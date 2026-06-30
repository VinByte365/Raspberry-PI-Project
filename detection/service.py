from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np
import websockets
from dotenv import load_dotenv
from inference_sdk import InferenceHTTPClient

from box_utils import Box, prediction_to_box


@dataclass(frozen=True)
class Config:
    pi_stream_url: str
    detector_host: str
    detector_port: int
    roboflow_api_url: str
    roboflow_api_key: str
    roboflow_model_id: str
    inference_fps: float
    confidence_threshold: float
    jpeg_quality: int


class DetectionState:
    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.latest_frame: np.ndarray | None = None
        self.latest_jpeg: bytes | None = None
        self.latest_boxes: list[Box] = []
        self.frame_counter = 0

    async def set_frame(self, frame: np.ndarray, jpeg: bytes) -> None:
        async with self.lock:
            self.latest_frame = frame
            self.latest_jpeg = jpeg
            self.frame_counter += 1

    async def set_boxes(self, boxes: list[Box]) -> None:
        async with self.lock:
            self.latest_boxes = boxes

    async def snapshot(self) -> tuple[np.ndarray | None, bytes | None, list[Box], int]:
        async with self.lock:
            frame = self.latest_frame.copy() if self.latest_frame is not None else None
            return frame, self.latest_jpeg, list(self.latest_boxes), self.frame_counter


def load_config() -> Config:
    load_dotenv()

    api_key = os.getenv("ROBOFLOW_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("ROBOFLOW_API_KEY is required. Put it in detection/.env.")

    inference_fps = float(os.getenv("INFERENCE_FPS", "2"))
    if inference_fps <= 0:
        raise RuntimeError("INFERENCE_FPS must be greater than 0.")

    return Config(
        pi_stream_url=os.getenv("PI_STREAM_URL", "ws://<raspi-ip>:8765"),
        detector_host=os.getenv("DETECTOR_HOST", "0.0.0.0"),
        detector_port=int(os.getenv("DETECTOR_PORT", "8766")),
        roboflow_api_url=os.getenv(
            "ROBOFLOW_API_URL", "https://serverless.roboflow.com"
        ),
        roboflow_api_key=api_key,
        roboflow_model_id=os.getenv(
            "ROBOFLOW_MODEL_ID", "crayfish-4bvu4-i74yr/1"
        ),
        inference_fps=inference_fps,
        confidence_threshold=float(os.getenv("CONFIDENCE_THRESHOLD", "0.4")),
        jpeg_quality=int(os.getenv("JPEG_QUALITY", "80")),
    )


async def consume_pi_stream(config: Config, state: DetectionState) -> None:
    while True:
        try:
            print(f"[Detector] Connecting to Pi stream: {config.pi_stream_url}")
            async with websockets.connect(config.pi_stream_url) as websocket:
                print("[Detector] Connected to Pi stream.")
                async for message in websocket:
                    frame = decode_jpeg(message)
                    if frame is None:
                        continue
                    await state.set_frame(frame, bytes(message))
        except Exception as exc:
            print(f"[Detector] Pi stream unavailable: {exc}. Retrying in 3s...")
            await asyncio.sleep(3)


async def inference_loop(config: Config, state: DetectionState) -> None:
    client = InferenceHTTPClient(
        api_url=config.roboflow_api_url,
        api_key=config.roboflow_api_key,
    )
    interval_seconds = 1 / config.inference_fps

    while True:
        started_at = time.monotonic()
        frame, _, _, frame_counter = await state.snapshot()

        if frame is not None:
            try:
                result = await asyncio.to_thread(
                    client.infer,
                    frame,
                    model_id=config.roboflow_model_id,
                )
                boxes = extract_boxes(
                    result,
                    frame.shape[1],
                    frame.shape[0],
                    config.confidence_threshold,
                )
                await state.set_boxes(boxes)
                print(
                    f"[Detector] Frame {frame_counter}: {len(boxes)} detections."
                )
            except Exception as exc:
                print(f"[Detector] Roboflow inference failed: {exc}")

        elapsed = time.monotonic() - started_at
        await asyncio.sleep(max(0.0, interval_seconds - elapsed))


async def client_handler(websocket: Any, state: DetectionState, config: Config) -> None:
    print(f"[Detector] Client connected: {websocket.remote_address}")
    try:
        while True:
            frame, latest_jpeg, boxes, _ = await state.snapshot()

            if frame is not None:
                annotated = draw_boxes(frame, boxes)
                jpeg = encode_jpeg(annotated, config.jpeg_quality)
            else:
                jpeg = latest_jpeg

            count_payload = json.dumps({"type": "detection_count", "count": len(boxes)})
            await websocket.send(count_payload)

            if jpeg:
                await websocket.send(jpeg)

            await asyncio.sleep(0.03)
    except websockets.ConnectionClosed:
        pass
    finally:
        print(f"[Detector] Client disconnected: {websocket.remote_address}")


async def main() -> None:
    config = load_config()
    state = DetectionState()

    consumer_task = asyncio.create_task(consume_pi_stream(config, state))
    inference_task = asyncio.create_task(inference_loop(config, state))

    async with websockets.serve(
        lambda websocket: client_handler(websocket, state, config),
        config.detector_host,
        config.detector_port,
    ):
        print(
            "[Detector] Annotated stream online at "
            f"ws://<laptop-ip>:{config.detector_port}"
        )
        await asyncio.Future()

    consumer_task.cancel()
    inference_task.cancel()


def decode_jpeg(payload: bytes) -> np.ndarray | None:
    image_array = np.frombuffer(payload, dtype=np.uint8)
    return cv2.imdecode(image_array, cv2.IMREAD_COLOR)


def encode_jpeg(frame: np.ndarray, quality: int = 80) -> bytes | None:
    ok, buffer = cv2.imencode(
        ".jpg",
        frame,
        [cv2.IMWRITE_JPEG_QUALITY, quality],
    )
    if not ok:
        return None
    return buffer.tobytes()


def extract_boxes(
    result: dict[str, Any],
    frame_width: int,
    frame_height: int,
    confidence_threshold: float,
) -> list[Box]:
    predictions = result.get("predictions", [])
    return [
        box
        for prediction in predictions
        if (
            box := prediction_to_box(
                prediction,
                frame_width,
                frame_height,
                confidence_threshold,
            )
        )
        is not None
    ]


def draw_boxes(frame: np.ndarray, boxes: list[Box]) -> np.ndarray:
    annotated = frame.copy()

    for box in boxes:
        cv2.rectangle(
            annotated,
            (box.left, box.top),
            (box.right, box.bottom),
            (70, 230, 120),
            2,
        )
        label = f"{box.label} {box.confidence:.2f}"
        label_size, baseline = cv2.getTextSize(
            label,
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            1,
        )
        label_top = max(0, box.top - label_size[1] - baseline - 6)
        cv2.rectangle(
            annotated,
            (box.left, label_top),
            (box.left + label_size[0] + 8, label_top + label_size[1] + baseline + 6),
            (70, 230, 120),
            -1,
        )
        cv2.putText(
            annotated,
            label,
            (box.left + 4, label_top + label_size[1] + 2),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (5, 20, 12),
            1,
            cv2.LINE_AA,
        )

    return annotated


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[Detector] Shut down.")
