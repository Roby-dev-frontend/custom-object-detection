"""User accounts: password hashing, roles, and the users.db SQLite store.

Passwords are never stored, not even encrypted. For each user we keep a random
`salt` and the result of running the password through scrypt. Logging in repeats
that calculation on the password typed and compares the two results.

scrypt is used because it is deliberately slow and memory-hungry: that is what
limits how many passwords an attacker can try per second. Its parameters are
unchanged from the users.json version, and the migration copied every salt and
hash across byte for byte -- nobody's password changed.

Why a database replaced users.json
----------------------------------
The old store was one document rewritten whole on every change, with no lock
and no fsync: two concurrent writes lost one of them, and a power cut during
os.replace could leave nothing. Here a change is one transaction with
synchronous=FULL behind it.

The real reason, though, is `token_version`. Sessions are stateless signed
cookies, so the only way to end one early is to make the server refuse it, and
the only way to do that cheaply is a number the cookie carries and the row can
disagree with. Without it a demotion would not take effect for seven days and
roles would be decorative. Every act that should end a session -- a role
change, a rename, a password change, "disconnetti ovunque" -- bumps it, and the
next request carrying an older number is refused.

The counter is global, not per user: delete "mario" and recreate "mario", and a
version that restarted at 1 would make his week-old cookie valid again.

One deliberate difference from faces.py's pattern: the store lock is NEVER held
across scrypt. Hashing is ~100 ms and 16 MB by design, and holding a lock
across it would serialise every other authenticated request in the process,
including the video WebSocket handshake. So: read the row under the lock, hash
outside it.
"""

import contextlib
import hashlib
import hmac
import os
import secrets
import threading
import time
from typing import Any, Dict, Iterator, List, Optional

# Plain stdlib SQLite: no database passphrase. Whoever can reach this server
# can read the store, so keep it on a trusted LAN.
import sqlite3

_HERE = os.path.dirname(os.path.abspath(__file__))
USERS_DB = os.path.join(_HERE, "users.db")

# scrypt cost settings. n is the main work factor; raising it makes both login
# and password guessing proportionally slower. These are the values recommended
# for interactive logins: roughly 100 ms and 16 MB of memory per attempt.
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SALT_BYTES = 16

MIN_PASSWORD_LENGTH = 5

