import { useState } from "react";
import {
  ActionIcon,
  Button,
  Card,
  Group,
  Image,
  Modal,
  SimpleGrid,
  Stack,
  Select,
  Text,
  Textarea,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { toast } from "sonner";
import { API_BASE, call } from "./api.js";
import MapsLink from "../MapsLink";

/** The enrolled people: read, edit, and delete from faces.db.
 *
 *  "Delete" here means the record, every embedding and every stored photograph
 *  go in one transaction -- ON DELETE CASCADE in the database, not a hidden
 *  row and not merely a face removed from a screen. */
export default function Faces({ people, judges, onPeople }) {
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);
  // The photograph currently being deleted, so its own X can show that it is
  // working without freezing the whole dialog.
  const [removingPhoto, setRemovingPhoto] = useState(null);
  const [form, setForm] = useState({ name: "", surname: "", description: "", judge: "" });

  const judgeOptions = Object.keys(judges ?? {}).map((judge) => ({
    value: judge,
    label: judge,
  }));

  function open(person) {
    setForm({
      name: person.name ?? "",
      surname: person.surname ?? "",
      description: person.description ?? "",
      judge: person.judge ?? "",
    });
    setEditing(person);
  }

  async function save() {
    setBusy(true);
    try {
      const data = await call("PATCH", `/faces/${encodeURIComponent(editing.id)}`, form);
      onPeople(data.people);
      setEditing(null);
      toast.success("Scheda salvata.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const data = await call("DELETE", `/faces/${encodeURIComponent(confirming.id)}`);
      onPeople(data.people);
      setConfirming(null);
      setEditing(null);
      toast.success("Eliminata dal database: scheda, foto e dati biometrici.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  /** One stored view: the picture and the mark made from it, together.
   *
   *  The server refuses to remove the last one -- a person with no views left
   *  could never be recognised again -- and says so, which is shown as it
   *  arrives rather than guessed at here. */
  async function removePhoto(photo) {
    setRemovingPhoto(photo);
    try {
      const data = await call(
        "DELETE",
        `/faces/${encodeURIComponent(editing.id)}/view/${encodeURIComponent(photo)}`,
      );
      // Guarded, both of them. A server that answers with only the person --
      // an older one, or a future change -- used to hand `undefined` to the
      // list and take the whole tab down with it, which looked like the dialog
      // closing itself the moment a photograph was deleted.
      if (Array.isArray(data.people)) onPeople(data.people);
      // The open dialog is a copy taken when it was opened, so it has to be
      // refreshed too -- otherwise the deleted photograph stays on screen
      // until the dialog is closed and opened again.
      if (data.person) setEditing(data.person);
      toast.success("Foto eliminata, con il suo dato biometrico.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setRemovingPhoto(null);
    }
  }

  const fullName = (person) => `${person.name ?? ""} ${person.surname ?? ""}`.trim() || "—";

  return (
    <Stack gap="md">
      <div>
        <Title order={3} size="h5">
          Volti
        </Title>
        <Text size="sm" c="dimmed">
          Le persone salvate. <b>Elimina</b> cancella davvero dal database: scheda, foto e
          dati biometrici, in un colpo solo.
        </Text>
      </div>

      {people.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nessuna persona salvata.
        </Text>
      ) : (
        <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="md">
          {people.map((person) => (
            <UnstyledButton key={person.id} onClick={() => open(person)}>
              <Card withBorder radius="md" padding="sm" className="text-left">
                <Card.Section>
                  {person.photo ? (
                    <Image src={`${API_BASE}/faces/photo/${person.photo}`} alt=""
                           className="aspect-square object-cover" />
                  ) : (
                    <div className="aspect-square bg-[--mantine-color-default-hover]" />
                  )}
                </Card.Section>
                <Group gap={6} mt="xs" wrap="nowrap">
                  <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: person.color }} />
                  <Text size="sm" fw={600} truncate>
                    {fullName(person)}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed">
                  {person.samples} inquadrature
                </Text>
              </Card>
            </UnstyledButton>
          ))}
        </SimpleGrid>
      )}

      <Modal opened={Boolean(editing)} onClose={() => setEditing(null)} centered
             title={editing ? fullName(editing) : ""}>
        {editing && (
          <Stack gap="sm">
            {/* Each photograph carries its own X. `relative` on the wrapper is
                what the button is positioned against; without it the X would
                land relative to the dialog and all of them would stack in one
                corner. */}
            <Group gap="xs" wrap="nowrap" className="overflow-x-auto pb-1">
              {(editing.photos ?? []).map((photo) => (
                <div key={photo} className="relative shrink-0">
                  <Image src={`${API_BASE}/faces/photo/${photo}`} alt=""
                         w={110} className="rounded-md" />
                  <ActionIcon
                    size="sm"
                    radius="xl"
                    color="red"
                    variant="filled"
                    className="absolute top-1 right-1"
                    loading={removingPhoto === photo}
                    disabled={busy || (editing.photos ?? []).length < 2}
                    onClick={() => removePhoto(photo)}
                    aria-label="Elimina questa foto"
                    title={
                      (editing.photos ?? []).length < 2
                        ? "E' l'ultima foto: senza di essa la persona non sarebbe piu' riconoscibile."
                        : "Elimina questa foto"
                    }
                  >
                    ×
                  </ActionIcon>
                  {/* Where it was taken: photos saved from a detection-strip
                      picture of a device that knew its position. */}
                  <MapsLink position={editing.photo_places?.[photo]} short size="xs"
                            mt={4} className="max-w-[110px]" />
                </div>
              ))}
            </Group>
            <TextInput label="Nome" value={form.name}
                       onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} />
            <TextInput label="Cognome" value={form.surname}
                       onChange={(event) => setForm({ ...form, surname: event.currentTarget.value })} />
            <Select label="Giudizio" data={judgeOptions} value={form.judge} allowDeselect={false}
                    onChange={(judge) => judge && setForm({ ...form, judge })} />
            <Textarea label="Descrizione" autosize minRows={3} value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.currentTarget.value })} />
            <Group justify="space-between" mt="md">
              <Button color="red" variant="subtle" disabled={busy}
                      onClick={() => setConfirming(editing)}>
                Elimina dal database
              </Button>
              <Group gap="xs">
                <Button variant="default" onClick={() => setEditing(null)}>
                  Annulla
                </Button>
                <Button onClick={save} disabled={busy}>
                  Salva
                </Button>
              </Group>
            </Group>
          </Stack>
        )}
      </Modal>

      <Modal opened={Boolean(confirming)} onClose={() => setConfirming(null)} centered
             title={`Eliminare ${confirming ? fullName(confirming) : ""}?`}>
        <Stack gap="sm">
          <Text size="sm">
            Spariscono la scheda, tutte le fotografie e tutti i dati biometrici di questa
            persona. Non si torna indietro.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirming(null)}>
              Annulla
            </Button>
            <Button color="red" onClick={remove} disabled={busy}>
              Elimina
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
