// Drawing a rectangle round an object, with a finger.
//
// WHY THIS IS HAND-BUILT (rule 10)
// --------------------------------
// Mantine has no control that lets you drag a rectangle over a picture, and
// there is nothing to compose one out of either -- this is a canvas and a
// pointer gesture, not an arrangement of inputs. Asked for and approved before
// it was written.
//
// Faces never needed it: YuNet finds the face and the box comes for free. An
// object nobody has trained for has no such detector, so the one thing only a
// person can supply is WHICH PIXELS ARE THE OBJECT. That is this component's
// entire job.
//
// TWO THINGS THAT LOOK LIKE DETAILS AND ARE NOT
// ---------------------------------------------
// 1. touch-action. The video overlay elsewhere in this app uses
//    `touch-manipulation`, which leaves panning to the browser -- correct for
//    tapping a face, fatal here: the first finger-drag would scroll the page
//    instead of drawing anything. The canvas therefore sets `touch-none`, and
//    only the canvas does, so scrolling everywhere else is untouched. It has to
//    be set BEFORE the gesture starts, not while it runs: touch-action is
//    consulted when the browser decides what a gesture means, and by the time
//    a move event arrives that decision has already been taken.
//
// 2. The coordinates. The picture is letterboxed inside its box, so a finger
//    position is not a picture position, and the naive calculation lands a
//    consistent distance out -- which reads as "the box is slightly off"
//    rather than as a bug. detection/hittest.js already inverts that transform
//    for tapping faces; this reuses it rather than repeating it.

import { useEffect, useRef, useState } from "react";
import { Text } from "@mantine/core";
import { pointerToCanvasClamped } from "./detection/hittest";

// Below this, in picture pixels, a box is a mis-tap rather than a selection.
// Stray taps would otherwise produce a 2 px reference that matches everything
// and nothing.
const MIN_BOX_PX = 16;

/**
 * @param src       the still to draw on (data: URL or URL)
 * @param box       {x, y, w, h} in PICTURE pixels, or null
 * @param onChange  called with a new box, or null when one is discarded
 * @param disabled  no drawing, picture still shown
 */
export default function BoxPicker({ src, box, onChange, disabled = false }) {
  const canvasRef = useRef(null);
  const imageRef = useRef(null);
  const dragRef = useRef(null);
  const [ready, setReady] = useState(false);

  // Load the still, and size the canvas bitmap to the picture's own pixels --
  // not to the element's CSS size. Everything below then works in picture
  // coordinates, which is what gets sent to the server, and the browser does
  // the scaling for display.
  useEffect(() => {
    setReady(false);
    if (!src) {
      imageRef.current = null;
      return undefined;
    }
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      imageRef.current = image;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
      }
      setReady(true);
    };
    image.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  // Redraw on every change: the picture, then everything outside the box
  // dimmed, then the box itself. Dimming the outside rather than outlining the
  // inside is what makes a half-drawn box readable on a busy photograph.
  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !ready) return;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (!box || box.w < 1 || box.h < 1) return;

    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    // The inner rectangle wound the other way punches a hole in the fill.
    ctx.rect(box.x + box.w, box.y, -box.w, box.h);
    ctx.fill("evenodd");
    ctx.restore();

    // Scaled to the picture, so the outline is the same visual weight whether
    // the still is 480 px wide or 1920.
    const weight = Math.max(2, Math.round(canvas.width / 240));
    ctx.strokeStyle = "#40c057";
    ctx.lineWidth = weight;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = "#40c057";
    for (const [cx, cy] of [
      [box.x, box.y],
      [box.x + box.w, box.y],
      [box.x, box.y + box.h],
      [box.x + box.w, box.y + box.h],
    ]) {
      ctx.fillRect(cx - weight * 1.5, cy - weight * 1.5, weight * 3, weight * 3);
    }
  }, [box, ready]);

  function normalise(from, to) {
    return {
      x: Math.round(Math.min(from.x, to.x)),
      y: Math.round(Math.min(from.y, to.y)),
      w: Math.round(Math.abs(to.x - from.x)),
      h: Math.round(Math.abs(to.y - from.y)),
    };
  }

  function handlePointerDown(event) {
    if (disabled || !ready) return;
    const point = pointerToCanvasClamped(canvasRef.current, event.clientX, event.clientY);
    if (!point) return;
    // Capture, so a finger that leaves the canvas mid-drag keeps sending
    // moves here. Without it the box stops updating the moment the finger
    // crosses the edge -- exactly when you are boxing something near it.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = point;
    onChange(normalise(point, point));
  }

  function handlePointerMove(event) {
    if (!dragRef.current) return;
    const point = pointerToCanvasClamped(canvasRef.current, event.clientX, event.clientY);
    if (!point) return;
    onChange(normalise(dragRef.current, point));
  }

  function handlePointerUp(event) {
    if (!dragRef.current) return;
    const start = dragRef.current;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const point = pointerToCanvasClamped(canvasRef.current, event.clientX, event.clientY);
    const finished = normalise(start, point ?? start);
    // A tap, not a drag. Discarded rather than kept, so tapping the picture by
    // accident does not silently replace a good box with a dot.
    onChange(finished.w < MIN_BOX_PX || finished.h < MIN_BOX_PX ? null : finished);
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <canvas
        ref={canvasRef}
        // touch-none: see the note at the top. This is what lets a finger draw
        // instead of scrolling the page.
        className={
          // 50vh, not 60. The dialog also carries a header, a hint line and
          // the Annulla/Salva row, and at 60 those together overflowed a phone
          // screen -- which is how Salva ended up half off the bottom.
          "block max-h-[50vh] w-full touch-none select-none rounded-md bg-black object-contain " +
          (disabled ? "cursor-default" : "cursor-crosshair")
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
      <Text size="xs" c="dimmed">
        {box
          ? `Riquadro: ${box.w}x${box.h} pixel. Disegnane un altro per cambiarlo.`
          : "Trascina il dito attorno all'oggetto per disegnare un riquadro."}
      </Text>
    </div>
  );
}
