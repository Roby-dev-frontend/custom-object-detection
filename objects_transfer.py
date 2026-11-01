"""Carrying classifiers out of one objects.db and into another.

The one place that knows the export file format. Two callers share it:

    scripts/export_objects.py, scripts/merge_objects.py   the command line
    server_fastapi.py                                     the administration page

so the two can never disagree about what a file holds. Nothing here prints and
nothing calls SystemExit: a problem is a TransferError, and each caller says it
its own way (the scripts as a one-line exit message, the server as an Italian
answer to the page).

WHAT A FILE IS
--------------
A plain, UNENCRYPTED SQLite file (the machine reading it has another
passphrase, so a file only the writer could open would be an export of
nothing) holding classifiers only: the object rows, their photographs and
boxes, which photographs were generated, the template choice and the active
measurement with the references it was made against. Never faces, users,
detections or notifications.

TWO LEVELS OF TRUST
-------------------
The command line reads files this program wrote on a machine the person
controls, so it keeps the checks it always had (`strict=False`).

The page reads whatever an administrator uploads, which is input from outside.
`validate_export` is the gate for that: nothing of the file is believed until it
has passed, and `apply_entry(strict=True)` then copies only rows that stay inside
the classifier they came with. The reasons are in the comments where each check
is made.
"""

import hashlib
import os
import re
import sqlite3
import time
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

import object_augment
import object_dupes
import object_localisers

FORMAT = "camera-objects-1"
IMPORTED_SUFFIX = " (importato)"

