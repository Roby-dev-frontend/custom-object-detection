#!/usr/bin/env python3
"""Adds classifiers from an export file into THIS machine's objects.db.

    python3 scripts/merge_objects.py classificatori.db --verify-only
    python3 scripts/merge_objects.py classificatori.db
    python3 scripts/merge_objects.py classificatori.db --name "Tazza" --into <id>
    python3 scripts/merge_objects.py classificatori.db --skip-existing

Read the file first with --verify-only: it opens only the export and prints
exactly what the merge would do, classifier by
classifier.

ADDITIVE, ALWAYS
----------------
Nothing already here is changed, renamed or deleted. A merge can only add:
new classifiers, and new photographs inside an existing one. Running the same
file twice is safe -- a photograph is recognised by its own name, which is 16
random bytes made where the photograph was taken, so the second run finds
everything already present and adds nothing.

Ids never collide for the same reason, so there is no renumbering step and no
mapping table: a row keeps the id it had on the machine it came from.

THE ONE REAL CONFLICT: THE NAME
-------------------------------
object.name is UNIQUE COLLATE NOCASE, because two classifiers called "Tazza"
are not a conflict to resolve later -- they are two things nobody can choose
between in a list. So a name already taken is the one case this script has to
decide, and it offers three answers:

    default           import it as "<name> (importato)", both kept apart
    --into <id>       put its photographs INTO a classifier already here
    --skip-existing   leave it alone, import nothing for that name

--into is the one that merges rather than copies, and it is deliberately
per-name and explicit: "the Tazza over there is the same cup as the Tazza
here" is a fact about your house that nothing in a database can check.

WHAT COMES ACROSS WITH A NEW CLASSIFIER
---------------------------------------
Its photographs, their boxes, which of them were generated, the template
choice and -- only for a classifier that is new here -- its measurement with
the references it was made against. A measurement is NOT copied into an
existing classifier (--into): a threshold measured on another machine's
photographs is not a threshold for this one's, and the honest answer is to
press Misura here once the new photographs have arrived.

Nothing is activated for live detection by a merge. That stays a deliberate
press in the page.
"""

import argparse
import os
import sqlite3
import sys
import time
from typing import Dict, List, Optional, Tuple

_HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _HERE)

import objects  # noqa: E402
import objects_transfer  # noqa: E402
from objects_transfer import FORMAT, IMPORTED_SUFFIX, TransferError  # noqa: E402,F401


def _open_export(path: str) -> sqlite3.Connection:
    try:
        return objects_transfer.open_export(path)
    except TransferError as error:
        raise SystemExit(error.cli)


def _incoming(conn: sqlite3.Connection, name: Optional[str]) -> List[sqlite3.Row]:
    try:
        return objects_transfer.incoming(conn, name)
    except TransferError as error:
        raise SystemExit(error.cli)


def _counts(export: sqlite3.Connection, object_id: str) -> Dict[str, int]:
    return objects_transfer.counts_of(export, object_id)


def _plan(export: sqlite3.Connection, here: sqlite3.Connection,
          rows: List[sqlite3.Row], into: Optional[str],
          skip_existing: bool) -> List[objects_transfer.PlanEntry]:
    """What the merge would do, per incoming classifier. Nothing is written."""
    try:
        return objects_transfer.plan(
            export, here, rows,
            into={row["id"]: into for row in rows} if into else None,
            skip_existing=skip_existing)
    except TransferError as error:
        raise SystemExit(error.cli)


def verify(path: str, name: Optional[str], into: Optional[str],
           skip_existing: bool) -> None:
    """Says what would happen, without opening the local store or writing.

    It cannot see what is already here, so it reports the file and the
    conflicts it can check -- names inside the file itself -- and says so
    plainly rather than implying it checked more.
    """
    export = _open_export(path)
    try:
        meta = dict(export.execute("SELECT key, value FROM export_meta").fetchall())
        print(f"{path}: {meta['format']}, exported {time.ctime(int(meta['exported']))}")
        for row in _incoming(export, name):
            counts = _counts(export, row["id"])
            print(f"  « {row['name']} »  {counts['views']} photos"
                  f" ({counts['boxed']} boxed), {counts['picks']} template picks,"
                  f" {'measured' if counts['measured'] else 'not measured'}")
        print("\nThis says what is IN the file. What it would collide with here needs the")
        print("local database, so run it without --verify-only to see that.")
    finally:
        export.close()


def merge(path: str, name: Optional[str], into: Optional[str],
          skip_existing: bool, dry_run: bool) -> None:
    export = _open_export(path)
    here = objects.connect(objects.OBJECTS_DB, create=False)
    try:
        rows = _incoming(export, name)
        plan = _plan(export, here, rows, into, skip_existing)
        print(f"{len(plan)} classifier(s) in {path}:")
        for entry in plan:
            counts = _counts(export, entry.row["id"])
            print(f"  « {entry.row['name']} »  {counts['views']} photos"
                  f" -> {entry.action}: {entry.explanation}")
        if dry_run:
            print("\n--dry-run: nothing written.")
            return
        added_objects = added_views = 0
        here.execute("BEGIN IMMEDIATE")
        try:
            for entry in plan:
                done = objects_transfer.apply_entry(export, here, entry)
                added_objects += 1 if done["added_object"] else 0
                added_views += done["added_views"]
        except BaseException:
            here.execute("ROLLBACK")
            raise
        here.execute("COMMIT")
        print(f"\nadded {added_objects} classifier(s) and {added_views} photograph(s)")
        print("Nothing was activated for live detection: press Misura in the page,")
        print("then « Usa questo metodo », for anything you want detected here.")
    finally:
        here.close()
        export.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file", help="an export written by scripts/export_objects.py")
    parser.add_argument("--name", help="just one classifier out of the file")
    parser.add_argument("--into", metavar="ID",
                        help="merge the photographs into an existing classifier")
    parser.add_argument("--skip-existing", action="store_true",
                        help="leave a name that is already here alone")
    parser.add_argument("--verify-only", action="store_true",
                        help="read the file and stop without opening the local store")
    parser.add_argument("--dry-run", action="store_true",
                        help="say what would be merged, including collisions here, "
                             "and write nothing")
    args = parser.parse_args()
    if args.into and not args.name:
        raise SystemExit("--into needs --name: it merges ONE classifier into one here")
    if args.verify_only:
        verify(args.file, args.name, args.into, args.skip_existing)
        return
    merge(args.file, args.name, args.into, args.skip_existing, args.dry_run)


if __name__ == "__main__":
    main()
