// The objects somebody is collecting photographs of, and what was collected.
//
// The panel in the app creates one and adds photographs to it; everything that
// CHANGES or DESTROYS what other people contributed lives here instead --
// renaming and deleting. That split is deliberate: gathering is meant to be
// everybody's job, and undoing somebody else's contribution is not.

import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Group,
  Image,
  Modal,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { toast } from "sonner";
import { API_BASE, call, get } from "./api";
import ObjectsTransfer from "./ObjectsTransfer";

function when(seconds) {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString("it-IT");
}

export default function Objects() {
  const [objects, setObjects] = useState([]);
  const [open, setOpen] = useState(null); // the object whose photos are shown
  const [renaming, setRenaming] = useState(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const data = await get("/objects");
      setObjects(data.objects ?? []);
    } catch (error) {
      toast.error(error.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function run(work, done) {
    setBusy(true);
    try {
      const data = await work();
      setObjects(data.objects ?? []);
      if (done) toast.success(done);
      return data;
    } catch (error) {
      toast.error(error.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function showPhotos(item) {
    try {
      // The list endpoint carries counts; the photographs themselves are only
      // fetched when somebody actually opens one.
      const full = await get(`/objects/${item.id}`);
      setOpen({ ...full, view_list: full.view_list ?? [] });
    } catch (error) {
      toast.error(error.message);
    }
  }

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          Gli oggetti creati dagli operatori. Qui si correggono i nomi e si
          eliminano le foto: raccoglierle e' compito di tutti, disfare il lavoro
          di qualcun altro no.
        </Text>
        <Group gap="xs">
          <ObjectsTransfer objects={objects} onObjects={setObjects} />
          <Button variant="default" onClick={refresh} loading={busy}>
            Aggiorna
          </Button>
        </Group>
      </Group>

      {objects.length === 0 ? (
        <Text c="dimmed">
          Nessun oggetto. Si creano dall'app, con « Nuovo classificatore ».
        </Text>
      ) : (
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Nome</Table.Th>
              <Table.Th>Foto</Table.Th>
              <Table.Th>Creato da</Table.Th>
              <Table.Th>Aggiornato</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {objects.map((item) => (
              <Table.Tr key={item.id}>
                <Table.Td>{item.name}</Table.Td>
                <Table.Td>
                  <Badge variant="light">{item.views}</Badge>
                </Table.Td>
                <Table.Td>{item.created_by || "—"}</Table.Td>
                <Table.Td>{when(item.updated)}</Table.Td>
                <Table.Td>
                  <Group gap="xs" justify="flex-end">
                    <Button
                      size="compact-xs"
                      variant="default"
                      onClick={() => showPhotos(item)}
                    >
                      Foto
                    </Button>
                    <Button
                      size="compact-xs"
                      variant="default"
                      onClick={() => {
                        setRenaming(item);
                        setNewName(item.name);
                      }}
                    >
                      Rinomina
                    </Button>
                    <Button
                      size="compact-xs"
                      color="red"
                      variant="light"
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Eliminare « ${item.name} » e tutte le sue ${item.views} foto?`,
                          )
                        )
                          return;
                        run(
                          () => call("DELETE", `/objects/${item.id}`),
                          `« ${item.name} » eliminato.`,
                        );
                      }}
                    >
                      Elimina
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {/* Renaming. The name is the only thing this changes: the photographs,
          the boxes and who contributed them stay exactly as they were, so
          fixing a typo never costs a record its history. */}
      <Modal
        opened={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rinomina il classificatore"
        centered
      >
        <Stack gap="md">
          <TextInput
            label="Nome"
            value={newName}
            onChange={(event) => setNewName(event.currentTarget.value)}
            maxLength={60}
            data-autofocus
          />
          <Text size="xs" c="dimmed">
            Le foto e chi le ha scattate non cambiano.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRenaming(null)}>
              Annulla
            </Button>
            <Button
              loading={busy}
              disabled={!newName.trim() || newName.trim() === renaming?.name}
              onClick={async () => {
                const done = await run(
                  () =>
                    call("PATCH", `/objects/${renaming.id}`, { name: newName.trim() }),
                  "Nome aggiornato.",
                );
                if (done) setRenaming(null);
              }}
            >
              Salva
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* The photographs of one object, and deleting them one at a time. */}
      <Modal
        opened={open !== null}
        onClose={() => setOpen(null)}
        title={open ? `Foto di « ${open.name} »` : ""}
        size="lg"
      >
        <Stack gap="md">
          {(open?.view_list ?? []).length === 0 ? (
            <Text c="dimmed">Nessuna foto.</Text>
          ) : (
            <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="xs">
              {open.view_list.map((view) => (
                <Card key={view.name} withBorder padding="xs">
                  <Card.Section>
                    <Image src={`${API_BASE}/objects/view/${view.name}`} alt="" />
                  </Card.Section>
                  <Text size="xs" c="dimmed" mt={4}>
                    {view.created_by || "—"}
                    {view.box ? ` · riquadro ${view.box.w}x${view.box.h}` : " · senza riquadro"}
                  </Text>
                  <Button
                    size="compact-xs"
                    color="red"
                    variant="light"
                    mt={4}
                    onClick={async () => {
                      if (!window.confirm("Eliminare questa foto?")) return;
                      const done = await run(
                        () => call("DELETE", `/objects/views/${view.name}`),
                        "Foto eliminata.",
                      );
                      if (done) {
                        setOpen((current) => ({
                          ...current,
                          view_list: current.view_list.filter(
                            (v) => v.name !== view.name,
                          ),
                        }));
                      }
                    }}
                  >
                    Elimina
                  </Button>
                </Card>
              ))}
            </SimpleGrid>
          )}
        </Stack>
      </Modal>
    </Stack>
  );
}
