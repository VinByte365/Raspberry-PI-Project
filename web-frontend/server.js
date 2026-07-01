const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const mqtt = require('mqtt');
const sqlite3 = require('sqlite3').verbose();
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
const MQTT_BROKER = process.env.MQTT_BROKER || 'localhost';
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883');
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const MQTT_TOPICS = [
  'sensors/water/turbidity',
  'sensors/water/tds',
  'sensors/water/ph',
  'sensors/water/distance',
  'sensors/air/ppm',
  'sensors/air/label',
];

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH = path.join(__dirname, 'sensor_data.sqlite');
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('[DB] Failed to open SQLite database:', err.message);
  } else {
    console.log(`[DB] SQLite database ready at ${DB_PATH}`);
  }
});

function initializeDatabase() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS sensor_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        topic TEXT NOT NULL,
        sensor_name TEXT NOT NULL,
        value REAL,
        raw_value TEXT,
        source TEXT NOT NULL DEFAULT 'mqtt'
      )
    `, (err) => {
      if (err) {
        console.error('[DB] Failed to create sensor_readings table:', err.message);
      } else {
        console.log('[DB] sensor_readings table ready');
      }
    });
  });
}

function saveSensorReading(topic, payload, sensorName, numericValue) {
  const timestamp = new Date().toISOString();
  db.run(
    'INSERT INTO sensor_readings (timestamp, topic, sensor_name, value, raw_value, source) VALUES (?, ?, ?, ?, ?, ?)',
    [timestamp, topic, sensorName, numericValue, payload, 'mqtt'],
    (err) => {
      if (err) {
        console.error('[DB] Failed to save sensor reading:', err.message);
      }
    }
  );
}

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
  air_label: '',
  connected: false,
  error: null
};

// Track connected WebSocket clients
const connectedClients = new Set();

// MQTT Setup for ESP32 → Pi data flow
let serialPort = null;
let parser = null;
let isConnected = false;
let mqttClient = null;
let mqttConnected = false;
let mqttDebug = {
  broker: MQTT_BROKER,
  port: MQTT_PORT,
  connected: false,
  configuredTopics: MQTT_TOPICS,
  subscribedTopics: [],
  connectCount: 0,
  reconnectCount: 0,
  messageCount: 0,
  lastConnectAt: null,
  lastDisconnectAt: null,
  lastMessageAt: null,
  lastTopic: null,
  lastPayload: null,
  lastError: null,
  subscriptionError: null,
  recentMessages: [],
};

function getMqttDebugPayload() {
  return {
    ...mqttDebug,
    connected: mqttConnected,
    clientPresent: Boolean(mqttClient),
    serverTime: new Date().toISOString(),
  };
}

function broadcastMqttDebug() {
  const payload = JSON.stringify({
    type: 'mqtt_debug',
    data: getMqttDebugPayload()
  });

  connectedClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function recordMqttMessage(topic, payload) {
  mqttDebug.messageCount += 1;
  mqttDebug.lastMessageAt = new Date().toISOString();
  mqttDebug.lastTopic = topic;
  mqttDebug.lastPayload = payload;
  mqttDebug.lastError = null;
  mqttDebug.recentMessages.unshift({
    topic,
    payload,
    timestamp: mqttDebug.lastMessageAt,
  });
  mqttDebug.recentMessages = mqttDebug.recentMessages.slice(0, 8);
}

function initializeMqttClient() {
  if (mqttClient) {
    return;
  }

  // NOTE: This connects to an EXISTING MQTT broker (e.g. Mosquitto running
  // as a system service on the Pi at localhost:1883). It does NOT start its
  // own broker — Mosquitto already owns port 1883, so we just act as a client.
  const mqttOptions = {
    host: MQTT_BROKER,
    port: MQTT_PORT,
    protocol: 'mqtt',
    keepalive: 60,
    reconnectPeriod: 5000,
  };

  if (MQTT_USERNAME) {
    mqttOptions.username = MQTT_USERNAME;
  }
  if (MQTT_PASSWORD) {
    mqttOptions.password = MQTT_PASSWORD;
  }

  mqttClient = mqtt.connect(mqttOptions);

  mqttClient.on('connect', () => {
    mqttConnected = true;
    mqttDebug.connected = true;
    mqttDebug.connectCount += 1;
    mqttDebug.lastConnectAt = new Date().toISOString();
    mqttDebug.lastError = null;
    mqttDebug.subscriptionError = null;
    latestSensorData.connected = true;
    latestSensorData.error = null;
    console.log(`[MQTT] Connected to ${MQTT_BROKER}:${MQTT_PORT}`);

    mqttClient.subscribe(MQTT_TOPICS, (err, granted) => {
      if (err) {
        mqttDebug.subscriptionError = err.message;
        console.error('[MQTT] Subscription failed:', err);
      } else {
        mqttDebug.subscribedTopics = (granted || []).map((item) => item.topic);
        console.log('[MQTT] Subscribed to ESP32 sensor topics');
      }
      broadcastMqttDebug();
    });

    broadcastSensorData();
    broadcastMqttDebug();
  });

  mqttClient.on('message', (topic, message) => {
    try {
      const payload = message.toString().trim();
      recordMqttMessage(topic, payload);
      const timestamp = new Date().toISOString();
      latestSensorData.timestamp = timestamp;
      latestSensorData.connected = true;
      latestSensorData.error = null;

      let numericValue = null;
      let sensorName = null;

      switch (topic) {
        case 'sensors/water/turbidity':
          numericValue = Number(payload) || 0;
          sensorName = 'turbidity';
          latestSensorData.turbidity = numericValue;
          break;
        case 'sensors/water/tds':
          numericValue = Number(payload) || 0;
          sensorName = 'tds';
          latestSensorData.tds = numericValue;
          break;
        case 'sensors/water/ph':
          numericValue = Number(payload) || 0;
          sensorName = 'ph';
          latestSensorData.ph = numericValue;
          break;
        case 'sensors/water/distance':
          numericValue = Number(payload) || 0;
          sensorName = 'distance';
          latestSensorData.tof = numericValue;
          break;
        case 'sensors/air/ppm':
          numericValue = Number(payload) || 0;
          sensorName = 'air_ppm';
          latestSensorData.mq135 = numericValue;
          break;
        case 'sensors/air/label':
          sensorName = 'air_label';
          latestSensorData.air_label = payload;
          break;
        default:
          break;
      }

      if (sensorName) {
        saveSensorReading(topic, payload, sensorName, numericValue);
      }

      broadcastSensorData();
      broadcastMqttDebug();
    } catch (error) {
      mqttDebug.lastError = error.message;
      console.error('[MQTT] Error handling message:', error);
      broadcastMqttDebug();
    }
  });

  mqttClient.on('error', (err) => {
    mqttConnected = false;
    mqttDebug.connected = false;
    mqttDebug.lastError = err.message;
    latestSensorData.connected = false;
    latestSensorData.error = err.message;
    console.error('[MQTT] Error:', err);
    broadcastSensorData();
    broadcastMqttDebug();
  });

  mqttClient.on('reconnect', () => {
    mqttDebug.reconnectCount += 1;
    mqttDebug.lastError = 'Reconnecting to MQTT broker';
    console.log('[MQTT] Reconnecting...');
    broadcastMqttDebug();
  });

  mqttClient.on('close', () => {
    mqttConnected = false;
    mqttDebug.connected = false;
    mqttDebug.lastDisconnectAt = new Date().toISOString();
    latestSensorData.connected = false;
    latestSensorData.error = 'MQTT connection closed';
    console.log('[MQTT] Connection closed');
    broadcastSensorData();
    broadcastMqttDebug();
  });
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
  ws.send(JSON.stringify({
    type: 'mqtt_debug',
    data: getMqttDebugPayload()
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
      } else if (parsedMessage.type === 'request_mqtt_debug') {
        ws.send(JSON.stringify({
          type: 'mqtt_debug',
          data: getMqttDebugPayload()
        }));
      } else if (parsedMessage.type === 'relay_control') {
        const command = parsedMessage.payload;
        if (mqttClient && mqttConnected) {
          mqttClient.publish('control/relay', command);
          console.log('[WebSocket] Published relay command to MQTT:', command);
        } else if (serialPort && isConnected) {
          serialPort.write(`${command}\n`);
          console.log('[WebSocket] Sent command to ESP32 over serial:', command);
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
  if (mqttClient && mqttConnected) {
    mqttClient.publish('control/relay', `PUMP:${state ? '1' : '0'}`);
    res.json({ success: true, command: `PUMP:${state ? '1' : '0'}` });
  } else if (serialPort && isConnected) {
    serialPort.write(`PUMP:${state ? '1' : '0'}\n`);
    res.json({ success: true, command: `PUMP:${state ? '1' : '0'}` });
  } else {
    res.status(503).json({ success: false, error: 'ESP32 not reachable over MQTT or serial' });
  }
});

app.post('/api/relay/solenoid', (req, res) => {
  const state = req.body.state;
  if (mqttClient && mqttConnected) {
    mqttClient.publish('control/relay', `SOLENOID:${state ? '1' : '0'}`);
    res.json({ success: true, command: `SOLENOID:${state ? '1' : '0'}` });
  } else if (serialPort && isConnected) {
    serialPort.write(`SOLENOID:${state ? '1' : '0'}\n`);
    res.json({ success: true, command: `SOLENOID:${state ? '1' : '0'}` });
  } else {
    res.status(503).json({ success: false, error: 'ESP32 not reachable over MQTT or serial' });
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
    mqtt_connected: mqttConnected,
    serial_connected: isConnected,
    connected_clients: connectedClients.size,
    mqtt_broker: `${MQTT_BROKER}:${MQTT_PORT}`,
    serial_port: SERIAL_PORT,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/mqtt-debug', (req, res) => {
  res.json(getMqttDebugPayload());
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
initializeDatabase();
initializeMqttClient();

server.listen(WS_PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`🚀 Sensor Dashboard Server Started`);
  console.log(`========================================`);
  console.log(`📡 WebSocket Server: ws://0.0.0.0:${WS_PORT}`);
  console.log(`🌐 HTTP Server: http://localhost:${WS_PORT}`);
  console.log(`📶 MQTT Broker: ${MQTT_BROKER}:${MQTT_PORT}`);
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

  if (mqttClient) {
    mqttClient.end(true, () => {
      console.log('[MQTT] Client disconnected');
    });
  }

  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });
});
