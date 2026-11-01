"""Finding an object nobody has trained for, three different ways.

WHY THIS FILE EXISTS SEPARATELY
-------------------------------
For an object nobody has trained for there is nothing that says "something is
here" -- no detector that can say where to look -- and without that an
embedding can answer "is the object in view?" but can never draw a box round
it.

There is no way to know from reading code which substitute works for a
particular object: it is a property of the object, not of the algorithm. So all
three are implemented, measured against real photographs, and the winner is
chosen from the numbers.

Pure vision: no database, no passphrase, no HTTP. That is deliberate, and it is
what lets the same code serve both front doors -- scripts/object_bench.py on
the command line, and POST /objects/measure from the app -- without either
growing its own copy that can drift.
"""

import os
import statistics
import urllib.request
from typing import Any, Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))

# Already in the project root: the app serves this file to the browser.
EFFICIENTDET_PATH = os.path.join(_HERE, "efficientdet_lite0.tflite")

# The embedder both halves of the app would use. 4.1 MB, fetched on first use
# the way detection.py already fetches hand_landmarker.task.
EMBEDDER_PATH = os.path.join(_HERE, "mobilenet_v3_small.tflite")
EMBEDDER_URL = (
    "https://storage.googleapis.com/mediapipe-models/image_embedder"
    "/mobilenet_v3_small/float32/1/mobilenet_v3_small.tflite"
)

# --- ORB ---------------------------------------------------------------
# Generous but cheap: ORB is a corner detector, not a network. Too few
# keypoints and a partly-hidden object stops matching at all.
ORB_FEATURES = 1500
# Lowe's ratio, the classic 0.75: below it a match is distinctive rather than
# one of many similar-looking corners.
LOWE_RATIO = 0.75
# Fewer inliers than this and a homography is fitting noise.
MIN_INLIERS = 10

# --- proposals ---------------------------------------------------------
# Far below the 0.5 the app uses for real detection. We are not asking
# EfficientDet what the thing IS -- only whether there is an object there at
# all -- so recall matters and its labels are discarded.
PROPOSAL_SCORE = 0.15
PROPOSAL_MAX = 20

# --- template ----------------------------------------------------------
TEMPLATE_SCALES = [0.5, 0.65, 0.8, 1.0, 1.25, 1.5, 2.0]

# How many boxed photos become references at all -- gathered once in
# server_fastapi.py's _gather_measurement_inputs and shared by every method
# compare() runs. orb and proposals barely notice this growing (they pay for
# the frame's own features/detector once regardless of reference count), so
# this number is sized for THEM: a real classifier, boxed for every side of
# the object and every lighting condition, genuinely needs more than a
# handful. Raised 4 -> 10 -> 20 as that became clear in practice.
MAX_REFERENCES = 20

# Template is the one method that does NOT get to use all of the above: it
# reruns its whole 7-scale sweep once per reference, measured on a desktop PC
# (scripts/object_bench.py speed --refs N) going from ~130ms at 1 reference to
# ~535ms at 8, on a 480x480 frame -- roughly linear, so MAX_REFERENCES (20)
# references would cost well over a second per frame for this method alone,
# worse again on a Raspberry Pi. TemplateLocaliser therefore caps ITSELF to
# this many of whatever reference list it is handed (see its own docstring),
# rather than everything upstream needing to know template is different.
MAX_TEMPLATE_REFERENCES = 6


def ensure_embedder() -> None:
    if not os.path.exists(EMBEDDER_PATH):
        urllib.request.urlretrieve(EMBEDDER_URL, EMBEDDER_PATH)


Box = Tuple[int, int, int, int]


def _best(results: Sequence[Tuple[Optional[Box], float]]) -> Tuple[Optional[Box], float]:
    """The single best entry of a find_all() list: a box beats no box, and the
    higher score wins otherwise. Every Localiser's find() is this, over its
    own find_all() -- a drop-in single answer on top of the per-reference one,
    for the one caller (classifier_detection.py) that only wants "the" match.
    """
    if not results:
        return None, 0.0
    return max(results, key=lambda item: (item[0] is not None, item[1]))


