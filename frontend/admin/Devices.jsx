import { useState } from "react";
import { Badge, Button, Card, Group, Stack, Table, Text, Title } from "@mantine/core";
import { toast } from "sonner";
import { call } from "./api.js";
import Watch from "./Watch.jsx";

/** The pages that have the app open right now, and watching one of them. */
export default function Devices({ devices, onRefresh }) {
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState(null);

  async function watch(device) {
    setBusy(true);
    try {
      if (!device.sharing) {
        // Asks that device to turn its camera on. It reads the request off its
        // own next heartbeat, so there is a beat of delay before frames start.
        await call("POST", "/share_request", { client_id: device.client_id });
      }
      setWatching(device);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
      onRefresh();
    }
  }

  async function stop(label) {
    try {
      await call("POST", "/stop_sharing");
      toast.success(`« ${label} » non trasmette più.`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      onRefresh();
    }
  }

  function Actions({ device, justify }) {
    return (
      <Group gap="xs" justify={justify} wrap="wrap">
        <Button size="xs" disabled={busy} onClick={() => watch(device)}>
          Guarda
        </Button>
        {device.sharing && (
          <Button size="xs" variant="subtle" color="red" onClick={() => stop(device.label)}>
            Ferma
          </Button>
        )}
      </Group>
    );
  }

  function State({ device }) {
    return (
      <Badge color={device.sharing ? "green" : "gray"} variant="light">
        {device.sharing ? "in diretta" : "in attesa"}
      </Badge>
    );
  }

  const rows = devices.map((device) => (
    <Table.Tr key={device.client_id}>
      <Table.Td>
        <Text fw={600}>{device.label}</Text>
      </Table.Td>
      <Table.Td>{device.username}</Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {device.seconds_ago} s fa
        </Text>
      </Table.Td>
      <Table.Td>
        <State device={device} />
      </Table.Td>
      <Table.Td>
        <Actions device={device} justify="flex-end" />
      </Table.Td>
    </Table.Tr>
  ));

  return (
    <Stack gap="md">
      <div>
        <Title order={3} size="h5">
          Dispositivi collegati
        </Title>
        <Text size="sm" c="dimmed">
          Chi ha l'app aperta adesso. Un dispositivo sparisce dopo 20 secondi senza segnale.
          <b> Guarda</b> accende la fotocamera di quel dispositivo e ne apre il video qui, in
          una finestra: un operatore alla volta. <b>Ferma</b> spegne la condivisione senza
          guardarla.
        </Text>
      </div>

      {devices.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nessun dispositivo collegato in questo momento.
        </Text>
      ) : (
        <>
          {/* Same reason as the users table: below 768 px a row becomes a
              card, so "Guarda" is never off the side of the screen. */}
          <div className="hidden md:block">
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Dispositivo</Table.Th>
                  <Table.Th>Utente</Table.Th>
                  <Table.Th>Visto</Table.Th>
                  <Table.Th>Stato</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>{rows}</Table.Tbody>
            </Table>
          </div>

          <Stack gap="sm" className="md:hidden">
            {devices.map((device) => (
              <Card key={device.client_id} withBorder radius="md" padding="sm">
                <Stack gap="xs">
                  <Group justify="space-between" wrap="nowrap">
                    <Text fw={600}>{device.label}</Text>
                    <State device={device} />
                  </Group>
                  <Text size="xs" c="dimmed">
                    {device.username} · visto {device.seconds_ago} s fa
                  </Text>
                  <Actions device={device} justify="flex-start" />
                </Stack>
              </Card>
            ))}
          </Stack>
        </>
      )}

      <Text size="xs" c="dimmed">
        Nota tecnica: il browser mostra sempre il suo indicatore di fotocamera attiva (il
        pallino nella scheda, e la spia del sistema). Quello non si può togliere da qui. E la
        prima volta, su un dispositivo che non ha mai condiviso, il browser chiede il
        permesso: finché non è stato dato, la fotocamera non parte.
      </Text>

      <Watch
        device={watching}
        onClose={(alsoStop) => {
          const device = watching;
          setWatching(null);
          if (alsoStop && device) stop(device.label);
          else onRefresh();
        }}
      />
    </Stack>
  );
}
