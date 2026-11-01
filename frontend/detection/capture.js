/**
 * Grabbing whole frames out of the picture on screen.
 *
 * The sibling cropFaceToJpeg in faces.js cuts ONE face out of the frame,
 * because that is all SFace ever looks at. Gathering photographs of an object
 * is the opposite job: the background has to come too. What makes those photos
 * worth measuring is precisely that the object appears in a real room, at a
 * real distance, with real clutter behind it -- a set of tight crops would
 * prove only that the object matches itself.
 *
 * Read from the source element at its natural size for the same reason
 * cropFaceToJpeg does: the detection canvas the overlay uses is downscaled to
 * a few hundred pixels, and keypoint matching has nothing to hold on to once
 * the texture has been resampled away.
 */

// Long side of a stored frame. Big enough to keep the texture ORB needs --
// shrinking to detection size (240-320 px) would throw away the very detail
// the measurement is about -- and small enough that ten of them fit in one
// request comfortably under the server's cap.
export const CAPTURE_MAX_SIDE = 960;
export const CAPTURE_QUALITY = 0.9;

/**
 * One frame of whatever is on screen, as base64 JPEG (no data: prefix).
 *
 * @param media   the <img> or <video> actually being displayed
 * @returns a base64 JPEG, or null when the element has no picture yet
 */
export function frameToJpeg(media, maxSide = CAPTURE_MAX_SIDE, quality = CAPTURE_QUALITY) {
  const naturalWidth = media?.naturalWidth || media?.videoWidth || 0;
  const naturalHeight = media?.naturalHeight || media?.videoHeight || 0;
  // An <img> that has not painted yet reports 0x0, and drawing it produces a
  // blank rectangle rather than an error -- a file that looks like a capture
  // and contains nothing.
  if (!naturalWidth || !naturalHeight) return null;

  const shrink = Math.min(1, maxSide / Math.max(naturalWidth, naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(naturalWidth * shrink));
  canvas.height = Math.max(1, Math.round(naturalHeight * shrink));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality).split(",", 2)[1] ?? null;
}

/**
 * A burst of frames, spaced out in time.
 *
 * The spacing is the whole point: ten frames grabbed in one tick are ten
 * copies of one instant, and a record built from them describes a single pose
 * while looking like it has ten pieces of evidence. faces.py measured exactly
 * that trap on people (ENROL_MAX_SIMILARITY), and an object held in the hand
 * is no different -- the gap is what lets you turn it between shots.
 *
 * @param getMedia  called before every frame, so switching source mid-burst
 *                  cannot keep capturing from an element no longer on screen
 * @param onCapture optional, called right after each frame is grabbed (even
 *                  one that came back empty) -- so the page can flash the
 *                  screen at the instant the photo was actually taken,
 *                  rather than at the start of the whole burst.
 */
export async function captureBurst(getMedia, count, gapMs = 400, onCapture) {
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const jpeg = frameToJpeg(getMedia());
    if (jpeg) frames.push(jpeg);
    onCapture?.(i, count);
    if (i < count - 1) {
      await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
  }
  return frames;
}


// The server refuses an image whose base64 is longer than this
// (MAX_CAPTURE_B64 in server_fastapi.py). Stated here so the browser can shrink
// a photograph until it fits instead of sending one that will be rejected.
export const CAPTURE_MAX_B64 = 900_000;

/**
 * A file from disk as base64 JPEG, scaled the way a captured frame is.
 *
 * Deliberately an <img> and not createImageBitmap: every browser that can
 * reach this page can decode into an <img>, and the scaling that follows is
 * frameToJpeg's, so an imported photograph and a captured one end up the same
 * size and quality.
 *
 * @returns base64 JPEG, or null when this browser cannot decode the file --
 *          HEIC from an iPhone is the common case, readable in Safari and not
 *          in Chrome or Firefox.
 */
export async function fileToJpeg(file, maxSide = CAPTURE_MAX_SIDE, quality = CAPTURE_QUALITY) {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("undecodable"));
      element.src = url;
    });
    return frameToJpeg(image, maxSide, quality);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The same, but guaranteed to fit the server's per-image cap.
 *
 * A noisy 960 px photograph can exceed the cap on its own, so quality comes
 * down first and only then the size: shrinking below CAPTURE_MAX_SIDE costs the
 * texture ORB needs to find anything at all, which is worth more than the last
 * few per cent of compression.
 *
 * @returns {{jpeg: string, shrunk: boolean} | null}
 */
