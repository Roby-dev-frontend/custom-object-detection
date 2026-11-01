import asyncio
import base64
import binascii
import collections
import datetime
import difflib
import hashlib
import hmac
import json
import logging
import math
import os
import platform
import re
import secrets
import sqlite3
import statistics
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
from dotenv import load_dotenv

load_dotenv()

# --- The database passphrase, resolved before anything can open a store -----
#
# This runs at IMPORT, not in __main__, and it has to: users.count_users() near
# the bottom of this file is also at module level, so by the time __main__ is
# reached the store has already been opened. A prompt down there would be far
# too late.
#
# No argparse. This file is launched both as `python server_fastapi.py` and as
# `python -m uvicorn server_fastapi:app --reload`, and in the second case
# sys.argv belongs to uvicorn -- a parser here would reject --reload and kill
# the server. A plain membership test takes the flag and leaves the rest alone.
import users  # noqa: E402  (needed for first-run check before the prompt)

_HERE = os.path.dirname(os.path.abspath(__file__))
_USERS_DB_PATH = os.path.join(_HERE, "users.db")
FIRST_RUN = not os.path.exists(_USERS_DB_PATH)


# True on the Raspberry: Linux on an ARM CPU.
RUNNING_ON_PI = platform.system() == "Linux" and platform.machine().startswith(
    ("arm", "aarch64")
)

from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import MutableHeaders
from pydantic import BaseModel, Field, field_validator
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from typing_extensions import Literal

import classifier_detection
import detections
import notifications
import object_augment
import object_dupes
import object_localisers
import objects
import objects_transfer
import text_reader
import transfer_staging
from camera import (
    DETECT_EVERY,
    VIDEO_ENCODING,
    FrameHub,
    LocalCameraWorker,
    ShareMeter,
    picamera_available,
)
from detection import (
    COCO_CLASSES,
    COCO_CLASSES_IT,
    DETECTION_CONFIG,
    Detection,
    DetectionConfig,
    annotate,
    detect,
    draw_detections,
)

# Logging rather than print(): on the Raspberry the server runs as a systemd
# service, and systemd's log reader `journalctl` captures logging output with
# timestamps and severity, while bare print() lines arrive without either.
#
# basicConfig is needed for any of that to actually appear. Without a handler
# the root logger falls back to WARNING, so every logger.info() in this file --
# the source switches, the user changes, the detections reported by the
# browser -- was silently discarded.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("server")

# Primo avvio: crea gli account di default senza chiedere nulla.
# admin / admin per l'amministratore, operator / operator per l'operatore.
# Si possono cambiare dopo dal pannello di amministrazione o con
# `python manage_users.py`.
if FIRST_RUN:
    users.connect(users.USERS_DB, create=True)
    users.create_user("admin", "admin", admin=True, by="setup")
    users.create_user("operator", "operator", by="setup")
    FIRST_RUN = False
    logger.info("setup: default accounts created (admin/admin, operator/operator)")

# --- Configuration, all read from .env in one place --------------------
# Secret used to sign session cookies. Anyone knowing it could forge a cookie
# for any user, so it must never leave the server. Changing it invalidates
# every existing session, which is the way to force everybody to log in again.
SESSION_SECRET = os.environ.get("SESSION_SECRET")
if not SESSION_SECRET:
    raise RuntimeError(
        "SESSION_SECRET must be set in .env before starting the server. "
        "Generate one with:  python -c \"import secrets; print(secrets.token_urlsafe(32))\""
    )
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS")
# "none" is the idle state: no local camera is opened and nothing is streamed,
# until somebody presses "Condividi la webcam" (or picks their own camera). It
# used to default to "usb", so the Pi's webcam streamed to whoever opened the
# page with nobody having asked. NOT "remote": that means "show THIS DEVICE's own
# camera", and a page that read the idle state as that opened its own camera.
# CAMERA_SOURCE in the environment still wins, for anybody who WANTS a camera at
# launch.
CAMERA_SOURCE = os.environ.get("CAMERA_SOURCE", "none")
CAMERA_DEVICE_INDEX = int(os.environ.get("CAMERA_DEVICE_INDEX", "0"))
# Read again inside the __main__ block at the bottom, which explains them.
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
SSL_CERTFILE = os.environ.get("SSL_CERTFILE") or None
SSL_KEYFILE = os.environ.get("SSL_KEYFILE") or None


def create_self_signed_cert(certfile: str, keyfile: str) -> None:
    """Write a new self-signed certificate and its private key.

    Produces the same thing the openssl command this code used to print
    produced (self-signed, RSA 2048, CN=camera, 10 years), but in Python, so
    it works the same on the Raspberry and on Windows. Shelling out to openssl
    does not: on Windows openssl is usually not on PATH at all, and the
    printed command was POSIX shell syntax ('mkdir -p', a trailing '\\',
    '/CN=camera') that neither PowerShell nor cmd can run.

    cryptography is imported here and not at the top of the file on purpose:
    running without HTTPS (SSL_CERTFILE commented out in .env) then does not
    need the package installed.
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "camera")])
    # Naive UTC: an aware datetime is deprecated here in cryptography 42+, and
    # datetime.utcnow() is deprecated in Python 3.12+. This satisfies both.
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=3650))
        .sign(key, hashes.SHA256())
    )

    for path in (certfile, keyfile):
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
    with open(keyfile, "wb") as handle:
        handle.write(
            key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )
    with open(certfile, "wb") as handle:
        handle.write(cert.public_bytes(serialization.Encoding.PEM))


limiter = Limiter(key_func=get_remote_address)

app = FastAPI()
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

if ALLOWED_ORIGINS:
    cors_kwargs = {"allow_origins": [origin.strip() for origin in ALLOWED_ORIGINS.split(",")]}
else:
    cors_kwargs = {"allow_origin_regex": r"http://(localhost|127\.0\.0\.1):\d+"}

app.add_middleware(
    CORSMiddleware,
    allow_methods=["*"],
    allow_headers=["*"],
    **cors_kwargs,
)


# --- Who is allowed to open a WebSocket --------------------------------
#
# The two video sockets authenticate on the session cookie, and the browser
# attaches that cookie by itself -- including when the page asking for the
# socket belongs to somebody else's website. CORS does not cover this: the
# middleware above guards fetch(), not the WebSocket handshake.
#
# SameSite=lax on the cookie already refuses that handshake in current
# browsers, so this is a second lock on the same door rather than a hole being
# closed. It is worth having on a home network too: a malicious page open in
# your own browser is already inside the network, and the router never sees it.
#
# The rule is "the same origin as the page you are on", asked against the Host
# header rather than a fixed address. This server answers on localhost, on its
# LAN address, and on 192.168.4.1 while the Raspberry is its own access point;
# a hard-coded origin would lock out two of those three.
_DEV_ORIGIN = re.compile(r"http://(localhost|127\.0\.0\.1):\d+$")


def _origin_allowed(origin: Optional[str], host: Optional[str]) -> bool:
    """True when a WebSocket handshake may proceed.

    A REQUEST CARRYING NO Origin HEADER AT ALL IS LET THROUGH, deliberately.
    Browsers always send one on a WebSocket handshake, so a request without it
    is not the thing this defends against -- it is curl, a test script, or some
    future client that is not a browser at all. Refusing those would buy
    nothing and break them.
    """
    if not origin:
        return True
    # Same origin: "https://192.168.1.200:8000" against Host "192.168.1.200:8000".
    if host and origin.partition("://")[2] == host:
        return True
    # Whatever CORS already lets through, so that `npm run dev` -- where the
    # page comes from vite on another port and the API from here -- keeps
    # working exactly as it does for ordinary requests.
    if ALLOWED_ORIGINS:
        return origin in [allowed.strip() for allowed in ALLOWED_ORIGINS.split(",")]
    return bool(_DEV_ORIGIN.match(origin))


# --- Security headers --------------------------------------------------
#
# Sent on every answer, including the pages and the built assets.
#
#   nosniff         stops a browser deciding for itself that something we
#                   served as an image is really a script.
#   same-origin     keeps the address of this server out of the Referer of
#                   anything it links to.
#   DENY            no other page may put this one in a frame. That is the one
#                   that earns its place here: framed invisibly over a decoy,
#                   the camera controls can be clicked by somebody who thinks
#                   they are clicking something else.
#
# NO Strict-Transport-Security, although this server does speak HTTPS, and
# although the plan said to add it when it does. The certificate here is
# self-signed. HSTS tells the browser "never accept anything but a valid
# certificate for this host", and from that moment the warning for a
# self-signed one HAS NO "proceed anyway" BUTTON: Chrome answers "you cannot
# visit this site right now because it uses HSTS". Every browser that had ever
# opened the app -- including every phone in the house -- would be locked out
# of it, permanently, with no way back except clearing the rule by hand in
# chrome://net-internals. It belongs here the day the certificate is one a
# browser already trusts, and not before.
_SECURITY_HEADERS = (
    ("x-content-type-options", "nosniff"),
    ("referrer-policy", "same-origin"),
    ("x-frame-options", "DENY"),
)


class SecurityHeaders:
    """Adds those headers to every HTTP response.

    Written as plain ASGI rather than with @app.middleware("http") on purpose.
    That decorator installs Starlette's BaseHTTPMiddleware, which pulls the
    whole response through an internal queue -- and /video_feed is an endless
    MJPEG stream, which is precisely the shape that stalls behind it. This
    touches the response-start message and passes everything else straight
    through, so no stream is affected.
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Any) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in _SECURITY_HEADERS:
                    # setdefault, not append: an endpoint that deliberately set
                    # one of these for itself keeps its own value.
                    headers.setdefault(name, value)
            await send(message)

        await self.app(scope, receive, send_with_headers)


app.add_middleware(SecurityHeaders)


# --- Login sessions ----------------------------------------------------
# The browser holds a cookie containing "username|token_version|expiry|signature".
#
# The signature is computed from the first three fields using SESSION_SECRET,
# which only the server knows. On every request the server recomputes it and
# compares: if anything in the cookie was altered -- a different username, a
# later expiry, a different version -- the recomputed signature no longer
# matches and the request is refused.
#
# `token_version` is the field that makes a session revocable. Nothing about a
# session is stored on the server, so the only way to end one early is for the
# account's row to disagree with the number the cookie carries. Every act that
# should end a session -- a role change, a rename, a password change,
# "disconnetti ovunque" -- bumps the row, and the very next request carrying
# the old number is refused. Without it a demotion would not take effect for
# seven days and roles would be decorative.
#
# The per-request check is ONE indexed lookup on a primary key, on an already
# open connection. It replaces the two full re-reads of users.json that used to
# happen (user_exists here, then is_admin in require_admin), so authenticated
# requests got cheaper, not dearer.
#
# A cookie is used rather than a header because <img src> and WebSocket cannot
# send custom headers, while the browser attaches cookies to both by itself.
SESSION_COOKIE = "session"
SESSION_MAX_AGE = 7 * 24 * 60 * 60  # 7 days, in seconds


def _sign(payload: str) -> str:
    return hmac.new(
        SESSION_SECRET.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def _make_session_cookie(username: str, token_version: int) -> str:
    expiry = int(time.time()) + SESSION_MAX_AGE
    payload = f"{username}|{token_version}|{expiry}"
    return f"{payload}|{_sign(payload)}"


def _read_session(raw_cookie: Optional[str]) -> Optional[Dict[str, Any]]:
    """The account behind a cookie -- username, role, is_admin -- when the
    cookie is genuine, unexpired, and still the current version for that
    account. Otherwise None.

    Cookies in the old three-field shape do not parse here, so everyone is
    logged out once when this ships. That is intended.
    """
    if not raw_cookie:
        return None
    parts = raw_cookie.rsplit("|", 3)
    if len(parts) != 4:
        return None
    username, version_text, expiry_text, signature = parts

    # compare_digest always inspects every character, so an attacker cannot
    # discover a valid signature by measuring which guesses are rejected faster.
    if not hmac.compare_digest(_sign(f"{username}|{version_text}|{expiry_text}"), signature):
        return None
    try:
        if int(expiry_text) < time.time():
            return None
        version = int(version_text)
    except ValueError:
        return None

    # Re-checked on every request, so deleting an account -- or demoting it, or
    # changing its password -- stops the sessions its holder already had.
    record = users.auth(username)
    if record is None or record["token_version"] != version:
        return None
    return record


def require_session(request: Request) -> str:
    """Every endpoint depends on this. Returns the logged-in username, or
    refuses the request with 401."""
    record = _read_session(request.cookies.get(SESSION_COOKIE))
    if record is None:
        raise HTTPException(status_code=401, detail="Not logged in")
    # Kept so require_admin does not have to look the same row up again.
    request.state.account = record
    return record["username"]


def require_admin(request: Request, username: str = Depends(require_session)) -> str:
    """For the administration endpoints. Checked on the server, not merely
    hidden in the interface, so a non-admin cannot reach them by calling the
    address directly."""
    record = getattr(request.state, "account", None) or users.auth(username)
    if not record or not record["is_admin"]:
        raise HTTPException(status_code=403, detail="Administrator access required")
    return username


# How often a stream that is ALREADY RUNNING re-checks the session behind it.
#
# The three streams -- /video_ws, /camera_feed and /video_feed -- check the
# cookie once, at the handshake, and then run for hours. Without this a demoted
# or logged-out user keeps watching until they close the tab, which is the
# difference between roles that mean something and roles that look like they
# do. Ten seconds is short enough that revocation feels immediate and long
# enough that the check (one indexed lookup) is nothing next to a video frame.
SESSION_RECHECK_INTERVAL = 10.0


class SessionWatch:
    """Re-validates the cookie a long-running stream was opened with.

    The cookie itself cannot change for the life of a connection -- the browser
    has no way to hand the socket a new one -- so what is re-read is the
    account behind it: its token_version, and whether it still exists.
    """

    def __init__(self, cookies: Any) -> None:
        self._raw = cookies.get(SESSION_COOKIE)
        self._next = time.monotonic() + SESSION_RECHECK_INTERVAL

    def revoked(self) -> bool:
        """True once the session behind this stream has stopped being valid.
        Cheap to call in a tight loop: it only looks at the clock until the
        interval is up."""
        now = time.monotonic()
        if now < self._next:
            return False
        self._next = now + SESSION_RECHECK_INTERVAL
        return _read_session(self._raw) is None


def _set_session_cookie(response: Response, username: str, token_version: int) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        _make_session_cookie(username, token_version),
        max_age=SESSION_MAX_AGE,
        httponly=True,   # JavaScript cannot read it, so a script injected into
                         # the page cannot steal the session
        samesite="lax",  # another website cannot make the browser send it
        # A "secure" cookie is refused by the browser over plain http://, which
        # would make login impossible during `npm run dev`. So it is only set
        # when the server is actually running with HTTPS.
        secure=bool(SSL_CERTFILE),
        path="/",
    )


class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/login")
@limiter.limit("5/minute")
async def login(request: Request, body: LoginRequest, response: Response) -> Dict[str, Any]:
    # Rate-limited so passwords cannot be guessed rapidly. Checking the
    # password is deliberately slow (scrypt), which limits guessing further.
    if not await run_in_threadpool(users.verify_password, body.username, body.password):
        # Deliberately vague: saying "no such user" would let someone discover
        # which usernames exist.
        raise HTTPException(status_code=401, detail="Wrong username or password")
    await run_in_threadpool(users.touch_login, body.username)
    record = users.auth(body.username)
    if record is None:
        # Deleted between the password check and here. Vanishingly unlikely,
        # but issuing a cookie for an account that no longer exists is not a
        # thing to leave to luck.
        raise HTTPException(status_code=401, detail="Wrong username or password")
    _set_session_cookie(response, record["username"], record["token_version"])
    logger.info("login: %s (%s)", record["username"], record["role"])
    return {"username": record["username"], "role": record["role"],
            "is_admin": record["is_admin"]}


@app.post("/logout")
async def logout(response: Response) -> Dict[str, bool]:
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"logged_out": True}


# --- First-run setup -------------------------------------------------------
#
# On the very first start no users.db exists. The server starts without asking
# for a passphrase; the frontend shows a modal asking the user for one, then
# POSTs it here. Stores are plain SQLite (no database passphrase): whoever can
# reach this server can read them, so keep the server on a trusted LAN.


class SetupPassphraseRequest(BaseModel):
    passphrase: str


@app.get("/setup/status")
async def setup_status() -> Dict[str, Any]:
    """Whether this is the first run."""
    return {
        "first_run": FIRST_RUN,
    }


@app.post("/setup/passphrase")
async def setup_passphrase(body: SetupPassphraseRequest) -> Dict[str, Any]:
    """Creates the stores and the default accounts. Only valid on the first run.

    The passphrase is accepted but not used: stores are plain SQLite now.
    """
    if not FIRST_RUN:
        return {"ok": False, "detail": "Setup already completed."}

    try:
        users.connect(users.USERS_DB, create=True)
        users.create_user("admin", "admin", admin=True, by="setup")
        users.create_user("operator", "operator", by="setup")
    except Exception as error:
        return {"ok": False, "detail": str(error)}

    logger.info("setup: databases created and default accounts created")
    _mark_first_run_done()
    return {"ok": True}


@app.get("/setup/data-info")
async def setup_data_info(admin: str = Depends(require_admin)) -> Dict[str, Any]:
    """Quanti utenti e amministratori sono presenti nei database."""
    return {
        "users": users.count_users(),
        "admins": users.count_admins(),
    }


@app.get("/me")
async def me(request: Request, username: str = Depends(require_session)) -> Dict[str, Any]:
    """The page calls this when it loads, to decide whether to show the login
    form or the camera. The administration page calls it to decide whether to
    render anything at all -- though the real check is on every endpoint, not
    here: this answer only saves it drawing a panel it may not use."""
    record = request.state.account
    return {"username": username, "role": record["role"], "is_admin": record["is_admin"]}


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str


@app.post("/me/password")
@limiter.limit("5/minute")
async def change_own_password(
    request: Request,
    response: Response,
    body: PasswordChangeRequest,
    username: str = Depends(require_session),
) -> Dict[str, bool]:
    # The current password is required so that someone who finds an unlocked
    # browser cannot lock the real owner out by changing it.
    if not await run_in_threadpool(users.verify_password, username, body.current_password):
        raise HTTPException(status_code=401, detail="Current password is wrong")
    try:
        token = await run_in_threadpool(users.set_password, username, body.new_password)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error))
    # A password change bumps token_version, which ends every session of this
    # account -- including this one. Re-issuing the cookie here is what keeps
    # the tab the user is standing in working; without it, changing your own
    # password logs you out and reads as a crash.
    _set_session_cookie(response, username, token)
    return {"changed": True}


# --- User management (administrators only) -----------------------------


class NewUserRequest(BaseModel):
    username: str
    password: str
    # Either may be given. `role` is what the administration page sends;
    # `is_admin` is what the older caller sent, and it still works.
    role: Optional[str] = None
    is_admin: bool = False


class RoleRequest(BaseModel):
    role: str


class RenameRequest(BaseModel):
    new_username: str


class NewPasswordRequest(BaseModel):
    new_password: str


def _user_error(error: Exception) -> HTTPException:
    """The store raises LookupError for "no such account" and ValueError for
    "that is not allowed". They are different HTTP answers, and every endpoint
    below maps them the same way."""
    if isinstance(error, LookupError):
        return HTTPException(status_code=404, detail=str(error))
    return HTTPException(status_code=400, detail=str(error))


@app.get("/users")
async def get_users(_admin: str = Depends(require_admin)) -> Dict[str, Any]:
    # list_users() deliberately omits salt and hash, so nothing secret is sent
    # to the browser.
    return {"users": users.list_users(), "roles": list(users.ROLES)}


@app.post("/users")
@limiter.limit("20/minute")
async def add_user(
    request: Request, body: NewUserRequest, admin: str = Depends(require_admin)
) -> Dict[str, Any]:
    try:
        await run_in_threadpool(
            users.create_user, body.username, body.password, body.is_admin,
            body.role, admin,
        )
    except (ValueError, LookupError) as error:
        raise _user_error(error)
    logger.info("user created: %s by %s", body.username, admin)
    return {"users": users.list_users()}


@app.delete("/users/{username}")
@limiter.limit("20/minute")
async def remove_user(
    request: Request, username: str, admin: str = Depends(require_admin)
) -> Dict[str, Any]:
    if username == admin:
        # Deleting your own account mid-session would leave the page logged in
        # but every request failing, which looks like a broken server.
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    try:
        # Refuses to remove the last administrator, which would leave nobody
        # able to manage users ever again.
        await run_in_threadpool(users.delete_user, username, admin)
    except (ValueError, LookupError) as error:
        raise _user_error(error)
    logger.info("user deleted: %s by %s", username, admin)
    return {"users": users.list_users()}


# Each privileged act gets its own subpath rather than one general PATCH: they
# want separate rate limits and separate lines in the log. The guard rails are
# NOT here -- they live inside users.py, in the same transaction as the write,
# so the command line obeys them too and two concurrent demotions cannot both
# pass their pre-check.


@app.patch("/users/{username}/role")
@limiter.limit("20/minute")
async def change_role(
    request: Request, username: str, body: RoleRequest,
    admin: str = Depends(require_admin),
) -> Dict[str, Any]:
    try:
        await run_in_threadpool(users.set_role, username, body.role, admin)
    except (ValueError, LookupError) as error:
        raise _user_error(error)
    logger.info("role: %s -> %s by %s", username, body.role, admin)
    return {"users": users.list_users()}


@app.patch("/users/{username}/name")
@limiter.limit("20/minute")
async def rename_user(
    request: Request, response: Response, username: str, body: RenameRequest,
    admin: str = Depends(require_admin),
) -> Dict[str, Any]:
    try:
        token = await run_in_threadpool(
            users.rename_user, username, body.new_username, admin)
    except (ValueError, LookupError) as error:
        raise _user_error(error)
    # The cookie carries the username, so after a rename the old name no longer
    # resolves and that account's sessions end by themselves. Renaming YOURSELF
    # therefore has to hand back a new cookie in this same response.
    if username == admin:
        _set_session_cookie(response, body.new_username, token)
    logger.info("rename: %s -> %s by %s", username, body.new_username, admin)
    return {"users": users.list_users(), "renamed_self": username == admin}


