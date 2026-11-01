// Talks to the detector, which runs in a worker.
//
// The models themselves live in public/detection-worker.js, on a thread of
// their own. This file is what the page holds: the same small API it always
// had -- ensureLoaded, detect, setTrackedRegions, deferSweep, close -- with
// messages behind it instead of method calls.
//
// Why the split, measured on the Raspberry Pi in a headless browser: a
// detection pass costs about 200 ms, and while it ran on the page's own thread
// the page could not decode the frame that had arrived, draw it, or ask the
// server for the next one. The video therefore advanced once per detection.
// A 50 ms heartbeat standing in for that work got 73 of its 240 turns with the
// detector on the page's thread, and all 241 with it in the worker -- at the
// same detection rate, 4.7 passes a second against 4.8.
//
// Both detectors return the SAME shape the Python side uses, so the drawing
// code and the /detections endpoint do not care which produced them:
//     { label, confidence, bbox: [x1, y1, x2, y2], points? }

// Served from public/, deliberately not bundled: it has to be a classic worker
// (MediaPipe's WASM loader needs importScripts, which module workers lack), and
// asking the bundler for that in both dev and build is more fragile than a
// plain file at a fixed URL.
const WORKER_URL = "/detection-worker.js";

export class BrowserDetector {
  constructor() {
    // Set by the caller while a recognition is in flight. The grid square is
    // the most speculative thing the face pass does, so it is what gets given
    // up for a turn when somebody is waiting to be named -- see _detectFaces
    // in the worker.
    this.deferSweep = false;
    this._regions = [];
    this._nextId = 1;
    this._pending = new Map();
    this._worker = null;
    this._broken = null;
    try {
      this._worker = new Worker(WORKER_URL);
      this._worker.onmessage = (event) => this._answer(event.data);
      // An error here is the worker script itself failing to start -- a
      // missing file, a browser that refuses workers. Nothing it was asked
      // will ever be answered, so everything waiting is failed at once rather
      // than left hanging.
      this._worker.onerror = (event) => {
        this._fail(new Error(event.message || "il rilevatore non si e' avviato"));
      };
    } catch (error) {
      this._broken = error;
    }
  }

  _answer(data) {
    const waiting = this._pending.get(data.id);
    if (!waiting) return;
    this._pending.delete(data.id);
    // TEMPORARY: the model's own time for the last detection, measured in the
    // worker. Read by the diagnostic readout in App.jsx.
    if (typeof data.ms === "number") this.lastModelMs = data.ms;
    if (data.delegate) this.lastDelegate = data.delegate;
    if (data.renderer) this.renderer = data.renderer;
    if (data.ok) waiting.resolve(data.result);
    else waiting.reject(new Error(data.message));
  }

  _fail(error) {
    this._broken = error;
    for (const waiting of this._pending.values()) waiting.reject(error);
    this._pending.clear();
  }

  _ask(message, transfer) {
    if (this._broken) return Promise.reject(this._broken);
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ ...message, id }, transfer ?? []);
    });
  }

  /** Loads whichever model the chosen backend needs. Called again when the
   * backend changes; each model is loaded at most once, in the worker. */
  ensureLoaded(backend, classNames) {
    return this._ask({ cmd: "load", backend, classNames });
  }

  /**
   * Detects in one frame.
   * @param source  anything createImageBitmap accepts: <video>, <img>, canvas
   * @param width,height  the source's natural size, which the returned boxes
   *                      are expressed in
   * @param config  { backend, yolo_classes } -- the same dict the server uses
   * @param timestamp  monotonic ms, required by MediaPipe's VIDEO mode
   */
  async detect(source, width, height, config, timestamp) {
    // A bitmap and not the canvas itself: a canvas cannot cross to a worker,
    // and a bitmap is handed over rather than copied -- the pixels are not
    // serialised. Making it is the one piece of this that still happens on the
    // page's thread, and the browser does the work off it.
    const bitmap = await createImageBitmap(source);
    try {
      return await this._ask(
        {
          cmd: "detect",
          bitmap,
          width,
          height,
          config,
          timestamp,
          // Sent with the frame instead of as their own messages: the page
          // sets both between one detection and the next, so this is the same
          // thing with one round trip less.
          regions: this._regions,
          deferSweep: this.deferSweep,
        },
        [bitmap],
      );
    } catch (error) {
      // A bitmap that never reached the worker would otherwise be held until
      // the garbage collector felt like it.
      bitmap.close?.();
      throw error;
    }
  }

  /**
   * Tells the detector which boxes are worth re-finding next frame.
   *
   * Between grid squares each known face is looked for again inside a small
   * padded crop around where it just was, which is cheaper and a tighter zoom
   * than sweeping. Left to itself the detector seeds those crops from its own
   * last answer, and that turns a single false positive into a permanent one:
   * the ghost is searched for at exactly the spot, and at the magnification,
   * where it is easiest to find again.
   *
   * So the caller feeds back the boxes its tracker has seen more than once.
   * A one-frame ghost is never looked for a second time.
   */
  setTrackedRegions(boxes) {
    this._regions = boxes ?? [];
  }

  close() {
    this._regions = [];
    this._fail(new Error("rilevatore chiuso"));
    this._worker?.terminate();
    this._worker = null;
  }
}
