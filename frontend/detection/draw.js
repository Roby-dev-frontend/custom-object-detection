// Port of draw_detections() in detection.py, for hands and objects.
//
// Those two must stay in step: the server can still detect and draw for itself
// (detection_config.location === "server"), and switching between the two
// should not change how the picture looks. If you change a colour or a
// thickness for hands or objects here, change it there too.
//
// FACES are the exception, and deliberately have no Python counterpart. They
// are a browser-only backend -- annotate() in detection.py returns the frame
// untouched for backend "face" -- because only the page knows which face is
// selected and what name came back for it. Nothing to keep in step.

import { drawingSize, fitScale } from "./hittest";

// The 21 hand landmarks are connected in these pairs. Same set MediaPipe's
// HAND_CONNECTIONS uses on the Python side, written out because the JS package
// exposes it as HandLandmarker.HAND_CONNECTIONS only after a model has loaded.
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], // thumb
  [0, 5], [5, 6], [6, 7], [7, 8], // index
  [5, 9], [9, 10], [10, 11], [11, 12], // middle
  [9, 13], [13, 14], [14, 15], [15, 16], // ring
  [13, 17], [17, 18], [18, 19], [19, 20], // little
  [0, 17], // palm
];

// detection.py draws in BGR because OpenCV does; the same colours in RGB.
const LINE_COLOR = "rgb(0, 255, 0)"; // (0, 255, 0) BGR -> green either way
const POINT_COLOR = "rgb(255, 0, 0)"; // (0, 0, 255) BGR is red

// A face we have not identified. Neutral on purpose: the traffic-light colours
// mean a judgement about a named person, and painting an unknown face green
// would say something we have not earned.
const UNKNOWN_COLOR = "rgb(200, 200, 200)";

// The caption size, in the pixels of the SCREEN rather than of the bitmap.
//
// This distinction was the whole bug. The overlay bitmap is FACE_DETECT_WIDTH
// (640) across whatever the size of the element showing it, so a fixed 15 px
// of bitmap came out at about 9 px on a phone, where the canvas is ~390 CSS px
// wide -- and at 23 px on a 1000 px desktop, which is why it looked fine here
// and was unreadable in the hand. Converting through canvas.clientWidth makes
// the caption the same size on every screen.
const LABEL_CSS_PX = 17;
const LABEL_MIN_PX = 12;
const LABEL_MAX_PX = 44;

/**
 * The longest of `options` that fits, cut with an ellipsis if none of them do.
 *
 * The options exist because "Claudio Bi…" is a worse label than "Claudio": a
 * name the reader completes themselves beats a name chopped mid-word. The
 * caller passes the full name first and the first name after it.
 */
function fitText(ctx, options, maxWidth) {
  const candidates = Array.isArray(options) ? options : [options];
  for (const candidate of candidates) {
    if (ctx.measureText(candidate).width <= maxWidth) return candidate;
  }
  let cut = candidates[candidates.length - 1];
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/** What to write under a face, given what the server said about it. */
function faceCaption(identity) {
  if (!identity) return "…";
  switch (identity.status) {
    case "match": {
      const person = identity.person ?? {};
      const full = `${person.name ?? ""} ${person.surname ?? ""}`.trim();
      // Widest first: the full name where the box is wide enough for it, the
      // first name alone where it is not.
      return [full || "?", person.name || full || "?"];
    }
    // Deliberately NOT the maybe-name. Showing "Mario?" over the wrong person,
    // next to a red light that says "cattivo", is the failure the uncertain
    // band exists to prevent -- and a question mark is not a disclaimer people
    // read before they react to a name.
    // "???" rather than "?": a single question mark on a box reads as a
    // punctuation mark that lost its sentence, and at caption size it is
    // almost invisible. Three of them read as "the machine does not know".
    case "uncertain":
      return "???";
    // One answer has named somebody, but a second has to agree before that
    // name goes on the picture.
    case "checking":
      return "…";
    case "too_small":
      return "avvicinati";
    case "unknown":
      return "sconosciuto";
    default:
      return "…";
  }
}

/**
 * Draws face boxes with the identity written INSIDE the bottom edge of each
 * one.
 *
 * Inside the box, not floating beside it, because with several people on
 * screen a caption anywhere else forces the viewer to work out which face it
 * belongs to -- and it is attached to the box rather than being a DOM element
 * so that it cannot lag behind a moving face by a frame.
 *
 * @param selectedTrackId  the face the user tapped; drawn heavier
 * @param fit  "contain" or "cover" -- must match the CSS class on the canvas
 */
export function drawFaces(ctx, detections, selectedTrackId = null, fit = "contain") {
  const canvas = ctx.canvas;
  // How many CSS pixels one bitmap pixel is worth -- the scale object-fit
  // applied. Using the width alone was right only while the box matched the
  // source's aspect ratio; on a screen wider than the source it rendered the
  // caption far too small.
  //
  // The same helper the tap test uses, so the caption and the hit box can
  // never disagree about which fit is on screen.
  // In drawing coordinates, not bitmap pixels: the overlay's bitmap is larger
  // than what is drawn on it (see drawingSize), and the caption is sized in
  // what it is drawn in.
  const drawn = drawingSize(canvas);
  const shownWidth = canvas.clientWidth || drawn.width;
  const shownHeight = canvas.clientHeight || drawn.height;
  const cssPerBitmapPx =
    fitScale(fit, shownWidth, shownHeight, drawn.width, drawn.height) || 1;
  const fontPx = Math.round(
    Math.min(
      LABEL_MAX_PX,
      Math.max(LABEL_MIN_PX, LABEL_CSS_PX / cssPerBitmapPx),
    ),
  );
  const pad = Math.max(3, Math.round(fontPx * 0.3));
  ctx.font = `600 ${fontPx}px sans-serif`;
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";

  for (const detection of detections) {
    if (!detection.bbox) continue;
    const [x1, y1, x2, y2] = detection.bbox;
    const width = x2 - x1;
    const height = y2 - y1;
    const identity = detection.identity;
    const person = identity?.status === "match" ? identity.person : null;
    const color = person?.color ?? UNKNOWN_COLOR;
    const selected = selectedTrackId != null && detection.trackId === selectedTrackId;

    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 4 : 2;
    ctx.strokeRect(x1, y1, width, height);

    // A second, darker outline just outside the selected box. On a bright
    // background a thicker line of the same colour is not obviously thicker;
    // a contrasting edge always reads.
    if (selected) {
      ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x1 - 3, y1 - 3, width + 6, height + 6);
    }

    const stripHeight = fontPx + pad * 2;
    // A box too short for a caption gets the colour band alone: still tells
    // you the judgement, without unreadable text on top of the face.
    const showText = width >= fontPx * 3 && height >= stripHeight + 8;
    ctx.fillStyle = color;
    const bandHeight = showText ? stripHeight : Math.min(6, height);
    // The band may now be taller than a distant face's box, so it is allowed
    // to sit just BELOW the box rather than eating it. Clamped to the frame so
    // a face at the bottom edge keeps its caption on screen.
    const bandTop = showText && stripHeight > height / 2
      ? Math.min(drawn.height - bandHeight, y2)
      : y2 - bandHeight;
    ctx.fillRect(x1, bandTop, width, bandHeight);

    if (showText) {
      const caption = fitText(ctx, faceCaption(identity), width - pad * 2);
      // White with a dark outline, on every colour. Picking the text colour per
      // band (black on amber, white on green) reads well on a big screen and
      // fails on a phone in daylight, where the band itself is a few
      // millimetres tall; an outline is legible on all four without depending
      // on which one is behind it.
      const baseline = bandTop + bandHeight - pad;
      ctx.lineWidth = Math.max(2, fontPx * 0.18);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
      ctx.strokeText(caption, x1 + pad, baseline);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(caption, x1 + pad, baseline);
    }
  }
}

