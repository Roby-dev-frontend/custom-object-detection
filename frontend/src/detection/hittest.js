// Turning a tap into a position on the overlay canvas.
//
// This looks like it should be three lines of proportion, and it is not. The
// overlay canvas is sized in DETECT space -- whatever aspect ratio the camera
// happens to produce -- while its CSS box is the full-screen stage, whatever
// shape the window is. The two almost never agree, so `object-fit` has to
// reconcile them, and a plain `(x - rect.left) / rect.width * canvas.width`
// then lands a consistent distance from where the finger actually was. That
// does not read as a coordinate bug: it reads as "selecting a face is flaky".
//
// So the object-fit transform is inverted here, once, in its own file.
//
// BOTH fits are live now -- the App panel has a switch -- and the only
// difference between them is Math.min vs Math.max. Getting that one character
// wrong throws nothing: taps simply miss by up to half a band. Which is why
// `fit` is passed in from the same state that sets the CSS class, rather than
// each file deciding for itself.

/** The scale object-fit applies, for either fit. */
export function fitScale(fit, boxWidth, boxHeight, bitmapWidth, bitmapHeight) {
  const byWidth = boxWidth / bitmapWidth;
  const byHeight = boxHeight / bitmapHeight;
  // `contain`: scale by whichever axis needs the LESS magnification, so the
  // whole bitmap fits inside the box and a band is left on the other axis.
  // `cover`: the MORE, so the box is filled and the overflow is cropped.
  return fit === "cover" ? Math.max(byWidth, byHeight) : Math.min(byWidth, byHeight);
}

/**
 * Maps a pointer event to canvas bitmap coordinates.
 *
 * @param canvas  the overlay <canvas>
 * @param clientX,clientY  from a PointerEvent
 * @param fit     "contain" (default) or "cover" -- must match the CSS class
 *                actually on the element
 * @returns {{x:number,y:number}} or null when the point is outside the
 *          picture -- which with `contain` is the ordinary case: the bands are
 *          part of the stage and a tap in one is a tap on nothing. With
 *          `cover` there is no band, so this only rejects a tap outside the
 *          element itself.
 */
export function pointerToCanvas(canvas, clientX, clientY, fit = "contain") {
  if (!canvas || !canvas.width || !canvas.height) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const { width, height } = drawingSize(canvas);

  const scale = fitScale(fit, rect.width, rect.height, width, height);
  // Centred, which is object-position's 50% 50% default. This is the width of
  // the band on that axis, and it is zero on the axis that fills the box.
  const offsetX = (rect.width - width * scale) / 2;
  const offsetY = (rect.height - height * scale) / 2;

  const x = (clientX - rect.left - offsetX) / scale;
  const y = (clientY - rect.top - offsetY) / scale;
  if (x < 0 || y < 0 || x > width || y > height) return null;
  return { x, y };
}

/**
 * A canvas's size in the coordinates things are DRAWN in -- the detector's
 * pixels -- rather than in bitmap pixels.
 *
 * The overlay's bitmap is made larger than the detector's frame, and a
 * transform maps detector pixels onto it, so boxes and captions are drawn at
 * the screen's own resolution instead of being stretched up from 480-640 px
 * and blurred. Anything that relates the canvas to detection coordinates --
 * the tap mapping here, the caption sizing in draw.js -- must use this rather
 * than canvas.width, or it is off by exactly that factor. A canvas with no
 * `pixelScale`, which is every canvas except the overlay, has a scale of 1 and
 * gets canvas.width back unchanged.
 */
export function drawingSize(canvas) {
  const scale = canvas.pixelScale || 1;
  return { width: canvas.width / scale, height: canvas.height / scale };
}

/**
 * The same mapping, but clamped to the picture instead of refused.
 *
 * pointerToCanvas returns null outside the bands, which is right for a TAP:
 * a tap on a black band is a tap on nothing. It is wrong for a DRAG, and in
 * the most ordinary case there is -- dragging a box around something near the
 * edge, where the finger crosses into the band or leaves the element
 * altogether. Refusing those points would freeze the rectangle mid-gesture and
 * read as the box "sticking".
 *
 * Kept here rather than in the component so the object-fit arithmetic stays in
 * one file. Two copies of it drifting apart is precisely what this module's
 * opening comment exists to prevent.
 */
export function pointerToCanvasClamped(canvas, clientX, clientY, fit = "contain") {
  if (!canvas || !canvas.width || !canvas.height) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const { width, height } = drawingSize(canvas);

  const scale = fitScale(fit, rect.width, rect.height, width, height);
  const offsetX = (rect.width - width * scale) / 2;
  const offsetY = (rect.height - height * scale) / 2;

  const x = (clientX - rect.left - offsetX) / scale;
  const y = (clientY - rect.top - offsetY) / scale;
  return {
    x: Math.min(width, Math.max(0, x)),
    y: Math.min(height, Math.max(0, y)),
  };
}

/**
 * The detection whose box contains this point, or null.
 *
 * Smallest box wins when boxes overlap: a face in front of another is drawn
 * inside it, and the nearer, smaller one is what a finger on that spot means.
 */
export function detectionAt(detections, x, y) {
  let best = null;
  let bestArea = Infinity;
  for (const detection of detections ?? []) {
    const [x1, y1, x2, y2] = detection.bbox;
    if (x < x1 || x > x2 || y < y1 || y > y2) continue;
    const area = (x2 - x1) * (y2 - y1);
    if (area < bestArea) {
      bestArea = area;
      best = detection;
    }
  }
  return best;
}
