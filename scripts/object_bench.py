#!/usr/bin/env python3
"""Stage 0 of custom-object detection: measure before building anything.

It imports `object_localisers` from the project root and NOTHING else from the
app -- that module is pure vision, so this never opens a database. The same
module backs the Misura button in
the app, so the command line and the page cannot report different numbers.

THE QUESTION IT EXISTS TO ANSWER
--------------------------------
Custom-object detection needs both a location and a similarity score: the
classifier has to find the measured object in a new frame, not just label a
pre-existing crop.

Which substitute works is a property of YOUR object, not of the code, so all
three are measured and the winner is chosen from the numbers. See
object_localisers.py for what each one is good and bad at.

WHAT "GOOD" LOOKS LIKE
----------------------
Two numbers, and the second is the one people forget:

  found      how often it boxes the object in frames that contain it;
  false      how often it boxes SOMETHING in frames that do not.

A localiser that finds the object every time and also boxes the sofa every time
is useless -- it has learned to say yes. Both are reported, and a contact sheet
is written so you can see what it actually drew rather than trusting a
percentage.

USAGE
-----
    python3 scripts/object_bench.py speed
        Timings on this machine. Needs no photographs.

    python3 scripts/object_bench.py capture --out bench_object/with --seconds 20
        Grab frames from a camera into a folder, for "with". The app's own
        Cattura button no longer fills this folder -- it saves "con
        l'oggetto" photos into a named classifier in objects.db instead -- so
        this command is the only way to fill "with" now; "without" is still
        the app's own "Senza" capture, into bench_object/without.

    python3 scripts/object_bench.py localise bench_object
        THE REAL TEST.

FOLDER LAYOUT
-------------
    bench_object/
        reference.jpg      one clean, well-lit photo of the object
        reference.json     the box round it, {"x", "y", "w", "h"}
        with/*.jpg         frames that DO contain it, varied
        without/*.jpg      frames of the same room that do NOT

Nothing writes these two files automatically any more: the app's own Misura
button now draws its reference from a classifier's own photographs in
objects.db instead of this folder, so running this script needs them placed
here by hand, or `--box x,y,w,h` given on the command line.
"""

import argparse
import glob
import json
import os
import statistics
import sys
import time
from typing import List, Sequence, Tuple

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from object_localisers import (  # noqa: E402
    ALL_LOCALISERS,
    compare,
)


def _median_ms(fn, runs: int) -> float:
    """Median rather than mean: one scheduler hiccup on a loaded Pi wrecks a
    mean, and what matters is the typical frame."""
    samples = []
    for _ in range(runs):
        start = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - start) * 1000.0)
    return statistics.median(samples)


def _load(paths: Sequence[str]) -> List[Tuple[str, np.ndarray]]:
    out = []
    for path in paths:
        image = cv2.imread(path)
        if image is not None:
            out.append((os.path.basename(path), image))
    return out


def _images_in(folder: str) -> List[str]:
    found: List[str] = []
    for pattern in ("*.jpg", "*.jpeg", "*.png", "*.JPG", "*.PNG"):
        found.extend(glob.glob(os.path.join(folder, pattern)))
    return sorted(found)


def _spread(scores: Sequence[float]) -> str:
    if not scores:
        return "(none)"
    return (f"min {min(scores):.2f}  median {statistics.median(scores):.2f}"
            f"  max {max(scores):.2f}")