export async function fileToJpegUnderCap(file, maxBytes = CAPTURE_MAX_B64) {
  const attempts = [
    [CAPTURE_MAX_SIDE, CAPTURE_QUALITY],
    [CAPTURE_MAX_SIDE, 0.75],
    [CAPTURE_MAX_SIDE, 0.6],
    [720, 0.75],
    [640, 0.7],
  ];
  for (const [side, quality] of attempts) {
    const jpeg = await fileToJpeg(file, side, quality);
    if (jpeg === null) return null;                 // cannot be decoded at all
    if (jpeg.length <= maxBytes) {
      return { jpeg, shrunk: side < CAPTURE_MAX_SIDE };
    }
  }
  return null;
}

/**
 * A file for the text reader: the whole picture at up to 1600 px, stepped down
 * only as far as the server's cap needs. Small print needs more pixels than the
 * 960 px an object photo is kept at.
 *
 * @returns base64 JPEG, or null when this browser cannot decode the file.
 */
export async function fileToTextJpeg(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("undecodable"));
      element.src = url;
    });
    return await averagedFrameToJpeg(image, 1, 0);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * One picture made of several frames of the same scene, averaged.
 *
 * WHY: the noise in a dim webcam frame is different in every frame, while the
 * paper is the same. Averaging N frames divides the noise by about sqrt(N) and
 * leaves the text where it was. Measured on rendered text in a dark, grainy
 * room (scripts/ocr_bench.py's conditions): Tesseract found 17% of the words in
 * one frame, 67% in an average of 4, 92% in 8, 95% in 16.
 *
 * THE COST: it takes count * gapMs (about 0.8 s at the defaults) and the paper
 * has to stay still for it. A page that moves smears into a blur, which is
 * worse than the grain it was meant to remove -- the caller says so.
 *
 * The frames are summed as integers (8 x 255 fits a Uint16 many times over) and
 * divided once, so no precision is lost on the way, and the result is encoded at
 * a high quality because the JPEG step adds noise of its own.
 */
export async function averagedFrameToJpeg(
  media,
  count = 8,
  gapMs = 100,
  maxSide = 1600,
  quality = 0.92,
  region = null,
) {
  const naturalWidth = media?.naturalWidth || media?.videoWidth || 0;
  const naturalHeight = media?.naturalHeight || media?.videoHeight || 0;
  if (!naturalWidth || !naturalHeight) return null;
  // Only this rectangle of the picture (natural pixels), or all of it.
  const source = region
    ? {
        x: Math.max(0, Math.round(region.x)),
        y: Math.max(0, Math.round(region.y)),
        width: Math.min(naturalWidth - Math.max(0, Math.round(region.x)), Math.round(region.width)),
        height: Math.min(naturalHeight - Math.max(0, Math.round(region.y)), Math.round(region.height)),
      }
    : { x: 0, y: 0, width: naturalWidth, height: naturalHeight };
  if (source.width < 8 || source.height < 8) return null;

  const shrink = Math.min(1, maxSide / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * shrink));
  const height = Math.max(1, Math.round(source.height * shrink));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  let sum = null;
  for (let index = 0; index < count; index += 1) {
    ctx.drawImage(media, source.x, source.y, source.width, source.height, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    if (!sum) sum = new Uint16Array(pixels.length);
    for (let at = 0; at < pixels.length; at += 1) sum[at] += pixels[at];
    if (index < count - 1) await new Promise((resolve) => setTimeout(resolve, gapMs));
  }

  const averaged = ctx.createImageData(width, height);
  for (let at = 0; at < sum.length; at += 1) averaged.data[at] = Math.round(sum[at] / count);
  ctx.putImageData(averaged, 0, 0);

  // Stepped down until the base64 fits the server's cap, like every other
  // upload here; the averaged canvas is the one thing that is never redone.
  for (const [side, q] of [[maxSide, quality], [1200, 0.85], [960, 0.75]]) {
    let target = canvas;
    if (Math.max(width, height) > side) {
      const scale = side / Math.max(width, height);
      target = document.createElement("canvas");
      target.width = Math.round(width * scale);
      target.height = Math.round(height * scale);
      target.getContext("2d").drawImage(canvas, 0, 0, target.width, target.height);
    }
    const jpeg = target.toDataURL("image/jpeg", q).split(",", 2)[1] ?? null;
    if (jpeg && jpeg.length <= CAPTURE_MAX_B64) return jpeg;
  }
  return null;
}
