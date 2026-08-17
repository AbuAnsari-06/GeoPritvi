import torch
from torch.utils.data import Dataset
import numpy as np

def build_radius_k_nn_graph(centroids: torch.Tensor, radius: float = 20.0, max_neighbors: int = 32) -> torch.Tensor:
    """
    Constructs a static radius-based k-NN graph once at layer 0.
    Args:
        centroids: (N, 3) node positions
        radius: spatial interaction threshold in meters [10.0, 30.0]
        max_neighbors: max nearest neighbors K = 32
    Returns:
        edge_index: (2, E) graph edge connectivity matrix
    """
    N = centroids.size(0)
    # Compute pairwise Euclidean distance matrix
    dist_matrix = torch.cdist(centroids, centroids, p=2) # (N, N)
    
    edge_sources = []
    edge_targets = []
    
    for i in range(N):
        # Find neighbors within radius excluding self-loops
        in_radius = torch.where((dist_matrix[i] <= radius) & (dist_matrix[i] > 0))[0]
        if len(in_radius) > 0:
            # Sort by distance and pick top max_neighbors
            dists = dist_matrix[i, in_radius]
            sorted_idx = torch.argsort(dists)[:max_neighbors]
            selected_neighbors = in_radius[sorted_idx]
            
            for j in selected_neighbors:
                edge_sources.append(i)
                edge_targets.append(j.item())
                
    if len(edge_sources) == 0:
        # Fallback to self loops if disconnected graph
        edge_index = torch.stack([torch.arange(N), torch.arange(N)], dim=0)
    else:
        edge_index = torch.tensor([edge_sources, edge_targets], dtype=torch.long)
        
    return edge_index

class RockfallGeotechDataset(Dataset):
    """
    Multi-modal PyTorch dataset loader for 3D LiDAR sub-volume voxel patches,
    mesh centroids, static radius-kNN graph, continuous sensor streams, and dual targets.
    
    Input Shapes:
    - voxels: (N, 4, 32, 32, 32) - 4 channels: [Density, Curvature, Dip Angle, Fracture Intensity]
    - centroids: (N, 3) - 3D spatial coordinates (x_i \in R^3)
    - sensor_series: (N, T, 4) - Time series [Rainfall mm/h, InSAR LOS vel mm/y, Pore Pressure kPa, Seismic Accel]
    
    Targets:
    - node_labels: (N,) Binary Joint Condition / Failure Rating per node (RQD failure class)
    - collapse_prob: (1,) Global Slope Collapse Probability
    - factor_of_safety: (1,) Factor of Safety (FoS) scalar value
    """
    def __init__(self, num_samples: int = 100, num_nodes_per_scene: int = 50, seq_len: int = 24, radius: float = 20.0, max_k: int = 32):
        super().__init__()
        self.num_samples = num_samples
        self.num_nodes = num_nodes_per_scene
        self.seq_len = seq_len
        self.radius = radius
        self.max_k = max_k
        
    def __len__(self) -> int:
        return self.num_samples
        
    def __getitem__(self, idx: int) -> dict:
        # Seed deterministically per sample for reproducible dataset generation
        rng = np.random.RandomState(idx)
        N = self.num_nodes
        T = self.seq_len
        
        # 1. Generate 3D Voxel Patches (N, 4, 32, 32, 32)
        # Channel 0: Point Density [0, 1]
        # Channel 1: Normal Curvature [0, 1]
        # Channel 2: Dip Angle [0, pi/2]
        # Channel 3: Fracture Intensity [0, 10]
        voxels = rng.uniform(0.0, 1.0, size=(N, 4, 32, 32, 32)).astype(np.float32)
        voxels[:, 2, :, :, :] *= (np.pi / 2.0) # Dip angle scaling
        voxels[:, 3, :, :, :] *= 10.0 # Fracture intensity scaling
        
        # 2. Generate Mesh Centroids (N, 3) in a realistic slope coordinate box [100m x 100m x 50m]
        centroids_np = np.zeros((N, 3), dtype=np.float32)
        centroids_np[:, 0] = rng.uniform(0.0, 100.0, size=N) # X
        centroids_np[:, 1] = rng.uniform(0.0, 100.0, size=N) # Y
        centroids_np[:, 2] = centroids_np[:, 1] * 0.4 + rng.uniform(-5.0, 5.0, size=N) # Z (inclined slope)
        
        centroids_tensor = torch.from_numpy(centroids_np)
        
        # 3. Build Static Radius Graph at Layer 0
        edge_index = build_radius_k_nn_graph(centroids_tensor, radius=self.radius, max_neighbors=self.max_k)
        
        # 4. Generate Spatio-Temporal Sensor Stream (N, T, 4)
        # Channel 0: Rainfall (0-50 mm/h)
        # Channel 1: InSAR LOS velocity (-20 to +5 mm/yr)
        # Channel 2: Pore pressure (10-150 kPa)
        # Channel 3: Micro-seismic accel (0-0.5 m/s^2)
        sensor_series = np.zeros((N, T, 4), dtype=np.float32)
        time_steps = np.arange(T).reshape(1, T, 1)
        
        sensor_series[:, :, 0] = np.sin(time_steps / 4.0) * 20.0 + 25.0 + rng.normal(0, 2, (N, T)) # Rain
        sensor_series[:, :, 1] = -np.exp(time_steps / 10.0) * 1.5 + rng.normal(0, 0.5, (N, T)) # InSAR shift
        sensor_series[:, :, 2] = sensor_series[:, :, 0] * 2.1 + 30.0 + rng.normal(0, 3, (N, T)) # Pore pressure
        sensor_series[:, :, 3] = rng.exponential(scale=0.05, size=(N, T)) # Seismic accel
        
        # 5. Calculate Dual Targets
        # Node Failure Class: 1 if high fracture intensity + high pore pressure + steep angle, else 0
        high_fracture = voxels[:, 3].mean(axis=(1,2,3)) > 5.0
        high_pore_pressure = sensor_series[:, -1, 2] > 70.0
        node_failure_prob = (high_fracture.astype(float) * 0.5 + high_pore_pressure.astype(float) * 0.5)
        node_labels = (node_failure_prob + rng.normal(0, 0.1, N) > 0.5).astype(np.int64)
        
        # Global Slope Collapse Risk & FoS calculation
        failed_node_ratio = np.mean(node_labels)
        collapse_prob = np.clip(failed_node_ratio * 1.4 + rng.normal(0, 0.05), 0.0, 1.0).astype(np.float32)
        # FoS < 1.0 indicates unstable slope, FoS > 1.5 stable slope
        factor_of_safety = np.array([max(0.6, 2.2 - collapse_prob * 1.5)], dtype=np.float32)
        
        return {
            'voxels': torch.from_numpy(voxels),
            'centroids': centroids_tensor,
            'edge_index': edge_index,
            'sensor_series': torch.from_numpy(sensor_series),
            'node_labels': torch.from_numpy(node_labels),
            'collapse_prob': torch.from_numpy(collapse_prob),
            'factor_of_safety': torch.from_numpy(factor_of_safety)
        }
