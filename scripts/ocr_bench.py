#!/usr/bin/env python3
"""Measure text reading before building it: Tesseract against RapidOCR.

Like scripts/object_bench.py, this imports no app code and opens no database,
so it can run while the app does.

WHAT IT ANSWERS
---------------
Which engine reads the text YOUR webcam sees, how wrong it is, and how long it
takes on this Pi. Two numbers per engine:

  CER      character error rate: edit distance to the expected text divided by
           its length. 0.00 is perfect, 0.10 means one character in ten is wrong.
  seconds  per image, the model's one-off load not counted (reported apart).

USAGE
-----
    python3 scripts/ocr_bench.py synth bench_text/synth
        Renders known sentences under the conditions a webcam produces (small,
        blurred, dim, tilted, noisy). The expected text is exact by
        construction. It says how the engines RANK, not how they do on your
        paper: rendered text is cleaner than anything a lens sees.

    python3 scripts/ocr_bench.py capture bench_text/real --count 10
        Grabs frames from the webcam. Hold up the text, run it, then write what
        it says into bench_text/real/<same name>.txt.

    python3 scripts/ocr_bench.py run bench_text/real
        THE REAL TEST. Every image that has a .txt beside it.
"""

import argparse
import glob
import os
import re
import statistics
import subprocess
import sys
import tempfile
import time
from typing import Callable, Dict, List, Optional, Tuple

import cv2
import numpy as np

# Lines a person would write on paper, in Italian, with the characters an
# English-only reading gets wrong, and one made of codes.
SENTENCES: List[Tuple[str, str]] = [
    ("frase", "La riunione è stata spostata a giovedì alle 15:30 nella sala grande."),
    ("accenti", "Perché non c'è già più tempo? Sì, è così: più o meno."),
    ("inglese", "Please keep the door closed when the air conditioning is running."),
    ("codice", "SN 4821-B7 / LOTTO 2209 / 01.03.2027"),
    ("numeri", "Totale 1.248,50 euro, IVA 22% inclusa, n. 0045."),
    ("multi", "Raccolta differenziata\nVetro e lattine: lunedì\nCarta: giovedì"),
]


# ---------------------------------------------------------------- scoring

def _normal(text: str) -> str:
    """Whitespace collapsed: where an engine breaks a line is not an error in
    what it READ, and counting it as one would punish the layout, not the OCR."""
    return re.sub(r"\s+", " ", text).strip()


def edit_distance(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1,
                               previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def cer(read: str, truth: str) -> float:
    truth = _normal(truth)
    return edit_distance(_normal(read), truth) / max(1, len(truth))


# ---------------------------------------------------------------- engines

def _tesseract(path: str) -> str:
    out = subprocess.run(
        ["tesseract", path, "stdout", "-l", "ita+eng", "--psm", "6"],
        capture_output=True, text=True, timeout=120,
    )
    return out.stdout


_rapid = None


def _rapidocr(path: str) -> str:
    global _rapid
    if _rapid is None:
        from rapidocr_onnxruntime import RapidOCR
        _rapid = RapidOCR()
    result, _ = _rapid(path)
    return "\n".join(item[1] for item in (result or []))


ENGINES: Dict[str, Callable[[str], str]] = {
    "tesseract": _tesseract,
    "rapidocr": _rapidocr,
}


# ---------------------------------------------------------------- synthetic

def _render(text: str, size: int = 34) -> np.ndarray:
    from PIL import Image, ImageDraw, ImageFont

    font = ImageFont.truetype("/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf", size)
    image = Image.new("RGB", (640, 480), (236, 233, 224))
    draw = ImageDraw.Draw(image)
    # Wrapped to the picture: a sentence wider than the frame would be CUT OFF,
    # and the engine would then be scored for text it was never shown.
    lines: List[str] = []
    for paragraph in text.split("\n"):
        current = ""
        for word in paragraph.split(" "):
            trial = (current + " " + word).strip()
            if font.getlength(trial) <= 580 or not current:
                current = trial
            else:
                lines.append(current)
                current = word
        lines.append(current)
    y = 40
    for line in lines:
        draw.text((30, y), line, font=font, fill=(28, 28, 32))
        y += int(size * 1.6)
    return cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)


def _tilt(image: np.ndarray, degrees: float) -> np.ndarray:
    h, w = image.shape[:2]
    matrix = cv2.getRotationMatrix2D((w / 2, h / 2), degrees, 1.0)
    return cv2.warpAffine(image, matrix, (w, h), borderValue=(236, 233, 224))


def _perspective(image: np.ndarray) -> np.ndarray:
    h, w = image.shape[:2]
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32([[40, 30], [w - 10, 0], [w - 60, h - 20], [20, h]])
    return cv2.warpPerspective(image, cv2.getPerspectiveTransform(src, dst), (w, h),
                               borderValue=(236, 233, 224))


def _conditions() -> List[Tuple[str, Callable[[np.ndarray], np.ndarray]]]:
    rng = np.random.default_rng(3)

    def noisy(image):
        return np.clip(image.astype(np.int16) + rng.normal(0, 14, image.shape),
                       0, 255).astype(np.uint8)

    return [
        ("pulita", lambda im: im),
        ("sfocata", lambda im: cv2.GaussianBlur(im, (0, 0), 2.2)),
        ("buio", lambda im: (im.astype(np.float32) * 0.28).astype(np.uint8)),
        ("inclinata", lambda im: _tilt(im, 9)),
        ("prospettiva", _perspective),
        ("rumore", lambda im: noisy(cv2.GaussianBlur(im, (0, 0), 1.0))),
    ]


