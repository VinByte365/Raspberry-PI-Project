#!/usr/bin/env python3
"""mqtt_ws_bridge.py

Listens to MQTT topics from the ESP32 and broadcasts JSON messages to
WebSocket clients on port 8767.

Run on the Raspberry Pi where Mosquitto is running.
"""
import asyncio
import json
import signal
import sys
from typing import Set

import paho.mqtt.client as mqtt
import websockets

# MQTT configuration
MQTT_BROKER = "localhost"
MQTT_PORT = 1883
MQTT_TOPICS = [
    ("sensors/water/turbidity", 0),
    ("sensors/water/tds", 0),
    ("sensors/water/ph", 0),
    ("sensors/water/distance", 0),
    ("sensors/air/ppm", 0),
    ("sensors/air/label", 0),
    ("status/", 0),
]

# WebSocket server configuration
WS_HOST = "0.0.0.0"
WS_PORT = 8767

# Shared state
connected_clients: Set[websockets.WebSocketServerProtocol] = set()
message_queue: asyncio.Queue = asyncio.Queue()

# MQTT callbacks

def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print(f"[MQTT] Connected to {MQTT_BROKER}:{MQTT_PORT}")
        # subscribe to topics
        for t, qos in MQTT_TOPICS:
            # support wildcard: if topic ends with '/', subscribe to prefix#: we'll subscribe the prefix+
            client.subscribe(t)
            print(f"[MQTT] Subscribed to {t}")
    else:
        print(f"[MQTT] Connect failed with rc={rc}")


def on_message(client, userdata, msg):
    try:
        payload = msg.payload.decode("utf-8")
    except Exception:
        payload = repr(msg.payload)

    payload_obj = {"topic": msg.topic, "payload": payload}
    # Push into asyncio queue thread-safely
    loop = asyncio.get_event_loop()
    loop.call_soon_threadsafe(message_queue.put_nowait, payload_obj)


# WebSocket broadcaster
async def broadcaster():
    print(f"[WS] Broadcaster running, waiting for messages...")
    while True:
        msg = await message_queue.get()
        if msg is None:
            break
        text = json.dumps(msg)
        if connected_clients:
            dead = []
            for ws in list(connected_clients):
                try:
                    await ws.send(text)
                except Exception:
                    dead.append(ws)
            for d in dead:
                connected_clients.discard(d)


async def ws_handler(websocket, path):
    print(f"[WS] Client connected: {websocket.remote_address}")
    connected_clients.add(websocket)
    try:
        # Keep connection open; we only push messages server->client
        await websocket.wait_closed()
    finally:
        connected_clients.discard(websocket)
        print(f"[WS] Client disconnected: {websocket.remote_address}")


def start_mqtt_client():
    client = mqtt.Client()
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(MQTT_BROKER, MQTT_PORT, keepalive=60)
    client.loop_start()
    return client


async def main():
    # Start MQTT client in background thread
    mqtt_client = start_mqtt_client()

    # Start WebSocket server
    ws_server = await websockets.serve(ws_handler, WS_HOST, WS_PORT)
    print(f"[WS] Listening on ws://{WS_HOST}:{WS_PORT}")

    # Run broadcaster task
    broadcaster_task = asyncio.create_task(broadcaster())

    # Handle shutdown signals
    stop = asyncio.Event()

    def _signal_handler(sig, frame):
        print(f"[System] Signal {sig} received, shutting down...")
        stop.set()

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    await stop.wait()

    # Shutdown
    broadcaster_task.cancel()
    mqtt_client.loop_stop()
    mqtt_client.disconnect()
    ws_server.close()
    await ws_server.wait_closed()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("[System] Interrupted")
        sys.exit(0)