# The tables carried across, in an order a foreign key can follow: an object
# before its views, a measurement before its references.
SCHEMA = """
CREATE TABLE object (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL,
    updated INTEGER NOT NULL, created_by TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE view (
    name TEXT PRIMARY KEY, object_id TEXT NOT NULL, jpeg BLOB NOT NULL,
    box_x INTEGER, box_y INTEGER, box_w INTEGER, box_h INTEGER,
    created INTEGER NOT NULL, created_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE measurement (
    object_id TEXT PRIMARY KEY, method TEXT NOT NULL, threshold REAL NOT NULL,
    recall REAL NOT NULL, false_rate REAL NOT NULL, with_min REAL NOT NULL,
    without_max REAL NOT NULL, ms REAL, with_frames INTEGER NOT NULL,
    without_frames INTEGER NOT NULL, reference_view TEXT NOT NULL,
    box_x INTEGER NOT NULL, box_y INTEGER NOT NULL, box_w INTEGER NOT NULL,
    box_h INTEGER NOT NULL, measured_at INTEGER NOT NULL,
    measured_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE measurement_reference (
    object_id TEXT NOT NULL, view_name TEXT NOT NULL, box_x INTEGER NOT NULL,
    box_y INTEGER NOT NULL, box_w INTEGER NOT NULL, box_h INTEGER NOT NULL,
    PRIMARY KEY (object_id, view_name)
);
CREATE TABLE template_pick (
    object_id TEXT NOT NULL, view_name TEXT NOT NULL, rank INTEGER NOT NULL,
    PRIMARY KEY (object_id, view_name)
);
CREATE TABLE view_origin (
    view_name TEXT PRIMARY KEY, source_view TEXT NOT NULL, kind TEXT NOT NULL,
    created INTEGER NOT NULL
);
-- What made this file, so a merge on another machine can say where a
-- classifier came from and refuse a file it cannot read.
CREATE TABLE export_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

# --- limits for a file that comes from outside --------------------------------

MAX_IMPORT_BYTES = 256 * 1024 * 1024
MAX_IMPORT_OBJECTS = 200
MAX_IMPORT_VIEWS = 5000
MAX_VIEWS_PER_OBJECT = 1000
MAX_JPEG_BYTES = 4 * 1024 * 1024
# OpenCV will allocate whatever a JPEG header claims (its own cap is 2**30
# pixels), so a few kilobytes naming 60000 x 60000 would ask for gigabytes on a
# machine with a few. The size is read from the header and refused first.
MAX_JPEG_PIXELS = 24_000_000
MAX_PROBLEMS_SHOWN = 5
# SQL work in the uploaded file is stopped after this many seconds in total.
SQL_BUDGET_SECONDS = 30.0

_ID_OK = re.compile(r"^[0-9a-f]{32}$")
_VIEW_NAME_OK = re.compile(r"^[0-9a-f]{32}\.jpg$")
# The method names the measurement may carry: the three localisers.
METHODS = ("orb", "proposals", "template")

# The columns each table must have, in order -- compared with the file's own.
_EXPECTED_COLUMNS: Dict[str, List[str]] = {
    "object": ["id", "name", "created", "updated", "created_by", "updated_by"],
    "view": ["name", "object_id", "jpeg", "box_x", "box_y", "box_w", "box_h",
             "created", "created_by"],
    "measurement": ["object_id", "method", "threshold", "recall", "false_rate",
                    "with_min", "without_max", "ms", "with_frames", "without_frames",
                    "reference_view", "box_x", "box_y", "box_w", "box_h",
                    "measured_at", "measured_by"],
    "measurement_reference": ["object_id", "view_name", "box_x", "box_y", "box_w", "box_h"],
    "template_pick": ["object_id", "view_name", "rank"],
    "view_origin": ["view_name", "source_view", "kind", "created"],
    "export_meta": ["key", "value"],
}


class TransferError(Exception):
    """`cli` is the one-line message the scripts exit with (unchanged from before
    this module existed); `it` is what the page shows; `status` is the HTTP code."""

    def __init__(self, cli: str, it: Optional[str] = None, status: int = 400) -> None:
        super().__init__(cli)
        self.cli = cli
        self.it = it or cli
        self.status = status


# --- writing an export -----------------------------------------------------------

def chosen_ids(source: sqlite3.Connection, name: Optional[str] = None,
               ids: Optional[Sequence[str]] = None) -> List[str]:
    """Which classifiers to export: the listed ids, one name, or all of them."""
    if ids is not None:
        found = []
        for object_id in ids:
            row = source.execute("SELECT id FROM object WHERE id = ?", (object_id,)).fetchone()
            if row is None:
                raise TransferError(f"no classifier with id {object_id!r} in objects.db",
                                    "Classificatore non trovato.", 404)
            if row[0] not in found:
                found.append(row[0])
        if not found:
            raise TransferError("nothing to export", "Non ci sono classificatori da esportare.", 404)
        return found
    if name is None:
        rows = source.execute("SELECT id FROM object ORDER BY name COLLATE NOCASE").fetchall()
        return [row[0] for row in rows]
    rows = source.execute(
        "SELECT id FROM object WHERE name = ? COLLATE NOCASE", (name,)
    ).fetchall()
    if not rows:
        raise TransferError(f"no classifier called {name!r} in objects.db",
                            "Classificatore non trovato.", 404)
    return [row[0] for row in rows]


def _columns_of(conn: sqlite3.Connection, table: str) -> List[str]:
    return [row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]


def write_export(source: sqlite3.Connection, partial: str,
                 ids: Sequence[str]) -> Dict[str, int]:
    """Writes the chosen classifiers into the new file `partial` and returns how
    many rows of each table went in. The caller renames it into place once it has
    checked it: an interrupted run must not leave a file that looks finished.

    The reads happen inside one transaction, so a classifier being edited while
    this runs is exported as one moment, not as a mixture of two.
    """
    target = sqlite3.connect(partial)
    counts: Dict[str, int] = {}
    source.execute("BEGIN")
    try:
        target.executescript(SCHEMA)
        marks = ",".join("?" * len(ids))
        with target:
            for table, column in (("object", "id"), ("measurement", "object_id"),
                                  ("measurement_reference", "object_id"),
                                  ("template_pick", "object_id")):
                rows = source.execute(
                    f"SELECT * FROM {table} WHERE {column} IN ({marks})", list(ids)
                ).fetchall()
                if not rows:
                    counts[table] = 0
                    continue
                columns = [d[0] for d in source.execute(
                    f"SELECT * FROM {table} LIMIT 0").description]
                # Only the columns this format declares: objects.py may grow
                # one, and a file carrying a column the reader does not know
                # about is a file the reader cannot insert.
                keep = [c for c in columns if c in _columns_of(target, table)]
                placeholders = ",".join("?" * len(keep))
                target.executemany(
                    f"INSERT INTO {table} ({','.join(keep)}) VALUES ({placeholders})",
                    [[row[c] for c in keep] for row in rows],
                )
                counts[table] = len(rows)
            # Photographs one at a time: twenty classifiers of phone
            # photographs do not fit in memory together on this machine.
            views = 0
            for row in source.execute(
                f"SELECT name FROM view WHERE object_id IN ({marks}) ORDER BY created",
                list(ids),
            ).fetchall():
                full = source.execute(
                    "SELECT name, object_id, jpeg, box_x, box_y, box_w, box_h,"
                    " created, created_by FROM view WHERE name = ?", (row[0],)
                ).fetchone()
                target.execute(
                    "INSERT INTO view (name, object_id, jpeg, box_x, box_y, box_w,"
                    " box_h, created, created_by) VALUES (?,?,?,?,?,?,?,?,?)",
                    tuple(full),
                )
                views += 1
            counts["view"] = views
            origins = source.execute(
                "SELECT o.view_name, o.source_view, o.kind, o.created FROM view_origin o"
                f" JOIN view v ON v.name = o.view_name WHERE v.object_id IN ({marks})",
                list(ids),
            ).fetchall()
            target.executemany(
                "INSERT INTO view_origin (view_name, source_view, kind, created)"
                " VALUES (?,?,?,?)", [tuple(r) for r in origins],
            )
            counts["view_origin"] = len(origins)
            target.executemany(
                "INSERT INTO export_meta (key, value) VALUES (?, ?)",
                [("format", FORMAT), ("exported", str(int(time.time()))),
                 ("objects", str(len(ids)))],
            )
    finally:
        try:
            source.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        target.close()
    return counts


# --- reading an export (trusted: the command line) -------------------------------

def open_export(path: str) -> sqlite3.Connection:
    if not os.path.exists(path):
        raise TransferError(f"{path} does not exist", "Il file non esiste.", 404)
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        meta = dict(conn.execute("SELECT key, value FROM export_meta").fetchall())
    except sqlite3.DatabaseError as error:
        conn.close()
        raise TransferError(f"{path} is not a readable export file: {error}",
                            "Questo non è un file di classificatori esportato da questa app.")
    if meta.get("format") != FORMAT:
        conn.close()
        raise TransferError(
            f"{path} is not a {FORMAT} file (it says {meta.get('format')!r})",
            f"Il file è di un altro formato (« {meta.get('format')} »).")
    return conn


def incoming(conn: sqlite3.Connection, name: Optional[str]) -> List[sqlite3.Row]:
    if name is None:
        return conn.execute("SELECT * FROM object ORDER BY name COLLATE NOCASE").fetchall()
    rows = conn.execute("SELECT * FROM object WHERE name = ? COLLATE NOCASE", (name,)).fetchall()
    if not rows:
        raise TransferError(f"no classifier called {name!r} in that file",
                            "Classificatore non presente nel file.")
    return rows


def counts_of(export: sqlite3.Connection, object_id: str) -> Dict[str, int]:
    one = lambda sql: export.execute(sql, (object_id,)).fetchone()[0]
    return {
        "views": one("SELECT COUNT(*) FROM view WHERE object_id = ?"),
        "boxed": one("SELECT COUNT(*) FROM view WHERE object_id = ? AND box_x IS NOT NULL"),
        "picks": one("SELECT COUNT(*) FROM template_pick WHERE object_id = ?"),
        "measured": one("SELECT COUNT(*) FROM measurement WHERE object_id = ?"),
    }


def describe(export: sqlite3.Connection, object_id: str) -> Dict[str, Any]:
    """counts_of plus what the page's preview shows."""
    out: Dict[str, Any] = dict(counts_of(export, object_id))
    out["generated"] = export.execute(
        "SELECT COUNT(*) FROM view_origin g JOIN view v ON v.name = g.view_name"
        " WHERE v.object_id = ?", (object_id,)).fetchone()[0]
    method = export.execute("SELECT method FROM measurement WHERE object_id = ?",
                            (object_id,)).fetchone()
    out["method"] = method[0] if method else None
    return out


