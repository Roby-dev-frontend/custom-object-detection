import { useEffect, useRef, useState } from "react";
import { Badge, Button, Group, Modal, Stack, Text } from "@mantine/core";

/** The viewer: an operator's camera, in a window.
 *
 *  One operator at a time, and while this is open the rest of the panel is
 *  blocked -- it cannot be dismissed by clicking outside it or pressing Esc,
 *  because both exits do different things and the wrong one is not undoable
 *  without asking the operator to press "Condividi" again.
 *
 *  The picture is object-contain, never cropped: an operator's phone is 9:16
 *  and the server's camera 16:9, and cropping one to the other loses the half
 *  you were watching for.
 */
export default function Watch({ device, onClose }) {
  const imageRef = useRef(null);
  const [state, setState] = useState("connecting"); // connecting | live | error
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!device) return undefined;
    setState("connecting");
    setSeconds(0);
    const started = Date.now();
    const tick = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);

    // The same stream the app watches: the operator publishes to /camera_feed
    // and the server re-serves it here. /video_ws rather than /video_feed for
    // the reason the app uses it -- MJPEG cannot be slowed down, so a frame
    // that piles up in a buffer becomes permanent delay.
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/video_ws`;
    const socket = new WebSocket(url);
    let objectUrl = null;
    let stopped = false;

    socket.binaryType = "arraybuffer";
    socket.onopen = () => socket.send("next");
    socket.onmessage = (event) => {
      if (stopped) return;
      if (typeof event.data === "string") {
        // "waiting": the camera has produced nothing yet. Ask again.
        socket.send("next");
        return;
      }
      const next = URL.createObjectURL(new Blob([event.data], { type: "image/jpeg" }));
      if (imageRef.current) imageRef.current.src = next;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = next;
      setState("live");
      socket.send("next");
    };
    socket.onerror = () => !stopped && setState("error");
    socket.onclose = () => !stopped && setState("error");

    return () => {
      stopped = true;
      clearInterval(tick);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      // Closing the socket is what releases the viewer slot on the server.
      socket.close();
    };
  }, [device]);

  const clock =
    `${String(Math.floor(seconds / 60)).padStart(2, "0")}:` +
    `${String(seconds % 60).padStart(2, "0")}`;

  return (
    <Modal
      opened={Boolean(device)}
      onClose={() => {}}
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
      size="lg"
      centered
      title={device?.label ?? ""}
    >
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {device?.username} · la sua fotocamera sta trasmettendo al server
        </Text>

        <div className="relative w-full aspect-video overflow-hidden rounded-md bg-black">
          <img ref={imageRef} alt=""
               className="absolute inset-0 h-full w-full object-contain" />
          {state !== "live" && (
            <div className="absolute inset-0 grid place-items-center px-4 text-center">
              <Text size="sm" c="dimmed">
                {state === "connecting"
                  ? "In attesa del video dell'operatore…"
                  : "Il video si è interrotto. Chiudi e riprova."}
              </Text>
            </div>
          )}
          <Badge color={state === "live" ? "red" : "gray"} variant="filled"
                 className="absolute right-2 top-2">
            {state === "live" ? "IN DIRETTA" : "…"}
          </Badge>
          <Badge color="dark" variant="filled" className="absolute bottom-2 left-2 tabular-nums">
            {clock}
          </Badge>
        </div>

        <Text size="xs" c="dimmed">
          Si guarda un operatore alla volta: finché questa finestra è aperta il resto del
          pannello è bloccato. Si esce in due modi: fermando la condivisione, oppure
          lasciandola accesa — in quel caso il dispositivo continua a trasmettere al server.
        </Text>

        {/* The two exits sit at the two ends of one row of their own, never
            stacked and never sharing the row with anything else: side by side
            they invite the wrong thumb, and one of them cannot be undone
            without asking the operator to press "Condividi" again. */}
        <Group justify="space-between" wrap="nowrap" gap="xl" mt="md">
          <Button variant="default" onClick={() => onClose(false)}
                  classNames={{ label: "whitespace-normal leading-tight" }}>
            Chiudi, lascia trasmettere
          </Button>
          <Button color="red" variant="outline" onClick={() => onClose(true)}
                  classNames={{ label: "whitespace-normal leading-tight" }}>
            Chiudi e ferma la condivisione
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
