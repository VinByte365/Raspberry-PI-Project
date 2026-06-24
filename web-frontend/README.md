# 🌊 Sensor Dashboard

A real-time sensor monitoring web application that connects to an ESP32 microcontroller via WebSocket for live data visualization and relay control.

## Features

✨ **Real-Time Monitoring**
- Live sensor data updates via WebSocket
- Automatic reconnection on disconnect
- Low-latency data streaming

📊 **Sensor Support**
- Turbidity sensor (water clarity)
- TDS sensor (dissolved solids - water quality)
- MQ135 gas sensor (air quality)
- pH sensor (water acidity/alkalinity)
- TOF distance sensor (water level)

🎛️ **Relay Controls**
- Pump control
- Solenoid valve control
- UV light control
- Real-time state feedback

🎨 **User Interface**
- Modern, responsive dashboard
- Dark mode with gradient design
- Mobile-friendly layout
- Status indicators and alerts
- Data export functionality

## Installation

### Prerequisites
- Node.js (v16 or higher)
- npm or yarn
- Python 3.7+ (recommended for Windows)
- ESP32 with merged-sensors.ino firmware
- USB connection between computer and ESP32

### 🪟 Windows Users

**See [WINDOWS_FIXED.md](WINDOWS_FIXED.md) for Windows-specific setup!**

Summary: Use Python server on Windows (no build tools needed)
```bash
pip install -r requirements-python.txt
python sensor-server-python.py
```

### Setup Steps

1. **Navigate to the web-frontend directory**
   ```bash
   cd web-frontend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure the environment**
   ```bash
   cp .env.example .env
   ```

4. **Edit `.env` file with your settings**
   ```
   SERIAL_PORT=COM3          # Windows: COMx, Linux/Mac: /dev/ttyUSB0
   SERIAL_BAUD=115200        # Must match ESP32 baud rate
   WS_PORT=8080              # Web server port
   SENSOR_UPDATE_INTERVAL=500 # Update frequency in ms
   ```

## Running the Server

### Development Mode
```bash
npm run dev
```
(Requires nodemon to be installed)

### Production Mode
```bash
npm start
```

The dashboard will be available at: **http://localhost:8080**

## WebSocket API

### Message Types

#### Sensor Update (Server → Client)
```json
{
  "type": "sensor_update",
  "data": {
    "timestamp": "2024-01-15T10:30:45.123Z",
    "turbidity": 1500,
    "tds": 85.5,
    "mq135": 420.3,
    "ph": 6.8,
    "tof": 150,
    "relay_pump": false,
    "relay_solenoid": true,
    "relay_uv": false,
    "servo_angle": 90,
    "connected": true,
    "error": null
  }
}
```

#### Request Status (Client → Server)
```json
{
  "type": "request_status"
}
```

#### Relay Control (Client → Server)
```json
{
  "type": "relay_control",
  "payload": "PUMP:1"
}
```

Supported payloads:
- `PUMP:1` / `PUMP:0` - Turn pump on/off
- `SOLENOID:1` / `SOLENOID:0` - Turn solenoid on/off
- `UV:1` / `UV:0` - Turn UV light on/off

## REST API Endpoints

### Get Current Sensor Data
```
GET /api/sensors
```

### Get Server Status
```
GET /api/status
```

### Control Relays
```
POST /api/relay/pump
POST /api/relay/solenoid
POST /api/relay/uv

Body: { "state": true/false }
```

### Health Check
```
GET /health
```

## Sensor Thresholds & Alerts

| Sensor | Alert Condition | Action |
|--------|-----------------|--------|
| Turbidity | ≤ 500 | 🔴 DIRTY - Pump activated |
| Turbidity | ≥ 2000 | ✅ CLEAN - Pump deactivated |
| TDS | ≥ 100 ppm | ⚠️ HIGH - Possible contamination |
| MQ135 | ≥ 85 ppm | ⚠️ POOR AIR - UV may activate |
| pH | ≤ 6.0 | 🔴 ACIDIC - Valve opens |
| pH | ≥ 7.59 | 🔴 ALKALINE - Valve closes |

## Troubleshooting

### Serial Port Not Found
- Check the USB cable connection
- Verify the correct COM port in `.env`
- On Linux/Mac, ensure you have permissions: `sudo chmod 666 /dev/ttyUSB0`

### WebSocket Connection Failed
- Ensure the server is running on the correct port
- Check firewall settings
- Verify the client IP matches the server address

### No Sensor Data
- Verify ESP32 is uploading the `merged-sensors.ino` sketch
- Check serial monitor output at 115200 baud
- Ensure sensor data format matches expected pattern: `[LABEL] Value`

### Relay Commands Not Working
- Verify ESP32 has relay control code implemented
- Check relay pin connections
- Monitor ESP32 serial output for command reception

## Project Structure

```
web-frontend/
├── public/
│   └── index.html          # Web interface
├── server.js               # Node.js WebSocket server
├── package.json            # Dependencies
├── .env.example            # Configuration template
├── .gitignore             # Git ignore rules
└── README.md              # This file
```

## Configuration

### Serial Port Naming
- **Windows**: `COM1`, `COM2`, `COM3`, etc.
- **Linux**: `/dev/ttyUSB0`, `/dev/ttyACM0`, etc.
- **macOS**: `/dev/cu.usbserial-*`, `/dev/cu.wchusbserial*`, etc.

To find your port:
- **Windows**: Device Manager → Ports (COM & LPT)
- **Linux**: `ls /dev/tty*`
- **macOS**: `ls /dev/cu.*`

## Performance Optimization

- **Sensor Update Interval**: Default 500ms. Increase for slower networks.
- **Broadcast Optimization**: Server only sends data when values change or at interval.
- **Frame Rate**: Adjust based on your network and ESP32 capacity.

## Future Enhancements

- 📈 Historical data graphing
- 📱 Mobile app integration
- 🔔 SMS/Email alert notifications
- 🔐 User authentication
- 🌍 Multi-device support
- 📊 Data logging to database

## License

MIT License - Feel free to use and modify

## Support

For issues or questions:
1. Check the Troubleshooting section
2. Review ESP32 serial output
3. Verify network connectivity
4. Check browser console for errors

## Version

**Current Version**: 1.0.0
**Last Updated**: January 2024
