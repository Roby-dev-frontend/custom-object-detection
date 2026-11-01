import platform
import queue
import threading
import time
from collections import deque
from typing import Deque, Dict, List, Optional, Tuple

import cv2

from detection import (
    DETECTION_CONFIG,
    Detection,
    DetectionConfig,
    Frame,
    detect,
    draw_detections,
)

# At most one frame in this many is handed to the detector; every frame is drawn
# with the latest result. Detection costs 130-550 ms on a Pi 4 against ~15 ms
# for capture and encoding. It now runs on its own thread (see
# LocalCameraWorker), so it no longer holds the camera up at all; this number
# only caps how often it may run, which keeps its CPU use no higher than when
# it ran inline on one frame in three.
DETECT_EVERY = 3
# Seconds between two raw frames offered to a frame listener when detection runs
# in the browser (5 a second). The listener's own consumer is slower still.
LISTENER_EVERY = 0.2

# How the camera's frames are encoded before they leave this machine, and the
# one lever that decides how many of them a slow link can carry.
#
# Measured on a 640x480 frame from the webcam on this Pi: OpenCV's default --
# quality 95, no resize, which is what this used to be -- is 70 kB. Quality 85
# is 34 kB, quality 65 is 20 kB, and 480 px wide at 65 is 13 kB. Each rung
# roughly halves the bytes, because a halving is the smallest step that shows
# up as a different frame rate at the other end.
#
# width 0 means "whatever the camera produced". Held by reference like
# detection_config below, so changing it applies to the next frame without the
# camera being restarted.
VIDEO_ENCODING: Dict[str, int] = {"width": 0, "quality": 95}

# How long the Pi Camera is given to hand over a frame before it is declared
# dead. picamera2's capture_array() takes no timeout and cannot be interrupted:
# when the CSI pipeline fails to start (dmesg shows
# "unicam fe801000.csi: Failed to start media pipeline: -22") it simply never
# returns. Whichever thread called it is lost for the life of the process, so
# the rule below is that the thread which calls it must be one we can afford
# to abandon.
#
# The first frame gets longer: the sensor has to be brought up, and on a Pi 4
# that is comfortably under 2 s, but a loaded machine can be slower.
PICAMERA_FIRST_FRAME_TIMEOUT = 10.0
# Once frames are flowing they arrive every ~33 ms, so this only ever fires on
# a camera that has genuinely stopped.
PICAMERA_STALL_TIMEOUT = 5.0
# stop() and close() hand work to the same picamera2 event loop that a wedged
# camera has stopped servicing, so they can block just as hard. Wait this long
# for them, then leave them to the daemon thread and carry on.
PICAMERA_CLOSE_TIMEOUT = 3.0


class Subscription:
    """One viewer's queue of frames waiting to be sent.

    The hub owns the lock; this is only the storage. `maxlen` on the deque IS
    the "drop the oldest when full" rule -- appending to a full deque discards
    from the other end, which is exactly what a bounded buffer has to do and
    needs no code of its own.

    One queue and not two. A pair that took turns -- one played out while the
    other collected -- was built and measured, and it lost every fair
    comparison: against a single queue of the same TOTAL size it delivered 270
    frames to 281, and against one of the same size per queue it delivered the
    same 119 frames for twice the delay. Two queues of N hold what one queue of
    2N holds, and splitting them only decides where the losses fall.
    """

    __slots__ = ("frames", "dropped", "overwritten", "notify")

    def __init__(self, maxlen: int, notify=None) -> None:
        self.frames: Deque[Tuple[bytes, float]] = deque(maxlen=max(1, maxlen))
        # Frames this viewer never saw, because it fell a whole buffer behind
        # and was caught up to the present. Reported so "the picture jumped"
        # has a number next to it rather than being a mystery.
        self.dropped = 0
        # Frames the deque itself discarded on append, since the last take.
        #
        # Counted where the loss happens rather than inferred afterwards,
        # because with maxlen 1 -- the buffer turned OFF -- it cannot be
        # inferred at all: every new frame silently replaces the last and the
        # queue never looks full. That made the loss report zero for exactly
        # the setting that loses the most, which is worse than not reporting
        # it. Reset by take(), so it always means "since you last looked".
        self.overwritten = 0
        # Called with no arguments when a frame lands for this viewer, so a
        # reader waiting for one can be woken instead of having to come back
        # and ask. A plain callable and not an asyncio primitive on purpose:
        # frames are produced from the capture THREAD as well as from the event
        # loop, and this class has no business knowing which.
        self.notify = notify