@app.post("/users/{username}/password")
@limiter.limit("5/minute")
async def reset_password(
    request: Request, username: str, body: NewPasswordRequest,
    admin: str = Depends(require_admin),
) -> Dict[str, bool]:
    # Refused on yourself inside users.py: this path does not re-issue a
    # cookie, so it would log the administrator out of the panel they are
    # standing in. Their own password goes through POST /me/password.
    try:
        await run_in_threadpool(
            users.set_password_as_admin, username, body.new_password, admin)
    except (ValueError, LookupError) as error:
        raise _user_error(error)
    logger.info("password reset: %s by %s", username, admin)
    return {"changed": True}


@app.post("/users/{username}/logout_everywhere")
@limiter.limit("20/minute")
async def logout_user_everywhere(
    request: Request, username: str, admin: str = Depends(require_admin)
) -> Dict[str, bool]:
    if username == admin:
        # Not a refusal of the act -- just of this route for it. Doing it to
        # yourself must keep THIS session alive, and only /me/logout_everywhere
        # re-issues the cookie that makes that true.
        raise HTTPException(
            status_code=400, detail="Use /me/logout_everywhere for your own account")
    try:
        await run_in_threadpool(users.logout_everywhere, username, admin)
    except (ValueError, LookupError) as error:
        raise _user_error(error)
    logger.info("sessions closed: %s by %s", username, admin)
    return {"logged_out": True}


@app.post("/me/logout_everywhere")
@limiter.limit("10/minute")
async def logout_my_other_sessions(
    request: Request, response: Response, username: str = Depends(require_session)
) -> Dict[str, bool]:
    """Ends the OTHER sessions of this account and keeps this one."""
    try:
        token = await run_in_threadpool(users.logout_everywhere, username, username)
    except (ValueError, LookupError) as error:
        raise _user_error(error)
    _set_session_cookie(response, username, token)
    logger.info("sessions closed: %s (own)", username)
    return {"logged_out": True}


# --- Gathering photographs of an object --------------------------------
#
# Step one of custom-object detection, and deliberately the smallest piece of
# it: before anything can be built, we have to know whether an object nobody
# has trained for can be FOUND in a frame at all. That question is answered by
# scripts/object_bench.py, and this is how it gets its photographs.
#
# require_session, NOT require_admin. The whole point is that everyone who logs
# in can contribute views of the same object, from their own phone and their
# own angle -- one database, many users. Enrolling a face is open to every
# operator for the same reason; only deleting is an administrator's job.
#
# The frames arrive already encoded from the browser, which grabs them from the
# video it is displaying. Whoever is holding the phone is therefore capturing
# their own camera directly, at full quality, with no round trip through the
# server and back.

# Bigger than MAX_IMAGE_B64 above, on purpose: those are face crops of at most
# 240 px, these are whole scenes with the object somewhere in them, and the
# background is the part that makes the measurement honest.
MAX_CAPTURE_B64 = 900_000
MAX_CAPTURE_IMAGES = 10

# The two folders scripts/object_bench.py reads. `bench_object/` is gitignored
# beside bench_faces/, because these are photographs of somebody's home.
CAPTURE_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bench_object")

# Signatures of the frames in CAPTURE_ROOT's folders, so a near-copy can be
# refused there too. objects.py has a table for this; these are plain files on
# disk, and a table for them would be a second store to keep in step with a
# directory anybody can copy files into.
#
# Keyed by path, and safe to keep for the life of the process because these
# files are write-once: the name carries a millisecond stamp, so a path that
# has been read never changes content. A deleted file leaves an entry behind,
# which costs 72 bytes and can never match anything again.
_frame_signatures: Dict[str, Any] = {}


def _folder_signatures(folder: str) -> List[Tuple[str, int, bytes]]:
    """Every readable frame in one capture folder, as (name, dhash, thumb)."""
    out: List[Tuple[str, int, bytes]] = []
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return out
    for name in names:
        if not name.lower().endswith((".jpg", ".jpeg", ".png")):
            continue
        path = os.path.join(folder, name)
        made = _frame_signatures.get(path)
        if made is None:
            try:
                with open(path, "rb") as handle:
                    made = object_dupes.signature(handle.read())
            except OSError:
                continue
            if made is None:
                continue
            _frame_signatures[path] = made
        out.append((name, made[0], made[1]))
    return out


class CaptureRequest(BaseModel):
    """Frames to keep, and which of the two sets they belong to.

    `into` is a Literal rather than a string: the value becomes a directory
    name, and a caller-supplied path here would reach faces.db and .env. Two
    words are the entire vocabulary, so pydantic refuses everything else before
    this code ever runs -- the same reasoning as the allow-list in
    /models/{name} and the name pattern in /faces/photo/{name}.
    """

    into: Literal["with", "without"]
    images: List[str]

    @field_validator("images")
    @classmethod
    def _validate_images(cls, value: List[str]) -> List[str]:
        if not value:
            raise ValueError("At least one image is required")
        if len(value) > MAX_CAPTURE_IMAGES:
            raise ValueError(f"At most {MAX_CAPTURE_IMAGES} images")
        for image in value:
            if len(image) > MAX_CAPTURE_B64:
                raise ValueError("Image too large")
        return value


@app.post("/objects/frames")
@limiter.limit("30/minute")
async def capture_object_frames(
    request: Request, body: CaptureRequest, user: str = Depends(require_session)
) -> Dict[str, Any]:
    def work() -> Dict[str, Any]:
        folder = os.path.join(CAPTURE_ROOT, body.into)
        os.makedirs(folder, exist_ok=True)
        # Decoded and re-encoded rather than written through: _decode_images
        # drops anything that is not actually an image, so a frame that arrives
        # corrupt is skipped instead of becoming a file the bench cannot read
        # and has to explain.
        frames = _decode_images(body.images)
        # The same rule the classifier's own photographs get: a frame that is a
        # near-copy of one already in this folder is not kept. It matters most
        # here -- "scatta 5 foto senza l'oggetto" from a fixed phone is five
        # copies of one wall, and a false-positive rate measured against five
        # copies of one wall is one measurement reported as five.
        stored = _folder_signatures(folder)
        saved = 0
        duplicates = 0
        stamp = int(time.time() * 1000)
        # The contributor's name goes in the filename so a set gathered by
        # several people can be read back -- but a username is free text, and
        # "../../etc/passwd" is a legal one. Reduced to letters and digits
        # here: everything else becomes "_", and the result cannot leave the
        # folder however it was spelled.
        who = re.sub(r"[^A-Za-z0-9]", "_", user)[:24] or "anon"
        for index, frame in enumerate(frames):
            ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
            if not ok:
                continue
            blob = encoded.tobytes()
            made = object_dupes.signature(blob)
            if made is None:
                continue
            if object_dupes.first_match(made, stored) is not None:
                duplicates += 1
                continue
            path = os.path.join(folder, f"{stamp}-{index:02d}-{who}.jpg")
            with open(path, "wb") as handle:
                handle.write(blob)
            _frame_signatures[path] = made
            # Within the batch as well as against the folder: a burst arrives
            # as one request.
            stored.append((os.path.basename(path), made[0], made[1]))
            saved += 1
        total = len([n for n in os.listdir(folder) if n.lower().endswith(".jpg")])
        return {"saved": saved, "duplicates": duplicates,
                "into": body.into, "total": total}

    result = await run_in_threadpool(work)
    logger.info(
        "object capture: %s saved %d frame(s) into %s, %d near-copy refused "
        "(%d in total)",
        user, result["saved"], result["into"], result["duplicates"], result["total"],
    )
    return result


# --- Named objects ------------------------------------------------------
#
# Creating one and contributing photographs is open to every operator: the
# whole point is one database and many people, each adding the angle they
# happen to be standing at. Renaming and deleting are administrators', because
# they change or destroy what everybody else contributed.


class NewObjectRequest(BaseModel):
    name: str
    description: str = ""
    judge: str = "verde"


class RenameObjectRequest(BaseModel):
    name: str


def _object_error(error: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(error))


@app.get("/objects")
async def get_objects(_user: str = Depends(require_session)) -> Dict[str, Any]:
    return {"objects": await run_in_threadpool(objects.list_objects)}


# --- carrying classifiers to and from another installation -------------------------
#
# Administrators only: the export file is NOT encrypted and holds every photograph
# of the classifiers chosen, and an import writes into the store. Declared before
# GET /objects/{object_id} so that no path below can be read as an object id.
# The logic (what a file holds, the checks on one from outside, what a merge
# does) is in objects_transfer.py, shared with the command-line scripts; the
# temporary files are in transfer_staging.py.

_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
# One export build, upload check or apply at a time: each is heavy for this
# machine, and two at once would only make both slow.
_transfer_busy = threading.Lock()
# Directories a crashed run left in the temp folder are removed once, now,
# before any request can make a new one.
transfer_staging.sweep_orphans()


class ExportRequest(BaseModel):
    ids: Optional[List[str]] = Field(None, max_length=1000)


class TransferOptions(BaseModel):
    # Which incoming classifiers to bring (None: all), whether a name already
    # here is skipped instead of imported as "<name> (importato)", and which
    # incoming classifier goes INTO which one already here.
    only: Optional[List[str]] = Field(None, max_length=objects_transfer.MAX_IMPORT_OBJECTS)
    skip_existing: bool = False
    into: Dict[str, str] = Field(default_factory=dict, max_length=objects_transfer.MAX_IMPORT_OBJECTS)


class ApplyRequest(TransferOptions):
    plan_digest: str = Field(max_length=64)


def _transfer_http(error: Exception) -> HTTPException:
    if isinstance(error, objects_transfer.TransferError):
        return HTTPException(status_code=error.status, detail=error.it)
    if isinstance(error, transfer_staging.StagingError):
        return HTTPException(status_code=error.status, detail=error.message)
    raise error


def _check_ids(values: Any) -> None:
    for value in values:
        if not (isinstance(value, str) and _ID_PATTERN.match(value)):
            raise HTTPException(status_code=400, detail="Identificativo di classificatore non valido.")


def _busy_or_409() -> None:
    if not _transfer_busy.acquire(blocking=False):
        raise HTTPException(
            status_code=409,
            detail="Un'esportazione o un'importazione è già in corso: riprova tra poco.")


def _explain_it(entry: Any) -> str:
    if entry.action == "skip":
        return ("Non selezionato" if entry.why == "not_selected"
                else "Esiste già un classificatore con questo nome: non importato")
    if entry.action == "new":
        return "Nuovo"
    if entry.action == "rename":
        return f"Il nome è già usato: verrà importato come « {entry.final_name} »"
    if entry.target_id == entry.row["id"]:
        return "Già presente (stesso identificativo): solo le foto nuove"
    return f"Le foto nuove vanno in « {entry.final_name} »"


def _plan_import(validated: Any, options: TransferOptions) -> Dict[str, Any]:
    """The preview of an uploaded file under the given options. Reads only: the
    staged file and this machine's classifiers."""
    export = objects_transfer.open_export(validated.path)
    here = objects.connect(objects.OBJECTS_DB, create=False)
    try:
        rows = export.execute("SELECT * FROM object ORDER BY name COLLATE NOCASE").fetchall()
        in_file = {row["id"] for row in rows}
        _check_ids(list(options.into.keys()) + list(options.into.values())
                   + list(options.only or []))
        if not set(options.into) <= in_file or not set(options.only or []) <= in_file:
            raise HTTPException(status_code=400, detail="Classificatore non presente nel file.")
        entries = objects_transfer.plan(
            export, here, rows, into=options.into, skip_existing=options.skip_existing,
            max_name=objects.MAX_NAME_LENGTH, only=options.only)
        items = []
        for entry in entries:
            object_id = entry.row["id"]
            info = objects_transfer.describe(export, object_id)
            names = [r[0] for r in export.execute(
                "SELECT name FROM view WHERE object_id = ?", (object_id,))]
            present = sum(1 for name in names if here.execute(
                "SELECT 1 FROM view WHERE name = ?", (name,)).fetchone())
            items.append({
                "source_id": object_id, "name": entry.row["name"],
                "views": info["views"], "boxed": info["boxed"], "generated": info["generated"],
                "picks": info["picks"], "measured": bool(info["measured"]),
                "method": info["method"], "already_here": present,
                "new_views": 0 if entry.action == "skip" else len(names) - present,
                "action": entry.action, "final_name": entry.final_name,
                "target_id": entry.target_id, "explanation": _explain_it(entry),
            })
        targets = [{"id": r["id"], "name": r["name"]} for r in here.execute(
            "SELECT id, name FROM object ORDER BY name COLLATE NOCASE").fetchall()]
    finally:
        here.close()
        export.close()
    digest = hashlib.sha256(json.dumps(
        [validated.sha256, sorted(options.into.items()), sorted(options.only or []),
         options.skip_existing,
         [[i["source_id"], i["action"], i["final_name"], i["target_id"], i["new_views"]]
          for i in items]],
        sort_keys=True).encode("utf-8")).hexdigest()
    return {
        "file": {"format": objects_transfer.FORMAT, "exported": validated.exported,
                 "size": validated.size, "objects": len(validated.objects),
                 "views": validated.views},
        "items": items, "targets": targets,
        "totals": {"objects": sum(1 for i in items if i["action"] in ("new", "rename")),
                   "views": sum(i["new_views"] for i in items)},
        "plan_digest": digest,
    }


def _prepare_export(ids: Optional[List[str]], owner: str) -> Dict[str, Any]:
    _busy_or_409()
    try:
        transfer_staging.staging.sweep()
        source = objects.connect(objects.OBJECTS_DB, create=False)
        try:
            chosen = objects_transfer.chosen_ids(source, None, ids)
            if not chosen:
                raise objects_transfer.TransferError(
                    "nothing to export", "Non ci sono classificatori da esportare.", 404)
            marks = ",".join("?" * len(chosen))
            estimate = source.execute(
                f"SELECT COALESCE(SUM(length(jpeg)), 0) FROM view WHERE object_id IN ({marks})",
                chosen).fetchone()[0]
            transfer_staging.staging.check_space(int(estimate))
            partial = transfer_staging.staging.new_path(".db.partial")
            try:
                counts = objects_transfer.write_export(source, partial, chosen)
                final = partial[: -len(".partial")]
                os.replace(partial, final)
            except BaseException:
                if os.path.exists(partial):
                    os.remove(partial)
                raise
        finally:
            source.close()
        size = os.path.getsize(final)
        filename = "classificatori-" + time.strftime("%Y%m%d-%H%M") + ".db"
        token = transfer_staging.staging.put("export", owner, final, size=size, filename=filename,
                                             objects=len(chosen), views=counts.get("view", 0))
        return {"token": token, "filename": filename, "size": size, "objects": len(chosen),
                "views": counts.get("view", 0), "measured": counts.get("measurement", 0)}
    except (objects_transfer.TransferError, transfer_staging.StagingError) as error:
        raise _transfer_http(error)
    finally:
        _transfer_busy.release()


@app.post("/objects/transfer/export")
@limiter.limit("6/minute")
async def prepare_classifier_export(
    request: Request, body: ExportRequest, admin: str = Depends(require_admin)
) -> Dict[str, Any]:
    """Builds the export file and keeps it for five minutes; the answer carries
    the token for GET /objects/transfer/export/{token}."""
    _check_ids(body.ids or [])
    return await run_in_threadpool(_prepare_export, body.ids, admin)


@app.get("/objects/transfer/export/{token}")
@limiter.limit("10/minute")
async def download_classifier_export(
    request: Request, token: str, admin: str = Depends(require_admin)
) -> StreamingResponse:
    """The file, once. It is unlinked as soon as it is open (Linux keeps it
    readable until the last byte is sent), so a download that is cut off leaves
    nothing on the disk."""
    try:
        entry = transfer_staging.staging.get(token, admin, "export")
    except transfer_staging.StagingError as error:
        raise _transfer_http(error)
    path = entry["path"]
    handle = open(path, "rb")
    transfer_staging.staging.forget(token)
    still_there = False
    try:
        os.unlink(path)
    except OSError:
        still_there = True   # Windows: it cannot be removed while open

    def chunks():
        try:
            while True:
                block = handle.read(256 * 1024)
                if not block:
                    break
                yield block
        finally:
            handle.close()
            if still_there:
                try:
                    os.remove(path)
                except OSError:
                    pass

    logger.info("classifier export downloaded by %s: %s", admin, entry["filename"])
    await run_in_threadpool(
        notifications.add, "classifiers_exported",
        f"{admin} ha esportato {entry['objects']} classificatori "
        f"({entry['views']} foto, file non cifrato).", admin)
    return StreamingResponse(chunks(), media_type="application/vnd.sqlite3", headers={
        "Content-Disposition": f'attachment; filename="{entry["filename"]}"',
        "Content-Length": str(entry["size"]),
        "Cache-Control": "no-store",
    })


def _validate_upload(path: str, digest: str) -> Any:
    _busy_or_409()
    try:
        return objects_transfer.validate_export(path, objects.MAX_NAME_LENGTH, digest)
    finally:
        _transfer_busy.release()


@app.put("/objects/transfer/upload")
@limiter.limit("6/minute")
async def upload_classifier_import(
    request: Request, admin: str = Depends(require_admin)
) -> Dict[str, Any]:
    """Takes an export file as the raw request body, checks everything in it,
    and answers with the preview. Nothing is written to the store yet."""
    kind = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if kind != "application/octet-stream":
        raise HTTPException(status_code=415,
                            detail="Il file deve essere inviato come application/octet-stream.")
    length = request.headers.get("content-length")
    if length is None or not length.isdigit():
        raise HTTPException(status_code=411, detail="Manca la dimensione del file.")
    if int(length) > objects_transfer.MAX_IMPORT_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Il file è troppo grande: il limite è "
                   f"{objects_transfer.MAX_IMPORT_BYTES // (1024 * 1024)} MB.")
    staging = transfer_staging.staging
    staging.sweep()
    path = None
    token = None
    try:
        staging.check_space(int(length))
        path = staging.new_path(".db")
        size, digest = await transfer_staging.receive_upload(
            request, path, objects_transfer.MAX_IMPORT_BYTES)
        validated = await run_in_threadpool(_validate_upload, path, digest)
        token = staging.put("import", admin, path, validated=validated, size=size)
        preview = await run_in_threadpool(_plan_import, validated, TransferOptions())
    except (objects_transfer.TransferError, transfer_staging.StagingError) as error:
        if token:
            staging.discard(token)
        if path:
            try:
                os.remove(path)
            except OSError:
                pass
        raise _transfer_http(error)
    except BaseException:
        if token:
            staging.discard(token)
        if path:
            try:
                os.remove(path)
            except OSError:
                pass
        raise
    preview["token"] = token
    preview["expires_in"] = transfer_staging.IMPORT_TTL_SECONDS
    return preview


@app.post("/objects/transfer/{token}/plan")
@limiter.limit("60/minute")
async def plan_classifier_import(
    request: Request, token: str, body: TransferOptions, admin: str = Depends(require_admin)
) -> Dict[str, Any]:
    """The preview again, under other options (which rows, skip, merge into)."""
    try:
        entry = transfer_staging.staging.get(token, admin, "import")
        preview = await run_in_threadpool(_plan_import, entry["validated"], body)
    except (objects_transfer.TransferError, transfer_staging.StagingError) as error:
        raise _transfer_http(error)
    preview["token"] = token
    return preview


def _apply_import(token: str, entry: Dict[str, Any], body: ApplyRequest,
                  admin: str) -> Dict[str, Any]:
    _busy_or_409()
    try:
        validated = entry["validated"]
        again = _plan_import(validated, body)
        if again["plan_digest"] != body.plan_digest:
            raise HTTPException(
                status_code=409,
                detail="Nel frattempo i classificatori sono cambiati: controlla di nuovo l'anteprima.")
        export = objects_transfer.open_export(validated.path)
        here = objects.connect(objects.OBJECTS_DB, create=False)
        results: List[Dict[str, Any]] = []
        added_objects = added_views = 0
        try:
            rows = export.execute("SELECT * FROM object ORDER BY name COLLATE NOCASE").fetchall()
            entries = objects_transfer.plan(
                export, here, rows, into=body.into, skip_existing=body.skip_existing,
                max_name=objects.MAX_NAME_LENGTH, only=body.only)
            for plan_entry in entries:
                result = {"source_id": plan_entry.row["id"], "name": plan_entry.row["name"],
                          "final_name": plan_entry.final_name, "action": plan_entry.action,
                          "added_views": 0, "measurement": "none", "error": None}
                if plan_entry.action == "skip":
                    results.append(result)
                    continue
                # Written in small steps (objects_transfer.BATCH_PHOTOS photographs
                # each): the video reads these tables through another connection
                # and waits only as long as one step takes, never the whole file.
                def next_step() -> None:
                    here.execute("COMMIT")
                    here.execute("BEGIN IMMEDIATE")

                def give_up() -> None:
                    try:
                        here.execute("ROLLBACK")
                    except sqlite3.OperationalError:
                        pass                      # no step was open

                here.execute("BEGIN IMMEDIATE")
                try:
                    done = objects_transfer.apply_entry(
                        export, here, plan_entry, strict=True,
                        signatures=validated.signatures, on_batch=next_step)
                    here.execute("COMMIT")
                except sqlite3.IntegrityError:
                    give_up()
                    # Someone made a classifier of that name between the preview
                    # and now; the others still go in.
                    result["error"] = "Il nome è stato preso nel frattempo: non importato."
                    results.append(result)
                    continue
                except BaseException:
                    give_up()
                    raise
                added_objects += 1 if done["added_object"] else 0
                added_views += done["added_views"]
                result["added_views"] = done["added_views"]
                result["measurement"] = ("copied" if done["measurement_copied"]
                                         else "dropped" if done["measurement_dropped"] else "none")
                results.append(result)
        except HTTPException:
            raise
        except Exception:
            logger.exception("classifier import failed after %d classifier(s)", len(results))
            raise HTTPException(
                status_code=500,
                detail=f"Importazione interrotta: {sum(1 for r in results if not r['error'])} "
                       "classificatori importati prima dell'errore. Ricaricare lo stesso file "
                       "è sicuro: aggiunge solo ciò che manca (la misura di un classificatore "
                       "interrotto potrebbe dover essere rifatta).")
        finally:
            here.close()
            export.close()
        classifier_detection.invalidate()
        logger.info("classifier import by %s: %d classifier(s), %d photo(s)",
                    admin, added_objects, added_views)
        return {"added_objects": added_objects, "added_views": added_views, "results": results}
    finally:
        _transfer_busy.release()


