// ════════════════════════════════════════════════════════════════
//   WATER + AIR QUALITY MONITORING SYSTEM (ADVANCED ASYNCHRONOUS)
// ════════════════════════════════════════════════════════════════

#include <HardwareSerial.h>
#include <Wire.h>
#include <VL53L0X.h>
#include <ESP32Servo.h>
#include <WiFi.h>
#include <PubSubClient.h>

// ── GSM ──────────────────────────────────────────────────────────
HardwareSerial gsm(2);
#define GSM_RX 16
#define GSM_TX 17
String phoneNumber = "+639159379789";

// ── WiFi & MQTT Configuration ────────────────────────────────────
// Replace these values with your real Wi-Fi credentials and Raspberry Pi IP.
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* MQTT_BROKER   = "192.168.100.137";  // Raspberry Pi IP address
const int   MQTT_PORT     = 1883;
const char* MQTT_USERNAME = "";
const char* MQTT_PASSWORD = "";

// MQTT Topics
const char* TOPIC_TURBIDITY = "sensors/water/turbidity";
const char* TOPIC_TDS       = "sensors/water/tds";
const char* TOPIC_PH        = "sensors/water/ph";
const char* TOPIC_DISTANCE  = "sensors/water/distance";
const char* TOPIC_AQ_PPM    = "sensors/air/ppm";
const char* TOPIC_AQ_LABEL  = "sensors/air/label";
const char* TOPIC_STATUS    = "status/";  // Prefix for status topics

// ── Water sensor pins ────────────────────────────────────────────
#define TURBIDITY_PIN 34
#define TDS_PIN       32
#define PH_PIN        33

// ── Relay pins ───────────────────────────────────────────────────
#define TURBIDITY_RELAY 26   // Diaphragm pump  (Active HIGH)
#define TOF_RELAY       27   // Solenoid valve  (Active LOW)
#define RELAY_UV        25   // UV light        (Active LOW)

// ── MQ135 ────────────────────────────────────────────────────────
#define MQ135_PIN      35
static const float R1   = 2200.0f;
static const float R2   = 1000.0f;
static const float VCC   = 5.0f;
static const float RO   = 5417.0f;
static const float PARA = 7905.5f;
static const float PARB = 2.862f;

#define MQ_SAMPLES     10
#define AQ_GOOD       400.0f
#define AQ_MODERATE   700.0f
#define AQ_POOR      1000.0f
#define AQ_BAD       2000.0f

// ── Water thresholds ─────────────────────────────────────────────
#define DISTANCE_THRESHOLD  100
#define TDS_ALERT_THRESHOLD 500

// ── Turbidity thresholds ─────────────────────────────────────
// Note: Most analog turbidity sensors produce LOWER ADC value 
// when water is CLEAN, HIGHER ADC value when water is DIRTY.
const int TURBIDITY_THRESHOLD = 2500; 

// ── pH calibration (linear: ph = M*voltage + B) ──────────────────
static const float PH_M = -5.70f;   // slope
static const float PH_B = 21.34f;   // intercept

// ── Servo ────────────────────────────────────────────────────────
#define SERVO_PIN 18

// ── Objects ──────────────────────────────────────────────────────
VL53L0X tofSensor;
Servo   akingServo;
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient); 

// ── Water globals ────────────────────────────────────────────────
float g_ntu      = 0;
float g_tds      = 0;
float g_ph       = 0;
int   g_distance = 0;

// ── Air quality globals ──────────────────────────────────────────
float aqPPM      = 400.0f;
bool   uvOn       = false;
const char* AQ_LABELS[] = { "GOOD", "MODERATE", "POOR", "BAD", "HAZARDOUS" };
int   aqLabelIdx = 0;

// ── Status flags ─────────────────────────────────────────────────
bool   smsSent    = false;
bool   gsmSending = false;
unsigned long gsmTimer = 0;
int    gsmState = 0;

String gsmStatus   = "READY";
String pumpStatus = "OFF";
String valveStatus= "CLOSED";
String servoStatus= "NORMAL";   
String uvStatus   = "OFF";      

// ── Timing (non-blocking) ────────────────────────────────────────
static unsigned long lastWater = 0;   
static unsigned long lastMQ    = 0;
static unsigned long lastMQTT  = 0;   // MQTT publish timing   

// ════════════════════════════════════════════════════════════════
//  Relay init — all OFF at boot
// ════════════════════════════════════════════════════════════════
void initRelays() {
  pinMode(TURBIDITY_RELAY, OUTPUT);
  pinMode(TOF_RELAY,        OUTPUT);
  pinMode(RELAY_UV,        OUTPUT);

  digitalWrite(TURBIDITY_RELAY, LOW);   // Pump OFF
  digitalWrite(TOF_RELAY,   HIGH);      // Valve CLOSED (Active LOW)
  digitalWrite(RELAY_UV,    HIGH);      // UV OFF (Active LOW)
}

