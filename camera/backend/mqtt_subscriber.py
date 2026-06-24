import json
import signal
import sys
import time

import paho.mqtt.client as mqtt

# MQTT broker settings
MQTT_BROKER = "192.168.x.x"  # Raspberry Pi IP address
MQTT_PORT = 1883
MQTT_USERNAME = ""  # Optional: set if broker requires auth
MQTT_PASSWORD = ""  # Optional: set if broker requires auth
CLIENT_ID = "pi_camera_mqtt_subscriber"

TOPICS = [
    ("sensors/water/turbidity", 0),
    ("sensors/water/tds", 0),
    ("sensors/water/ph", 0),
    ("sensors/water/distance", 0),
    ("sensors/air/ppm", 0),
    ("sensors/air/label", 0),
    ("status/+", 0),
]

state = {
    "water": {},
    "air": {},
    "status": {},
}


def format_state() -> str:
    return json.dumps(state, indent=2)


def print_update(topic: str, payload: str):
    print(f"[MQTT] {topic} -> {payload}")
    print(format_state())
    print("---")


def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print(f"[MQTT] Connected to broker {MQTT_BROKER}:{MQTT_PORT}")
        for topic, qos in TOPICS:
            client.subscribe(topic, qos=qos)
            print(f"[MQTT] Subscribed to {topic}")
        print("[MQTT] Waiting for incoming sensor messages...\n")
    else:
        print(f"[MQTT] Failed to connect, rc={rc}")


def on_message(client, userdata, msg):
    try:
        payload = msg.payload.decode("utf-8").strip()
    except UnicodeDecodeError:
        payload = repr(msg.payload)

    topic_parts = msg.topic.split("/")
    if len(topic_parts) >= 2:
        section = topic_parts[0]
        key = "/".join(topic_parts[1:])
        if section in state:
            state[section][key] = payload
        else:
            state.setdefault(section, {})[key] = payload

    print_update(msg.topic, payload)


def on_disconnect(client, userdata, rc):
    print(f"[MQTT] Disconnected from broker (rc={rc}). Reconnecting in 5s...")
    time.sleep(5)
    try:
        client.reconnect()
    except Exception as exc:
        print(f"[MQTT] Reconnect failed: {exc}")


def cleanup(signal_number, frame):
    print("\n[MQTT] Shutting down subscriber...")
    client.disconnect()
    sys.exit(0)


client = mqtt.Client(client_id=CLIENT_ID)
client.on_connect = on_connect
client.on_message = on_message
client.on_disconnect = on_disconnect

if MQTT_USERNAME:
    client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)

signal.signal(signal.SIGINT, cleanup)
signal.signal(signal.SIGTERM, cleanup)

print("[MQTT] Starting subscriber...")
client.connect(MQTT_BROKER, MQTT_PORT, keepalive=60)
client.loop_forever()