# --- planning ----------------------------------------------------------------------

@dataclass
class PlanEntry:
    row: sqlite3.Row
    action: str                     # "new" | "rename" | "into" | "skip"
    target_id: Optional[str]
    explanation: str                # English, exactly what the scripts print
    final_name: str
    why: str = ""                   # "exists" | "not_selected" | "" (for skip)


def _imported_name(base: str, attempt: int, max_name: Optional[int]) -> str:
    suffix = IMPORTED_SUFFIX if attempt == 1 else f"{IMPORTED_SUFFIX} {attempt}"
    if max_name is not None and len(base) + len(suffix) > max_name:
        base = base[: max(1, max_name - len(suffix))].rstrip()
    return base + suffix


def plan(export: sqlite3.Connection, here: sqlite3.Connection,
         rows: Sequence[sqlite3.Row], into: Optional[Dict[str, str]] = None,
         skip_existing: bool = False, max_name: Optional[int] = None,
         only: Optional[Iterable[str]] = None) -> List[PlanEntry]:
    """What the merge would do, per incoming classifier. Nothing is written.

    `into` maps an incoming id to a classifier already here whose photographs
    receive it; `only` limits the import to those incoming ids (the rest come
    back as skipped, so a preview can still list them).
    """
    into = into or {}
    chosen = set(only) if only is not None else None
    existing = {row["name"].lower(): row["id"]
                for row in here.execute("SELECT id, name FROM object").fetchall()}
    taken = set(existing)
    out: List[PlanEntry] = []
    for row in rows:
        if chosen is not None and row["id"] not in chosen:
            out.append(PlanEntry(row, "skip", None, "not selected", row["name"], "not_selected"))
            continue
        if row["id"] in into:
            target = here.execute("SELECT id, name FROM object WHERE id = ?",
                                  (into[row["id"]],)).fetchone()
            if target is None:
                raise TransferError(f"--into {into[row['id']]}: no classifier with that id here",
                                    "« Unisci in »: classificatore di destinazione non trovato.")
            out.append(PlanEntry(row, "into", target["id"],
                                 f"photographs go into the existing « {target['name']} »",
                                 target["name"]))
            continue
        same_id = here.execute("SELECT name FROM object WHERE id = ?", (row["id"],)).fetchone()
        if same_id is not None:
            out.append(PlanEntry(
                row, "into", row["id"],
                f"already here as « {same_id['name']} » (same id): only new photographs",
                same_id["name"]))
            continue
        if row["name"].lower() in taken:
            if skip_existing:
                out.append(PlanEntry(row, "skip", None,
                                     "a classifier of that name is already here",
                                     row["name"], "exists"))
                continue
            attempt = 1
            name = _imported_name(row["name"], attempt, max_name)
            while name.lower() in taken:
                attempt += 1
                name = _imported_name(row["name"], attempt, max_name)
            taken.add(name.lower())
            out.append(PlanEntry(row, "rename", None,
                                 f"the name is taken: imported as « {name} »", name))
            continue
        taken.add(row["name"].lower())
        out.append(PlanEntry(row, "new", None, "new here", row["name"]))
    return out


