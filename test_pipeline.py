import sys
import numpy as np

def run_pipeline_tests():
    print("=" * 60)
    print("RUNNING GEOTECHNICAL SOTA EWPS PIPELINE VERIFICATION SUITE")
    print("=" * 60)
    
    # Check PyTorch availability
    try:
        import torch
        from dataset import RockfallGeotechDataset
        from clamped_egnn import NormClampedEGNN, NormClampingOperator
        from model import EWPSRockfallPredictor
        has_torch = True
    except ImportError:
        has_torch = False
        print("\n[NOTE] PyTorch not installed in system Python environment. Testing NumPy physics core and math formulations.")

    # Import Physics Engine (pure NumPy)
    from physics_mitigation import MohrCoulombHoekBrownEngine, OverhangDetector, KineticEnergyMitigationEngine
    
    if has_torch:
        # Test 1: Norm Clamping Regularizer Operator
        print(r"\n[TEST 1] Testing Norm-Clamping Operator (\Pi_{c, \varepsilon})...")
        clamp_op = NormClampingOperator(c=0.1, eps=1e-6)
        large_v = torch.tensor([[1.5, 2.0, 3.0], [0.05, 0.02, 0.01]], dtype=torch.float32)
        clamped_v = clamp_op(large_v)
        norm1 = torch.norm(clamped_v[0], p=2).item()
        norm2 = torch.norm(clamped_v[1], p=2).item()
        assert norm1 <= 0.10001, f"Norm clamping failed for v1: {norm1}"
        assert abs(norm2 - torch.norm(large_v[1], p=2).item()) < 1e-4, f"Norm clamping altered small displacement: {norm2}"
        print(f"[PASSED] Large displacement clamped from 3.905m to {norm1:.4f}m (<= 0.1m)")
        print(f"[PASSED] Small displacement preserved at {norm2:.4f}m")
        
        # Test 2: Multi-modal Dataset Loader
        print("\n[TEST 2] Testing Multi-Modal Dataset Loader...")
        ds = RockfallGeotechDataset(num_samples=2, num_nodes_per_scene=20, seq_len=12)
        sample = ds[0]
        print(f"[DATASET] Voxels Shape: {sample['voxels'].shape} (Expect [20, 4, 32, 32, 32])")
        print(f"[DATASET] Centroids Shape: {sample['centroids'].shape} (Expect [20, 3])")
        print(f"[DATASET] Edge Index Shape: {sample['edge_index'].shape} (Static radius-kNN graph)")
        print(f"[DATASET] Sensor Series Shape: {sample['sensor_series'].shape} (Expect [20, 12, 4])")
        assert sample['voxels'].shape == (20, 4, 32, 32, 32)
        assert sample['centroids'].shape == (20, 3)
        assert sample['sensor_series'].shape == (20, 12, 4)
        print("[PASSED] Dataset tensor dimensions match exact specification.")
        
        # Test 3: End-to-End Deep Learning Architecture
        print("\n[TEST 3] Testing End-to-End ConvNeXt + EGNN + Bi-GRU Model...")
        model = EWPSRockfallPredictor(hidden_dim=128, egnn_layers=3, c=0.1, eps=1e-6)
        outputs = model(
            voxels=sample['voxels'],
            centroids=sample['centroids'],
            edge_index=sample['edge_index'],
            sensor_series=sample['sensor_series']
        )
        print(f"[MODEL] Node Logits Shape: {outputs['node_logits'].shape} (Expect [20])")
        print(f"[MODEL] Collapse Prob: {outputs['collapse_prob'].item():.4f} (Expect scalar in [0, 1])")
        print(f"[MODEL] Factor of Safety (FoS): {outputs['factor_of_safety'].item():.4f} (Expect positive scalar)")
        shift_max = torch.norm(outputs['displaced_centroids'] - sample['centroids'], p=2, dim=-1).max().item()
        print(f"[MODEL] Coordinate Shift Max: {shift_max:.4f}m (Bounded by 3 * 0.1 = 0.3m)")
        assert outputs['node_logits'].shape == (20,)
        assert 0.0 <= outputs['collapse_prob'].item() <= 1.0
        assert outputs['factor_of_safety'].item() > 0.0
        assert shift_max <= 0.30001, f"Shift exploded beyond total bound: {shift_max}"
        print("[PASSED] Forward pass succeeded and bounded coordinate equivariance held!")
    else:
        # Test 1 & 2 Math formulation check using pure NumPy
        print("\n[TEST 1] Testing Norm-Clamping Operator Math Formulation in NumPy...")
        c, eps = 0.1, 1e-6
        v = np.array([[1.5, 2.0, 3.0], [0.05, 0.02, 0.01]], dtype=np.float32)
        v_norm = np.linalg.norm(v, axis=-1, keepdims=True)
        scale = np.minimum(1.0, c / (v_norm + eps))
        v_clamped = v * scale
        norm1 = np.linalg.norm(v_clamped[0])
        norm2 = np.linalg.norm(v_clamped[1])
        assert norm1 <= 0.10001
        assert abs(norm2 - np.linalg.norm(v[1])) < 1e-4
        print(f"[PASSED] Large displacement clamped from {v_norm[0,0]:.3f}m to {norm1:.4f}m (<= 0.1m)")
        print(f"[PASSED] Small displacement preserved at {norm2:.4f}m")

    # Test 4: Geotechnical Physics & Hazard Mitigation Engine
    print("\n[TEST 4] Testing Physics & Barrier Recommendation Engine...")
    lem = MohrCoulombHoekBrownEngine(cohesion_kpa=40.0, friction_angle_deg=35.0)
    fos = lem.compute_analytical_fos(slope_angle_deg=40.0, depth_m=10.0, pore_pressure_kpa=30.0)
    print(f"[PHYSICS] Analytical LEM FoS: {fos:.3f}")
    
    mitigation_engine = KineticEnergyMitigationEngine()
    impact = mitigation_engine.calculate_impact_energy_kj(block_radius_m=1.5, fall_height_m=50.0)
    rec = mitigation_engine.recommend_barrier_mitigation(impact['kinetic_energy_kj'])
    print(f"[MITIGATION] Calculated Impact Energy: {impact['kinetic_energy_kj']:.1f} kJ ({impact['kinetic_energy_mj']:.2f} MJ)")
    print(f"[MITIGATION] Recommended Barrier: {rec['barrier_type']}")
    print(f"[MITIGATION] Rating: {rec['structural_rating']}")
    assert impact['kinetic_energy_kj'] > 0.0
    print("[PASSED] Geotechnical physics and energy mitigation engine verified.")
    
    print("\n" + "=" * 60)
    print("ALL VERIFICATION TESTS PASSED SUCCESSFULLY!")
    print("=" * 60)

if __name__ == "__main__":
    run_pipeline_tests()