class FrameHub:
    """Thread-safe holder of the latest annotated JPEG frame, and of one queue
    per viewer that wants the frames in between as well.

    The single slot and the queues serve two different needs and both are kept:

      the slot   -- "what does the camera look like right now". Used by the
                    MJPEG stream and by the readiness probe, neither of which
                    wants a history.
      the queues -- "show me everything, in order". A viewer that falls behind
                    for a moment gets the frames it missed instead of a hole,
                    which is what buffering buys. Bounded, because an unbounded
                    one turns a slow link into unbounded delay and unbounded
                    memory rather than into dropped frames.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jpeg: Optional[bytes] = None
        # When that frame was stored, on the monotonic clock. Kept so a viewer
        # can be told how OLD the picture it is being sent already is: that one
        # number separates "the phone is slow to send" from "the browser is
        # slow to draw", which is otherwise guesswork.
        self._stored_at: float = 0.0
        self._subscribers: List[Subscription] = []

    def update(self, jpeg_bytes: bytes) -> None:
        waiting = []
        with self._lock:
            self._jpeg = jpeg_bytes
            self._stored_at = time.monotonic()
            for sub in self._subscribers:
                # A deque at capacity discards from the other end as this
                # appends. That discard is silent, so it is counted here, on
                # the way in -- afterwards there is nothing left to count.
                if len(sub.frames) == sub.frames.maxlen:
                    sub.overwritten += 1
                sub.frames.append((jpeg_bytes, self._stored_at))
                if sub.notify is not None:
                    waiting.append(sub.notify)
        # Woken OUTSIDE the lock. A notifier hands the wake-up to another
        # thread's event loop, and doing that while holding the hub's lock
        # would make every frame's arrival wait on whatever that loop is busy
        # with -- including, in the worst case, a viewer trying to take a frame.
        for notify in waiting:
            try:
                notify()
            except Exception:
                # A viewer whose loop is already shutting down must not stop
                # the frame reaching the others, or one closing tab would
                # freeze everybody else's picture.
                pass

    def clear(self) -> None:
        with self._lock:
            self._jpeg = None
            self._stored_at = 0.0
            # A queue left standing after the stream stopped would be played
            # out as if it were live, which is how a camera that stopped
            # sharing keeps appearing to send pictures.
            for sub in self._subscribers:
                sub.frames.clear()
                # Losses belong to the share that produced them. Carrying them
                # into the next one would report the old stream's holes against
                # the new one's first frame.
                sub.overwritten = 0

    def subscribe(self, maxlen: int, notify=None) -> Subscription:
        """A queue of this many frames for one viewer. maxlen 1 is the old
        behaviour exactly: only ever the newest frame, no buffering.

        `notify` is called when a frame lands for this viewer, so a reader can
        wait to be told instead of asking again on a timer.
        """
        sub = Subscription(maxlen, notify=notify)
        with self._lock:
            self._subscribers.append(sub)
        return sub

    def unsubscribe(self, sub: Subscription) -> None:
        with self._lock:
            if sub in self._subscribers:
                self._subscribers.remove(sub)

    def take(self, sub: Subscription) -> "tuple[Optional[bytes], float, int]":
        """The next frame for this viewer: (jpeg, when it was stored, frames
        skipped since the last one it was given). None when the queue is empty.

        A FULL queue means this viewer has fallen a whole buffer behind, so it
        is caught up to the present in one step rather than played the backlog.
        Draining a backlog it could not keep up with in the first place only
        makes it later, and it would stay that way for the rest of the session;
        this way a bad patch costs that patch and nothing after it.

        The two losses are added, never double counted: `overwritten` is what
        the deque threw away on the way in, and the clear below is what is
        thrown away on the way out. With the buffer off only the first can
        happen; with it on, usually only the second.
        """
        with self._lock:
            if not sub.frames:
                return None, 0.0, 0
            skipped = sub.overwritten
            sub.overwritten = 0
            if len(sub.frames) == sub.frames.maxlen and sub.frames.maxlen > 1:
                skipped += len(sub.frames) - 1
                jpeg, stored_at = sub.frames[-1]
                sub.frames.clear()
            else:
                jpeg, stored_at = sub.frames.popleft()
            sub.dropped += skipped
            return jpeg, stored_at, skipped

    def get_latest(self) -> "tuple[Optional[bytes], float]":
        """The frame and the moment it arrived, read together so the age
        cannot be computed against a frame that was replaced in between."""
        with self._lock:
            return self._jpeg, self._stored_at

    def get_latest_jpeg(self) -> Optional[bytes]:
        with self._lock:
            return self._jpeg


# Over how long a window the publisher's frame rate is averaged. One second
# reads as jitter -- a link that delivers 7, 4, 9 frames is a link delivering
# about 7, not one changing every second -- and much longer hides a stall.
SHARE_RATE_WINDOW = 3.0


def _note(times: List[float], now: float, count: int = 1) -> None:
    """Record `count` events at `now` and drop anything older than the window.

    Trimmed on write rather than on read: the write happens ~10 times a second
    and the read once every 5 s, so an untrimmed list would be 50 entries long
    by the time anybody looked at it.
    """
    times.extend([now] * count)
    cutoff = now - SHARE_RATE_WINDOW
    if times[0] < cutoff:
        times[:] = [t for t in times if t >= cutoff]


def _rate(times: List[float], now: float) -> int:
    """Events per second over the window, from the same list."""
    cutoff = now - SHARE_RATE_WINDOW
    return round(len([t for t in times if t >= cutoff]) / SHARE_RATE_WINDOW)


class ShareMeter:
    """How the shared stream is actually flowing.

    The page reports what IT can see -- frames encoded, frames the socket
    accepted, bytes, its own round trip -- but the two numbers that separate
    "the phone cannot upload fast enough" from "the browser cannot draw fast
    enough" can only be taken here, because only this process sees both ends of
    them on one clock. Two devices comparing their own clocks would be
    measuring the difference between them as much as the delay.

    The age is already computed in /video_ws; this only keeps it where
    /presence can read it, instead of it going to the log and nowhere else.

    Three separate frame rates are kept, because a frame can be lost at three
    different points and only the gaps between them say which one is doing it:

        arrived  -- put on the wire by the publishing device
        received -- got as far as the hub, so a viewer could be sent it
        skipped  -- thrown away again when a viewer's buffer overflowed

    arrived minus received is the server's own frame dropping (it keeps only
    the newest arrival while it is busy with the previous one); skipped is the
    buffer catching a viewer up in one step. Neither was visible anywhere
    before, which made "it still jumps frames" impossible to attribute.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._arrived: List[float] = []
        self._received: List[float] = []
        self._skipped: List[float] = []
        self._age_ms: Optional[float] = None
        self._upload_ms: Optional[float] = None

    def report_upload(self, upload_ms: float) -> None:
        """The publishing device's own estimate of how far behind its upload
        is running. It cannot be measured here: it is the time between the
        camera producing a frame and this process receiving it, and the two
        ends have different clocks. The publisher times a ping against itself
        instead and reports the answer, which is passed on unchanged."""
        with self._lock:
            self._upload_ms = upload_ms

    def frame_arrived(self) -> None:
        """One frame came off the publisher's socket.

        Counted where it lands, before anything decides whether to keep it, so
        this is what the device actually managed to upload. Deliberately NOT
        merged with frame_received below: the difference between the two is the
        measurement.
        """
        now = time.monotonic()
        with self._lock:
            _note(self._arrived, now)

    def frame_received(self) -> None:
        """One frame was USED: claimed for annotation or storage in the hub.

        The rate frames are used at, not the rate they arrive at. Counting
        arrivals here would report what the phone sent even when the server
        dropped most of it, which is the opposite of what this is for.
        """
        now = time.monotonic()
        with self._lock:
            _note(self._received, now)

    def frame_skipped(self, count: int) -> None:
        """Frames a viewer's buffer discarded to catch up in one step.

        With more than one viewer this is the TOTAL across all of them, not a
        figure for any one of them -- each has its own queue and they overflow
        independently. For the ordinary case of one watcher the two are the
        same thing.
        """
        if count <= 0:
            return
        now = time.monotonic()
        with self._lock:
            _note(self._skipped, now, count)

    def frame_served(self, age_seconds: float) -> None:
        """A viewer was handed a frame that was already this old."""
        with self._lock:
            self._age_ms = age_seconds * 1000.0

    def reset(self) -> None:
        """The share ended. Stale numbers are worse than none."""
        with self._lock:
            self._arrived = []
            self._received = []
            self._skipped = []
            self._age_ms = None
            self._upload_ms = None

    def snapshot(self) -> Optional[dict]:
        """The numbers, or None when nothing is flowing.

        `total_ms` is the one to read: roughly how far behind reality the
        picture a viewer is looking at already is by the time it leaves here.
        It is the upload plus the wait on this machine -- the viewer adds its
        own fetch to it, which only the viewer can measure.
        """
        now = time.monotonic()
        with self._lock:
            cutoff = now - SHARE_RATE_WINDOW
            recent = [t for t in self._received if t >= cutoff]
            if not recent and self._age_ms is None:
                return None
            age_ms = None if self._age_ms is None else round(self._age_ms)
            upload_ms = None if self._upload_ms is None else round(self._upload_ms)
            # Only a sum when both halves are known. Adding a missing part as
            # zero would report a small delay for a stream nobody has measured,
            # which is worse than saying so.
            total = None
            if upload_ms is not None:
                total = upload_ms + (age_ms or 0)
            return {
                "fps": round(len(recent) / SHARE_RATE_WINDOW),
                "arrived_fps": _rate(self._arrived, now),
                "skipped_fps": _rate(self._skipped, now),
                "age_ms": age_ms,
                "upload_ms": upload_ms,
                "total_ms": total,
            }