class OrbLocaliser:
    """Keypoints matched against the enrolled crops, boxed via a homography.

    Strong on rigid, textured things -- a printed box, a book, a label, a tool.
    Blind to anything smooth, shiny or plain: no texture, no keypoints, nothing
    to match. It is also the only one of the three that can REFUSE, which is
    why its false-positive rate is meaningful on its own.

    Takes several reference crops (different angles, distances, lighting of
    the same object) rather than one: the frame's own keypoints are extracted
    once, matched once against all references' descriptors together, and only
    THEN split back out by which reference each match came from -- each
    reference's homography depends only on its own matches, matching against
    the reference is what knnMatch's query side does, so concatenating first
    and splitting after is exactly the same result as running N separate
    matches, for one feature-extraction pass instead of N.
    """

    name = "orb"

    def __init__(self, references: Sequence[np.ndarray]) -> None:
        if not references:
            raise ValueError("OrbLocaliser needs at least one reference crop.")
        self.orb = cv2.ORB_create(nfeatures=ORB_FEATURES)
        # One entry per reference, dead ones kept as (kp, None, shape) so
        # indices stay aligned with references -- a caller matching with_frames
        # to a reference index cannot do that if a reference silently vanishes.
        self.refs: List[Tuple[Any, Any, Tuple[int, int]]] = []
        descs: List[Any] = []
        owners: List[int] = []
        # Where each reference's own descriptors start inside the
        # concatenated self.all_desc below -- a match's queryIdx is a GLOBAL
        # row in that concatenation, and has to have this subtracted back off
        # before it means anything as an index into THAT reference's own
        # keypoint list (ref_kp below). Forgetting this worked by accident for
        # reference 0 (offset 0) and indexed into the wrong keypoints, or
        # raised IndexError, for every reference after it.
        self.offsets: Dict[int, int] = {}
        cursor = 0
        for index, reference in enumerate(references):
            gray = cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY)
            kp, desc = self.orb.detectAndCompute(gray, None)
            self.refs.append((kp, desc, reference.shape[:2]))
            if desc is not None and len(kp) >= MIN_INLIERS:
                self.offsets[index] = cursor
                descs.append(desc)
                owners.extend([index] * len(desc))
                cursor += len(desc)
        # How many references actually had enough texture to match against --
        # surfaced in compare()'s row so a classifier of shiny, textureless
        # objects shows WHY orb's score barely moves when a reference is added.
        self.usable = len({o for o in owners})
        self.all_desc = np.vstack(descs) if descs else None
        self.owner = np.array(owners, dtype=np.int64) if owners else None
        # Hamming: ORB descriptors are binary strings.
        self.matcher = cv2.BFMatcher(cv2.NORM_HAMMING)

    def find_all(self, frame: np.ndarray) -> List[Tuple[Optional[Box], float]]:
        results: List[Tuple[Optional[Box], float]] = [(None, 0.0) for _ in self.refs]
        if self.all_desc is None:
            return results
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        kp, desc = self.orb.detectAndCompute(gray, None)
        if desc is None or len(kp) < MIN_INLIERS:
            return results
        pairs = self.matcher.knnMatch(self.all_desc, desc, k=2)
        good = [m for m, n in (p for p in pairs if len(p) == 2)
                if m.distance < LOWE_RATIO * n.distance]
        if not good:
            return results
        frame_h, frame_w = frame.shape[:2]
        by_owner: Dict[int, List[Any]] = {}
        for m in good:
            by_owner.setdefault(int(self.owner[m.queryIdx]), []).append(m)
        for index, (ref_kp, _ref_desc, shape) in enumerate(self.refs):
            matches = by_owner.get(index)
            if not matches:
                continue
            if len(matches) < MIN_INLIERS:
                results[index] = (None, float(len(matches)))
                continue
            offset = self.offsets[index]
            src = np.float32([ref_kp[m.queryIdx - offset].pt for m in matches]).reshape(-1, 1, 2)
            dst = np.float32([kp[m.trainIdx].pt for m in matches]).reshape(-1, 1, 2)
            matrix, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
            if matrix is None or mask is None:
                results[index] = (None, float(len(matches)))
                continue
            inliers = int(mask.sum())
            if inliers < MIN_INLIERS:
                results[index] = (None, float(inliers))
                continue
            height, width = shape
            corners = np.float32(
                [[0, 0], [0, height - 1], [width - 1, height - 1], [width - 1, 0]]
            ).reshape(-1, 1, 2)
            projected = cv2.perspectiveTransform(corners, matrix).reshape(-1, 2)
            xs, ys = projected[:, 0], projected[:, 1]
            box = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
            # A homography can fold the corners into a sliver or fling them off
            # the frame. Both are failures wearing the costume of a detection.
            w, h = box[2] - box[0], box[3] - box[1]
            if w < 8 or h < 8 or w > frame_w * 2 or h > frame_h * 2:
                results[index] = (None, float(inliers))
                continue
            results[index] = (box, float(inliers))
        return results

    def find(self, frame: np.ndarray) -> Tuple[Optional[Box], float]:
        return _best(self.find_all(frame))


