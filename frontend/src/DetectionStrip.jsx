// The pictures the server kept when an own-camera device's frames contained
// something -- see /detect_ws in server_fastapi.py.
//
// A strip across the bottom of the video, newest first, on every device. Each
// thumbnail opens the picture, bigger, and has its own round ✕ on its
// top-right corner, which
// deletes the entry on the server for everybody. Inside the bigger picture the
// delete is a red "Elimina" button instead: that dialog already has a ✕, which
// closes it. "Nascondi" / "Mostra" folds the strip away, remembered on this
// device. "Svuota" deletes every picture in the strip from the server, for
// every device, after asking. Two arrows at the sides scroll the row a
// screenful at a time.
//
// Built from Mantine core only. There is no carousel in core, and the lightest
// thing that does the job is a row of images inside a ScrollArea.

import { useEffect, useRef, useState } from "react";
import ZoomableImage from "./ZoomableImage";
import {
  ActionIcon,
  Button,
  CloseButton,
  CopyButton,
  Group,
  Image,
  Modal,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
} from "@mantine/core";

import MapsLink from "./MapsLink";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// Where "hidden" is remembered. A per-device convenience, so the browser's own
// storage: it may be unavailable (private window), and then the strip is
// simply shown.
const HIDDEN_KEY = "detectionStripHidden";

export function savedImageUrl(entry) {
  return `${API_BASE}/detections_saved/${entry.id}.jpg`;
}