def picamera_available() -> bool:
    """True only when a real Pi Camera Module is attached.

    libcamera also enumerates USB webcams through its UVC pipeline, and
    Picamera2 will happily open one -- but that pipeline hands back RGB while
    the CSI pipeline hands back BGR, so a webcam opened this way comes out with
    red and blue swapped (skin looks blue). Those entries are deliberately not
    counted: a USB webcam belongs to the "usb" source, which reads it through
    OpenCV and gets the channel order right.
    """
    try:
        from picamera2 import Picamera2
    except ImportError:
        return False
    try:
        cameras = Picamera2.global_camera_info()
    except Exception:
        # Enumeration itself can fail on a machine with no libcamera stack.
        return False
    for info in cameras:
        # The Id is the only thing that tells the two apart. A CSI module hangs
        # off the board's own I2C bus:
        #     /base/soc/i2c0mux/i2c@1/ov5647@36
        # while a UVC webcam names a usb node:
        #     /base/scb/pcie@7d500000/pci@0,0/usb@0,0-1.3:1.0-145f:0142
        # Location is NOT usable here: it reads 2 ("external") for a genuine
        # Camera Module v1 as well as for a webcam, which had this returning
        # False with a real camera plugged in.
        if "usb" in str(info.get("Id", "")).lower():
            continue
        return True
    return False


