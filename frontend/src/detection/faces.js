// Keeping track of which face is which between frames, and cutting a face out
// of the picture well enough for the server to recognise it.
//
// The dangerous failure here is not "lost the face" -- that just costs another
// round trip. It is a track id surviving across two DIFFERENT people, because
// the identity cached against it then gets painted onto the wrong face, with
// whatever judgement was recorded about the other person. Everything below is
// shaped by that: boxes must agree closely before they are called the same
// face, tracks expire by wall-clock time, and an id is never reused.

// Boxes must overlap this much to be considered the same face.
const IOU_THRESHOLD = 0.3;
// ...and their centres must be within this fraction of the box size. IoU alone
// is too generous when two similar-sized faces sit side by side.
const CENTRE_GATE = 0.6;
// Expiry is in milliseconds, NOT frames: detection runs on requestAnimationFrame
// throttled by a busy flag, so the gap between two frames varies from 40 ms to
// several hundred, and a frame count would mean different things at different
// moments.
const MAX_AGE_MS = 1000;
// ...and how long a track is REMEMBERED after that, so a face that flickers out
// and comes back gets its own id -- and its name -- rather than starting again
// as a stranger.
//
// This is what "the name disappears for three seconds every time the box
// breaks" was: the box reforming meant a new track, a new track meant no
// identity, and no identity meant a round trip to the server before the name
// could come back. A revived track shows its name in the same frame.
//
// It is bounded by the same geometry as any other match -- the returning box
// has to overlap where the old one was, and be about the same size -- and the
// app re-checks a revived track immediately, so a wrong revival (somebody
// stepping into the spot another person just left) is corrected within about a
// second rather than persisting.
const MAX_REVIVE_MS = 2500;
// How many frames a box must be seen in before anything is done with it.
//
// One frame is not evidence. BlazeFace on a tile will report a lamp or a
// window frame once and never again, and until this existed that single frame
// was enough to draw a box, offer to save it, and spend a recognition on it.
// A real face is found in every frame it is in, so the cost is one frame of
// delay -- about 40 ms.
export const MIN_HITS = 2;

// Cap on the longest side of an uploaded crop, and its JPEG quality.
//
// SFace aligns whatever it is given down to 112x112 before looking at it, so
// sending more than a few hundred pixels is pure upload with no accuracy in it.
// Measured on a real face, cosine against the same face at native resolution:
//
//   native 443x613 q90   47 KB (63 KB base64)   0.978
//   240 px       q85    7.2 KB (9.6 KB)         0.981
//   160 px       q82    3.9 KB (5.2 KB)         0.961
//   112 px       q75    2.2 KB (3.0 KB)         0.948
//
// 240 costs a seventh of the bytes and loses nothing, so that is the setting.
const CROP_MAX_SIDE = 240;
const CROP_QUALITY = 0.85;

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (!overlap) return 0;
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return overlap / (areaA + areaB - overlap);
}

function centresClose(a, b) {
  const ax = (a[0] + a[2]) / 2;
  const ay = (a[1] + a[3]) / 2;
  const bx = (b[0] + b[2]) / 2;
  const by = (b[1] + b[3]) / 2;
  const size = Math.max(a[2] - a[0], a[3] - a[1], 1);
  return Math.hypot(ax - bx, ay - by) <= size * CENTRE_GATE;
}

export class FaceTracker {
  constructor() {
    this.tracks = new Map(); // id -> { id, bbox, lastSeen, identity, firstSeen }
    // Tracks whose box has gone but which may still come back. Same shape,
    // kept for MAX_REVIVE_MS. Nothing outside this class sees the difference.
    this.lost = new Map();
    this._nextId = 1;
  }

