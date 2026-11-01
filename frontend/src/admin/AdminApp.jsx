import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  CloseButton,
  Container,
  Divider,
  Group,
  Indicator,
  Loader,
  Paper,
  Popover,
  ScrollArea,
  Stack,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import { toast } from "sonner";
import { call, get } from "./api.js";
import Users from "./Users.jsx";
import Devices from "./Devices.jsx";
import Objects from "./Objects";

// The devices list is a live thing: the server forgets a device 20 s after its
// last heartbeat, and the app beats every 5 s. Polling on the same beat keeps
// this page's list no more stale than the app's own.
const DEVICE_POLL_MS = 5000;

// Same threshold as the app's own VIEWS_WARN_ABOVE (App.jsx): past this many
// photos on one classifier, nothing is deleted automatically, so somebody has
// to notice and do it by hand.
const VIEWS_WARN_ABOVE = 100;

/** The administration panel, at /admin/.
 *
 *  The bundle is only a page, never a permission. It renders nothing
 *  privileged until GET /me answers, and every check that matters is on the
 *  server, in require_admin -- reaching this URL by typing it gets you a page
 *  that can do nothing. */
export default function AdminApp() {
  const [me, setMe] = useState(null);
  const [state, setState] = useState("loading"); // loading | ready | anon | forbidden | error
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [devices, setDevices] = useState([]);
  const [message, setMessage] = useState("");
  const [objects, setObjects] = useState([]);
  const [persistedNotifications, setPersistedNotifications] = useState([]);
  const [clearing, setClearing] = useState(false);

  const loadNotifications = useCallback(async () => {
    try {
      const data = await get("/admin/notifications");
      setPersistedNotifications(data.notifications ?? []);
    } catch {
      // Silent, same reason loadDevices is.
    }
  }, []);

  async function dismissNotification(id) {
    try {
      const data = await call("POST", `/admin/notifications/${id}/dismiss`);
      setPersistedNotifications(data.notifications ?? []);
    } catch {
      // The next poll (DEVICE_POLL_MS) corrects the list either way.
    }
  }

  /** Clears the stored notifications in one request.
   *
   *  Only the stored ones: the computed warnings in this list are recomputed
   *  from the classifiers on every poll, so "dismissing" one would put it
   *  straight back and make the button look broken. The label says how many it
   *  will actually take. */
  async function dismissAllNotifications() {
    setClearing(true);
    try {
      const data = await call("POST", "/admin/notifications/dismiss_all");
      setPersistedNotifications(data.notifications ?? []);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setClearing(false);
    }
  }

  const loadDevices = useCallback(async () => {
    try {
      // A read, not a heartbeat: /presence would register this page as a
      // device, and a panel that appears in its own list -- and can be asked
      // to share its own camera -- is confusing rather than useful.
      const data = await get("/devices");
      setDevices(data.devices ?? []);
    } catch {
      // Silent: the next poll is 5 s away, and the heartbeat in the app
      // already reports a server that cannot be reached.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const account = await get("/me");
        if (cancelled) return;
        setMe(account);
        if (!account.is_admin) {
          setState("forbidden");
          return;
        }
        const [userData] = await Promise.all([get("/users")]);
        if (cancelled) return;
        setUsers(userData.users ?? []);
        setRoles(userData.roles ?? []);
        setState("ready");
      } catch (error) {
        if (cancelled) return;
        setMessage(error.message);
        setState(error.status === 401 ? "anon" : "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (state !== "ready") return undefined;
    loadDevices();
    const timer = setInterval(loadDevices, DEVICE_POLL_MS);
    return () => clearInterval(timer);
  }, [state, loadDevices]);

  useEffect(() => {
    if (state !== "ready") return undefined;
    loadNotifications();
    const timer = setInterval(loadNotifications, DEVICE_POLL_MS);
    return () => clearInterval(timer);
  }, [state, loadNotifications]);

  // Just for the notification below: the "Oggetti" tab (Objects.jsx) fetches
  // its own, fuller copy when opened. keepMounted={false} on the Tabs means
  // this cannot rely on that one having run yet.
  useEffect(() => {
    if (state !== "ready") return;
    get("/objects")
      .then((data) => setObjects(data.objects ?? []))
      .catch(() => {
        // Silent, same reason loadDevices is: nothing here is worth a toast
        // on every failed poll, and the rest of the page already works.
      });
  }, [state]);

  // Every notification this page can show, from every check that matters to
  // an admin -- one list, not one Alert per kind of check, so a new check
  // just pushes another entry in here rather than growing a pile of
  // near-identical conditional Alerts. The bell below renders whatever is in
  // this list and nothing else.
  //
  // Two different NATURES, both ending up in the same list:
  // - computed (dismissible: false): a live condition, recalculated every
  //   render from data that already exists elsewhere (objects' view counts).
  //   It has no "dismiss", because it is not an event -- it simply stops
  //   appearing once the condition is no longer true.
  // - persisted (dismissible: true): a one-time EVENT from notifications.py
  //   (a classifier being created, say), which nothing will un-happen, so it
  //   stays until an administrator dismisses it.
  const notifications = [
    // Nothing is deleted automatically past VIEWS_WARN_ABOVE (see App.jsx's
    // own constant of the same name) -- this is what tells an admin who
    // never opens "Foto di un oggetto" that one classifier needs tidying up.
    // real_views, not views: variants generated from a boxed photo are not
    // photographs anybody has to tidy up, and telling an admin to delete
    // some would point at the wrong remedy (there is a button for those).
    ...objects
      .filter((o) => (o.real_views ?? o.views) > VIEWS_WARN_ABOVE)
      .map((item) => ({
        id: `views-${item.id}`,
        color: "orange",
        message:
          `« ${item.name} » ha ${item.real_views ?? item.views} foto: elimina ` +
          `quelle che non servono più nella pagina "Foto di un oggetto".`,
        dismissible: false,
      })),
    ...persistedNotifications.map((item) => ({
      id: item.id,
      color: "blue",
      message: item.message,
      dismissible: true,
    })),
  ];
  // What the button can really take: the stored half. See its own comment.
  const dismissibleCount = notifications.filter((item) => item.dismissible).length;

  if (state === "loading") {
    return (
      <Group justify="center" mt="xl">
        <Loader />
      </Group>
    );
  }

  if (state !== "ready") {
    const text =
      state === "anon"
        ? "Devi entrare con un account amministratore."
        : state === "forbidden"
          ? "Questo account non è un amministratore."
          : message || "Errore.";
    return (
      <Container size="sm" py="xl" w="100%" className="text-left">
        <Alert color={state === "error" ? "red" : "yellow"} title="Amministrazione">
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{text}</Text>
            <Anchor href="/">Vai all'app</Anchor>
          </Stack>
        </Alert>
      </Container>
    );
  }

  return (
    // w="100%" is not decoration. #root is a column flex container, and
    // Container carries margin-inline:auto -- an auto margin on the cross axis
    // switches `stretch` off, so without a width the Container is sized by its
    // content and grew to 706 px inside a 390 px phone, taking the table's
    // scroll container with it. text-left because #root centres everything.
    <Container size="lg" py="md" w="100%" className="text-left">
      <Group justify="space-between" align="center" wrap="wrap" mb="md">
        <Group gap="sm" align="center">
          {/* order={3} deliberately, not 1: index.css styles h1 and h2
              UNLAYERED, at 56px and 24px, and unlayered CSS beats every layer
              -- including Mantine's own size and any Tailwind utility. An h1
              here would ignore `size` entirely and render enormous. */}
          <Title order={3}>Amministrazione</Title>
          <Anchor href="/" size="sm">
            ← Torna all'app
          </Anchor>
        </Group>
        <Group gap="xs">
          {/* Always here, notifications or not -- see below for the empty
              state. The number is the only part that depends on there being
              any; disabled hides it (not "0") when the list is empty. */}
          <Popover width={320} position="bottom-end" shadow="md" withArrow>
            <Popover.Target>
              <Indicator
                disabled={notifications.length === 0}
                label={notifications.length}
                color="red"
                size={16}
                offset={4}
              >
                <ActionIcon variant="subtle" color="gray" size="lg" aria-label="Notifiche">
                  <Text size="lg">🔔</Text>
                </ActionIcon>
              </Indicator>
            </Popover.Target>
            <Popover.Dropdown p={0}>
              <Group justify="space-between" wrap="nowrap" p="sm" pb={0} gap="xs">
                <Text size="sm" fw={600}>
                  Notifiche
                </Text>
                {/* Counted rather than "all": the computed warnings in this
                    list cannot be dismissed (they come back on the next poll),
                    so a bare "Svuota" would promise more than it does. */}
                {dismissibleCount > 0 && (
                  <Button size="compact-xs" variant="subtle"
                          loading={clearing} onClick={dismissAllNotifications}>
                    Ignora tutte ({dismissibleCount})
                  </Button>
                )}
              </Group>
              {notifications.length === 0 ? (
                <Text size="sm" c="dimmed" p="sm">
                  Nessuna notifica.
                </Text>
              ) : (
                // A fixed height, not one that grows with the list: past
                // around 8 short notifications (fewer if a message wraps to
                // two lines) this scrolls instead of pushing the page's
                // header down.
                //
                // The padding goes on viewportProps (the actual scrollable
                // .mantine-ScrollArea-viewport div), not on the root: the
                // scrollbar track is the root's own child, a sibling of the
                // viewport, so padding on the root does not move it -- only
                // padding on the viewport pushes the CONTENT (and the X)
                // away from where the scrollbar is drawn.
                <ScrollArea.Autosize
                  mah={320}
                  scrollbarSize={6}
                  viewportProps={{
                    style: {
                      paddingLeft: "var(--mantine-spacing-sm)",
                      paddingRight: "var(--mantine-spacing-md)",
                      paddingTop: "var(--mantine-spacing-sm)",
                      paddingBottom: "var(--mantine-spacing-sm)",
                    },
                  }}
                >
                  <Stack gap="xs">
                    {notifications.map((item, index) => (
                      <div key={item.id}>
                        {index > 0 && <Divider mb="xs" />}
                        <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
                          <Text size="sm" c={item.color}>
                            {item.message}
                          </Text>
                          {item.dismissible && (
                            <CloseButton
                              size="xs"
                              aria-label="Ignora"
                              title="Ignora"
                              onClick={() => dismissNotification(item.id)}
                            />
                          )}
                        </Group>
                      </div>
                    ))}
                  </Stack>
                </ScrollArea.Autosize>
              )}
            </Popover.Dropdown>
          </Popover>
          <Text size="sm" c="dimmed">
            Collegato come
          </Text>
          <Text size="sm" fw={600}>
            {me.username}
          </Text>
          <Badge variant="light">{me.role}</Badge>
        </Group>
      </Group>

      <Paper withBorder radius="md" p="md">
        <Tabs defaultValue="utenti" keepMounted={false}>
          <Tabs.List mb="md">
            <Tabs.Tab value="utenti">Utenti</Tabs.Tab>
            <Tabs.Tab value="dispositivi">Dispositivi collegati</Tabs.Tab>
            <Tabs.Tab value="oggetti">Oggetti</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="utenti">
            <Users me={me} users={users} roles={roles} onUsers={setUsers} />
          </Tabs.Panel>
          <Tabs.Panel value="dispositivi">
            <Devices devices={devices} onRefresh={loadDevices} />
          </Tabs.Panel>
          {/* keepMounted={false} on the Tabs above means this fetches its own
              list when it is opened, not on every admin page load. */}
          <Tabs.Panel value="oggetti">
            <Objects />
          </Tabs.Panel>
        </Tabs>
      </Paper>
    </Container>
  );
}