def _close_picamera(picam2) -> None:
    """Releases the Pi Camera, giving up if it refuses to let go.

    stop() alone is not enough: it halts the pipeline but leaves the camera
    ACQUIRED by this process -- lsof still shows /dev/media3 and /dev/video0
    held, and the next worker's Picamera2() dies with "Failed to acquire
    camera: Device or resource busy". close() is what actually releases it.

    Both calls go through picamera2's event loop, which is precisely what a
    wedged camera has stopped servicing, so both can block for ever. They run
    on a daemon thread for that reason: a camera we cannot close is bad, but a
    capture thread that never ends is worse.
    """
    def shut() -> None:
        try:
            picam2.stop()
        finally:
            picam2.close()

    closer = threading.Thread(target=shut, daemon=True)
    closer.start()
    closer.join(PICAMERA_CLOSE_TIMEOUT)
    if closer.is_alive():
        print(
            "[camera] the Pi Camera did not respond to stop()/close(); it stays "
            "held until this process exits. Restart the server before selecting "
            "it again."
        )


class LocalCameraWorker:
    """Captures from a local camera (USB or Pi Camera Module) in a background
    thread, annotates each frame, and pushes it into a FrameHub."""

    def __init__(
        self,
        frame_hub: FrameHub,
        source: str,
        device_index: int = 0,
        target_fps: float = 30,
        detection_config: Optional[DetectionConfig] = None,
        detect_every: int = DETECT_EVERY,
        video_encoding: Optional[Dict[str, int]] = None,
    ) -> None:
        if source not in ("usb", "picamera"):
            raise ValueError(f"Unsupported local camera source: {source}")
        self.frame_hub = frame_hub
        self.source = source
        self.device_index = device_index
        self.target_fps = target_fps
        # Held by reference, not copied: mutating this dict elsewhere (see
        # _apply_detection_config in server_fastapi.py) changes what the next
        # frame is annotated with, without restarting the camera.
        self.detection_config: DetectionConfig = (
            DETECTION_CONFIG if detection_config is None else detection_config
        )
        # Same arrangement, same reason: mutated from the endpoint, read here
        # on the next frame.
        self.video_encoding: Dict[str, int] = (
            VIDEO_ENCODING if video_encoding is None else video_encoding
        )
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self.detect_every = max(1, detect_every)
        self._frame_index = 0
        self._last_detections: Optional[List[Detection]] = None
        # Detection runs on a thread of its own. It used to run inline on the
        # camera thread, one frame in three, and every one of those frames held
        # the camera up for the whole detection: measured on the Windows webcam,
        # 29.1 fps with detection off against 16.9 with YOLO (73 ms a pass) and
        # 20.5 with hands (58 ms), with single frames taking up to 265 ms. The
        # camera thread now only leaves a copy of the newest frame here and
        # draws whatever the detector found last.
        self._detect_thread: Optional[threading.Thread] = None
        self._detect_lock = threading.Lock()
        self._detect_input: Optional[Frame] = None
        self._detect_wake = threading.Event()
        # Somebody who wants the RAW frames, to detect and save them on the
        # server (see DetectSession and /camera_detect_ws). Set and cleared from
        # outside by CameraManager, read on every frame; None costs nothing.
        # Called as listener(frame, detections) where detections is None when
        # the frame is raw and a list when this worker already detected on it.
        # It must return at once: it runs on the capture or detector thread,
        # and anything slow here is dropped frames for every viewer.
        self.frame_listener: Optional[Callable[[Frame, Optional[List[Detection]]], None]] = None
        self._listener_at = 0.0

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        self._detect_thread = threading.Thread(target=self._run_detector, daemon=True)
        self._detect_thread.start()

    def stop(self, wait: bool = True) -> None:
        """Asks the capture thread to finish.

        wait=True  : block until it has really finished (up to 4 seconds) and
                     the camera is therefore released. Needed before reopening
                     the same camera, e.g. when switching source.
        wait=False : only ask it to stop, return immediately. The thread is a
                     daemon, so it ends on its own a few milliseconds later.
                     Used where blocking is not allowed -- see
                     CameraManager.viewer_disconnected in server_fastapi.py.

        THE 4 SECONDS (was 2): _stop_event is only checked between retry
        attempts in _run_usb's open loop, or at the top of the main read loop
        -- never while a cv2.VideoCapture() call or cap.release() is actually
        in flight. Measured on a laptop's built-in camera, cleanly serialized
        (no contention): one open-and-read cycle took up to ~1.5 s and
        release() itself up to ~0.5 s, so a thread caught mid-cycle when stop()
        is called can need close to 2 s just to notice and let go -- the OLD
        timeout's entire budget, with no margin. When join() gave up early,
        the caller (set_source) went on to build a NEW worker that tried to
        open the SAME device the old thread had not actually released yet:
        two threads contending for one camera, which is slower and flakier
        than either alone, and is what made switching sources after a normal
        (not rapid) pause fail far more often than it should have. 4 s is
        roughly double the measured worst case; join() still returns as soon
        as the thread actually finishes, so this costs nothing in the common,
        fast case -- it only changes how long a genuinely stuck switch waits
        before giving up.
        """
        self._stop_event.set()
        self._detect_wake.set()  # so a detector waiting for a frame notices at once
        if wait and self._thread is not None:
            self._thread.join(timeout=4)
        # Not joined: a detection pass in progress cannot be interrupted, and
        # the camera is released by the capture thread above, not by this one.
        # It is a daemon and ends on its own when the pass finishes.
        self._thread = None
        self._detect_thread = None

    def is_alive(self) -> bool:
        """Whether the capture thread is still running.

        False once it has ended -- including when it ended BY ITSELF, which is
        what happens when the camera could not be opened: _run_picamera and
        _run_usb print the reason and return. The object survives that, so
        callers cannot use "is not None" to mean "is capturing".
        """
        return self._thread is not None and self._thread.is_alive()

    def _run(self) -> None:
        if self.source == "picamera":
            self._run_picamera()
        else:
            self._run_usb()

    def _run_detector(self) -> None:
        """Detects on the newest frame the camera thread has left, over and over.

        Never touches the camera and never encodes: its only output is
        self._last_detections, which the camera thread draws onto each frame.
        Replacing that list is a single assignment, so the camera thread always
        sees either the old result or the new one, never half of one.
        """
        while not self._stop_event.is_set():
            if not self._detect_wake.wait(timeout=0.5):
                continue
            with self._detect_lock:
                frame = self._detect_input
                self._detect_input = None
                self._detect_wake.clear()
            if frame is None or self._stop_event.is_set():
                continue
            config = self.detection_config
            if config.get("location") == "browser" or not config.get("active", True):
                continue
            try:
                detections = detect(frame, config)
            except Exception as error:  # noqa: BLE001
                # One failed pass must not end detection for good: the camera
                # would keep running with the last boxes frozen on screen.
                print(f"[camera] detection failed on one frame: {error}")
                continue
            # Dropped if detection moved to the browser while this pass ran,
            # so no stale boxes come back if it is moved to the server later.
            if (self.detection_config.get("location") != "browser"
                    and self.detection_config.get("active", True)):
                self._last_detections = detections
                # The frame is this thread's own copy and nothing else uses it
                # after this pass, so it is handed over as it is; the detections
                # come with it so the listener does not detect a second time.
                self._offer(frame, detections)

    def _offer(self, frame: Frame, found: Optional[List[Detection]]) -> None:
        """Hands one raw frame to the listener, if there is one. A fault in the
        listener is printed and swallowed: it must never stop the video."""
        listener = self.frame_listener
        if listener is None:
            return
        try:
            listener(frame, found)
        except Exception as error:  # noqa: BLE001
            print(f"[camera] frame listener failed: {error}")

    def _encode(self, frame_bgr: Frame):
        """The frame as JPEG, at the size and quality currently chosen.

        This is the only place the picture's weight is decided. It used to be
        cv2.imencode with no arguments at all, which is quality 95 and no
        resize -- the heaviest setting OpenCV has, chosen by nobody.
        """
        width = int(self.video_encoding.get("width") or 0)
        quality = int(self.video_encoding.get("quality") or 95)
        if 0 < width < frame_bgr.shape[1]:
            height = round(frame_bgr.shape[0] * width / frame_bgr.shape[1])
            # INTER_AREA is the one that does not alias when shrinking, which
            # matters here: the page the frame is going to runs a face detector
            # over it.
            frame_bgr = cv2.resize(frame_bgr, (width, height),
                                   interpolation=cv2.INTER_AREA)
        return cv2.imencode(".jpg", frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])

    def _push_frame(self, frame_bgr: Frame) -> None:
        # location == "browser": publish the frame untouched and let the page
        # detect and draw. Skipping annotate() here is the entire point of that
        # mode -- it is 90% of the per-frame cost on a Pi 4.
        if (self.detection_config.get("location") == "browser"
                or not self.detection_config.get("active", True)):
            self._last_detections = None  # stale the moment we stop detecting
            if self.frame_listener is not None:
                # Before _encode: the listener gets the frame as the lens (and
                # the mirror) made it, not the 480 px / q65 copy that is
                # streamed. A copy, because the caller keeps using this array;
                # at most LISTENER_EVERY apart, because saving needs a few
                # pictures a second, not thirty.
                now = time.monotonic()
                if now - self._listener_at >= LISTENER_EVERY:
                    self._listener_at = now
                    self._offer(frame_bgr.copy(), None)
            ok, jpeg = self._encode(frame_bgr)
            if ok:
                self.frame_hub.update(jpeg.tobytes())
            return

        # Offer every detect_every'th frame to the detector thread, replacing any
        # frame it has not picked up yet, so it always works on the newest one.
        # A copy, because this frame is about to be drawn on and encoded while
        # the detector may still be reading it.
        if self._frame_index % self.detect_every == 0:
            with self._detect_lock:
                self._detect_input = frame_bgr.copy()
            self._detect_wake.set()
        self._frame_index += 1
        # Drawn from the latest result, whichever frame it was computed on. Until
        # the first pass finishes there is none, and the frame goes out clean
        # rather than waiting for it.
        detections = self._last_detections
        if detections:
            frame_bgr = draw_detections(frame_bgr, detections)
        # `self._last_detections` is a list of {"label", "confidence", "bbox"}
        # dicts -- see the docstring on annotate() in detection.py for the
        # shape and examples of using it (counting, filtering by label,
        # driving GPIO).
        ok, jpeg = self._encode(frame_bgr)
        if ok:
            self.frame_hub.update(jpeg.tobytes())

    def _run_usb(self) -> None:
        # On Windows, OpenCV's default backend fails to open some webcams;
        # CAP_DSHOW is the standard fix. Linux (the Pi) uses V4L2 by default,
        # which doesn't have this problem.
        # Retry a few times: a previous capture thread stopped with wait=False
        # may still be releasing this same camera for a few milliseconds, and
        # a camera can only be open once at a time. Without the retry, a page
        # reloaded very quickly would find the camera still busy and show
        # nothing until the next source switch.
        #
        # 5 attempts at 0.2 s (1 s total) was sized for a USB webcam, which
        # lets go almost immediately. A laptop's built-in camera measured far
        # slower to release on this machine: switching away and back inside
        # about a second left it still unreadable when the 1 s budget ran out,
        # which is what server_fastapi.py's 5 s SOURCE_READY_TIMEOUT then
        # reported as "produced no images" even though the camera itself was
        # fine. 12 attempts at 0.3 s (3.6 s worst case) stays under that 5 s
        # ceiling -- this loop runs inside the same window the caller is
        # waiting on -- while giving a slow-releasing camera several times the
        # previous margin.
        cap = None
        for _attempt in range(12):
            if platform.system() == "Windows":
                cap = cv2.VideoCapture(self.device_index, cv2.CAP_DSHOW)
            else:
                cap = cv2.VideoCapture(self.device_index)
            if cap.isOpened():
                break
            cap.release()
            if self._stop_event.wait(0.3):
                return
        if cap is None or not cap.isOpened():
            print(f"[camera] could not open USB camera at index {self.device_index}")
            return
        if platform.system() == "Windows":
            # DirectShow opens some webcams at a fixed, dark exposure instead
            # of the driver's own auto setting -- measured on one camera: mean
            # brightness 46.7 as opened, 119.9 once auto-exposure is turned on
            # explicitly. 0.75 is DSHOW's own legacy value for "auto" (0.25 is
            # "manual") -- meaningless on V4L2, which uses different numbers,
            # so this stays inside the Windows branch and leaves the Linux/Pi
            # path untouched. Harmless where the property is not supported:
            # set() is then a no-op and the camera behaves exactly as before.
            cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.75)
        try:
            interval = 1 / self.target_fps
            while not self._stop_event.is_set():
                start = time.monotonic()
                ok, frame = cap.read()
                if ok:
                    self._push_frame(frame)
                elapsed = time.monotonic() - start
                time.sleep(max(0, interval - elapsed))
        finally:
            cap.release()

    def _run_picamera(self) -> None:
        # Pi/Linux-only; imported lazily so this module still loads on
        # dev machines that don't have picamera2 installed.
        try:
            from picamera2 import Picamera2
        except ImportError as error:
            # Same treatment as a USB camera that refuses to open: say why on
            # the console and end this thread quietly. The server keeps serving
            # every other source instead of dying with the camera.
            print(f"[camera] picamera2 is not installed: {error}")
            return

        try:
            picam2 = Picamera2()
        except Exception as error:
            # Raised when no camera is attached, when the ribbon cable is not
            # seated, or when the legacy camera stack is still enabled. Before
            # this guard the exception escaped the capture thread and printed a
            # traceback, which read like a crash even though only this one
            # source was unusable.
            print(f"[camera] could not open the Pi Camera: {error}")
            return

        # Despite its name, picamera2's "RGB888" hands back an array whose
        # channels are ordered BLUE, GREEN, RED -- the format names describe
        # byte order in memory, which is the reverse of the channel order.
        # picamera2's own tables spell this out, e.g. in request.py:
        #     FORMAT_TABLE = {..., "BGR888": "RGB", "RGB888": "BGR"}
        # BGR is exactly what OpenCV works in, so the array is already correct
        # and must NOT be converted: a cvtColor(..., COLOR_RGB2BGR) here would
        # swap red and blue and make the Pi Camera picture look wrong.
        try:
            picam2.configure(
                picam2.create_video_configuration(main={"format": "RGB888"})
            )
            picam2.start()
        except Exception as error:
            print(f"[camera] could not start the Pi Camera: {error}")
            # The constructor succeeded, so a camera is held open here and must
            # be released, or selecting the source again would find it busy.
            picam2.close()
            return

        # Capture on a thread of its own and hand frames over through a queue
        # holding one. THE POINT: capture_array() cannot be given a deadline or
        # interrupted, so on a camera that never delivers, whichever thread
        # calls it is stuck for ever. Losing THIS thread costs nothing -- it is
        # a daemon and nobody waits on it. Losing the capture loop is what gave
        # a black picture, an empty log, and a camera still held afterwards.
        frames: "queue.Queue" = queue.Queue(maxsize=1)

        def produce() -> None:
            while not self._stop_event.is_set():
                try:
                    frame = picam2.capture_array()
                except Exception as error:
                    print(f"[camera] the Pi Camera stopped delivering: {error}")
                    return
                if frames.full():
                    # Drop the older frame rather than block: the newest
                    # picture is the only one worth showing, which is the same
                    # choice /video_ws makes at the other end of the pipeline.
                    try:
                        frames.get_nowait()
                    except queue.Empty:
                        pass
                frames.put(frame)

        producer = threading.Thread(target=produce, daemon=True)
        producer.start()

        try:
            interval = 1 / self.target_fps
            timeout = PICAMERA_FIRST_FRAME_TIMEOUT
            while not self._stop_event.is_set():
                start = time.monotonic()
                try:
                    frame = frames.get(timeout=timeout)
                except queue.Empty:
                    # The camera opened and started and then produced nothing,
                    # which is a failure BELOW picamera2 -- so say where to
                    # look, because this used to be entirely silent.
                    print(
                        f"[camera] the Pi Camera produced no frame in "
                        f"{timeout:.0f}s and is being given up on. It opened "
                        f"and started, so the fault is under picamera2: check "
                        f"`dmesg | grep unicam` and `libcamera-hello -t 3000 -n`."
                    )
                    return
                # Only the FIRST frame gets the long wait; a camera that has
                # started and then stalls should be reported quickly.
                timeout = PICAMERA_STALL_TIMEOUT
                self._push_frame(frame)
                elapsed = time.monotonic() - start
                time.sleep(max(0, interval - elapsed))
        finally:
            # Let the producer notice the stop flag and leave capture_array()
            # of its own accord before touching the camera underneath it. On a
            # healthy camera that is one frame away, well inside this wait.
            producer.join(PICAMERA_CLOSE_TIMEOUT)
            _close_picamera(picam2)
