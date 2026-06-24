#!/usr/bin/env python3
"""
Alternative WebSocket Sensor Server (Python)
For users who prefer Python over Node.js
"""

import asyncio
import json
import re
import serial
import sys
from datetime import datetime
from pathlib import Path

try:
    import websockets
except ImportError:
    print("ERROR: websockets library not installed")
    print("Install with: pip install websockets pyserial")
    sys.exit(1)

# Configuration
SERIAL_PORT = "/dev/ttyUSB0"  # Change to COM3 on Windows
SERIAL_BAUD = 115200
WS_HOST = "0.0.0.0"
WS_PORT = 8765
UPDATE_INTERVAL = 0.5

# Global state
clients = set()
sensor_data = {
    "timestamp": None,
    "turbidity": 0,
    "tds": 0,
    "mq135": 0,
    "ph": 0,
    "tof": 0,
    "relay_pump": False,
    "relay_solenoid": False,
    "relay_uv": False,
    "connected": False,
    "error": None
}

class SerialReader:
    """Handles serial communication with ESP32"""
    
    def __init__(self, port, baudrate):
        self.port = port
        self.baudrate = baudrate
        self.serial = None
        self.connected = False
    
    def connect(self):
        """Connect to serial port"""
        try:
            self.serial = serial.Serial(
                port=self.port,
                baudrate=self.baudrate,
                timeout=1
            )
            self.connected = True
            print(f"✅ Connected to {self.port} @ {self.baudrate} baud")
            return True
        except Exception as e:
            print(f"❌ Failed to connect: {e}")
            self.connected = False
            return False
    
    def disconnect(self):
        """Disconnect from serial port"""
        if self.serial and self.serial.is_open:
            self.serial.close()
            self.connected = False
            print("Serial port closed")
    
    def read_line(self):
        """Read a line from serial port"""
        if not self.connected or not self.serial.is_open:
            return None
        
        try:
            if self.serial.in_waiting:
                line = self.serial.readline().decode('utf-8').strip()
                return line
        except Exception as e:
            print(f"Serial read error: {e}")
            self.connected = False
        
        return None
    
    def write_command(self, command):
        """Send command to ESP32"""
        if not self.connected or not self.serial.is_open:
            return False
        
        try:
            self.serial.write((command + '\n').encode('utf-8'))
            return True
        except Exception as e:
            print(f"Serial write error: {e}")
            return False


def parse_sensor_data(line):
    """Parse sensor data from serial line"""
    global sensor_data
    
    try:
        # Match format: [LABEL] Value
        match = re.match(r'\[(.+?)\]\s*(.+)', line)
        if not match:
            return
        
        label = match.group(1).strip()
        value = match.group(2).strip()
        
        # Parse specific sensor types
        if label == 'TURB':
            m = re.search(r'Filtered:\s*(\d+)', value)
            if m:
                sensor_data['turbidity'] = int(m.group(1))
        
        elif label == 'TDS':
            m = re.search(r'PPM:\s*([\d.]+)', value)
            if m:
                sensor_data['tds'] = float(m.group(1))
        
        elif label == 'MQ135':
            m = re.search(r'PPM:\s*([\d.]+)', value)
            if m:
                sensor_data['mq135'] = float(m.group(1))
        
        elif label == 'PH':
            m = re.search(r'pH:\s*([\d.]+)', value)
            if m:
                sensor_data['ph'] = float(m.group(1))
        
        elif label == 'TOF':
            m = re.search(r'Distance:\s*(\d+)', value)
            if m:
                sensor_data['tof'] = int(m.group(1))
        
        sensor_data['timestamp'] = datetime.now().isoformat()
        sensor_data['connected'] = True
        sensor_data['error'] = None
        
    except Exception as e:
        print(f"Parse error: {e}")


async def websocket_handler(websocket, path):
    """Handle WebSocket client connection"""
    clients.add(websocket)
    client_addr = websocket.remote_address
    print(f"[WS] Client connected: {client_addr} (Total: {len(clients)})")
    
    try:
        # Send current sensor data
        await websocket.send(json.dumps({
            "type": "sensor_update",
            "data": sensor_data
        }))
        
        # Listen for messages
        async for message in websocket:
            try:
                msg = json.loads(message)
                print(f"[WS] Received: {msg}")
                
                if msg.get('type') == 'ping':
                    await websocket.send(json.dumps({'type': 'pong'}))
                
                elif msg.get('type') == 'request_status':
                    await websocket.send(json.dumps({
                        "type": "sensor_update",
                        "data": sensor_data
                    }))
                
                elif msg.get('type') == 'relay_control':
                    print(f"Relay control: {msg.get('payload')}")
                    # Could send to serial here if needed
                    
            except json.JSONDecodeError:
                print(f"Invalid JSON: {message}")
    
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        clients.discard(websocket)
        print(f"[WS] Client disconnected: {client_addr} (Total: {len(clients)})")


async def broadcast_sensor_data():
    """Broadcast sensor data to all connected clients"""
    while True:
        await asyncio.sleep(UPDATE_INTERVAL)
        
        if clients:
            message = json.dumps({
                "type": "sensor_update",
                "data": sensor_data
            })
            
            # Send to all connected clients
            dead_clients = set()
            for client in clients:
                try:
                    await client.send(message)
                except Exception as e:
                    print(f"Send error: {e}")
                    dead_clients.add(client)
            
            # Remove dead connections
            for client in dead_clients:
                clients.discard(client)


async def serial_reader_loop(reader):
    """Read from serial port in background"""
    while True:
        await asyncio.sleep(0.1)
        
        if reader.connected:
            line = reader.read_line()
            if line:
                parse_sensor_data(line)
        else:
            # Try to reconnect
            if not reader.connect():
                await asyncio.sleep(5)


async def main():
    """Main server loop"""
    
    # Initialize serial reader
    reader = SerialReader(SERIAL_PORT, SERIAL_BAUD)
    
    # Try to connect
    if not reader.connect():
        print("WARNING: Serial port not connected. Will retry automatically.")
        sensor_data['connected'] = False
        sensor_data['error'] = "Serial port not available"
    
    print(f"\n========================================")
    print(f"🚀 Sensor Server Started (Python)")
    print(f"========================================")
    print(f"📡 WebSocket: ws://{WS_HOST}:{WS_PORT}")
    print(f"📊 Serial Port: {SERIAL_PORT} @ {SERIAL_BAUD} baud")
    print(f"🔄 Update Interval: {UPDATE_INTERVAL}s")
    print(f"========================================\n")
    
    # Create tasks
    serial_task = asyncio.create_task(serial_reader_loop(reader))
    broadcast_task = asyncio.create_task(broadcast_sensor_data())
    
    try:
        async with websockets.serve(websocket_handler, WS_HOST, WS_PORT):
            print(f"✅ WebSocket server listening on ws://{WS_HOST}:{WS_PORT}")
            await asyncio.Future()  # Run forever
    
    except KeyboardInterrupt:
        print("\n[System] Shutting down...")
    
    finally:
        serial_task.cancel()
        broadcast_task.cancel()
        reader.disconnect()
        print("[System] Server stopped")


if __name__ == "__main__":
    asyncio.run(main())
