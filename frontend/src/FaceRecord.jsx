// The whole record of one person, filling the screen.
//
// This is what "Dettagli" opens, and it stays open until its close button is
// pressed -- the small caption under the video follows whoever is in front of
// the camera, so it is gone the moment you look away from the screen to talk
// to the person. This does not move and does not update.
//
// Two halves, ALWAYS stacked: the photographs above, the description below.
// It used to turn side by side from `sm` up, which on a wide screen left each
// half about half the width and put the photographs on a vertical slider.
//
// The photographs are ALL there at once, in one row as tall as their half,
// scrolling sideways. It used to be a slider showing one at a time, which hid
// every photograph but the first behind the arrows.

import { CloseButton, Group, Image, Modal, ScrollArea, Text, UnstyledButton } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import TrafficLight from "./TrafficLight";
import MapsLink from "./MapsLink";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// How far the pointer may travel before a press counts as a drag rather than
// as a tap on the photograph.
const DRAG_SLOP = 4;

export default function FaceRecord({ person, judges, onClose }) {
  // Which photograph is enlarged, by index. Cleared whenever the panel opens
  // on somebody else, which `key` on the modal below takes care of.
  const [zoom, setZoom] = useState(null);
  const stripRef = useRef(null);

  // Opening a record always starts at the first photograph.
  //
  // Done on OPEN and not on close, deliberately: a closed record has no layout
  // box, and assigning scrollLeft to an element that is not being laid out is
  // silently a no-op -- which is exactly why resetting it on close appeared to
  // do nothing.
  useEffect(() => {
    if (!person) return;
    const element = stripRef.current;
    if (element) element.scrollLeft = 0;
  }, [person?.id]);
  // The drag in progress, and whether the last one moved. A mouse press that
  // turned into a drag must not also open the photograph it started on.
  const dragRef = useRef(null);
  const draggedRef = useRef(false);

  // A finger already scrolls this: it is a real overflow container, and taking
  // the gesture over would only make it worse. A MOUSE does not, which is what
  // these three handlers are for -- on a laptop the row has to be draggable
  // too.
  function handlePointerDown(event) {
    // Every press starts clean. Clearing this here rather than in the click
    // handler matters: a drag big enough to scroll often fires no click at
    // all, and the flag left standing would then swallow the NEXT one -- a
    // real tap, on a photograph the user meant to enlarge.
    draggedRef.current = false;
    const element = stripRef.current;
    if (event.pointerType !== "mouse" || !element) return;
    dragRef.current = { x: event.clientX, left: element.scrollLeft, moved: false };
    // No pointer capture here, deliberately. Capturing on the press retargets
    // the click that follows it to the strip, and the photograph underneath
    // then never hears about being clicked -- the press has to prove it is a
    // drag first. Capture is taken in handlePointerMove instead.
  }

  function handlePointerMove(event) {
    const drag = dragRef.current;
    const element = stripRef.current;
    if (!drag || !element) return;
    const dx = event.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > DRAG_SLOP) {
      drag.moved = true;
      // Now that this is certainly a drag, keep receiving moves even when the
      // mouse leaves the strip.
      element.setPointerCapture?.(event.pointerId);
    }
    element.scrollLeft = drag.left - dx;
  }

  function handlePointerUp(event) {
    const drag = dragRef.current;
    const element = stripRef.current;
    dragRef.current = null;
    if (!drag || !element) return;
    if (element.hasPointerCapture?.(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
    draggedRef.current = drag.moved;
  }

  if (!person) return null;
  const photos = person.photos?.length ? person.photos : person.photo ? [person.photo] : [];
  const source = (name) => `${API_BASE}/faces/photo/${name}`;

  return (
    <Modal
      key={person.id}
      opened
      onClose={onClose}
      fullScreen
      withCloseButton
      // Only the button closes it, which is the whole point of pinning a
      // record: a stray tap on the video behind must not dismiss it.
      closeOnClickOutside={false}
      closeButtonProps={{ "aria-label": "Chiudi la scheda", size: "lg" }}
      title={
        <Group gap="sm" wrap="nowrap">
          <TrafficLight judge={person.judge} judges={judges} size={32} />
          <div className="min-w-0 text-left">
            <Text fw={600} truncate>
              {person.name} {person.surname}
            </Text>
            {/* The judgement word in the judgement's own colour -- the same
                colour its box is drawn in on the video and in the context bar.
                The colour comes from the server with the person, so nothing is
                invented here. */}
            <Text size="xs" style={{ color: person.color }}>
              {person.judge}
            </Text>
          </div>
        </Group>
      }
      classNames={{
        content: "flex flex-col",
        // relative, because the enlarged photograph covers the whole body
        // rather than only the half it came from -- on a phone that half is
        // 40% of the height, which is not an enlargement.
        body: "relative flex-1 min-h-0 p-0",
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="relative h-2/5 min-h-0 shrink-0 overflow-hidden border-b border-[var(--mantine-color-default-border)] p-2 sm:h-1/2">
          {photos.length ? (
            <div
              ref={stripRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              // Every photograph as tall as this half, side by side, so the
              // row scrolls sideways once they do not all fit. The scrollbar
              // stays: with several photographs on screen it is what says
              // there are more.
              className="flex h-full w-full cursor-grab select-none gap-2 overflow-x-auto overflow-y-hidden overscroll-contain active:cursor-grabbing"
            >
              {photos.map((name, position) => (
                // Beside the button, not inside it: a link inside a button is
                // two controls in one, and the tap would open the photograph.
                <div key={name} className="relative h-full shrink-0">
                  <UnstyledButton
                    onClick={() => {
                      // The click that ends a drag is not a tap on a picture.
                      if (draggedRef.current) return;
                      setZoom(position);
                    }}
                    aria-label={`Ingrandisci la foto ${position + 1}`}
                    className="h-full"
                  >
                    <Image
                      src={source(name)}
                      alt=""
                      draggable={false}
                      radius="sm"
                      className="h-full w-auto max-w-none"
                    />
                  </UnstyledButton>
                  {/* Where it was taken, for a photo saved from the strip of a
                      device that knew its position. */}
                  <MapsLink
                    position={person.photo_places?.[name]}
                    size="xs"
                    className="absolute bottom-1 left-1 max-w-[calc(100%-8px)] truncate rounded bg-black/70 px-1.5 py-0.5 !text-white"
                  />
                </div>
              ))}
            </div>
          ) : (
            <Text size="sm" c="dimmed" className="flex h-full items-center justify-center">
              Nessuna foto per questa persona.
            </Text>
          )}
        </div>

        {/* The description, scrolling on its own. Dragging the text is how a
            browser scrolls a real overflow container, which is what this is --
            on a phone the scrollbar is far too thin to aim at.
            overscroll-contain stops a flick past the end from scrolling the
            page underneath. */}
        <div className="min-h-0 flex-1">
          <ScrollArea h="100%" type="auto" className="overscroll-contain px-4 py-3">
            {person.description ? (
              <Text className="text-left whitespace-pre-wrap">{person.description}</Text>
            ) : (
              <Text size="sm" c="dimmed" className="text-left">
                Nessuna descrizione.
              </Text>
            )}
          </ScrollArea>
        </div>
      </div>

      {zoom !== null && photos[zoom] ? (
        // Opaque, not a 90% wash: at 90% the description behind stays just
        // legible enough to compete with the photograph.
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black p-4">
          <Image
            src={source(photos[zoom])}
            alt=""
            fit="contain"
            className="max-h-full max-w-full object-contain"
          />
          <CloseButton
            onClick={() => setZoom(null)}
            aria-label="Chiudi la foto"
            size="lg"
            variant="filled"
            color="dark"
            className="absolute top-2 right-2"
          />
        </div>
      ) : null}
    </Modal>
  );
}
