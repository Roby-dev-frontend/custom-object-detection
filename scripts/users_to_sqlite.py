#!/usr/bin/env python3
"""One-time migration: users.json -> users.db.

Run it once, by hand, with the application stopped:

    python3 scripts/users_to_sqlite.py
    python3 scripts/users_to_sqlite.py --verify-only

It is additive. It never writes to, renames or removes users.json -- that stays
as the backup, and deleting it is a decision for whoever owns the accounts, not
for this script.

The database is built as users.db.partial and moved into place only after every
check below has passed, so an interrupted run leaves nothing that could be
mistaken for a good migration.

Nothing about anybody's password changes. The salt and the scrypt digest are
copied across as the same characters they already were, and the script proves
it by logging a throwaway account in and out through the new code path before
it commits to anything.
"""

import argparse
import json
import os
import secrets
import sqlite3
import sys
import time
from typing import Any, Dict, List

_HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _HERE)

USERS_JSON = os.path.join(_HERE, "users.json")
USERS_DB = os.path.join(_HERE, "users.db")
PARTIAL = USERS_DB + ".partial"

import users  # noqa: E402  (after sys.path is pointed at the project root)


def _refuse_if_populated() -> None:
    """Never overwrite a database that already holds accounts.

    "Already migrated" means "has accounts in it", not "the file exists": a
    users.db with nothing in it is just the empty one SQLite creates on a first
    connection, and there is nothing to lose by replacing that.

    An unreadable or non-SQLite database raises DatabaseError here. Swallowing
    it would replace an unknown file with a new users.db built from users.json,
    potentially losing accounts, so it stops loudly.
    """
    if not os.path.exists(USERS_DB):
        return
    try:
        conn = sqlite3.connect(f"file:{USERS_DB}?mode=ro", uri=True)
        total = conn.execute("SELECT COUNT(*) FROM user").fetchone()[0]
        conn.close()
    except sqlite3.DatabaseError:
        sys.exit(
            f"{USERS_DB} exists but is not a readable SQLite database.\n"
            "\n"
            "Refusing to touch it. Running this now would replace an unreadable\n"
            "store with one rebuilt from users.json, potentially losing accounts.\n"
            "Move the file aside yourself if you really mean to start over."
        )
    if total:
        sys.exit(
            f"users.db already holds {total} accounts. Refusing to touch it.\n"
            "Remove it yourself if you really mean to migrate again -- that is "
            "a destructive act and it is yours to take."
        )


def load_json() -> Dict[str, Any]:
    if not os.path.exists(USERS_JSON):
        sys.exit(f"{USERS_JSON} does not exist. Nothing to migrate.")
    with open(USERS_JSON, "r", encoding="utf-8") as handle:
        return json.load(handle)


def build(accounts: Dict[str, Any]) -> Dict[str, int]:
    """Writes PARTIAL from users.json. Returns a report."""
    for side in ("", "-wal", "-shm"):
        if os.path.exists(PARTIAL + side):
            os.remove(PARTIAL + side)

    conn = sqlite3.connect(PARTIAL, isolation_level=None)
    conn.executescript(users.SCHEMA)

    report = {"users": 0, "admins": 0}
    now = int(time.time())
    conn.execute("BEGIN IMMEDIATE")
    # Sorted so the token numbers handed out are reproducible rather than
    # dependent on dict order.
    for index, (username, data) in enumerate(sorted(accounts.items()), start=1):
        role = users.ADMIN if data.get("is_admin") else users.OPERATOR
        created = data.get("created") or now
        conn.execute(
            "INSERT INTO user (username, role, salt, hash, token_version,"
            " created, updated, updated_by, last_login)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
            (username, role, data["salt"], data["hash"], index, created, created, ""),
        )
        report["users"] += 1
        report["admins"] += role == users.ADMIN
    # The counter continues from the last number handed out, so no account can
    # ever be issued a token_version another one already used.
    conn.execute("UPDATE meta SET value = ? WHERE key = 'token_seq'",
                 (str(max(1, len(accounts))),))
    conn.execute("COMMIT")
    conn.close()
    return report