# --- applying ----------------------------------------------------------------------

# How many photographs the page writes before it lets go of the database and takes
# it again (see apply_entry). A photograph of 60 KB costs about 7 ms to write on
# this Pi, so 25 of them hold the store for about a fifth of a second.
BATCH_PHOTOS = 25


def apply_entry(export: sqlite3.Connection, here: sqlite3.Connection, entry: PlanEntry,
                strict: bool = False,
                signatures: Optional[Dict[str, Tuple[int, bytes]]] = None,
                on_batch: Optional[Callable[[], None]] = None) -> Dict[str, Any]:
    """Writes one planned classifier into `here`. The CALLER owns the transaction,
    so the command line can make one for the whole file.

    The page passes `on_batch`, called after every BATCH_PHOTOS photographs, and
    commits and begins again there. One transaction for a classifier of 500 phone
    photographs held the store for 3.5 s on this Pi (measured), and the video
    reads the same tables through another connection: it would have stood still
    that long. In small steps nothing waits more than a fraction of a second.
    A step that fails leaves the earlier ones in place; that is safe because a
    photograph is recognised by its name, so loading the same file again adds
    only what is missing.

    `strict` is for files from outside: a template pick or a pinned reference is
    kept only if its photograph belongs to the classifier it is being attached
    to. Without that, a crafted file could pin a reference to a photograph of
    ANOTHER classifier here, and the measurement would count it as intact.
    """
    result = {"added_object": False, "added_views": 0, "already_here": 0,
              "measurement_copied": False, "measurement_dropped": False}
    row = entry.row
    if entry.action == "skip":
        return result
    target = entry.target_id
    if entry.action in ("new", "rename"):
        target = row["id"]
        here.execute(
            "INSERT INTO object (id, name, created, updated, created_by,"
            " updated_by) VALUES (?,?,?,?,?,?)",
            (row["id"], entry.final_name, row["created"], row["updated"],
             row["created_by"], row["updated_by"]),
        )
        result["added_object"] = True
    added, present = _copy_views(export, here, row["id"], target, signatures, on_batch)
    result["added_views"] = added
    result["already_here"] = present
    _copy_picks(export, here, row["id"], target, strict)
    if entry.action in ("new", "rename"):
        copied = _copy_measurement(export, here, row["id"], strict)
        result["measurement_copied"] = copied == "copied"
        result["measurement_dropped"] = copied == "dropped"
    return result


