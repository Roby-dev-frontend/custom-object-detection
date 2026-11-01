"""Extra photographs made from the ones somebody took.

WHY THIS EXISTS
---------------
A classifier measured on twenty photographs of one burst knows one lighting and
one angle. The honest fix is more photographs, and the guided capture in the
page asks for them -- but a person photographing a cup in their kitchen cannot
produce dusk, a cloudy window and a yellow bulb on demand. Those three are a
pixel operation, so this module does them.

WHAT IT DELIBERATELY DOES NOT DO
--------------------------------
No rotation, no flip, no crop, no perspective. Every transform here leaves each
pixel where it was, which is the whole reason the original's box can be copied
onto the variant unchanged. The moment a transform moves pixels, the box has to
be transformed too, and a box that is subtly wrong is worse than no extra
photograph at all: the reference crop then holds a slice of background that the
localiser learns to look for.

Pure vision, like object_localisers.py: cv2 and numpy, no database, no
passphrase. The caller reads the JPEG bytes, hands them here, and stores what
comes back.

WHAT THE FIVE ARE FOR
---------------------
    bright    a lamp switched on, or the sun coming out
    dark      the same room at dusk, or a shadow falling across it
    contrast  a harder light: highlights clip, the shadows go black
    blur      the camera moving, or focusing on something else
    colour    a warmer bulb, and a camera that saturates more than this one

Five, not fifty: each one multiplies what is stored and what every measurement
has to read, and these five are the variations an indoor photograph of a
belonging actually undergoes. They are not a substitute for a second burst from
a different angle -- nothing here invents a view of the back of the cup.
"""

from typing import Callable, Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

# The order variants are generated in, so "generate 2 per photo" is a
# predictable pair rather than whichever two a dict happened to yield.
KINDS: Tuple[str, ...] = ("bright", "dark", "contrast", "blur", "colour")

# What a generated photograph is saved as. 90 rather than the 95 the camera
# path uses: a variant is already a lossy copy of a lossy original, and the
# ones that matter -- blur and dark -- compress smaller at the same quality.
JPEG_QUALITY = 90


def _bright(image: np.ndarray) -> np.ndarray:
    """+40 on every channel, saturating. cv2.add saturates where a plain
    `image + 40` would wrap 230 round to 14 and put black speckles in the
    highlights."""
    return cv2.add(image, 40)


def _dark(image: np.ndarray) -> np.ndarray:
    return cv2.subtract(image, 40)


def _contrast(image: np.ndarray) -> np.ndarray:
    """Steeper than life (alpha 1.35) with the offset that keeps mid-grey mid-grey
    (-45 ~ 128 * 0.35), so it reads as a harder light rather than as a brighter
    one -- which is what _bright already covers."""
    return cv2.convertScaleAbs(image, alpha=1.35, beta=-45.0)


def _blur(image: np.ndarray) -> np.ndarray:
    """Gaussian with sigma scaled to the long side, so a 1920-px photo and a
    480-px one come back equally soft. A fixed sigma blurs a phone photograph
    imperceptibly and destroys a thumbnail."""
    long_side = max(image.shape[:2])
    sigma = max(1.0, long_side / 320.0)
    radius = int(sigma * 3) | 1
    return cv2.GaussianBlur(image, (radius, radius), sigma)


def _colour(image: np.ndarray) -> np.ndarray:
    """Hue +8 degrees, saturation x1.25: a warmer bulb through a camera that
    saturates more than this one. In OpenCV's 8-bit HSV hue runs 0..179 for
    360 degrees, so 8 degrees is 4 steps, and hue is the one channel that is
    meant to wrap -- it is added modulo 180 on purpose."""
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    hue = hsv[:, :, 0].astype(np.int16)
    hsv[:, :, 0] = ((hue + 4) % 180).astype(np.uint8)
    hsv[:, :, 1] = cv2.convertScaleAbs(hsv[:, :, 1], alpha=1.25, beta=0.0)
    return cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)


_TRANSFORMS: Dict[str, Callable[[np.ndarray], np.ndarray]] = {
    "bright": _bright,
    "dark": _dark,
    "contrast": _contrast,
    "blur": _blur,
    "colour": _colour,
}


def variants(jpeg: bytes, kinds: Optional[Sequence[str]] = None) -> List[Tuple[str, bytes]]:
    """Generated photographs made from one stored photograph.

    Returns [(kind, jpeg_bytes)] in KINDS order, for the caller to store with
    the SAME box as the original -- every transform here is a per-pixel one, so
    that box is still correct by construction.

    An unreadable JPEG returns an empty list rather than raising: a stored photo
    that cv2 cannot decode is a fact about one row, and it should not abort the
    other nineteen.
    """
    frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    if frame is None or frame.size == 0:
        return []
    wanted = [kind for kind in KINDS if kind in set(kinds or KINDS)]
    out: List[Tuple[str, bytes]] = []
    for kind in wanted:
        made = _TRANSFORMS[kind](frame)
        ok, buffer = cv2.imencode(".jpg", made, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
        if ok:
            out.append((kind, buffer.tobytes()))
    return out
