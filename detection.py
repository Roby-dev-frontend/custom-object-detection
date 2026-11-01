import os
import time
from typing import Any, Dict, List, Optional, Tuple

# BEFORE importing ultralytics, and it has to stay before it.
#
# ultralytics runs ONLINE = is_online() at IMPORT time, which is a DNS lookup
# against one.one.one.one and dns.google. On a machine with no network that
# fails immediately and costs nothing -- but on one with a DNS server
# configured and unreachable (exactly what happens on our own access point,
# where clients are handed a resolver that leads nowhere) it blocks until the
# resolver times out, and the whole server start waits for it.
#
# YOLO_OFFLINE=1 makes is_online() return False without asking the network.
# setdefault, not assignment: a value already in the environment wins.
os.environ.setdefault("YOLO_OFFLINE", "1")

import cv2
import numpy as np
from ultralytics import YOLO

# A frame is an OpenCV BGR image: an (H, W, 3) uint8 numpy array.
Frame = np.ndarray
# One detected object/hand, as returned by annotate().
Detection = Dict[str, Any]
# Shape of DETECTION_CONFIG below.
DetectionConfig = Dict[str, Any]

# --------------------------------------------------------------------------
# Detection config -- the single knob controlling what annotate() does.
#   backend:      "none" (no detection), "yolo" (general objects) or
#                 "classifier" (one named object from objects.db, once Misura
#                 has measured it)
#   yolo_classes: only used when backend == "yolo". A list of COCO_CLASSES
#                 keys to restrict detection to (e.g. [0, 2] for person+car),
#                 or None to detect all 80 classes.
#   object_id:    only used when backend == "classifier". Which classifier
#                 (objects.py) to look for; see classifier_detection.py.
#   location:     WHERE detection runs.
#                 "browser" (default) -- the server publishes raw frames and
#                     the page detects and draws them itself. Detection costs
#                     167 ms (hands) to 548 ms (yolo) per frame on a Pi 4,
#                     against ~15 ms for capture and encoding, so this hands
#                     the expensive 90% to hardware that is sitting idle.
#                 "server" -- the original behaviour, kept as a fallback for
#                     clients that cannot run the models. Everything below
#                     (annotate, draw_detections) serves this path.
# --------------------------------------------------------------------------
# This is the real default, not a hint: DeviceRegistry copies it at
# construction (server_fastapi.py) and nothing persists a change, so whatever
# stands here is what every page opens on after a restart.
DETECTION_CONFIG: DetectionConfig = {
    "backend": "face",
    "yolo_classes": None,
    "location": "browser",
    # Hands followed when detection runs on the server: 1 or 2. The page's
    # "Mani da rilevare" sets it; see _get_hand_detector for why 1 is default.
    "num_hands": 1,
    "object_id": None,
    # False = the Raspberry's own camera, and only that, publishes its picture
    # without detecting or drawing anything: "Osserva"/"Avvia" are off. The
    # page switches it (see /source); it has no effect on other sources.
    "active": True,
}

# COCO class indices used by the pretrained yolov8n.pt model (80 classes,
# the standard COCO object-detection set). Pass the indices you want via
# DETECTION_CONFIG["yolo_classes"]; leave it None to detect all of them.
COCO_CLASSES: Dict[int, str] = {
    0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 4: "airplane",
    5: "bus", 6: "train", 7: "truck", 8: "boat", 9: "traffic light",
    10: "fire hydrant", 11: "stop sign", 12: "parking meter", 13: "bench",
    14: "bird", 15: "cat", 16: "dog", 17: "horse", 18: "sheep", 19: "cow",
    20: "elephant", 21: "bear", 22: "zebra", 23: "giraffe", 24: "backpack",
    25: "umbrella", 26: "handbag", 27: "tie", 28: "suitcase", 29: "frisbee",
    30: "skis", 31: "snowboard", 32: "sports ball", 33: "kite",
    34: "baseball bat", 35: "baseball glove", 36: "skateboard",
    37: "surfboard", 38: "tennis racket", 39: "bottle", 40: "wine glass",
    41: "cup", 42: "fork", 43: "knife", 44: "spoon", 45: "bowl",
    46: "banana", 47: "apple", 48: "sandwich", 49: "orange", 50: "broccoli",
    51: "carrot", 52: "hot dog", 53: "pizza", 54: "donut", 55: "cake",
    56: "chair", 57: "couch", 58: "potted plant", 59: "bed",
    60: "dining table", 61: "toilet", 62: "tv", 63: "laptop", 64: "mouse",
    65: "remote", 66: "keyboard", 67: "cell phone", 68: "microwave",
    69: "oven", 70: "toaster", 71: "sink", 72: "refrigerator", 73: "book",
    74: "clock", 75: "vase", 76: "scissors", 77: "teddy bear",
    78: "hair drier", 79: "toothbrush",
}

