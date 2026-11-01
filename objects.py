"""Named objects and the photographs taken of them.

A separate encrypted store beside faces.db, opened with the same passphrase,
because the two hold different things: faces.db holds people, this holds
belongings. Keeping them apart means nothing in here can disturb enrolled
people, which is the one dataset in this project that cannot be regenerated.

WHAT IS STORED, AND WHAT DELIBERATELY IS NOT
-------------------------------------------
Every view keeps its photograph, the rectangle somebody drew round the object,
and who contributed it. That is the durable part, and it is worth keeping
whatever happens next.

There is no embedding, no descriptor, no matching representation -- yet. Which
one to store is exactly the question scripts/object_bench.py and the Misura
button exist to answer, and storing the wrong one now would mean recomputing
every record later. The photographs and the boxes are the input to all three
candidates; the representation is added once the measurement has chosen.

A VIEW AND ITS PICTURE ARE ONE THING
------------------------------------
Written into the schema from the start, rather than learned twice. In faces.py
the mark and the picture were trimmed by two independent rules, and a record
over the cap could end up with an embedding whose photograph had been evicted
-- a mark still matching, with nothing to show for itself. Here a view IS the
row that holds the picture, so the question cannot arise.
"""

import contextlib
import os
import re
import secrets
import threading
import time
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

import sqlite3

import object_dupes

_HERE = os.path.dirname(os.path.abspath(__file__))
OBJECTS_DB = os.path.join(_HERE, "objects.db")

MAX_NAME_LENGTH = 60

