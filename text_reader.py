"""Reading the text in one picture.

Pure vision, like object_localisers.py: JPEG bytes in, lines out, no database
and no passphrase. Two engines, because they are good at opposite things and
the first measurement of this module compared them on the wrong kind of text.

THE THREE MODES
---------------
    scene   RapidOCR. Packaging, signs, stylised or coloured lettering -- text
            that is part of a PHOTOGRAPH. It finds the lines first and reads each
            one, so white-on-green and a tilted logo are not a problem.
    text    Tesseract. Printed pages: sentences, Italian and English together,
            with their accents.
    codes   Tesseract on capitals and digits only. Serial numbers, plates, lot
            codes: "B7" read as "B?" or "O" as "0" is the usual failure on a
            code, and a code has no dictionary to correct it against.

WHAT EACH WAS MEASURED ON (scripts/ocr_bench.py, and the real webcam)
--------------------------------------------------------------------
Rendered pages, 42 pictures of Italian and English sentences (small, blurred,
dim, tilted, in perspective, noisy):

                    median error   read exactly   seconds/image
    tesseract            0.000         35 / 42          1.0
    rapidocr             0.115          0 / 42          2.7

RapidOCR's default model has no Italian accents ("e", "gia", "piu") and merges
words, so on prose Tesseract wins clearly.

A real cereal-bar box held to the webcam (10 frames, white lettering on green
and pink, 7 words I could read on the box):

                           one frame      average of 8 frames
    tesseract              0 - 2 of 7           1 of 7
    rapidocr               5 - 6 of 7           7 of 7

The first run chose Tesseract from the pages alone and shipped it; the box is
what showed it was the wrong default for text in a photograph. Neither table
promises how well YOUR paper or label reads -- they rank the engines.

THE PICTURE NEVER TOUCHES THE DISK
----------------------------------
Tesseract is run as a command, not through a Python wrapper, and given the
picture on standard input; RapidOCR is given the array. A photograph of
somebody's letter is never written to a temporary file by either.
"""

import os
import subprocess
import threading
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

LANGUAGES = "ita+eng"

# Phone photographs are 4000 px wide and Tesseract's time grows with the
# picture, not with the text. A webcam frame never reaches this.
MAX_SIDE = 1600

TIMEOUT_SECONDS = 45

# The space is IN the list, deliberately: without it Tesseract glues a whole
# line into one "word" and gives it confidence 0 (measured: "SN4821-B7/LOTTO2209/"),
# which the line filter below then throws away, leaving only the last token.
# One thread, on purpose. Tesseract uses OpenMP, whose threads spin waiting for
# each other, and in the server they have to share four cores with the camera
# and the detection. Measured on the real page: the same picture took 24 s in
# the server and 1.3 s alone; one thread removes the waiting.
_TESSERACT_ENV = {**os.environ, "OMP_THREAD_LIMIT": "1"}

CODE_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/.:# "

# A LINE is kept only if its best word is at least this sure. Tesseract makes
# up glyphs out of texture -- noise, grain, the edge of a shelf -- but it is
# never confident about them. Measured over the 42 rendered pictures and 8
# pictures with no text (5 real scenes, 3 synthetic):
#
#                      error on text    words invented
#                                       real scenes  synthetic
#     cut each word <30    0.0190            5           44      (the first rule)
#     no filter            0.0119            9          160
#     drop weak LINES <50  0.0119            2           26
#
# Whole lines and not single words, because a correct word can be weak inside a
# real line: "più o" scored 29 between words scored 96, and a per-word cut at 30
# threw it away. A line is judged by its best word; a word in a kept line stays.
#
# 50 rather than the 70 that invents nothing on a real scene: all three give the
# same error on text, but the text here is cleaner than a lens makes it, and
# dropping a real line costs more than showing a junk glyph the boxes expose.
MIN_LINE_CONFIDENCE = 50


class ReaderUnavailable(RuntimeError):
    """Tesseract or its language data is not installed."""


_checked_ok = False
_rapid_engine: Any = None
_rapid_lock = threading.Lock()


def _tesseract_problem() -> Optional[str]:
    """None when Tesseract and its language data are there, otherwise why not.

    A success is remembered: it is a process spawn, and the answer does not
    change while the server runs. A failure is NOT remembered, so installing
    Tesseract makes the button work without restarting anything."""
    global _checked_ok
    if _checked_ok:
        return None
    try:
        out = subprocess.run(["tesseract", "--list-langs"], capture_output=True,
                             text=True, timeout=10)
    except FileNotFoundError:
        return ("Tesseract non e' installato. Raspberry: sudo apt install "
                "tesseract-ocr tesseract-ocr-ita tesseract-ocr-eng. Windows: "
                "installa Tesseract (con la lingua italiana) e aggiungilo al PATH.")
    except subprocess.TimeoutExpired:
        return "Tesseract non risponde."
    installed = set(out.stdout.split())
    missing = [lang for lang in LANGUAGES.split("+") if lang not in installed]
    if missing:
        return (f"Mancano i dati di lingua di Tesseract: {', '.join(missing)} "
                f"(Raspberry: pacchetto tesseract-ocr-{missing[0]}).")
    _checked_ok = True
    return None


