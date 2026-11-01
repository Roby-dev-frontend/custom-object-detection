// The form that saves a face.
//
// It shows the capture it is about to store, because with several unknown
// people on screen the one thing that must never be ambiguous is WHO is being
// named. The picture answers that before the first field is filled in.

import { useEffect, useState } from "react";
import {
  Button,
  Group,
  Image,
  Input,
  Modal,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import TrafficLight from "./TrafficLight";
import MapsLink from "./MapsLink";

const JUDGE_LABELS = {
  buono: "Buono",
  accettabile: "Accettabile",
  cattivo: "Cattivo",
};

export default function FaceEnrollModal({
  opened,
  onClose,
  onSubmit,
  preview,          // base64 JPEG of the face about to be saved
  judges,           // { judge: colour } from the server
  defaultJudge = "accettabile",
  saving = false,
  person = null,    // set when editing someone already enrolled
  // The next three are given only when the form opens from a picture in the
  // strip (DetectionStrip): the buttons the face panel under the live video
  // offers, which a page on its own camera does not show.
  onAddView,        // recognised face: add this picture to the person
  onDetails,        // recognised face: open the person's full record
  onPickPerson,     // unknown face: add this picture to someone already saved
  addingView = false,
  position = null,  // where the strip picture was taken, when known
}) {
  const [name, setName] = useState("");
  const [surname, setSurname] = useState("");
  const [description, setDescription] = useState("");
  const [judge, setJudge] = useState(defaultJudge);

  // Refill whenever the dialog opens, so editing one person and then another
  // does not show the first one's details for a frame.
  useEffect(() => {
    if (!opened) return;
    setName(person?.name ?? "");
    setSurname(person?.surname ?? "");
    setDescription(person?.description ?? "");
    setJudge(person?.judge ?? defaultJudge);
  }, [opened, person, defaultJudge]);

  const options = Object.keys(judges ?? JUDGE_LABELS).map((value) => ({
    value,
    label: JUDGE_LABELS[value] ?? value,
  }));

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={person ? "Modifica persona" : "Salva questo volto"}
      centered
      size="md"
    >
      <Stack gap="md">
        <Group align="flex-start" wrap="nowrap">
          {preview ? (
            <Image
              src={`data:image/jpeg;base64,${preview}`}
              alt="Volto da salvare"
              w={110}
              h={110}
              radius="md"
              fit="cover"
            />
          ) : null}
          <Stack gap={4} style={{ flex: 1 }}>
            <TextInput
              label="Nome"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              required
              data-autofocus
            />
            <TextInput
              label="Cognome"
              value={surname}
              onChange={(event) => setSurname(event.currentTarget.value)}
            />
          </Stack>
        </Group>
        {/* Where the picture was taken, as a field like the others. Read
            only: a div with the input's look, so only the link's own text
            opens Maps, not the whole width of the field. */}
        <Input.Wrapper label="Dove è stata scattata">
          <Input component="div">
            {position ? (
              <MapsLink position={position} />
            ) : (
              <Text span size="sm" c="dimmed">
                Non disponibile
              </Text>
            )}
          </Input>
        </Input.Wrapper>

        <Group align="flex-end" wrap="nowrap">
          <Select
            label="Giudizio"
            data={options}
            value={judge}
            onChange={(value) => value && setJudge(value)}
            allowDeselect={false}
            style={{ flex: 1 }}
            description="Decide il colore del riquadro sul video"
          />
          <TrafficLight judge={judge} judges={judges} size={44} />
        </Group>

        <Textarea
          label="Descrizione"
          placeholder="Note su questa persona. Possono essere lunghe: sul video appariranno dietro un pulsante."
          value={description}
          onChange={(event) => setDescription(event.currentTarget.value)}
          autosize
          minRows={3}
          maxRows={8}
        />

        {!person && !preview ? (
          <Text size="xs" c="dimmed">
            Nessuna immagine catturata: seleziona un volto sul video e riprova.
          </Text>
        ) : null}

        {(onAddView || onDetails || onPickPerson) && (
          <Group gap="xs">
            {person && onAddView ? (
              <Button
                variant="light"
                onClick={onAddView}
                loading={addingView}
                title="Aggiunge questa inquadratura a questa persona"
              >
                + Inquadratura ({person.samples ?? 0})
              </Button>
            ) : null}
            {person && onDetails ? (
              <Button variant="light" onClick={onDetails}>
                Dettagli
              </Button>
            ) : null}
            {!person && onPickPerson ? (
              <Button variant="default" onClick={onPickPerson}>
                Aggiungi a una persona…
              </Button>
            ) : null}
          </Group>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={saving}>
            Annulla
          </Button>
          <Button
            onClick={() => onSubmit({ name, surname, description, judge })}
            loading={saving}
            disabled={!name.trim()}
          >
            {person ? "Salva modifiche" : "Salva"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