SCHEMA = """
CREATE TABLE IF NOT EXISTS object (
    id         TEXT    PRIMARY KEY,
    -- Unique, and the database says so rather than the endpoint: two entries
    -- called "Tazza" are not a conflict to resolve later, they are two things
    -- a person cannot choose between. NOCASE so "Tazza" and "tazza" collide,
    -- which is what anybody would expect them to do.
    name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    -- What the person called it when the first photograph was saved, plus the
    -- description and traffic-light judge they chose in the same form.
    description TEXT   NOT NULL DEFAULT '',
    judge       TEXT   NOT NULL DEFAULT 'verde',
    created     INTEGER NOT NULL,
    updated     INTEGER NOT NULL,
    created_by  TEXT    NOT NULL DEFAULT '',
    updated_by  TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS view (
    name       TEXT    PRIMARY KEY,
    object_id  TEXT    NOT NULL REFERENCES object(id) ON DELETE CASCADE,
    jpeg       BLOB    NOT NULL,
    -- The rectangle somebody drew round the object, in the pixels of THIS
    -- photograph. Nullable: a view imported from a folder has no box until
    -- somebody draws one, and that is a missing answer rather than a broken
    -- row.
    box_x      INTEGER,
    box_y      INTEGER,
    box_w      INTEGER,
    box_h      INTEGER,
    created    INTEGER NOT NULL,
    created_by TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS view_object ON view(object_id, created);

-- The ONE measurement currently trusted for live detection, if any. Not a
-- history: an administrator activates one row from a Misura result (see
-- server_fastapi.py's /objects/measure and the "Usa per il rilevamento"
-- button), and that replaces whatever was active before -- there is only
-- ever one classifier detecting at a time, because detection_config is
-- shared by the whole machine.
--
-- Pinned to the EXACT photo and box it was computed from, rather than just
-- to the object: a threshold is only meaningful relative to the reference
-- embedding it was measured against. get_measurement() checks the pinned
-- box against the view's CURRENT box and treats any difference -- a redrawn
-- box, or the photo itself gone -- as "no longer measured", rather than
-- silently judging live frames against a reference that no longer exists.
CREATE TABLE IF NOT EXISTS measurement (
    object_id      TEXT    PRIMARY KEY REFERENCES object(id) ON DELETE CASCADE,
    method         TEXT    NOT NULL,
    threshold      REAL    NOT NULL,
    recall         REAL    NOT NULL,
    false_rate     REAL    NOT NULL,
    -- The lowest score Misura saw on a "with" photo and the highest it saw on
    -- a "without" photo -- not used yet, kept so a live cut point can be
    -- chosen without re-running the comparison.
    with_min       REAL    NOT NULL,
    without_max    REAL    NOT NULL,
    ms             REAL,
    with_frames    INTEGER NOT NULL,
    without_frames INTEGER NOT NULL,
    -- Superseded by measurement_reference below, which can hold several.
    -- Kept (filled with the first reference) rather than dropped: SQLite
    -- cannot make a NOT NULL column nullable without rebuilding the table,
    -- and nothing still reads these two past the migration in SCHEMA.
    reference_view TEXT    NOT NULL,
    box_x          INTEGER NOT NULL,
    box_y          INTEGER NOT NULL,
    box_w          INTEGER NOT NULL,
    box_h          INTEGER NOT NULL,
    measured_at    INTEGER NOT NULL,
    measured_by    TEXT    NOT NULL DEFAULT ''
);

-- Every boxed photo the active measurement actually matches against, not
-- just one: a single reference crop made live detection fragile (one photo's
-- lighting/angle/distance had to carry the whole classifier) and made
-- deleting or redrawing that ONE unmarked photo silently disable detection.
-- No foreign key to view (same reason measurement.reference_view has none):
-- a deleted photo must leave its pinned row behind so a read can tell "3 of
-- 5 references still intact" from "never measured", rather than the row
-- just vanishing along with the photo.
CREATE TABLE IF NOT EXISTS measurement_reference (
    object_id  TEXT    NOT NULL REFERENCES measurement(object_id) ON DELETE CASCADE,
    view_name  TEXT    NOT NULL,
    box_x      INTEGER NOT NULL,
    box_y      INTEGER NOT NULL,
    box_w      INTEGER NOT NULL,
    box_h      INTEGER NOT NULL,
    PRIMARY KEY (object_id, view_name)
);

-- A measurement row from before multiple references existed becomes a
-- one-reference set -- behaviourally identical, since matching against one
-- reference is exactly what happened before. Idempotent: it only inserts for
-- a measurement with no reference rows yet, which a new-style activation
-- never leaves behind (set_measurement always writes at least one).
INSERT OR IGNORE INTO measurement_reference (object_id, view_name, box_x, box_y, box_w, box_h)
SELECT m.object_id, m.reference_view, m.box_x, m.box_y, m.box_w, m.box_h
FROM measurement m
WHERE NOT EXISTS (SELECT 1 FROM measurement_reference r WHERE r.object_id = m.object_id);

-- WHICH boxed photos the template method may use, and in which order.
--
-- Template reruns a whole scale sweep per reference, so it can afford about
-- six where the other two methods take twenty (MAX_TEMPLATE_REFERENCES in
-- object_localisers.py). It used to take "the first six", which in practice
-- meant six frames of one burst: the method with the tightest budget spent all
-- of it on one angle. These rows are a person's own choice instead, made by
-- tapping the photos.
--
-- Unlike measurement_reference this DOES cascade from view: a pick is a live
-- intention about a photograph, meaningless once the photograph is gone, where
-- a pinned reference is the record of a measurement that really happened and
-- has to outlive its photo to say "3 of 5 still intact".
CREATE TABLE IF NOT EXISTS template_pick (
    object_id TEXT    NOT NULL REFERENCES object(id) ON DELETE CASCADE,
    view_name TEXT    NOT NULL REFERENCES view(name) ON DELETE CASCADE,
    rank      INTEGER NOT NULL,
    PRIMARY KEY (object_id, view_name)
);
CREATE UNIQUE INDEX IF NOT EXISTS template_pick_rank ON template_pick(object_id, rank);

-- Photographs this program MADE, out of one somebody took.
--
-- A variant is an ordinary view row: it has the same picture format, the same
-- box (every transform in object_augment.py is per-pixel, so the original's
-- box is still correct on it) and it is deleted, measured and served exactly
-- like a real photograph. What it is not is EVIDENCE: twenty variants of one
-- burst are not twenty photographs of the object, and a recall figure that
-- counted them would be measuring this program against its own output.
--
-- So the fact that a row was generated is recorded, and the three places that
-- care read it: the measurement leaves variants out of its recall set, the
-- page badges them, and DELETE /objects/{id}/generated takes them all back out
-- in one go. source_view has no foreign key on purpose -- deleting the
-- original should not take its variants with it, because they are still
-- usable photographs, and "made from a photo that is gone" is a true thing
-- worth keeping.
CREATE TABLE IF NOT EXISTS view_origin (
    view_name   TEXT    PRIMARY KEY REFERENCES view(name) ON DELETE CASCADE,
    source_view TEXT    NOT NULL,
    kind        TEXT    NOT NULL,
    created     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS view_origin_source ON view_origin(source_view);

-- What each photograph looks like, in 72 bytes, so "is this one I already
-- have?" does not mean decoding every stored JPEG again.
--
-- A cache, not data: every row here can be recomputed from the view it
-- belongs to (object_dupes.signature), and dropping the table would cost time
-- and nothing else. It exists because the cost is real -- 9.8 ms per stored
-- photograph on this Pi -- and an import of 200 photographs into a classifier
-- holding 200 would otherwise spend six and a half minutes on nothing but
-- decoding the same stored pictures over and over.
-- dhash is the 64-bit hash as 8 big-endian bytes, NOT an INTEGER: SQLite's
-- INTEGER is signed 64-bit, so every hash with its top bit set -- about half
-- of them -- raises OverflowError on the way in. Nothing compares these in
-- SQL (the comparison is a population count, in object_dupes), so a blob
-- costs nothing here.
CREATE TABLE IF NOT EXISTS view_signature (
    view_name TEXT PRIMARY KEY REFERENCES view(name) ON DELETE CASCADE,
    dhash     BLOB NOT NULL,
    thumb     BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
"""

# Reentrant for the same reason faces.py's is: a write helper may call a read
# helper while still holding it, so nobody sees a half-applied change.
_lock = threading.RLock()


