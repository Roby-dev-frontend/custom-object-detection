"""What the server found in the frames an own-camera device sent it.

An own-camera device (a phone, or a PC showing its own webcam) runs no
detection library any more: it sends frames over /detect_ws, the server
detects, and when something is found a few pictures of it are kept here. Every
page shows them in the strip in the corner of the video.

A separate encrypted store, opened with the same passphrase as faces.db, for
the reason objects.py gives: people are the one dataset here that cannot be
regenerated, and nothing written in bulk by a camera should share a file with
them.

Nothing is removed automatically. Somebody deletes an entry with its ✕, and
the page warns everybody once there are more than 100.
"""

import contextlib
import json
import os
import secrets
import threading
import time
from typing import Any, Dict, Iterator, List, Optional

import sqlite3

_HERE = os.path.dirname(os.path.abspath(__file__))
DETECTIONS_DB = os.path.join(_HERE, "detections.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS entry (
    id        TEXT    PRIMARY KEY,
    created   INTEGER NOT NULL,           -- milliseconds since the epoch
    kind      TEXT    NOT NULL,           -- 'face', 'hand', 'object' or 'text'
    label     TEXT    NOT NULL DEFAULT '',
    -- Set for a face the server recognised; NULL for an unknown one and for
    -- hands and objects. Not a foreign key: faces.db is another file.
    person_id TEXT,
    device    TEXT    NOT NULL DEFAULT '',
    origin    TEXT,
    -- Which batch of three it came from, so the pictures of one moment can be
    -- told apart from the next one.
    batch     TEXT    NOT NULL DEFAULT '',
    jpeg      BLOB    NOT NULL,
    boxes     TEXT    NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS entry_created ON entry(created);

-- Where the device was when it took the picture, when it knew. A table of its
-- own so an existing store only GAINS a table; removed with its entry.
CREATE TABLE IF NOT EXISTS entry_place (
    id        TEXT    PRIMARY KEY,
    lat       REAL    NOT NULL,
    lon       REAL    NOT NULL,
    accuracy  REAL
);

-- What was READ, for an entry of kind 'text'. Beside the entry rather than in
-- its label or its boxes: the label is a caption cut to a few words and the
-- boxes are geometry, while this is the thing somebody saved the entry FOR and
-- has to come back whole. Like entry_place it has no foreign key, so
-- delete_entry and delete_before remove it by hand.
CREATE TABLE IF NOT EXISTS entry_text (
    id    TEXT PRIMARY KEY,
    text  TEXT NOT NULL,
    mode  TEXT NOT NULL DEFAULT 'text'
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
"""

_lock = threading.RLock()

# Bumped on every change. The count and the newest id say nothing about a
# picture that was relabelled or an older one deleted, and a page must still
# learn from its heartbeat that its strip is out of date.
_version = 0


def _changed() -> None:
    global _version
    with _lock:
        _version += 1


def connect(path: str = DETECTIONS_DB, create: bool = False,
            passphrase: Optional[str] = None) -> sqlite3.Connection:
    """Opens the store. `create` is False by default: a missing file must not
    silently become an empty store."""
    if not create and not os.path.exists(path):
        raise FileNotFoundError(
            f"{path} does not exist. Refusing to create an empty encrypted store. "
            "If this really is a first run, pass create=True."
        )
    conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=10.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute("PRAGMA busy_timeout=10000")
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(entry)")}
    if "origin" not in columns:
        conn.execute("ALTER TABLE entry ADD COLUMN origin TEXT")
    return conn


_conn: Optional[sqlite3.Connection] = None


def _db() -> sqlite3.Connection:
    """Opened on first use, not at import. server_fastapi.py has already
    created the file at startup (see _STORES), so this only ever opens it."""
    global _conn
    with _lock:
        if _conn is None:
            _conn = connect(DETECTIONS_DB)
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


def _public(row: sqlite3.Row) -> Dict[str, Any]:
    """Everything but the picture, which is fetched on its own by id."""
    keys = row.keys()
    position = (
        {"lat": row["lat"], "lon": row["lon"], "accuracy": row["accuracy"]}
        if "lat" in keys and row["lat"] is not None
        else None
    )
    return {
        "id": row["id"],
        "created": row["created"],
        "kind": row["kind"],
        "label": row["label"],
        "person_id": row["person_id"],
        "device": row["device"],
        "origin": row["origin"] if "origin" in keys else None,
        "batch": row["batch"],
        "boxes": json.loads(row["boxes"] or "[]"),
        "position": position,
        # None for everything that is not a text entry.
        "text": row["text"] if "text" in keys else None,
    }


_SELECT = (
    "SELECT e.id, e.created, e.kind, e.label, e.person_id, e.device, e.origin, e.batch, e.boxes,"
    " p.lat, p.lon, p.accuracy, t.text FROM entry e"
    " LEFT JOIN entry_place p ON p.id = e.id"
    " LEFT JOIN entry_text t ON t.id = e.id"
)


def add_entry(kind: str, label: str, jpeg: bytes, boxes: List[Any],
              device: str = "", person_id: Optional[str] = None,
              batch: str = "", position: Optional[Dict[str, Any]] = None,
              origin: Optional[str] = None) -> Dict[str, Any]:
    entry_id = secrets.token_hex(16)
    with _write() as conn:
        conn.execute(
            "INSERT INTO entry (id, created, kind, label, person_id, device, origin, batch, jpeg, boxes)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (entry_id, int(time.time() * 1000), kind, label, person_id, device,
             origin, batch, jpeg, json.dumps(boxes)),
        )
        if position:
            conn.execute(
                "INSERT INTO entry_place (id, lat, lon, accuracy) VALUES (?, ?, ?, ?)",
                (entry_id, position["lat"], position["lon"], position.get("accuracy")),
            )
        row = conn.execute(_SELECT + " WHERE e.id = ?", (entry_id,)).fetchone()
    _changed()
    return _public(row)


def add_text_entry(text: str, mode: str, label: str, jpeg: bytes, boxes: List[Any],
                   device: str = "",
                   position: Optional[Dict[str, Any]] = None,
                   origin: Optional[str] = None) -> Dict[str, Any]:
    """A picture of some text, where it was taken, and what it said.

    The entry and its text are written in one transaction, so an entry of kind
    'text' can never exist without its text (a caption with nothing behind it)
    nor the other way round.
    """
    entry_id = secrets.token_hex(16)
    with _write() as conn:
        conn.execute(
            "INSERT INTO entry (id, created, kind, label, person_id, device, origin, batch, jpeg, boxes)"
            " VALUES (?, ?, 'text', ?, NULL, ?, ?, '', ?, ?)",
            (entry_id, int(time.time() * 1000), label, device, origin, jpeg,
             json.dumps(boxes)),
        )
        conn.execute("INSERT INTO entry_text (id, text, mode) VALUES (?, ?, ?)",
                     (entry_id, text, mode))
        if position:
            conn.execute(
                "INSERT INTO entry_place (id, lat, lon, accuracy) VALUES (?, ?, ?, ?)",
                (entry_id, position["lat"], position["lon"], position.get("accuracy")),
            )
        row = conn.execute(_SELECT + " WHERE e.id = ?", (entry_id,)).fetchone()
    _changed()
    return _public(row)


def list_entries() -> List[Dict[str, Any]]:
    """Newest first."""
    with _lock:
        rows = _db().execute(_SELECT + " ORDER BY e.created DESC, e.id").fetchall()
    return [_public(row) for row in rows]


def entry_jpeg(entry_id: str) -> Optional[bytes]:
    with _lock:
        row = _db().execute("SELECT jpeg FROM entry WHERE id = ?", (entry_id,)).fetchone()
    return bytes(row["jpeg"]) if row else None


def update_text(entry_id: str, text: str) -> Optional[Dict[str, Any]]:
    """Replaces the words of a saved text ("correct what was misread"), and the
    caption with them: the first line, cut like add_text_entry's callers cut it.
    None when there is no text entry with this id."""
    first = text.split("\n", 1)[0]
    label = first if len(first) <= 40 else first[:39].rstrip() + "…"
    with _write() as conn:
        changed = conn.execute(
            "UPDATE entry_text SET text = ? WHERE id = ?"
            " AND EXISTS (SELECT 1 FROM entry WHERE id = ? AND kind = 'text')",
            (text, entry_id, entry_id),
        ).rowcount
        if not changed:
            return None
        conn.execute("UPDATE entry SET label = ? WHERE id = ?", (label, entry_id))
        row = conn.execute(_SELECT + " WHERE e.id = ?", (entry_id,)).fetchone()
    _changed()
    return _public(row)


def delete_entry(entry_id: str) -> bool:
    with _write() as conn:
        deleted = conn.execute("DELETE FROM entry WHERE id = ?", (entry_id,)).rowcount > 0
        conn.execute("DELETE FROM entry_place WHERE id = ?", (entry_id,))
        conn.execute("DELETE FROM entry_text WHERE id = ?", (entry_id,))
    if deleted:
        _changed()
    return deleted


def delete_before(created_ms: int) -> int:
    """Deletes every entry created at or before `created_ms` ("Svuota"): the
    ones on screen when it was pressed, not one that arrived during the click.
    Returns how many went."""
    with _write() as conn:
        conn.execute(
            "DELETE FROM entry_place WHERE id IN (SELECT id FROM entry WHERE created <= ?)",
            (created_ms,),
        )
        conn.execute(
            "DELETE FROM entry_text WHERE id IN (SELECT id FROM entry WHERE created <= ?)",
            (created_ms,),
        )
        deleted = conn.execute("DELETE FROM entry WHERE created <= ?", (created_ms,)).rowcount
    if deleted:
        _changed()
    return deleted


def entry_position(entry_id: str) -> Optional[Dict[str, Any]]:
    """Where the device was when it took this picture, or None."""
    with _lock:
        row = _db().execute(
            "SELECT lat, lon, accuracy FROM entry_place WHERE id = ?", (entry_id,)
        ).fetchone()
    return {"lat": row["lat"], "lon": row["lon"], "accuracy": row["accuracy"]} if row else None


def unknown_faces() -> List[str]:
    """Ids of the faces nobody was recognised in, oldest first."""
    with _lock:
        rows = _db().execute(
            "SELECT id FROM entry WHERE kind = 'face' AND person_id IS NULL ORDER BY created"
        ).fetchall()
    return [row["id"] for row in rows]


def update_label(entry_id: str, label: str, person_id: Optional[str]) -> bool:
    """A face recognised after the fact, once somebody has been saved."""
    with _write() as conn:
        updated = conn.execute(
            "UPDATE entry SET label = ?, person_id = ? WHERE id = ?",
            (label, person_id, entry_id),
        ).rowcount > 0
    if updated:
        _changed()
    return updated


def summary() -> Dict[str, Any]:
    """How many there are and which is newest: enough for a page to tell, from
    its heartbeat, whether its strip is out of date."""
    with _lock:
        row = _db().execute(
            "SELECT COUNT(*) AS n, (SELECT id FROM entry ORDER BY created DESC, id LIMIT 1) AS latest"
            " FROM entry"
        ).fetchone()
    return {"count": row["n"], "latest": row["latest"], "version": _version}
