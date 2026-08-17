import numpy as np

class MohrCoulombHoekBrownEngine:
    r"""
    Geotechnical Shear Strength & Limit Equilibrium Method (LEM) Physics Engine.
    Models Mohr-Coulomb failure criterion:
        \tau = c' + (\sigma_n - u) * tan(\phi')
    and analytical Factor of Safety (FoS):
        FoS_LEM = \tau / \tau_driving
    """
    def __init__(self, cohesion_kpa: float = 35.0, friction_angle_deg: float = 32.0, rock_density_kg_m3: float = 2650.0):
        self.cohesion = cohesion_kpa # c' in kPa
        self.phi_rad = np.radians(friction_angle_deg) # \phi' in radians
        self.density = rock_density_kg_m3 # \rho in kg/m^3
        self.g = 9.81 # acceleration due to gravity m/s^2

    def calculate_shear_strength(self, normal_stress_kpa: float, pore_pressure_kpa: float) -> float:
        """
        Calculates effective shear strength \tau (kPa).
        """
        effective_normal_stress = max(0.0, normal_stress_kpa - pore_pressure_kpa)
        tau = self.cohesion + effective_normal_stress * np.tan(self.phi_rad)
        return float(tau)

    def compute_analytical_fos(self, slope_angle_deg: float, depth_m: float, pore_pressure_kpa: float) -> float:
        """
        Calculates analytical Limit Equilibrium Method (LEM) Factor of Safety.
        """
        theta_rad = np.radians(slope_angle_deg)
        # Normal stress \sigma_n = \rho * g * h * cos^2(\theta) in kPa
        sigma_n = (self.density * self.g * depth_m * (np.cos(theta_rad) ** 2)) / 1000.0
        # Driving shear stress \tau_driving = \rho * g * h * sin(\theta) * cos(\theta) in kPa
        tau_driving = (self.density * self.g * depth_m * np.sin(theta_rad) * np.cos(theta_rad)) / 1000.0
        
        tau_resisting = self.calculate_shear_strength(sigma_n, pore_pressure_kpa)
        
        if tau_driving <= 1e-4:
            return 5.0 # Extremely stable horizontal slope
            
        fos = tau_resisting / tau_driving
        return float(fos)

class OverhangDetector:
    """
    Identifies gravitational overhangs and tensile detachments using normal vectors.
    Nodes with negative Z-normal (\vec{N}_z < 0) point downwards, indicating gravity overhang zones.
    """
    @staticmethod
    def detect_overhang_nodes(normals: np.ndarray) -> np.ndarray:
        """
        Args:
            normals: (N, 3) geometric surface normal vectors [N_x, N_y, N_z]
        Returns:
            is_overhang: (N,) boolean array where True = overhang zone
        """
        # Gravity vector \vec{g} = [0, 0, -1]
        # Alignment = \vec{N}_z
        is_overhang = normals[:, 2] < 0.0
        return is_overhang

class KineticEnergyMitigationEngine:
    """
    Rockfall Kinetic Energy Calculator & Retention Netting Recommendation Engine.
    Models rock mass block volume V = 4/3 * pi * r^3, velocity v, impact kinetic energy E_k (kJ/MJ),
    and specifies steel netting / rockfall barrier structural ratings.
    """
    def __init__(self, rock_density_kg_m3: float = 2650.0):
        self.density = rock_density_kg_m3
        self.g = 9.81

    def calculate_rock_volume_mass(self, block_radius_m: float) -> tuple[float, float]:
        """
        Volume V = 4/3 * pi * r^3 (m^3), Mass m = density * V (kg)
        """
        volume = (4.0 / 3.0) * np.pi * (block_radius_m ** 3)
        mass = self.density * volume
        return float(volume), float(mass)

    def calculate_impact_energy_kj(self, block_radius_m: float, fall_height_m: float, restitution_coeff: float = 0.75) -> dict:
        """
        Calculates freefall/bounce velocity and kinetic energy in kilojoules (kJ).
        E_k = 0.5 * m * v^2
        """
        volume, mass = self.calculate_rock_volume_mass(block_radius_m)
        # Impact velocity v = sqrt(2 * g * H * (1 - restitution loss))
        velocity = np.sqrt(2.0 * self.g * fall_height_m * restitution_coeff)
        energy_joules = 0.5 * mass * (velocity ** 2)
        energy_kj = energy_joules / 1000.0 # Convert to kJ
        
        return {
            'block_volume_m3': volume,
            'block_mass_kg': mass,
            'impact_velocity_m_s': velocity,
            'kinetic_energy_kj': energy_kj,
            'kinetic_energy_mj': energy_kj / 1000.0
        }

    def recommend_barrier_mitigation(self, kinetic_energy_kj: float) -> dict:
        """
        Recommends steel catch netting / dynamic barriers based on ISO / EOTA ETL 273 guidelines.
        """
        if kinetic_energy_kj < 500.0:
            barrier_type = "Light High-Tensile Steel Wire Mesh (Tecco / SPIDER G65 Mesh)"
            rating = "500 kJ Flexible Netting System"
            post_spacing = "10.0 meters"
            anchor_depth = "3.0 - 4.0 meters"
        elif kinetic_energy_kj < 2000.0:
            barrier_type = "Dynamic Rockfall Catch Barrier (Class 3 Standard)"
            rating = "2,000 kJ Energy Dissipation Barrier"
            post_spacing = "8.0 meters"
            anchor_depth = "5.0 - 6.0 meters"
        elif kinetic_energy_kj < 5000.0:
            barrier_type = "Heavy-Duty Attenuator Netting + Ring Net Barrier"
            rating = "5,000 kJ High-Capacity Impact Barrier"
            post_spacing = "5.0 - 6.0 meters"
            anchor_depth = "8.0 - 10.0 meters"
        else:
            barrier_type = "Reinforced Concrete Rockfall Shed / Earth Embankment Deflection Gallery"
            rating = "10,000+ kJ Civil Engineering Protection Structure"
            post_spacing = "Continuous Sub-surface Foundation"
            anchor_depth = "Heavy Bored Piles (>12 meters)"

        return {
            'kinetic_energy_kj': kinetic_energy_kj,
            'barrier_type': barrier_type,
            'structural_rating': rating,
            'recommended_post_spacing': post_spacing,
            'recommended_anchor_depth': anchor_depth
        }

if __name__ == "__main__":
    lem = MohrCoulombHoekBrownEngine()
    fos = lem.compute_analytical_fos(slope_angle_deg=45.0, depth_m=12.0, pore_pressure_kpa=45.0)
    print(f"Analytical LEM Factor of Safety (FoS): {fos:.3f}")
    
    mitigation = KineticEnergyMitigationEngine()
    impact = mitigation.calculate_impact_energy_kj(block_radius_m=1.2, fall_height_m=40.0)
    recommendation = mitigation.recommend_barrier_mitigation(impact['kinetic_energy_kj'])
    print(f"Impact Energy: {impact['kinetic_energy_kj']:.1f} kJ")
    print(f"Recommended Barrier: {recommendation['barrier_type']} ({recommendation['structural_rating']})")
