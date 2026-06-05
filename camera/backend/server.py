import asyncio
import websockets
from camera import PiCameraBackend

# Network Configuration parameters
HOST = "0.0.0.0"  # Broadcasts across your entire local network
PORT = 8765

# Track active mobile app clients
connected_clients = set()

# Initialize our clean camera wrapper class
camera = PiCameraBackend(width=640, height=480, fps=30.0)

async def client_handler(websocket):
    """Fires automatically when Expo Go establishes a network socket."""
    connected_clients.add(websocket)
    print(f"[Network Server] Mobile client connected from {websocket.remote_address}. Active: {len(connected_clients)}")
    try:
        # Keep connection open until client closes it or leaves Wi-Fi area
        await websocket.wait_closed()
    finally:
        connected_clients.discard(websocket)
        print(f"[Network Server] Client disconnected. Active connections remaining: {len(connected_clients)}")

async def broadcast_loop():
    """Asynchronous pipeline worker that updates only on verified hardware frames."""
    print("[Network Server] Broadcast pipeline loop engaged.")
    while True:
        try:
            if connected_clients:
                # This will return a byte array only if it's a completely brand new frame
                frame_bytes = camera.get_latest_frame()

                if frame_bytes:
                    # FIX (Risk #1): Snapshot the set before iterating so a mid-send
                    # disconnect can't mutate it and raise a RuntimeError.
                    targets = list(connected_clients)
                    results = await asyncio.gather(
                        *[client.send(frame_bytes) for client in targets],
                        return_exceptions=True
                    )
                    # FIX (Risk #1): Log send failures instead of swallowing them silently
                    for client, result in zip(targets, results):
                        if isinstance(result, Exception):
                            print(f"[Network Server] Failed to send frame to {client.remote_address}: {result}")

            # FIX (Tip): 10ms is sufficient at 30fps (new frame every ~33ms) and
            # halves the unnecessary CPU spin vs the original 5ms sleep.
            await asyncio.sleep(0.010)

        except Exception as e:
            print(f"[Network Server] Broadcast routine anomaly: {e}")
            await asyncio.sleep(0.1)

async def main():
    # Start the camera worker hardware loops
    camera.start()

    # FIX (Risk #3): Launch broadcast_loop as a background task instead of awaiting
    # it directly. Awaiting it inside websockets.serve() blocks the event loop —
    # if the loop stalls, the server stops accepting new client connections entirely.
    # asyncio.create_task() lets both run concurrently on the same event loop.
    broadcast_task = asyncio.create_task(broadcast_loop())

    async with websockets.serve(client_handler, HOST, PORT):
        print(f"[Network Server] WebSockets online! Listening on ws://<your-pi-ip>:{PORT}")
        # Hold the server open forever (broadcast_task runs alongside this)
        await asyncio.Future()

    # If serve() ever exits, cancel the broadcaster cleanly
    broadcast_task.cancel()
    try:
        await broadcast_task
    except asyncio.CancelledError:
        pass

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[System] Shut down command acknowledged. Stopping processes...")
        camera.stop()