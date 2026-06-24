# 🪟 Windows Setup Guide

## Issue: SerialPort Build Error

On Windows, `serialport` requires Visual Studio C++ build tools which can be problematic to install.

## ✅ Solution (3 Options)

### Option 1: Use Python Server (Recommended for Windows) ⭐

The Python server doesn't have native module dependencies and works great on Windows:

```bash
# Install Python dependencies
pip install -r requirements-python.txt

# Run Python server
python sensor-server-python.py
```

**Advantages:**
- No build tools needed
- Works immediately
- Same functionality as Node.js

### Option 2: Install Visual Studio Build Tools

If you want to use the Node.js server on Windows:

1. Download [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/)
2. Run the installer
3. Select "Desktop development with C++"
4. Install
5. Run: `npm install serialport`

**Time required:** 5-10 minutes

### Option 3: Test Dashboard Without Serial Connection

The dashboard UI works standalone - you can test it without ESP32 connected:

```bash
npm start
```

Then open: http://localhost:8080

**Note:** Sensor data won't appear, but you can test the UI and relay buttons.

## 🚀 Windows Setup (Fastest)

```bash
# 1. Go to web-frontend
cd web-frontend

# 2. Install core packages (already done!)
npm install --no-optional

# 3. Use Python version for actual serial communication
# Install Python dependencies
pip install -r requirements-python.txt

# 4. Start Python server in one terminal
python sensor-server-python.py

# 5. Start web server in another terminal (optional, for static files)
npm start

# 6. Access dashboard
# Open http://localhost:8080
```

## 📋 For Node.js Server (Optional)

If you specifically want to use Node.js with serialport:

```bash
# Option A: Install build tools manually
npm install serialport

# Option B: Use pre-built binaries
npm install --build-from-source=false

# Option C: Skip and use Python instead
python sensor-server-python.py
```

## ✨ Recommended: Use Python Server on Windows

Create a batch file `start-server.bat`:

```batch
@echo off
echo 🚀 Starting Sensor Dashboard (Python)
echo.
python sensor-server-python.py
pause
```

Then just double-click `start-server.bat` to start the server!

## 🔧 Configure Python Server

Edit `.env`:
```
SERIAL_PORT=COM3              # Your ESP32 COM port
SERIAL_BAUD=115200
WS_PORT=8080
```

Find your COM port:
- Device Manager → Ports (COM & LPT)
- Look for "USB-SERIAL CH340"

## ✅ Verify Installation

```bash
# Check Python is installed
python --version

# Check pip packages
pip list | findstr websockets

# Check Node.js packages
npm list

# Check if .env exists
dir .env
```

## 📊 Python vs Node.js on Windows

| Feature | Python | Node.js |
|---------|--------|---------|
| Setup | ✅ Easy | ⚠️ Need build tools |
| Speed | ✅ Fast | ✅ Fast |
| Functionality | ✅ 100% | ✅ 100% |
| Dependencies | ✅ None | ⚠️ Requires Visual Studio |
| Time to run | ✅ 30 seconds | ⚠️ 10+ minutes |

**Recommendation:** Use Python on Windows!

## 🎯 Quick Start (Windows)

```bash
# Terminal 1: Navigate to project
cd web-frontend

# Terminal 2: Install & run Python server
pip install -r requirements-python.txt
python sensor-server-python.py

# Browser: Open dashboard
http://localhost:8080
```

## 🔍 Troubleshooting Windows Setup

### Error: "Python not found"
- Install Python: https://www.python.org/downloads/
- Make sure to check "Add Python to PATH" during installation
- Restart terminal after installing

### Error: "Module websockets not found"
```bash
pip install websockets pyserial
```

### Error: "Port COM3 not found"
- Check Device Manager for correct port
- Update `.env` with your port (e.g., COM4)

### Dashboard shows "Connecting..."
- Check `.env` has correct SERIAL_PORT
- Verify ESP32 is connected to that port
- Check baud rate is 115200

## 📚 Documentation

- **[README.md](README.md)** - Feature overview
- **[SETUP_GUIDE.md](../SETUP_GUIDE.md)** - General setup
- **[ARCHITECTURE.md](../ARCHITECTURE.md)** - System design

## 💡 Pro Tips

1. Use Python server on Windows (no build tools needed)
2. The Node.js server works great on Linux/Mac (no issues there)
3. Both servers are identical in functionality
4. Dashboard UI is separate from backend server
5. You can switch servers anytime without changing the dashboard

## ✨ Success Indicators

You'll know it's working when:
- ✅ No errors in terminal
- ✅ Server starts successfully
- ✅ Dashboard loads at http://localhost:8080
- ✅ Green "Connected" indicator appears
- ✅ Sensor values update in real-time

## 🆘 Still Having Issues?

**Try Python server first** - it's the most reliable on Windows:

```bash
python sensor-server-python.py
```

If that doesn't work:
1. Check Python is installed: `python --version`
2. Check dependencies: `pip list`
3. Check COM port: Device Manager
4. Check baud rate in `.env` is 115200

---

**Windows Setup Status:** ✅ Ready to Use
**Recommended:** Python Server
**Time to first run:** < 2 minutes
