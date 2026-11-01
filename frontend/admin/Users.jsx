import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  Group,
  Modal,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { toast } from "sonner";
import { call } from "./api.js";

const MIN_PASSWORD = 8;

function when(stamp) {
  if (!stamp) return "mai";
  return new Date(stamp * 1000).toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Accounts: create, rename, change role, reset someone else's password,
 *  change your own, end every session, delete.
 *
 *  Every rule this page appears to enforce is really enforced by the server,
 *  in the same transaction as the write. What is here only saves a round trip
 *  and explains the refusal in Italian. */
export default function Users({ me, users, roles, onUsers }) {
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null); // {kind, username}
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState(roles[roles.length - 1]);

  const roleOptions = roles.map((role) => ({ value: role, label: role }));

  function open(kind, username) {
    setNewName(username ?? "");
    setPassword("");
    setCurrent("");
    setDialog({ kind, username });
  }

  async function run(work, done) {
    setBusy(true);
    try {
      const data = await work();
      if (data?.users) onUsers(data.users);
      setDialog(null);
      toast.success(done);
      return true;
    } catch (error) {
      toast.error(error.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const create = () =>
    run(
      () => call("POST", "/users", { username: name, password, role: newRole }),
      `Utente « ${name} » creato.`,
    ).then((ok) => {
      if (ok) {
        setName("");
        setPassword("");
      }
    });

  const isSelf = (user) => user.username === me.username;

  // The role picker and the four buttons are the same controls in the table
  // and in the phone cards, so they are written once.
  function RolePicker({ user, size }) {
    return (
      <Select
        size={size}
        data={roleOptions}
        value={user.role}
        // Changing your own role is refused by the server; disabling it here
        // means the refusal never has to be explained.
        disabled={isSelf(user) || busy}
        allowDeselect={false}
        onChange={(role) =>
          role &&
          role !== user.role &&
          run(
            () => call("PATCH", `/users/${encodeURIComponent(user.username)}/role`, { role }),
            `« ${user.username} » adesso è ${role}. Le sue sessioni sono chiuse.`,
          )
        }
      />
    );
  }

  function Actions({ user, justify }) {
    const me_ = isSelf(user);
    return (
      <Group gap="xs" justify={justify} wrap="wrap">
        <Button size="xs" variant="default" disabled={busy}
                onClick={() => open("rename", user.username)}>
          Rinomina
        </Button>
        <Button size="xs" variant="default" disabled={busy}
                onClick={() => open(me_ ? "mine" : "password", user.username)}>
          {me_ ? "La mia password" : "Password"}
        </Button>
        <Button
          size="xs"
          variant="default"
          disabled={busy}
          onClick={() =>
            me_
              ? run(
                  () => call("POST", "/me/logout_everywhere"),
                  "Le altre tue sessioni sono chiuse. Questa resta aperta.",
                )
              : run(
                  () =>
                    call("POST", `/users/${encodeURIComponent(user.username)}/logout_everywhere`),
                  `Ogni sessione di « ${user.username} » è chiusa.`,
                )
          }
        >
          Disconnetti ovunque
        </Button>
        <Button size="xs" variant="subtle" color="red" disabled={busy || me_}
                onClick={() => open("delete", user.username)}>
          Elimina
        </Button>
      </Group>
    );
  }

  function Who({ user }) {
    return (
      <Group gap="xs" wrap="nowrap">
        <Text fw={600}>{user.username}</Text>
        {isSelf(user) && (
          <Badge size="sm" variant="light">
            tu
          </Badge>
        )}
      </Group>
    );
  }

  const rows = users.map((user) => (
    <Table.Tr key={user.username}>
      <Table.Td>
        <Who user={user} />
      </Table.Td>
      <Table.Td>
        <RolePicker user={user} size="xs" />
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {when(user.created)}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {when(user.last_login)}
        </Text>
      </Table.Td>
      <Table.Td>
        <Actions user={user} justify="flex-end" />
      </Table.Td>
    </Table.Tr>
  ));

  const kind = dialog?.kind;
  const target = dialog?.username;

  return (
    <Stack gap="md">
      {/* A five-column table with four buttons per row does not fit a phone:
          as a scrolling strip the buttons sit off screen and have to be
          hunted for sideways. Below 768 px each account becomes a card
          instead, with nothing hidden. Same controls in both. */}
      <div className="hidden md:block">
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Utente</Table.Th>
              <Table.Th>Ruolo</Table.Th>
              <Table.Th>Creato</Table.Th>
              <Table.Th>Ultimo accesso</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>{rows}</Table.Tbody>
        </Table>
      </div>

      <Stack gap="sm" className="md:hidden">
        {users.map((user) => (
          <Card key={user.username} withBorder radius="md" padding="sm">
            <Stack gap="xs">
              <Who user={user} />
              <RolePicker user={user} size="sm" />
              <Text size="xs" c="dimmed">
                Creato {when(user.created)} · ultimo accesso {when(user.last_login)}
              </Text>
              <Actions user={user} justify="flex-start" />
            </Stack>
          </Card>
        ))}
      </Stack>

      <Text size="xs" c="dimmed">
        Regole che il server applica sempre, anche da riga di comando: non si retrocede o
        elimina l'ultimo amministratore; non si cambia il proprio ruolo; la propria password
        non passa dalla via che usi per gli altri, perché quella non rifà il cookie e ti
        sloggherebbe da solo.
      </Text>

      <Card withBorder radius="md" padding="md">
        <Title order={4} size="h6" mb="xs">
          Nuovo utente
        </Title>
        {/* A grid, not a Group: three inputs in a `grow` Group each keep their
            min-content width, which forced the whole page to 706 px inside a
            390 px phone. Here they simply stack. */}
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
          <TextInput label="Nome utente" placeholder="mario" value={name}
                     onChange={(event) => setName(event.currentTarget.value)} />
          <PasswordInput label="Password" placeholder={`almeno ${MIN_PASSWORD} caratteri`}
                         autoComplete="new-password" value={password}
                         onChange={(event) => setPassword(event.currentTarget.value)} />
          <Select label="Ruolo" data={roleOptions} value={newRole} allowDeselect={false}
                  onChange={(role) => role && setNewRole(role)} />
        </SimpleGrid>
        <Group justify="flex-end" mt="md">
          <Button onClick={create}
                  disabled={busy || !name.trim() || password.length < MIN_PASSWORD}>
            Crea utente
          </Button>
        </Group>
      </Card>

      <Modal opened={kind === "rename"} onClose={() => setDialog(null)} title="Rinomina utente"
             centered>
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Il nome è ciò che il cookie di sessione porta con sé, quindi rinominare chiude
            le sessioni di quell'utente. Se rinomini te stesso, resti collegato.
          </Text>
          <TextInput label="Nuovo nome utente" value={newName} data-autofocus
                     onChange={(event) => setNewName(event.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDialog(null)}>
              Annulla
            </Button>
            <Button
              disabled={busy || !newName.trim()}
              onClick={() =>
                run(
                  () =>
                    call("PATCH", `/users/${encodeURIComponent(target)}/name`, {
                      new_username: newName.trim(),
                    }),
                  `Rinominato in « ${newName.trim()} ».`,
                )
              }
            >
              Rinomina
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={kind === "password"} onClose={() => setDialog(null)}
             title={`Reimposta la password di ${target ?? ""}`} centered>
        <Stack gap="sm">
          <PasswordInput label="Nuova password" data-autofocus autoComplete="new-password"
                         placeholder={`almeno ${MIN_PASSWORD} caratteri`} value={password}
                         onChange={(event) => setPassword(event.currentTarget.value)} />
          <Text size="xs" c="dimmed">
            Tutte le sessioni di questo utente vengono chiuse.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDialog(null)}>
              Annulla
            </Button>
            <Button
              disabled={busy || password.length < MIN_PASSWORD}
              onClick={() =>
                run(
                  () =>
                    call("POST", `/users/${encodeURIComponent(target)}/password`, {
                      new_password: password,
                    }),
                  `Password di ${target} reimpostata. Le sue sessioni sono chiuse.`,
                )
              }
            >
              Reimposta
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={kind === "mine"} onClose={() => setDialog(null)} title="La mia password"
             centered>
        <Stack gap="sm">
          <PasswordInput label="Password attuale" data-autofocus autoComplete="current-password"
                         value={current}
                         onChange={(event) => setCurrent(event.currentTarget.value)} />
          <PasswordInput label="Nuova password" autoComplete="new-password"
                         placeholder={`almeno ${MIN_PASSWORD} caratteri`} value={password}
                         onChange={(event) => setPassword(event.currentTarget.value)} />
          <Text size="xs" c="dimmed">
            Serve quella attuale, così chi trova il browser aperto non può chiuderti fuori
            dal tuo account. Le altre sessioni si chiudono; questa resta aperta, perché il
            cookie viene rifatto nella stessa risposta.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDialog(null)}>
              Annulla
            </Button>
            <Button
              disabled={busy || !current || password.length < MIN_PASSWORD}
              onClick={() =>
                run(
                  () =>
                    call("POST", "/me/password", {
                      current_password: current,
                      new_password: password,
                    }),
                  "Password cambiata. Le altre sessioni sono chiuse, questa resta aperta.",
                )
              }
            >
              Cambia
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={kind === "delete"} onClose={() => setDialog(null)}
             title={`Eliminare « ${target ?? ""} »?`} centered>
        <Stack gap="sm">
          <Text size="sm">
            L'account sparisce e chi lo stava usando viene disconnesso subito. Non si torna
            indietro.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDialog(null)}>
              Annulla
            </Button>
            <Button
              color="red"
              disabled={busy}
              onClick={() =>
                run(
                  () => call("DELETE", `/users/${encodeURIComponent(target)}`),
                  `Utente « ${target} » eliminato.`,
                )
              }
            >
              Elimina
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