def connect(path: str = OBJECTS_DB, create: bool = False,
            passphrase: Optional[str] = None) -> sqlite3.Connection:
    """Opens the store.

    `create` is False by default: a missing file must not silently become an
    empty store -- "no objects exist yet" would look exactly like every object
    having been deleted.
    """
    if not create and not os.path.exists(path):
        raise FileNotFoundError(
            f"{path} does not exist. Refusing to create an empty encrypted store: "
            "that would look exactly like every stored object having vanished. "
            "If this really is a first run, pass create=True."
        )
    conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=10.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=10000")
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    # Columns added after the database was first created: sqlite has no
    # "ADD COLUMN IF NOT EXISTS", so we try and swallow the duplicate error.
    for column in ("description TEXT NOT NULL DEFAULT ''",
                   "judge TEXT NOT NULL DEFAULT 'verde'"):
        try:
            conn.execute(f"ALTER TABLE object ADD COLUMN {column}")
        except sqlite3.OperationalError:
            pass
    # Asserted, not hoped about: foreign_keys is off by default and per
    # connection, and forgetting it raises nothing -- deleting an object would
    # simply leave every photograph of it behind, invisibly.
    if conn.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
        raise RuntimeError("SQLite refused to enable foreign keys: cascades would not happen")
    return conn


_conn: Optional[sqlite3.Connection] = None


def _db() -> sqlite3.Connection:
    """The connection, opened on first use rather than at import, so importing
    this module never creates a file."""
    global _conn
    with _lock:
        if _conn is None:
            _conn = connect(OBJECTS_DB, create=True)
        return _conn


@contextlib.contextmanager
def _write() -> Iterator[sqlite3.Connection]:
    with _lock:
        conn = _db()
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")


def _clean_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise ValueError("Il nome non puo' essere vuoto.")
    if len(name) > MAX_NAME_LENGTH:
        raise ValueError(f"Il nome non puo' superare {MAX_NAME_LENGTH} caratteri.")
    return name


def _public(row: sqlite3.Row, views: int = 0,
            detector: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "judge": row["judge"],
        "views": views,
        "created": row["created"],
        "updated": row["updated"],
        "created_by": row["created_by"],
        "updated_by": row["updated_by"],
        # None until an administrator activates a Misura result for this
        # classifier (see set_measurement). The page uses this to decide
        # whether the classifier can be offered under "Detect" at all.
        "detector": detector,
    }


def _reference_intact(row: sqlite3.Row) -> bool:
    """True when a pinned reference's photo still exists with the EXACT box
    the measurement was computed against -- see the measurement table's own
    comment. Shared by every reader that joins measurement_reference (or the
    legacy measurement columns) against view's CURRENT box, aliased cur_x/
    cur_y/cur_w/cur_h."""
    if row["cur_x"] is None:
        return False
    return (row["box_x"], row["box_y"], row["box_w"], row["box_h"]) == (
        row["cur_x"], row["cur_y"], row["cur_w"], row["cur_h"],
    )


def _measurement_rows(object_ids: Optional[List[str]] = None) -> Dict[str, Dict[str, Any]]:
    """Every object's measurement, keyed by object_id, but ONLY the ones with
    at least one reference still intact (see _reference_intact). Losing one
    reference out of several degrades detection; losing the last one is what
    turns a classifier "unmeasured" again -- the same object_id simply stops
    appearing in the returned dict. Kept as one query so list_objects() does
    not run one extra query per classifier.
    """
    query = (
        "SELECT m.object_id, m.method, m.threshold, m.recall, m.false_rate,"
        " m.measured_at, m.measured_by, r.box_x, r.box_y, r.box_w, r.box_h,"
        " v.box_x AS cur_x, v.box_y AS cur_y, v.box_w AS cur_w, v.box_h AS cur_h"
        " FROM measurement m JOIN measurement_reference r ON r.object_id = m.object_id"
        " LEFT JOIN view v ON v.name = r.view_name"
    )
    params: tuple = ()
    if object_ids is not None:
        if not object_ids:
            return {}
        query += f" WHERE m.object_id IN ({','.join('?' * len(object_ids))})"
        params = tuple(object_ids)
    with _lock:
        rows = _db().execute(query, params).fetchall()
    pinned: Dict[str, int] = {}
    intact: Dict[str, int] = {}
    info: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        object_id = row["object_id"]
        pinned[object_id] = pinned.get(object_id, 0) + 1
        info.setdefault(object_id, {
            "method": row["method"],
            "threshold": row["threshold"],
            "recall": row["recall"],
            "false_rate": row["false_rate"],
            "measured_at": row["measured_at"],
            "measured_by": row["measured_by"],
        })
        if _reference_intact(row):
            intact[object_id] = intact.get(object_id, 0) + 1
    return {
        object_id: {**info[object_id], "references": count,
                    "references_pinned": pinned[object_id]}
        for object_id, count in intact.items()
    }