def _copy_views(export: sqlite3.Connection, here: sqlite3.Connection, source_id: str,
                target_id: str,
                signatures: Optional[Dict[str, Tuple[int, bytes]]] = None,
                on_batch: Optional[Callable[[], None]] = None) -> Tuple[int, int]:
    """Photographs not already here, by name. One at a time, so a classifier of
    two hundred phone photographs never sits in memory as a whole. Returns
    (added, already present)."""
    added = present = 0
    names = [r[0] for r in export.execute(
        "SELECT name FROM view WHERE object_id = ? ORDER BY created", (source_id,))]
    for view_name in names:
        if here.execute("SELECT 1 FROM view WHERE name = ?", (view_name,)).fetchone():
            present += 1
            continue
        row = export.execute(
            "SELECT name, jpeg, box_x, box_y, box_w, box_h, created, created_by"
            " FROM view WHERE name = ?", (view_name,)
        ).fetchone()
        here.execute(
            "INSERT INTO view (name, object_id, jpeg, box_x, box_y, box_w, box_h,"
            " created, created_by) VALUES (?,?,?,?,?,?,?,?,?)",
            (row["name"], target_id, row["jpeg"], row["box_x"], row["box_y"],
             row["box_w"], row["box_h"], row["created"], row["created_by"]),
        )
        origin = export.execute(
            "SELECT source_view, kind, created FROM view_origin WHERE view_name = ?",
            (view_name,)
        ).fetchone()
        if origin is not None:
            here.execute(
                "INSERT OR IGNORE INTO view_origin (view_name, source_view, kind, created)"
                " VALUES (?,?,?,?)",
                (view_name, origin["source_view"], origin["kind"], origin["created"]),
            )
        if signatures is not None and view_name in signatures:
            made = signatures[view_name]
            here.execute(
                "INSERT OR IGNORE INTO view_signature (view_name, dhash, thumb)"
                " VALUES (?, ?, ?)",
                (view_name, sqlite3.Binary(made[0].to_bytes(8, "big")),
                 sqlite3.Binary(made[1])),
            )
        added += 1
        if on_batch is not None and added % BATCH_PHOTOS == 0:
            on_batch()
    return added, present


def _copy_picks(export: sqlite3.Connection, here: sqlite3.Connection, source_id: str,
                target_id: str, strict: bool = False) -> None:
    """The template choice, but only into a classifier that has none.

    Overwriting a choice somebody made here would be the one destructive thing
    a merge could do, and UNIQUE(object_id, rank) makes appending to an
    existing choice impossible anyway without renumbering somebody else's.
    """
    if here.execute("SELECT 1 FROM template_pick WHERE object_id = ?",
                    (target_id,)).fetchone():
        return
    rows = export.execute(
        "SELECT view_name, rank FROM template_pick WHERE object_id = ? ORDER BY rank",
        (source_id,)
    ).fetchall()
    rank = 0
    for row in rows:
        # Only for a photograph that actually arrived: a pick pointing at a
        # photograph this machine does not have would be refused by the
        # foreign key, and ranks are renumbered so no hole is left behind.
        if strict:
            ok = here.execute("SELECT 1 FROM view WHERE name = ? AND object_id = ?",
                              (row["view_name"], target_id)).fetchone()
        else:
            ok = here.execute("SELECT 1 FROM view WHERE name = ?",
                              (row["view_name"],)).fetchone()
        if ok:
            here.execute(
                "INSERT OR IGNORE INTO template_pick (object_id, view_name, rank)"
                " VALUES (?,?,?)", (target_id, row["view_name"], rank),
            )
            rank += 1


def _copy_measurement(export: sqlite3.Connection, here: sqlite3.Connection,
                      object_id: str, strict: bool = False) -> str:
    """Returns "none" (nothing to copy), "copied" or "dropped" (strict only: a
    reference photograph is not this classifier's, so a measurement made against
    it would be wrong -- better none, and the page says to measure again)."""
    row = export.execute("SELECT * FROM measurement WHERE object_id = ?",
                         (object_id,)).fetchone()
    if row is None:
        return "none"
    references = export.execute(
        "SELECT view_name, box_x, box_y, box_w, box_h FROM measurement_reference"
        " WHERE object_id = ?", (object_id,)
    ).fetchall()
    if strict:
        for ref in references:
            if not here.execute("SELECT 1 FROM view WHERE name = ? AND object_id = ?",
                                (ref["view_name"], object_id)).fetchone():
                return "dropped"
    columns = [c for c in row.keys()]
    here.execute(
        f"INSERT OR IGNORE INTO measurement ({','.join(columns)})"
        f" VALUES ({','.join('?' * len(columns))})",
        tuple(row[c] for c in columns),
    )
    for ref in references:
        here.execute(
            "INSERT OR IGNORE INTO measurement_reference (object_id, view_name,"
            " box_x, box_y, box_w, box_h) VALUES (?,?,?,?,?,?)",
            (object_id, ref["view_name"], ref["box_x"], ref["box_y"],
             ref["box_w"], ref["box_h"]),
        )
    return "copied"


# --- validating a file from outside ----------------------------------------------------

