# GeoPritvi — EWPS India (Early Warning Prediction System)

EWPS India (GeoPritvi) is a research-grade geotechnical early-warning platform for cave and rockfall risk monitoring. It combines a FastAPI inference backend, a physics-aware DEM/topography service, a multi‑modal PyTorch Voxel+EGNN model (EWPS-VoxelNET), a browser-based dashboard, and utility scripts to run physics-based mitigation sizing and SMS alert dispatching.

Key uses:
- Real-time hazard inference from multi-sensor telemetry (rainfall, InSAR, pore pressure, microseismic).
- Automated barrier-sizing recommendations from simple block/height inputs.
- DEM ingestion (NASA SRTM / Copernicus fallback) and Mohr‑Coulomb FoS mapping.
- Simulated dataset and training pipeline for the research model.

---

## Features
- FastAPI backend exposing health, cave registry, inference, DEM and telemetry endpoints.
- Geotechnical inference engine with conformal uncertainty bounds, tiered alerting and physics fallback mitigation sizing.
- EWPSRockfallPredictor: 3D ConvNeXt backbone → Norm-Clamped EGNN → Bi-GRU spatio-temporal fusion → dual-task heads (node failure + global FoS/collapse prob).
- Synthetic dataset generator (radius-kNN graph, voxel patches, sensor time-series).
- DEM terrain service: real DEM fetch (Open-Meteo/OpenWeather) with calibrated high-fidelity terrain generator fallback and Mohr‑Coulomb FoS calculations.
- Browser-based dashboard (index.html + app.js + styles.css) for interactive visualization and manual dispatch.

---