def _intact_reference_view_names(object_id: str) -> set:
    """Which of this object's photos are a reference the live detector still
    actually uses -- for get_object()'s view_list, so the page can mark them
    and warn before a delete or a redrawn box would drop one. A superset of
    "has a box": a box drawn AFTER the classifier was activated is not yet a
    reference (see classifier_detection.py -- only Misura plus activation
    makes a new box count)."""
    with _lock:
        rows = _db().execute(
            "SELECT r.view_name, r.box_x, r.box_y, r.box_w, r.box_h,"
            " v.box_x AS cur_x, v.box_y AS cur_y, v.box_w AS cur_w, v.box_h AS cur_h"
            " FROM measurement_reference r LEFT JOIN view v ON v.name = r.view_name"
            " WHERE r.object_id = ?", (object_id,),
        ).fetchall()
    return {row["view_name"] for row in rows if _reference_intact(row)}


def list_objects() -> List[Dict[str, Any]]:
    with _lock:
        rows = _db().execute(
            "SELECT o.*, (SELECT COUNT(*) FROM view WHERE object_id = o.id) AS views,"
            " (SELECT COUNT(*) FROM view v WHERE v.object_id = o.id AND NOT EXISTS"
            "  (SELECT 1 FROM view_origin g WHERE g.view_name = v.name)) AS real_views"
            " FROM object o ORDER BY o.name COLLATE NOCASE"
        ).fetchall()
    detectors = _measurement_rows()
    out = []
    for row in rows:
        # Both counts, same as get_object: "how much is stored" and "how many
        # photographs somebody took" are different questions, and the warning
        # about having too many must not fire on generated variants.
        record = _public(row, row["views"], detectors.get(row["id"]))
        record["real_views"] = row["real_views"]
        out.append(record)
    return out


def get_object(object_id: str) -> Optional[Dict[str, Any]]:
    with _lock:
        row = _db().execute("SELECT * FROM object WHERE id = ?", (object_id,)).fetchone()
        if row is None:
            return None
        views = _db().execute(
            "SELECT name, box_x, box_y, box_w, box_h, created, created_by"
            " FROM view WHERE object_id = ? ORDER BY created", (object_id,)
        ).fetchall()
    detector = _measurement_rows([object_id]).get(object_id)
    in_detector = _intact_reference_view_names(object_id)
    picks = get_template_picks(object_id)
    rank_of = {name: index + 1 for index, name in enumerate(picks)}
    generated = generated_kinds(object_id)
    record = _public(row, len(views), detector)
    record["template_picks"] = picks
    # Photographs somebody actually took, i.e. not counting what /augment
    # made. The page warns on this rather than on the total: generating
    # variants should not make it say "you have a lot of photographs".
    record["real_views"] = sum(1 for v in views if v["name"] not in generated)
    record["view_list"] = [
        {
            "name": v["name"],
            "box": (None if v["box_x"] is None
                    else {"x": v["box_x"], "y": v["box_y"], "w": v["box_w"], "h": v["box_h"]}),
            "created": v["created"],
            "created_by": v["created_by"],
            "in_detector": v["name"] in in_detector,
            # 1-based so it can be shown as it is; None when not chosen.
            "template_rank": rank_of.get(v["name"]),
            # Which transform made this one, or None for a real photograph.
            "generated": generated.get(v["name"]),
        }
        for v in views
    ]
    # Whether the choice has moved since template was activated. Re-picking
    # changes nothing on its own -- the active measurement keeps the references
    # it was made with -- and without saying so, a photo would carry a number
    # while the detector quietly went on using another set.
    if detector and detector.get("method") == "template":
        activated = _activated_reference_names(object_id)
        record["detector"]["template_stale"] = bool(picks) and set(picks) != activated
    return record


def _activated_reference_names(object_id: str) -> set:
    """Every view name the active measurement pinned, intact or not: the
    question here is what was MEASURED, not what still exists."""
    with _lock:
        rows = _db().execute(
            "SELECT view_name FROM measurement_reference WHERE object_id = ?", (object_id,)
        ).fetchall()
    return {row["view_name"] for row in rows}


def get_template_picks(object_id: str) -> List[str]:
    """The photos chosen for the template method, in the order chosen.

    Empty when nobody has chosen: callers then fall back to what template
    always did, the first few boxed photos. See template_pick in SCHEMA.
    """
    with _lock:
        rows = _db().execute(
            "SELECT view_name FROM template_pick WHERE object_id = ? ORDER BY rank",
            (object_id,),
        ).fetchall()
    return [row["view_name"] for row in rows]


def set_template_picks(object_id: str, view_names: List[str]) -> Optional[List[str]]:
    """Replaces the whole choice in one transaction, ranked by position.

    Whole-list replace rather than toggle-one, for three reasons: the request is
    idempotent, the rank IS the position in the list the caller sent, and the
    UNIQUE(object_id, rank) index can never be tripped halfway through a
    reshuffle. Returns the stored list, or None when the object is unknown.

    Raises ValueError for a name that is not this object's, for a photo with no
    box (an unboxed photo cannot be a reference at all), and for a duplicate --
    all three mean the caller and the database disagree about what exists,
    which is worth saying rather than silently dropping.
    """
    wanted = list(view_names or [])
    if len(set(wanted)) != len(wanted):
        raise ValueError("Una foto compare due volte nella scelta.")
    with _write() as conn:
        if conn.execute("SELECT 1 FROM object WHERE id = ?", (object_id,)).fetchone() is None:
            return None
        if wanted:
            rows = conn.execute(
                "SELECT name, box_x FROM view WHERE object_id = ? AND name IN "
                f"({','.join('?' * len(wanted))})",
                (object_id, *wanted),
            ).fetchall()
            known = {row["name"]: row["box_x"] for row in rows}
            for name in wanted:
                if name not in known:
                    raise ValueError("Una delle foto scelte non appartiene a questo classificatore.")
                if known[name] is None:
                    raise ValueError("Una delle foto scelte non ha il riquadro: disegnalo prima.")
        conn.execute("DELETE FROM template_pick WHERE object_id = ?", (object_id,))
        conn.executemany(
            "INSERT INTO template_pick (object_id, view_name, rank) VALUES (?, ?, ?)",
            [(object_id, name, index) for index, name in enumerate(wanted)],
        )
    return wanted