@dataclass
class Validated:
    path: str
    size: int
    sha256: str
    exported: int
    objects: List[Dict[str, Any]] = field(default_factory=list)
    views: int = 0
    # view name -> (dhash, thumbnail bytes), filled while the photographs are
    # checked, so applying does not decode them a second time.
    signatures: Dict[str, Tuple[int, bytes]] = field(default_factory=dict)


class _Problems:
    def __init__(self) -> None:
        self.items: List[str] = []

    def add(self, text: str) -> None:
        self.items.append(text)

    def raise_if_any(self) -> None:
        if not self.items:
            return
        shown = self.items[:MAX_PROBLEMS_SHOWN]
        more = len(self.items) - len(shown)
        text = "; ".join(shown) + (f"; …e altri {more}" if more > 0 else "")
        raise TransferError("invalid export file: " + "; ".join(shown),
                            f"Il file è danneggiato o non valido: {text}")


def jpeg_size(data: bytes) -> Optional[Tuple[int, int]]:
    """(width, height) from the JPEG header, without decoding it, or None if the
    header is not one. Walks the marker segments up to the first start-of-frame."""
    if len(data) < 4 or data[0] != 0xFF or data[1] != 0xD8:
        return None
    at = 2
    end = len(data)
    while at + 4 <= end:
        if data[at] != 0xFF:
            at += 1
            continue
        marker = data[at + 1]
        if marker == 0xFF:
            at += 1
            continue
        if marker in (0x01, 0xD8) or 0xD0 <= marker <= 0xD7:
            at += 2
            continue
        length = (data[at + 2] << 8) | data[at + 3]
        if length < 2:
            return None
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            if at + 9 > end:
                return None
            height = (data[at + 5] << 8) | data[at + 6]
            width = (data[at + 7] << 8) | data[at + 8]
            if width == 0 or height == 0:
                return None
            return width, height
        at += 2 + length
    return None


def _clean_text(value: Any, longest: int, allow_empty: bool = False) -> bool:
    if not isinstance(value, str):
        return False
    stripped = value.strip()
    if not stripped and not allow_empty:
        return False
    if len(value) > longest:
        return False
    return not any(unicodedata.category(ch) in ("Cc", "Cf") for ch in value)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_real(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) \
        and value == value and value not in (float("inf"), float("-inf"))


def _plausible_time(value: Any) -> bool:
    # 2020 .. a day from now; a file claiming another century is not ours.
    return _is_int(value) and 1_577_836_800 <= value <= int(time.time()) + 86_400


def file_sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_export(path: str, max_name: int, sha256: Optional[str] = None) -> Validated:
    """Everything a file from outside has to satisfy before any of it is read for
    real. Raises TransferError (with up to five problems listed) on the first
    failing stage; otherwise returns what the preview and the apply need.

    The whole file is refused for any bad row. This program's own exporter never
    writes one, so a bad row means corruption or tampering, and importing "the
    good part" of such a file would be guessing.
    """
    size = os.path.getsize(path)
    if size > MAX_IMPORT_BYTES:
        raise TransferError("file too large",
                            f"Il file è troppo grande: il limite è {MAX_IMPORT_BYTES // (1024 * 1024)} MB.",
                            413)
    not_ours = TransferError(
        "not an export file",
        "Questo non è un file di classificatori esportato da questa app.")
    with open(path, "rb") as handle:
        header = handle.read(100)
    if len(header) < 100 or not header.startswith(b"SQLite format 3\x00"):
        raise not_ours

    conn = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
    conn.row_factory = sqlite3.Row
    started = time.monotonic()

    def watchdog() -> int:
        # Called every few thousand SQLite steps; non-zero aborts the statement.
        return 1 if time.monotonic() - started > SQL_BUDGET_SECONDS else 0

    conn.set_progress_handler(watchdog, 10000)
    try:
        try:
            conn.execute("PRAGMA trusted_schema=OFF")
            conn.execute("PRAGMA cell_size_check=ON")
            verdict = conn.execute("PRAGMA quick_check").fetchone()
            if verdict is None or verdict[0] != "ok":
                raise not_ours
            return _validate_open(conn, path, size, max_name, sha256)
        except sqlite3.Error:
            raise not_ours
    finally:
        conn.close()


