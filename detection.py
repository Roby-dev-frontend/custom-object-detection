"""Live detection for measured custom object classifiers."""

from typing import Any, Dict, List, Tuple

import cv2
import numpy as np

Frame = np.ndarray
Detection = Dict[str, Any]
DetectionConfig = Dict[str, Any]

DETECTION_CONFIG: DetectionConfig = {
    "backend": None,
    "object_id": None,
    "active": False,
}


def detect(frame_bgr: Frame, config: DetectionConfig) -> List[Detection]:
    """Return detections for the selected, measured custom classifier."""
    if config.get("backend") != "classifier":
        return []
    object_id = config.get("object_id")
    if not object_id:
        return []

    import classifier_detection

    return classifier_detection.detect(frame_bgr, object_id)


def draw_detections(frame_bgr: Frame, detections: List[Detection]) -> Frame:
    """Draw custom-classifier detections onto a BGR frame in place."""
    for detection in detections:
        x1, y1, x2, y2 = detection["bbox"]
        cv2.rectangle(frame_bgr, (x1, y1), (x2, y2), (0, 255, 0), 2)

        label = str(detection.get("label", ""))
        confidence = detection.get("confidence")
        if confidence is not None:
            label = f"{label} {confidence:.2f}"
        if not label:
            continue

        font_scale = max(0.5, min(1.2, (x2 - x1) / 200))
        thickness = 2 if font_scale >= 0.8 else 1
        (text_w, text_h), baseline_h = cv2.getTextSize(
            label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, thickness,
        )
        pad = max(3, int(text_h * 0.3))
        band_h = text_h + baseline_h + pad * 2
        band_top = y1 if y1 - band_h < 0 else y1 - band_h
        cv2.rectangle(
            frame_bgr,
            (x1, band_top),
            (x1 + text_w + pad * 2, band_top + band_h),
            (0, 255, 0),
            -1,
        )
        text_origin: Tuple[int, int] = (
            x1 + pad,
            band_top + band_h - pad - baseline_h,
        )
        cv2.putText(
            frame_bgr, label, text_origin, cv2.FONT_HERSHEY_SIMPLEX,
            font_scale, (0, 0, 0), thickness + 2, cv2.LINE_AA,
        )
        cv2.putText(
            frame_bgr, label, text_origin, cv2.FONT_HERSHEY_SIMPLEX,
            font_scale, (255, 255, 255), thickness, cv2.LINE_AA,
        )
    return frame_bgr


def annotate(
    frame_bgr: Frame, config: DetectionConfig = DETECTION_CONFIG
) -> Tuple[Frame, List[Detection]]:
    """Detect with the selected custom classifier and draw its boxes."""
    detections = detect(frame_bgr, config)
    return draw_detections(frame_bgr, detections), detections