# The two roles. An administrator may open /admin/ and manage accounts; an
# operatore uses the app exactly as before. The words are Italian because they
# are shown in the interface, and they are defined here so the database CHECK,
# the API and the page cannot drift apart.
ADMIN = "amministratore"
OPERATOR = "operatore"
ROLES = (ADMIN, OPERATOR)

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS user (
    username      TEXT    PRIMARY KEY,
    role          TEXT    NOT NULL DEFAULT '{OPERATOR}'
                          CHECK (role IN ('{ADMIN}', '{OPERATOR}')),
    -- 16 bytes of salt as hex, and a 64-byte scrypt digest as hex.
    salt          TEXT    NOT NULL CHECK (length(salt) = 32),
    hash          TEXT    NOT NULL CHECK (length(hash) = 128),
    -- Bumped on every role change, rename, password change and
    -- "disconnetti ovunque". A cookie carrying an older number stops
    -- validating on the very next request.
    token_version INTEGER NOT NULL,
    created       INTEGER NOT NULL,
    updated       INTEGER NOT NULL,
    updated_by    TEXT    NOT NULL DEFAULT '',
    last_login    INTEGER
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
-- A monotone counter handed out to token_version, never a per-user 1.
INSERT OR IGNORE INTO meta (key, value) VALUES ('token_seq', '1');
"""

# Reentrant for the same reason as faces.py: a write helper may call a read
# helper while still holding the lock, so that nobody sees a half-applied change.
_lock = threading.RLock()


def _hash_password(password: str, salt: bytes) -> str:
    return hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P
    ).hex()


def connect(path: str = USERS_DB, create: bool = False,
            passphrase: Optional[str] = None) -> sqlite3.Connection:
    """Opens the encrypted store.

    `create` is False by default for the same reason as in faces.py: SQLCipher
    will happily make a new empty encrypted database out of a missing file and
    any passphrase at all, and the result -- a server reporting "no accounts
    exist yet" -- is indistinguishable from every account having been deleted.
    """
    if not create and not os.path.exists(path):
        raise FileNotFoundError(
            f"{path} does not exist. Refusing to create an empty encrypted store: "
            "that would look exactly like every account having been deleted. "
            "If this really is a first run, pass create=True."
        )
    conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=10.0)
    conn.execute("PRAGMA journal_mode=WAL")
    # Credentials on a machine that can lose power. The old os.replace did not
    # fsync at all, so this is strictly more durable.
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute("PRAGMA busy_timeout=10000")
    # stdlib's Row.
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


_conn: Optional[sqlite3.Connection] = None


def _db() -> sqlite3.Connection:
    """The connection, opened on first use rather than at import.

    Importing this module must not create a file: the migration script imports
    it for SCHEMA and then replaces users.db, and an open WAL connection held
    across that replace leaves the new database reading as empty.
    """
    global _conn
    with _lock:
        if _conn is None:
            _conn = connect()
        return _conn


@contextlib.contextmanager
def _write() -> Iterator[sqlite3.Connection]:
    """One transaction. BEGIN IMMEDIATE takes the write lock at the start, so a
    conflict is a wait here instead of a failure half way through."""
    with _lock:
        conn = _db()
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")


def _next_token(conn: sqlite3.Connection) -> int:
    """The next session-token number. Must be called inside a transaction."""
    conn.execute(
        "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)"
        " WHERE key = 'token_seq'"
    )
    return int(conn.execute("SELECT value FROM meta WHERE key = 'token_seq'").fetchone()[0])


def _count_admins(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM user WHERE role = ?", (ADMIN,)).fetchone()[0]


def _require(conn: sqlite3.Connection, username: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM user WHERE username = ?", (username,)).fetchone()
    if row is None:
        raise LookupError(f"User {username!r} does not exist")
    return row


# --- Reading -----------------------------------------------------------


def auth(username: str) -> Optional[Dict[str, Any]]:
    """The role and token version of an account, or None if there is no such
    account.

    This is the single lookup every authenticated request makes. It replaces
    the two full re-reads of users.json that used to happen -- one in
    _read_session_cookie for user_exists, another in require_admin for is_admin
    -- with one indexed hit on a primary key, on a connection already open.
    """
    with _lock:
        row = _db().execute(
            "SELECT role, token_version FROM user WHERE username = ?", (username,)
        ).fetchone()
    if row is None:
        return None
    return {"username": username, "role": row["role"], "token_version": row["token_version"],
            "is_admin": row["role"] == ADMIN}


def user_exists(username: str) -> bool:
    return auth(username) is not None


def is_admin(username: str) -> bool:
    record = auth(username)
    return bool(record and record["is_admin"])


def count_users() -> int:
    with _lock:
        return _db().execute("SELECT COUNT(*) FROM user").fetchone()[0]


def count_admins() -> int:
    with _lock:
        return _count_admins(_db())


def _public(row: sqlite3.Row) -> Dict[str, Any]:
    """One account WITHOUT salt or hash, so this can safely be sent to the
    browser."""
    return {
        "username": row["username"],
        "role": row["role"],
        # Kept alongside `role` so App.jsx, which reads is_admin in three
        # places, keeps working untouched.
        "is_admin": row["role"] == ADMIN,
        "created": row["created"],
        "updated": row["updated"],
        "updated_by": row["updated_by"],
        "last_login": row["last_login"],
    }


def list_users() -> List[Dict[str, Any]]:
    with _lock:
        rows = _db().execute("SELECT * FROM user ORDER BY username").fetchall()
    return [_public(row) for row in rows]


def get_user(username: str) -> Optional[Dict[str, Any]]:
    with _lock:
        row = _db().execute("SELECT * FROM user WHERE username = ?", (username,)).fetchone()
    return _public(row) if row else None


# --- Writing -----------------------------------------------------------
#
# Every guard rail lives in here, inside the same transaction as the write --
# not in the endpoint that calls it. Put in the endpoint, the command line
# would bypass it, and two concurrent demotions would both pass their
# pre-check and leave nobody able to administer anything.


def create_user(username: str, password: str, admin: bool = False,
                role: Optional[str] = None, by: str = "") -> None:
    """Raises ValueError when the name is taken or the password is too short."""
    username = username.strip()
    if not username:
        raise ValueError("Username cannot be empty")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    if role is None:
        role = ADMIN if admin else OPERATOR
    if role not in ROLES:
        raise ValueError(f"Unknown role {role!r}")

    # Hashed before the transaction opens, deliberately: see the module note.
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = _hash_password(password, salt)
    now = int(time.time())

    with _write() as conn:
        if conn.execute("SELECT 1 FROM user WHERE username = ?", (username,)).fetchone():
            raise ValueError(f"User {username!r} already exists")
        conn.execute(
            "INSERT INTO user (username, role, salt, hash, token_version,"
            " created, updated, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (username, role, salt.hex(), digest, _next_token(conn), now, now, by),
        )


def delete_user(username: str, by: str = "") -> None:
    """Raises LookupError when the user does not exist, ValueError when
    removing them would leave nobody able to manage users."""
    with _write() as conn:
        row = _require(conn, username)
        if row["role"] == ADMIN and _count_admins(conn) <= 1:
            raise ValueError("Cannot delete the last administrator")
        conn.execute("DELETE FROM user WHERE username = ?", (username,))


def set_password(username: str, new_password: str) -> int:
    """Your own password. Returns the new token_version, which the caller must
    put in a freshly-issued cookie -- otherwise the user changing their own
    password logs themselves out of the tab they are standing in."""
    if len(new_password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = _hash_password(new_password, salt)
    with _write() as conn:
        _require(conn, username)
        token = _next_token(conn)
        conn.execute(
            "UPDATE user SET salt = ?, hash = ?, token_version = ?, updated = ?,"
            " updated_by = ? WHERE username = ?",
            (salt.hex(), digest, token, int(time.time()), username, username),
        )
    return token


def set_password_as_admin(username: str, new_password: str, actor: str) -> None:
    """An administrator resetting SOMEONE ELSE's password.

    Refused on yourself: this path does not re-issue a cookie, so it would log
    the administrator out of the panel they are standing in, which reads as a
    crash. Your own password goes through set_password.
    """
    if username == actor:
        raise ValueError("Use the 'my password' form to change your own password")
    if len(new_password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = _hash_password(new_password, salt)
    with _write() as conn:
        _require(conn, username)
        conn.execute(
            "UPDATE user SET salt = ?, hash = ?, token_version = ?, updated = ?,"
            " updated_by = ? WHERE username = ?",
            (salt.hex(), digest, _next_token(conn), int(time.time()), actor, username),
        )


def set_role(username: str, role: str, actor: str = "") -> None:
    """Promote or demote. Refused on yourself, and refused when it would leave
    no administrator at all."""
    if role not in ROLES:
        raise ValueError(f"Unknown role {role!r}")
    if username == actor:
        raise ValueError("Cannot change your own role")
    with _write() as conn:
        row = _require(conn, username)
        if row["role"] == role:
            # Saving nothing must not log anybody out.
            return
        if row["role"] == ADMIN and _count_admins(conn) <= 1:
            raise ValueError("Cannot demote the last administrator")
        conn.execute(
            "UPDATE user SET role = ?, token_version = ?, updated = ?, updated_by = ?"
            " WHERE username = ?",
            (role, _next_token(conn), int(time.time()), actor, username),
        )


def rename_user(username: str, new_username: str, actor: str = "") -> int:
    """Moves the primary key. Returns the new token_version.

    The username is what the session cookie carries, so after this the old name
    no longer resolves and that account's cookies die on their own. Renaming
    YOURSELF therefore needs a freshly-issued cookie in the same response.

    History in faces.db is left alone on purpose: created_by / updated_by are
    plain text recording who did something at the time, not foreign keys, and
    rewriting them would falsify the record.
    """
    new_username = new_username.strip()
    if not new_username:
        raise ValueError("Username cannot be empty")
    with _write() as conn:
        row = _require(conn, username)
        if new_username == username:
            # Saving the name it already had must not log anybody out.
            return row["token_version"]
        if conn.execute(
            "SELECT 1 FROM user WHERE username = ?", (new_username,)
        ).fetchone():
            raise ValueError(f"User {new_username!r} already exists")
        token = _next_token(conn)
        conn.execute(
            "UPDATE user SET username = ?, token_version = ?, updated = ?, updated_by = ?"
            " WHERE username = ?",
            (new_username, token, int(time.time()), actor, username),
        )
    return token


def logout_everywhere(username: str, actor: str = "") -> int:
    """Ends every session of this account. Returns the new token_version, so a
    caller doing it to THEMSELVES can re-issue their own cookie and keep the
    tab they are standing in."""
    with _write() as conn:
        _require(conn, username)
        token = _next_token(conn)
        conn.execute(
            "UPDATE user SET token_version = ?, updated = ?, updated_by = ?"
            " WHERE username = ?",
            (token, int(time.time()), actor or username, username),
        )
    return token


def touch_login(username: str) -> None:
    """Records a successful login. Not a guard rail -- it is what makes the
    admin page able to say when an account was last used."""
    with _write() as conn:
        conn.execute(
            "UPDATE user SET last_login = ? WHERE username = ?",
            (int(time.time()), username),
        )


def verify_password(username: str, password: str) -> bool:
    """True when the password matches. Takes roughly the same time whether the
    user exists or not, so an attacker cannot learn which usernames are real by
    measuring how fast the answer comes back."""
    with _lock:
        row = _db().execute(
            "SELECT salt, hash FROM user WHERE username = ?", (username,)
        ).fetchone()

    # Outside the lock from here on: scrypt is ~100 ms, and holding the store
    # lock across it would serialise every other request in the process.
    if row is None:
        # No such user. Hash anyway against a throwaway salt so this path costs
        # the same as a real check, then fail.
        _hash_password(password, secrets.token_bytes(_SALT_BYTES))
        return False

    candidate = _hash_password(password, bytes.fromhex(row["salt"]))
    # compare_digest always looks at every character. A plain == returns as soon
    # as two characters differ, and that timing difference can be measured to
    # work out the correct value one character at a time.
    return hmac.compare_digest(candidate, row["hash"])
