// Reports what the browser detected back to the server, so the Pi can still
// act on detections (GPIO and so on) now that it is no longer the one finding
// them. See POST /detections and handle_detections() in server_fastapi.py.
//
// Deliberately NOT sent every frame. Four pages at 30 fps would be 120 requests
// a second to say mostly the same thing. Instead: send when the set of labels
// changes, plus a slow heartbeat so the server knows the page is still there
// and can tell "nothing detected" from "nobody looking".

const HEARTBEAT_MS = 500; // at most 2 reports a second when nothing changes

export class DetectionReporter {
  constructor(post) {
    this.post = post; // (body) => Promise, injected so App owns fetch details
    this.lastLabels = "";
    this.lastSentAt = 0;
    this.inFlight = false;
  }

  /** Call with every frame's detections; decides whether to actually send. */
  report(source, detections) {
    const labels = [...new Set(detections.map((d) => d.label))].sort().join(",");
    const now = performance.now();
    const changed = labels !== this.lastLabels;
    if (!changed && now - this.lastSentAt < HEARTBEAT_MS) return;
    // Never queue up: on a slow link the next frame is more current than a
    // retry of this one would be.
    if (this.inFlight) return;

    this.lastLabels = labels;
    this.lastSentAt = now;
    this.inFlight = true;
    this.post({
      source,
      // The server only needs the shape it can act on; landmark points would
      // be 21 pairs per hand for nothing.
      detections: detections.map((d) => ({
        label: d.label,
        confidence: d.confidence ?? null,
        bbox: d.bbox ?? null,
      })),
    })
      .catch(() => {
        // A failed report must not break the video. Clear the cached labels so
        // the next frame tries again rather than assuming the server knows.
        this.lastLabels = "";
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  reset() {
    this.lastLabels = "";
    this.lastSentAt = 0;
  }
}