  /**
   * Assigns a stable `trackId` to each detection, carrying over whatever
   * identity that track already had.
   *
   * @returns the same detections, each with `trackId`, `identity` and
   *          `firstSeen` attached.
   */
  update(detections, now = performance.now()) {
    const unmatched = new Set(this.tracks.keys());
    const out = [];

    /** The best geometric match for `bbox` among `ids` of `pool`, or null. */
    const bestMatch = (pool, ids, bbox) => {
      let bestId = null;
      let bestScore = IOU_THRESHOLD;
      for (const id of ids) {
        const track = pool.get(id);
        const score = iou(track.bbox, bbox);
        if (score > bestScore && centresClose(track.bbox, bbox)) {
          bestScore = score;
          bestId = id;
        }
      }
      return bestId;
    };

    for (const detection of detections) {
      // Live tracks first, always: a box that continues an existing one is that
      // one, and a lost track must never steal it.
      const bestId = bestMatch(this.tracks, unmatched, detection.bbox);
      const revivedId =
        bestId === null
          ? bestMatch(this.lost, [...this.lost.keys()], detection.bbox)
          : null;

      let track;
      let revived = false;
      if (bestId !== null) {
        track = this.tracks.get(bestId);
        unmatched.delete(bestId);
      } else if (revivedId !== null) {
        // The same face coming back where it left off. It keeps its id, its
        // identity and its hit count, so the name is on the box in this frame
        // rather than after another round trip to the server.
        track = this.lost.get(revivedId);
        this.lost.delete(revivedId);
        this.tracks.set(track.id, track);
        revived = true;
      } else {
        // Never recycle an id. If a stale one came back it would inherit an
        // identity belonging to whoever held it before.
        track = { id: this._nextId++, identity: null, firstSeen: now, hits: 0 };
        this.tracks.set(track.id, track);
      }
      track.bbox = detection.bbox;
      track.lastSeen = now;
      track.hits = (track.hits ?? 0) + 1;
      out.push({
        ...detection,
        trackId: track.id,
        identity: track.identity,
        firstSeen: track.firstSeen,
        // Whether this box has been seen often enough to act on. Everything
        // downstream -- drawing, selecting, recognising, saving -- filters on
        // this, so a one-frame ghost never reaches any of it.
        confirmed: track.hits >= MIN_HITS,
        // True for the one frame in which this track came back from the dead,
        // so the caller can re-check who it is straight away instead of
        // trusting an identity that is now a couple of seconds old.
        revived,
      });
    }

    for (const id of unmatched) {
      const track = this.tracks.get(id);
      if (now - track.lastSeen > MAX_AGE_MS) {
        this.tracks.delete(id);
        this.lost.set(id, track);
      }
    }
    for (const [id, track] of this.lost) {
      if (now - track.lastSeen > MAX_REVIVE_MS) this.lost.delete(id);
    }
    return out;
  }

  setIdentity(trackId, identity) {
    const track = this.tracks.get(trackId) ?? this.lost.get(trackId);
    if (track) track.identity = identity;
  }

  get(trackId) {
    return this.tracks.get(trackId) ?? this.lost.get(trackId) ?? null;
  }

  /** Whether this id is still meaningful -- on screen, or recently enough gone
   * that an answer about it is still worth keeping. */
  has(trackId) {
    return this.tracks.has(trackId) || this.lost.has(trackId);
  }

  reset() {
    this.tracks.clear();
    this.lost.clear();
  }
}

/**
 * Cuts one face out of the live picture as a JPEG.
 *
 * Crops from the SOURCE element at its natural size, never from the downscaled
 * detection canvas. That distinction was measured: SFace on an upscaled 50 px
 * face produces an embedding drifting toward the population average, which is
 * exactly the regime where everybody weakly matches everybody.
 *
 * @param media       the <img> or <video> actually on screen
 * @param bbox        the face box, in DETECT-space coordinates
 * @param detectWidth width of the detection canvas those coordinates belong to
 * @param pad         context to keep around the face; YuNet re-detects inside
 *                    this crop and wants a little room around the head
 * @returns a base64 JPEG (no data: prefix), or null
 */
export function cropFaceToJpeg(media, bbox, detectWidth, pad = 1.4, quality = CROP_QUALITY) {
  const naturalWidth = media?.naturalWidth || media?.videoWidth || 0;
  const naturalHeight = media?.naturalHeight || media?.videoHeight || 0;
  if (!naturalWidth || !naturalHeight || !detectWidth) return null;

  const scale = naturalWidth / detectWidth;
  const [x1, y1, x2, y2] = bbox;
  const cx = ((x1 + x2) / 2) * scale;
  const cy = ((y1 + y2) / 2) * scale;
  const width = (x2 - x1) * scale * pad;
  const height = (y2 - y1) * scale * pad;

  const left = Math.max(0, Math.round(cx - width / 2));
  const top = Math.max(0, Math.round(cy - height / 2));
  const right = Math.min(naturalWidth, Math.round(cx + width / 2));
  const bottom = Math.min(naturalHeight, Math.round(cy + height / 2));
  if (right - left < 8 || bottom - top < 8) return null;

  const cropWidth = right - left;
  const cropHeight = bottom - top;
  // Scale down on the way out rather than after encoding: the resize happens
  // in the same drawImage that does the crop, so it is free.
  const shrink = Math.min(1, CROP_MAX_SIDE / Math.max(cropWidth, cropHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cropWidth * shrink));
  canvas.height = Math.max(1, Math.round(cropHeight * shrink));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(
    media,
    left, top, cropWidth, cropHeight,
    0, 0, canvas.width, canvas.height,
  );
  // toDataURL rather than toBlob: the result goes into a JSON body as base64
  // anyway, and this avoids a FileReader round trip for a few KB.
  return canvas.toDataURL("image/jpeg", quality).split(",", 2)[1] ?? null;
}
