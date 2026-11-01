"""Temporary files for exporting and importing classifiers from the page.

An export is built on disk first (a SQLite file cannot be streamed while it is
still being written) and handed over on a second request; an import is uploaded
first, checked, previewed, and only then applied. In between, the file has to
live somewhere, belong to somebody, and disappear:

  - in one private directory (mode 0700) made for this process, never in the
    project folder and never anywhere a later request could name by path;
  - behind a random token, owned by the administrator who made it;
  - with an expiry, swept before every request that touches it;
  - at most one file of each kind at a time, so abandoned ones cannot pile up;
  - and any directory a crashed process left behind is removed at start. The
    directory name carries the process id, so a leftover is recognised by its
    process being gone, and a second server running on the same machine never
    has its files taken away.

Kept out of server_fastapi.py so it can be tested without starting the server.
"""

import hashlib
import os
import secrets
import shutil
import tempfile
import threading
import time
from typing import Any, Dict, Optional, Tuple

PREFIX = "camera-transfer-"
EXPORT_TTL_SECONDS = 5 * 60
IMPORT_TTL_SECONDS = 15 * 60
# Free space that must remain beyond the file itself, and the factor on top of
# its size: the upload plus the room SQLite needs to open it.
SPARE_BYTES = 200 * 1024 * 1024
SPACE_FACTOR = 2


class StagingError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class Staging:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._dir: Optional[str] = None
        self._entries: Dict[str, Dict[str, Any]] = {}

    # --- the directory ---------------------------------------------------

    def directory(self) -> str:
        with self._lock:
            if self._dir is None or not os.path.isdir(self._dir):
                self._dir = tempfile.mkdtemp(prefix=f"{PREFIX}{os.getpid()}-")
                os.chmod(self._dir, 0o700)
            return self._dir

    def new_path(self, suffix: str) -> str:
        return os.path.join(self.directory(), secrets.token_hex(16) + suffix)

    def check_space(self, size: int) -> None:
        free = shutil.disk_usage(self.directory()).free
        if free < size * SPACE_FACTOR + SPARE_BYTES:
            raise StagingError(507, "Spazio su disco insufficiente.")

    # --- the registry -------------------------------------------------------

    def put(self, kind: str, owner: str, path: str, **extra: Any) -> str:
        """Registers `path` as the one file of `kind`, replacing (and deleting)
        any earlier one. Returns its token."""
        ttl = EXPORT_TTL_SECONDS if kind == "export" else IMPORT_TTL_SECONDS
        token = secrets.token_urlsafe(24)
        stale = []
        with self._lock:
            for old, entry in list(self._entries.items()):
                if entry["kind"] == kind:
                    stale.append(entry["path"])
                    del self._entries[old]
            self._entries[token] = {
                "kind": kind, "owner": owner, "path": path,
                "expires": time.time() + ttl, **extra,
            }
        for old_path in stale:
            _remove(old_path)
        return token

    def get(self, token: str, owner: str, kind: str) -> Dict[str, Any]:
        """The entry, or a StagingError saying why not. An expired or unknown
        token and a token that is somebody else's give different answers on
        purpose: the first is "start again", the second is not yours."""
        self.sweep()
        with self._lock:
            entry = self._entries.get(token)
        if entry is None or entry["kind"] != kind or not os.path.exists(entry["path"]):
            raise StagingError(
                404, "Il file non è più disponibile (scaduto o già usato): ricomincia.")
        if entry["owner"] != owner:
            raise StagingError(403, "Questo file è stato caricato da un altro amministratore.")
        return entry

    def discard(self, token: str, owner: Optional[str] = None) -> None:
        """Removes the entry and its file. Silent when it is already gone, so a
        cancel that arrives twice is not an error. An owner given must match."""
        with self._lock:
            entry = self._entries.get(token)
            if entry is None or (owner is not None and entry["owner"] != owner):
                return
            del self._entries[token]
        _remove(entry["path"])

    def forget(self, token: str) -> None:
        """Drops the entry without touching the file: for a download that has
        already unlinked it."""
        with self._lock:
            self._entries.pop(token, None)

    def sweep(self, now: Optional[float] = None) -> int:
        """Deletes every expired entry and its file; returns how many."""
        moment = time.time() if now is None else now
        gone = []
        with self._lock:
            for token, entry in list(self._entries.items()):
                if entry["expires"] <= moment:
                    gone.append(entry["path"])
                    del self._entries[token]
        for path in gone:
            _remove(path)
        return len(gone)

    def clear(self) -> None:
        """Everything, now (tests, and shutdown)."""
        with self._lock:
            paths = [entry["path"] for entry in self._entries.values()]
            self._entries.clear()
            directory, self._dir = self._dir, None
        for path in paths:
            _remove(path)
        if directory:
            shutil.rmtree(directory, ignore_errors=True)


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True                       # exists, belongs to someone else
    return True


def sweep_orphans(keep: Optional[str] = None) -> int:
    """Removes the directories of processes that no longer exist. Called once when
    the server starts, before any request can make a new one. A directory whose
    name has no process id in it is removed only when a day old."""
    removed = 0
    base = tempfile.gettempdir()
    try:
        names = os.listdir(base)
    except OSError:
        return 0
    for name in names:
        full = os.path.join(base, name)
        if not name.startswith(PREFIX) or full == keep or not os.path.isdir(full):
            continue
        head = name[len(PREFIX):].split("-", 1)[0]
        if head.isdigit():
            gone = int(head) != os.getpid() and not _process_alive(int(head))
        else:
            gone = time.time() - os.path.getmtime(full) > 24 * 3600
        if gone:
            shutil.rmtree(full, ignore_errors=True)
            removed += 1
    return removed


async def receive_upload(request: Any, path: str, limit: int) -> Tuple[int, str]:
    """Writes the request body to `path` as it arrives, never holding more than a
    chunk in memory, and stops the moment it passes `limit`. Returns (size,
    sha256). The caller deletes `path` on any error.

    Chunks are written through the event loop's thread pool so a slow disk does
    not stop the other requests, and the video, from being served meanwhile.
    """
    from starlette.concurrency import run_in_threadpool

    digest = hashlib.sha256()
    size = 0
    handle = open(path, "wb")
    try:
        buffer = bytearray()
        async for chunk in request.stream():
            size += len(chunk)
            if size > limit:
                raise StagingError(
                    413, f"Il file è troppo grande: il limite è {limit // (1024 * 1024)} MB.")
            digest.update(chunk)
            buffer.extend(chunk)
            if len(buffer) >= 1024 * 1024:
                await run_in_threadpool(handle.write, bytes(buffer))
                buffer.clear()
        if buffer:
            await run_in_threadpool(handle.write, bytes(buffer))
    finally:
        handle.close()
    return size, digest.hexdigest()


# The one staging area of the server process.
staging = Staging()
