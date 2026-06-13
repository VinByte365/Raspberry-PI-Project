from __future__ import annotations

from typing import Any, Mapping, NamedTuple


class Box(NamedTuple):
    left: int
    top: int
    right: int
    bottom: int
    label: str
    confidence: float


def prediction_to_box(
    prediction: Mapping[str, Any],
    frame_width: int,
    frame_height: int,
    confidence_threshold: float,
) -> Box | None:
    confidence = float(prediction.get("confidence", 0.0))
    if confidence < confidence_threshold:
        return None

    x_center = float(prediction.get("x", 0.0))
    y_center = float(prediction.get("y", 0.0))
    width = float(prediction.get("width", 0.0))
    height = float(prediction.get("height", 0.0))

    left = clamp_int(x_center - width / 2, 0, frame_width - 1)
    top = clamp_int(y_center - height / 2, 0, frame_height - 1)
    right = clamp_int(x_center + width / 2, 0, frame_width - 1)
    bottom = clamp_int(y_center + height / 2, 0, frame_height - 1)

    if right <= left or bottom <= top:
        return None

    label = str(prediction.get("class") or prediction.get("class_name") or "object")
    return Box(left, top, right, bottom, label, confidence)


def clamp_int(value: float, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, int(round(value))))
