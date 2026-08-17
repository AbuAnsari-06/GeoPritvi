"""
==========================================================================
EARLY WARNING PREDICTION SYSTEM (EWPS) - FASTAPI BACKEND API & INFERENCE ENGINE
==========================================================================
Provides real-time telemetry ingestion, Conformal Prediction uncertainty bounds,
3-tier dynamic alert escalation, Limit Equilibrium Method (LEM) fallback,
kinetic rockfall barrier mitigation, and multi-channel field worker alerts.
"""

from server import app, engine, TelemetryPayload, SensorTelemetry, PredictionResponse, INDIAN_CAVES_DB
import uvicorn
import os

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print(f"Starting EWPS API server on port {port}...")
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=False)