@app.post("/objects/transfer/{token}/apply")
@limiter.limit("3/minute")
async def apply_classifier_import(
    request: Request, token: str, body: ApplyRequest, admin: str = Depends(require_admin)
) -> Dict[str, Any]:
    """Writes the previewed classifiers into the store. Additive: nothing already
    here is changed or removed, and nothing is made active for detection."""
    try:
        entry = transfer_staging.staging.get(token, admin, "import")
    except transfer_staging.StagingError as error:
        raise _transfer_http(error)
    try:
        outcome = await run_in_threadpool(_apply_import, token, entry, body, admin)
    except objects_transfer.TransferError as error:
        raise _transfer_http(error)
    transfer_staging.staging.discard(token, admin)
    if outcome["added_objects"] or outcome["added_views"]:
        await run_in_threadpool(
            notifications.add, "classifiers_imported",
            f"{admin} ha importato {outcome['added_objects']} classificatori e "
            f"{outcome['added_views']} foto.", admin)
    outcome["objects"] = await run_in_threadpool(objects.list_objects)
    return outcome


@app.delete("/objects/transfer/{token}")
@limiter.limit("30/minute")
async def cancel_classifier_transfer(
    request: Request, token: str, admin: str = Depends(require_admin)
) -> Dict[str, bool]:
    """Throws a staged file away. Already gone is not an error."""
    transfer_staging.staging.discard(token, admin)
    return {"ok": True}