class ProposalLocaliser:
    """EfficientDet's boxes with its labels thrown away, ranked by the embedder.

    Handles texture-free things ORB cannot -- but it may propose nothing at all
    for a shape unlike any COCO category, and it always returns its best guess,
    so its score distribution matters more than its hit rate.

    Takes several reference crops: EfficientDet runs once per frame regardless
    (it knows nothing about the references), and each proposal box is embedded
    once; what used to be one cosine similarity per proposal becomes one per
    (proposal, reference) pair, which is cheap -- a dot product -- next to the
    detector and embedder calls already paid for a single reference.
    """

    name = "proposals"

    def __init__(self, references: Sequence[np.ndarray]) -> None:
        if not references:
            raise ValueError("ProposalLocaliser needs at least one reference crop.")
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision

        self.mp = mp
        self.vision = vision
        self.detector = vision.ObjectDetector.create_from_options(
            vision.ObjectDetectorOptions(
                base_options=mp_python.BaseOptions(model_asset_path=EFFICIENTDET_PATH),
                score_threshold=PROPOSAL_SCORE,
                max_results=PROPOSAL_MAX,
                running_mode=vision.RunningMode.IMAGE,
            )
        )
        ensure_embedder()
        self.embedder = vision.ImageEmbedder.create_from_options(
            vision.ImageEmbedderOptions(
                base_options=mp_python.BaseOptions(model_asset_path=EMBEDDER_PATH),
                l2_normalize=True,
                running_mode=vision.RunningMode.IMAGE,
            )
        )
        self.reference_embeddings = [self._embed(r) for r in references]

    def _embed(self, bgr: np.ndarray):
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        image = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=rgb)
        return self.embedder.embed(image).embeddings[0]

    def find_all(self, frame: np.ndarray) -> List[Tuple[Optional[Box], float]]:
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        image = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=rgb)
        result = self.detector.detect(image)
        height, width = frame.shape[:2]
        proposals: List[Tuple[Box, Any]] = []
        for detection in result.detections or []:
            box = detection.bounding_box
            x1 = max(0, int(box.origin_x))
            y1 = max(0, int(box.origin_y))
            x2 = min(width, int(box.origin_x + box.width))
            y2 = min(height, int(box.origin_y + box.height))
            if x2 - x1 < 8 or y2 - y1 < 8:
                continue
            proposals.append(((x1, y1, x2, y2), self._embed(frame[y1:y2, x1:x2])))
        results: List[Tuple[Optional[Box], float]] = []
        for reference_embedding in self.reference_embeddings:
            best_box, best_score = None, 0.0
            for box, embedding in proposals:
                similarity = self.vision.ImageEmbedder.cosine_similarity(
                    reference_embedding, embedding
                )
                if similarity > best_score:
                    best_box, best_score = box, float(similarity)
            results.append((best_box, best_score))
        return results

    def find(self, frame: np.ndarray) -> Tuple[Optional[Box], float]:
        return _best(self.find_all(frame))