def _rapid() -> Any:
    """The RapidOCR engine, built on first use (about 3 s: it loads three
    models), or ReaderUnavailable if the package is not installed."""
    global _rapid_engine
    with _rapid_lock:
        if _rapid_engine is None:
            try:
                from rapidocr_onnxruntime import RapidOCR
            except ImportError:
                raise ReaderUnavailable(
                    "RapidOCR non e' installato: pip install rapidocr-onnxruntime "
                    "(nell'ambiente Python dell'app)."
                )
            _rapid_engine = RapidOCR()
        return _rapid_engine


# The live reader: the same engine, told to work on a picture no bigger than
# this. RapidOCR enlarges anything small to 736 px by default, which cost 1.5 s a
# pass of detection alone on a 640x480 frame; at 480 a whole pass (finding and
# reading) took 0.7 to 1.3 s.
LIVE_SIDE = 480
# A line is shown, counted and kept only if the engine is this sure of it and it
# holds at least this many letters or digits. Measured on three pictures where a
# face, a mouth and a window-sill detail had been kept as "text": this engine
# returns no line at all for them, while real lines scored 0.63 to 0.99. Edge
# density and contrast did not separate them (0.03, 0.03 and 0.17 against 0.12
# for real text), so they are not used.
LIVE_MIN_CONFIDENCE = 0.6
LIVE_MIN_CHARACTERS = 2

_live_engine: Any = None
_live_lock = threading.Lock()


def _live() -> Any:
    """The engine for the live reading, built on first use. A second instance
    beside _rapid(): the detector's size limit is a setting of the instance, and
    the one that reads a tapped area must keep seeing pictures at full size."""
    global _live_engine
    with _live_lock:
        if _live_engine is None:
            try:
                from rapidocr_onnxruntime import RapidOCR
            except ImportError:
                raise ReaderUnavailable(
                    "RapidOCR non e' installato: pip install rapidocr-onnxruntime "
                    "(nell'ambiente Python dell'app)."
                )
            _live_engine = RapidOCR(det_limit_side_len=LIVE_SIDE, det_limit_type="max")
        return _live_engine


def read_live(frame: np.ndarray) -> List[Dict[str, Any]]:
    """The confident lines of text in this BGR frame, [{"text", "confidence",
    "box": [x1, y1, x2, y2]}] in the frame's own pixels, top to bottom. Raises
    ReaderUnavailable if the package is missing."""
    result, _ = _live()(frame)
    lines = []
    for box, text, score in result or []:
        text = str(text).strip()
        if float(score) < LIVE_MIN_CONFIDENCE:
            continue
        if sum(character.isalnum() for character in text) < LIVE_MIN_CHARACTERS:
            continue
        xs = [point[0] for point in box]
        ys = [point[1] for point in box]
        lines.append({
            "text": text,
            "confidence": round(float(score), 3),
            "box": [round(min(xs)), round(min(ys)), round(max(xs)), round(max(ys))],
        })
    lines.sort(key=lambda line: (line["box"][1], line["box"][0]))
    return lines


def available(mode: str = "text") -> Optional[str]:
    """None when this mode can run, otherwise the reason, in words a person can
    act on. The Tesseract modes need the program; scene needs the package."""
    if mode == "scene":
        try:
            _rapid()
        except ReaderUnavailable as error:
            return str(error)
        return None
    return _tesseract_problem()


# THE SHARPENING OF A SMALL, SOFT CROP (scene mode, a tapped area)
#
# Measured on 24 crops of logo-like words (8 words, 4 colour schemes), shrunk and
# blurred like a webcam's (mild, medium, strong), noise and JPEG added; the score
# is the character error rate against the word, 0.00 perfect:
#
#                             all    mild   medium  strong   read exactly
#     nothing               0.432   0.041   0.254   1.000       7 / 24
#     enlarge x2            0.461   0.139   0.243   1.000       7 / 24
#     contrast (CLAHE)      0.169   0.039   0.120   0.347      11 / 24
#     sharpen               0.123   0.020   0.041   0.307      13 / 24
#     edge boost            0.267   0.020   0.020   0.760      13 / 24
#     adaptive threshold    0.288   0.000   0.144   0.721      11 / 24
#     x2 + CLAHE + sharpen  0.025   0.020   0.020   0.036      18 / 24
#
# Each step alone is little; the three together are what recovers a strongly
# blurred word. These are rendered words, not photographs: on one real blurred
# crop of "MICROTECH" the same chain gave "MCROTECH" where nothing gave
# "CROTECH", so the gain on a real lens is smaller than the table says.
ENHANCE_SCALE = 2


