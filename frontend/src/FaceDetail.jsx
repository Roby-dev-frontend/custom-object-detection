// The context bar: what the page shows about the face you tapped, and what you
// can do about it.
//
// One face at a time, never a list. That is the whole point: with several
// people on screen, a panel showing all of them forces the viewer to work out
// which row belongs to which box. Selecting one removes the question, which is
// why the box labels carry only a name and everything else lives here.
//
// THREE BUTTON SLOTS THAT NEVER MOVE. Only their labels and their disabled
// state change with the state of the selected face. This is deliberate and it
// fixes a real complaint: "the button to save a face disappears too fast".
// Buttons that never move cannot disappear from under a finger, and the hand
// learns where each one is instead of hunting for it every time.
//
// The labels are never truncated either: an ellipsis hides the word that says
// what the button does. They wrap to two lines, and the bar is tall enough for
// two.

import { Badge, Button, Group, Image, Stack, Text } from "@mantine/core";
import TrafficLight from "./TrafficLight";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// Labels wrap instead of ellipsing; Mantine's Button label is single-line by
// default. min-h keeps the row the same height whether a label took one line
// or two, so nothing shifts as the state changes.
const WRAP = { label: "whitespace-normal leading-tight" };

function Slot({ spec, wide = false }) {
  // `label` is the button's text, not a DOM attribute -- pulled out so it is
  // not spread onto the element.
  const { label, ...props } = spec;
  return (
    <Button
      size="sm"
      classNames={WRAP}
      // h-auto matters as much as the width. Mantine gives a Button a FIXED
      // height from its size, and the root clips what does not fit -- so a
      // label wrapping to three lines in a 101 px slot had its last word cut
      // in half, which is the exact failure wrapping was meant to avoid.
      // Height from the content, with a floor so a one-line slot is still a
      // comfortable target.
      //
      // The primary slot gets about 1.6x the others: the long labels ("Salva
      // come nuova persona") do not fit three equal slots on a 390 px phone.
      className={`${wide ? "grow-[1.6]" : "grow"} basis-0 h-auto min-h-[46px] px-2 py-1.5`}
      {...props}
    >
      {label}
    </Button>
  );
}

export default function FaceDetail({
  detection,        // the selected face, with .identity attached
  judges,
  faceCount,        // how many faces are on screen right now
  busy = false,
  onSave,           // enrol this face
  onEdit,           // edit the person it was recognised as
  onDetails,        // pin this person's full record on screen
  onAddView,        // teach this person's record the current angle
  onPickPerson,     // choose an enrolled person by name and add this view
  addingView = false,
}) {
  const identity = detection?.identity;
  const status = identity?.status;
  const person = status === "match" ? identity.person : null;
  const maybe = status === "uncertain" ? identity?.maybe : null;

  // --- the status line -------------------------------------------------

  let line;
  if (person) {
    line = (
      <Group gap="sm" wrap="nowrap" className="min-w-0">
        {person.photo && (
          <Image src={`${API_BASE}/faces/photo/${person.photo}`} alt="" w={38} h={38}
                 radius="sm" fit="cover" className="shrink-0" />
        )}
        <TrafficLight judge={person.judge} judges={judges} size={26} />
        <Stack gap={0} className="min-w-0">
          <Text fw={600} size="sm" truncate>
            {person.name} {person.surname}
          </Text>
          <Text size="xs" truncate>
            {/* The judgement written in the judgement's own colour -- the same
                colour its box is drawn in on the video. The colours come from
                the server with the person, so nothing is invented here. */}
            <span style={{ color: person.color }}>{person.judge}</span>
            {identity.score != null && (
              <span className="opacity-70">
                {" · somiglianza "}
                {/* A cosine in 0..1. Shown as a percentage because "0.98" is
                    not a number most people read as "almost certainly". */}
                {Math.round(identity.score * 100)}%
              </span>
            )}
          </Text>
        </Stack>
      </Group>
    );
  } else if (!detection) {
    line = (
      <Text size="sm" c="dimmed">
        {faceCount > 1 ? "Tocca un volto per selezionarlo." : "Nessun volto inquadrato."}
      </Text>
    );
  } else if (status === "too_small") {
    line = (
      <Text size="sm" c="dimmed">
        Il volto è troppo lontano per essere riconosciuto.
      </Text>
    );
  } else if (!identity || status === "checking") {
    line = (
      <Text size="sm" c="dimmed">
        Verifica in corso…
      </Text>
    );
  } else if (status === "uncertain") {
    line = (
      <Badge color="gray" variant="light">
        {maybe ? `Forse ${maybe.name} ${maybe.surname}`.trim() : "Non riconosciuto con certezza"}
      </Badge>
    );
  } else {
    line = (
      <Badge color="gray" variant="light">
        Sconosciuto
      </Badge>
    );
  }

  // --- the three slots -------------------------------------------------
  //
  // Every branch fills all three. A slot with nothing to do is disabled, not
  // removed.

  let primary = { label: "Salva questo volto", disabled: true };
  let secondary = { label: "Aggiungi a una persona…", disabled: true };
  let tertiary = { label: "Dettagli", disabled: true };

  if (person) {
    primary = {
      label: `+ Inquadratura (${person.samples ?? 0})`,
      onClick: () => onAddView(person.id),
      loading: addingView,
      title: "Aggiunge l'inquadratura attuale a questa persona",
    };
    secondary = { label: "Modifica", onClick: onEdit, variant: "default" };
    tertiary = { label: "Dettagli", onClick: onDetails, variant: "light" };
  } else if (!detection || status === "too_small") {
    // Nothing selected, or too far away to be worth asking about. The slots
    // stay where they are, greyed.
  } else if (status === "uncertain" && maybe) {
    primary = {
      // Shortened on purpose: "Sì, è Mario — aggiungi" does not fit a 390 px
      // phone in the primary slot. The full sentence is in the tooltip.
      label: `Sì, è ${maybe.name}`,
      title: `Sì, è ${maybe.name} ${maybe.surname ?? ""} — aggiungi questa inquadratura`.trim(),
      onClick: () => onAddView(maybe.id),
      loading: addingView,
    };
    secondary = { label: "È un altro…", onClick: onPickPerson, variant: "default" };
    // "Somebody I do not know, who happens to resemble somebody I do" is a
    // real case, and it needs the same button as a face nobody has ever seen.
    tertiary = { label: "Nuova persona", onClick: onSave, loading: busy, variant: "default" };
  } else {
    // unknown, uncertain-with-no-maybe, checking, and a face nobody has asked
    // about yet. The save button stays in all of them: this state arrives a
    // second after an unknown face appears and lasts until the answer firms
    // up, and hiding it made the button vanish mid-reach. A duplicate is
    // refused by the server anyway, with an offer to add the view to the
    // existing record instead.
    primary = {
      label: status === "uncertain" ? "Salva come nuova persona" : "Salva questo volto",
      onClick: onSave,
      loading: busy,
    };
    secondary = { label: "Aggiungi a una persona…", onClick: onPickPerson, variant: "default" };
  }

  return (
    <Stack gap={6} className="face-detail w-full px-2 py-1.5 text-left">
      <div className="flex min-h-[42px] items-center justify-center">{line}</div>
      <Group gap="xs" wrap="nowrap" align="stretch">
        <Slot wide spec={primary} />
        <Slot spec={secondary} />
        <Slot spec={tertiary} />
      </Group>
    </Stack>
  );
}