def _validate_open(conn: sqlite3.Connection, path: str, size: int, max_name: int,
                   sha256: Optional[str]) -> Validated:
    problems = _Problems()
    not_ours = TransferError(
        "not an export file",
        "Questo non è un file di classificatori esportato da questa app.")

    # --- the schema is exactly ours: no views, triggers or extra objects
    for kind, name, table in conn.execute(
            "SELECT type, name, tbl_name FROM sqlite_master").fetchall():
        if kind == "table" and name in _EXPECTED_COLUMNS:
            continue
        if kind == "index" and name.startswith("sqlite_autoindex_"):
            continue
        raise not_ours
    for table, expected in _EXPECTED_COLUMNS.items():
        columns = [row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]
        if columns != expected:
            raise not_ours

    meta = dict(conn.execute("SELECT key, value FROM export_meta").fetchall())
    if meta.get("format") != FORMAT:
        raise TransferError(
            f"wrong format {meta.get('format')!r}",
            f"Il file è di un altro formato (« {str(meta.get('format'))[:40]} »).")
    try:
        exported = int(meta.get("exported", ""))
    except ValueError:
        exported = 0
    if not _plausible_time(exported):
        problems.add("data di esportazione non valida")

    # --- objects
    object_rows = conn.execute("SELECT * FROM object").fetchall()
    if len(object_rows) > MAX_IMPORT_OBJECTS:
        problems.add(f"troppi classificatori ({len(object_rows)}, massimo {MAX_IMPORT_OBJECTS})")
    object_ids: Dict[str, Dict[str, Any]] = {}
    names_seen = set()
    for row in object_rows:
        label = str(row["id"])[:12]
        if not (isinstance(row["id"], str) and _ID_OK.match(row["id"])):
            problems.add(f"identificativo non valido ({label})")
            continue
        if row["id"] in object_ids:
            problems.add(f"identificativo ripetuto ({label})")
            continue
        if not _clean_text(row["name"], max_name):
            problems.add(f"nome non valido per il classificatore {label}")
            continue
        if row["name"].strip().lower() in names_seen:
            problems.add(f"nome ripetuto: « {row['name'][:40]} »")
            continue
        names_seen.add(row["name"].strip().lower())
        if not (_plausible_time(row["created"]) and _plausible_time(row["updated"])):
            problems.add(f"date non valide per « {row['name'][:40]} »")
        if not (_clean_text(row["created_by"], 64, True) and _clean_text(row["updated_by"], 64, True)):
            problems.add(f"autore non valido per « {row['name'][:40]} »")
        object_ids[row["id"]] = {"id": row["id"], "name": row["name"], "views": 0}
    problems.raise_if_any()

    # --- photographs: checked one at a time (a file may hold hundreds of MB)
    total_views = conn.execute("SELECT COUNT(*) FROM view").fetchone()[0]
    if total_views > MAX_IMPORT_VIEWS:
        problems.add(f"troppe foto ({total_views}, massimo {MAX_IMPORT_VIEWS})")
        problems.raise_if_any()
    view_object: Dict[str, str] = {}
    view_box: Dict[str, Optional[Tuple[int, int, int, int]]] = {}
    signatures: Dict[str, Tuple[int, bytes]] = {}
    names = [r[0] for r in conn.execute("SELECT name FROM view ORDER BY rowid").fetchall()]
    for name in names:
        if not (isinstance(name, str) and _VIEW_NAME_OK.match(name)):
            problems.add(f"nome di foto non valido ({str(name)[:20]})")
            continue
        row = conn.execute(
            "SELECT typeof(jpeg) AS jpeg_type, length(jpeg) AS jpeg_size, object_id,"
            " box_x, box_y, box_w, box_h, created, created_by FROM view WHERE name = ?",
            (name,)).fetchone()
        if row["object_id"] not in object_ids:
            problems.add(f"la foto {name[:8]}… appartiene a un classificatore assente")
            continue
        if row["jpeg_type"] != "blob" or not (0 < row["jpeg_size"] <= MAX_JPEG_BYTES):
            problems.add(f"la foto {name[:8]}… non è un'immagine valida o è troppo grande")
            continue
        if not _plausible_time(row["created"]) or not _clean_text(row["created_by"], 64, True):
            problems.add(f"dati non validi nella foto {name[:8]}…")
            continue
        info = object_ids[row["object_id"]]
        info["views"] += 1
        if info["views"] > MAX_VIEWS_PER_OBJECT:
            problems.add(f"troppe foto in « {info['name'][:40]} » (massimo {MAX_VIEWS_PER_OBJECT})")
            continue
        jpeg = bytes(conn.execute("SELECT jpeg FROM view WHERE name = ?", (name,)).fetchone()[0])
        dims = jpeg_size(jpeg)
        if dims is None or dims[0] * dims[1] > MAX_JPEG_PIXELS:
            problems.add(f"la foto {name[:8]}… non è un'immagine valida o è troppo grande")
            continue
        box = (row["box_x"], row["box_y"], row["box_w"], row["box_h"])
        if all(v is None for v in box):
            view_box[name] = None
        elif all(_is_int(v) for v in box):
            x, y, w, h = box
            if x < 0 or y < 0 or w < 8 or h < 8 or x + w > dims[0] or y + h > dims[1]:
                problems.add(f"riquadro fuori dall'immagine nella foto {name[:8]}…")
                continue
            view_box[name] = (x, y, w, h)
        else:
            problems.add(f"riquadro non valido nella foto {name[:8]}…")
            continue
        # Only now, with the header size known to be sane, is it decoded: the
        # same pass makes the signature that stops duplicates being added later.
        grey = object_dupes._grey(jpeg)
        if grey is None or sorted(grey.shape) != sorted((dims[1], dims[0])):
            problems.add(f"la foto {name[:8]}… non si legge")
            continue
        signatures[name] = (object_dupes.dhash(grey), object_dupes.thumbnail(grey).tobytes())
        view_object[name] = row["object_id"]
        if problems.items and len(problems.items) > 50:
            break
    problems.raise_if_any()

    # --- generated-photo records
    for row in conn.execute("SELECT * FROM view_origin").fetchall():
        if row["view_name"] not in view_object:
            problems.add("record di foto generata senza la foto")
        elif row["kind"] not in object_augment.KINDS:
            problems.add(f"tipo di variante sconosciuto ({str(row['kind'])[:20]})")
        elif not (isinstance(row["source_view"], str) and _VIEW_NAME_OK.match(row["source_view"])):
            problems.add("foto di origine non valida")
        elif not _is_int(row["created"]):
            problems.add("data non valida in una foto generata")
    problems.raise_if_any()

    # --- template choice: this classifier's own photographs, ranks 0.., at most 6
    picks: Dict[str, List[Tuple[Any, str]]] = {}
    for row in conn.execute("SELECT * FROM template_pick").fetchall():
        if row["object_id"] not in object_ids or view_object.get(row["view_name"]) != row["object_id"]:
            problems.add("scelta dei riferimenti verso una foto di un altro classificatore")
            continue
        if not _is_int(row["rank"]) or row["rank"] < 0:
            problems.add("posizione non valida nella scelta dei riferimenti")
            continue
        picks.setdefault(row["object_id"], []).append((row["rank"], row["view_name"]))
    for object_id, items in picks.items():
        ranks = [rank for rank, _ in items]
        if len(set(ranks)) != len(ranks) or len(items) > object_localisers.MAX_TEMPLATE_REFERENCES:
            problems.add(f"scelta dei riferimenti non valida in « {object_ids[object_id]['name'][:40]} »")
    problems.raise_if_any()

    # --- measurement and the references it was made against
    measured = set()
    bad_measurement = set()
    for row in conn.execute("SELECT * FROM measurement").fetchall():
        object_id = row["object_id"]
        label = object_ids.get(object_id, {}).get("name", "?")[:40]
        if object_id not in object_ids:
            problems.add("misura di un classificatore assente")
            continue
        reals = ("threshold", "recall", "false_rate", "with_min", "without_max")
        if row["method"] not in METHODS or not all(_is_real(row[c]) for c in reals) \
                or not (0 <= row["recall"] <= 1 and 0 <= row["false_rate"] <= 1) \
                or (row["ms"] is not None and not _is_real(row["ms"])) \
                or not all(_is_int(row[c]) and row[c] >= 0 for c in
                           ("with_frames", "without_frames", "box_x", "box_y", "box_w", "box_h")) \
                or not _plausible_time(row["measured_at"]) \
                or not _clean_text(row["measured_by"], 64, True) \
                or not _clean_text(row["reference_view"], 80, True):
            problems.add(f"misura non valida in « {label} »")
            bad_measurement.add(object_id)
            continue
        measured.add(object_id)
    references: Dict[str, int] = {}
    for row in conn.execute("SELECT * FROM measurement_reference").fetchall():
        object_id = row["object_id"]
        if object_id in bad_measurement:
            continue                      # already reported with its measurement
        if object_id not in measured:
            problems.add("riferimento di misura senza misura")
            continue
        references[object_id] = references.get(object_id, 0) + 1
        if references[object_id] > object_localisers.MAX_REFERENCES:
            problems.add("troppi riferimenti di misura")
            continue
        if view_object.get(row["view_name"]) != object_id:
            problems.add("riferimento di misura verso una foto di un altro classificatore")
            continue
        if view_box.get(row["view_name"]) != (row["box_x"], row["box_y"], row["box_w"], row["box_h"]):
            problems.add("riquadro del riferimento diverso da quello della foto")
    problems.raise_if_any()

    return Validated(
        path=path, size=size, sha256=sha256 or file_sha256(path), exported=exported,
        objects=sorted(object_ids.values(), key=lambda o: o["name"].lower()),
        views=len(view_object), signatures=signatures)