function when(entry) {
  return new Date(entry.created).toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function readHidden() {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** One of the two arrows, rendered with Mantine's ActionIcon. */
function ScrollArrow({ left, disabled, onClick }) {
  return (
    <ActionIcon
      variant="filled"
      color="dark"
      radius="xl"
      size="md"
      disabled={disabled}
      onClick={onClick}
      aria-label={left ? "Immagini precedenti" : "Immagini successive"}
      className={`!flex shrink-0 items-center justify-center ${disabled ? "opacity-40" : ""}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className={`h-4 w-4 ${left ? "rotate-180" : ""}`}
        fill="none"
        stroke="black"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.5"
      >
        <path d="m9 5 7 7-7 7" />
      </svg>
    </ActionIcon>
  );
}

function Caption({ entry }) {
  return (
    <Text
      size="xs"
      c="#f4f6f8"
      truncate="end"
      ta="center"
      mt={2}
    >
      {entry.label}
    </Text>
  );
}

export default function DetectionStrip({
  entries,
  onOpen,
  onDelete,
  onClear,
  raised = false,
  // A row the page puts ABOVE the strip's own buttons, in the same fixed column
  // so it always sits just over whatever the strip is showing -- over the
  // thumbnails, over only the Mostra pill when they are hidden, or at the bottom
  // when there are no pictures at all. A separate fixed row would have to guess
  // the strip's height, and a guess is wrong the moment a picture arrives.
  above = null,
}) {
  const [hidden, setHidden] = useState(readHidden);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const viewportRef = useRef(null);
  // Where the row is, for greying out the arrow at each end.
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);
  const shown = entries;
  // New pictures make the row longer: the right arrow comes back to life.
  useEffect(() => {
    const frame = requestAnimationFrame(updateEnds);
    return () => cancelAnimationFrame(frame);
  }, [shown.length, hidden]);

  function updateEnds() {
    const element = viewportRef.current;
    if (!element) return;
    setAtStart(element.scrollLeft <= 1);
    setAtEnd(
      element.scrollLeft + element.clientWidth >= element.scrollWidth - 1,
    );
  }

  function scrollBy(direction) {
    const element = viewportRef.current;
    if (!element) return;
    element.scrollBy({
      left: direction * element.clientWidth,
      behavior: "smooth",
    });
  }

  // Up to the newest picture on screen, by the server's own timestamp: one
  // that arrives while the dialog is open is not deleted unseen.
  async function clear() {
    setClearing(true);
    try {
      await onClear(Math.max(...entries.map((entry) => entry.created)));
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  }

  if (!shown.length && !above) return null;

  function toggle() {
    const next = !hidden;
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN_KEY, next ? "1" : "0");
    } catch {
      // Not remembered, but still hidden or shown for now.
    }
  }

  return (
    <div
      // Measured from the footer bar, whatever height the bar has: just above
      // it, or -- `raised`, while the floating "Smetti di condividere" button
      // is shown -- above that button, which at the same height it covered.
      // Whole class names, not built from pieces, so Tailwind finds them.
      //
      // Side to side, between the two panels, like the footer bar: Mantine
      // sets each offset to the panel's width while it is open beside the
      // picture (from `md` up) and to 0 otherwise -- closed, or on a phone,
      // where an open panel covers the whole screen anyway.
      className={
        "fixed left-[var(--app-shell-navbar-offset,0px)] right-[var(--app-shell-aside-offset,0px)] " +
        "z-[101] flex flex-col items-end gap-1 min-[62em]:gap-3 px-2 " +
        (raised
          ? "bottom-[calc(var(--app-shell-footer-height,52px)+4rem)]"
          : "bottom-[calc(var(--app-shell-footer-height,52px)+1rem)]")
      }
    >
      {above}
      {shown.length > 0 && (
        <Group justify="space-between" className="w-full">
          <Button
            size="compact-md"
            variant="filled"
            color="dark"
            radius="xl"
            onClick={() => setConfirmClear(true)}
          >
            Svuota
          </Button>
          <Button
            size="compact-md"
            variant="filled"
            color="dark"
            radius="xl"
            onClick={toggle}
          >
            {hidden ? `Mostra (${shown.length})` : "Nascondi"}
          </Button>
        </Group>
      )}
      {shown.length > 0 && !hidden && (
        <Paper
          shadow="md"
          radius="md"
          p={6}
          bg="#242424"
          c="#f4f6f8"
          className="flex w-full items-center gap-1"
        >
          <ScrollArrow left disabled={atStart} onClick={() => scrollBy(-1)} />
          <ScrollArea
            type="auto"
            scrollbarSize={6}
            offsetScrollbars="x"
            viewportRef={(element) => {
              viewportRef.current = element;
              // The first measure, once the thumbnails are laid out; after
              // that every scroll updates it.
              if (element) requestAnimationFrame(updateEnds);
            }}
            onScrollPositionChange={updateEnds}
            className="min-w-0 flex-1"
          >
            <Group gap={6} wrap="nowrap">
              {shown.map((entry) => (
                // Room above and to the right for the half of the round ✕
                // that sits outside the picture; the ScrollArea would clip it.
                <div
                  key={entry.id}
                  className="w-[76px] shrink-0 pl-[calc(var(--spacing))] pr-3 pt-3"
                >
                  <div className="relative">
                    <UnstyledButton
                      onClick={() => onOpen(entry)}
                      title={`${entry.label} · ${when(entry)}`}
                      className="block"
                    >
                      <Image
                        src={savedImageUrl(entry)}
                        alt={entry.label}
                        w={64}
                        h={64}
                        radius="sm"
                        fit="cover"
                      />
                    </UnstyledButton>
                    <CloseButton
                      size={24}
                      iconSize={14}
                      radius="xl"
                      variant="transparent"
                      aria-label="Elimina"
                      title="Elimina"
                      onClick={() => onDelete(entry)}
                      // Centred on the picture's top-right corner.
                      className="absolute right-0 top-0 translate-x-1/2 -translate-y-1/2
                                 !bg-black/75 !text-white"
                    />
                  </div>
                  <UnstyledButton
                    onClick={() => onOpen(entry)}
                    className="block w-16"
                  >
                    <Caption entry={entry} />
                  </UnstyledButton>
                </div>
              ))}
            </Group>
          </ScrollArea>
          <ScrollArrow disabled={atEnd} onClick={() => scrollBy(1)} />
        </Paper>
      )}
      <Modal
        opened={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Eliminare tutte le immagini?"
        centered
      >
        <Text size="sm">
          Le {entries.length} immagini della striscia vengono eliminate dal
          server, per tutti i dispositivi. Non si puo' annullare.
        </Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setConfirmClear(false)}>
            Annulla
          </Button>
          <Button color="red" onClick={clear} loading={clearing}>
            Elimina tutte
          </Button>
        </Group>
      </Modal>
    </div>
  );
}

/** One saved detection picture, with classifier-training and delete actions. */
export function SavedPictureModal({
  entry,
  onClose,
  onDelete,
  onAddToClassifier,
  addingToClassifier,
  // All classifiers, including unmeasured ones, can accept another training
  // picture.
  classifiers = [],
  onCreateClassifier,
  creatingClassifier = false,
  onDetails,
  // (entry, text) -> Promise<boolean>: stores a corrected text.
  onEditText,
}) {
  const objectId = entry?.boxes?.[0]?.object_id;
  // Starts on the classifier that matched, when one did, so the common case is
  // one button press and the picker is only touched to override it.
  const [chosen, setChosen] = useState(objectId ?? null);
  const [newName, setNewName] = useState("");
  // The text of a saved read as being edited (null: not touched).
  const [editedText, setEditedText] = useState(null);
  const [savingText, setSavingText] = useState(false);

  // The dialog is reused for every picture, so a choice made for the last one
  // must not be left sitting over the next.
  useEffect(() => {
    setChosen(objectId ?? null);
    setNewName("");
    setEditedText(null);
  }, [entry?.id, objectId]);

  const busy = addingToClassifier === entry?.id || creatingClassifier;
  // A saved read of some text, not a detection: it has words to show and copy,
  // and "add to a classifier" means nothing for it.
  const isText = entry?.kind === "text";

  return (
    <Modal
      opened={Boolean(entry)}
      onClose={onClose}
      title={entry ? (isText ? "Testo letto" : `Rilevato: ${entry.label}`) : ""}
      centered
      size="lg"
      classNames={{ close: "hover:!bg-white hover:!text-black" }}
      styles={{
        content: {
          backgroundColor: "#242424",
          color: "#fff",
          "--mantine-color-body": "#000",
          "--mantine-color-text": "#fff",
          "--mantine-color-dimmed": "#fff",
          "--mantine-color-default-color": "#fff",
          "--mantine-color-default-border": "#666",
        },
        header: { backgroundColor: "#242424", color: "#fff" },
        title: { color: "#fff" },
        close: { color: "#fff" },
        body: { color: "#fff" },
      }}
    >
      {entry && isText && (
        <Stack gap="sm">
          <ZoomableImage>
            <Image
              src={savedImageUrl(entry)}
              alt={entry.label}
              radius="sm"
              w="100%"
              mah="70vh"
              fit="contain"
            />
          </ZoomableImage>
          {entry.origin && (
            <Text size="sm" c="dimmed">
              {entry.origin}
            </Text>
          )}
          <Textarea
            label="Testo"
            styles={{
              input: {
                backgroundColor: "#000",
                color: "#fff",
                borderColor: "#666",
              },
              label: { color: "#fff" },
            }}
            value={editedText ?? entry.text ?? ""}
            onChange={(event) => setEditedText(event.currentTarget.value)}
            autosize
            minRows={3}
            maxRows={12}
          />
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {when(entry)}
              {entry.device ? ` · ${entry.device}` : ""}
            </Text>
            <Group gap="xs">
              {editedText !== null &&
                editedText.trim() !== (entry.text ?? "") && (
                  <Button
                    size="xs"
                    loading={savingText}
                    disabled={!editedText.trim()}
                    onClick={async () => {
                      setSavingText(true);
                      const saved = await onEditText?.(
                        entry,
                        editedText.trim(),
                      );
                      setSavingText(false);
                      if (saved) setEditedText(null);
                    }}
                  >
                    Salva modifiche
                  </Button>
                )}
              <CopyButton value={editedText ?? entry.text ?? ""}>
                {({ copied, copy }) => (
                  <Button
                    size="xs"
                    variant="light"
                    color={copied ? "teal" : "gray"}
                    onClick={copy}
                  >
                    {copied ? "Copiato" : "Copia testo"}
                  </Button>
                )}
              </CopyButton>
              <Button color="red" size="xs" onClick={() => onDelete(entry)}>
                Elimina
              </Button>
            </Group>
          </Group>
          <MapsLink position={entry.position} />
        </Stack>
      )}
      {entry && !isText && (
        <Stack gap="sm">
          <ZoomableImage>
            <Image
              src={savedImageUrl(entry)}
              alt={entry.label}
              radius="sm"
              w="100%"
              mah="70vh"
              fit="contain"
            />
          </ZoomableImage>
          {entry.origin && (
            <Text size="sm" c="dimmed">
              {entry.origin}
            </Text>
          )}
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {when(entry)}
              {entry.device ? ` · ${entry.device}` : ""}
            </Text>
            <Button
              color="red"
              size="xs"
              onClick={() => onDelete(entry)}
              disabled={busy}
            >
              Elimina
            </Button>
          </Group>
          <MapsLink position={entry.position} />

          {classifiers.length > 0 && (
            <Group gap="xs" align="flex-end" wrap="nowrap">
              <Select
                label="Aggiungi a un classificatore"
                placeholder="Scegli un classificatore"
                data={classifiers}
                value={chosen}
                onChange={setChosen}
                searchable={classifiers.length > 6}
                size="xs"
                className="grow"
                disabled={busy}
              />
              <Button
                size="xs"
                variant="light"
                disabled={!chosen || busy}
                loading={addingToClassifier === entry.id}
                onClick={() => onAddToClassifier(entry, chosen)}
              >
                Aggiungi
              </Button>
              {onDetails && (
                <Button
                  size="xs"
                  variant="default"
                  disabled={!chosen || busy}
                  onClick={() => onDetails(chosen)}
                >
                  Dettagli
                </Button>
              )}
            </Group>
          )}

          {onCreateClassifier && (
            <Group gap="xs" align="flex-end" wrap="nowrap">
              <TextInput
                label="Nuovo classificatore da questa foto"
                placeholder="Nome"
                value={newName}
                onChange={(event) => setNewName(event.currentTarget.value)}
                size="xs"
                className="grow"
                disabled={busy}
              />
              <Button
                size="xs"
                disabled={!newName.trim() || busy}
                loading={creatingClassifier}
                onClick={() => onCreateClassifier(entry, newName.trim())}
              >
                Crea e aggiungi
              </Button>
            </Group>
          )}

          {/* Said before the button is pressed as well as after it, because
              this is the step everybody misses: a photograph filed here is a
              recall test until it has a box, and the live detector goes on
              using whatever Misura last measured either way. */}
          <Text size="xs" c="dimmed">
            Una foto aggiunta qui non viene usata dal rilevamento finche' non le
            disegni il riquadro (in « Foto di un oggetto ») e non rilanci «
            Misura », attivando la misura nuova.
          </Text>
        </Stack>
      )}
    </Modal>
  );
}
