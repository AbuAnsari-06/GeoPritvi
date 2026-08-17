import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader
from dataset import RockfallGeotechDataset
from model import EWPSRockfallPredictor
import time

class FocalLoss(nn.Module):
    """
    Focal Loss for handling heavily skewed failure vs. non-failure node distributions.
    FL(p_t) = -alpha_t * (1 - p_t)^gamma * log(p_t)
    """
    def __init__(self, alpha: float = 0.25, gamma: float = 2.0):
        super().__init__()
        self.alpha = alpha
        self.gamma = gamma

    def forward(self, logits: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
        bce_loss = F.binary_cross_entropy_with_logits(logits, targets.float(), reduction='none')
        pt = torch.exp(-bce_loss)
        alpha_t = self.alpha * targets + (1 - self.alpha) * (1 - targets)
        focal_loss = alpha_t * (1 - pt) ** self.gamma * bce_loss
        return focal_loss.mean()

class DualTaskLoss(nn.Module):
    """
    Dual-Task Objective Loss:
    L = \alpha * L_node + (1 - \alpha) * L_graph
    L_node: Focal Loss on joint condition / RQD node failure rating
    L_graph: Focal Loss (collapse prob) + Smooth L1 Loss (Factor of Safety regression)
    """
    def __init__(self, alpha: float = 0.5, focal_gamma: float = 2.0):
        super().__init__()
        self.alpha = alpha
        self.node_focal = FocalLoss(alpha=0.3, gamma=focal_gamma)
        self.graph_collapse_focal = FocalLoss(alpha=0.5, gamma=focal_gamma)
        self.smooth_l1 = nn.SmoothL1Loss()

    def forward(self, outputs: dict, batch: dict) -> dict:
        node_logits = outputs['node_logits']
        node_targets = batch['node_labels']
        
        collapse_prob = outputs['collapse_prob']
        collapse_target = batch['collapse_prob']
        
        fos_pred = outputs['factor_of_safety']
        fos_target = batch['factor_of_safety']
        
        # 1. Node Loss
        l_node = self.node_focal(node_logits, node_targets)
        
        # 2. Graph Loss (Collapse Prob + FoS)
        # Convert collapse_prob to logit form for focal loss stability
        collapse_logits = torch.logit(torch.clamp(collapse_prob, 1e-6, 1.0 - 1e-6))
        l_collapse = self.graph_collapse_focal(collapse_logits, collapse_target)
        l_fos = self.smooth_l1(fos_pred, fos_target)
        l_graph = l_collapse + l_fos
        
        # Total Dual Loss
        total_loss = self.alpha * l_node + (1.0 - self.alpha) * l_graph
        
        return {
            'total_loss': total_loss,
            'l_node': l_node,
            'l_collapse': l_collapse,
            'l_fos': l_fos
        }

def train_ewps_model(epochs: int = 5, batch_size: int = 1, lr: float = 1e-3, device_str: str = 'cpu'):
    device = torch.device(device_str if torch.cuda.is_available() and device_str != 'cpu' else 'cpu')
    print(f"Initializing EWPS Model Training on Device: {device}")
    
    # Datasets
    train_dataset = RockfallGeotechDataset(num_samples=20, num_nodes_per_scene=30, seq_len=12)
    val_dataset = RockfallGeotechDataset(num_samples=5, num_nodes_per_scene=30, seq_len=12)
    
    # Model
    model = EWPSRockfallPredictor(hidden_dim=128, egnn_layers=3, c=0.1, eps=1e-6).to(device)
    criterion = DualTaskLoss(alpha=0.5)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)
    
    scaler = torch.cuda.amp.GradScaler(enabled=(device.type == 'cuda'))
    
    print("\n--- Starting Training Loop ---")
    start_time = time.time()
    
    for epoch in range(1, epochs + 1):
        model.train()
        epoch_loss = 0.0
        epoch_l_node = 0.0
        epoch_l_fos = 0.0
        
        for i in range(len(train_dataset)):
            sample = train_dataset[i]
            
            # Move tensors to device
            voxels = sample['voxels'].to(device) # (N, 4, 32, 32, 32)
            centroids = sample['centroids'].to(device) # (N, 3)
            edge_index = sample['edge_index'].to(device) # (2, E)
            sensor_series = sample['sensor_series'].to(device) # (N, T, 4)
            
            node_labels = sample['node_labels'].to(device)
            collapse_prob = sample['collapse_prob'].to(device)
            factor_of_safety = sample['factor_of_safety'].to(device)
            
            batch_dict = {
                'node_labels': node_labels,
                'collapse_prob': collapse_prob,
                'factor_of_safety': factor_of_safety
            }
            
            optimizer.zero_grad()
            
            with torch.cuda.amp.autocast(enabled=(device.type == 'cuda')):
                outputs = model(voxels, centroids, edge_index, sensor_series)
                losses = criterion(outputs, batch_dict)
                loss = losses['total_loss']
                
            if device.type == 'cuda':
                scaler.scale(loss).backward()
                scaler.step(optimizer)
                scaler.update()
            else:
                loss.backward()
                optimizer.step()
                
            epoch_loss += loss.item()
            epoch_l_node += losses['l_node'].item()
            epoch_l_fos += losses['l_fos'].item()
            
        scheduler.step()
        avg_loss = epoch_loss / len(train_dataset)
        avg_l_node = epoch_l_node / len(train_dataset)
        avg_l_fos = epoch_l_fos / len(train_dataset)
        
        print(f"Epoch [{epoch}/{epochs}] | Loss: {avg_loss:.4f} | L_node: {avg_l_node:.4f} | L_FoS: {avg_l_fos:.4f} | LR: {scheduler.get_last_lr()[0]:.6f}")
        
    elapsed = time.time() - start_time
    print(f"\nTraining Completed in {elapsed:.2f}s!")
    
    # Save checkpoint
    torch.save(model.state_dict(), "ewps_rockfall_model.pth")
    print("Saved model checkpoint to 'ewps_rockfall_model.pth'")
    return model

if __name__ == "__main__":
    train_ewps_model(epochs=3, batch_size=1)
