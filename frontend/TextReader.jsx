// The window that shows what was read from one frame: the frozen picture with
// each line boxed, the text itself, and the button that keeps it.
//
// Built from Mantine core only. The page owns the state and the requests; this
// is just what is on screen, so the same dialog can be reused for a re-read in
// the other mode without a second copy of any of it.

import { useState } from "react";
import ZoomableImage from "./ZoomableImage";
import {
  Button,
  CopyButton,
  Group,
  Image,
  LoadingOverlay,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";

const MODES = [
  { value: "scene", label: "Etichette" },
  { value: "text", label: "Testo" },
  { value: "codes", label: "Codici" },
];

// One line under the switch, because three words do not say which to pick.
const MODE_HINTS = {
  scene: "Confezioni, insegne, scritte colorate o stilizzate.",
  text: "Pagine stampate, con gli accenti.",
  codes: "Solo maiuscole e cifre: numeri di serie, lotti, targhe.",
};

export default function TextReadDialog({
  opened,
  image,
  mode,
  onMode,
  result,
  // The text as shown, and what to do when it is edited: the page keeps the
  // corrected text, so « Salva » stores what is on screen.
  text,
  onText,
  busy,
  error,
  saving,
  onSave,
  onClose,
}) {
  // The box coordinates are in the pixels of the picture that was SENT, so they
  // are turned into percentages of its natural size, the same way a view's box
  // is drawn in the classifier's photo grid.
  const [natural, setNatural] = useState(null);
  const lines = result?.lines ?? [];

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Leggi testo"
      centered
      size="lg"
    >
      <Stack gap="sm" pos="relative">
        <LoadingOverlay visible={busy} zIndex={10} />
        <SegmentedControl
          size="xs"
          fullWidth
          data={MODES}
          value={mode}
          onChange={onMode}
          disabled={busy || saving}
        />
        <Text size="xs" c="dimmed">
          {MODE_HINTS[mode]}
        </Text>
        {image && (
          <ZoomableImage>
          <div className="relative w-full">
            <Image
              src={`data:image/jpeg;base64,${image}`}
              alt="Fotogramma letto"
              radius="sm"
              w="100%"
              onLoad={(event) =>
                setNatural({
                  w: event.currentTarget.naturalWidth,
                  h: event.currentTarget.naturalHeight,
                })
              }
            />
            {natural &&
              lines.map((line, index) => (
                <div
                  key={index}
                  className="pointer-events-none absolute border-2 border-[#40c057]"
                  style={{
                    left: `${(line.box[0] / natural.w) * 100}%`,
                    top: `${(line.box[1] / natural.h) * 100}%`,
                    width: `${((line.box[2] - line.box[0]) / natural.w) * 100}%`,
                    height: `${((line.box[3] - line.box[1]) / natural.h) * 100}%`,
                  }}
                />
              ))}
          </div>
          </ZoomableImage>
        )}
        {error ? (
          <Text size="sm" c="red">
            {error}
          </Text>
        ) : lines.length === 0 && result && !busy ? (
          <Text size="sm" c="dimmed">
            Nessun testo leggibile. Avvicinati, tieni fermo il foglio e cerca
            luce: il testo deve riempire una parte buona dell&apos;immagine.
          </Text>
        ) : (
          <Textarea
            label="Testo letto"
            description="Puoi correggerlo prima di copiarlo o salvarlo."
            value={text}
            onChange={(event) => onText(event.currentTarget.value)}
            autosize
            minRows={3}
            maxRows={10}
          />
        )}
        {result && !error && (
          <Text size="xs" c="dimmed">
            {lines.length} {lines.length === 1 ? "riga" : "righe"} in{" "}
            {(result.ms / 1000).toFixed(1)} s. Non viene salvato nulla finché
            non premi « Salva ».
          </Text>
        )}
        <Group justify="flex-end" gap="xs">
          <CopyButton value={text}>
            {({ copied, copy }) => (
              <Button
                size="xs"
                variant="light"
                color={copied ? "teal" : "gray"}
                disabled={!text || busy}
                onClick={copy}
              >
                {copied ? "Copiato" : "Copia testo"}
              </Button>
            )}
          </CopyButton>
          <Button
            size="xs"
            loading={saving}
            disabled={!text || busy || Boolean(error)}
            onClick={onSave}
          >
            Salva
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
