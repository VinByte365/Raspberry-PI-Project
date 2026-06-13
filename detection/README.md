# Detection Microservice

This laptop-running service consumes the Raspberry Pi raw camera stream, runs
Roboflow detection, draws boxes onto frames, and serves an annotated JPEG stream.

## Setup

```powershell
cd D:\Projects\Crayfish\Raspberry-PI-Project\detection
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `.env`:

```text
PI_STREAM_URL=ws://<raspi-ip>:8765
ROBOFLOW_API_KEY=<your-key>
```

## Run

```powershell
python service.py
```

The annotated stream will be available at:

```text
ws://<laptop-ip>:8766
```

Point the Expo app's `WS_URL` at the laptop stream when you want detection
boxes. The Raspberry Pi backend stays camera-only and does not need Roboflow
dependencies or credentials.