class TemplateLocaliser:
    """Multi-scale normalised cross-correlation: the cheap baseline.

    Honest only when the object appears at much the same angle every time. It
    is here because if it wins, the problem was easier than we thought, and if
    it loses to ORB by a mile that is worth knowing too.

    Takes several reference crops: the frame is converted to grey once, then
    each reference runs its own full scale sweep against it -- the one method
    here whose cost is genuinely N times a single reference's. orb and
    proposals barely notice MAX_REFERENCES growing; this one does, so it caps
    itself far lower (MAX_TEMPLATE_REFERENCES) rather than paying for every
    boxed photo the classifier has. References beyond that cap are kept as
    dead slots -- (None, 0.0) from find_all(), same idea OrbLocaliser already
    uses for a reference with no usable texture -- so find_all() still
    returns one entry per input reference, which is what compare()'s
    leave-one-out indexing (with_sources) assumes everywhere.
    """

    name = "template"

    def __init__(self, references: Sequence[np.ndarray],
                 usable: Optional[Sequence[int]] = None) -> None:
        """`usable` says WHICH references this method may spend its budget on,
        by index. Left out, it takes the first MAX_TEMPLATE_REFERENCES of them,
        which is exactly what it always did.

        It exists because "the first six" is a poor way to choose: the six
        oldest boxed photos are usually six frames of one burst, so the method
        with the tightest budget spent all of it on one angle. A human looking
        at the grid can pick six that differ -- see template_pick in objects.py.
        """
        if not references:
            raise ValueError("TemplateLocaliser needs at least one reference crop.")
        allowed = (set(range(min(len(references), MAX_TEMPLATE_REFERENCES)))
                   if usable is None else set(usable))
        self.refs = [
            cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY) if index in allowed else None
            for index, reference in enumerate(references)
        ]
        self.usable = sum(1 for r in self.refs if r is not None)

    def find_all(self, frame: np.ndarray) -> List[Tuple[Optional[Box], float]]:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        results: List[Tuple[Optional[Box], float]] = []
        for reference in self.refs:
            if reference is None:
                results.append((None, 0.0))
                continue
            best_box, best_score = None, -1.0
            for scale in TEMPLATE_SCALES:
                width = int(reference.shape[1] * scale)
                height = int(reference.shape[0] * scale)
                if width < 8 or height < 8:
                    continue
                if height > gray.shape[0] or width > gray.shape[1]:
                    continue
                resized = cv2.resize(reference, (width, height))
                result = cv2.matchTemplate(gray, resized, cv2.TM_CCOEFF_NORMED)
                _, score, _, location = cv2.minMaxLoc(result)
                if score > best_score:
                    best_score = float(score)
                    best_box = (location[0], location[1],
                                location[0] + width, location[1] + height)
            results.append((best_box, max(best_score, 0.0)))
        return results

    def find(self, frame: np.ndarray) -> Tuple[Optional[Box], float]:
        return _best(self.find_all(frame))


ALL_LOCALISERS = (OrbLocaliser, ProposalLocaliser, TemplateLocaliser)

# So a stored method name (e.g. from objects.get_measurement) can rebuild the
# exact localiser class Misura measured, without a caller writing its own
# if/elif over the three names.
LOCALISERS_BY_NAME = {cls.name: cls for cls in ALL_LOCALISERS}


def best_threshold(
    with_scores: Sequence[float], without_scores: Sequence[float]
) -> Optional[Tuple[float, float, float]]:
    """The cut that keeps most of the object and least of the room.

    Every score actually observed is tried as the cut, and the one with the
    fewest mistakes wins -- false positives counted double, because a detector
    that cries wolf is worse than one that occasionally misses.

    Returns (threshold, recall %, false-positive %), or None when no cut does
    better than refusing everything.
    """
    candidates = sorted(set(list(with_scores) + list(without_scores)))
    best = None
    best_cost = None
    for cut in candidates:
        if cut <= 0:
            continue
        recall = sum(1 for s in with_scores if s >= cut) / len(with_scores)
        false_rate = (sum(1 for s in without_scores if s >= cut) / len(without_scores)
                      if without_scores else 0.0)
        cost = (1.0 - recall) + 2.0 * false_rate
        if best_cost is None or cost < best_cost:
            best_cost = cost
            best = (cut, recall * 100.0, false_rate * 100.0)
    if best is None or best[1] == 0.0:
        return None
    return best