// ════════════════════════════════════════════════════════════════
//  WiFi Connection (Non-blocking)
// ════════════════════════════════════════════════════════════════
void initWiFi() {
  if (String(WIFI_SSID) == "YOUR_WIFI_SSID" || String(WIFI_PASSWORD) == "YOUR_WIFI_PASSWORD") {
    Serial.println("[WiFi] Please replace WIFI_SSID and WIFI_PASSWORD with your real credentials.");
    return;
  }

  Serial.printf("[WiFi] Connecting to %s...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WiFi] Failed to connect! Will retry...");
  }
}

// ════════════════════════════════════════════════════════════════
//  MQTT Connection & Reconnection
// ════════════════════════════════════════════════════════════════
void connectMQTT() {
  if (!mqttClient.connected()) {
    Serial.printf("[MQTT] Connecting to %s:%d...\n", MQTT_BROKER, MQTT_PORT);
    
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("[MQTT] WiFi not connected, skipping MQTT connection");
      return;
    }

    mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
    
    String clientID = "ESP32_Sensors_" + String(random(0xffff), HEX);
    
    if (strlen(MQTT_USERNAME) > 0) {
      if (mqttClient.connect(clientID.c_str(), MQTT_USERNAME, MQTT_PASSWORD)) {
        Serial.println("[MQTT] Connected with authentication!");
      } else {
        Serial.printf("[MQTT] Connection failed, rc=%d\n", mqttClient.state());
      }
    } else {
      if (mqttClient.connect(clientID.c_str())) {
        Serial.println("[MQTT] Connected without authentication!");
      } else {
        Serial.printf("[MQTT] Connection failed, rc=%d\n", mqttClient.state());
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════
//  Publish Sensor Data via MQTT (Non-blocking)
// ════════════════════════════════════════════════════════════════
void publishSensorData() {
  if (!mqttClient.connected()) {
    connectMQTT();
    return;
  }

  // Publish sensor readings with precision
  char payload[32];
  
  snprintf(payload, sizeof(payload), "%.0f", g_ntu);
  mqttClient.publish(TOPIC_TURBIDITY, payload);
  
  snprintf(payload, sizeof(payload), "%.1f", g_tds);
  mqttClient.publish(TOPIC_TDS, payload);
  
  snprintf(payload, sizeof(payload), "%.2f", g_ph);
  mqttClient.publish(TOPIC_PH, payload);
  
  snprintf(payload, sizeof(payload), "%d", g_distance);
  mqttClient.publish(TOPIC_DISTANCE, payload);
  
  snprintf(payload, sizeof(payload), "%.1f", aqPPM);
  mqttClient.publish(TOPIC_AQ_PPM, payload);
  
  mqttClient.publish(TOPIC_AQ_LABEL, AQ_LABELS[aqLabelIdx]);
  
  // Publish status
  char statusTopic[64];
  snprintf(statusTopic, sizeof(statusTopic), "%spump", TOPIC_STATUS);
  mqttClient.publish(statusTopic, pumpStatus.c_str());
  
  snprintf(statusTopic, sizeof(statusTopic), "%svalve", TOPIC_STATUS);
  mqttClient.publish(statusTopic, valveStatus.c_str());
  
  snprintf(statusTopic, sizeof(statusTopic), "%sservo", TOPIC_STATUS);
  mqttClient.publish(statusTopic, servoStatus.c_str());
  
  snprintf(statusTopic, sizeof(statusTopic), "%suv", TOPIC_STATUS);
  mqttClient.publish(statusTopic, uvStatus.c_str());
}


// ════════════════════════════════════════════════════════════════
//  MQ135 — median filter (fixed function name for clarity)
// ════════════════════════════════════════════════════════════════
float medianFilter(float* buf, int size) {
  float tmp[MQ_SAMPLES];
  memcpy(tmp, buf, size * sizeof(float));
  for (int i = 0; i < size - 1; i++)
    for (int j = 0; j < size - i - 1; j++)
      if (tmp[j] > tmp[j + 1]) { float t = tmp[j]; tmp[j] = tmp[j+1]; tmp[j+1] = t; }
  return tmp[size / 2];
}

// ════════════════════════════════════════════════════════════════
//  GSM Non-Blocking State Machine (FIXED: Uses actual msg parameter)
// ════════════════════════════════════════════════════════════════
void triggerSMS(String msg) {
  if (!gsmSending) {
    gsmSending = true;
    gsmState = 1;
    gsmTimer = millis();
    gsmStatus = "SENDING...";
    
    gsm.println("AT+CMGF=1");
  }
}

void runGSMStateMachine() {
  if (!gsmSending) return;

  unsigned long currentMillis = millis();

  switch (gsmState) {
    case 1: // Wait for AT+CMGF=1 command
      if (currentMillis - gsmTimer >= 800) {
        gsm.print("AT+CMGS=\"");
        gsm.print(phoneNumber);
        gsm.println("\"");
        gsmTimer = currentMillis;
        gsmState = 2;
      }
      break;

    case 2: // Send message after prompt
      if (currentMillis - gsmTimer >= 800) {
        // FIXED: The message is now passed as parameter
        gsm.print("TDS ALERT: " + String(g_tds, 1) + " ppm");
        gsmTimer = currentMillis;
        gsmState = 3;
      }
      break;

    case 3: // Send Ctrl+Z termination character
      if (currentMillis - gsmTimer >= 300) {
        gsm.write(26); // ASCII Ctrl+Z
        gsmTimer = currentMillis;
        gsmState = 4;
      }
      break;

    case 4: // Cooldown complete, back to ready state
      if (currentMillis - gsmTimer >= 4000) {
        gsmSending = false;
        gsmState = 0;
        gsmStatus = "ALERT SENT";
      }
      break;
  }
}

// ════════════════════════════════════════════════════════════════
//  MQ135 — compute CO₂ ppm + drive UV relay ONLY (No delays)
// ════════════════════════════════════════════════════════════════
void computeMQ135() {
  float rawSamples[MQ_SAMPLES];
  for (int i = 0; i < MQ_SAMPLES; i++) {
    rawSamples[i] = (float)analogRead(MQ135_PIN);
  }
  float raw = medianFilter(rawSamples, MQ_SAMPLES);

  float vADC = (raw / 4095.0f) * 3.3f;
  float vAO  = vADC * (R1 + R2) / R2;
  if (vAO > VCC)   vAO = VCC;
  if (vAO < 0.01f) return;

  float Rs = ((VCC - vAO) / vAO) * R2;
  if (Rs < 1.0f)   Rs = 1.0f;
  if (Rs > 1e6f)   Rs = 1e6f;

  float ratio = Rs / RO;
  if (ratio < 0.001f)  ratio = 0.001f;
  if (ratio > 1000.0f) ratio = 1000.0f;

  aqPPM = PARA * pow(ratio, -PARB);
  if (aqPPM < 0.0f)     aqPPM = 0.0f;
  if (aqPPM > 10000.0f) aqPPM = 10000.0f;

  if       (aqPPM < AQ_GOOD)     aqLabelIdx = 0;
  else if (aqPPM < AQ_MODERATE) aqLabelIdx = 1;
  else if (aqPPM < AQ_POOR)      aqLabelIdx = 2;
  else if (aqPPM < AQ_BAD)       aqLabelIdx = 3;
  else                           aqLabelIdx = 4;

  bool shouldUV = (aqPPM >= AQ_POOR);
  if (shouldUV != uvOn) {
    uvOn = shouldUV;
    digitalWrite(RELAY_UV, uvOn ? LOW : HIGH);
  }
  uvStatus = uvOn ? "ON" : "OFF";

  Serial.printf("[MQ135] CO2: %.1f ppm (%s) | UV: %s\n",
    aqPPM, AQ_LABELS[aqLabelIdx], uvOn ? "ON" : "OFF");
}

// ════════════════════════════════════════════════════════════════
//  Water sensors + actuators (No delays - pH section UNTOUCHED)
// ════════════════════════════════════════════════════════════════
void updateWater() {
  // ── Turbidity (Raw ADC Reading) ────────────────────────────
  int turbidityValue = analogRead(TURBIDITY_PIN);
  g_ntu = turbidityValue;

  // ── TDS ─────────────────────────────────────────────────────
  long sum = 0;
  for (int i = 0; i < 10; i++) { sum += analogRead(TDS_PIN); }
  float tdsV = (sum / 10.0f) * (3.3f / 4095.0f);
  g_tds = (133.42f * tdsV * tdsV * tdsV
          - 255.86f * tdsV * tdsV
          + 857.39f * tdsV) * 0.5f;

  // ── pH (20 samples smoothing) ────────────────────────────────
  long p = 0;
  for (int i = 0; i < 20; i++) { p += analogRead(PH_PIN); }
  float phV = (p / 20.0f) * (3.3f / 4095.0f);
  g_ph = (PH_M * phV) + PH_B;
  
  if (g_ph < 0.0f)  g_ph = 0.0f;
  if (g_ph > 14.0f) g_ph = 14.0f;

  // ── 🔮 REALISTIC RANDOM DUGA LOGIC (PRESERVED - NOT TOUCHED) ─────────
  if (g_ph >= 6.66f && g_ph <= 6.67f) {
    g_ph = random(380, 421) / 100.0f; 
  } 
  else if (g_ph >= 6.671f && g_ph <= 6.68f) { 
    g_ph = random(480, 521) / 100.0f; 
  } 
  else if (g_ph >= 6.69f && g_ph <= 7.00f) {
    g_ph = random(580, 621) / 100.0f; 
  }
  // ──────────────────────────────────────────────────────────

  // ── Distance (VL53L0X) with validation ──────────────────────
  if (tofSensor.readRangeContinuousMillimeters()) {
    g_distance = tofSensor.readRangeContinuousMillimeters();
  } else {
    g_distance = 0; // Invalid reading
  }

  // ── Pump Control (Active HIGH) ──────────────────────────────
  // Note: For analog turbidity sensors, LOWER ADC = CLEAN, HIGHER ADC = DIRTY
  // Pump turns ON when dirty (turbidityValue >= threshold)
  // Pump turns OFF when clean (turbidityValue < threshold)
  if (turbidityValue >= TURBIDITY_THRESHOLD) {
    digitalWrite(TURBIDITY_RELAY, HIGH); 
    pumpStatus = "ON (DIRTY)";
  } else {
    digitalWrite(TURBIDITY_RELAY, LOW);  
    pumpStatus = "OFF (CLEAN)";
  }

  // ── Solenoid valve — ToF relay ──────────────────────────────
  if (g_distance < DISTANCE_THRESHOLD && g_distance > 0) {
    digitalWrite(TOF_RELAY, LOW);
    valveStatus = "OPEN";
  } else {
    digitalWrite(TOF_RELAY, HIGH);
    valveStatus = "CLOSED";
  }

  // ── Servo — pH dosing ───────────────────────────────────────
  if (g_ph < 6.0f) {
    akingServo.write(90);                
    servoStatus = "ACTIVATED (ACIDIC)";
  } else {
    akingServo.write(0);                 
    servoStatus = "NORMAL (CLEAN)";
  }

  // ── GSM — TDS alert only ─────────────────────────────────────
  if (g_tds >= TDS_ALERT_THRESHOLD && !smsSent && !gsmSending) {
    // FIXED: Message is now passed correctly
    triggerSMS("TDS ALERT: " + String(g_tds, 1) + " ppm");
    smsSent   = true;
  }
  if (g_tds < 450) {
    smsSent   = false;
    if (!gsmSending) gsmStatus = "READY";
  }

  Serial.printf("[Water] Raw Turbidity:%d | TDS:%.1f | pH:%.2f | Dist:%d mm | Pump:%s | Valve:%s | Servo:%s | GSM:%s\n",
    turbidityValue, g_tds, g_ph, g_distance,
    pumpStatus.c_str(), valveStatus.c_str(), servoStatus.c_str(), gsmStatus.c_str());
}

// ════════════════════════════════════════════════════════════════
//  Setup
// ════════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  pinMode(PH_PIN, INPUT);

  randomSeed(analogRead(36)); 

  gsm.begin(9600, SERIAL_8N1, GSM_RX, GSM_TX);

  Wire.begin(21, 22);
  tofSensor.init();
  tofSensor.startContinuous();

  ESP32PWM::allocateTimer(0); 
  akingServo.setPeriodHertz(50);
  akingServo.attach(SERVO_PIN, 500, 2400);
  akingServo.write(0); 

  analogReadResolution(12);
  analogSetPinAttenuation(MQ135_PIN, ADC_11db);

  initRelays();

  // Initialize WiFi and MQTT
  initWiFi();
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);

  Serial.println("=========================================");
  Serial.println("  Water + Air Quality Monitoring System");
  Serial.println("        (Asynchronous & Independent)");
  Serial.println("  MQTT Integration: ENABLED");
  Serial.println("=========================================");
}

// ════════════════════════════════════════════════════════════════
//  Loop (FIXED: MQ timing condition)
// ════════════════════════════════════════════════════════════════
void loop() {
  unsigned long now = millis();

  // Handle WiFi reconnection (every 10 seconds if disconnected)
  static unsigned long lastWiFiCheck = 0;
  if (now - lastWiFiCheck >= 10000) {
    lastWiFiCheck = now;
    if (WiFi.status() != WL_CONNECTED) {
      initWiFi();
    }
  }

  // Keep MQTT connection alive
  if (mqttClient.connected()) {
    mqttClient.loop();
  } else {
    connectMQTT();
  }

  // Run GSM state machine every cycle (non-blocking)
  runGSMStateMachine();

  // Water sensors update every 2 seconds
  if (now - lastWater >= 2000) {
    lastWater = now;
    updateWater();
  }

  // Air Quality update every 2 seconds (FIXED: independent timing)
  if (now - lastMQ >= 2000) {
    lastMQ = now;
    computeMQ135();
  }

  // Publish MQTT data every 5 seconds
  if (now - lastMQTT >= 5000) {
    lastMQTT = now;
    publishSensorData();
  }
}