/**
 * Draws detections onto a 2D canvas context, in place.
 *
 * Hands carry `points` (the 21 landmarks) and are drawn as the skeleton;
 * everything else is drawn as its box and label -- exactly the split
 * draw_detections() makes in Python.
 *
 * The label uses the same readable-at-any-size recipe as drawFaces(): a
 * filled band behind white, black-outlined text, sized from the CSS pixels
 * the canvas is actually shown at rather than a fixed bitmap size -- a plain
 * fillText here was unreadable against a bright background and, on a small
 * box, could land above the top edge of the frame.
 *
 * @param fit  "contain" or "cover" -- must match the CSS class on the canvas
 */
export function drawDetections(ctx, detections, fit = "contain") {
  const canvas = ctx.canvas;
  const drawn = drawingSize(canvas);
  const shownWidth = canvas.clientWidth || drawn.width;
  const shownHeight = canvas.clientHeight || drawn.height;
  const cssPerBitmapPx =
    fitScale(fit, shownWidth, shownHeight, drawn.width, drawn.height) || 1;
  const fontPx = Math.round(
    Math.min(LABEL_MAX_PX, Math.max(LABEL_MIN_PX, LABEL_CSS_PX / cssPerBitmapPx)),
  );
  const pad = Math.max(3, Math.round(fontPx * 0.3));

  for (const detection of detections) {
    const points = detection.points;
    if (points && points.length) {
      ctx.strokeStyle = LINE_COLOR;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [start, end] of HAND_CONNECTIONS) {
        if (!points[start] || !points[end]) continue;
        ctx.moveTo(points[start][0], points[start][1]);
        ctx.lineTo(points[end][0], points[end][1]);
      }
      ctx.stroke();

      ctx.fillStyle = POINT_COLOR;
      for (const [x, y] of points) {
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      continue;
    }

    if (!detection.bbox) continue;
    const [x1, y1, x2, y2] = detection.bbox;
    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

    let label = detection.label ?? "";
    if (detection.confidence != null) {
      label = `${label} ${detection.confidence.toFixed(2)}`;
    }
    if (!label) continue;

    ctx.font = `600 ${fontPx}px sans-serif`;
    ctx.textBaseline = "alphabetic";
    const stripHeight = fontPx + pad * 2;
    const textWidth = ctx.measureText(label).width;
    // Above the box, like before; if that runs off the top of the frame,
    // inside it instead -- the same fallback drawFaces uses for the bottom.
    const bandTop = y1 - stripHeight < 0 ? y1 : y1 - stripHeight;
    ctx.fillStyle = LINE_COLOR;
    ctx.fillRect(x1, bandTop, textWidth + pad * 2, stripHeight);

    const baseline = bandTop + stripHeight - pad;
    ctx.lineWidth = Math.max(2, fontPx * 0.18);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
    ctx.strokeText(label, x1 + pad, baseline);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, x1 + pad, baseline);
  }
}
