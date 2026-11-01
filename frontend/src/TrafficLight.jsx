// The judgement recorded about a person, as a traffic light.
//
// Inline SVG rather than an icon font or an image: there are three lamps and
// two states each, it has to match the colour drawn on the video box exactly,
// and the colours come from the server (faces.JUDGES) so the two cannot drift.

const ORDER = ["buono", "accettabile", "cattivo"];

// Used when the page has not yet been told the colours. Same values as
// faces.JUDGES on the server; if you change them, change them there.
const FALLBACK = {
  buono: "#2f9e44",
  accettabile: "#f08c00",
  cattivo: "#e03131",
};

/**
 * @param judge   which lamp is lit: "buono" | "accettabile" | "cattivo"
 * @param judges  { judge: colour } from GET /faces
 * @param size    height in pixels
 */
export default function TrafficLight({ judge, judges, size = 34, title }) {
  const colors = judges ?? FALLBACK;
  // Proportioned so the three lamps nearly fill the width: a narrower body
  // reads as a stripe rather than as a traffic light at the sizes used here.
  const lampRadius = size / 7;
  const padding = lampRadius * 0.55;
  const gap = lampRadius * 2.35;
  const width = lampRadius * 2 + padding * 2;
  const height = gap * 2 + lampRadius * 2 + padding * 2;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={title ?? judge ?? "nessun giudizio"}
    >
      <title>{title ?? judge ?? "nessun giudizio"}</title>
      <rect
        x="0.5"
        y="0.5"
        width={width - 1}
        height={height - 1}
        rx={lampRadius}
        fill="#2b2b2b"
        stroke="#111"
      />
      {ORDER.map((name, index) => {
        const lit = name === judge;
        return (
          <circle
            key={name}
            cx={width / 2}
            cy={padding + lampRadius + index * gap}
            r={lampRadius}
            fill={lit ? (colors[name] ?? FALLBACK[name]) : "#4a4a4a"}
            // A lit lamp glows; an unlit one is just a dark disc. Without this
            // the three greys and one colour read as "one is selected" only if
            // you already know what you are looking at.
            opacity={lit ? 1 : 0.55}
          />
        );
      })}
    </svg>
  );
}