def _contact_sheet(rows, path: str, columns: int = 4) -> None:
    """One picture of everything the localiser drew. A percentage can hide a
    box that is technically on the object and useless in practice."""
    if not rows:
        return
    cell = 240
    thumbs = []
    for label, image in rows:
        scale = cell / max(image.shape[:2])
        small = cv2.resize(image, (int(image.shape[1] * scale), int(image.shape[0] * scale)))
        canvas = np.zeros((cell, cell, 3), np.uint8)
        canvas[: small.shape[0], : small.shape[1]] = small
        cv2.putText(canvas, label[:22], (4, cell - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1, cv2.LINE_AA)
        thumbs.append(canvas)
    while len(thumbs) % columns:
        thumbs.append(np.zeros((cell, cell, 3), np.uint8))
    grid = np.vstack([np.hstack(thumbs[i:i + columns]) for i in range(0, len(thumbs), columns)])
    cv2.imwrite(path, grid)
    print(f"    contact sheet: {path}")


def cmd_localise(args: argparse.Namespace) -> None:
    folder = args.folder
    reference_path = os.path.join(folder, "reference.jpg")
    if not os.path.exists(reference_path):
        raise SystemExit(f"{reference_path} not found. See the layout in this file's header.")
    reference_full = cv2.imread(reference_path)
    if reference_full is None:
        raise SystemExit(f"{reference_path} is not a readable image.")

    saved = os.path.join(folder, "reference.json")
    if args.box:
        try:
            x, y, w, h = (int(v) for v in args.box.split(","))
        except ValueError:
            raise SystemExit("--box wants four numbers: x,y,w,h")
        reference = reference_full[y:y + h, x:x + w]
        if reference.size == 0:
            raise SystemExit("--box falls outside reference.jpg")
    elif os.path.exists(saved):
        with open(saved) as handle:
            box = json.load(handle)
        x, y, w, h = box["x"], box["y"], box["w"], box["h"]
        print(f"box drawn in the app: {w}x{h} at ({x}, {y})"
              f"{' by ' + box['by'] if box.get('by') else ''}")
        reference = reference_full[y:y + h, x:x + w]
        if reference.size == 0:
            raise SystemExit(f"the box in {saved} falls outside reference.jpg")
    else:
        print("no box: using the whole of reference.jpg as the object.")
        print("That includes the background, which will flatter nothing.\n")
        reference = reference_full

    withs = _load(_images_in(os.path.join(folder, "with")))
    withouts = _load(_images_in(os.path.join(folder, "without")))
    if not withs:
        raise SystemExit(f"no images in {os.path.join(folder, 'with')}")
    print(f"reference crop {reference.shape[1]}x{reference.shape[0]} px")
    print(f"{len(withs)} frames with the object, {len(withouts)} without\n")
    if not withouts:
        print("WARNING: no 'without' frames. The false-positive rate -- the number")
        print("that decides whether this is usable -- cannot be measured.\n")

    names = [name for name, _ in withs] + [name for name, _ in withouts]

    def report(row, boxes) -> None:
        print(f"=== {row['name']} ===")
        if row.get("error"):
            print(f"    unavailable: {row['error']}\n")
            return
        print(f"    {row['ms']} ms per frame, boxed {row['boxed']}/{row['of']} "
              "of the frames containing it")
        print(f"    score WITH object: {_spread(row['with_scores'])}")
        if row["without_scores"]:
            print(f"    score WITHOUT:     {_spread(row['without_scores'])}")
            if not row["separates"]:
                print("    SEPARATION: none. The two sets of scores overlap completely --")
                print("      no threshold can tell the object's presence from its absence.")
            else:
                verdict = "clean" if row["false_rate"] == 0 else "imperfect"
                print(f"    SEPARATION: {verdict}. At a threshold of {row['threshold']} it")
                print(f"      finds the object in {row['recall']}% of frames and fires on"
                      f" {row['false_rate']}% of empty ones.")
        drawn = []
        originals = [image for _, image in withs] + [image for _, image in withouts]
        for (label, box, score), original, name in zip(boxes, originals, names):
            empty = label.startswith("without")
            if box is None:
                drawn.append((name + (" EMPTY" if empty else " (none)"), original))
                continue
            shown = original.copy()
            colour = (0, 0, 255) if empty else (0, 255, 0)
            cv2.rectangle(shown, (box[0], box[1]), (box[2], box[3]), colour, 2)
            cv2.putText(shown, f"{score:.2f}", (box[0], max(14, box[1] - 4)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, colour, 1, cv2.LINE_AA)
            drawn.append((name + (" EMPTY" if empty else ""), shown))
        _contact_sheet(drawn, os.path.join(folder, f"sheet-{row['name']}.png"))
        print()

    compare([reference], [image for _, image in withs], [image for _, image in withouts],
            only=args.only, on_result=report)

    print("How to read this: SEPARATION is the line that matters. A candidate")
    print("that boxes the object every time and also boxes something in every")
    print("empty frame has simply learned to say yes, and no threshold rescues")
    print("it. Then open the contact sheets -- a box in the right place for the")
    print("wrong reason still counts as a hit in these numbers, and only the")
    print("picture shows that.")


def cmd_speed(args: argparse.Namespace) -> None:
    runs = args.runs
    print(f"OpenCV {cv2.__version__}, cv2.getNumThreads()={cv2.getNumThreads()}")
    print(f"median of {runs} runs, milliseconds\n")
    rng = np.random.default_rng(0)
    # Synthetic frames are honest here: all three cost what they cost per
    # pixel, not per object. What they FIND needs real photographs, which is
    # what `localise` is for.
    print(f"with {args.refs} reference crop(s) per localiser\n")
    for side in (240, 320, 480):
        frame = rng.integers(0, 255, (side, side, 3), dtype=np.uint8)
        # Distinct crops, not the same one repeated: a repeated crop would let
        # ORB's matcher reuse identical descriptors across "references" and
        # under-report the real cost of several genuinely different ones.
        references = [
            rng.integers(0, 255, (100, 100, 3), dtype=np.uint8) for _ in range(args.refs)
        ]
        for factory in ALL_LOCALISERS:
            try:
                localiser = factory(references)
                ms = _median_ms(lambda: localiser.find(frame), runs)
                print(f"  {factory.name:<12} {side:>4}x{side:<4}  {ms:8.1f}")
            except Exception as error:
                print(f"  {factory.name:<12} {side:>4}x{side:<4}  unavailable: {error}")
        print()


def cmd_capture(args: argparse.Namespace) -> None:
    os.makedirs(args.out, exist_ok=True)
    capture = cv2.VideoCapture(args.device)
    if not capture.isOpened():
        raise SystemExit(f"cannot open camera {args.device}")
    print(f"capturing into {args.out} for {args.seconds}s -- move around the object")
    start = time.time()
    saved = 0
    try:
        while time.time() - start < args.seconds:
            ok, frame = capture.read()
            if not ok:
                continue
            cv2.imwrite(os.path.join(args.out, f"{int(time.time() * 1000)}.jpg"), frame)
            saved += 1
            time.sleep(args.every)
    finally:
        capture.release()
    print(f"saved {saved} frames")


def cmd_dupes(args: argparse.Namespace) -> None:
    """Measure the gap between "the same photograph again" and "another
    photograph", so object_dupes.py's two thresholds are read off real data
    instead of chosen.

    It prints three distributions. The near-copy ones have to end well below
    where the different-scene one starts, and if they overlap there is no
    threshold that works and the approach is wrong -- which is a result, and
    this says so rather than picking a number anyway.
    """
    import object_dupes

    folders = args.folders
    groups: List[Tuple[str, List[Tuple[str, Tuple[int, bytes]]]]] = []
    for folder in folders:
        signatures = []
        for path in _images_in(folder):
            with open(path, "rb") as handle:
                signature = object_dupes.signature(handle.read())
            if signature is not None:
                signatures.append((os.path.basename(path), signature))
        if not signatures:
            print(f"no readable images in {folder}")
            continue
        groups.append((folder, signatures))
    if not groups:
        raise SystemExit("nothing to measure")

    def report(label: str, pairs: Sequence[Tuple[int, float]]) -> None:
        if not pairs:
            print(f"  {label:<34} (no pairs)")
            return
        bits = sorted(p[0] for p in pairs)
        corrs = sorted(p[1] for p in pairs)
        print(f"  {label:<34} {len(pairs):>5} pairs"
              f"   bits min {bits[0]:>2} median {int(statistics.median(bits)):>2} max {bits[-1]:>2}"
              f"   corr min {corrs[0]:.3f} median {statistics.median(corrs):.3f}")

    print("re-encoding the same photograph (quality 95 and 60), the easy case")
    same = []
    for folder, signatures in groups:
        for name, _ in signatures[:5]:
            image = cv2.imread(os.path.join(folder, name))
            for quality in (95, 60):
                ok, buffer = cv2.imencode(".jpg", image,
                                          [int(cv2.IMWRITE_JPEG_QUALITY), quality])
                other = object_dupes.signature(buffer.tobytes())
                original = dict(signatures)[name]
                same.append((object_dupes.distance(original[0], other[0]),
                             object_dupes.correlation(original[1], other[1])))
    report("same photo, re-encoded", same)

    print("\nwithin one folder -- bursts and repeats live here")
    within = {}
    for folder, signatures in groups:
        pairs = []
        for i in range(len(signatures)):
            for j in range(i + 1, len(signatures)):
                left, right = signatures[i][1], signatures[j][1]
                pairs.append((object_dupes.distance(left[0], right[0]),
                              object_dupes.correlation(left[1], right[1])))
        within[folder] = pairs
        report(os.path.basename(folder.rstrip("/")), pairs)

    print("\nacross folders -- different scenes, must stay far")
    across = []
    for a in range(len(groups)):
        for b in range(a + 1, len(groups)):
            for _, left in groups[a][1]:
                for _, right in groups[b][1]:
                    across.append((object_dupes.distance(left[0], right[0]),
                                   object_dupes.correlation(left[1], right[1])))
    report("across", across)

    print(f"\nthresholds in object_dupes.py: <= {object_dupes.MAX_DISTANCE} bits"
          f" AND correlation >= {object_dupes.MIN_CORRELATION}")
    flagged = sum(
        1 for bits, corr in across
        if bits <= object_dupes.MAX_DISTANCE and corr >= object_dupes.MIN_CORRELATION
    )
    print(f"  different-scene pairs they would call near-copies: {flagged} of {len(across)}")
    for folder, pairs in within.items():
        hit = sum(1 for bits, corr in pairs
                  if bits <= object_dupes.MAX_DISTANCE and corr >= object_dupes.MIN_CORRELATION)
        print(f"  {os.path.basename(folder.rstrip('/')):<22} near-copy pairs: {hit} of {len(pairs)}")
    for folder, signatures in groups:
        keep = object_dupes.dedupe([s for _, s in signatures])
        print(f"  {os.path.basename(folder.rstrip('/')):<22} "
              f"{len(signatures)} photos would store {len(keep)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    speed = sub.add_parser("speed", help="timings on this machine")
    speed.add_argument("--runs", type=int, default=15)
    speed.add_argument(
        "--refs", type=int, default=1,
        help="how many reference crops to build each localiser with -- object_localisers.py's "
             "MAX_REFERENCES is a cost cap chosen from exactly this number on real hardware",
    )
    speed.set_defaults(func=cmd_speed)

    capture = sub.add_parser("capture", help="grab frames from a camera")
    capture.add_argument("--out", required=True)
    capture.add_argument("--seconds", type=float, default=20.0)
    capture.add_argument("--every", type=float, default=0.5)
    capture.add_argument("--device", type=int, default=0)
    capture.set_defaults(func=cmd_capture)

    localise = sub.add_parser("localise", help="THE REAL TEST")
    localise.add_argument("folder")
    localise.add_argument("--box", help="x,y,w,h, overriding reference.json")
    localise.add_argument("--only", help="run just one candidate")
    localise.set_defaults(func=cmd_localise)

    dupes = sub.add_parser("dupes", help="measure the near-copy thresholds")
    dupes.add_argument("folders", nargs="+",
                       help="one folder per scene; pairs WITHIN a folder are the "
                            "near-copies, pairs ACROSS folders the different ones")
    dupes.set_defaults(func=cmd_dupes)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
