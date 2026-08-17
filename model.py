import torch
import torch.nn as nn
import torch.nn.functional as F
from clamped_egnn import NormClampedEGNN

class ConvNeXtBlock3D(nn.Module):
    """
    3D ConvNeXt Block adapted for 3D spatial voxel grids (32x32x32x4).
    7x7x7 depthwise conv -> LayerNorm -> 1x1x1 conv (expansion 4x) -> GELU -> 1x1x1 conv
    """
    def __init__(self, dim: int):
        super().__init__()
        self.dwconv = nn.Conv3d(dim, dim, kernel_size=7, padding=3, groups=dim)
        self.norm = nn.LayerNorm(dim)
        self.pwconv1 = nn.Linear(dim, 4 * dim)
        self.act = nn.GELU()
        self.pwconv2 = nn.Linear(4 * dim, dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        input_x = x
        x = self.dwconv(x)
        # Permute for LayerNorm: (N, C, D, H, W) -> (N, D, H, W, C)
        x = x.permute(0, 2, 3, 4, 1)
        x = self.norm(x)
        x = self.pwconv1(x)
        x = self.act(x)
        x = self.pwconv2(x)
        # Permute back: (N, D, H, W, C) -> (N, C, D, H, W)
        x = x.permute(0, 4, 1, 2, 3)
        return input_x + x

class ConvNeXt3DBackbone(nn.Module):
    """
    Stage 1: 3D ConvNeXt Backbone downsampling 32x32x32 voxel grids with 4 channels
    to a node-level latent fracture embedding h_i^{(0)} \in R^{128}.
    """
    def __init__(self, in_channels: int = 4, hidden_dim: int = 128):
        super().__init__()
        # Stem: 32x32x32 -> 16x16x16
        self.stem = nn.Sequential(
            nn.Conv3d(in_channels, 32, kernel_size=4, stride=2, padding=1),
            nn.BatchNorm3d(32),
            nn.GELU()
        )
        self.stage1 = ConvNeXtBlock3D(32)
        
        # Downsample 1: 16x16x16 -> 8x8x8
        self.downsample1 = nn.Sequential(
            nn.Conv3d(32, 64, kernel_size=2, stride=2),
            nn.BatchNorm3d(64)
        )
        self.stage2 = ConvNeXtBlock3D(64)
        
        # Downsample 2: 8x8x8 -> 4x4x4
        self.downsample2 = nn.Sequential(
            nn.Conv3d(64, hidden_dim, kernel_size=2, stride=2),
            nn.BatchNorm3d(hidden_dim)
        )
        self.stage3 = ConvNeXtBlock3D(hidden_dim)
        
        # Global Average Pool across D, H, W -> (N, 128)
        self.avg_pool = nn.AdaptiveAvgPool3d((1, 1, 1))

    def forward(self, voxels: torch.Tensor) -> torch.Tensor:
        # voxels: (N, 4, 32, 32, 32)
        x = self.stem(voxels)
        x = self.stage1(x)
        x = self.downsample1(x)
        x = self.stage2(x)
        x = self.downsample2(x)
        x = self.stage3(x)
        x = self.avg_pool(x)
        h_0 = x.view(x.size(0), -1) # (N, 128)
        return h_0

class SpatioTemporalModule(nn.Module):
    """
    Stage 3: Bidirectional GRU Spatio-Temporal Trigger Module.
    Fuses sliding window temporal sensor streams (Rainfall, InSAR, Pore Pressure, Seismic Accel)
    with spatial EGNN embeddings h_i.
    """
    def __init__(self, sensor_in_dim: int = 4, hidden_dim: int = 128):
        super().__init__()
        self.bigru = nn.GRU(
            input_size=sensor_in_dim,
            hidden_size=hidden_dim // 2,
            num_layers=2,
            batch_first=True,
            bidirectional=True
        )
        self.temporal_fusion = nn.Sequential(
            nn.Linear(hidden_dim * 2, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.SiLU(),
            nn.Linear(hidden_dim, hidden_dim)
        )

    def forward(self, h_spatial: torch.Tensor, sensor_series: torch.Tensor) -> torch.Tensor:
        """
        Args:
            h_spatial: (N, 128) spatial features from Norm-Clamped EGNN
            sensor_series: (N, T, 4) time-series sensor telemetry
        Returns:
            z_t: (N, 128) latent spatio-temporal node embeddings
        """
        out, _ = self.bigru(sensor_series) # (N, T, 128)
        last_temp_embed = out[:, -1, :] # Pick last time step (N, 128)
        
        combined = torch.cat([h_spatial, last_temp_embed], dim=-1) # (N, 256)
        z_t = self.temporal_fusion(combined) # (N, 128)
        return z_t

class DualTaskOptimizationHeads(nn.Module):
    """
    Stage 4: Dual-Task Output Heads
    1. Node Head: RQD / Joint Condition failure rating per node (L_node)
    2. Graph Head: Slope collapse probability & Factor of Safety FoS regression (L_graph)
    """
    def __init__(self, hidden_dim: int = 128):
        super().__init__()
        # 1. Node Failure Classifier
        self.node_classifier = nn.Sequential(
            nn.Linear(hidden_dim, 64),
            nn.LayerNorm(64),
            nn.SiLU(),
            nn.Linear(64, 1)
        )
        
        # 2. Graph Pooling & Global Head
        self.graph_mlp = nn.Sequential(
            nn.Linear(hidden_dim * 2, 64),
            nn.LayerNorm(64),
            nn.SiLU()
        )
        self.collapse_head = nn.Linear(64, 1) # Sigmoid output
        self.fos_head = nn.Linear(64, 1) # Factor of safety regression

    def forward(self, z_t: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        # Node logits (N, 1)
        node_logits = self.node_classifier(z_t).squeeze(-1)
        
        # Graph Mean + Max Pooling across all nodes in the slope mesh
        graph_mean = torch.mean(z_t, dim=0, keepdim=True) # (1, 128)
        graph_max, _ = torch.max(z_t, dim=0, keepdim=True) # (1, 128)
        graph_embed = torch.cat([graph_mean, graph_max], dim=-1) # (1, 256)
        
        g_feat = self.graph_mlp(graph_embed) # (1, 64)
        
        collapse_prob = torch.sigmoid(self.collapse_head(g_feat)).squeeze(-1) # (1,)
        # Factor of Safety: Softplus + 0.1 to guarantee positive physical FoS
        factor_of_safety = (F.softplus(self.fos_head(g_feat)) + 0.1).squeeze(-1) # (1,)
        
        return node_logits, collapse_prob, factor_of_safety

class EWPSRockfallPredictor(nn.Module):
    """
    Complete End-to-End Multi-Modal Rockfall Prediction Network.
    Combines:
    1. 3D ConvNeXt Voxel Feature Extractor
    2. 3-Layer Norm-Clamped E(3)-Equivariant EGNN
    3. Bi-GRU Spatio-Temporal Trigger Module
    4. Dual-Task Optimization Heads
    """
    def __init__(self, hidden_dim: int = 128, egnn_layers: int = 3, c: float = 0.1, eps: float = 1e-6):
        super().__init__()
        self.voxel_backbone = ConvNeXt3DBackbone(in_channels=4, hidden_dim=hidden_dim)
        self.norm_clamped_egnn = NormClampedEGNN(num_layers=egnn_layers, hidden_dim=hidden_dim, c=c, eps=eps)
        self.st_module = SpatioTemporalModule(sensor_in_dim=4, hidden_dim=hidden_dim)
        self.heads = DualTaskOptimizationHeads(hidden_dim=hidden_dim)

    def forward(self, voxels: torch.Tensor, centroids: torch.Tensor, edge_index: torch.Tensor, sensor_series: torch.Tensor) -> dict:
        """
        Args:
            voxels: (N, 4, 32, 32, 32)
            centroids: (N, 3) mesh centroid positions x_i^{(0)}
            edge_index: (2, E) static radius-kNN graph adjacency
            sensor_series: (N, T, 4) dynamic sensor telemetry
        Returns:
            dict containing:
            - node_logits: (N,)
            - collapse_prob: (1,)
            - factor_of_safety: (1,)
            - displaced_centroids: (N, 3) final E(3)-equivariant shifted coordinates
        """
        # Stage 1: Extract 3D Voxel Embeddings h_i^{(0)}
        h_0 = self.voxel_backbone(voxels) # (N, 128)
        
        # Stage 2: Norm-Clamped Geometric Fusion Engine
        h_spatial, x_displaced = self.norm_clamped_egnn(h_0, centroids, edge_index)
        
        # Stage 3: Spatio-Temporal Fusion
        z_t = self.st_module(h_spatial, sensor_series) # (N, 128)
        
        # Stage 4: Dual-Task Output Heads
        node_logits, collapse_prob, factor_of_safety = self.heads(z_t)
        
        return {
            'node_logits': node_logits,
            'collapse_prob': collapse_prob,
            'factor_of_safety': factor_of_safety,
            'displaced_centroids': x_displaced
        }