# Italian labels for the UI. Same keys as COCO_CLASSES on purpose: the index is
# what the model and the API use, only the displayed text changes. Kept here
# next to the English names so the two can't drift apart.
COCO_CLASSES_IT: Dict[int, str] = {
    0: "persona", 1: "bicicletta", 2: "automobile", 3: "motocicletta",
    4: "aeroplano", 5: "autobus", 6: "treno", 7: "camion", 8: "barca",
    9: "semaforo", 10: "idrante", 11: "segnale di stop", 12: "parchimetro",
    13: "panchina", 14: "uccello", 15: "gatto", 16: "cane", 17: "cavallo",
    18: "pecora", 19: "mucca", 20: "elefante", 21: "orso", 22: "zebra",
    23: "giraffa", 24: "zaino", 25: "ombrello", 26: "borsetta",
    27: "cravatta", 28: "valigia", 29: "frisbee", 30: "sci", 31: "snowboard",
    32: "palla", 33: "aquilone", 34: "mazza da baseball",
    35: "guantone da baseball", 36: "skateboard", 37: "tavola da surf",
    38: "racchetta da tennis", 39: "bottiglia", 40: "bicchiere da vino",
    41: "tazza", 42: "forchetta", 43: "coltello", 44: "cucchiaio",
    45: "ciotola", 46: "banana", 47: "mela", 48: "panino", 49: "arancia",
    50: "broccoli", 51: "carota", 52: "hot dog", 53: "pizza",
    54: "ciambella", 55: "torta", 56: "sedia", 57: "divano",
    58: "pianta in vaso", 59: "letto", 60: "tavolo da pranzo", 61: "water",
    62: "televisore", 63: "computer portatile", 64: "mouse",
    65: "telecomando", 66: "tastiera", 67: "telefono cellulare",
    68: "forno a microonde", 69: "forno", 70: "tostapane", 71: "lavandino",
    72: "frigorifero", 73: "libro", 74: "orologio", 75: "vaso",
    76: "forbici", 77: "orsacchiotto", 78: "asciugacapelli",
    79: "spazzolino da denti",
}

# Absolute, NOT the bare "yolov8n.pt". ultralytics resolves a bare filename
# against the current working directory and its own weights_dir, and when it
# finds neither it DOWNLOADS from github.com/ultralytics/assets -- at import
# time, so with no internet the failure takes the whole server down before it
# ever serves a page. The file sits next to this module; say so.
YOLO_MODEL_PATH: str = os.path.join(os.path.dirname(__file__), "yolov8n.pt")

_yolo_model = YOLO(YOLO_MODEL_PATH)


def _detect_yolo(
    frame_bgr: Frame, classes: Optional[List[int]]
) -> Tuple[Frame, List[Detection]]:
    results = _yolo_model.predict(frame_bgr, imgsz=320, verbose=False, classes=classes)
    result = results[0]

    detections: List[Detection] = []
    for box in result.boxes:
        class_id = int(box.cls[0])
        x1, y1, x2, y2 = (int(v) for v in box.xyxy[0].tolist())
        detections.append(
            {
                "label": COCO_CLASSES.get(class_id, str(class_id)),
                "confidence": float(box.conf[0]),
                "bbox": (x1, y1, x2, y2),
            }
        )
    return frame_bgr, detections


