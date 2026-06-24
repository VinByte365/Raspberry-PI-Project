const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Try to load serialport, gracefully handle if not available
let SerialPort, ReadlineParser;
try {
  SerialPort = require('serialport').SerialPort;
  ReadlineParser = require('@serialport/parser-readline').ReadlineParser;
} catch (e) {
  console.log('[WARNING] Serial port not available. Use Python server or install: npm install serialport');
  SerialPort = null;
  ReadlineParser = null;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuration
const SERIAL_PORT = process.env.SERIAL_PORT || 'COM3';
const SERIAL_BAUD = parseInt(process.env.SERIAL_BAUD || '115200');
const WS_PORT = process.env.WS_PORT || 8080;
const SENSOR_UPDATE_INTERVAL = parseInt(process.env.SENSOR_UPDATE_INTERVAL || '500');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store latest sensor data
let latestSensorData = {
  timestamp: null,
  turbidity: 0,
  tds: 0,
  mq135: 0,
  ph: 0,
  tof: 0,
  relay_pump: false,
  relay_solenoid: false,
  relay_uv: false,
  servo_angle: 0,
  connected: false,
  error: null
};

// Track connected WebSocket clients
const connectedClients = new Set();

// Serial Port Setup
let serialPort = null;
let parser = null;
let isConnected = false;

function initializeSerialPort() {
  // Check if serialport is available
  if (!SerialPort) {
    console.log('[Serial Port] SerialPort module not available');
    console.log('[Serial Port] Options:');
    console.log('  1. Use Python server: python sensor-server-python.py');
    console.log('  2. Install serialport: npm install serialport');
    console.log('  3. Install Visual Studio Build Tools with C++ support');
    console.log('');
    console.log('For Windows, Python server is recommended (no build tools needed)');
    console.log('');
    
    latestSensorData.connected = false;
    latestSensorData.error = 'SerialPort not available. Use Python server or install via: npm install serialport';
    isConnected = false;
    return;
  }

  try {
    serialPort = new SerialPort({
      path: SERIAL_PORT,
      baudRate: SERIAL_BAUD,
      autoOpen: false
    });

    parser = serialPort.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    parser.on('data', (data) => {
      try {
        // Parse sensor data from ESP32
        // Expected format: [LABEL] VALUE
        const match = data.match(/\[(.+?)\]\s*(.+)/);
        if (match) {
          const label = match[1].trim();
          const value = match[2].trim();

          // Map labels to sensor data
          switch (label) {
            case 'TURB':
              const turbMatch = value.match(/Filtered:\s*(\d+)/);
              if (turbMatch) {
                latestSensorData.turbidity = parseInt(turbMatch[1]);
              }
              break;
            case 'TDS':
              const tdsMatch = value.match(/PPM:\s*([\d.]+)/);
              if (tdsMatch) {
                latestSensorData.tds = parseFloat(tdsMatch[1]);
              }
              break;
            case 'MQ135':
              const mqMatch = value.match(/PPM:\s*([\d.]+)/);
              if (mqMatch) {
                latestSensorData.mq135 = parseFloat(mqMatch[1]);
              }
              break;
            case 'PH':
              const phMatch = value.match(/pH:\s*([\d.]+)/);
              if (phMatch) {
                latestSensorData.ph = parseFloat(phMatch[1]);
              }
              break;
          }
          
          latestSensorData.timestamp = new Date().toISOString();
          latestSensorData.connected = true;
          latestSensorData.error = null;
        }
      } catch (error) {
        console.error('[Serial Parser] Error parsing data:', error);
      }
    });

    serialPort.on('error', (err) => {
      console.error('[Serial Port] Error:', err);
      latestSensorData.connected = false;
      latestSensorData.error = err.message;
      broadcastSensorData();
    });

    serialPort.on('close', () => {
      console.log('[Serial Port] Connection closed');
      isConnected = false;
      latestSensorData.connected = false;
      reconnectSerial();
    });

    serialPort.open((err) => {
      if (err) {
        console.error('[Serial Port] Failed to open port:', err);
        latestSensorData.connected = false;
        latestSensorData.error = err.message;
        broadcastSensorData();
        setTimeout(reconnectSerial, 5000);
      } else {
        console.log(`[Serial Port] Connected to ${SERIAL_PORT} at ${SERIAL_BAUD} baud`);
        isConnected = true;
        latestSensorData.connected = true;
        latestSensorData.error = null;
        broadcastSensorData();
      }
    });
  } catch (error) {
    console.error('[Serial Initialization] Error:', error);
    latestSensorData.connected = false;
    latestSensorData.error = error.message;
    setTimeout(reconnectSerial, 5000);
  }
}

function reconnectSerial() {
  if (!isConnected) {
    console.log('[Serial Port] Attempting to reconnect...');
    initializeSerialPort();
  }
}

function broadcastSensorData() {
  connectedClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'sensor_update',
        data: latestSensorData
      }));
    }
  });
}

