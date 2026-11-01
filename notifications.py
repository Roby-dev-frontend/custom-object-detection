"""Things an administrator should know about, until one of them dismisses it.

A separate encrypted store, same reasoning as detections.py and objects.py:
this is written to by ordinary, non-admin actions (creating a classifier,
say), so it cannot share a file with anything an administrator alone should
be able to touch.

Deliberately NOT everything the admin page shows -- a classifier with more
photos than it should have is a live CONDITION, computed fresh from objects.py
every time, and stops needing attention on its own the moment somebody
deletes a few photos. What lives here is the opposite kind: a one-time EVENT
("this was created") that nothing will ever un-happen, so it has to be
dismissed by a person rather than resolve itself.

Dismissal is shared, not per-admin: once any administrator has seen and
dismissed a notification, it is gone for all of them. A home with one or two
administrators has little use for each tracking their own read state, and a
shared flag is one column instead of a whole join table.
"""

import contextlib
import os
import secrets
import threading
import time
from typing import Any, Dict, Iterator, List, Optional

import sqlite3

_HERE = os.path.dirname(os.path.abspath(__file__))
NOTIFICATIONS_DB = os.path.join(_HERE, "notifications.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS notification (
    id           TEXT    PRIMARY KEY,
    created      INTEGER NOT NULL,
    -- A short machine tag ("classifier_created", ...), not shown to anybody:
    -- it exists so a future caller could filter by kind without parsing
    -- `message`, which is already-formatted Italian text for the bell.
    kind         TEXT    NOT NULL,
    message      TEXT    NOT NULL,
    created_by   TEXT    NOT NULL DEFAULT '',
    dismissed_at INTEGER,
    dismissed_by TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS notification_active ON notification(dismissed_at, created);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
"""

_lock = threading.RLock()


def connect(path: str = NOTIFICATIONS_DB, create: bool = False,
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
    return conn


_conn: Optional[sqlite3.Connection] = None


def _db() -> sqlite3.Connection:
    """Opened on first use, not at import, so importing this module never
    creates a file."""
    global _conn
    with _lock:
        if _conn is None:
            _conn = connect(NOTIFICATIONS_DB, create=True)
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
    return {
        "id": row["id"],
        "created": row["created"],
        "kind": row["kind"],
        "message": row["message"],
        "created_by": row["created_by"],
    }


def add(kind: str, message: str, created_by: str = "") -> Dict[str, Any]:
    """Raises a new notification. Called from ordinary, non-admin actions
    (creating a classifier, say) -- never gated on require_admin itself,
    since the person DOING the thing is not the one who needs telling."""
    notification_id = secrets.token_hex(16)
    with _write() as conn:
        conn.execute(
            "INSERT INTO notification (id, created, kind, message, created_by)"
            " VALUES (?, ?, ?, ?, ?)",
            (notification_id, int(time.time()), kind, message, created_by),
        )
    return {"id": notification_id, "kind": kind, "message": message}


def list_active() -> List[Dict[str, Any]]:
    """Every notification nobody has dismissed yet, newest first."""
    with _lock:
        rows = _db().execute(
            "SELECT * FROM notification WHERE dismissed_at IS NULL ORDER BY created DESC"
        ).fetchall()
    return [_public(row) for row in rows]


def dismiss_all(dismissed_by: str = "") -> int:
    """Dismisses every active notification at once, returning how many went.

    Shared, like dismiss() above: this is final for every administrator. One
    UPDATE rather than a loop of them, so a notification arriving mid-sweep is
    either wholly included or wholly left for next time -- never half-dismissed
    with the count disagreeing.
    """
    with _write() as conn:
        cursor = conn.execute(
            "UPDATE notification SET dismissed_at = ?, dismissed_by = ?"
            " WHERE dismissed_at IS NULL",
            (int(time.time()), dismissed_by),
        )
        return cursor.rowcount


def dismiss(notification_id: str, dismissed_by: str = "") -> bool:
    """True if it existed and was still active. Shared dismissal (see the
    module docstring): this is final for every administrator, not just the
    one who clicked it."""
    with _write() as conn:
        cursor = conn.execute(
            "UPDATE notification SET dismissed_at = ?, dismissed_by = ?"
            " WHERE id = ? AND dismissed_at IS NULL",
            (int(time.time()), dismissed_by, notification_id),
        )
        return cursor.rowcount > 0