def draw_detections(frame_bgr: Frame, detections: List[Detection]) -> Frame:
    """Draws detections onto frame_bgr in place and returns it.

    Split out from detection so a frame can be drawn from results that were
    computed on an EARLIER frame. Detection costs 130-550 ms on a Pi 4 while
    capture and encoding cost about 15 ms, so running it on every frame pinned
    the video to detection speed. Callers can now detect occasionally and draw
    the last result onto the frames in between.

    Every detection is drawn as its box and label. Both backends go through
    here, so a redrawn frame looks identical to a freshly detected one.
    """
    for detection in detections:
        x1, y1, x2, y2 = detection["bbox"]
        cv2.rectangle(frame_bgr, (x1, y1), (x2, y2), (0, 255, 0), 2)
        label = str(detection.get("label", ""))
        confidence = detection.get("confidence")
        if confidence is not None:
            label = f"{label} {confidence:.2f}"
        if label:
            # Same readable-at-any-size recipe as the browser's drawDetections():
            # a filled band behind white, black-outlined text, rather than bare
            # green text that vanished against a bright background.
            font_scale = max(0.5, min(1.2, (x2 - x1) / 200))
            thickness = 2 if font_scale >= 0.8 else 1
            (text_w, text_h), baseline_h = cv2.getTextSize(
                label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, thickness,
            )
            pad = max(3, int(text_h * 0.3))
            band_h = text_h + baseline_h + pad * 2
            # Above the box, like before; if that runs off the top of the
            # frame, inside it instead.
            band_top = y1 if y1 - band_h < 0 else y1 - band_h
            cv2.rectangle(
                frame_bgr, (x1, band_top), (x1 + text_w + pad * 2, band_top + band_h),
                (0, 255, 0), -1,
            )
            text_origin = (x1 + pad, band_top + band_h - pad - baseline_h)
            cv2.putText(
                frame_bgr, label, text_origin, cv2.FONT_HERSHEY_SIMPLEX, font_scale,
                (0, 0, 0), thickness + 2, cv2.LINE_AA,
            )
            cv2.putText(
                frame_bgr, label, text_origin, cv2.FONT_HERSHEY_SIMPLEX, font_scale,
                (255, 255, 255), thickness, cv2.LINE_AA,
            )
    return frame_bgr


def annotate(
    frame_bgr: Frame, config: DetectionConfig = DETECTION_CONFIG
) -> Tuple[Frame, List[Detection]]:
    """Runs whichever backend `config` selects, draws boxes/landmarks directly
    onto frame_bgr, and returns (annotated_frame, detections).

    `config` defaults to the module-level DETECTION_CONFIG; pass your own dict
    of the same shape to override per call, e.g.
        annotate(frame, {"backend": "yolo", "yolo_classes": [0]})
    Keys are read with .get(), so a partial dict like {"backend": "yolo"} works.

    `detections` is a list of dicts, one per detected object/hand:
        {"label": str, "confidence": float | None, "bbox": (x1, y1, x2, y2)}
    """
    detections = detect(frame_bgr, config)
    return draw_detections(frame_bgr, detections), detections


def detect(frame_bgr: Frame, config: DetectionConfig) -> List[Detection]:
    """annotate() without the drawing: only the list of detections.

    Split out so detection can run while incoming frames are processed.
    Returns a list of Detection objects, each with a confidence and the box
    it covers in pixel coordinates. frame_bgr is not modified.
    """
    backend = config.get("backend")
    if backend == "none" or backend is None:
        return []
    if backend == "yolo":
        return _detect_yolo(frame_bgr, config.get("yolo_classes"))[1]
    if backend == "classifier":
        # Imported here, not at module level: this is the one backend that
        # needs objects.db and therefore the database passphrase, and
        # detection.py otherwise never touches either (see its own "no
        # database" boundary in classifier_detection.py's docstring).
        import classifier_detection
        object_id = config.get("object_id")
        if not object_id:
            return []
        return classifier_detection.detect(frame_bgr, object_id)
    return []
