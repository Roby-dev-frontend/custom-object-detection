import { drawingSize, fitScale } from "./hittest";

const LINE_COLOR = "rgb(0, 255, 0)";
const LABEL_CSS_PX = 17;
const LABEL_MIN_PX = 12;
const LABEL_MAX_PX = 44;

export function drawDetections(ctx, detections, fit = "contain") {
  const canvas = ctx.canvas;
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

  for (const detection of detections) {
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