def compare(
    references: Sequence[np.ndarray],
    with_frames: Sequence[np.ndarray],
    without_frames: Sequence[np.ndarray],
    with_sources: Optional[Sequence[Any]] = None,
    only: Optional[str] = None,
    on_result=None,
    template_usable: Optional[Sequence[int]] = None,
) -> List[Dict[str, Any]]:
    """Run every localiser over both sets and report what each one did.

    Raw hit counts are NOT comparable across the three, and treating them as
    comparable was this measurement's first mistake. ORB can refuse; the other
    two always hand back their best guess, so they "find" the object in 100% of
    frames and in 100% of the empty ones, which says nothing.

    What decides usability is therefore whether the SCORES SEPARATE: is there a
    number above which the object is present and below which it is not. Both
    sets are scored in full, and the threshold is derived from the data rather
    than guessed.

    `references` are the boxed crops the live detector will actually use --
    more than one if the classifier has more than one boxed photo. A with-frame
    that IS one of those references (so testing it as-is would be the method
    finding itself) says so via `with_sources[i]`: that reference is left out
    of ITS OWN test, every other reference stays in. This is leave-one-out,
    and it is free: find_all() already scores every reference, so leaving one
    out the is just not looking at that one entry. A with-frame that is not a
    reference (`with_sources[i] is None`, or `with_sources` omitted entirely)
    is tested against every reference, exactly like a without-frame.

    `with_sources[i]` may be SEVERAL indices rather than one, because a
    reference is no longer always a photograph somebody took: a generated
    variant (object_augment.py) is that same photograph with the brightness
    changed, so leaving out only the frame's own entry would still let it be
    found by a near-copy of itself. The caller passes every index derived from
    that frame, and all of them are left out together.

    `on_result` is called with each finished row, so a caller that wants to
    draw a contact sheet can do it without this function knowing what one is.
    """
    import time

    if with_sources is None:
        with_sources = [None] * len(with_frames)

    rows: List[Dict[str, Any]] = []
    for factory in ALL_LOCALISERS:
        if only and factory.name != only:
            continue
        try:
            # Only template takes a second argument, and only template has a
            # budget small enough for the choice to matter.
            localiser = (factory(references, template_usable)
                         if factory is TemplateLocaliser else factory(references))
        except Exception as error:
            rows.append({"name": factory.name, "error": f"{type(error).__name__}: {error}"})
            continue

        with_scores: List[float] = []
        without_scores: List[float] = []
        boxes: List[Tuple[str, Optional[Box], float]] = []
        times: List[float] = []
        held_out = 0
        leave_one_out = 0

        for index, (frame, source) in enumerate(zip(with_frames, with_sources)):
            start = time.perf_counter()
            per_reference = localiser.find_all(frame)
            times.append((time.perf_counter() - start) * 1000.0)
            left_out = (
                () if source is None
                else (source,) if isinstance(source, int)
                else tuple(source)
            )
            allowed = [r for i, r in enumerate(per_reference) if i not in left_out]
            box, score = _best(allowed)
            with_scores.append(score if box is not None else 0.0)
            label = f"with-{index}-rif" if left_out else f"with-{index}"
            boxes.append((label, box, score))
            if left_out:
                leave_one_out += 1
            else:
                held_out += 1
        for index, frame in enumerate(without_frames):
            box, score = localiser.find(frame)
            without_scores.append(score if box is not None else 0.0)
            boxes.append((f"without-{index}", box, score))

        threshold = best_threshold(with_scores, without_scores)
        row = {
            "name": factory.name,
            "ms": round(statistics.median(times), 1) if times else None,
            "boxed": sum(1 for _, box, _ in boxes[:len(with_frames)] if box is not None),
            "of": len(with_frames),
            "with_scores": with_scores,
            "without_scores": without_scores,
            "threshold": None if threshold is None else round(threshold[0], 3),
            # The exact cut, not the rounded display value above: rounding
            # 0.999944 to 1.0 for the table would otherwise also become the
            # LIVE cutoff, which a real frame scoring 0.9999 -- genuinely
            # above the measured threshold -- would then fail to clear for a
            # reason that only exists on screen.
            "threshold_raw": None if threshold is None else threshold[0],
            "recall": None if threshold is None else round(threshold[1]),
            "false_rate": None if threshold is None else round(threshold[2]),
            "separates": threshold is not None,
            # The two scores either side of the gap a threshold sits in --
            # not used to pick the cut (best_threshold already did that), but
            # kept so a live cut point can be chosen later without having to
            # re-run the whole comparison for frames nobody kept.
            "with_min": min(with_scores) if with_scores else None,
            "without_max": max(without_scores) if without_scores else 0.0,
            "references": len(references),
            "held_out": held_out,
            "leave_one_out": leave_one_out,
        }
        if factory.name in ("orb", "template"):
            row["usable_references"] = getattr(localiser, "usable", len(references))
        rows.append(row)
        if on_result is not None:
            on_result(row, boxes)
    return rows
