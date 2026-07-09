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

// MQTT debug tracking
let mqttDebugData = {
  broker: MQTT_BROKER,
  port: MQTT_PORT,
  connected: false,
  connectCount: 0,
  reconnectCount: 0,
  messageCount: 0,
  lastTopic: null,
  lastPayload: null,
  lastMessageAt: null,
  lastError: null,
  subscriptionError: null,
  subscribedTopics: [],
  configuredTopics: [
    'sensors/water/turbidity',
    'sensors/water/tds',
    'sensors/water/ph',
    'sensors/water/distance',
    'sensors/air/ppm',
    'sensors/air/label'
  ],
  recentMessages: [],
  serverTime: null,
  lastConnectAt: null,
  lastDisconnectAt: null
};

// Track connected WebSocket clients
const connectedClients = new Set();

// MQTT Setup for ESP32 → Pi data flow
let serialPort = null;
let parser = null;
let isConnected = false;
let mqttClient = null;
let mqttConnected = false;

function initializeMqttClient() {
  if (mqttClient) {
    return;
  }

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
    latestSensorData.connected = true;
    latestSensorData.error = null;
    
    // Update MQTT debug
    mqttDebugData.connected = true;
    mqttDebugData.connectCount += 1;
    mqttDebugData.lastConnectAt = new Date().toISOString();
    mqttDebugData.lastError = null;
    
    console.log(`[MQTT] Connected to ${MQTT_BROKER}:${MQTT_PORT}`);

    const topics = [
      'sensors/water/turbidity',
      'sensors/water/tds',
      'sensors/water/ph',
      'sensors/water/distance',
      'sensors/air/ppm',
      'sensors/air/label',
    ];

    mqttClient.subscribe(topics, (err) => {
      if (err) {
        console.error('[MQTT] Subscription failed:', err);
        mqttDebugData.subscriptionError = err.message;
      } else {
        console.log('[MQTT] Subscribed to ESP32 sensor topics');
        mqttDebugData.subscribedTopics = topics;
        mqttDebugData.subscriptionError = null;
      }
    });

    broadcastSensorData();
    broadcastMqttDebug();
  });

  mqttClient.on('message', (topic, message) => {
    try {
      const payload = message.toString().trim();
      const timestamp = new Date().toISOString();
      latestSensorData.timestamp = timestamp;
      latestSensorData.connected = true;
      latestSensorData.error = null;

      // Update MQTT debug
      mqttDebugData.messageCount += 1;
      mqttDebugData.lastTopic = topic;
      mqttDebugData.lastPayload = payload;
      mqttDebugData.lastMessageAt = timestamp;
      mqttDebugData.recentMessages.push({
        timestamp: timestamp,
        topic: topic,
        payload: payload
      });
      if (mqttDebugData.recentMessages.length > 20) {
        mqttDebugData.recentMessages.shift();
      }
      mqttDebugData.serverTime = new Date().toISOString();

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
      console.error('[MQTT] Error handling message:', error);
      mqttDebugData.lastError = error.message;
    }
  });

  mqttClient.on('error', (err) => {
    mqttConnected = false;
    latestSensorData.connected = false;
    latestSensorData.error = err.message;
    mqttDebugData.connected = false;
    mqttDebugData.lastError = err.message;
    console.error('[MQTT] Error:', err);
    broadcastSensorData();
    broadcastMqttDebug();
  });

  mqttClient.on('reconnect', () => {
    console.log('[MQTT] Reconnecting...');
    mqttDebugData.reconnectCount += 1;
  });

  mqttClient.on('close', () => {
    mqttConnected = false;
    latestSensorData.connected = false;
    latestSensorData.error = 'MQTT connection closed';
    mqttDebugData.connected = false;
    mqttDebugData.lastDisconnectAt = new Date().toISOString();
    console.log('[MQTT] Connection closed');
    broadcastSensorData();
    broadcastMqttDebug();
  });
}

function broadcastSensorData() {
  const message = JSON.stringify({
    type: 'sensor_update',
    data: latestSensorData
  });
  
  connectedClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function broadcastMqttDebug() {
  const message = JSON.stringify({
    type: 'mqtt_debug',
    data: mqttDebugData
  });
  
  connectedClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function broadcastHistoryData(ws) {
  db.all(
    'SELECT * FROM sensor_readings ORDER BY timestamp DESC LIMIT 200',
    (err, rows) => {
      if (!err && rows && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'history',
          data: rows
        }));
      }
    }
  );
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

  // Send MQTT debug data
  ws.send(JSON.stringify({
    type: 'mqtt_debug',
    data: mqttDebugData
  }));

  // Send historical data from DB
  broadcastHistoryData(ws);

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
      } else if (parsedMessage.type === 'request_history') {
        broadcastHistoryData(ws);
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

// Get historical data from database
app.get('/api/sensor-history', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const sensor = req.query.sensor || null;
  const hours = parseInt(req.query.hours) || 24;
  
  let query = 'SELECT * FROM sensor_readings';
  const params = [];
  const conditions = [];
  
  // Add time filter (last N hours)
  if (hours > 0) {
    conditions.push("timestamp > datetime('now', '-' || ? || ' hours')");
    params.push(hours);
  }
  
  if (sensor) {
    conditions.push('sensor_name = ?');
    params.push(sensor);
  }
  
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  
  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);
  
  db.all(query, params, (err, rows) => {
    if (err) {
      console.error('[DB] Query error:', err);
      res.status(500).json({ error: err.message });
    } else {
      res.json(rows);
    }
  });
});

// Get latest reading from DB for a specific sensor
app.get('/api/sensor-latest', (req, res) => {
  const sensor = req.query.sensor || null;
  
  let query = 'SELECT * FROM sensor_readings';
  const params = [];
  
  if (sensor) {
    query += ' WHERE sensor_name = ?';
    params.push(sensor);
  }
  
  query += ' ORDER BY timestamp DESC LIMIT 1';
  
  db.get(query, params, (err, row) => {
    if (err) {
      console.error('[DB] Query error:', err);
      res.status(500).json({ error: err.message });
    } else {
      res.json(row || null);
    }
  });
});

// Get statistics from database
app.get('/api/sensor-stats', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  
  db.all(`
    SELECT 
      sensor_name,
      COUNT(*) as count,
      AVG(value) as avg_value,
      MIN(value) as min_value,
      MAX(value) as max_value,
      MAX(timestamp) as last_reading
    FROM sensor_readings
    WHERE timestamp > datetime('now', '-' || ? || ' hours')
    GROUP BY sensor_name
  `, [hours], (err, rows) => {
    if (err) {
      console.error('[DB] Stats query error:', err);
      res.status(500).json({ error: err.message });
    } else {
      res.json(rows);
    }
  });
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

// MQTT Debug endpoint
app.get('/api/mqtt-debug', (req, res) => {
  res.json(mqttDebugData);
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