def set_measurement(
    object_id: str, *, method: str, threshold: float, recall: float, false_rate: float,
    with_min: float, without_max: float, ms: Optional[float], with_frames: int,
    without_frames: int, references: List[Dict[str, Any]], measured_by: str = "",
) -> bool:
    """Activates one Misura result as the thing live detection trusts for this
    classifier: which method, its threshold, and every boxed photo (each a
    {"view": name, "box": {...}} dict) it matches against. Replaces whatever
    was active before, references included -- there is only one active
    measurement per classifier.

    Returns False when the object does not exist (nothing to attach it to).
    """
    if not references:
        raise ValueError("set_measurement needs at least one reference.")
    with _write() as conn:
        if conn.execute("SELECT 1 FROM object WHERE id = ?", (object_id,)).fetchone() is None:
            return False
        now = int(time.time())
        # The legacy reference_view/box_* columns are superseded by
        # measurement_reference below; filled from the first reference only
        # because nothing reads them again (see the measurement table's
        # comment) and they cannot be made nullable without rebuilding the
        # table.
        first = references[0]
        conn.execute(
            "INSERT INTO measurement (object_id, method, threshold, recall, false_rate,"
            " with_min, without_max, ms, with_frames, without_frames, reference_view,"
            " box_x, box_y, box_w, box_h, measured_at, measured_by)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(object_id) DO UPDATE SET"
            " method=excluded.method, threshold=excluded.threshold, recall=excluded.recall,"
            " false_rate=excluded.false_rate, with_min=excluded.with_min,"
            " without_max=excluded.without_max, ms=excluded.ms,"
            " with_frames=excluded.with_frames, without_frames=excluded.without_frames,"
            " reference_view=excluded.reference_view, box_x=excluded.box_x,"
            " box_y=excluded.box_y, box_w=excluded.box_w, box_h=excluded.box_h,"
            " measured_at=excluded.measured_at, measured_by=excluded.measured_by",
            (object_id, method, threshold, recall, false_rate, with_min, without_max, ms,
             with_frames, without_frames, first["view"],
             first["box"]["x"], first["box"]["y"], first["box"]["w"], first["box"]["h"],
             now, measured_by),
        )
        conn.execute("DELETE FROM measurement_reference WHERE object_id = ?", (object_id,))
        conn.executemany(
            "INSERT INTO measurement_reference (object_id, view_name, box_x, box_y, box_w, box_h)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            [
                (object_id, r["view"], r["box"]["x"], r["box"]["y"], r["box"]["w"], r["box"]["h"])
                for r in references
            ],
        )
        return True


def get_measurement(object_id: str) -> Optional[Dict[str, Any]]:
    """The classifier's active measurement, with every reference crop still
    INTACT: its photo still exists, with the exact box the measurement was
    computed against (see _reference_intact). None when nothing was ever
    activated, or when every reference has gone stale -- losing one at a
    time degrades detection (see classifier_detection.py), losing the last
    one turns it off.
    """
    with _lock:
        row = _db().execute(
            "SELECT * FROM measurement WHERE object_id = ?", (object_id,)
        ).fetchone()
        if row is None:
            return None
        ref_rows = _db().execute(
            "SELECT r.view_name, r.box_x, r.box_y, r.box_w, r.box_h,"
            " v.box_x AS cur_x, v.box_y AS cur_y, v.box_w AS cur_w, v.box_h AS cur_h"
            " FROM measurement_reference r LEFT JOIN view v ON v.name = r.view_name"
            " WHERE r.object_id = ? ORDER BY r.rowid", (object_id,),
        ).fetchall()
    references = [
        {"view": r["view_name"],
         "box": {"x": r["box_x"], "y": r["box_y"], "w": r["box_w"], "h": r["box_h"]}}
        for r in ref_rows if _reference_intact(r)
    ]
    if not references:
        return None
    return {
        "method": row["method"],
        "threshold": row["threshold"],
        "references": references,
        "references_pinned": len(ref_rows),
        "measured_at": row["measured_at"],
    }


