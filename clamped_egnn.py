import torch
import torch.nn as nn
import torch.nn.functional as F

class NormClampingOperator(nn.Module):
    """
    Norm-Clamping Operator \Pi_{c, \varepsilon}(v) = v * min(1, c / (||v||_2 + \varepsilon))
    Geotechnical hyperparameter: c = 0.1m, \varepsilon = 1e-6
    Ensures per-layer spatial displacement does not exceed c meters.
    """
    def __init__(self, c: float = 0.1, eps: float = 1e-6):
        super().__init__()
        self.c = c
        self.eps = eps

    def forward(self, v: torch.Tensor) -> torch.Tensor:
        # v shape: (N, 3)
        v_norm = torch.norm(v, p=2, dim=-1, keepdim=True) # (N, 1)
        scale = torch.clamp(self.c / (v_norm + self.eps), max=1.0)
        return v * scale

class NormClampedEGNNLayer(nn.Module):
    """
    E(3)-Equivariant Graph Neural Network Layer with 1-Lipschitz Norm-Clamping.
    Follows strict engineering contract:
    - Linear -> LayerNorm -> SiLU for feature MLPs
    - No activation on coordinate MLP \phi_x
    - Mean aggregation for coordinates, Sum aggregation for features
    - Edge input dimension: 257 (h_i: 128 + h_j: 128 + ||x_i - x_j||^2: 1)
    """
    def __init__(self, hidden_dim: int = 128, c: float = 0.1, eps: float = 1e-6):
        super().__init__()
        self.hidden_dim = hidden_dim
        
        # Edge MLP \phi_e: 257 -> 128 -> 128 -> 128
        self.phi_e = nn.Sequential(
            nn.Linear(hidden_dim * 2 + 1, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.SiLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.SiLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.SiLU()
        )
        
        # Coordinate MLP \phi_x: 128 -> 128 -> 128 -> 1 (No final activation)
        self.phi_x = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.SiLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.SiLU(),
            nn.Linear(hidden_dim, 1, bias=False)
        )
        
        # Node MLP \phi_h: 256 -> 128 -> 128 -> 128
        self.phi_h = nn.Sequential(
            nn.Linear(hidden_dim * 2, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.SiLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.SiLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.SiLU()
        )
        
        self.clamp_op = NormClampingOperator(c=c, eps=eps)

    def forward(self, h: torch.Tensor, x: torch.Tensor, edge_index: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """
        Args:
            h: (N, hidden_dim) node feature matrix
            x: (N, 3) node coordinate matrix
            edge_index: (2, E) graph edge connectivity (static)
        Returns:
            h_next: (N, hidden_dim) updated node features
            x_next: (N, 3) updated node coordinates (clamped shift)
        """
        row, col = edge_index[0], edge_index[1]
        
        # 1. Compute squared Euclidean distance (E(3) invariant scalar)
        rel_pos = x[row] - x[col] # (E, 3)
        dist_sq = torch.sum(rel_pos ** 2, dim=-1, keepdim=True) # (E, 1)
        
        # 2. Edge Message Passing m_ij = \phi_e(h_i, h_j, ||x_i - x_j||^2)
        edge_input = torch.cat([h[row], h[col], dist_sq], dim=-1) # (E, 257)
        m_ij = self.phi_e(edge_input) # (E, 128)
        
        # 3. Coordinate Displacements \Delta x_i
        # Weight per edge: \phi_x(m_ij)
        w_ij = self.phi_x(m_ij) # (E, 1)
        coord_msg = rel_pos * w_ij # (E, 3)
        
        # Mean aggregation over neighbors for coordinates
        num_nodes = h.size(0)
        delta_x = torch.zeros_like(x) # (N, 3)
        deg = torch.zeros((num_nodes, 1), device=h.device, dtype=h.dtype)
        
        delta_x.index_add_(0, row, coord_msg)
        deg.index_add_(0, row, torch.ones((edge_index.size(1), 1), device=h.device, dtype=h.dtype))
        
        # Avoid div by 0 for isolated nodes
        deg = torch.clamp(deg, min=1.0)
        delta_x = delta_x / deg
        
        # 4. Apply Norm-Clamping Operator \Pi_{c, \varepsilon}
        clamped_delta_x = self.clamp_op(delta_x)
        x_next = x + clamped_delta_x
        
        # 5. Feature Update with Sum Aggregation
        m_i = torch.zeros((num_nodes, self.hidden_dim), device=h.device, dtype=h.dtype)
        m_i.index_add_(0, row, m_ij)
        
        node_input = torch.cat([h, m_i], dim=-1) # (N, 256)
        h_next = self.phi_h(node_input) # (N, 128)
        
        return h_next, x_next

class NormClampedEGNN(nn.Module):
    """
    Multi-Layer Norm-Clamped EGNN Module.
    Default: L = 3 layers, max total coordinate shift bounded to L * c = 0.3 meters.
    """
    def __init__(self, num_layers: int = 3, hidden_dim: int = 128, c: float = 0.1, eps: float = 1e-6):
        super().__init__()
        self.num_layers = num_layers
        self.layers = nn.ModuleList([
            NormClampedEGNNLayer(hidden_dim=hidden_dim, c=c, eps=eps)
            for _ in range(num_layers)
        ])

    def forward(self, h: torch.Tensor, x: torch.Tensor, edge_index: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        for layer in self.layers:
            h, x = layer(h, x, edge_index)
        return h, x