@app.get("/objects/{object_id}")
async def get_one_object(
    object_id: str, _user: str = Depends(require_session)
) -> Dict[str, Any]:
    """One object WITH its photographs listed.

    Separate from the list above because the list is fetched constantly and
    only needs counts, while this is fetched when somebody actually opens one.
    """
    record = await run_in_threadpool(objects.get_object, object_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Oggetto non trovato.")
    return _with_template_max(record)


@app.post("/objects")
@limiter.limit("20/minute")
async def create_object(
    request: Request, body: NewObjectRequest, user: str = Depends(require_session)
) -> Dict[str, Any]:
    try:
        record = await run_in_threadpool(
            objects.create_object, body.name, user,
            description=body.description, judge=body.judge,
        )
    except ValueError as error:
        raise _object_error(error)
    logger.info("object created: %s by %s", record["name"], user)
    await run_in_threadpool(
        notifications.add, "classifier_created",
        f"« {record['name']} » creato da {user}.", user,
    )
    return {"object": _with_template_max(record), "objects": objects.list_objects()}


@app.patch("/objects/{object_id}")
@limiter.limit("20/minute")
async def rename_object(
    request: Request, object_id: str, body: RenameObjectRequest,
    admin: str = Depends(require_admin),
) -> Dict[str, Any]:
    """Administrators only, and the name is all it changes."""
    try:
        record = await run_in_threadpool(objects.rename_object, object_id, body.name, admin)
    except ValueError as error:
        raise _object_error(error)
    if record is None:
        raise HTTPException(status_code=404, detail="Oggetto non trovato.")
    logger.info("object renamed: %s -> %s by %s", object_id, record["name"], admin)
    return {"object": _with_template_max(record), "objects": objects.list_objects()}


@app.delete("/objects/{object_id}")
@limiter.limit("20/minute")
async def remove_object(
    request: Request, object_id: str, admin: str = Depends(require_admin)
) -> Dict[str, Any]:
    removed = await run_in_threadpool(objects.delete_object, object_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Oggetto non trovato.")
    # If this classifier was the thing every device was currently detecting,
    # there is nothing left to point at -- reset to nothing for everyone,
    # rather than leaving detection_config naming an object that no longer
    # exists. classifier_detection would already return [] for it (its own
    # objects.get_measurement() check fails closed), but the Detect picker
    # would otherwise keep showing a choice that silently does nothing.
    if (camera.detection_config.get("backend") == "classifier"
            and camera.detection_config.get("object_id") == object_id):
        camera.apply_detection_config(
            {"backend": "none", "yolo_classes": None, "object_id": None}
        )
    classifier_detection.invalidate()
    logger.info("object deleted: %s by %s", object_id, admin)
    return {"objects": objects.list_objects()}


class ObjectViewsRequest(BaseModel):
    images: List[str]

    @field_validator("images")
    @classmethod
    def _validate_images(cls, value: List[str]) -> List[str]:
        if not value:
            raise ValueError("At least one image is required")
        if len(value) > MAX_CAPTURE_IMAGES:
            raise ValueError(f"At most {MAX_CAPTURE_IMAGES} images")
        for image in value:
            if len(image) > MAX_CAPTURE_B64:
                raise ValueError("Image too large")
        return value


@app.post("/objects/{object_id}/views")
@limiter.limit("30/minute")
async def add_object_views(
    request: Request, object_id: str, body: ObjectViewsRequest,
    user: str = Depends(require_session),
) -> Dict[str, Any]:
    """A burst of photographs of one named object. Every operator may add."""

    def work() -> Dict[str, Any]:
        frames = _decode_images(body.images)
        jpegs = []
        for frame in frames:
            ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
            if ok:
                jpegs.append(encoded.tobytes())
        # One batch, one transaction, and the near-copies dropped on the way
        # in -- including copies of each other, since a burst arrives as one
        # request. See objects.add_views.
        added = objects.add_views(object_id, jpegs, created_by=user)
        if added is None:
            raise HTTPException(status_code=404, detail="Oggetto non trovato.")
        # And the ones gathered before that gate existed. Automatic and
        # unasked, as decided; objects.prune_duplicates lists the four kinds of
        # photograph it will never delete.
        removed = objects.prune_duplicates(object_id)
        record = objects.get_object(object_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Oggetto non trovato.")
        return {
            "saved": len(added["names"]),
            "duplicates": added["duplicates"],
            "removed": len(removed),
            "object": _with_template_max(record),
        }

    result = await run_in_threadpool(work)
    logger.info(
        "%s added %d view(s) to %s (%d duplicate(s) refused, %d older one(s) pruned)",
        user, result["saved"], result["object"]["name"],
        result["duplicates"], result["removed"],
    )
    return result


@app.delete("/objects/views/{view_name}")
@limiter.limit("30/minute")
async def remove_object_view(
    request: Request, view_name: str, user: str = Depends(require_session)
) -> Dict[str, Any]:
    """One photograph, and everything recorded about it.

    require_session, not require_admin: curating the photos YOU took -- taking
    a bad one back out -- is part of gathering them, not undoing somebody
    else's work. Deleting a photo somebody else contributed is still an
    administrator's job, checked below, for the same reason renaming and
    deleting a whole classifier are.

    Nothing else has to be remembered here: the box lives on the same row, so
    a picture and what was known about it cannot come apart.
    """

    def work() -> Dict[str, Any]:
        owner = objects.view_owner(view_name)
        if owner is None:
            raise HTTPException(status_code=404, detail="Immagine non trovata.")
        account = getattr(request.state, "account", None) or users.auth(user)
        is_admin = bool(account and account["is_admin"])
        if not is_admin and owner != user:
            raise HTTPException(
                status_code=403,
                detail="Puoi eliminare solo le foto che hai scattato tu.",
            )
        if not objects.delete_view(view_name):
            raise HTTPException(status_code=404, detail="Immagine non trovata.")
        return {"objects": objects.list_objects()}

    result = await run_in_threadpool(work)
    logger.info("object view deleted: %s by %s", view_name, user)
    return result


@app.get("/objects/view/{view_name}")
async def object_view(
    request: Request, view_name: str, _user: str = Depends(require_session)
) -> Response:
    """One stored photograph. The name is matched against the pattern we
    generate, never joined onto a directory."""
    jpeg = await run_in_threadpool(objects.view_bytes, view_name)
    if jpeg is None:
        raise HTTPException(status_code=404, detail="Immagine non trovata")
    etag = f'"{view_name}"'
    headers = {"Cache-Control": "private, max-age=86400", "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=jpeg, media_type="image/jpeg", headers=headers)


class ViewBox(BaseModel):
    """Where the object is, in the pixels of the picture it was drawn on."""

    x: int
    y: int
    w: int
    h: int


# How many photographs one press of "Genera varianti" may draw from. Five
# transforms over twelve sources is sixty JPEG encodes of a phone-sized
# picture, which is about as much as a threadpool worker can do on this Pi
# without the video stuttering. Carried to the page by _with_template_max
# below rather than written there as well.
MAX_AUGMENT_SOURCES = 12


def _with_template_max(record: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """How many references the template method can afford, carried with the
    record so the page never hardcodes it.

    Added here and not in objects.py, which deliberately imports no vision
    code. Applied wherever ONE object's record is returned, because the page
    adopts those responses directly -- an activation that answered without it
    would blank the number the picker depends on.
    """
    if record is not None:
        record["template_max"] = object_localisers.MAX_TEMPLATE_REFERENCES
        record["augment_max"] = MAX_AUGMENT_SOURCES
    return record


class TemplateRefsRequest(BaseModel):
    """Which photos the template method may use, in the order chosen.

    An empty list means "stop choosing": template then falls back to the first
    few boxed photos, which is what it did before anybody could choose.
    """
    views: List[str] = Field(default_factory=list)


@app.put("/objects/{object_id}/template-refs")
@limiter.limit("30/minute")
async def set_template_refs(
    request: Request, object_id: str, body: TemplateRefsRequest,
    user: str = Depends(require_session),
) -> Dict[str, Any]:
    """Curation, so require_session and not require_admin -- the same rule the
    box endpoint follows, and for the same reason: it changes nothing the house
    detects until an administrator measures and activates again. The response
    says so through detector.template_stale."""
    if len(body.views) > object_localisers.MAX_TEMPLATE_REFERENCES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Al massimo {object_localisers.MAX_TEMPLATE_REFERENCES} foto per "
                "il metodo template: togline una prima di aggiungerne un'altra."
            ),
        )
    try:
        stored = await run_in_threadpool(objects.set_template_picks, object_id, body.views)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    if stored is None:
        raise HTTPException(status_code=404, detail="Oggetto non trovato.")
    record = await run_in_threadpool(objects.get_object, object_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Oggetto non trovato.")
    logger.info("template references for %s set to %d photo(s) by %s",
                record["name"], len(stored), user)
    return {"object": _with_template_max(record), "objects": await run_in_threadpool(objects.list_objects)}



class AugmentRequest(BaseModel):
    """Which transforms to apply. Empty means all five.

    A Literal list rather than free text: the names index a dict of functions
    in object_augment, and an unknown one should be refused by pydantic before
    this code runs.
    """
    kinds: List[Literal["bright", "dark", "contrast", "blur", "colour"]] = Field(
        default_factory=list
    )


@app.post("/objects/{object_id}/augment")
@limiter.limit("3/minute")
async def augment_object(
    request: Request, object_id: str, body: AugmentRequest,
    admin: str = Depends(require_admin),
) -> Dict[str, Any]:
    """Makes extra photographs out of the boxed ones, for the references to
    cover more than one lighting.

    require_admin, like /objects/measure and unlike capturing: it is seconds of
    CPU per press and it adds rows to everybody's classifier, which is not the
    same kind of act as contributing a photograph of your own.
    """

    def work() -> Dict[str, Any]:
        sources = objects.augment_source_views(object_id)
        if not sources:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Serve almeno una foto con il riquadro: le varianti copiano "
                    "il riquadro dell'originale."
                ),
            )
        made = 0
        for view_name in sources[:MAX_AUGMENT_SOURCES]:
            jpeg = objects.view_bytes(view_name)
            if not jpeg:
                continue
            variants = object_augment.variants(jpeg, body.kinds or None)
            made += len(objects.add_variants(object_id, view_name, variants,
                                             created_by=admin))
        record = objects.get_object(object_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Oggetto non trovato.")
        return {
            "generated": made,
            "sources": min(len(sources), MAX_AUGMENT_SOURCES),
            "object": _with_template_max(record),
        }

    result = await run_in_threadpool(work)
    logger.info("%s generated %d variant(s) from %d photo(s) of %s",
                admin, result["generated"], result["sources"], result["object"]["name"])
    return result


@app.delete("/objects/{object_id}/generated")
@limiter.limit("6/minute")
async def remove_generated_views(
    request: Request, object_id: str, admin: str = Depends(require_admin),
) -> Dict[str, Any]:
    """Takes every generated photograph of one classifier back out.

    The originals stay. An active measurement made against variants is not
    re-run here -- it keeps its pinned references like any other, and
    get_object reports the ones that no longer exist, same as for a photo
    deleted by hand.
    """

    def work() -> Dict[str, Any]:
        removed = objects.delete_generated(object_id)
        record = objects.get_object(object_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Oggetto non trovato.")
        return {"removed": removed, "object": _with_template_max(record)}

    result = await run_in_threadpool(work)
    logger.info("%s removed %d generated photo(s) from %s",
                admin, result["removed"], result["object"]["name"])
    return result


@app.post("/objects/views/{view_name}/box")
@limiter.limit("30/minute")
async def set_object_view_box(
    request: Request, view_name: str, body: ViewBox, user: str = Depends(require_session),
) -> Dict[str, Any]:
    """Where the object is, in one photograph already saved to the classifier.

    require_session, like adding a view: drawing the box is finishing the
    photograph you or someone else just contributed, not undoing anybody's
    work, so it is not an administrator's job the way deleting one is.
    """

    def work() -> Dict[str, Any]:
        jpeg = objects.view_bytes(view_name)
        if jpeg is None:
            raise HTTPException(status_code=404, detail="Immagine non trovata.")
        frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise HTTPException(status_code=400, detail="Immagine non leggibile.")
        height, width = frame.shape[:2]
        # Clamped to the picture, not trusted. The browser computes these from
        # a pointer position, and a rounding error at the edge would otherwise
        # become a crop that reaches outside the array -- numpy answers that
        # with an empty slice rather than an error, so it would surface later
        # as "the reference matches nothing".
        x1 = max(0, min(width, body.x))
        y1 = max(0, min(height, body.y))
        x2 = max(0, min(width, body.x + body.w))
        y2 = max(0, min(height, body.y + body.h))
        if x2 - x1 < 8 or y2 - y1 < 8:
            raise HTTPException(
                status_code=400,
                detail="Il riquadro e' troppo piccolo o fuori dall'immagine.",
            )
        box = {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}
        if not objects.set_view_box(view_name, box, updated_by=user):
            raise HTTPException(status_code=404, detail="Immagine non trovata.")
        return box

    result = await run_in_threadpool(work)
    logger.info("object view box set: %s by %s: %s", view_name, user, result)
    return result


# Upper bound on how many photographs one measurement looks at. Comparing
# three localisers over the full set is tens of seconds of CPU on this Pi; a
# folder somebody filled with a thousand frames would hold a worker for many
# minutes and make the video stutter for everyone.
MAX_MEASURE_FRAMES = 60

# The contact sheets compare() draws. An allow-list rather than a pattern,
# because the name arrives in a URL -- the same care /models/{name} takes.
SHEET_NAMES = {f"sheet-{name}.png" for name in ("orb", "proposals", "template")}


class MeasureRequest(BaseModel):
    object_id: str


class MeasurementInputs:
    """What both /objects/measure and /objects/{id}/activate need: every
    reference ({view, box}) and its cropped pixels, and the two sets of
    frames to test against, with_sources saying which references each
    with_frame came from -- its own index plus any variant generated from it,
    or None for a plain held-out test photo. One place to
    gather it so the two endpoints cannot end up disagreeing about which
    photos are references -- that was exactly reference.jpg's old failure
    mode, a file nothing kept in sync with the classifier's own photos.
    """

    def __init__(self, references: List[Dict[str, Any]], crops: List[Any],
                 with_frames: List[Any], with_sources: List[Optional[List[int]]],
                 without_frames: List[Any],
                 template_usable: Optional[List[int]] = None) -> None:
        self.references = references
        self.crops = crops
        self.with_frames = with_frames
        self.with_sources = with_sources
        self.without_frames = without_frames
        # Indices into `references`: which ones the template method may use,
        # in the order a person chose them. See template_pick in objects.py.
        self.template_usable = [] if template_usable is None else template_usable

    @property
    def template_references(self) -> List[Dict[str, Any]]:
        """Just those, in that order. What /activate stores when the method
        being activated is template, so the set it detects with is the set it
        was measured with -- which it was not before: template truncated to the
        first six of a list the live side then read back in another order."""
        return [self.references[index] for index in self.template_usable]


def _gather_measurement_inputs(object_id: str) -> MeasurementInputs:
    """Raises HTTPException with the same messages /objects/measure always
    showed; called from inside a threadpool worker, same as before."""
    record = objects.get_object(object_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Oggetto non trovato.")
    views = record["view_list"]
    boxed = [v for v in views if v["box"]]
    if not boxed:
        raise HTTPException(
            status_code=400,
            detail="Disegna il riquadro su almeno una foto prima di misurare.",
        )
    # Every boxed photo (up to the cap) becomes a reference the live detector
    # matches against; a boxed photo beyond the cap falls back to being a
    # plain recall-test photo, same as an unboxed one. Oldest first, so which
    # photos are references does not reshuffle as new ones are added.
    chosen = boxed[:object_localisers.MAX_REFERENCES]
    references: List[Dict[str, Any]] = []
    crops: List[Any] = []
    for view in chosen:
        jpeg = objects.view_bytes(view["name"])
        full = (cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
                if jpeg else None)
        if full is None:
            continue
        box = view["box"]
        crop = full[box["y"]:box["y"] + box["h"], box["x"]:box["x"] + box["w"]]
        if crop.size == 0:
            continue
        references.append({"view": view["name"], "box": box})
        crops.append(crop)
    if not references:
        raise HTTPException(status_code=400, detail="Il riferimento non e' leggibile.")
    reference_index = {r["view"]: index for index, r in enumerate(references)}
    # Every reference index that came from a given photograph: its own, plus
    # the ones generated FROM it. A photograph found by a brightened copy of
    # itself is the method finding itself, exactly like a photograph found by
    # its own reference -- the leave-one-out that object_localisers.compare()
    # does has to leave out the whole family, not one member.
    origins = objects.generated_sources(object_id)
    derived: Dict[str, List[int]] = {}
    for r in references:
        derived.setdefault(origins.get(r["view"], r["view"]), []).append(
            reference_index[r["view"]]
        )

    def load(folder: str) -> List[Any]:
        path = os.path.join(CAPTURE_ROOT, folder)
        if not os.path.isdir(path):
            return []
        frames = []
        for name in sorted(os.listdir(path))[:MAX_MEASURE_FRAMES]:
            if not name.lower().endswith((".jpg", ".jpeg", ".png")):
                continue
            image = cv2.imread(os.path.join(path, name))
            if image is not None:
                frames.append(image)
        return frames

    with_frames: List[Any] = []
    with_sources: List[Optional[List[int]]] = []
    # Generated variants are references, not evidence: a variant IS one of
    # these photographs with the brightness turned up, so counting it as a
    # frame "with the object" would measure this program against its own
    # output and report a recall nobody can rely on. They stay in `boxed`
    # above, so they still become references -- which is the whole point of
    # generating them.
    real = [view for view in views if not view["generated"]]
    for view in real[:MAX_MEASURE_FRAMES]:
        source = derived.get(view["name"])
        # A frame whose family IS every reference has nothing left to be
        # tested against: drop it, exactly as the single-reference code always
        # did (one boxed photo and nothing else was this same case).
        if source is not None and len(source) >= len(references):
            continue
        jpeg = objects.view_bytes(view["name"])
        image = (cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
                  if jpeg else None)
        if image is not None:
            with_frames.append(image)
            with_sources.append(source)
    without_frames = load("without")
    # Template's own choice, mapped onto the reference list this run built.
    # Names that did not survive the crop-readability loop above simply are not
    # in reference_index, so they fall out here rather than shifting the rest.
    picked = objects.get_template_picks(object_id)
    template_usable = [reference_index[name] for name in picked if name in reference_index]
    if not template_usable:
        # What template always did, minus nothing: the first few references in
        # the order they were gathered.
        template_usable = list(range(min(len(references),
                                         object_localisers.MAX_TEMPLATE_REFERENCES)))
    template_usable = template_usable[:object_localisers.MAX_TEMPLATE_REFERENCES]
    if not with_frames:
        raise HTTPException(
            status_code=400,
            detail=(
                "Serve almeno un'altra foto con l'oggetto, oltre a quelle "
                "usate come riferimento: cattura qualche foto in piu'."
            ),
        )
    return MeasurementInputs(references, crops, with_frames, with_sources, without_frames,
                             template_usable)


@app.post("/objects/measure")
@limiter.limit("6/minute")
async def measure_object(
    request: Request, body: MeasureRequest, admin: str = Depends(require_admin)
) -> Dict[str, Any]:
    """Which way of finding this object actually works, as numbers.

    require_admin, unlike capturing. Gathering photographs is everybody's job
    -- that is the entire point of one database and many users -- but this
    burns whole seconds of CPU per press, and leaving it open to every operator
    would hand anybody a way to make the video stutter for the whole house.
    """

    def work() -> Dict[str, Any]:
        inputs = _gather_measurement_inputs(body.object_id)
        with_frames = inputs.with_frames
        without_frames = inputs.without_frames

        sheets: List[str] = []

        def draw(row: Dict[str, Any], boxes: Any) -> None:
            if row.get("error"):
                return
            originals = list(with_frames) + list(without_frames)
            drawn = []
            for (label, found, score), original in zip(boxes, originals):
                empty = label.startswith("without")
                if found is None:
                    drawn.append((label, original))
                    continue
                shown = original.copy()
                colour = (0, 0, 255) if empty else (0, 255, 0)
                cv2.rectangle(shown, (found[0], found[1]), (found[2], found[3]), colour, 2)
                cv2.putText(shown, f"{score:.2f}", (found[0], max(14, found[1] - 4)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, colour, 1, cv2.LINE_AA)
                drawn.append((label, shown))
            name = f"sheet-{row['name']}.png"
            _write_contact_sheet(drawn, os.path.join(CAPTURE_ROOT, name))
            sheets.append(name)

        rows = object_localisers.compare(
            inputs.crops, with_frames, without_frames,
            with_sources=inputs.with_sources, on_result=draw,
            template_usable=inputs.template_usable,
        )
        # The raw score arrays are not sent: thirty floats per localiser tell a
        # reader nothing the min/median/max does not, and the page has no use
        # for them.
        summary = []
        for row in rows:
            if row.get("error"):
                summary.append({"name": row["name"], "error": row["error"]})
                continue
            summary.append({
                "name": row["name"],
                "ms": row["ms"],
                "boxed": row["boxed"],
                "of": row["of"],
                "separates": row["separates"],
                "threshold": row["threshold"],
                "recall": row["recall"],
                "false_rate": row["false_rate"],
                "with_median": round(statistics.median(row["with_scores"]), 2),
                "without_median": (round(statistics.median(row["without_scores"]), 2)
                                   if row["without_scores"] else None),
                "usable_references": row.get("usable_references"),
            })
        return {
            "rows": summary,
            "with_frames": len(with_frames),
            "without_frames": len(without_frames),
            "sheets": sheets,
            "references": len(inputs.references),
            "held_out": sum(1 for s in inputs.with_sources if s is None),
            "leave_one_out": sum(1 for s in inputs.with_sources if s is not None),
        }

    result = await run_in_threadpool(work)
    logger.info("object measurement by %s: %s", admin, result["rows"])
    return result


class ActivateRequest(BaseModel):
    method: str


@app.post("/objects/{object_id}/activate")
@limiter.limit("10/minute")
async def activate_classifier(
    request: Request, object_id: str, body: ActivateRequest, admin: str = Depends(require_admin)
) -> Dict[str, Any]:
    """Turns one Misura result into the thing live detection trusts.

    Deliberately a second, explicit step rather than Misura auto-adopting
    whichever method separated best: a later Misura run -- after a worse
    photo was added, say -- would otherwise silently replace a detector that
    was working. The administrator decides when a result is good enough to
    go live, same as they decide everything else that changes what the whole
    house detects.

    Re-runs the ONE chosen method itself, through the same
    _gather_measurement_inputs every Misura press uses, rather than trusting
    numbers the client could have sent: the server's own numbers are what
    gets stored, never the caller's.
    """

    def work() -> Dict[str, Any]:
        inputs = _gather_measurement_inputs(object_id)
        rows = object_localisers.compare(
            inputs.crops, inputs.with_frames, inputs.without_frames,
            with_sources=inputs.with_sources, only=body.method,
            template_usable=inputs.template_usable,
        )
        row = rows[0] if rows else None
        if row is None or row.get("error"):
            raise HTTPException(
                status_code=400,
                detail=row.get("error") if row else f"Metodo sconosciuto: {body.method}",
            )
        if row["threshold"] is None:
            raise HTTPException(
                status_code=400,
                detail="Questo metodo non separa con/senza per questo oggetto: non attivabile.",
            )
        ok = objects.set_measurement(
            object_id,
            method=row["name"],
            threshold=row["threshold_raw"],
            recall=row["recall"],
            false_rate=row["false_rate"],
            with_min=row["with_min"],
            without_max=row["without_max"],
            ms=row["ms"],
            with_frames=len(inputs.with_frames),
            without_frames=len(inputs.without_frames),
            # Template gets ONLY the references it was measured with. Storing
            # all twenty was the bug: the localiser kept the first six of the
            # list it was handed, and live detection read that list back in a
            # different order -- so it measured with one six and detected with
            # another. With six stored there is nothing left to truncate and
            # order stops mattering.
            references=(inputs.template_references if row["name"] == "template"
                        else inputs.references),
            measured_by=admin,
        )
        if not ok:
            raise HTTPException(status_code=404, detail="Oggetto non trovato.")
        classifier_detection.invalidate()
        record = objects.get_object(object_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Oggetto non trovato.")
        return {"object": _with_template_max(record), "objects": objects.list_objects()}

    result = await run_in_threadpool(work)
    logger.info("classifier activated: %s method=%s by %s",
                object_id, body.method, admin)
    return result


@app.get("/objects/sheet/{name}")
async def object_sheet(name: str, _admin: str = Depends(require_admin)) -> Response:
    """One contact sheet from the last measurement."""
    if name not in SHEET_NAMES:
        raise HTTPException(status_code=404, detail="Unknown sheet")
    path = os.path.join(CAPTURE_ROOT, name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Not measured yet")
    with open(path, "rb") as handle:
        data = handle.read()
    # Overwritten by the next measurement, so it must never be cached.
    return Response(content=data, media_type="image/png",
                    headers={"Cache-Control": "no-store"})


def _write_contact_sheet(rows: List[Any], path: str, columns: int = 4) -> None:
    """Everything a localiser drew, in one picture.

    A percentage hides a box that is technically on the object and useless in
    practice; only the picture shows that.
    """
    if not rows:
        return
    cell = 240
    thumbs = []
    for label, image in rows:
        scale = cell / max(image.shape[:2])
        small = cv2.resize(image, (int(image.shape[1] * scale), int(image.shape[0] * scale)))
        canvas = np.zeros((cell, cell, 3), np.uint8)
        canvas[: small.shape[0], : small.shape[1]] = small
        cv2.putText(canvas, str(label)[:22], (4, cell - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1, cv2.LINE_AA)
        thumbs.append(canvas)
    while len(thumbs) % columns:
        thumbs.append(np.zeros((cell, cell, 3), np.uint8))
    grid = np.vstack([np.hstack(thumbs[i:i + columns]) for i in range(0, len(thumbs), columns)])
    cv2.imwrite(path, grid)


# --- Detections reported by the browser --------------------------------


class ReportedDetection(BaseModel):
    """One detection as the page found it. Same shape as detection.Detection,
    so browser-side and server-side results are interchangeable."""

    label: str
    confidence: Optional[float] = None
    # (x1, y1, x2, y2) in pixels of the frame the page was looking at.
    bbox: Optional[Tuple[int, int, int, int]] = None


class DetectionsRequest(BaseModel):
    source: Literal["remote"]
    detections: List[ReportedDetection]


def handle_detections(source: str, detections: List[ReportedDetection]) -> None:
    """Called for every batch the browser reports. Deliberately does nothing.

    THIS IS THE HOOK: put whatever should happen on a detection here.

    Two things to keep in mind before wiring that up:
      - Several pages can report at once, and they will disagree. Decide
        whether the first, the last or a consensus wins.
      - The browser only reports when the set of labels changes, plus a slow
        heartbeat -- so this is edge-driven, not a steady stream. Do not rely
        on it being called at any particular rate.
    """


@app.post("/detections", dependencies=[Depends(require_session)])
@limiter.limit("120/minute")
async def report_detections(
    request: Request, body: DetectionsRequest
) -> Dict[str, Any]:
    """Where the browser sends what it detected, so the server can act on it.

    The page draws its own boxes; nothing here affects what it displays. This
    exists purely so detection moving off the Pi does not also move it out of
    reach of the hardware attached to the Pi.
    """
    labels = [d.label for d in body.detections]
    logger.info(
        "detections from %s: %s",
        body.source,
        ", ".join(sorted(set(labels))) if labels else "(none)",
    )
    handle_detections(body.source, body.detections)
    return {"received": len(body.detections)}


# --- Which devices are connected, and which one is sharing ------------

# A device is forgotten this long after its last heartbeat. Long enough to ride
# out a slow request or a phone briefly losing WiFi, short enough that closing a
# tab does not leave a ghost in the list for minutes.
DEVICE_TIMEOUT_SECONDS = 20


class DeviceRegistry:
    """Tracks the pages that currently have the app open, and which one is
    publishing its camera.

    Sessions alone cannot answer this: every device signs in as the same user,
    so the cookie says who but never which. Each page therefore makes up an id
    of its own and repeats it on every heartbeat.

    Exists because sharing had no owner. Every page rendered its own sharing
    button, so a second device could start publishing over the first, and the
    stream flipped between whichever frame arrived last."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._devices: Dict[str, Dict[str, Any]] = {}
        self._publisher: Optional[str] = None
        # Set by request_stop() when someone asks the current publisher to give
        # up the stream. /camera_feed reads it once per frame and closes.
        self._stop_requested = False
        # Set by request_start() when an administrator asks a device to begin
        # sharing. The device reads it off its own next /presence beat and
        # starts its camera. Only ONE device can be asked at a time -- the same
        # rule as publishing, decided in the same place, so a second request
        # cannot leave two pages both trying to become the publisher.
        self._start_requested: Optional[str] = None

    def _expire_locked(self) -> None:
        cutoff = time.time() - DEVICE_TIMEOUT_SECONDS
        for client_id in [k for k, v in self._devices.items() if v["last_seen"] < cutoff]:
            del self._devices[client_id]
            # A publisher that stopped answering is no longer publishing,
            # otherwise nobody else could ever take over.
            if self._publisher == client_id:
                self._publisher = None
                self._stop_requested = False

    def heartbeat(self, client_id: str, label: str, username: str) -> None:
        with self._lock:
            self._devices[client_id] = {
                "label": label,
                "username": username,
                "last_seen": time.time(),
            }
            self._expire_locked()

    def claim_publisher(self, client_id: str) -> bool:
        """True when this device may publish. False when another live device
        already is -- first come, first served, rather than letting the last
        connection silently win."""
        with self._lock:
            self._expire_locked()
            if self._publisher is not None and self._publisher != client_id:
                return False
            self._publisher = client_id
            # A stop asked of the PREVIOUS publisher must not cut this one off
            # the moment it starts.
            self._stop_requested = False
            return True

    def release_publisher(self, client_id: str) -> None:
        with self._lock:
            if self._publisher == client_id:
                self._publisher = None
                self._stop_requested = False

    def request_stop(self) -> Optional[str]:
        """Asks whoever is publishing to stop, so another device is not stuck
        watching a stream it did not start and cannot end. Returns the device
        that was asked, or None when nobody is sharing."""
        with self._lock:
            self._expire_locked()
            self._start_requested = None
            if self._publisher is None:
                return None
            self._stop_requested = True
            return self._publisher

    def request_start(self, client_id: str) -> bool:
        """Asks one device to start sharing its camera. False when there is no
        such device -- one that has gone quiet cannot be asked anything.

        Whoever is publishing now is asked to stop in the same breath: there is
        only ever one publisher, so a request aimed at a second device would
        otherwise be refused at the handshake and look like a dead button.
        """
        with self._lock:
            self._expire_locked()
            if client_id not in self._devices:
                return False
            if self._publisher is not None and self._publisher != client_id:
                self._stop_requested = True
            self._start_requested = client_id
            return True

    def take_start_request(self, client_id: str) -> bool:
        """True exactly once, to the device that was asked.

        Consumed rather than read, so a page that restarts its camera and beats
        again is not told to start over and over from one click.
        """
        with self._lock:
            if self._start_requested != client_id:
                return False
            self._start_requested = None
            return True

    @property
    def stop_requested(self) -> bool:
        with self._lock:
            return self._stop_requested

    @property
    def publisher(self) -> Optional[str]:
        with self._lock:
            self._expire_locked()
            return self._publisher

    def snapshot(self) -> List[Dict[str, Any]]:
        with self._lock:
            self._expire_locked()
            now = time.time()
            return [
                {
                    "client_id": client_id,
                    "label": device["label"],
                    "username": device["username"],
                    "sharing": client_id == self._publisher,
                    "seconds_ago": round(now - device["last_seen"], 1),
                }
                for client_id, device in sorted(
                    self._devices.items(), key=lambda kv: kv[1]["label"]
                )
            ]


devices = DeviceRegistry()


class PresenceRequest(BaseModel):
    # Made up by the page and kept in localStorage, so the same browser keeps
    # the same identity across reloads.
    client_id: str
    # Human-readable, e.g. "Chrome su Android". Shown in the device list.
    label: str
    # Only the PUBLISHING device sends this: how far behind its upload is
    # running, in milliseconds, measured on its own clock (a ping it echoes
    # against itself, plus the time its send queue will take to drain). It is
    # reported here so the server can pass it on to every other page, which
    # otherwise has no way to know how old the picture it is watching is.
    # Optional, so an older page that does not send it still works.
    upload_ms: Optional[float] = None


@app.post("/presence", dependencies=[Depends(require_session)])
@limiter.limit("120/minute")
async def presence(
    request: Request, body: PresenceRequest, username: str = Depends(require_session)
) -> Dict[str, Any]:
    """Heartbeat. Every open page calls this every few seconds; the answer is
    the list of devices, so one round trip both registers and refreshes.

    It also carries the state that lives on the SERVER and is shared by every
    page: which camera is selected and what is being detected. Each page used
    to keep private copies of those, so a page never learned that another one
    had changed them -- which is why picking a different detection class on one
    device left the others detecting the old one, and why a freshly opened page
    reset the camera source and cut off whoever was sharing."""
    client_id = body.client_id[:64]
    devices.heartbeat(client_id, body.label[:64], username)
    # Taken only from the device that actually owns the stream. Without that
    # check any page could report a delay for a stream it is not sending, and
    # the number every other page shows would be whatever arrived last.
    if body.upload_ms is not None and client_id == devices.publisher:
        share_meter.report_upload(body.upload_ms)
    return {
        "devices": devices.snapshot(),
        "publisher": devices.publisher,
        # True on ONE beat, to ONE device: an administrator asked it to start
        # sharing. The page starts its camera when it sees this. Consumed on
        # read, so one click cannot make it restart for ever.
        "share_requested": devices.take_start_request(client_id),
        # What THIS device is to see: the server machine's camera, switched on
        # but not shared, is "none" to everybody except the server machine.
        "source": "none" if _withheld_from(client_id) else camera.source,
        "camera_shared": camera.shared,
        # The server machine's camera is on (shared or not): a page that opens
        # must not switch it off by turning on its own.
        "server_camera_on": False,
        "device_index": camera.device_index,
        "detection_config": camera.detection_config,
        # One setting shared by every device, so each page shows what the
        # camera is actually doing rather than what it last asked for.
        "video_encoding": camera.video_encoding,
        # Somebody has Avvia on for the Pi's webcam, on any page: so a page
        # that did not press it can still say the strip is filling up.
        "server_camera_saving": (server_camera_detection.count() > 0
                                 or server_camera_text.saving_count() > 0),
        "client_is_server": _client_is_server(request),
        # Lets the page label the camera buttons for the machine that is
        # actually running the server. On a Windows PC "Videocamere del
        # Raspberry" and "/dev/video0" are simply untrue, and the only working
        # button looked like it needed hardware that is not plugged in.
        "server_is_pi": RUNNING_ON_PI,
        # The server's half of the sharing measurements: the rate frames really
        # arrive at, and how old one is when it leaves here. None when nothing
        # is being shared, which is also when the page hides the box.
        "share_meter": share_meter.snapshot(),
        # This server understands the text ping the publisher uses to time its
        # uplink. A page must NOT send that ping until it has seen this flag:
        # an older /camera_feed reads the socket with receive_bytes(), which
        # RAISES on a text frame rather than ignoring it, so one ping ends the
        # share with a bare 1006. That is not hypothetical -- it is what
        # happened the first time the page was rebuilt without restarting the
        # server, and from the outside it looks like sharing turning itself off
        # a few seconds after being switched on.
        "echoes_ping": True,
        # How many pictures the strip holds and which is newest, so each page
        # can tell from its heartbeat that another device's camera found
        # something -- see /detect_ws.
        "saved": await run_in_threadpool(detections.summary),
    }


@app.post("/stop_sharing", dependencies=[Depends(require_session)])
@limiter.limit("30/minute")
async def stop_sharing(request: Request) -> Dict[str, Any]:
    """Ends whoever's share is currently running, from any device.

    Without this a viewer is stuck: the publisher owns the single stream, so
    everyone else watches a camera they cannot turn off, and the only way out
    was to walk over to the sharing device."""
    stopped = devices.request_stop()
    if stopped is not None:
        logger.info("stop of %s requested by another device", stopped)
    return {"stopped": stopped}


@app.get("/devices")
async def connected_devices(_admin: str = Depends(require_admin)) -> Dict[str, Any]:
    """The device list, read WITHOUT registering the caller as a device.

    /presence is a heartbeat: it registers whoever calls it. The
    administration page only wants to look, and a page that appeared in its own
    list -- and could be asked to share its own camera -- would be confusing
    rather than useful.
    """
    return {"devices": devices.snapshot(), "publisher": devices.publisher,
            "source": camera.source}


@app.get("/admin/notifications")
async def list_notifications(_admin: str = Depends(require_admin)) -> Dict[str, Any]:
    """Events worth an administrator's attention, until one of them dismisses
    each -- see notifications.py. Separate from the admin page's own LIVE
    checks (a classifier with too many photos, say), which are computed fresh
    from objects.py each time rather than stored here."""
    return {"notifications": await run_in_threadpool(notifications.list_active)}


@app.post("/admin/notifications/{notification_id}/dismiss")
@limiter.limit("60/minute")
async def dismiss_notification(
    request: Request, notification_id: str, admin: str = Depends(require_admin)
) -> Dict[str, Any]:
    ok = await run_in_threadpool(notifications.dismiss, notification_id, admin)
    if not ok:
        raise HTTPException(status_code=404, detail="Notifica non trovata.")
    return {"notifications": await run_in_threadpool(notifications.list_active)}


@app.post("/admin/notifications/dismiss_all")
@limiter.limit("20/minute")
async def dismiss_all_notifications(
    request: Request, admin: str = Depends(require_admin)
) -> Dict[str, Any]:
    """Clears the whole list in one go. Not an error when it was already empty:
    the page offers the button from a count it read seconds ago, and somebody
    else dismissing the last one in between is not a failure of this request."""
    cleared = await run_in_threadpool(notifications.dismiss_all, admin)
    if cleared:
        logger.info("%s dismissed %d notifications", admin, cleared)
    return {"cleared": cleared,
            "notifications": await run_in_threadpool(notifications.list_active)}


class ShareRequest(BaseModel):
    client_id: str


@app.post("/share_request")
@limiter.limit("30/minute")
async def share_request(
    request: Request, body: ShareRequest, admin: str = Depends(require_admin)
) -> Dict[str, Any]:
    """Asks one device to turn its camera on and send it here.

    Two limits that are the browser's, not this server's, and cannot be coded
    around: the tab that captures shows a recording indicator, and the
    operating system may show its own light -- nothing can be put on the page
    to remove those. And getUserMedia only succeeds without a click on a device
    that has already granted this site camera permission persistently, so this
    works on a device that has shared before and cannot be made to work on one
    that never has.
    """
    asked = devices.request_start(body.client_id[:64])
    if not asked:
        raise HTTPException(status_code=404, detail="That device is not connected")
    # The source has to be "remote" before the device's socket arrives, or
    # /camera_feed refuses it with 4409 and the request looks like a dead
    # button. Done here rather than left to the page: asking a device to share
    # IS asking for the remote source, and the page would only be guessing at
    # the order.
    if camera.source != "remote":
        await run_in_threadpool(camera.set_source, "remote", None)
    logger.info("share of %s requested by %s", body.client_id[:64], admin)
    return {"requested": body.client_id[:64]}


# --- Camera streaming -------------------------------------------------

CAMERA_SOURCES = ("picamera", "usb", "remote", "none")

# See CameraManager.probe_devices: webcams are probed one request at a time.
_PROBE_LOCK = threading.Lock()
# Viewers are async coroutines sharing one frame, so extra ones are cheap
# (measured: +0.3% CPU for the 2nd viewer). Headroom matters here because a
# page returning from the background opens a new stream before the old
# connection is always reaped -- too low a limit turns that into a 503.
MAX_STREAM_VIEWERS = 4

frame_hub = FrameHub()
# The two numbers only this process can take: the rate frames actually arrive
# from the publisher, and how old one already is when it goes out to a viewer.
# Reported on /presence and shown in the page's "Diagnostica" box.
share_meter = ShareMeter()
_stream_semaphore = threading.Semaphore(MAX_STREAM_VIEWERS)


class CameraManager:
    """Owns everything about the capture state: which source is selected, how
    many pages are watching, and the capture thread itself.

    THE RULE THIS CLASS EXISTS TO ENFORCE: never hold `_lock` while opening,
    closing or waiting on a camera. Opening a camera takes seconds and stopping
    a capture thread takes up to 2 seconds. FastAPI runs every `async def`
    endpoint on one single thread, so if an endpoint waits for this lock, the
    whole server stops answering everyone.

    Its methods therefore come in two kinds, and each endpoint must pick the
    right one:

      FAST  - viewer_connected(), viewer_disconnected(), apply_detection_config()
              Touch only counters and dictionaries. Safe to call directly
              inside an endpoint.

      SLOW  - set_source(), probe_devices(), wait_for_frame()
              Wait on capture threads and camera hardware. Must always be
              called through run_in_threadpool, which moves them to a separate
              thread and leaves the server free to answer other requests.
    """

    def __init__(self, source: str, device_index: int) -> None:
        self._lock = threading.Lock()
        self._source = source
        self._device_index = device_index
        self._viewer_count = 0
        self._worker: Optional[LocalCameraWorker] = None
        # True while a slow camera operation is running WITHOUT the lock held
        # (a scan, or a source switch). It tells _sync_worker() not to start a
        # capture thread in the meantime, because that thread would try to open
        # the very camera the slow operation is currently using.
        self._busy = False
        # The live detection settings. This exact dictionary object is handed
        # to LocalCameraWorker and to annotate(), so apply_detection_config()
        # changes its contents IN PLACE. Replacing it with a new dictionary
        # would leave the capture thread reading the old one.
        self.detection_config: DetectionConfig = dict(DETECTION_CONFIG)
        # Whether the server machine's own camera is SHOWN to the other devices.
        # False keeps the camera running and visible on the server machine's own
        # pages, and hides it from everybody else. Has no meaning for the other
        # sources.
        self.shared = True
        # While it is not shared: the one page (client id) that switched the
        # camera on and still sees it.
        self.shared_owner: Optional[str] = None
        # Likewise by reference: apply_video_encoding() mutates this very
        # dictionary, and the capture thread reads it on its next frame.
        #
        # It is ONE setting for the whole machine, not one per page, because
        # the camera encodes each frame once and every viewer is sent that same
        # JPEG. A page therefore reads the current value back from /presence
        # instead of remembering its own.
        self.video_encoding: Dict[str, int] = dict(VIDEO_ENCODING)
        # Whoever wants the camera's raw frames to detect and save them (see
        # ServerCameraDetection). Held HERE rather than on a worker, because
        # workers are rebuilt on every source switch, viewer change and failed
        # open; each new one is handed this on creation.
        self._frame_listener: Optional[Any] = None

    # --- read-only views -------------------------------------------------

    @property
    def source(self) -> str:
        with self._lock:
            return self._source

    @property
    def device_index(self) -> int:
        with self._lock:
            return self._device_index

    @property
    def viewer_count(self) -> int:
        with self._lock:
            return self._viewer_count

    # --- FAST: safe to call directly from an endpoint --------------------

    def apply_detection_config(self, new_config: DetectionConfig) -> None:
        """Changes what is detected. Takes effect on the next frame; the
        camera keeps running untouched."""
        with self._lock:
            self.detection_config.update(new_config)

    def apply_video_encoding(self, new_encoding: Dict[str, int]) -> None:
        """Changes how heavy the picture is. Takes effect on the next frame;
        the camera keeps running untouched."""
        with self._lock:
            self.video_encoding.update(new_encoding)

    def set_frame_listener(self, listener: Optional[Any]) -> None:
        """Offers every raw frame the local camera produces to `listener`
        (None stops it). Applies to the running worker at once and to every
        later one. The listener runs on the capture thread and must return
        immediately."""
        with self._lock:
            self._frame_listener = listener
            if self._worker is not None:
                self._worker.frame_listener = listener

    def viewer_connected(self) -> None:
        with self._lock:
            self._viewer_count += 1
            self._sync_worker_locked()

    def viewer_disconnected(self) -> None:
        with self._lock:
            self._viewer_count = max(0, self._viewer_count - 1)
            self._sync_worker_locked()


    # --- SLOW: always call through run_in_threadpool ---------------------

    def set_source(self, source: str, device_index: Optional[int] = None) -> None:
        if source not in CAMERA_SOURCES:
            raise ValueError(f"Unknown camera source {source!r}, expected one of {CAMERA_SOURCES}")

        with self._lock:
            # Nothing about the camera itself changed (e.g. this call only
            # carried a new detection_config) -- leave the running capture
            # alone rather than tearing the camera down and back up for
            # no reason.
            unchanged = source == self._source and (
                device_index is None or device_index == self._device_index
            )
            if unchanged and self._worker is not None:
                return
            self._source = source
            if device_index is not None:
                self._device_index = device_index
            # Hand the old capture thread out of the object, then stop it below
            # with the lock released, so nobody waits on us meanwhile.
            old_worker, self._worker = self._worker, None
            self._busy = True

        try:
            if old_worker is not None:
                old_worker.stop(wait=True)
            # The previous source's last frame is now stale -- clear it so
            # readiness checks (see wait_for_frame) don't mistake it for a
            # frame from the new source.
            frame_hub.clear()
        finally:
            with self._lock:
                self._busy = False
                self._sync_worker_locked()

    def wait_for_frame(self, timeout: float) -> bool:
        """Waits until the selected source has produced its first frame, so
        callers can tell "switched" apart from "actually showing something"."""
        deadline = time.monotonic() + timeout
        while frame_hub.get_latest_jpeg() is None and time.monotonic() < deadline:
            time.sleep(SOURCE_READY_POLL_INTERVAL)
        return frame_hub.get_latest_jpeg() is not None

    def probe_devices(self, indices: range) -> List[int]:
        """Finds which camera numbers actually exist by trying to open each
        one: OpenCV offers no way to list cameras, only to open one and see
        whether it answers.

        The running capture is stopped first, because a camera can only be
        open once at a time and would otherwise report itself as missing.

        One probe at a time: every page that opens asks for one, and two at
        once each held the webcam open for the other -- measured, neither saw
        it (10 out of 10). The second simply waits for the first."""
        with _PROBE_LOCK:
            with self._lock:
                old_worker, self._worker = self._worker, None
                self._busy = True

            try:
                if old_worker is not None:
                    old_worker.stop(wait=True)

                found: List[int] = []
                for idx in indices:
                    cap = None
                    try:
                        # On Windows, try multiple backends to find real cameras
                        # and avoid phantom devices. Try DSHOW first, then MSMF.
                        backends = []
                        if platform.system() == "Windows":
                            backends = [cv2.CAP_DSHOW, cv2.CAP_MSMF, cv2.CAP_ANY]
                        else:
                            backends = [cv2.CAP_ANY]

                        for backend in backends:
                            cap = cv2.VideoCapture(idx, backend)
                            if cap.isOpened():
                                # Read multiple frames to verify the camera works
                                # and skip phantom devices that return empty frames.
                                valid_frames = 0
                                for _ in range(3):
                                    ok, frame = cap.read()
                                    if ok and frame is not None and frame.size > 0:
                                        # Check frame is not all black/empty
                                        if frame.mean() > 1.0:
                                            valid_frames += 1
                                        else:
                                            break
                                    time.sleep(0.05)

                                cap.release()
                                cap = None

                                # Require at least 2 valid frames to consider camera real
                                if valid_frames >= 2:
                                    found.append(idx)
                                    break  # Found working backend, try next index

                            if cap is not None:
                                cap.release()

                    except cv2.error as error:
                        logger.warning("camera %d did not answer the probe: %s", idx,
                                       str(error).strip()[:120])
                    finally:
                        if cap is not None:
                            cap.release()
                return found
            finally:
                with self._lock:
                    self._busy = False
                    self._sync_worker_locked()

    def _sync_worker_locked(self) -> None:
        """Starts or stops the capture thread so it matches the current state.
        Must be called with `_lock` held.

        Cheap on purpose: starting only creates a Python thread (the camera is
        opened inside it), and stopping uses wait=False, which just signals the
        thread instead of waiting for it. That is what makes the FAST methods
        above safe to call directly from an endpoint."""
        should_run = (
            self._viewer_count > 0
            and self._source in ("usb", "picamera")
            and not self._busy
        )
        # A worker whose thread has already ended is NOT capturing, even though
        # the object is still here. That is exactly what a camera which failed
        # to open leaves behind: _run_picamera prints the reason and returns.
        # Treating it as "running" made one failed open permanent -- nothing
        # below would ever build a new worker for that source again, for the
        # life of the process. Dropping it here means the next viewer to
        # connect (or the next source switch) retries the camera.
        #
        # A thread HUNG in capture_array() still reports alive, so this does
        # not rescue that case.
        if self._worker is not None and not self._worker.is_alive():
            self._worker = None
        if should_run and self._worker is None:
            self._worker = LocalCameraWorker(
                frame_hub,
                source=self._source,
                device_index=self._device_index,
                detection_config=self.detection_config,
                video_encoding=self.video_encoding,
            )
            self._worker.frame_listener = self._frame_listener
            self._worker.start()
        elif not should_run and self._worker is not None:
            self._worker.stop(wait=False)
            self._worker = None


_initial_source = CAMERA_SOURCE
if _initial_source not in CAMERA_SOURCES:
    logger.warning("invalid CAMERA_SOURCE=%r, falling back to 'none' (idle)", _initial_source)
    _initial_source = "none"

# No viewers exist yet at startup, so no capture thread is started here.
camera = CameraManager(_initial_source, CAMERA_DEVICE_INDEX)


class DetectionConfigRequest(BaseModel):
    """Mirrors detection.DETECTION_CONFIG. Every field optional so callers can
    send just the part they want to change."""

    backend: Optional[Literal["mediapipe", "yolo", "face", "classifier"]] = None
    # COCO_CLASSES keys to restrict YOLO to; None means "all 80 classes".
    yolo_classes: Optional[List[int]] = None
    # Where detection runs. "browser" makes the server publish raw frames; see
    # the comment on DETECTION_CONFIG in detection.py.
    location: Optional[Literal["browser", "server"]] = None
    # Hands the server's hand detector follows, when detection runs there.
    num_hands: Optional[Literal[1, 2]] = None
    # Which classifier (objects.py) to look for; only used when
    # backend == "classifier". Validated in set_source, not here: that needs
    # objects.db, which a pydantic validator has no clean way to reach.
    object_id: Optional[str] = None
    # False: the Raspberry's own camera publishes its picture with no detection
    # (Osserva and Avvia off). Only the page of that camera sends it.
    active: Optional[bool] = None

    @field_validator("yolo_classes")
    @classmethod
    def _validate_classes(cls, value: Optional[List[int]]) -> Optional[List[int]]:
        if value is not None:
            unknown = [i for i in value if i not in COCO_CLASSES]
            if unknown:
                raise ValueError(f"Unknown COCO class indices: {unknown}")
        return value


class SourceRequest(BaseModel):
    source: Literal["picamera", "usb", "remote", "none"]
    # Only for the server machine's own camera: show it to the other devices
    # (True) or not (False). Left out, it is unchanged -- except that switching
    # TO such a camera shares it.
    shared: Optional[bool] = None
    # The page asking; the one page that keeps seeing an unshared camera.
    client_id: Optional[str] = Field(None, max_length=64)
    # Which physical camera to use for "usb" (ignored for the other sources).
    # See /camera_devices for discovering which indices actually exist.
    device_index: Optional[int] = None
    # Optional detection settings; applied before the readiness wait so the
    # first frame of the new source already uses them.
    detection_config: Optional[DetectionConfigRequest] = None


SOURCE_READY_TIMEOUT = 5.0
SOURCE_READY_POLL_INTERVAL = 0.05
# How long a source switch keeps the camera running on its own, until the
# page's video stream connects and counts as a viewer.
SOURCE_HOLD_SECONDS = 10.0


CAMERA_PROBE_RANGE = range(5)


@app.get("/camera_devices", dependencies=[Depends(require_session)])
@limiter.limit("5/minute")
async def camera_devices(request: Request) -> Dict[str, Any]:
    # run_in_threadpool because probing opens up to five cameras in a row,
    # which takes seconds of hardware work.
    devices = await run_in_threadpool(camera.probe_devices, CAMERA_PROBE_RANGE)
    # Reported so the interface can hide the Pi Camera button when no camera
    # module is attached, rather than offering a source that cannot work.
    picamera = await run_in_threadpool(picamera_available)
    return {"devices": devices, "picamera": picamera}


# Loopback, under any of the spellings a request can arrive with.
_LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"}


def _client_is_server(request: Request) -> bool:
    """True when the page making this request is running on the same machine
    as the backend. The frontend uses it to avoid decoding a video stream the
    server machine is not actually being used to watch.

    Two ways that can be true, and the second is the one that used to be
    missed:

    - the request came from loopback;
    - the peer address equals the LOCAL address the connection arrived on. A
      connection from a machine to itself over its own LAN IP has the same
      address at both ends, and a connection from anywhere else does not.

    This replaces a socket.getaddrinfo(socket.gethostname()) lookup and a
    300-second cache around it. On this Pi that lookup returns 127.0.1.1 and
    NOT 192.168.1.200, so opening the app ON the Pi at its own LAN address --
    precisely the case the function exists for -- was not recognised, and the
    Pi decoded a video stream it was already serving.

    Both values here come from the kernel socket (getpeername and getsockname,
    which is what uvicorn puts in scope["client"] and scope["server"]), so
    neither can be forged with a header the way X-Forwarded-For can.
    """
    client = request.client
    if not client:
        return False
    if client.host in _LOOPBACK:
        return True
    server = request.scope.get("server")
    return bool(server) and client.host == server[0]


def _withheld_from(client_id: Optional[str]) -> bool:
    """True when the server machine's own camera is on but not shared, and the
    page asking is not the one that switched it on.

    There is no server camera anymore: the server only ever relays frames a
    client chose to share, so this is always False.
    """
    return False


@app.post("/source", dependencies=[Depends(require_session)])
@limiter.limit("30/minute")
async def set_source(request: Request, body: SourceRequest) -> Dict[str, Any]:
    if body.detection_config is not None:
        new_config = body.detection_config.model_dump(exclude_unset=True)
        if new_config.get("backend") == "classifier":
            object_id = new_config.get("object_id")
            if not object_id:
                raise HTTPException(
                    status_code=400,
                    detail="Scegli un classificatore prima di selezionarlo per il rilevamento.",
                )
            measurement = await run_in_threadpool(objects.get_measurement, object_id)
            if measurement is None:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Questo classificatore non e' pronto per il rilevamento: "
                        "misuralo e attivalo prima (pagina « Foto di un oggetto »)."
                    ),
                )
        camera.apply_detection_config(new_config)
    # run_in_threadpool because set_source waits for the previous capture
    # thread to finish. Calling it directly would hold up every other request.
    previous_source = camera.source
    await run_in_threadpool(camera.set_source, body.source, body.device_index)
    if body.shared is not None:
        camera.shared = body.shared
    elif camera.source != previous_source:
        camera.shared = True
    if camera.shared:
        camera.shared_owner = None
    elif body.shared is False or camera.shared_owner is None:
        camera.shared_owner = body.client_id
    # "remote" frames come from the browser over /camera_feed, which it only
    # opens AFTER this call returns. The server has no local camera of its own
    # to wait for, so readiness is always False here: a page selecting "remote"
    # sees its own picture only once another client starts sharing.
    ready = False
    return {
        "source": camera.source,
        "shared": camera.shared,
        "device_index": camera.device_index,
        "detection_config": camera.detection_config,
        "ready": ready,
        "publishing": devices.publisher is not None,
        "client_is_server": _client_is_server(request),
    }


class VideoEncodingRequest(BaseModel):
    """How the local camera's frames should be encoded from now on.

    Four rungs are offered in the page; anything in range is accepted here.
    The floor is not arbitrary: a watching page runs face detection at 640 px
    and hand detection at 480 px and never scales a picture UP, so sending less
    than 320 px would start starving the detector rather than merely softening
    the picture.
    """
    width: int = Field(0, ge=0, le=1920)
    quality: int = Field(95, ge=30, le=100)


@app.post("/video_encoding", dependencies=[Depends(require_session)])
@limiter.limit("60/minute")
async def set_video_encoding(request: Request, body: VideoEncodingRequest) -> Dict[str, Any]:
    camera.apply_video_encoding(body.model_dump())
    return {"video_encoding": camera.video_encoding}


@app.get("/detection_classes", dependencies=[Depends(require_session)])
@limiter.limit("30/minute")
async def detection_classes(request: Request) -> Dict[str, Any]:
    """The COCO classes yolov8n can detect, so the frontend's picker stays in
    sync with COCO_CLASSES instead of hardcoding a copy that could drift out
    of step with the indices the backend actually filters on."""
    return {
        "classes": COCO_CLASSES,
        "classes_it": COCO_CLASSES_IT,
        "detection_config": camera.detection_config,
    }


# The model files the browser needs in order to detect for itself. Served from
# the project root rather than copied into frontend/dist, because together they
# are ~20 MB and the build output is rebuilt (and gitignored) constantly.
# Explicit allow-list, not a directory mount: the name arrives in the URL, and
# anything else there would let a caller walk the filesystem.
BROWSER_MODELS = {
    "efficientdet_lite0.tflite": "application/octet-stream",
}


@app.get("/models/{name}", dependencies=[Depends(require_session)])
async def browser_model(name: str) -> FileResponse:
    if name not in BROWSER_MODELS:
        raise HTTPException(status_code=404, detail="Unknown model")
    path = os.path.join(os.path.dirname(__file__), name)
    if not os.path.exists(path):
        # Downloaded rather than shipped in the repo, from Google's
        # mediapipe-models bucket -- see detector.js:
        #   efficientdet_lite0.tflite
        raise HTTPException(status_code=404, detail=f"{name} is not on the server")
    # Long max-age: these files only change when the model itself is replaced,
    # and re-downloading 20 MB on every page load over WiFi is painful.
    return FileResponse(
        path,
        media_type=BROWSER_MODELS[name],
        headers={"Cache-Control": "public, max-age=604800"},
    )


# How often the stream checks for a new frame to send. It also sets the
# highest frame rate a viewer can receive: one frame per 0.05 s = 20 per
# second, even if the camera produces more.
FRAME_POLL_INTERVAL = 0.05


@app.get("/video_feed", dependencies=[Depends(require_session)])
async def video_feed(request: Request) -> StreamingResponse:
    if not _stream_semaphore.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="Too many active viewers")
    # Safe to call directly: viewer_connected only updates a counter and
    # creates a thread, it never waits for a camera.
    camera.viewer_connected()

    watch = SessionWatch(request.cookies)

    async def generator():
        try:
            last_sent = None
            while True:
                if await request.is_disconnected():
                    break
                if watch.revoked():
                    # Logged out, demoted or deleted while watching. There is
                    # no status code to send once the body has started, so the
                    # stream simply ends -- the browser's <img> stops, which is
                    # what it does on any interruption.
                    logger.info("ending an MJPEG stream: its session is no longer valid")
                    break
                jpeg = frame_hub.get_latest_jpeg()
                if jpeg is not None and jpeg is not last_sent:
                    last_sent = jpeg
                    yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
                await asyncio.sleep(FRAME_POLL_INTERVAL)
        finally:
            # This runs while the client is disconnecting, where `await` is not
            # allowed: the generator is being closed, and awaiting inside a
            # closing generator raises instead of finishing. viewer_disconnected
            # is written to never wait, so it can be called plainly here.
            camera.viewer_disconnected()
            _stream_semaphore.release()

    return StreamingResponse(
        generator(), media_type="multipart/x-mixed-replace; boundary=frame"
    )


# How often the frame-age line is written. Once a second is enough to see a
# trend without burying every other message in the log.
FRAME_AGE_LOG_INTERVAL = 1.0

# --- Reaping viewers that are gone without having said so -----------------
#
# THE BUG THESE EXIST TO FIX: a phone that leaves the WiFi -- walks out of
# range, or switches from the home network to the Pi's own access point --
# never closes its socket. The TCP connection stays ESTABLISHED on this side
# with its send buffer full:
#
#     Recv-Q  Send-Q  Local Address:Port   Peer Address:Port
#     0       435256  192.168.1.200:8000   192.168.1.108:57356
#
# uvicorn does send keepalive pings (20 s interval, 20 s timeout), but a ping
# is data too: with the buffer already full it cannot be written, so it never
# goes out, no pong ever fails to arrive, and nothing times out. The coroutine
# sits in receive_text() for ever holding one of MAX_STREAM_VIEWERS permits.
# Four disappearing phones and every viewer is told "Troppi dispositivi stanno
# guardando il video" with nobody watching at all.
#
# So the application does its own reaping, on all three places it can wait:

# The viewer asks for the next frame as soon as it has drawn the last one,
# which is milliseconds. Thirty seconds of silence means it is gone.
VIEWER_IDLE_TIMEOUT = 30.0
# Handing one JPEG to the socket is milliseconds too. If it has not completed
# in this long, the peer has stopped reading -- the full-buffer case above.
VIEWER_SEND_TIMEOUT = 15.0
# While waiting for the camera to produce a frame, poke the socket this often
# so a peer that died during a long idle period is still noticed. The viewer
# ignores these; see the `typeof event.data === "string"` guard in App.jsx.
VIEWER_KEEPALIVE_INTERVAL = 10.0

# The buffer the viewer may ask for, in seconds, and the frame rate used to turn
# that into a number of frames. The publisher's timer runs at ~10 fps, so ten
# frames is about a second of pictures whatever the link is doing -- it is the
# CAPTURE rate that decides how many frames a second of footage contains, not
# the rate they happen to arrive at.
# 15 s is 150 frames at the nominal rate, roughly 1 MB per viewer. Raised from
# 5 s because a buffer only rescues a stall it can hold: measured, a 7-second
# freeze lost 136 frames through a 3 s buffer, 137 through a 5 s one, and none
# at all through a 10 s one. Five seconds was a ceiling on how long a freeze
# could be survived, for no reason but the number.
MAX_VIEWER_BUFFER_SECONDS = 15.0
NOMINAL_PUBLISH_FPS = 10

# Pushed into a viewer's request queue by the task reading its socket, when that
# task stops -- which is the instant the viewer disconnects. Without it the
# sender waits out the full VIEWER_IDLE_TIMEOUT before it looks at whether the
# reader is still alive, and spends that time holding one of the
# MAX_STREAM_VIEWERS permits on behalf of somebody who has already gone.
#
# An object(), not a string: that queue otherwise carries only "next", and a
# sentinel a client could send by typing it is not a sentinel.
_VIEWER_GONE = object()


@app.websocket("/video_ws")
async def video_ws(websocket: WebSocket) -> None:
    """The viewer's video stream, one frame at a time, on request.

    This exists because MJPEG cannot be slowed down. /video_feed above pushes a
    frame every FRAME_POLL_INTERVAL whether or not the viewer drew the last one,
    and a browser's MJPEG decoder renders every frame it receives, in order,
    never skipping. Any frame that piles up in a socket buffer therefore becomes
    permanent delay -- the picture falls behind and never catches up, which is
    what the five-second lag was.

    Here the viewer asks for each frame, so the server never sends one nobody is
    ready for.

    `?buffer=<seconds>` decides what happens to the frames produced while the
    viewer was busy. At 0 they are dropped and the picture is always the newest
    one -- lowest delay, and the holes in the footage that come with it. Above
    0 they are kept in a queue of that many seconds and played in order, so the
    footage is complete at the cost of running that far behind. The queue is
    bounded: a viewer that falls a whole buffer behind is caught up to the
    present in one step, because draining a backlog it could not keep up with
    only makes it later still.

    Which of those is right is not something this code can know -- it depends on
    whether the link is merely bursty (a buffer removes the holes) or genuinely
    too slow (a buffer just adds delay to the same holes) -- so it is the
    viewer's choice, per device.

    /video_feed is deliberately left in place and working, as a fallback.
    """
    # Before the cookie, not after: the cookie is valid in this case -- it is
    # the PAGE asking that is not ours. Same 4401 either way, so a foreign page
    # learns nothing from the difference.
    if not _origin_allowed(websocket.headers.get("origin"), websocket.headers.get("host")):
        await websocket.close(code=4401)
        return
    if _read_session(websocket.cookies.get(SESSION_COOKIE)) is None:
        await websocket.close(code=4401)
        return
    watch = SessionWatch(websocket.cookies)
    viewer_id = websocket.query_params.get("client")
    if not _stream_semaphore.acquire(blocking=False):
        # Accept first so the browser gets a code it can explain, rather than a
        # failed handshake that looks identical to the server being down.
        await websocket.accept()
        await websocket.close(code=4503)  # too many viewers
        return

    # How many frames this viewer wants held for it. Clamped rather than
    # rejected: the number arrives in a URL and a page from a different version
    # -- or a hand-typed one -- must not be able to ask for an unbounded queue.
    try:
        buffer_seconds = float(websocket.query_params.get("buffer", "0"))
    except ValueError:
        buffer_seconds = 0.0
    buffer_seconds = max(0.0, min(MAX_VIEWER_BUFFER_SECONDS, buffer_seconds))
    # maxlen 1 is exactly the old behaviour: hold one frame, always the newest.
    buffer_frames = max(1, round(buffer_seconds * NOMINAL_PUBLISH_FPS))
    # `?double=` used to be read here, for a pair of queues that took turns. It
    # was built, measured and removed: two queues of N never beat one of 2N, and
    # a page from that version simply has the parameter ignored.

    # EVERYTHING after the acquire above must sit inside this try, because the
    # `finally` is the only thing that gives the permit back. accept() raises
    # when the browser dropped the handshake -- a fast reload, a tab closed
    # mid-connect, a phone putting the page to sleep -- and while that call sat
    # outside the try each occurrence burned one of MAX_STREAM_VIEWERS permits
    # for good. After four, every viewer got 4503 ("too many viewers") with
    # nobody watching, and only restarting the server cleared it.
    counted = False
    reader = None
    subscription = None
    try:
        await websocket.accept()
        # Same accounting as /video_feed: viewer counting is what starts the
        # capture and stops it when the last viewer leaves.
        camera.viewer_connected()
        counted = True

        # ONE task owns reading from this viewer, and it records the moment the
        # viewer last said ANYTHING -- a frame request, or an answer to a
        # keepalive. Reading in a separate task is what makes a suspended
        # viewer detectable: the loop below spends most of its life waiting for
        # a frame, and while it waits it cannot also be listening.
        #
        # A phone whose page is minimised is FROZEN by the browser. It stops
        # answering, `last_seen` stops moving, and the checks below give its
        # slot back. A viewer that is merely waiting on an idle camera keeps
        # answering, and keeps its slot.
        requests: "asyncio.Queue[object]" = asyncio.Queue()
        last_seen = time.monotonic()

        async def read_from_viewer() -> None:
            nonlocal last_seen
            try:
                while True:
                    message = await websocket.receive_text()
                    last_seen = time.monotonic()
                    # "next" is a request for a frame; anything else is the
                    # viewer answering a keepalive and needs nothing more than
                    # the timestamp above.
                    if message == "next":
                        await requests.put(message)
            finally:
                # Say that this viewer has gone, so the loop below stops
                # waiting for a request that can never come. Without it a
                # viewer that connects and leaves WITHOUT ever asking for a
                # frame keeps one of the four stream permits for the full
                # VIEWER_IDLE_TIMEOUT.
                #
                # put_nowait, not `await put`: the queue is unbounded so it
                # cannot block, and this also runs while the task is being
                # CANCELLED, where any await raises at once and would skip the
                # wake-up entirely.
                requests.put_nowait(_VIEWER_GONE)

        reader = asyncio.create_task(read_from_viewer())

        # Subscribed only after accept(), so a refused connection never leaves
        # a queue behind for frames nobody will ever collect.
        # Set when a frame lands for THIS viewer, so the wait below ends the
        # moment there is something to send instead of running to the end of a
        # fixed sleep. Measured before the change: a viewer asking with an empty
        # slot waited a median of 52 ms against a 50 ms poll, while one asking
        # with a frame already queued waited 3 ms -- the poll interval WAS the
        # delay, and it was also the ceiling on how fast any viewer could go.
        frame_ready = asyncio.Event()
        loop = asyncio.get_running_loop()

        def wake_for_frame() -> None:
            # Called from whichever thread produced the frame: the event loop
            # for a phone's stream, the capture thread for the Pi Camera.
            # asyncio.Event is not thread-safe, so the set() is handed to the
            # loop rather than done here. Harmless from the loop's own thread
            # too -- it simply schedules.
            try:
                loop.call_soon_threadsafe(frame_ready.set)
            except RuntimeError:
                # The loop is closing. The timeout below still fires, so the
                # worst case is the old behaviour rather than a stuck viewer.
                pass

        subscription = frame_hub.subscribe(buffer_frames, notify=wake_for_frame)
        logger.info(
            "viewer connected, buffering %.1f s (%d frames)",
            buffer_seconds, buffer_frames,
        )

        last_age_log = 0.0
        while True:
            # Waits for the viewer to ask. THIS is the backpressure: a viewer
            # that has not finished drawing simply has not asked yet.
            try:
                message = await asyncio.wait_for(
                    requests.get(), timeout=VIEWER_IDLE_TIMEOUT
                )
            except asyncio.TimeoutError:
                logger.info(
                    "dropping a viewer: silent for %.0fs", VIEWER_IDLE_TIMEOUT
                )
                break
            # Both checks, deliberately. The sentinel is what makes a viewer
            # that never asked for anything noticed AT ONCE rather than in
            # thirty seconds; reader.done() stays because it also covers a
            # reader that ended some other way. Keeping it means this only ever
            # ADDS a way out of the loop.
            #
            # Read after the get() rather than before, so a `next` already
            # queued ahead of the sentinel is still handled: that pass serves
            # its frame, and the next one breaks.
            if message is _VIEWER_GONE or reader.done():
                # The socket died; whatever ended the reader is the reason.
                logger.info("dropping a viewer: it disconnected")
                break

            # Measured against the clock, not counted in sleeps. The wait below
            # now ends early whenever a frame arrives, so adding a fixed
            # interval per pass would count time that did not pass and fire the
            # keepalive far too often.
            last_keepalive = time.monotonic()
            # "" while still here, then "disconnected" or "silent" -- which of
            # the two decides what gets logged, and they are not the same
            # event.
            gone = ""
            revoked = False
            while True:
                # Checked HERE and not only at the top of the outer loop: a
                # viewer waiting on an idle camera stays inside this inner loop
                # for up to VIEWER_IDLE_TIMEOUT, and a check it does not reach
                # is a check that does not exist. Measured: with the camera
                # producing nothing, revocation took 30 s to be noticed with
                # the test only above, and one interval with it here.
                if watch.revoked():
                    revoked = True
                    break
                # Cleared BEFORE the queue is checked, never after. A frame
                # landing between the check and the clear would have its
                # wake-up wiped, and this viewer would then wait out the whole
                # backstop for a frame that was already sitting there -- the
                # classic lost wake-up, and it would look exactly like the
                # stutter this change is meant to remove.
                frame_ready.clear()
                # The queue hands each frame over exactly once, so there is no
                # need to compare against the last one sent: an empty queue IS
                # "nothing new". With buffer=0 the queue holds one frame and
                # this behaves exactly as the single slot did.
                jpeg, stored_at, skipped = frame_hub.take(subscription)
                if jpeg is not None and _withheld_from(viewer_id):
                    # The server machine's camera is on but not shared: the
                    # frame is taken off the queue and not sent.
                    jpeg = None
                if jpeg is not None:
                    if skipped:
                        # Not "fell a full buffer behind" any more: with the
                        # buffer OFF the same count is one frame replaced by
                        # the next, which is not falling behind a buffer that
                        # does not exist. One wording has to cover both.
                        logger.info(
                            "viewer could not keep up: skipped %d frames", skipped
                        )
                        # Also recorded where the page can read it. This used
                        # to go to the log and nowhere else, so the one loss
                        # the buffer setting actually governs was invisible to
                        # the person turning the knob.
                        share_meter.frame_skipped(skipped)
                    break
                # Nothing new yet (camera idle, or nobody publishing). Wait to
                # be TOLD, rather than answering with a frame already on screen
                # or coming back on a timer.
                #
                # FRAME_POLL_INTERVAL survives as the backstop, not as the
                # pace: every check below it -- the keepalive, the disconnect,
                # the idle timeout, the revoked session -- still gets its turn
                # at least that often, so nothing that depended on this loop
                # ticking has changed. What has changed is that a frame no
                # longer has to wait for the tick.
                try:
                    await asyncio.wait_for(frame_ready.wait(), FRAME_POLL_INTERVAL)
                except asyncio.TimeoutError:
                    pass
                # A camera that produces nothing -- the Pi Camera with a dead
                # ribbon, or simply nobody sharing -- parks every viewer here
                # indefinitely. Ask whether it is still there.
                if time.monotonic() - last_keepalive >= VIEWER_KEEPALIVE_INTERVAL:
                    last_keepalive = time.monotonic()
                    await asyncio.wait_for(
                        websocket.send_text("waiting"),
                        timeout=VIEWER_SEND_TIMEOUT,
                    )
                # Two different things, told apart because the log line below
                # was reporting one as the other: a viewer whose socket has
                # CLOSED (reader.done) and one that is still connected but has
                # stopped answering (a frozen tab). While both said "no answer
                # for 30s", a viewer that had disconnected 60 ms earlier was
                # described as having been silent for half a minute -- which
                # sent me looking for a stall that was not there.
                if reader.done():
                    gone = "disconnected"
                    break
                if time.monotonic() - last_seen > VIEWER_IDLE_TIMEOUT:
                    gone = "silent"
                    break
            if revoked:
                # Logged out, demoted or deleted while watching. 4401 is the
                # same code the handshake refuses with, so the page treats it
                # the same way and sends the viewer back to the login form.
                logger.info("closing a viewer: its session is no longer valid")
                await websocket.close(code=4401)
                break
            if gone == "disconnected":
                logger.info("dropping a viewer: it disconnected while waiting for a frame")
                break
            if gone:
                logger.info(
                    "dropping a suspended viewer: no answer for %.0fs while it "
                    "waited for a frame",
                    VIEWER_IDLE_TIMEOUT,
                )
                break

            now = time.monotonic()
            # How stale the picture already is BEFORE it leaves the Pi. Small
            # here but laggy on screen means the delay is in the browser; large
            # here means it is the publisher's upload. Recorded every frame so
            # /presence can show it, and still logged occasionally so it is in
            # the record of a session nobody was watching the panel during.
            share_meter.frame_served(now - stored_at)
            if now - last_age_log >= FRAME_AGE_LOG_INTERVAL:
                last_age_log = now
                logger.info("frame age at send: %.0f ms", (now - stored_at) * 1000)
            # Bounded for the same reason as the receive above: a peer that
            # stopped reading leaves its socket buffer full, and without a
            # deadline this await never returns.
            await asyncio.wait_for(
                websocket.send_bytes(jpeg), timeout=VIEWER_SEND_TIMEOUT
            )
    except WebSocketDisconnect:
        pass
    except asyncio.TimeoutError:
        # Raised by either send above: the viewer is not reading any more.
        logger.info("dropping a viewer: send blocked for %.0fs", VIEWER_SEND_TIMEOUT)
    except RuntimeError as error:
        # Starlette raises this ("Cannot call send once a close message has
        # been sent") when the socket went away between the check and the
        # write. It means the same thing as a disconnect.
        logger.info("dropping a viewer: %s", error)
    finally:
        # The reader outlives the loop when we broke out of it, and a task
        # still awaiting on a socket nobody owns any more would keep this
        # coroutine's frame -- and its permit -- alive.
        if reader is not None:
            reader.cancel()
        # A queue left in the hub would keep being filled with frames for a
        # viewer that has gone, which is a slow leak of exactly the memory the
        # bound exists to cap.
        if subscription is not None:
            frame_hub.unsubscribe(subscription)
        # Only decrement what was actually counted: if accept() failed,
        # viewer_connected() never ran and this would drive the count negative
        # and stop the capture thread under a viewer that is still watching.
        if counted:
            camera.viewer_disconnected()
        _stream_semaphore.release()


def _annotate_to_jpeg(
    data: bytes, detect: bool, cached: Optional[List[Detection]]
) -> Tuple[Optional[bytes], Optional[List[Detection]]]:
    """Decode, draw on and re-encode one frame, returning it with the
    detections to reuse next time. Pure CPU work with no awaits, so it is safe
    to hand to a worker thread. The jpeg is None when the bytes are not a
    decodable image, or when re-encoding fails.

    `detect` false redraws `cached` instead of detecting again -- the same
    trade detection threading makes, for the same reason: detection costs
    hundreds of milliseconds while drawing costs microseconds."""
    frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        return None, cached
    if detect or cached is None:
        frame, cached = annotate(frame, camera.detection_config)
    else:
        frame = draw_detections(frame, cached)
    ok, jpeg = cv2.imencode(".jpg", frame)
    return (jpeg.tobytes() if ok else None), cached


# How long the publishing loop may wait for a frame before looking again at
# whether it has been asked to stop. Only reached when the publisher has gone
# quiet; a live stream wakes the loop ~10 times a second anyway.
STOP_CHECK_INTERVAL = 0.5


@app.websocket("/camera_feed")
async def camera_feed(websocket: WebSocket) -> None:
    # WebSocket connections cannot use Depends(require_session): FastAPI applies
    # dependencies like that to normal requests only. The browser still sends
    # the cookie automatically, so the check is done by hand here -- and the
    # automatic part is exactly why the origin is checked as well.
    if not _origin_allowed(websocket.headers.get("origin"), websocket.headers.get("host")):
        await websocket.close(code=4401)
        return
    if _read_session(websocket.cookies.get(SESSION_COOKIE)) is None:
        await websocket.close(code=4401)
        return
    watch = SessionWatch(websocket.cookies)
    if camera.source != "remote":
        await websocket.close(code=4409)  # source not set to "remote"
        return

    # Only one device may publish at a time. Without this a second page could
    # start sharing over the first and the stream flipped between whichever
    # frame arrived last, with no way to tell who was sending what.
    client_id = websocket.query_params.get("client", "")
    refusal = None
    if not client_id:
        refusal = 4400  # page too old to identify itself
    elif not devices.claim_publisher(client_id):
        refusal = 4408  # somebody else is already sharing
    if refusal is not None:
        # Accept first, then close with the code. Closing before accepting
        # fails the HTTP handshake instead, and the browser reports a generic
        # connection error with no code -- the page could not tell "someone
        # else is sharing" from "the server is down".
        await websocket.accept()
        await websocket.close(code=refusal)
        return

    await websocket.accept()
    logger.info("sharing started by %s", client_id)

    # The browser sends frames far faster than this hardware can annotate them
    # (a phone camera produces ~25 per second; detection manages 4-8). Receiving
    # and annotating in one loop meant every surplus frame waited its turn, so
    # what a viewer saw fell further behind reality the longer the stream ran --
    # eventually whole seconds. Receiving now runs in its own task that keeps
    # only the NEWEST frame, and anything arriving while the previous one is
    # still being annotated is dropped. Latency stays flat; the cost is skipped
    # frames, which is the right trade for a live view.
    newest: Optional[bytes] = None
    frame_index = 0
    cached_detections: Optional[List[Detection]] = None
    arrived = asyncio.Event()
    closed = asyncio.Event()

    async def receive_loop() -> None:
        nonlocal newest
        try:
            while True:
                # receive(), not receive_bytes(): the publisher also sends a
                # short TEXT ping once a second to time the uplink, and
                # receive_bytes() raises on a text frame rather than ignoring
                # it, which would end the share.
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                data = message.get("bytes")
                if data is None:
                    # The ping, echoed back untouched. The publisher put its own
                    # clock reading in it and compares it with its own clock on
                    # the way back, so the two machines never have to agree
                    # about the time -- only about the string.
                    text = message.get("text") or ""
                    if text.startswith("ping:"):
                        await websocket.send_text(text)
                    continue
                # Counted HERE, before anything decides whether to keep it:
                # this is what the publishing device actually got onto the
                # wire. Compared with the frames_received rate below, the gap
                # between the two is exactly how much this loop threw away.
                share_meter.frame_arrived()
                # Overwriting `newest` is the frame drop: an unprocessed frame
                # still sitting here is simply replaced by the fresher one.
                newest = data
                arrived.set()
        except WebSocketDisconnect:
            pass
        except RuntimeError:
            # The main loop closed the socket while this one was mid-send.
            pass
        finally:
            closed.set()
            arrived.set()  # wake the annotator so it can notice and stop

    receiver = asyncio.create_task(receive_loop())
    try:
        while True:
            # Someone pressed "Ferma" on another device. Closing with a code of
            # our own lets the publisher's page explain why its sharing ended,
            # instead of reporting a bare disconnection.
            if devices.stop_requested:
                await websocket.close(code=4410)
                break
            # A publisher whose account was logged out or deleted must stop
            # sending its camera, not only stop being able to watch.
            if watch.revoked():
                logger.info("ending a share: its session is no longer valid")
                await websocket.close(code=4401)
                break
            if newest is None:
                if closed.is_set():
                    break
                try:
                    # Bounded rather than an open wait, so the stop above is
                    # still noticed when the publisher has gone quiet without
                    # actually disconnecting.
                    await asyncio.wait_for(arrived.wait(), STOP_CHECK_INTERVAL)
                except asyncio.TimeoutError:
                    continue
                arrived.clear()
                continue
            # Claim the frame and clear the slot, so a frame arriving during
            # annotation is kept for the next pass instead of being lost.
            data, newest = newest, None
            # Counted here rather than in receive_loop: this is the rate frames
            # are USED at. Counting arrivals would report what the phone sent
            # even when the server dropped most of it, which is the opposite of
            # what the measurement is for.
            share_meter.frame_received()
            if camera.source != "remote":
                break
            if (
                camera.viewer_count == 0
                or camera.detection_config.get("location") == "browser"
            ):
                # Two reasons to store the client's JPEG untouched:
                #   - nobody is watching, so decode + detection + re-encode
                #     would burn ~40% CPU on output no one sees;
                #   - detection runs in the browser, so the server has no
                #     drawing left to do at all.
                # Either way a viewer sees an image immediately, because what
                # the client sent is already a JPEG.
                frame_hub.update(data)
                continue
            # run_in_threadpool because annotate() is ~130-230 ms of CPU work on
            # a Pi 4. Run inline it would block the event loop for that long,
            # stalling the receive task above -- which would rebuild the very
            # backlog this function exists to avoid.
            jpeg, cached_detections = await run_in_threadpool(
                _annotate_to_jpeg,
                data,
                frame_index % DETECT_EVERY == 0,
                cached_detections,
            )
            frame_index += 1
            if jpeg is not None:
                frame_hub.update(jpeg)
    except WebSocketDisconnect:
        pass
    finally:
        receiver.cancel()
        devices.release_publisher(client_id)
        logger.info("sharing stopped by %s", client_id)
        # Drop the last frame this publisher sent. Without this it stays in the
        # hub and every other viewer keeps showing it, so a camera that stopped
        # sharing looks like a live picture that happens to be very still.
        frame_hub.clear()
        # Same reasoning for the numbers: a rate left standing after the stream
        # stopped describes a stream that no longer exists.
        share_meter.reset()



# --- Detection for own-camera devices ---------------------------------------
#
# A device showing its OWN camera -- a phone, or a PC on its own webcam -- runs
# no detection library: measured on a phone, in-browser hand detection took
# ~120 ms a pass and the live view lagged behind it. It sends frames here
# instead, over /detect_ws, and shows its camera untouched. When the server
# finds something it keeps a few pictures of it (detections.py), and every
# page shows them in the strip in the corner of the video.

# One batch: up to this many pictures, at least SAVED_MIN_GAP seconds apart,
# closed after SAVED_BATCH_MAX seconds even if it is short of pictures. Nothing
# is saved -- or even detected -- for SAVED_PAUSE seconds after that.
SAVED_PER_BATCH = 3
SAVED_MIN_GAP = 0.5
SAVED_BATCH_MAX = 3.0
SAVED_PAUSE = 5.0
SAVED_JPEG_QUALITY = 85
# Hands and objects: a frame is not kept when its sharpness inside the detected
# boxes is below this fraction of the median of the device's recent frames --
# relative, because a fixed number does not carry from one camera or scene to
# another. Nothing is dropped until SHARPNESS_MIN_HISTORY frames have been seen.
SHARPNESS_KEEP_FRACTION = 0.5
SHARPNESS_HISTORY = 20
SHARPNESS_MIN_HISTORY = 5
# And a floor under both, whatever the recent frames were like: a camera that
# is blurred all the time used to pass the relative rule above. Measured with
# face_embedding.sharpness() on the detected box scaled so its longer side is
# SHARPNESS_SIZE px, faces and hands and objects alike, so one number means the
# same for all of them. Not on the face's 112 px aligned crop: when the face
# is near the edge of the crop, alignment fills the rest with black, and that
# border read a face blurred to 34 as 202. On a test portrait blurred step by
# step, 100 keeps the slightly soft pictures (115 and up) and drops the
# clearly blurred ones (78, 41).
SAVE_MIN_SHARPNESS = 100.0
SHARPNESS_SIZE = 112
# The boxes sent back for the device's own video: a face keeps the name it was
# given for this long, then is recognised again. A face is followed from one
# frame to the next by how much its box overlaps its box in the frame before.
BOX_RECOGNISE_EVERY = 1.0
BOX_TRACK_MIN_IOU = 0.3
# The device's position is attached to a picture only if it is at most this
# old: a phone that lost its signal minutes ago is no longer where it said.
POSITION_MAX_AGE = 60.0
# At most one "face not saved" line per device this often, in the terminal.
SKIP_LOG_EVERY = 1.0

_COCO_IT_BY_NAME = {
    name: COCO_CLASSES_IT.get(index, name) for index, name in COCO_CLASSES.items()
}


def _jpeg(frame: Any) -> Optional[bytes]:
    ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, SAVED_JPEG_QUALITY])
    return encoded.tobytes() if ok else None





class DetectSession:
    """One own-camera device's frames, detected on a thread of its own.

    Only the newest frame is kept: anything arriving while a pass runs replaces
    the one waiting, so a slow detector skips frames instead of falling behind.
    """

    def __init__(self, device: str, send: Any, save: bool = True,
                 send_boxes: bool = True, origin: Optional[str] = None) -> None:
        self.device = device
        self.origin = origin
        # False for the Pi's own webcam: the page already draws boxes there (it
        # detects faces itself, or the camera worker burns them into the
        # stream), and a second set from here would be double-drawn and a
        # whole detection pass behind. See ServerCameraDetection.
        self._send_boxes = send_boxes
        self._ready_sent = False
        # Called from this thread with one message for the device: the boxes
        # of every frame, and the pictures kept.
        self._send = send
        # Boxes are always detected and sent for this device's own video --
        # see _process()'s docstring. This decides only whether anything
        # found gets WRITTEN: "Ferma" (detectOn=false in the page) still
        # shows what the classifier finds, it just keeps none of it.
        # NOT self._save: that name belongs to the method below, and assigning
        # a bool over it made every frame that found something raise "'bool'
        # object is not callable" -- silently, see _run's handler.
        self._keep = save
        # Faces of the last frame: {"bbox", "identity", "at"}, see _boxes.
        self._tracks: List[Dict[str, Any]] = []
        # The device's last position ({"lat", "lon", "accuracy"}) and when it
        # arrived; see set_position.
        self._position: Optional[Dict[str, Any]] = None
        self._position_at = 0.0
        self._skip_logged_at = 0.0
        # Whether this session has already written a full traceback; see _run.
        self._logged_fault = False
        self._lock = threading.Lock()
        self._frame: Any = None
        self._frame_meta: Optional[Dict[str, Any]] = None
        self._last_saved_pause_key: Optional[str] = None
        self._latest_video_seek_id = 0
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._batch: Optional[str] = None
        self._batch_started = 0.0
        self._batch_count = 0
        self._last_saved = 0.0
        self._pause_until = 0.0
        self._sharpness: "collections.deque[float]" = collections.deque(maxlen=SHARPNESS_HISTORY)
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def set_position(self, lat: float, lon: float, accuracy: Optional[float]) -> None:
        with self._lock:
            self._position = {"lat": lat, "lon": lon, "accuracy": accuracy}
            self._position_at = time.monotonic()

    def set_video_seek_id(self, seek_id: int) -> None:
        with self._lock:
            self._latest_video_seek_id = max(self._latest_video_seek_id, seek_id)

    def _video_frame_is_current(self, frame_meta: Optional[Dict[str, Any]]) -> bool:
        if frame_meta is None:
            return True
        with self._lock:
            return frame_meta["seek_id"] >= self._latest_video_seek_id

    def _current_position(self) -> Optional[Dict[str, Any]]:
        with self._lock:
            if self._position and time.monotonic() - self._position_at <= POSITION_MAX_AGE:
                return dict(self._position)
        return None

    def _log_skipped(self, reason: str) -> None:
        """Why a face was not put in the strip, for finding out why a group of
        people gave no pictures. Throttled: faces are looked at every frame."""
        now = time.monotonic()
        if now - self._skip_logged_at < SKIP_LOG_EVERY:
            return
        self._skip_logged_at = now
        logger.info("face not saved (%s): %s", self.device or "device", reason)

    def offer(self, data: bytes,
              frame_meta: Optional[Dict[str, Any]] = None) -> None:
        with self._lock:
            self._frame = data
            self._frame_meta = frame_meta
            if frame_meta is not None:
                self._latest_video_seek_id = max(
                    self._latest_video_seek_id, frame_meta["seek_id"]
                )
        self._wake.set()

    def offer_frame(self, frame: Any, found: Optional[List[Any]]) -> None:
        """A frame that is already decoded, with the detections the camera made
        on it (None if it made none). Same rule as offer(): only the newest is
        kept."""
        with self._lock:
            self._frame = (frame, found)
            self._frame_meta = None
        self._wake.set()

    def stop(self) -> None:
        # Not joined: a pass in progress cannot be interrupted, and the thread
        # is a daemon that ends when it finishes.
        self._stop.set()
        self._wake.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            if not self._wake.wait(timeout=0.5):
                self._close_if_expired(time.monotonic())
                continue
            with self._lock:
                data, self._frame = self._frame, None
                frame_meta, self._frame_meta = self._frame_meta, None
                self._wake.clear()
            if data is None or self._stop.is_set():
                continue
            try:
                saved = (
                    self._process_frame(*data, frame_meta=frame_meta)
                    if isinstance(data, tuple)
                    else self._process(data, frame_meta)
                )
            except Exception as error:  # noqa: BLE001
                # One bad frame must not end detection for this device -- but a
                # fault that repeats on every frame is not a bad frame, it is a
                # bug, and this line is how one hid for two days: the message
                # alone ("'bool' object is not callable"), once per frame, with
                # no traceback and no type to search the code for. The first one
                # now carries both.
                if not self._logged_fault:
                    self._logged_fault = True
                    logger.exception(
                        "detection on a sent frame failed (%s); the rest of this "
                        "session's are logged as one-line warnings",
                        type(error).__name__,
                    )
                else:
                    logger.warning("detection on a sent frame failed: %s: %s",
                                   type(error).__name__, error)
                continue
            if saved:
                self._send({"type": "saved", "entries": saved})

    def _close_if_expired(self, now: float) -> None:
        if self._batch is not None and now - self._batch_started >= SAVED_BATCH_MAX:
            self._close(now)

    def _close(self, now: float) -> None:
        self._batch = None
        self._batch_count = 0
        self._pause_until = now + SAVED_PAUSE

    def _process(self, data: bytes,
                 frame_meta: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """A frame as a phone sends it: JPEG bytes."""
        frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            return []
        return self._process_frame(frame, None, frame_meta)

    def _process_frame(self, frame: Any, found: Optional[List[Any]] = None,
                       frame_meta: Optional[Dict[str, Any]] = None
                       ) -> List[Dict[str, Any]]:
        """The pictures kept from this frame. Every frame is detected, and its
        boxes sent at once, for the device's video; the pause and the gap
        between two pictures of a batch only decide whether anything is SAVED.

        `found` is what the camera already detected on this very frame, when it
        did (server-side detection on the Pi's webcam): reused, so a classifier
        or YOLO pass is not paid for twice. It is only trusted while the config
        still says detection runs on the server -- if it was moved to the
        browser while the frame waited, or the backend is faces (the camera has
        no face detector), this detects for itself as it always did."""
        now = time.monotonic()
        self._close_if_expired(now)
        config = dict(camera.detection_config)
        backend = config.get("backend")
        if found is not None and config.get("location") != "server":
            found = None
        if found is None:
            found = detect(frame, config)
        # Sent BEFORE saving: recognising and writing the pictures of a batch
        # took up to 2 s, and the boxes waiting behind it went stale on screen.
        if self._send_boxes:
            boxes = self._boxes(frame, backend, found, now)
            if frame_meta is not None:
                boxes["frame_meta"] = frame_meta
            self._send(boxes)
        elif not self._ready_sent:
            # No boxes on this path, so the page is told once that the first
            # frame has been looked at: that is what clears "Avvio rilevamento".
            self._ready_sent = True
            self._send({"type": "ready", "backend": backend})
        if (
            not found
            or not self._keep
            or (frame_meta is not None and not frame_meta["save"])
            or not self._video_frame_is_current(frame_meta)
        ):
            return []
        pause_key = frame_meta.get("pause_key") if frame_meta else None
        if pause_key and pause_key == self._last_saved_pause_key:
            return []
        if now < self._pause_until:
            return []
        if self._batch is not None and now - self._last_saved < SAVED_MIN_GAP:
            return []

        started_batch = self._batch is None
        if started_batch:
            self._batch = secrets.token_hex(8)
            self._batch_started = now
        saved = self._save(frame, backend, found, config.get("object_id"))
        if not saved:
            # Nothing in this frame was clear enough to keep: it does not count
            # as a picture of the batch, and does not start one either.
            if started_batch:
                self._batch = None
            return []
        self._batch_count += 1
        self._last_saved = time.monotonic()
        if pause_key:
            self._last_saved_pause_key = pause_key
        if self._batch_count >= SAVED_PER_BATCH:
            self._close(self._last_saved)
        return saved

    def _boxes(self, frame: Any, backend: Optional[str], found: List[Any],
               now: float) -> Dict[str, Any]:
        """What the device draws over its own video, in the pixels of the frame
        it sent (w x h). An empty list clears its boxes."""
        height, width = frame.shape[:2]
        items: List[Dict[str, Any]] = []
        self._tracks = []
        for d in found:
            item: Dict[str, Any] = {
                "bbox": [float(v) for v in d["bbox"]],
                "label": d.get("label"),
                "confidence": d.get("confidence"),
            }
            if d.get("points"):
                item["points"] = [[float(x), float(y)] for x, y in d["points"]]
            items.append(item)
        return {"type": "boxes", "w": width, "h": height, "backend": backend, "items": items}

    def _save(self, frame: Any, backend: Optional[str], found: List[Any],
              object_id: Optional[str] = None) -> List[Dict[str, Any]]:
        height, width = frame.shape[:2]
        # Hands and objects: one entry per frame, with everything drawn on it --
        # unless the frame is blurred compared with this device's recent ones.
        x1 = max(0, min(int(d["bbox"][0]) for d in found))
        y1 = max(0, min(int(d["bbox"][1]) for d in found))
        x2 = min(width, max(int(d["bbox"][2]) for d in found))
        y2 = min(height, max(int(d["bbox"][3]) for d in found))
        if x2 - x1 < 8 or y2 - y1 < 8:
            return []
        sharp = float(cv2.Laplacian(frame[y1:y2, x1:x2], cv2.CV_64F).var())
        history = sorted(self._sharpness)
        self._sharpness.append(sharp)
        crop = frame[y1:y2, x1:x2]
        scale = SHARPNESS_SIZE / max(x2 - x1, y2 - y1)
        scaled = cv2.resize(crop, (max(1, round((x2 - x1) * scale)), max(1, round((y2 - y1) * scale))), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
        if float(cv2.Laplacian(scaled, cv2.CV_64F).var()) < SAVE_MIN_SHARPNESS:
            return []
        if len(history) >= SHARPNESS_MIN_HISTORY:
            median = history[len(history) // 2]
            if sharp < SHARPNESS_KEEP_FRACTION * median:
                return []
        drawn = draw_detections(frame.copy(), found)
        jpeg = _jpeg(drawn)
        if jpeg is None:
            return []
        kind = "object"
        names = sorted({_COCO_IT_BY_NAME.get(d.get("label"), str(d.get("label"))) for d in found})
        label = ", ".join(names)
        # object_id is set only for a classifier match, not a YOLO class: it is
        # what lets the strip offer "Aggiungi al classificatore" for one but
        # not the other, carried through the boxes field since it is free-form
        # JSON already (see detections.py) rather than a new DB column.
        boxes = [
            {"bbox": list(d["bbox"]), "label": d.get("label"), "object_id": object_id}
            for d in found
        ]
        return [detections.add_entry(kind, label, jpeg, boxes, device=self.device,
                                     batch=self._batch or "",
                                     position=self._current_position(),
                                     origin=self.origin)]


# --- Live text finding -------------------------------------------------------
#
# "Leggi testo" switched on: the frames of a device are read (text_reader.
# read_live: only confident lines), the boxes with their words go back to be
# drawn over the video, and a view that keeps showing text is kept in the strip
# like a detected face, with the words of the pass that found it.

# A text area must be present in this many passes in a row before anything is
# kept: one pass of a moving camera finds all sorts of things.
TEXT_STABLE_PASSES = 2
# At least this long between two views kept (a page held still would otherwise
# be kept again and again).
TEXT_SAVE_GAP = 10.0


def _same_line(left: Dict[str, Any], right: Dict[str, Any]) -> bool:
    """The same line of text in two passes: similar words, boxes that overlap."""
    def plain(text: str) -> str:
        return "".join(c for c in text.casefold() if c.isalnum())
    a, b = plain(left["text"]), plain(right["text"])
    if not a or not b or difflib.SequenceMatcher(None, a, b).ratio() < 0.8:
        return False
    return _iou([float(v) for v in left["box"]], [float(v) for v in right["box"]]) >= 0.3


class TextSession:
    """One device's frames searched for text, on a thread of its own. Same
    shape as DetectSession (offer, offer_frame, set_position, stop), so the same
    two websockets can run either. Only the newest frame is kept."""

    def __init__(self, device: str, send: Any, save: bool = True,
                 send_boxes: bool = True, origin: Optional[str] = None) -> None:
        self.device = device
        self.origin = origin
        self._send = send
        self._keep = save
        self._position: Optional[Dict[str, Any]] = None
        self._position_at = 0.0
        self._lock = threading.Lock()
        self._frame: Any = None
        self._frame_meta: Optional[Dict[str, Any]] = None
        self._last_saved_pause_key: Optional[str] = None
        self._latest_video_seek_id = 0
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._ready_sent = False
        self._reading = False
        self._streak = 0
        # The lines of the pass before: a line counts only once it has been seen
        # twice in a row, in the same place with the same words.
        self._previous: List[Dict[str, Any]] = []
        self._last_try = 0.0
        self._last_signature: Optional[Tuple[int, bytes]] = None
        self._logged_fault = False
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def set_position(self, lat: float, lon: float, accuracy: Optional[float]) -> None:
        with self._lock:
            self._position = {"lat": lat, "lon": lon, "accuracy": accuracy}
            self._position_at = time.monotonic()

    def set_video_seek_id(self, seek_id: int) -> None:
        with self._lock:
            self._latest_video_seek_id = max(self._latest_video_seek_id, seek_id)

    def _video_frame_is_current(self, frame_meta: Optional[Dict[str, Any]]) -> bool:
        if frame_meta is None:
            return True
        with self._lock:
            return frame_meta["seek_id"] >= self._latest_video_seek_id

    def _current_position(self) -> Optional[Dict[str, Any]]:
        with self._lock:
            if self._position and time.monotonic() - self._position_at <= POSITION_MAX_AGE:
                return dict(self._position)
        return None

    def offer(self, data: bytes,
              frame_meta: Optional[Dict[str, Any]] = None) -> None:
        with self._lock:
            self._frame = data
            self._frame_meta = frame_meta
        self._wake.set()

    def offer_frame(self, frame: Any, found: Optional[List[Any]]) -> None:
        with self._lock:
            self._frame = frame
            self._frame_meta = None
        self._wake.set()

    def set_keep(self, keep: bool) -> None:
        """Whether views are kept in the strip (False: boxes only)."""
        self._keep = keep

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(timeout=0.5)
            with self._lock:
                data, self._frame = self._frame, None
                frame_meta, self._frame_meta = self._frame_meta, None
                self._wake.clear()
            if data is None or self._stop.is_set():
                continue
            try:
                frame = data if not isinstance(data, (bytes, bytearray)) else cv2.imdecode(
                    np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
                if frame is not None:
                    self._process(frame, frame_meta)
            except text_reader.ReaderUnavailable as error:
                self._send({"type": "error", "detail": str(error)})
                return
            except Exception as error:  # noqa: BLE001
                if not self._logged_fault:
                    self._logged_fault = True
                    logger.exception("text finding failed (%s)", type(error).__name__)
                else:
                    logger.warning("text finding failed: %s: %s", type(error).__name__, error)

    def _process(self, frame: Any,
                 frame_meta: Optional[Dict[str, Any]] = None) -> None:
        height, width = frame.shape[:2]
        seen = text_reader.read_live(frame)
        # A line is shown and counted only when the pass before had the same
        # words in about the same place: a two-letter read of a face ("BD")
        # comes and goes from one pass to the next, a label does not.
        lines = [line for line in seen if any(_same_line(line, old) for old in self._previous)]
        self._previous = seen
        # Sent first, like DetectSession: the boxes are what is on screen. Only
        # confident lines: see text_reader.LIVE_MIN_CONFIDENCE.
        boxes_message = {
            "type": "boxes", "w": width, "h": height, "backend": "text",
            "items": [{"bbox": [float(v) for v in line["box"]], "label": line["text"]}
                      for line in lines],
        }
        if frame_meta is not None:
            boxes_message["frame_meta"] = frame_meta
        self._send(boxes_message)
        # "Ready" after the first pass: the engine is loaded and working, which is
        # what the page's "Caricamento..." was waiting for.
        if not self._ready_sent:
            self._ready_sent = True
            self._send({"type": "ready", "backend": "text"})
        # Text has been seen but not confirmed yet (it needs two passes in a row):
        # the page says "Lettura in corso..." until a box can be drawn.
        reading = bool(seen) and not lines
        if reading != self._reading:
            self._reading = reading
            self._send({"type": "text_status", "reading": reading})
        if not lines:
            self._streak = 0
            return
        self._streak += 1
        now = time.monotonic()
        pause_key = frame_meta.get("pause_key") if frame_meta else None
        if (not self._keep
            or (frame_meta is not None and not frame_meta["save"])
            or (pause_key and pause_key == self._last_saved_pause_key)
            or not self._video_frame_is_current(frame_meta)
            or self._streak < TEXT_STABLE_PASSES
                or now - self._last_try < TEXT_SAVE_GAP):
            return
        jpeg = _jpeg(frame)
        if jpeg is None:
            return
        signature = object_dupes.signature(jpeg)
        if (signature is not None and self._last_signature is not None
                and object_dupes.is_near_copy(signature, self._last_signature)):
            return
        self._last_try = now
        self._last_signature = signature
        text = "\n".join(line["text"] for line in lines)
        if len(text) > OCR_MAX_TEXT_CHARS:
            return
        boxes = []
        for line in lines[:OCR_MAX_LINES]:
            x1, y1, x2, y2 = line["box"]
            x1, x2 = max(0, min(width - 1, x1)), max(0, min(width - 1, x2))
            y1, y2 = max(0, min(height - 1, y1)), max(0, min(height - 1, y2))
            if x2 - x1 < 2 or y2 - y1 < 2:
                continue
            cv2.rectangle(frame, (x1, y1), (x2, y2), (64, 192, 87), 2)
            boxes.append({"bbox": [x1, y1, x2, y2], "label": None})
        drawn = _jpeg(frame)
        if drawn is None:
            return
        first = lines[0]["text"]
        label = first if len(first) <= 40 else first[:39].rstrip() + "…"
        entry = detections.add_text_entry(text, "scene", label, drawn, boxes,
                                          device=self.device,
                                          position=self._current_position(),
                                          origin=self.origin)
        if pause_key:
            self._last_saved_pause_key = pause_key
        self._send({"type": "saved", "entries": [entry]})


# Who the entries saved from the Pi's own webcam are filed under: the frames are
# the Raspberry's, not those of the page that pressed the button.
SERVER_CAMERA_DEVICE = "Webcam del Raspberry"
# Seconds between two frames the shared session looks at: 3 a second. Saving
# needs a few pictures a second, not thirty, and on a 4-core Pi a face pass at
# the camera's own rate would compete with the page's detector and the video.
SERVER_SESSION_EVERY = 1 / 3


class ServerCameraDetection:
    """ONE detect-and-save session for the Pi's webcam, shared by every page that
    pressed Avvia.

    A session per page would save the same moment once per page: two people
    pressing Avvia would get two batches of three pictures of the same face.
    So the first page to join creates the session and registers it with the
    camera, and the last to leave stops it and takes it down again.
    """

    def __init__(self, make_session: Any = None) -> None:
        # Builds the session the first page creates: (device, send) -> session.
        self._make_session = make_session or (
            lambda device, send: DetectSession(device, send, save=True, send_boxes=False)
        )
        self._lock = threading.Lock()
        self._subscribers: Dict[int, Any] = {}
        # Per page: does it want what is found kept? The shared session keeps
        # it if any page does.
        self._keeps: Dict[int, bool] = {}
        self._next_id = 0
        self._session: Optional[Any] = None
        self._last_offer = 0.0
        self._ready = False

    def count(self) -> int:
        with self._lock:
            return len(self._subscribers)

    def saving_count(self) -> int:
        with self._lock:
            return sum(1 for keep in self._keeps.values() if keep)

    def _apply_keep(self) -> None:
        session = self._session
        if session is not None and hasattr(session, "set_keep"):
            session.set_keep(any(self._keeps.values()))

    def join(self, send: Any, keep: bool = True) -> int:
        """Adds a page. `send(message)` is called from the session's thread."""
        with self._lock:
            self._next_id += 1
            sid = self._next_id
            self._subscribers[sid] = send
            self._keeps[sid] = keep
            if self._session is None:
                self._ready = False
                self._session = self._make_session(SERVER_CAMERA_DEVICE, self._broadcast)
                camera.set_frame_listener(self._on_frame)
            self._apply_keep()
            ready = self._ready
        if ready:
            # The first frame was looked at before this page arrived: say so,
            # or its "Avvio rilevamento" would never clear.
            send({"type": "ready"})
        return sid

    def leave(self, sid: int) -> None:
        with self._lock:
            self._subscribers.pop(sid, None)
            self._keeps.pop(sid, None)
            self._apply_keep()
            if self._subscribers or self._session is None:
                return
            session, self._session = self._session, None
        camera.set_frame_listener(None)
        session.stop()

    def _broadcast(self, message: Dict[str, Any]) -> None:
        if message.get("type") == "ready":
            self._ready = True
        with self._lock:
            targets = list(self._subscribers.values())
        for send in targets:
            try:
                send(message)
            except Exception:  # noqa: BLE001
                # One page that went away must not stop the others hearing.
                pass

    def _on_frame(self, frame: Any, found: Optional[List[Any]]) -> None:
        """Called by the camera on its own thread: so it only counts the time
        and hands over, never detects."""
        now = time.monotonic()
        if now - self._last_offer < SERVER_SESSION_EVERY:
            return
        session = self._session
        if session is None:
            return
        self._last_offer = now
        session.offer_frame(frame, found)


server_camera_detection = ServerCameraDetection()
# The same, for the live text finder. Never both at once: the camera has room
# for one frame listener, and the Pi cannot run both passes anyway.
server_camera_text = ServerCameraDetection(
    lambda device, send: TextSession(device, send, save=True)
)


@app.websocket("/camera_detect_ws")
async def camera_detect_ws(websocket: WebSocket) -> None:
    """Avvia, for the Pi's own webcam: detect and save what it sees. Unlike
    /detect_ws nothing is uploaded -- the frames are the camera's own -- so this
    socket carries only "ready" and "saved" back."""
    if not _origin_allowed(websocket.headers.get("origin"), websocket.headers.get("host")):
        await websocket.close(code=4401)
        return
    if _read_session(websocket.cookies.get(SESSION_COOKIE)) is None:
        await websocket.close(code=4401)
        return
    watch = SessionWatch(websocket.cookies)
    await websocket.accept()
    # 4409: "this is not available now", which the page treats as an answer
    # rather than a fault, so it does not keep retrying.
    if camera.source != "usb":
        await websocket.close(code=4409)
        return
    # ?mode=text: the live text finder instead of Avvia's detect-and-save. The
    # camera has one frame listener, so while one of the two runs the other is
    # refused with the same "not available now".
    holder, other = ((server_camera_text, server_camera_detection)
                     if websocket.query_params.get("mode") == "text"
                     else (server_camera_detection, server_camera_text))
    if other.count() > 0:
        await websocket.close(code=4409)
        return

    loop = asyncio.get_running_loop()
    outbox: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue()
    sid = holder.join(
        lambda message: loop.call_soon_threadsafe(outbox.put_nowait, message),
        keep=websocket.query_params.get("save") != "0",
    )
    # The camera only runs while somebody watches. This page is watching, but
    # its video socket and this one come and go separately.
    camera.viewer_connected()

    async def send_messages() -> None:
        while True:
            message = await outbox.get()
            await websocket.send_text(json.dumps(message))

    sender = asyncio.create_task(send_messages())
    try:
        while True:
            try:
                message = await asyncio.wait_for(websocket.receive(), STOP_CHECK_INTERVAL)
            except asyncio.TimeoutError:
                message = None
            if watch.revoked():
                await websocket.close(code=4401)
                break
            if camera.source != "usb":
                await websocket.close(code=4409)
                break
            if message is None:
                continue
            if message["type"] == "websocket.disconnect":
                break
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        holder.leave(sid)
        camera.viewer_disconnected()
        sender.cancel()


@app.websocket("/detect_ws")
async def detect_ws(websocket: WebSocket) -> None:
    # The same two checks /camera_feed makes, for the same reasons.
    if not _origin_allowed(websocket.headers.get("origin"), websocket.headers.get("host")):
        await websocket.close(code=4401)
        return
    if _read_session(websocket.cookies.get(SESSION_COOKIE)) is None:
        await websocket.close(code=4401)
        return
    watch = SessionWatch(websocket.cookies)
    await websocket.accept()

    client_id = websocket.query_params.get("client", "")[:64]
    device = next(
        (d["label"] for d in devices.snapshot() if d["client_id"] == client_id), ""
    )
    # "0" opts out of saving -- see DetectSession's own comment. Anything
    # else, including leaving it off entirely, keeps today's default: save.
    save = websocket.query_params.get("save") != "0"
    loop = asyncio.get_running_loop()
    outbox: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue()
    # ?mode=text: look for text in the frames instead of faces, hands, objects.
    send = lambda message: loop.call_soon_threadsafe(outbox.put_nowait, message)
    origin = (
        "Rilevato da un video"
        if websocket.query_params.get("origin") == "video"
        else None
    )
    if websocket.query_params.get("mode") == "text":
        session = TextSession(device, send, save=save, origin=origin)
    else:
        session = DetectSession(device, send, save=save, origin=origin)

    async def send_messages() -> None:
        # Straight back to the device that sent the frames: the boxes for its
        # video, and the pictures kept, so its own strip does not wait for the
        # next heartbeat.
        while True:
            message = await outbox.get()
            await websocket.send_text(json.dumps(message))

    sender = asyncio.create_task(send_messages())
    pending_frame_meta: Optional[Dict[str, Any]] = None
    try:
        while True:
            try:
                message = await asyncio.wait_for(websocket.receive(), STOP_CHECK_INTERVAL)
            except asyncio.TimeoutError:
                message = None
            if watch.revoked():
                await websocket.close(code=4401)
                break
            if message is None:
                continue
            if message["type"] == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data:
                session.offer(data, pending_frame_meta)
                pending_frame_meta = None
                continue
            text = message.get("text")
            if text:
                try:
                    control = json.loads(text)
                except (ValueError, TypeError):
                    control = None
                if isinstance(control, dict) and control.get("type") == "frame_meta":
                    pending_frame_meta = _valid_detection_frame_meta(control)
                    continue
                if (
                    isinstance(control, dict)
                    and control.get("type") == "video_seek"
                ):
                    seek_id = control.get("seek_id")
                    if type(seek_id) is int and seek_id >= 0:
                        session.set_video_seek_id(seek_id)
                    continue
                _take_position(session, text)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        session.stop()
        sender.cancel()


def _valid_detection_frame_meta(message: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    frame_id = message.get("frame_id")
    seek_id = message.get("seek_id")
    media_time = message.get("media_time")
    paused = message.get("paused")
    save = message.get("save")
    pause_key = message.get("pause_key")
    if (
        type(frame_id) is not int
        or type(seek_id) is not int
        or isinstance(media_time, bool)
        or not isinstance(media_time, (int, float))
        or not math.isfinite(media_time)
        or media_time < 0
        or type(paused) is not bool
        or type(save) is not bool
    ):
        return None
    if paused and (not isinstance(pause_key, str) or len(pause_key) > 128):
        return None
    return {
        "frame_id": frame_id,
        "seek_id": seek_id,
        "media_time": media_time,
        "paused": paused,
        "pause_key": pause_key if paused else None,
        "save": save,
    }


def _take_position(session: "DetectSession", text: str) -> None:
    """{"type": "position", "lat", "lon", "accuracy"} from the device; anything
    else, or anything out of range, is ignored."""
    try:
        message = json.loads(text)
        if message.get("type") != "position":
            return
        position = _valid_position(message.get("lat"), message.get("lon"),
                                   message.get("accuracy"))
    except (ValueError, TypeError, KeyError, AttributeError):
        return
    if position:
        session.set_position(position["lat"], position["lon"], position["accuracy"])


def _valid_position(lat: Any, lon: Any, accuracy: Any) -> Optional[Dict[str, Any]]:
    """{"lat", "lon", "accuracy"} when the numbers are real coordinates, else
    None. The one rule for every place a device tells the server where it is --
    the detection websocket and the OCR save both -- so they cannot come to
    disagree about what counts as a position."""
    try:
        lat, lon = float(lat), float(lon)
        accuracy = float(accuracy) if accuracy is not None else None
    except (ValueError, TypeError):
        return None
    # NaN fails both comparisons below, which is the point of writing them so.
    if -90 <= lat <= 90 and -180 <= lon <= 180:
        return {"lat": lat, "lon": lon, "accuracy": accuracy}
    return None


@app.get("/detections_saved", dependencies=[Depends(require_session)])
async def list_saved_detections() -> Dict[str, Any]:
    entries = await run_in_threadpool(detections.list_entries)
    return {"entries": entries, "count": len(entries)}


# --- Reading text ---------------------------------------------------------

def _jpeg_bytes(encoded: str) -> Optional[bytes]:
    """The raw bytes of a base64 picture (a data: URL is fine), or None."""
    if encoded.startswith("data:") and "," in encoded[:64]:
        encoded = encoded.split(",", 1)[1]
    try:
        return base64.b64decode(encoded, validate=False)
    except (binascii.Error, ValueError):
        return None


#: How long a person's read waits for the reader before it is refused: a
#: background read of the live text takes up to about 8 s.
OCR_WAIT_SECONDS = 15.0

#: One read at a time. Tesseract takes about a second of a CPU core, the Pi has
#: four, and the video is streaming from the same process: two presses stacking
#: would be felt by everyone watching. A second press gets an answer, not a queue.
_ocr_lock = threading.Lock()

# What a read can hold, and so what a save is willing to accept back. A page of
# dense print is about 60 lines and 3,000 characters; these leave room for
# several, and stop a request from using the encrypted store as a file drop.
OCR_MAX_LINES = 200
OCR_MAX_LINE_CHARS = 1000
OCR_MAX_TEXT_CHARS = 20_000


class OcrRequest(BaseModel):
    image: str = Field(max_length=MAX_CAPTURE_B64)
    # scene: RapidOCR, text in a photograph. text / codes: Tesseract. See
    # text_reader.py for what each was measured on.
    mode: Literal["scene", "text", "codes"] = "scene"
    # A small soft crop (a tapped area): enlarged and sharpened before reading.
    # Scene mode only; see text_reader.enhance.
    sharpen: bool = False


@app.post("/ocr")
@limiter.limit("6/minute")
async def read_text(
    request: Request, body: OcrRequest, user: str = Depends(require_session),
) -> Dict[str, Any]:
    """The text in one picture. Stores nothing and logs only how many lines and
    how long: what a camera is pointed at may be somebody's letter."""
    def work() -> Dict[str, Any]:
        # Waits its turn rather than refusing: the live text reading keeps a
        # view in the background every few seconds and holds the reader while it
        # does, and a person tapping a box must not be told "busy" for that.
        if not _ocr_lock.acquire(timeout=OCR_WAIT_SECONDS):
            raise HTTPException(status_code=429,
                                detail="Sto gia' leggendo un altro testo: riprova tra un secondo.")
        try:
            started = time.perf_counter()
            raw = _jpeg_bytes(body.image)
            if raw is None:
                raise HTTPException(status_code=400, detail="Immagine non leggibile.")
            lines = text_reader.read(raw, body.mode, sharpen=body.sharpen)
            return {"lines": lines, "ms": round((time.perf_counter() - started) * 1000)}
        finally:
            _ocr_lock.release()

    try:
        result = await run_in_threadpool(work)
    except text_reader.ReaderUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error))
    except ValueError:
        raise HTTPException(status_code=400, detail="Immagine non leggibile.")
    logger.info("%s read text: %d line(s) in %d ms", user, len(result["lines"]), result["ms"])
    return result


class OcrLine(BaseModel):
    text: str = Field(max_length=OCR_MAX_LINE_CHARS)
    box: List[int] = Field(min_length=4, max_length=4)


class OcrPosition(BaseModel):
    lat: float
    lon: float
    accuracy: Optional[float] = None


class OcrSaveRequest(BaseModel):
    image: str = Field(max_length=MAX_CAPTURE_B64)
    mode: Literal["scene", "text", "codes"] = "scene"
    lines: List[OcrLine] = Field(min_length=1, max_length=OCR_MAX_LINES)
    position: Optional[OcrPosition] = None
    # The text as corrected by the person, when they edited it; the boxes stay
    # those of the lines.
    text: Optional[str] = Field(None, max_length=OCR_MAX_TEXT_CHARS)


@app.post("/ocr/save")
@limiter.limit("20/minute")
async def save_read_text(
    request: Request, body: OcrSaveRequest, user: str = Depends(require_session),
) -> Dict[str, Any]:
    """Keeps a read: the picture with the lines boxed, where it was taken, and
    the text in a field of its own. It goes into the same store and the same
    strip as a saved detection, so deleting it, clearing the strip and the map
    link all work without a second code path.

    The text is taken from the request and NOT read again: a second read would
    cost another second and could differ from what the person just looked at.
    """
    text = (body.text.strip() if body.text is not None else "") or "\n".join(
        line.text.strip() for line in body.lines if line.text.strip())
    if not text:
        raise HTTPException(status_code=400, detail="Nessun testo da salvare.")
    if len(text) > OCR_MAX_TEXT_CHARS:
        raise HTTPException(status_code=413, detail="Testo troppo lungo da salvare.")
    position = None
    if body.position is not None:
        position = _valid_position(body.position.lat, body.position.lon,
                                   body.position.accuracy)

    def work() -> Dict[str, Any]:
        decoded = _decode_images([body.image])
        if not decoded:
            raise HTTPException(status_code=400, detail="Immagine non leggibile.")
        frame = decoded[0]
        height, width = frame.shape[:2]
        boxes = []
        for line in body.lines:
            x1, y1, x2, y2 = line.box
            x1, x2 = max(0, min(width - 1, x1)), max(0, min(width - 1, x2))
            y1, y2 = max(0, min(height - 1, y1)), max(0, min(height - 1, y2))
            if x2 - x1 < 2 or y2 - y1 < 2:
                continue
            # Plain rectangles, never the text: cv2.putText has no accents, so
            # "è" would be burnt into the saved picture as "?".
            cv2.rectangle(frame, (x1, y1), (x2, y2), (64, 192, 87), 2)
            boxes.append({"bbox": [x1, y1, x2, y2], "label": None})
        jpeg = _jpeg(frame)
        if jpeg is None:
            raise HTTPException(status_code=400, detail="Immagine non salvabile.")
        first = text.split("\n", 1)[0]
        label = first if len(first) <= 40 else first[:39].rstrip() + "…"
        return detections.add_text_entry(text, body.mode, label, jpeg, boxes,
                                         device=user, position=position)

    entry = await run_in_threadpool(work)
    logger.info("%s saved a read of %d line(s)%s", user, len(body.lines),
                " with a position" if position else "")
    return {"entry": entry}


_SAVED_ID = re.compile(r"^[0-9a-f]{32}$")


class EntryTextRequest(BaseModel):
    text: str = Field(min_length=1, max_length=OCR_MAX_TEXT_CHARS)


@app.patch("/detections_saved/{entry_id}/text", dependencies=[Depends(require_session)])
@limiter.limit("60/minute")
async def correct_saved_text(request: Request, entry_id: str,
                             body: EntryTextRequest) -> Dict[str, Any]:
    """Replaces the words of a saved text entry -- for correcting a misread."""
    if not _SAVED_ID.match(entry_id):
        raise HTTPException(status_code=404, detail="Unknown entry")
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Il testo non puo' essere vuoto.")
    entry = await run_in_threadpool(detections.update_text, entry_id, text)
    if entry is None:
        raise HTTPException(status_code=404, detail="Unknown entry")
    return {"entry": entry}


@app.get("/detections_saved/{entry_id}.jpg", dependencies=[Depends(require_session)])
async def saved_detection_jpeg(entry_id: str) -> Response:
    if not _SAVED_ID.match(entry_id):
        raise HTTPException(status_code=404, detail="Unknown entry")
    jpeg = await run_in_threadpool(detections.entry_jpeg, entry_id)
    if jpeg is None:
        raise HTTPException(status_code=404, detail="Unknown entry")
    # An entry's picture never changes: it is deleted, not edited.
    return Response(jpeg, media_type="image/jpeg",
                    headers={"Cache-Control": "private, max-age=604800, immutable"})


@app.delete("/detections_saved", dependencies=[Depends(require_session)])
async def clear_saved_detections(before: int) -> Dict[str, int]:
    """"Svuota": deletes, for every device, the pictures created at or before
    `before` (ms) -- the newest one the page was showing. Anyone logged in may,
    as anyone may delete one picture with its X."""
    deleted = await run_in_threadpool(detections.delete_before, before)
    return {"deleted": deleted}


@app.delete("/detections_saved/{entry_id}", dependencies=[Depends(require_session)])
async def delete_saved_detection(entry_id: str) -> Dict[str, bool]:
    if not _SAVED_ID.match(entry_id):
        raise HTTPException(status_code=404, detail="Unknown entry")
    if not await run_in_threadpool(detections.delete_entry, entry_id):
        raise HTTPException(status_code=404, detail="Unknown entry")
    return {"deleted": True}


# --- Serve the built frontend ------------------------------------------
# Must stay AFTER every route above: routes are matched in the order they are
# registered, so declaring this mount earlier would let it swallow /command,
# /video_feed, etc. before they are ever reached.
#
# Only active once `npm run build` has produced frontend/dist. When it is
# missing (e.g. during backend development) the server simply runs API-only.
FRONTEND_DIST = os.path.join(os.path.dirname(__file__), "frontend", "dist")


class FrontendFiles(StaticFiles):
    """StaticFiles that says how long each file may be reused.

    Plain StaticFiles sends no Cache-Control at all. A response without one is
    not "do not cache": the browser is allowed to guess a freshness lifetime of
    its own and reuse the file without asking. For index.html that is the wrong
    guess to allow, because index.html is the file that names the bundle. Once
    the browser holds an old index.html AND the old bundle it points at, the
    whole page keeps running from cache after `npm run build`, and a rebuilt
    frontend looks exactly like nothing was rebuilt -- while the new bundle
    sits on disk unused and the old one now answers 404.

    The assets themselves are the opposite case: vite puts a content hash in
    every name, so a changed file is a different name and the old name can be
    kept for ever.
    """

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        # StaticFiles builds this path with the OS separator, so on Windows it
        # arrives as "assets\\index-abc.js". Comparing against "assets/" there
        # silently matches nothing, which is how the header went missing on
        # Windows while working on the Raspberry.
        relative = path.replace("\\", "/")
        if relative in ("", ".", "index.html") or relative.endswith(".html"):
            response.headers["Cache-Control"] = "no-cache"
        elif relative.startswith("assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


if os.path.isdir(FRONTEND_DIST):
    # html=True serves index.html for "/" automatically.
    app.mount("/", FrontendFiles(directory=FRONTEND_DIST, html=True), name="frontend")
    logger.info("serving frontend from %s", FRONTEND_DIST)
else:
    logger.info("no frontend build at %s -- running API only", FRONTEND_DIST)

# The stores are opened HERE, before uvicorn binds the port. `users` would be
# opened by the count below anyway; without this probe the server would start,
# serve the login page, and only fail later if a store is missing or unreadable.
_STORES = (
    (users, users.USERS_DB),
    # What own-camera devices' frames were found to contain -- see /detect_ws.
    (detections, detections.DETECTIONS_DB),
)

# The stores that exist are opened first, to make sure they can be read.
for _store, _path in _STORES:
    if not os.path.exists(_path):
        continue
    try:
        _store.connect(_path).close()
    except Exception as _error:                               # noqa: BLE001
        logger.error("Cannot open %s: %s", _path, _error)
        raise SystemExit(78)

# A store that does not exist is created empty, so the application starts on a
# machine that holds no data yet -- a fresh checkout, or a PC used alongside the
# Raspberry. It is not done silently: the danger faces.connect() warns about is
# an empty store being mistaken for enrolled people having vanished, so the log
# says plainly that this one is NEW, and where the real data would be instead.
for _store, _path in _STORES:
    if os.path.exists(_path):
        continue
    try:
        _store.connect(_path, create=True).close()
    except Exception as _error:                               # noqa: BLE001
        logger.error("Cannot create %s: %s", _path, _error)
        raise SystemExit(78)
    logger.warning(
        "%s did not exist: created a NEW, EMPTY store at %s.",
        _path, _path,
    )

# Nobody can log in until an account exists, and the page for creating accounts
# itself requires being logged in as an administrator. Without this warning the
# only symptom is that every password is rejected, with no explanation.
if not users.count_users():
    logger.warning(
        "no accounts exist yet -- nobody can log in. Create the first "
        "administrator with:  python manage_users.py add <name>"
    )
elif not users.count_admins():
    logger.warning(
        "there are accounts but no administrator -- nobody can open /admin/. "
        "Promote one with:  python manage_users.py role <name> %s",
        users.ADMIN,
    )


if __name__ == "__main__":
    # Everything below runs ONLY when you launch this file directly:
    #     python server_fastapi.py
    # It is skipped when the server is launched the other way
    # (python -m uvicorn server_fastapi:app), so the two ways never collide.
    import uvicorn

    # uvicorn.run() accepts its first argument in two different shapes:
    #
    #   (a) app                   -> the variable created earlier in this file
    #   (b) "server_fastapi:app"  -> a piece of text telling uvicorn: "open the
    #                                file server_fastapi.py yourself and take
    #                                the variable named app out of it"
    #
    # Shape (a) is required here. With shape (b), uvicorn executes this entire
    # file a second time in order to reach that variable -- so line 52 runs
    # twice, and the second run asks gpiozero for pins 17/27/22 while this
    #
    # What shape (a) costs: the server will NOT restart by itself when you
    # edit the code. Restarting means running the file again, which uvicorn
    # can only do if it was told where the file is -- that is, shape (b). So
    # while developing, start the server the other way instead:
    #     python -m uvicorn server_fastapi:app --reload
    #
    # HOST 127.0.0.1 means only this computer can reach the server. Set
    # HOST=0.0.0.0 in .env to also allow other machines on the same network
    # (needed on the Raspberry when the frontend runs on a different PC).
    #
    # SSL_CERTFILE/SSL_KEYFILE turn on HTTPS. This is REQUIRED for the
    # "camera of this device" button: browsers only grant camera access on
    # https:// or localhost, so over plain http:// a phone refuses it.
    # certs/ is deliberately not in git (key.pem is a private key), so a copy
    # of this project on another machine has .env pointing at certificate files
    # that are not there. Create them instead of stopping: a self-signed
    # certificate is all this needs, and generating it here works the same on
    # the Raspberry and on Windows.
    if SSL_CERTFILE and SSL_KEYFILE:
        if not os.path.isfile(SSL_CERTFILE) and not os.path.isfile(SSL_KEYFILE):
            logger.info(
                "no certificate at %s, creating a self-signed one",
                SSL_CERTFILE,
            )
            create_self_signed_cert(SSL_CERTFILE, SSL_KEYFILE)
            logger.info("wrote %s and %s", SSL_CERTFILE, SSL_KEYFILE)

    # Reached only when exactly one of the pair is missing, or when just one of
    # the two settings is filled in. Both are deliberately left alone here:
    # writing a new certificate on top of a half-present pair would destroy a
    # key that may have been put there on purpose. uvicorn's own error for a
    # missing file is a bare "FileNotFoundError: [Errno 2] No such file or
    # directory" which does not say which file, so say it plainly instead.
    for label, path in (("SSL_CERTFILE", SSL_CERTFILE), ("SSL_KEYFILE", SSL_KEYFILE)):
        if path and not os.path.isfile(path):
            other = "SSL_KEYFILE" if label == "SSL_CERTFILE" else "SSL_CERTFILE"
            raise SystemExit(
                f"\n{label} in .env points at {path!r}, which does not exist, "
                f"but its counterpart {other} is present.\n"
                "\nA certificate and its key only work as a pair. Delete the "
                "one that is left and start the server again to have a fresh "
                "pair created, or restore the missing file from wherever it "
                "came from.\n"
                "\nOr comment out SSL_CERTFILE and SSL_KEYFILE in .env to run "
                "without HTTPS. The 'camera of this device' button then stops "
                "working, because browsers only grant camera access on https:// "
                "or localhost.\n"
            )

    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        ssl_certfile=SSL_CERTFILE,
        ssl_keyfile=SSL_KEYFILE,
    )