def create_object(name: str, created_by: str = "",
                  description: str = "", judge: str = "verde") -> Dict[str, Any]:
    """Raises ValueError when the name is empty, too long, or already taken."""
    name = _clean_name(name)
    object_id = secrets.token_hex(16)
    now = int(time.time())
    with _write() as conn:
        if conn.execute(
            "SELECT 1 FROM object WHERE name = ? COLLATE NOCASE", (name,)
        ).fetchone():
            raise ValueError(f"Esiste gia' un oggetto chiamato « {name} ».")
        conn.execute(
            "INSERT INTO object (id, name, description, judge, created, updated,"
            " created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (object_id, name, description, judge, now, now, created_by,
             created_by),
        )
    return get_object(object_id)


def rename_object(object_id: str, name: str, updated_by: str = "") -> Optional[Dict[str, Any]]:
    """The name is the ONLY thing this changes.

    Photographs, boxes and who contributed them are untouched, so correcting a
    typo never costs a record its history.
    """
    name = _clean_name(name)
    with _write() as conn:
        if conn.execute("SELECT 1 FROM object WHERE id = ?", (object_id,)).fetchone() is None:
            return None
        clash = conn.execute(
            "SELECT id FROM object WHERE name = ? COLLATE NOCASE AND id <> ?",
            (name, object_id),
        ).fetchone()
        if clash:
            raise ValueError(f"Esiste gia' un oggetto chiamato « {name} ».")
        conn.execute(
            "UPDATE object SET name = ?, updated = ?, updated_by = ? WHERE id = ?",
            (name, int(time.time()), updated_by, object_id),
        )
    return get_object(object_id)


def delete_object(object_id: str) -> bool:
    """The object and every photograph of it, in one statement.

    The views go with it by ON DELETE CASCADE -- which works because
    connect() both sets and verifies PRAGMA foreign_keys.
    """
    with _write() as conn:
        return conn.execute("DELETE FROM object WHERE id = ?", (object_id,)).rowcount > 0


def _new_view_name() -> str:
    """Its own random name, not a numbered one: these end up in URLs, and a
    predictable name is a name somebody else can guess."""
    return secrets.token_hex(16) + ".jpg"


def _signature_of(conn: sqlite3.Connection, name: str) -> Optional[Tuple[int, bytes]]:
    """One photograph's signature, from the cache or computed and cached."""
    row = conn.execute(
        "SELECT dhash, thumb FROM view_signature WHERE view_name = ?", (name,)
    ).fetchone()
    if row is not None:
        return int.from_bytes(bytes(row["dhash"]), "big"), bytes(row["thumb"])
    blob = conn.execute("SELECT jpeg FROM view WHERE name = ?", (name,)).fetchone()
    if blob is None:
        return None
    made = object_dupes.signature(bytes(blob[0]))
    if made is None:
        # A stored photograph cv2 cannot decode. Not cached (there is nothing
        # to cache) and not an error: it simply never matches anything, which
        # is the safe direction -- it can never cause a new photo to be
        # dropped.
        return None
    conn.execute(
        "INSERT OR REPLACE INTO view_signature (view_name, dhash, thumb) VALUES (?, ?, ?)",
        (name, sqlite3.Binary(made[0].to_bytes(8, "big")), sqlite3.Binary(made[1])),
    )
    return made


def _comparison_set(conn: sqlite3.Connection,
                    object_id: str) -> List[Tuple[str, int, bytes]]:
    """What a new photograph of this object is checked against.

    Generated variants are left out. Measured, not assumed: four of the five
    transforms in object_augment.py come back within 8 bits and 0.99
    correlation of their source, because a difference hash reads the SIGN of
    each neighbour difference and brightness barely changes that. A variant is
    therefore a near-copy of a photograph that is already in this set, so
    including them would only cost comparisons.
    """
    rows = conn.execute(
        "SELECT name FROM view WHERE object_id = ?"
        " AND NOT EXISTS (SELECT 1 FROM view_origin o WHERE o.view_name = view.name)"
        " ORDER BY created", (object_id,),
    ).fetchall()
    out: List[Tuple[str, int, bytes]] = []
    for row in rows:
        made = _signature_of(conn, row["name"])
        if made is not None:
            out.append((row["name"], made[0], made[1]))
    return out


def _insert_view(conn: sqlite3.Connection, object_id: str, jpeg: bytes,
                 box: Optional[Dict[str, int]], created_by: str, now: int) -> str:
    name = _new_view_name()
    conn.execute(
        "INSERT INTO view (name, object_id, jpeg, box_x, box_y, box_w, box_h,"
        " created, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (name, object_id, sqlite3.Binary(jpeg),
         None if not box else box.get("x"), None if not box else box.get("y"),
         None if not box else box.get("w"), None if not box else box.get("h"),
         now, created_by),
    )
    return name