def enhance(frame: np.ndarray) -> np.ndarray:
    """The picture enlarged ENHANCE_SCALE times, with local contrast raised and
    edges sharpened. Coordinates in the result are ENHANCE_SCALE times those of
    the input."""
    big = cv2.resize(frame, None, fx=ENHANCE_SCALE, fy=ENHANCE_SCALE,
                     interpolation=cv2.INTER_CUBIC)
    lab = cv2.cvtColor(big, cv2.COLOR_BGR2LAB)
    lightness, a, b = cv2.split(lab)
    lightness = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4, 4)).apply(lightness)
    big = cv2.cvtColor(cv2.merge([lightness, a, b]), cv2.COLOR_LAB2BGR)
    blurred = cv2.GaussianBlur(big, (0, 0), 3.0)
    return cv2.addWeighted(big, 2.5, blurred, -1.5, 0)


def _decode(jpeg: bytes) -> Tuple[Optional[np.ndarray], float]:
    """The picture to read, and the factor its coordinates were scaled by (so a
    box found on the shrunken copy is reported in the ORIGINAL's pixels)."""
    frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    if frame is None or frame.size == 0:
        return None, 1.0
    scale = 1.0
    longest = max(frame.shape[:2])
    if longest > MAX_SIDE:
        scale = MAX_SIDE / longest
        frame = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return frame, scale


def _lines_from_tsv(tsv: str, scale: float) -> List[Dict[str, Any]]:
    """Tesseract's word table, regrouped into the lines it printed."""
    grouped: Dict[Tuple[str, str, str], List[Dict[str, Any]]] = {}
    for row in tsv.splitlines()[1:]:
        cells = row.split("\t")
        if len(cells) < 12 or cells[0] != "5":
            continue
        text = cells[11].strip()
        try:
            confidence = float(cells[10])
            left, top, width, height = (int(cells[i]) for i in (6, 7, 8, 9))
        except ValueError:
            continue
        if not text:
            continue
        grouped.setdefault((cells[2], cells[3], cells[4]), []).append(
            {"text": text, "conf": confidence, "box": (left, top, left + width, top + height)}
        )
    lines = []
    for words in grouped.values():
        if max(w["conf"] for w in words) < MIN_LINE_CONFIDENCE:
            continue
        x1 = min(w["box"][0] for w in words)
        y1 = min(w["box"][1] for w in words)
        x2 = max(w["box"][2] for w in words)
        y2 = max(w["box"][3] for w in words)
        lines.append({
            "text": " ".join(w["text"] for w in words),
            "confidence": round(sum(w["conf"] for w in words) / len(words) / 100.0, 3),
            "box": [round(v / scale) for v in (x1, y1, x2, y2)],
        })
    # Top to bottom, the order a person reads them in.
    lines.sort(key=lambda line: (line["box"][1], line["box"][0]))
    return lines


def _read_scene(frame: np.ndarray, scale: float) -> List[Dict[str, Any]]:
    """RapidOCR: [box (4 points), text, score] per line it found.

    No confidence cut-off of its own, because none is needed: its detector
    already refuses texture. On nine pictures with no text (walls, a window,
    noise, stripes, hand frames) it returned no line at all, while the lines of
    the real box scored 0.63 to 0.97."""
    result, _ = _rapid()(frame)
    lines = []
    for box, text, score in result or []:
        text = str(text).strip()
        if not text:
            continue
        xs = [point[0] for point in box]
        ys = [point[1] for point in box]
        lines.append({
            "text": text,
            "confidence": round(float(score), 3),
            "box": [round(min(xs) / scale), round(min(ys) / scale),
                    round(max(xs) / scale), round(max(ys) / scale)],
        })
    lines.sort(key=lambda line: (line["box"][1], line["box"][0]))
    return lines


def read(jpeg: bytes, mode: str = "text", sharpen: bool = False) -> List[Dict[str, Any]]:
    """[{"text", "confidence", "box": [x1, y1, x2, y2]}] for one picture, top to
    bottom, boxes in the pixels of the picture that was passed in. [] when
    nothing legible is there.

    Raises ValueError for a picture that will not decode, and ReaderUnavailable
    when the engine for this mode is missing. Both are facts about something
    other than the paper, and answering [] ("no text") for either would send
    somebody off to reframe a sheet that was never the problem.
    """
    reason = available(mode)
    if reason:
        raise ReaderUnavailable(reason)
    frame, scale = _decode(jpeg)
    if frame is None:
        # Not "no text": there is no picture. Saying [] would send somebody off
        # to reframe a sheet of paper when the upload itself was the problem.
        raise ValueError("The picture could not be decoded.")
    if mode == "scene":
        if sharpen:
            # Boxes come back divided by `scale`, so folding the enlargement into
            # it keeps them in the pixels of the picture that was passed in.
            return _read_scene(enhance(frame), scale * ENHANCE_SCALE)
        return _read_scene(frame, scale)
    ok, png = cv2.imencode(".png", frame)
    command = ["tesseract", "stdin", "stdout", "-l", LANGUAGES, "--psm", "6"]
    if mode == "codes":
        command += ["-c", f"tessedit_char_whitelist={CODE_CHARACTERS}"]
    command.append("tsv")
    out = subprocess.run(command, input=png.tobytes(), capture_output=True,
                         timeout=TIMEOUT_SECONDS, env=_TESSERACT_ENV)
    if out.returncode != 0:
        return []
    return _lines_from_tsv(out.stdout.decode("utf-8", errors="replace"), scale)
