// Carrying classifiers to and from another installation.
//
// Two buttons for the « Oggetti » tab and the two windows behind them. The
// logic of what a file holds, and every check on one that comes from outside,
// is on the server (objects_transfer.py); this is only the dialogue:
//
//   Esporta   choose which classifiers -> the server builds a file -> download
//   Importa   choose a file -> it is uploaded and checked -> a PREVIEW of what
//             would happen, row by row -> « Importa » writes it
//
// Built from Mantine core only, like the rest of the administration page.

import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  FileButton,
  Group,
  Loader,
  Modal,
  Progress,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Table,
  Text,
} from "@mantine/core";
import { toast } from "sonner";
import { call, upload, url } from "./api";

const MAX_FILE_MB = 256; // the same limit the server enforces
const NEW = "new"; // the « Come » choice that is not a merge into anything

const megabytes = (bytes) =>
  (bytes / (1024 * 1024)).toLocaleString("it-IT", { maximumFractionDigits: 1 });

const ACTION_BADGE = {
  new: { color: "green", label: "Nuovo" },
  rename: { color: "yellow", label: "Rinominato" },
  into: { color: "blue", label: "Unito" },
  skip: { color: "gray", label: "Saltato" },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function ExportWindow({ opened, onClose, objects }) {
  const [chosen, setChosen] = useState([]);
  const [understood, setUnderstood] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [ready, setReady] = useState(null); // {token, filename, size, objects, views}

  // Every time the window opens: everything ticked, nothing acknowledged.
  useEffect(() => {
    if (!opened) return;
    setChosen(objects.map((item) => item.id));
    setUnderstood(false);
    setReady(null);
  }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps

  const photos = objects
    .filter((item) => chosen.includes(item.id))
    .reduce((sum, item) => sum + (item.views ?? 0), 0);

  function close() {
    // A prepared file nobody downloaded is thrown away now rather than in five
    // minutes. Best effort: if it fails the server's own expiry gets it.
    if (ready) call("DELETE", `/objects/transfer/${ready.token}`).catch(() => {});
    onClose();
  }

  async function prepare() {
    setPreparing(true);
    try {
      setReady(await call("POST", "/objects/transfer/export", { ids: chosen }));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setPreparing(false);
    }
  }

  return (
    <Modal opened={opened} onClose={close} title="Esporta classificatori" size="md" centered>
      <Stack gap="sm">
        <Alert color="yellow" title="Il file non è cifrato">
          Contiene tutte le foto dei classificatori scelti, leggibili da chiunque
          abbia il file. Tienilo solo dove lasceresti le foto stesse e cancellalo
          dopo averlo importato. Non contiene persone, volti, utenti né rilevamenti.
        </Alert>

        <Group justify="space-between">
          <Text size="sm" fw={500}>
            Classificatori da esportare
          </Text>
          <Group gap="xs">
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => setChosen(objects.map((item) => item.id))}
              disabled={preparing || !!ready}
            >
              Tutti
            </Button>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => setChosen([])}
              disabled={preparing || !!ready}
            >
              Nessuno
            </Button>
          </Group>
        </Group>
        <ScrollArea.Autosize mah={280}>
          <Checkbox.Group value={chosen} onChange={setChosen}>
            <Stack gap="xs">
              {objects.map((item) => (
                <Checkbox
                  key={item.id}
                  value={item.id}
                  label={`${item.name} — ${item.views} foto`}
                  disabled={preparing || !!ready}
                />
              ))}
            </Stack>
          </Checkbox.Group>
        </ScrollArea.Autosize>
        <Text size="xs" c="dimmed">
          Selezionati: {chosen.length} classificatori, {photos} foto.
        </Text>

        <Checkbox
          checked={understood}
          onChange={(event) => setUnderstood(event.currentTarget.checked)}
          label="Ho capito che il file non è cifrato"
          disabled={preparing || !!ready}
        />

        {ready ? (
          <Alert color="teal" title="Il file è pronto">
            <Stack gap="xs">
              <Text size="sm">
                {ready.objects} classificatori, {ready.views} foto, {megabytes(ready.size)} MB.
                Resta disponibile per 5 minuti e si scarica una volta sola.
              </Text>
              <Button
                component="a"
                href={url(`/objects/transfer/export/${ready.token}`)}
                download={ready.filename}
                onClick={() => {
                  toast.success("Download avviato. Cancella il file dopo averlo importato.");
                  setReady(null);
                  onClose();
                }}
              >
                Scarica {ready.filename}
              </Button>
            </Stack>
          </Alert>
        ) : (
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Annulla
            </Button>
            <Button
              onClick={prepare}
              loading={preparing}
              disabled={!understood || chosen.length === 0}
            >
              Prepara il file
            </Button>
          </Group>
        )}
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function ImportWindow({ state, setState, onObjects }) {
  // state: null (closed) or {phase, name, progress, preview, selected, into,
  //        skipExisting, token}. phase: uploading | checking | preview |
  //        applying | done
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!state) return null;
  const { phase, preview } = state;

  const optionsFrom = (next) => {
    const all = preview.items.map((item) => item.source_id);
    const only = next.selected.length === all.length ? null : next.selected;
    const into = {};
    for (const [source, target] of Object.entries(next.into)) {
      if (target && target !== NEW) into[source] = target;
    }
    return { only, skip_existing: next.skipExisting, into };
  };

  // Any change of option asks the server what the import would now do; the
  // answer replaces the table. Waits a moment so a run of clicks is one call.
  function change(patch) {
    const next = { ...state, ...patch };
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const fresh = await call(
          "POST",
          `/objects/transfer/${next.token}/plan`,
          optionsFrom(next),
        );
        setState((now) => (now && now.token === next.token ? { ...now, preview: fresh } : now));
      } catch (error) {
        toast.error(error.message);
      }
    }, 300);
  }

  function close() {
    clearTimeout(timer.current);
    if (state.token && phase !== "done") {
      call("DELETE", `/objects/transfer/${state.token}`).catch(() => {});
    }
    setState(null);
  }

  async function apply() {
    setState({ ...state, phase: "applying" });
    try {
      const done = await call("POST", `/objects/transfer/${state.token}/apply`, {
        ...optionsFrom(state),
        plan_digest: preview.plan_digest,
      });
      onObjects(done.objects ?? []);
      toast.success(
        `Importati ${done.added_objects} classificatori e ${done.added_views} foto.`,
      );
      setState((now) => (now ? { ...now, phase: "done", done } : now));
    } catch (error) {
      if (error.status === 409) {
        toast.warning(error.message);
        change({ phase: "preview" });
      } else {
        toast.error(error.message);
        setState((now) => (now ? { ...now, phase: "preview" } : now));
      }
    }
  }

  const working = phase === "uploading" || phase === "checking" || phase === "applying";

  return (
    <Modal
      opened
      onClose={close}
      title="Importa classificatori"
      size="xl"
      centered
      closeOnClickOutside={!working}
      closeOnEscape={!working}
      withCloseButton={!working}
    >
      <Stack gap="sm">
        {phase === "uploading" && (
          <>
            <Text size="sm">Caricamento di {state.name}…</Text>
            <Progress value={Math.round(state.progress * 100)} animated />
            <Text size="xs" c="dimmed">{Math.round(state.progress * 100)}%</Text>
          </>
        )}

        {phase === "checking" && (
          <>
            <Text size="sm">Controllo delle foto…</Text>
            <Progress value={100} striped animated />
            <Text size="xs" c="dimmed">
              Ogni foto viene letta prima di entrare: con molte foto serve qualche secondo.
            </Text>
          </>
        )}

        {(phase === "preview" || phase === "applying") && preview && (
          <>
            <Text size="sm">
              Esportato il {new Date(preview.file.exported * 1000).toLocaleString("it-IT")} ·{" "}
              {preview.file.objects} classificatori · {preview.file.views} foto ·{" "}
              {megabytes(preview.file.size)} MB
            </Text>
            <Alert color="blue">
              L'importazione aggiunge soltanto: nulla di ciò che c'è già viene
              modificato o cancellato. Nessun classificatore viene messo in uso per il
              rilevamento.
            </Alert>
            <Switch
              checked={state.skipExisting}
              onChange={(event) => change({ skipExisting: event.currentTarget.checked })}
              label="Salta i classificatori con un nome già presente"
              disabled={phase === "applying"}
            />
            <Table.ScrollContainer minWidth={720}>
              <Table striped withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th />
                    <Table.Th>Classificatore</Table.Th>
                    <Table.Th>Foto</Table.Th>
                    <Table.Th>Come</Table.Th>
                    <Table.Th>Risultato</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {preview.items.map((item) => {
                    const badge = ACTION_BADGE[item.action];
                    const picked = state.selected.includes(item.source_id);
                    return (
                      <Table.Tr key={item.source_id}>
                        <Table.Td>
                          <Checkbox
                            checked={picked}
                            disabled={phase === "applying"}
                            aria-label={`Includi ${item.name}`}
                            onChange={(event) =>
                              change({
                                selected: event.currentTarget.checked
                                  ? [...state.selected, item.source_id]
                                  : state.selected.filter((id) => id !== item.source_id),
                              })
                            }
                          />
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{item.name}</Text>
                          {item.measured && (
                            <Badge size="xs" variant="light" color="grape">
                              misurato
                            </Badge>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">
                            {item.new_views} nuove su {item.views}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {item.already_here} già presenti · {item.generated} generate
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Select
                            size="xs"
                            searchable
                            allowDeselect={false}
                            disabled={!picked || phase === "applying"}
                            value={state.into[item.source_id] || NEW}
                            onChange={(value) =>
                              change({ into: { ...state.into, [item.source_id]: value } })
                            }
                            data={[
                              { value: NEW, label: "Come nuovo" },
                              ...preview.targets.map((target) => ({
                                value: target.id,
                                label: `Unisci in « ${target.name} »`,
                              })),
                            ]}
                          />
                        </Table.Td>
                        <Table.Td>
                          <Badge color={badge.color} variant="light">
                            {badge.label}
                          </Badge>
                          <Text size="xs" c="dimmed">
                            {item.explanation}
                          </Text>
                          {item.action !== "skip" && item.final_name !== item.name && (
                            <Text size="xs">→ « {item.final_name} »</Text>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Group justify="space-between">
              <Text size="sm">
                Verranno aggiunti {preview.totals.objects} classificatori e{" "}
                {preview.totals.views} foto.
              </Text>
              <Group gap="xs">
                <Button variant="default" onClick={close} disabled={phase === "applying"}>
                  Annulla
                </Button>
                <Button
                  onClick={apply}
                  loading={phase === "applying"}
                  disabled={preview.totals.objects === 0 && preview.totals.views === 0}
                >
                  Importa
                </Button>
              </Group>
            </Group>
            {phase === "applying" && (
              <Group gap="xs">
                <Loader size="xs" />
                <Text size="xs" c="dimmed">
                  Importazione in corso, non chiudere la pagina…
                </Text>
              </Group>
            )}
          </>
        )}

        {phase === "done" && state.done && (
          <>
            <Text size="sm">
              Importati {state.done.added_objects} classificatori e {state.done.added_views} foto.
            </Text>
            <Stack gap={4}>
              {state.done.results.map((result) => (
                <Text size="sm" key={result.source_id}>
                  « {result.final_name} » —{" "}
                  {result.error
                    ? result.error
                    : result.action === "skip"
                      ? "saltato"
                      : `${result.added_views} foto aggiunte`}
                  {result.measurement === "dropped" &&
                    " · misura non copiata: rifai « Misura »"}
                </Text>
              ))}
            </Stack>
            {state.done.results.some((result) => result.measurement === "copied") && (
              <Alert color="blue">
                Alcuni classificatori sono arrivati già misurati. Prima di usarli per il
                rilevamento su questo apparecchio premi « Misura » nell'app.
              </Alert>
            )}
            <Group justify="flex-end">
              <Button onClick={close}>Chiudi</Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The two buttons
// ---------------------------------------------------------------------------

export default function ObjectsTransfer({ objects, onObjects }) {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(null);

  async function chooseFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      toast.error(`Il file supera il limite di ${MAX_FILE_MB} MB.`);
      return;
    }
    setImporting({ phase: "uploading", name: file.name, progress: 0 });
    try {
      const preview = await upload("/objects/transfer/upload", file, (fraction) =>
        setImporting((now) =>
          now && now.phase === "uploading"
            ? { ...now, progress: fraction, phase: fraction >= 1 ? "checking" : "uploading" }
            : now,
        ),
      );
      setImporting({
        phase: "preview",
        name: file.name,
        token: preview.token,
        preview,
        selected: preview.items.map((item) => item.source_id),
        into: {},
        skipExisting: false,
      });
    } catch (error) {
      setImporting(null);
      toast.error(error.message);
    }
  }

  return (
    <>
      <Group gap="xs">
        <Button
          variant="default"
          onClick={() => setExporting(true)}
          disabled={objects.length === 0}
        >
          Esporta classificatori…
        </Button>
        <FileButton onChange={chooseFile} accept=".db,application/octet-stream">
          {(props) => (
            <Button variant="default" {...props}>
              Importa classificatori…
            </Button>
          )}
        </FileButton>
      </Group>
      <ExportWindow opened={exporting} onClose={() => setExporting(false)} objects={objects} />
      <ImportWindow state={importing} setState={setImporting} onObjects={onObjects} />
    </>
  );
}