def add_views(object_id: str, jpegs: Sequence[bytes], created_by: str = "",
              skip_duplicates: bool = True) -> Optional[Dict[str, Any]]:
    """Several photographs at once, dropping the ones already stored.

    Returns {"names", "duplicates", "unreadable"}, or None if there is no such
    object. One transaction for the batch, so a burst of ten either lands or
    does not.

    Each candidate is checked against what is already stored AND against the
    ones accepted earlier in this same batch -- a burst arrives as one request,
    so checking only against the database would store all ten of it.

    `skip_duplicates` is a parameter rather than always-on so the one caller
    that must not be filtered -- generated variants, which are near-copies of
    their own source by construction -- has a way to say so.

    There is still no cap and nothing is evicted by age. An earlier version
    dropped the OLDEST view past a limit, which could silently drop a boxed
    reference the live detector depended on. What a photograph can be dropped
    for now is being a copy of one already here -- never for being old, and
    never when it is one of the four kinds prune_duplicates protects.
    """
    with _write() as conn:
        if conn.execute("SELECT 1 FROM object WHERE id = ?", (object_id,)).fetchone() is None:
            return None
        now = int(time.time())
        stored = _comparison_set(conn, object_id) if skip_duplicates else []
        names: List[str] = []
        duplicates = 0
        unreadable = 0
        for jpeg in jpegs:
            made = object_dupes.signature(jpeg) if skip_duplicates else None
            if skip_duplicates:
                if made is None:
                    unreadable += 1
                    continue
                if object_dupes.first_match(made, stored) is not None:
                    duplicates += 1
                    continue
            name = _insert_view(conn, object_id, jpeg, None, created_by, now)
            names.append(name)
            if made is not None:
                conn.execute(
                    "INSERT INTO view_signature (view_name, dhash, thumb) VALUES (?, ?, ?)",
                    (name, sqlite3.Binary(made[0].to_bytes(8, "big")),
                     sqlite3.Binary(made[1])),
                )
                stored.append((name, made[0], made[1]))
        if names:
            conn.execute(
                "UPDATE object SET updated = ?, updated_by = ? WHERE id = ?",
                (now, created_by, object_id),
            )
    return {"names": names, "duplicates": duplicates, "unreadable": unreadable}


def add_variants(object_id: str, source_view: str,
                 made: Sequence[Tuple[str, bytes]],
                 created_by: str = "") -> List[str]:
    """Generated photographs, each carrying its source's box unchanged.

    No duplicate check, deliberately: a variant IS a near-copy of its source,
    which is the point of it (see _comparison_set). The box is copied because
    every transform in object_augment.py leaves each pixel where it was; the
    day one of them moves pixels, this copy becomes wrong and the box has to be
    transformed with the image.
    """
    with _write() as conn:
        source = conn.execute(
            "SELECT box_x, box_y, box_w, box_h FROM view"
            " WHERE name = ? AND object_id = ?", (source_view, object_id),
        ).fetchone()
        if source is None:
            return []
        box = (None if source["box_x"] is None
               else {"x": source["box_x"], "y": source["box_y"],
                     "w": source["box_w"], "h": source["box_h"]})
        now = int(time.time())
        names = []
        for kind, jpeg in made:
            name = _insert_view(conn, object_id, jpeg, box, created_by, now)
            conn.execute(
                "INSERT INTO view_origin (view_name, source_view, kind, created)"
                " VALUES (?, ?, ?, ?)", (name, source_view, kind, now),
            )
            names.append(name)
        if names:
            conn.execute(
                "UPDATE object SET updated = ?, updated_by = ? WHERE id = ?",
                (now, created_by, object_id),
            )
        return names



def prune_duplicates(object_id: str) -> List[str]:
    """Deletes photographs that are near-copies of another one already here.

    The gate in add_views stops duplicates ARRIVING; this takes out the ones
    gathered before that gate existed, so a classifier full of one burst does
    not stay that way. It runs by itself after photographs are added, and
    nothing is asked.

    Four kinds of photograph are never deleted here, and the reason is rule 4
    rather than caution: deleting one of them changes or disables what the live
    detector does.

        a photo with a box          it is, or can become, a reference
        a pinned reference          the active measurement was made against it
        a template pick            somebody chose it by hand
        a generated variant        it is a near-copy BY DESIGN (see add_variants)

    A protected photo can still be the one a cluster keeps: they are considered
    first, so when a plain photo and a boxed one are near-copies, the plain one
    goes. Otherwise the oldest of the cluster is kept, so "which photos are
    references" does not reshuffle (the same reasoning as _gather_measurement_
    inputs' "oldest first").

    Returns the names deleted.
    """
    with _write() as conn:
        rows = conn.execute(
            "SELECT v.name, v.created, v.box_x IS NOT NULL AS boxed,"
            " EXISTS (SELECT 1 FROM view_origin o WHERE o.view_name = v.name) AS generated,"
            " EXISTS (SELECT 1 FROM measurement_reference r"
            "         WHERE r.object_id = v.object_id AND r.view_name = v.name) AS pinned,"
            " EXISTS (SELECT 1 FROM template_pick t WHERE t.view_name = v.name) AS picked"
            " FROM view v WHERE v.object_id = ?", (object_id,),
        ).fetchall()
        protected = {
            row["name"] for row in rows
            if row["boxed"] or row["generated"] or row["pinned"] or row["picked"]
        }
        # Protected first, then oldest first. Generated variants are left out
        # of the comparison altogether: each is a near-copy of its own source,
        # so letting one into a cluster would make it swallow real photographs.
        order = sorted(
            (row for row in rows if not row["generated"]),
            key=lambda row: (row["name"] not in protected, row["created"], row["name"]),
        )
        kept: List[Tuple[str, int, bytes]] = []
        doomed: List[str] = []
        for row in order:
            made = _signature_of(conn, row["name"])
            if made is None:
                continue
            if object_dupes.first_match(made, kept) is None:
                kept.append((row["name"], made[0], made[1]))
            elif row["name"] in protected:
                # A near-copy of something kept, but not ours to delete. It
                # stays, and it joins the kept set so it does not then let a
                # third copy of itself in.
                kept.append((row["name"], made[0], made[1]))
            else:
                doomed.append(row["name"])
        for name in doomed:
            conn.execute("DELETE FROM view WHERE name = ?", (name,))
        if doomed:
            conn.execute("UPDATE object SET updated = ? WHERE id = ?",
                         (int(time.time()), object_id))
        return doomed


