"""Live detection using a named classifier's measured method.

Kept apart from detection.py, which stays free of a database and a
passphrase, and apart from object_localisers.py, which stays "pure vision"
with no database either (see that module's own docstring). This is the
glue: it reads objects.db to find which localiser a classifier is measured
against, builds and caches ONE instance of it, and answers "is the object in
this frame" in the same shape detection.py's other backends use.

ONE CACHE SLOT, NOT ONE PER CLASSIFIER
---------------------------------------
detection_config (camera.py) is shared by the whole machine, so only one
classifier is ever being detected at a time. A cache keyed by object_id would
quietly accumulate an EfficientDet model and an embedder for every classifier
anyone ever selected, never freed.

WHY A LOCK AROUND find()
-------------------------
object_localisers.ProposalLocaliser calls MediaPipe's ObjectDetector and
ImageEmbedder, which are not documented as safe to call from two threads at
once -- the same reasoning detection.py applies to the hand landmarker with
its own _hand_lock. Several threads can reach here: one DetectSession per
own-camera device, and /camera_feed's threadpool.
"""

import logging
import threading
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

import objects
from object_localisers import LOCALISERS_BY_NAME

logger = logging.getLogger("server")

_lock = threading.Lock()
_cached_object_id: Optional[str] = None
_cached_key: Optional[tuple] = None
_cached_localiser: Optional[Any] = None
_cached_label: str = ""


def invalidate() -> None:
    """Forces the next detect() to rebuild, even for the same object_id.

    Called by every endpoint that could change the active measurement: a
    view added, deleted or boxed, or the object itself deleted. Cheap and
    never wrong to call too often -- a spurious rebuild costs one slow frame,
    a missed one would detect against a reference that no longer matches
    what get_measurement() considers current. In practice this rarely needs
    calling any more: the cache key below already changes whenever a
    reference's intactness does, which is what used to need an explicit call.
    """
    global _cached_object_id, _cached_key, _cached_localiser, _cached_label
    with _lock:
        _cached_object_id = None
        _cached_key = None
        _cached_localiser = None
        _cached_label = ""


def _build(object_id: str, measurement: Dict[str, Any]) -> Optional[Any]:
    """The localiser Misura actually validated, built from every reference
    photo and box get_measurement() pinned and found still intact -- not from
    however the classifier looks now. Returns None if none of them are
    readable; the caller treats that as "nothing detected" rather than
    raising into a capture thread."""
    crops = []
    for reference in measurement["references"]:
        jpeg = objects.view_bytes(reference["view"])
        if jpeg is None:
            continue
        full = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if full is None:
            continue
        box = reference["box"]
        crop = full[box["y"]:box["y"] + box["h"], box["x"]:box["x"] + box["w"]]
        if crop.size:
            crops.append(crop)
    if not crops:
        return None
    factory = LOCALISERS_BY_NAME.get(measurement["method"])
    if factory is None:
        logger.warning("classifier %s: unknown method %r in its measurement",
                        object_id, measurement["method"])
        return None
    try:
        return factory(crops)
    except Exception as error:  # noqa: BLE001
        logger.warning("classifier %s: building %s failed: %s",
                        object_id, measurement["method"], error)
        return None


def detect(frame_bgr: np.ndarray, object_id: str) -> List[Dict[str, Any]]:
    """One detection, in the shape detection.py's other backends use:
    [{"label": str, "confidence": float, "bbox": (x1, y1, x2, y2)}] or [].

    [] whenever the classifier has no valid, active measurement -- picking
    it under "Detect" is only possible once one exists (see server_fastapi.py
    set_source), but a measurement can still go PARTLY or entirely stale
    (a reference photo redrawn or deleted) while it is the live selection,
    and this is what makes that silent rather than a 500 from inside a
    capture thread.
    """
    global _cached_object_id, _cached_key, _cached_localiser, _cached_label

    measurement = objects.get_measurement(object_id)
    if measurement is None:
        return []

    # Which intact references actually feed the matcher below -- the cache
    # key, so losing or regaining ONE of several references (not just a full
    # re-activation, which changes measured_at) still rebuilds it.
    key = (measurement["measured_at"],
           tuple(sorted(r["view"] for r in measurement["references"])))

    with _lock:
        stale = _cached_object_id != object_id or _cached_key != key
        if stale:
            record = objects.get_object(object_id)
            _cached_label = record["name"] if record else "oggetto"
            _cached_localiser = _build(object_id, measurement)
            _cached_object_id = object_id
            _cached_key = key
        localiser = _cached_localiser
        label = _cached_label
        if localiser is None:
            return []
        box, score = localiser.find(frame_bgr)

    if box is None or score < measurement["threshold"]:
        return []
    return [{"label": label, "confidence": float(score), "bbox": box}]