def cmd_synth(args: argparse.Namespace) -> None:
    os.makedirs(args.out, exist_ok=True)
    made = 0
    for key, text in SENTENCES:
        for name, apply in _conditions():
            # Small text is where webcams fail; render the sentence at two
            # sizes under the clean condition only, so the set stays quick.
            sizes = (34, 20) if name == "pulita" else (34,)
            for size in sizes:
                label = f"{key}-{name}" + (f"-{size}" if size != 34 else "")
                cv2.imwrite(os.path.join(args.out, label + ".jpg"),
                            apply(_render(text, size)), [cv2.IMWRITE_JPEG_QUALITY, 90])
                with open(os.path.join(args.out, label + ".txt"), "w") as handle:
                    handle.write(text)
                made += 1
    print(f"{made} images in {args.out}")


# ---------------------------------------------------------------- capture

def cmd_capture(args: argparse.Namespace) -> None:
    os.makedirs(args.out, exist_ok=True)
    capture = cv2.VideoCapture(args.device)
    if not capture.isOpened():
        raise SystemExit(f"cannot open camera {args.device}")
    for _ in range(10):          # let auto-exposure settle
        capture.read()
    stamp = int(time.time())
    for index in range(args.count):
        ok, frame = capture.read()
        if ok:
            path = os.path.join(args.out, f"{stamp}-{index:02d}.jpg")
            cv2.imwrite(path, frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
            print("saved", path)
        time.sleep(args.every)
    capture.release()
    print("\nNow write what each picture says into a .txt beside it, same name.")


# ---------------------------------------------------------------- run

def cmd_run(args: argparse.Namespace) -> None:
    images = sorted(glob.glob(os.path.join(args.folder, "*.jpg")))
    cases = []
    for path in images:
        truth_path = os.path.splitext(path)[0] + ".txt"
        if os.path.exists(truth_path):
            with open(truth_path) as handle:
                cases.append((path, handle.read()))
    if not cases:
        raise SystemExit(f"no image with a matching .txt in {args.folder}")
    print(f"{len(cases)} images\n")

    summary: Dict[str, Dict[str, List[float]]] = {}
    for engine, read in ENGINES.items():
        started = time.perf_counter()
        read(cases[0][0])            # the model's one-off load, kept apart
        load = time.perf_counter() - started
        times, errors = [], []
        by_condition: Dict[str, List[float]] = {}
        for path, truth in cases:
            started = time.perf_counter()
            try:
                text = read(path)
            except Exception as error:
                print(f"  {engine}: {os.path.basename(path)} failed: {error}")
                continue
            times.append(time.perf_counter() - started)
            error = cer(text, truth)
            errors.append(error)
            condition = os.path.basename(path).rsplit(".", 1)[0].split("-", 1)[-1]
            by_condition.setdefault(condition, []).append(error)
            if args.show:
                print(f"  [{engine}] {os.path.basename(path):<28} CER {error:.2f}  "
                      f"{_normal(text)[:70]!r}")
        summary[engine] = {"cer": errors, "s": times, "load": [load],
                           "cond": by_condition}  # type: ignore[dict-item]

    print(f"{'engine':<11}{'median CER':>11}{'mean CER':>10}{'exact':>7}"
          f"{'median s':>10}{'worst s':>9}{'load s':>8}")
    for engine, data in summary.items():
        errors, times = data["cer"], data["s"]
        exact = sum(1 for e in errors if e == 0)
        print(f"{engine:<11}{statistics.median(errors):>11.3f}{statistics.mean(errors):>10.3f}"
              f"{exact:>4}/{len(errors):<2}{statistics.median(times):>10.2f}"
              f"{max(times):>9.2f}{data['load'][0]:>8.1f}")
    print("\nmean CER by condition (rows) and engine:")
    conditions = sorted({c for d in summary.values() for c in d["cond"]})  # type: ignore[union-attr]
    print(f"  {'':<22}" + "".join(f"{e:>11}" for e in summary))
    for condition in conditions:
        row = "".join(
            f"{statistics.mean(d['cond'][condition]):>11.3f}" if condition in d["cond"] else f"{'-':>11}"  # type: ignore[index]
            for d in summary.values()
        )
        print(f"  {condition:<22}{row}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    synth = sub.add_parser("synth", help="render known text under webcam-like conditions")
    synth.add_argument("out")
    synth.set_defaults(func=cmd_synth)
    capture = sub.add_parser("capture", help="grab webcam frames")
    capture.add_argument("out")
    capture.add_argument("--count", type=int, default=10)
    capture.add_argument("--every", type=float, default=1.5)
    capture.add_argument("--device", type=int, default=0)
    capture.set_defaults(func=cmd_capture)
    run = sub.add_parser("run", help="score both engines")
    run.add_argument("folder")
    run.add_argument("--show", action="store_true", help="print what each one read")
    run.set_defaults(func=cmd_run)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
