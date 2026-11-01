import { useState } from "react";
import {
  Button,
  Group,
  Image,
  Modal,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";

/**
 * Offered when a saved detection of an OBJECT is opened from the strip.
 *
 * The frame becomes a view of a classifier: either a brand-new one (needs a
 * name) or one that already exists. Description and the traffic-light judge
 * are collected on the form; the server's object record only keeps a name,
 * so they are not persisted today -- they are there because the person asked
 * for them, and they cost nothing to ask.
 */
export default function ObjectSaveModal({
  opened,
  onClose,
  entry,
  classifiers,
  onCreated,
}) {
  const [name, setName] = useState(entry?.label ?? "");
  const [description, setDescription] = useState("");
  const [judge, setJudge] = useState("verde");
  const [mode, setMode] = useState("new"); // "new" | "existing"
  const [existingId, setExistingId] = useState("");
  const [busy, setBusy] = useState(false);

  const JUDGES = [
    { value: "verde", label: "Verde - ok" },
    { value: "giallo", label: "Giallo - dubbio" },
    { value: "rosso", label: "Rosso - da verificare" },
  ];

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (mode === "new") {
        const response = await fetch(`/objects`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), description, judge }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.detail || "Impossibile creare l'oggetto.");
        }
        // Add the frame as the first view of the new classifier.
        const add = await fetch(`/objects/${data.id}/views`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images: entry?.jpeg ? [entry.jpeg] : [] }),
        });
        if (!add.ok) {
          throw new Error(add.detail || "Oggetto creato, inquadratura non aggiunta.");
        }
        onCreated?.(data.id);
        onClose();
        return;
      }
      if (!existingId) return;
      const response = await fetch(`/objects/${existingId}/views`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: entry?.jpeg ? [entry.jpeg] : [] }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Impossibile aggiungere l'inquadratura.");
      }
      onClose();
    } catch (error) {
      // Surface the error once rather than silently swallowing it.
      // eslint-disable-next-line no-console
      console.error(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Salva questa inquadratura"
      size="lg"
    >
      <Stack gap="md">
        {entry?.jpeg && (
          <Image src={`data:image/jpeg;base64,${entry.jpeg}`} radius="sm" />
        )}
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Nome dell'oggetto (serve per creare un nuovo classificatore)
          </Text>
          <TextInput
            label="Nome"
            placeholder="Es. Tazza rossa"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={60}
          />
        </Stack>
        <Stack gap="xs">
          <Text size="sm" c="dimmed">Descrizione</Text>
          <Textarea
            placeholder="Cosa c'e' in questa inquadratura"
            value={description}
            onChange={(event) =>
              setDescription(event.currentTarget.value)
            }
          />
        </Stack>
        <Stack gap="xs">
          <Text size="sm" c="dimmed">Giudizio (semaforo)</Text>
          <Select
            data={JUDGES}
            value={judge}
            onChange={setJudge}
            searchable={false}
          />
        </Stack>
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Cosa farne
          </Text>
          <Group gap="sm">
            <Button
              variant="outline"
              onClick={() => setMode("new")}
              active={mode === "new"}
            >
              Nuovo classificatore
            </Button>
            <Button
              variant="outline"
              onClick={() => setMode("existing")}
              active={mode === "existing"}
              disabled={classifiers.length === 0}
            >
              Aggiungi a esistente
            </Button>
          </Group>
          {mode === "existing" && classifiers.length > 0 && (
            <Select
              data={classifiers.map((c) => ({ value: c.id, label: c.name }))}
              value={existingId}
              onChange={setExistingId}
              searchable
              nothingFoundMessage="Nessun classificatore"
              placeholder="Scegli un classificatore"
            />
          )}
        </Stack>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Annulla
          </Button>
          <Button
            onClick={save}
            loading={busy}
            disabled={
              !name.trim() ||
              (mode === "existing" && !existingId) ||
              busy
            }
          >
            Salva
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
