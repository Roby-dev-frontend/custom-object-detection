// Where a picture was taken, as a link that opens Google Maps -- the Maps app
// on a phone that has it, the website otherwise.
//
// The position comes from the device that took the picture (see /detect_ws);
// `accuracy` is its own estimate, in metres, of how far off it may be.
//
// As wide as its text and no wider: inside a Stack a link stretches to the
// full width, and a tap anywhere along that line opened Maps.

import { Anchor } from "@mantine/core";

export function mapsUrl(position) {
  return `https://www.google.com/maps?q=${position.lat},${position.lon}`;
}

/** The pin Google Maps uses (Material "place" icon), in Maps' red whatever the
 * link's own colour. No icon library is installed; this one glyph is drawn
 * here. */
function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" width="1.15em" height="1.15em" aria-hidden
         className="shrink-0 text-[#d33f3f]">
      <path
        fill="currentColor"
        d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"
      />
    </svg>
  );
}

/** `short`: "Mappa" instead of "Apri in Google Maps", for narrow places. */
export default function MapsLink({ position, short = false, className = "", ...props }) {
  if (!position) return null;
  const accuracy =
    position.accuracy != null ? ` (± ${Math.round(position.accuracy)} m)` : "";
  return (
    <Anchor
      href={mapsUrl(position)}
      target="_blank"
      rel="noopener noreferrer"
      size="sm"
      className={`inline-flex w-fit items-center gap-1 self-start ${className}`}
      {...props}
    >
      <PinIcon />
      {/* Cut short on one line where there is room for it; the short form,
          under a 110 px photo, wraps instead -- cut, it lost the accuracy. */}
      <span className={short ? "min-w-0" : "min-w-0 truncate"}>
        {short ? "Mappa" : "Apri in Google Maps"}
        {accuracy}
      </span>
    </Anchor>
  );
}