def generated_kinds(object_id: str) -> Dict[str, str]:
    """{view name: which transform made it} for this object's generated
    photographs."""
    with _lock:
        rows = _db().execute(
            "SELECT o.view_name, o.kind FROM view_origin o"
            " JOIN view v ON v.name = o.view_name WHERE v.object_id = ?", (object_id,),
        ).fetchall()
    return {row["view_name"]: row["kind"] for row in rows}


def generated_sources(object_id: str) -> Dict[str, str]:
    """{generated view name: the photograph it was made from}.

    Separate from generated_kinds because the two answer different questions
    and only one of them is wanted per call: the page asks what a variant IS,
    the measurement asks what it came FROM (so a photograph is not tested
    against a brightened copy of itself).
    """
    with _lock:
        rows = _db().execute(
            "SELECT o.view_name, o.source_view FROM view_origin o"
            " JOIN view v ON v.name = o.view_name WHERE v.object_id = ?", (object_id,),
        ).fetchall()
    return {row["view_name"]: row["source_view"] for row in rows}


def delete_generated(object_id: str) -> int:
    """Every generated photograph of this object, in one go. Returns how many.

    The originals are untouched: only rows with a view_origin entry go.
    """
    with _write() as conn:
        return conn.execute(
            "DELETE FROM view WHERE object_id = ? AND name IN"
            " (SELECT view_name FROM view_origin)", (object_id,),
        ).rowcount


def augment_source_views(object_id: str) -> List[str]:
    """The boxed, non-generated photographs variants can be made FROM.

    Boxed because a variant without a box is just more weight for every
    measurement to carry, and non-generated because a variant of a variant
    compounds the same transform twice.
    """
    with _lock:
        rows = _db().execute(
            "SELECT name FROM view WHERE object_id = ? AND box_x IS NOT NULL"
            " AND NOT EXISTS (SELECT 1 FROM view_origin o WHERE o.view_name = view.name)"
            " ORDER BY created", (object_id,),
        ).fetchall()
    return [row["name"] for row in rows]


def set_view_box(view_name: str, box: Dict[str, int], updated_by: str = "") -> bool:
    """Where the object is in one stored photograph."""
    with _write() as conn:
        row = conn.execute(
            "SELECT object_id FROM view WHERE name = ?", (view_name,)
        ).fetchone()
        if row is None:
            return False
        conn.execute(
            "UPDATE view SET box_x = ?, box_y = ?, box_w = ?, box_h = ? WHERE name = ?",
            (box["x"], box["y"], box["w"], box["h"], view_name),
        )
        conn.execute(
            "UPDATE object SET updated = ?, updated_by = ? WHERE id = ?",
            (int(time.time()), updated_by, row["object_id"]),
        )
        return True


def delete_view(view_name: str) -> bool:
    """One photograph, and with it everything recorded about that photograph.

    There is nothing else to remember to delete: the box lives on this row, so
    the picture and what was known about it cannot come apart.
    """
    with _write() as conn:
        return conn.execute("DELETE FROM view WHERE name = ?", (view_name,)).rowcount > 0


_VIEW_NAME_OK = re.compile(r"^[0-9a-f]{32}\.jpg$")


def view_bytes(view_name: str) -> Optional[bytes]:
    """One photograph, or None.

    The name arrives in a URL, so it is matched against the pattern we generate
    rather than joined onto anything.
    """
    if not _VIEW_NAME_OK.match(view_name or ""):
        return None
    with _lock:
        row = _db().execute("SELECT jpeg FROM view WHERE name = ?", (view_name,)).fetchone()
    return bytes(row[0]) if row else None


def view_owner(view_name: str) -> Optional[str]:
    """Who contributed one photograph, or None if there is no such photograph.

    Exists so a caller can decide "may THIS person delete THIS photo" without
    pulling the photograph itself off disk just to answer that.
    """
    if not _VIEW_NAME_OK.match(view_name or ""):
        return None
    with _lock:
        row = _db().execute(
            "SELECT created_by FROM view WHERE name = ?", (view_name,)
        ).fetchone()
    return row["created_by"] if row else None


def count_objects() -> int:
    with _lock:
        return _db().execute("SELECT COUNT(*) FROM object").fetchone()[0]