def verify(db_path: str, accounts: Dict[str, Any]) -> List[str]:
    """Compares the database against users.json. Returns the failures."""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    problems: List[str] = []

    rows = {row["username"]: row for row in conn.execute("SELECT * FROM user")}
    if set(rows) != set(accounts):
        problems.append(
            f"account names differ: only in JSON {sorted(set(accounts) - set(rows))}, "
            f"only in the database {sorted(set(rows) - set(accounts))}"
        )

    for username, data in accounts.items():
        row = rows.get(username)
        if row is None:
            continue
        # Character-identical, not "equivalent". A salt that survived as the
        # right bytes but the wrong text would lock the account out.
        if row["salt"] != data["salt"]:
            problems.append(f"{username}: salt differs")
        if row["hash"] != data["hash"]:
            problems.append(f"{username}: hash differs")
        wanted_role = users.ADMIN if data.get("is_admin") else users.OPERATOR
        if row["role"] != wanted_role:
            problems.append(f"{username}: role {row['role']!r}, expected {wanted_role!r}")
        if data.get("created") and row["created"] != data["created"]:
            problems.append(f"{username}: created {row['created']} != {data['created']}")
        if row["token_version"] < 1:
            problems.append(f"{username}: token_version {row['token_version']} is not positive")

    versions = [row["token_version"] for row in rows.values()]
    if len(set(versions)) != len(versions):
        problems.append("two accounts share a token_version")
    seq = int(conn.execute("SELECT value FROM meta WHERE key = 'token_seq'").fetchone()[0])
    if versions and seq < max(versions):
        problems.append(f"token_seq {seq} is behind the highest token_version {max(versions)}")

    if not any(row["role"] == users.ADMIN for row in rows.values()):
        problems.append("no administrator at all -- nobody could reach /admin/")

    conn.close()
    return problems


def round_trip(db_path: str) -> List[str]:
    """Logs a throwaway account in and out through the REAL users.py code path.

    There are no plaintext passwords to test the real accounts with, so this is
    how "nobody's password changed" gets proved rather than assumed: the same
    create/verify code that every login goes through is run against this
    database, with a password we know, and the account is removed again.
    """
    problems: List[str] = []
    name = "__migration_check_" + secrets.token_hex(4)
    password = secrets.token_urlsafe(16)

    previous = users._conn
    users._conn = users.connect(db_path)
    try:
        before = users.count_users()
        users.create_user(name, password, admin=False)
        if not users.verify_password(name, password):
            problems.append("the right password was refused through the SQLite path")
        if users.verify_password(name, password + "x"):
            problems.append("a wrong password was ACCEPTED through the SQLite path")
        if users.verify_password("__nobody_at_all__", password):
            problems.append("an unknown user was accepted")
        record = users.auth(name)
        if not record or record["role"] != users.OPERATOR or record["is_admin"]:
            problems.append(f"a new account came back as {record!r}")
        users.delete_user(name)
        if users.user_exists(name):
            problems.append("the throwaway account survived its own deletion")
        if users.count_users() != before:
            problems.append("the account count did not return to where it started")
    finally:
        users._conn.close()
        users._conn = previous
    return problems


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true",
                        help="check the existing users.db against users.json, change nothing")
    args = parser.parse_args()

    accounts = load_json()
    admins = sum(1 for data in accounts.values() if data.get("is_admin"))
    print(f"users.json: {len(accounts)} accounts, {admins} administrator(s)")

    if args.verify_only:
        problems = verify(USERS_DB, accounts) + round_trip(USERS_DB)
    else:
        _refuse_if_populated()
        report = build(accounts)
        print(f"  wrote {report['users']} accounts, {report['admins']} administrator(s)")
        problems = verify(PARTIAL, accounts)
        if not problems:
            problems = round_trip(PARTIAL)

    if problems:
        print(f"\nFAILED -- {len(problems)} problem(s):")
        for line in problems[:40]:
            print(f"  {line}")
        if not args.verify_only:
            for side in ("", "-wal", "-shm"):
                if os.path.exists(PARTIAL + side):
                    os.remove(PARTIAL + side)
            print("\nusers.db.partial removed. users.json untouched.")
        sys.exit(1)

    if args.verify_only:
        print("\nOK -- users.db matches users.json, and a login round-trip works.")
        return

    for suffix in ("-wal", "-shm"):
        side = PARTIAL + suffix
        if os.path.exists(side):
            os.remove(side)
    os.replace(PARTIAL, USERS_DB)
    # Credentials: readable by their owner only. users.json was created with
    # whatever umask was in force, and this is the moment to stop repeating that.
    os.chmod(USERS_DB, 0o600)
    print(f"\nOK -- users.db written, mode 600. users.json left exactly as it was.")


if __name__ == "__main__":
    main()