// Broadcast sensor data at regular intervals
setInterval(() => {
  broadcastSensorData();
}, SENSOR_UPDATE_INTERVAL);

// WebSocket Connection Handler
wss.on('connection', (ws) => {
  console.log(`[WebSocket] New client connected. Total: ${connectedClients.size + 1}`);
  connectedClients.add(ws);

  // Send current sensor data to new client
  ws.send(JSON.stringify({
    type: 'sensor_update',
    data: latestSensorData
  }));

  ws.on('message', (message) => {
    try {
      const parsedMessage = JSON.parse(message);
      
      if (parsedMessage.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (parsedMessage.type === 'request_status') {
        ws.send(JSON.stringify({
          type: 'sensor_update',
          data: latestSensorData
        }));
      } else if (parsedMessage.type === 'relay_control') {
        // Forward relay control commands to ESP32
        if (serialPort && isConnected) {
          const command = parsedMessage.payload;
          serialPort.write(`${command}\n`);
          console.log('[WebSocket] Sent command to ESP32:', command);
        }
      }
    } catch (error) {
      console.error('[WebSocket] Message parse error:', error);
    }
  });

  ws.on('close', () => {
    connectedClients.delete(ws);
    console.log(`[WebSocket] Client disconnected. Total: ${connectedClients.size}`);
  });

  ws.on('error', (error) => {
    console.error('[WebSocket] Error:', error);
  });
});

// REST API Endpoints
app.get('/api/sensors', (req, res) => {
  res.json(latestSensorData);
});

app.post('/api/relay/pump', (req, res) => {
  const state = req.body.state;
  if (serialPort && isConnected) {
    serialPort.write(`PUMP:${state ? '1' : '0'}\n`);
    res.json({ success: true, command: `PUMP:${state ? '1' : '0'}` });
  } else {
    res.status(503).json({ success: false, error: 'Serial port not connected' });
  }
});

app.post('/api/relay/solenoid', (req, res) => {
  const state = req.body.state;
  if (serialPort && isConnected) {
    serialPort.write(`SOLENOID:${state ? '1' : '0'}\n`);
    res.json({ success: true, command: `SOLENOID:${state ? '1' : '0'}` });
  } else {
    res.status(503).json({ success: false, error: 'Serial port not connected' });
  }
});

app.post('/api/relay/uv', (req, res) => {
  const state = req.body.state;
  if (serialPort && isConnected) {
    serialPort.write(`UV:${state ? '1' : '0'}\n`);
    res.json({ success: true, command: `UV:${state ? '1' : '0'}` });
  } else {
    res.status(503).json({ success: false, error: 'Serial port not connected' });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    serial_connected: isConnected,
    connected_clients: connectedClients.size,
    serial_port: SERIAL_PORT,
    timestamp: new Date().toISOString()
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve index.html for all unmatched routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize and start server
initializeSerialPort();

server.listen(WS_PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`🚀 Sensor Dashboard Server Started`);
  console.log(`========================================`);
  console.log(`📡 WebSocket Server: ws://0.0.0.0:${WS_PORT}`);
  console.log(`🌐 HTTP Server: http://localhost:${WS_PORT}`);
  console.log(`📊 Serial Port: ${SERIAL_PORT} @ ${SERIAL_BAUD} baud`);
  console.log(`========================================\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[System] Shutting down gracefully...');
  
  if (serialPort && isConnected) {
    serialPort.close(() => {
      console.log('[Serial Port] Closed');
    });
  }

  connectedClients.forEach((client) => {
    client.close();
  });

  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });
});
