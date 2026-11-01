"""Telling "the same photograph again" from "another photograph of the thing".

WHY THIS EXISTS
---------------
Both ways of getting photographs in produce near-copies by the dozen. A burst
holds the camera still and saves ten frames of one pose; a folder off a phone
holds every shot somebody took, including the four they took because the first
was blurred. Those frames cost storage, they cost every measurement the time to
decode them, and they make recall look better than it is -- a classifier
measured against ten copies of one pose scores ten times on one pose.

So a photograph that is a near-copy of one already stored is not stored.

HOW A NEAR-COPY IS RECOGNISED, AND WHY IT TAKES TWO GATES
---------------------------------------------------------
First gate: a 64-bit difference hash. Reduce to 9x8 grey, and set one bit per
row per pair of neighbours, "is this pixel brighter than the one on its right".
Two photographs are candidates when their hashes differ in few bits. It costs
one small resize, it survives re-compression and a change of resolution, and it
is a single integer per stored photograph.

dHash alone is not enough, and the case it misses is one this application
really produces: it records only the SIGN of each neighbour difference, so two
photographs of a blank wall, or of a desk at dusk, agree on most bits for the
simple reason that neither has edges to disagree about. Negatives -- "scatta 5
foto senza l'oggetto" -- are often that kind of photograph.

Second gate: the correlation of two 32x32 grey thumbnails. That reads the
magnitudes dHash threw away, so a flat wall and a different flat wall are
plainly different whatever their hashes say. Only pairs that pass BOTH gates
are near-copies.

WHERE THE NUMBERS COME FROM
---------------------------
scripts/object_bench.py dupes, over bench_object/with and bench_object/without
on this Pi, measured before these constants were written here:

    the same frame, re-encoded at q95 and q60   0-1 bits, correlation 1.000
    within one burst (10 frames, 45 pairs)      median 2 bits, max 8, corr >= 0.958
    two different scenes (200 pairs)            min 16 bits

So "the same photograph again" tops out at 8 bits and "a different photograph"
starts at 16, and the thresholds below sit at the burst end of that gap rather
than in the middle. The cost of being wrong is not symmetrical: dropping a
genuinely new photograph loses something nobody can get back, while keeping a
near-copy costs some disk. At 8 bits plus 0.90 correlation, none of the 200
different-scene pairs is called a near-copy, and the burst's 10 frames store 1.

What the second gate is worth, measured the same way: of the 89 pairs that came
within 8 bits, it rejects 4 -- all of them in the flat "senza l'oggetto"
photographs, as predicted -- and that saves 1 of those 20 photographs from
being dropped. A modest rescue, for one resize and a dot product.

NOTHING HERE TOUCHES A DATABASE
-------------------------------
Pure vision, like object_localisers.py: bytes in, numbers out. objects.py owns
the view_signature table that caches these, and the cache is the reason this is
affordable at all: signature() costs 9.8 ms for one 540x960 photograph on this
Pi, so importing 200 photographs into a classifier that already holds 200 would
spend about six and a half minutes decoding the same stored JPEGs over and over
without it.
"""

from typing import Iterable, List, Optional, Sequence, Tuple

import cv2
import numpy as np

# Bits of the 64 that may differ. The widest burst pair measured 8 and the
# closest genuinely-different pair 16, so this is the top of the near-copy
# range rather than the middle of the gap -- see the asymmetry above.
MAX_DISTANCE = 8

# How alike the two 32x32 thumbnails must also be, as a Pearson correlation.
# Burst pairs measured 0.958 and up; the pairs this gate rejected -- flat
# "senza" photographs that dHash could not tell apart -- scored 0.80 to 0.86.
MIN_CORRELATION = 0.90

THUMB = 32


def _grey(jpeg: bytes) -> Optional[np.ndarray]:
    image = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None or image.size == 0:
        return None
    return image


def dhash(grey: np.ndarray) -> int:
    """The 64-bit difference hash of an already-grey image.

    INTER_AREA on the way down, so every source pixel contributes: the default
    bilinear shrink of a 1920-px photograph samples a handful of pixels per
    output cell, and two photographs can then differ by pure sampling luck.
    """
    small = cv2.resize(grey, (9, 8), interpolation=cv2.INTER_AREA)
    bits = small[:, 1:] > small[:, :-1]
    value = 0
    for bit in bits.flatten():
        value = (value << 1) | int(bit)
    return value


def thumbnail(grey: np.ndarray) -> np.ndarray:
    """The 32x32 grey thumbnail the second gate compares, as uint8 so it stores
    as 1 KB of blob rather than 8 KB of float."""
    return cv2.resize(grey, (THUMB, THUMB), interpolation=cv2.INTER_AREA)


def signature(jpeg: bytes) -> Optional[Tuple[int, bytes]]:
    """(dhash, thumbnail bytes) for one photograph, or None if it will not
    decode. One decode for both, because decoding is nearly all the cost."""
    grey = _grey(jpeg)
    if grey is None:
        return None
    return dhash(grey), thumbnail(grey).tobytes()


def distance(left: int, right: int) -> int:
    """How many of the 64 bits differ. bin().count('1') rather than
    int.bit_count(), which this Pi's Python 3.9 does not have."""
    return bin(left ^ right).count("1")


def correlation(left: bytes, right: bytes) -> float:
    """Pearson correlation of two stored thumbnails, in [-1, 1].

    A thumbnail with no variance at all -- a photograph of pure black, which a
    covered lens really does produce -- has no correlation defined with
    anything. Those return 0.0, so such a frame is never called a near-copy of
    something on this gate's say-so.
    """
    a = np.frombuffer(left, np.uint8).astype(np.float32)
    b = np.frombuffer(right, np.uint8).astype(np.float32)
    if a.size != b.size or a.size == 0:
        return 0.0
    a -= a.mean()
    b -= b.mean()
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denominator < 1e-6:
        return 0.0
    return float(np.dot(a, b) / denominator)


def is_near_copy(left: Tuple[int, bytes], right: Tuple[int, bytes],
                 max_distance: int = MAX_DISTANCE,
                 min_correlation: float = MIN_CORRELATION) -> bool:
    """Both gates, cheap one first."""
    if distance(left[0], right[0]) > max_distance:
        return False
    return correlation(left[1], right[1]) >= min_correlation


def first_match(candidate: Tuple[int, bytes],
                stored: Iterable[Tuple[str, int, bytes]],
                max_distance: int = MAX_DISTANCE,
                min_correlation: float = MIN_CORRELATION) -> Optional[str]:
    """The name of the first stored photograph `candidate` is a near-copy of,
    or None. First rather than closest: the answer is only used to decide not to
    store, and finding one is enough to decide that."""
    for name, hash_value, thumb in stored:
        if is_near_copy(candidate, (hash_value, thumb), max_distance, min_correlation):
            return name
    return None


def dedupe(signatures: Sequence[Tuple[int, bytes]],
           max_distance: int = MAX_DISTANCE,
           min_correlation: float = MIN_CORRELATION) -> List[int]:
    """Indices to keep out of one batch, each compared against the ones already
    kept -- so ten frames of a burst keep the first, not the first and the
    tenth (which drift apart in sequence while each is a copy of its
    neighbour)."""
    kept: List[int] = []
    for index, candidate in enumerate(signatures):
        if any(is_near_copy(candidate, signatures[k], max_distance, min_correlation)
               for k in kept):
            continue
        kept.append(index)
    return kept
