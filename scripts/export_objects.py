#!/usr/bin/env python3
"""Takes classifiers out of objects.db, into one file another Pi can read.

    python3 scripts/export_objects.py --out /media/usb/classificatori.db
    python3 scripts/export_objects.py --out one.db --name "Tazza"
    python3 scripts/export_objects.py --out one.db --verify-only

WHAT IT WRITES, AND WHAT IT LEAVES ALONE
----------------------------------------
Classifiers only: the object rows, their photographs, the boxes, the active
measurement with every reference it was made against, the template choice and
the record of which photographs were generated.

It never reads users.db, detections.db or notifications.db. Those contain
accounts and saved detection data, and "share your classifiers with the other
house" is not a reason for any of that to leave this machine. There is no flag
to include them.

THE EXPORT FILE IS NOT ENCRYPTED
--------------------------------
The export contains the photographs in the clear. Put it somewhere you would
be willing to leave the photographs themselves, and delete it once it has
been merged.

It is a SQLite file rather than JSON or a tar: scripts/merge_objects.py can
then read exactly the columns it needs, a photograph at a time, instead of
holding every JPEG of twenty classifiers in memory at once.

WHY IT NEVER WRITES IN PLACE
----------------------------
The output is built as <out>.partial and renamed only once every check has
passed, the same rule scripts/users_to_sqlite.py follows: an interrupted run
leaves no file that could be mistaken for a complete export.
"""

import argparse
import os
import sqlite3
import sys
import time
from typing import List, Optional

_HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _HERE)

import objects  # noqa: E402
import objects_transfer  # noqa: E402
from objects_transfer import FORMAT, SCHEMA, TransferError  # noqa: E402,F401


def _chosen_ids(source: sqlite3.Connection, name: Optional[str]) -> List[str]:
    try:
        return objects_transfer.chosen_ids(source, name)
    except TransferError as error:
        raise SystemExit(error.cli)


def export(out: str, name: Optional[str]) -> None:
    partial = out + ".partial"
    if os.path.exists(partial):
        os.remove(partial)
    source = objects.connect(objects.OBJECTS_DB, create=False)
    try:
        ids = _chosen_ids(source, name)
        counts = objects_transfer.write_export(source, partial, ids)
    finally:
        source.close()
    os.replace(partial, out)
    print(f"wrote {out}")
    for table in ("object", "view", "measurement", "measurement_reference",
                  "template_pick", "view_origin"):
        print(f"  {table:<22} {counts.get(table, 0)}")
    print("\nThis file is NOT encrypted. Delete it once it has been merged.")


def verify(out: str) -> None:
    """Reads back a file written earlier and says what is in it."""
    if not os.path.exists(out):
        raise SystemExit(f"{out} does not exist")
    conn = sqlite3.connect(f"file:{out}?mode=ro", uri=True)
    try:
        meta = dict(conn.execute("SELECT key, value FROM export_meta").fetchall())
        if meta.get("format") != FORMAT:
            raise SystemExit(f"{out} is not a {FORMAT} file")
        print(f"{out}: {meta['format']}, exported {time.ctime(int(meta['exported']))}")
        for name, in conn.execute("SELECT name FROM object ORDER BY name COLLATE NOCASE"):
            views = conn.execute(
                "SELECT COUNT(*) FROM view v JOIN object o ON o.id = v.object_id"
                " WHERE o.name = ?", (name,)
            ).fetchone()[0]
            boxed = conn.execute(
                "SELECT COUNT(*) FROM view v JOIN object o ON o.id = v.object_id"
                " WHERE o.name = ? AND v.box_x IS NOT NULL", (name,)
            ).fetchone()[0]
            generated = conn.execute(
                "SELECT COUNT(*) FROM view_origin g JOIN view v ON v.name = g.view_name"
                " JOIN object o ON o.id = v.object_id WHERE o.name = ?", (name,)
            ).fetchone()[0]
            measured = conn.execute(
                "SELECT method FROM measurement m JOIN object o ON o.id = m.object_id"
                " WHERE o.name = ?", (name,)
            ).fetchone()
            print(f"  {name}: {views} photos ({boxed} boxed, {generated} generated)"
                  f"{', measured as ' + measured[0] if measured else ', not measured'}")
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, help="the file to write")
    parser.add_argument("--name", help="one classifier by name; default is all of them")
    parser.add_argument("--verify-only", action="store_true",
                        help="read back an existing file instead of writing one")
    args = parser.parse_args()
    if args.verify_only:
        verify(args.out)
        return
    if os.path.exists(args.out):
        raise SystemExit(f"{args.out} already exists. Choose another name or remove it "
                         "yourself -- this script does not overwrite.")
    export(args.out, args.name)
    print()
    verify(args.out)


if __name__ == "__main__":
    main()
