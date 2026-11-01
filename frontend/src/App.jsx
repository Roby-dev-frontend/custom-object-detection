import { useEffect, useRef, useState } from "react";
import {
  AppShell,
  MantineProvider,
  Badge,
  Burger,
  Button,
  CheckIcon,
  CloseButton,
  Divider,
  Fieldset,
  FileButton,
  Group,
  Image,
  LoadingOverlay,
  List,
  Loader,
  Modal,
  Paper,
  Progress,
  ScrollArea,
  Select,
  SegmentedControl,
  SimpleGrid,
  Slider,
  Stack,
  Stepper,
  Table,
  Switch,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { toast } from "sonner";
// Mantine has no QR component and nothing else here can draw one. Used only to
// turn a string into a PNG data URL; the dialog around it is Mantine's, and
// the picture is shown with Mantine's own Image.
import QRCode from "qrcode";
import Login from "./Login";
import { BrowserDetector } from "./detection/detector";
import { drawDetections, drawFaces } from "./detection/draw";
import { DetectionReporter } from "./detection/report";
import { clientId, deviceLabel } from "./detection/devices";
import { FaceTracker, cropFaceToJpeg } from "./detection/faces";
import {
  averagedFrameToJpeg,
  captureBurst,
  fileToJpegUnderCap,
  fileToTextJpeg,
  frameToJpeg,
} from "./detection/capture";
import TextReadDialog from "./TextReader";
import { detectionAt, pointerToCanvas } from "./detection/hittest";
import BoxPicker from "./BoxPicker";
import FaceDetail from "./FaceDetail";
import FaceEnrollModal from "./FaceEnrollModal";
import FaceRecord from "./FaceRecord";
import DetectionStrip, {
  SavedPictureModal,
  savedImageUrl,
} from "./DetectionStrip";

// Where the backend lives.
//   dev   (npm run dev)   -> .env sets it to http://127.0.0.1:8000
//   build (npm run build) -> .env.production sets it to "" (empty), so every
//                            call becomes a relative URL like "/video_feed".
// Relative means "same address this page came from", so the built app works
// from any IP or hostname without being rebuilt. `??` not `||`, because ""
// is a deliberate value here and `||` would discard it.
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// The session cookie identifies the user. `credentials: "same-origin"` tells
// fetch to attach it; without that line fetch sends no cookies and every
// request comes back 401.
const SEND_COOKIE = { credentials: "same-origin" };

function jsonHeaders() {
  return { "Content-Type": "application/json" };
}

async function sendCommand(command) {
  try {
    const response = await fetch(`${API_BASE}/command`, {
      method: "POST",
      headers: jsonHeaders(),
      ...SEND_COOKIE,
      body: JSON.stringify({ command }),
    });
    const data = await response.json();
    console.log("Received:", data);
  } catch (error) {
    console.error("Request failed:", error);
  }
}

function setServerSource(source, deviceIndex, detectionConfig, signal, shared) {
  return fetch(`${API_BASE}/source`, {
    method: "POST",
    signal,
    headers: jsonHeaders(),
    ...SEND_COOKIE,
    body: JSON.stringify({
      source,
      device_index: deviceIndex,
      detection_config: detectionConfig,
      shared,
      client_id: CLIENT_ID,
    }),
  });
}

// Value used by the detection picker for hand detection; any other value
// is a COCO class index (as a string, since option values are strings).
// NOTE: only the labels are translated -- these values stay the original
// indices, because that is what the backend and the model use.
// Width the detector actually sees. The models resize their input anyway, and
// the boxes are drawn a few pixels wide on a 640-wide display, so feeding them
// a phone's native 1280x720 spent most of the frame budget on pixels nothing
// used. The overlay canvas is sized to match, so the boxes come back in this
// same coordinate space and CSS stretches them to the displayed size.
const DETECT_WIDTH = 480;
// Upper bound on how much larger than the detector's frame the overlay bitmap
// may be. 3 x 640 covers a full-width 1920 px screen; past that the memory of
// a bigger bitmap buys nothing the eye can see.
const MAX_OVERLAY_SCALE = 3;

// What the phone sends: the size and quality of each uploaded frame, and how
// much may sit unsent before frames start being skipped.
//
// These three are one decision, not three. At 640 px and quality 0.7 a frame
// was ~35 KB and the 48 KB allowance was therefore ABOUT ONE FRAME: the moment
// the uplink took longer than 100 ms to clear a frame, every following frame
// was thrown away. That is what the holes in the footage were -- not a slow
// link on its own, but a threshold set so tight that a slow link dropped
// almost everything.
//
// 480 px at quality 0.5 is roughly a third of the bytes, and 72 KB then holds
// about six of them. The cost is delay: six queued frames are six frames the
// viewer has not seen yet. That is the trade asked for -- complete footage,
// accepted delay -- and the delay it produces is measured and shown in the
// Diagnostica panel rather than left to be guessed at.
// This is what a browser uploads when it is the one holding the camera. It is
// a constant again: the picture's weight is now decided in one place for the
// whole machine ("Qualita' immagine", VIDEO_RUNGS below), and that setting
// governs the camera the server itself is holding -- which is the case this
// app is normally used in, and the one that had no control at all.
const UPLOAD_WIDTH = 480;
const UPLOAD_QUALITY = 0.5;
const MAX_SOCKET_BACKLOG = 72 * 1024;

// How heavy the picture the server's own camera sends is. One setting for the
// whole machine -- the camera encodes each frame once and every viewer gets
// that same JPEG -- so the page reads it back from /presence rather than
// remembering its own.
//
// Four rungs and not more: each one roughly halves the bytes, measured on a
// 640x480 frame from this Pi's webcam, and a halving is the smallest step that
// shows up as a different frame rate at the far end. Anything finer would be a
// control that appears to do nothing.
//
// The last rung is the only one that makes the picture SMALLER, and that is
// deliberate: a watching page detects faces at 640 px and hands at 480 px and
// never scales a picture up, so pixels taken away are taken from the detector,
// while quality taken away is only compression.
const VIDEO_RUNGS = [
  {
    value: "originale",
    label: "Originale (nitida)",
    width: 0,
    quality: 95,
    kb: 70,
  },
  { value: "alta", label: "Alta", width: 0, quality: 85, kb: 34 },
  { value: "media", label: "Media", width: 0, quality: 65, kb: 20 },
  { value: "bassa", label: "Bassa (480 px)", width: 480, quality: 65, kb: 13 },
];
const DEFAULT_RUNG = VIDEO_RUNGS[0];

/** Which rung the server is currently on, or null if it is on something else
 *  (an older server, or a value set by hand). */
function rungFor(encoding) {
  if (!encoding) return null;
  return (
    VIDEO_RUNGS.find(
      (rung) =>
        rung.width === (encoding.width ?? 0) &&
        rung.quality === (encoding.quality ?? 95),
    ) ?? null
  );
}

// The fastest the uplink loop will go, as a gap between frames. It is a
// CEILING, not a rate: the loop sends the next frame when the last one has
// cleared the socket, so a slow link or a slow phone simply never reaches it.
//
// 40 ms = 25 fps. Not 33 (30 fps) because the encode and the detector share
// one thread on the sharing device, and leaving a little headroom is what keeps
// detection from being starved.
const UPLOAD_MIN_GAP_MS = 40;

// How many frames may be encoding at once. The old code had no limit at all,
// and that is where its speed came from: canvas.toBlob does its work off this
// thread, so several encodes overlap and the total rate is far higher than one
// encode's duration suggests.
//
// The number is measured, not guessed. On this Pi, where a single 480 px
// encode takes 401 ms: a cap of 2 gave 2.2 frames a second, 12 gave 9.1, and
// 24 gave 17.9 -- the same as no cap at all (18.7). So 24 is the first value
// that costs nothing on a slow device while still bounding the queue at about
// a second's worth of frames, instead of letting it grow without end.
const UPLOAD_MAX_IN_FLIGHT = 24;

// How long to wait for POST /source. The server opens the camera and waits for
// a frame before answering, so a few seconds is normal; beyond this something
// is wrong and the user needs to be told rather than left with dead buttons.
const SOURCE_TIMEOUT_MS = 20_000;

// How often each page tells the server it is still here. The server forgets a
// device after 20 s without one, so this leaves room for a couple of misses.
const PRESENCE_INTERVAL_MS = 5_000;

// Identity of THIS browser, fixed for the life of the tab.
const CLIENT_ID = clientId();
const CLIENT_LABEL = deviceLabel();

// Toast identities. A message given an id REPLACES the toast already showing
// under that id instead of stacking a new one, and can be dismissed by name
// when the condition clears. Without this the heartbeat alone -- which retries
// every 5 s -- would pile up a new "Impossibile contattare il server" toast
// twelve times a minute.
const TOAST_SOURCE = "source"; // switching camera source
const TOAST_VIDEO = "video"; // the /video_ws stream we are watching
const TOAST_SHARE = "share"; // this device publishing its own camera
const TOAST_PRESENCE = "presence"; // the /presence heartbeat
const TOAST_WIFI = "wifi"; // this machine's own WiFi access point
const TOAST_FACES = "faces"; // enrolling and recognising people
const TOAST_SAVED = "saved"; // the server found something (DetectionStrip)
const TOAST_CLASSIFIER_ADD = "classifier-add"; // adding a strip picture as a training view
const TOAST_TEMPLATE_PICKS = "template-picks"; // choosing template's references
const TOAST_GUIDED = "guided-capture"; // the step-by-step gathering
const TOAST_IMPORT = "image-import"; // photographs read from disk
const TOAST_SAVED_MANY = "saved-many"; // more than SAVED_WARN_ABOVE kept
const TOAST_DETECT = "detect"; // this device's /detect_ws upload
const TOAST_GPS = "gps"; // this device's position, for detections
const TOAST_READ = "read"; // reading text from a frame

/** Where this device is right now, or null. Asked for when a read is SAVED, not
 *  before: reading alone stores nothing, so it has no business asking for a
 *  position. Refused or unavailable is not an error -- the text is saved without
 *  one, and the person is told so. */
function currentPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (fix) =>
        resolve({
          lat: fix.coords.latitude,
          lon: fix.coords.longitude,
          accuracy: fix.coords.accuracy,
        }),
      (error) => {
        toast.warning(
          error.code === error.PERMISSION_DENIED
            ? "Posizione non consentita: il testo viene salvato senza."
            : "Posizione non disponibile: il testo viene salvato senza.",
          { id: TOAST_GPS },
        );
        resolve(null);
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 8000 },
    );
  });
}

// Frames per second this device sends to /detect_ws when it detects on its own
// camera. Measured: the server answers ~4 per second here and keeps only the
// newest frame, so more changes nothing visible, and fewer slows the boxes.
const DETECT_FPS = 5;
const VIDEO_BOX_MAX_AGE_MS = 400;
const PAUSED_VIDEO_FRAME_GAP_MS = 1000;
// How long a spinner over the video waits for the thing it announces to start
// working before it gives up and says so.
const PENDING_TIMEOUT_MS = 30000;

// Above this many pictures in the strip, every page is told to delete some.
// Nothing is removed automatically.
const SAVED_WARN_ABOVE = 100;

// Same idea, for one classifier's own photos: objects.add_views() evicts
// nothing by age (an earlier cap dropping the oldest could silently drop a
// boxed reference), so past this many the page asks instead of acting. It
// counts photographs somebody took -- generated variants are not in it.
const VIEWS_WARN_ABOVE = 100;

/** The five transforms /objects/{id}/augment can apply, in Italian. The keys
 *  are object_augment.py's KINDS and arrive on each view as `generated`. */
const VARIANT_LABELS = {
  bright: "piu' chiara",
  dark: "piu' scura",
  contrast: "contrasto",
  blur: "sfocata",
  colour: "colore",
};

const HAND_OPTION = "hand";
const HAND_LABEL = "Mani (MediaPipe)";

const FACE_OPTION = "face";
const FACE_LABEL = "Volti";

// A classifier's picker value is this prefix plus its id, e.g. "obj:abc123" --
// object ids are 32 hex characters, so this can never collide with a YOLO
// class index (the picker's other kind of non-face/non-hand value).
const CLASSIFIER_PREFIX = "obj:";
function isClassifierChoice(value) {
  return typeof value === "string" && value.startsWith(CLASSIFIER_PREFIX);
}
function classifierIdFromChoice(value) {
  return value.slice(CLASSIFIER_PREFIX.length);
}

// Faces get a bigger canvas than hands and objects. Detection cost does not
// change -- BlazeFace resizes whatever it is given to 128x128 -- but the
// detector is run on 3x3 tiles to reach across a room, and at 480 each tile is
// only 160 px wide. The extra pixels cost one larger drawImage per frame and
// buy detail in every tile.
const FACE_DETECT_WIDTH = 640;

// Frames kept per press of "Cattura". Ten is the server's own cap on one
// request (MAX_CAPTURE_IMAGES), and at the 400 ms spacing captureBurst uses it
// makes a press last about four seconds -- long enough to walk a step round
// the object, short enough that nobody holds a phone still waiting for it.
const CAPTURE_BURST = 10;

// The guided way of gathering, step by step. The burst is still there and
// unchanged; this is for building a set deliberately rather than quickly.
//
// One press takes ONE photograph, not a burst: "tilt the phone and take five
// from different angles" is impossible if one press takes all five 400 ms
// apart. Frames are held until the step is left and sent in one request, which
// keeps a six-step run at six requests -- comfortably inside the server's
// 30-a-minute limit, where one request per press would sit exactly on it.
//
// Steps 5 and 6 are NEGATIVES and go to the "without" set. Step 6 is the most
// valuable of the lot: something that could be mistaken for the object is what
// forces the threshold to be honest, because a background photo of an empty
// room is easy to tell apart and proves very little.
const GUIDED_STEPS = [
  {
    label: "Foto",
    target: 5,
    into: "with",
    message: "Scatta 5 foto dell'oggetto.",
  },
  {
    label: "Angoli",
    target: 5,
    into: "with",
    message: "Ora inclina il telefono e scatta 5 foto da angolazioni diverse.",
  },
  {
    label: "Distanza",
    target: 5,
    into: "with",
    message: "Avvicinati e allontanati dall'oggetto.",
  },
  {
    label: "Ambiente",
    target: 5,
    into: "with",
    message: "Prova con una luce diversa o uno sfondo diverso.",
  },
  {
    label: "Senza",
    target: 5,
    into: "without",
    message: "Ora scatta 5 foto senza l'oggetto con sfondi diversi",
  },
  {
    label: "Simili",
    target: 5,
    into: "without",
    message:
      "Se possibile, fotografa anche qualcosa che potrebbe essere facilmente confuso con il tuo oggetto.",
  },
];

// How many photographs go in one request when importing from disk: the server
// takes ten (MAX_CAPTURE_IMAGES), and the 2 s gap keeps a long import inside
// its 30-requests-a-minute limit by construction rather than by apology.
const IMPORT_BATCH = 10;
const IMPORT_GAP_MS = 2000;

// How often a face that is already identified is checked again. A cached
// identity is a hypothesis with a shelf life, not a fact: the person in the box
// can be replaced by someone else while the tracker thinks it is still the same
// box.
const FACE_REVERIFY_MS = 6000;
// How soon to try again on a face we could not identify. Shorter, because an
// unknown face is the one the user is probably waiting on -- and because a
// second answer is no use once the track it belongs to has expired, which
// happens a second after the box breaks.
const FACE_RETRY_MS = 1500;
// A name is shown once the same person has been named FACE_CONFIRMATIONS times
// within the last FACE_VOTE_WINDOW answers.
//
// NOT "twice in a row", which is what this was first written as and which does
// not work: when a record is thin the score sits near the threshold and the
// answers alternate between the right name and "uncertain", so two consecutive
// agreements never happen and the box stays blank for ever. Two out of three
// tolerates that flicker while still requiring real agreement -- to show a
// WRONG name it would have to be the same wrong person twice in three tries.
const FACE_CONFIRMATIONS = 2;
const FACE_VOTE_WINDOW = 3;
// ...except when one answer is decisive on its own, which names the person
// immediately.
//
// Waiting for a second opinion assumes the face will still be there to have
// one about. It often is not: tracks expire a second after the box breaks, and
// a new track starts with no votes, so with a phone in the hand or a face on a
// television the second vote never arrives and NOBODY is ever named. Measured
// on the real store, leave-one-out over every stored sample: correct matches
// scored 0.451-0.989 with the runner-up never above 0.280, and no probe
// matched the wrong person at all. An answer this far clear of second place is
// not the kind that needs confirming.
const FACE_STRONG_SCORE = 0.55;
const FACE_STRONG_MARGIN = 0.15;
// How long the panel under the video keeps showing a face after the detector
// last saw it. Without this a single missed frame empties the panel, and the
// "save this face" button disappears from under the user's finger.
const FACE_SELECTION_GRACE_MS = 2000;
// Crops kept per face, and for how long, so that saving uses the moment you
// were looking at when you pressed the button rather than two seconds later.
const CROP_BUFFER_SIZE = 6;
const CROP_BUFFER_MS = 8000;
// ...but ENROLLING from a crop that old is a different matter. Eight seconds
// is long enough to have walked several metres, and a burst mixing a face from
// then with the face now is a burst the server cannot store: the frames
// disagree with each other, and the oldest are below the size floor even when
// the one on screen is not. Both of those were reported as bugs; this is the
// line they came from.
const ENROL_CROP_MAX_AGE_MS = 3000;

/** What the panel under the video actually shows about a face, as a string.
 *
 * Used to skip a re-render when the new detection says the same thing as the
 * old one: the box moves every frame, and none of that movement changes a
 * single word beneath it. */
function panelSignature(detection) {
  if (!detection) return "";
  const identity = detection.identity;
  return [
    detection.trackId,
    identity?.status ?? "",
    identity?.person?.id ?? identity?.maybe?.id ?? "",
    identity?.score ?? "",
  ].join("|");
}

// Builds a ws:// or wss:// URL. API_BASE is empty in the production build
// (relative URLs), so fall back to the address the page was loaded from --
// that also picks wss:// automatically when the page is served over https.
function websocketUrl(path) {
  const base = API_BASE || window.location.origin;
  return base.replace(/^http/, "ws") + path;
}

// FastAPI's `detail` is a string for most errors here, but the duplicate-face
// refusal sends an object so the page can offer to add the view to the person
// it names. This reads either.
function detailText(detail) {
  if (!detail) return null;
  if (typeof detail === "string") return detail;
  return detail.message ?? null;
}

function detectionConfigFor(selectValue, location, numHands = "1") {
  let backend;
  if (selectValue === FACE_OPTION) {
    backend = { backend: "face", yolo_classes: null, object_id: null };
  } else if (selectValue === HAND_OPTION) {
    backend = { backend: "mediapipe", yolo_classes: null, object_id: null };
  } else if (isClassifierChoice(selectValue)) {
    backend = {
      backend: "classifier",
      yolo_classes: null,
      object_id: classifierIdFromChoice(selectValue),
    };
  } else {
    backend = {
      backend: "yolo",
      yolo_classes: [Number(selectValue)],
      object_id: null,
    };
  }
  // `location` tells the server whether to annotate at all. "browser" makes it
  // publish raw frames and leaves the drawing to us; see DETECTION_CONFIG in
  // detection.py. Faces are always "browser": the server has no face detector,
  // so "server" would mean no faces found anywhere. Classifiers are the
  // opposite -- always "server": the method needs server-side MediaPipe
  // tasks, and there is no browser implementation to fall back to.
  //
  // num_hands is always stated too. It only matters to the server while hands
  // are detected THERE, but leaving it out would leave whatever some other page
  // last sent.
  return {
    ...backend,
    location:
      backend.backend === "face"
        ? "browser"
        : backend.backend === "classifier"
          ? "server"
          : location,
    num_hands: Number(numHands) === 2 ? 2 : 1,
  };
}

// The inverse: turns the server's detection_config back into the picker's
// value, so a page can follow a choice made on another device. Returns null
// when the config has no single option to point at -- "yolo with every class"
// is a valid server state the picker cannot represent.
function choiceFromConfig(config) {
  if (!config) return null;
  if (config.backend === "face") return FACE_OPTION;
  if (config.backend === "mediapipe") return HAND_OPTION;
  if (config.backend === "classifier") {
    return config.object_id ? CLASSIFIER_PREFIX + config.object_id : null;
  }
  const first = config.yolo_classes?.[0];
  return first === undefined || first === null ? null : String(first);
}

// Reports what we detected so the Pi can still act on it (GPIO etc.).
function postDetections(body) {
  return fetch(`${API_BASE}/detections`, {
    method: "POST",
    headers: jsonHeaders(),
    ...SEND_COOKIE,
    body: JSON.stringify(body),
  });
}

/**
 * A burger on its own rounded backing.
 *
 * The header is transparent now so the picture reaches the top of the screen,
 * and a bare burger over a bright frame is three grey lines on white. Mantine's
 * Paper supplies the shape and the elevation; the Burger inside it is
 * unchanged, so the animation into an X and the keyboard behaviour are still
 * the library's.
 *
 * `hidden` blanks the burger for the panel that is NOT open, so only one is on
 * screen at a time.
 */
function BurgerPill({ opened, hidden, onClick, label }) {
  return (
    <Paper
      radius="xl"
      p={5}
      className={`bg-black/45 backdrop-blur-sm ${hidden ? "invisible" : ""}`}
    >
      <Burger
        opened={opened}
        onClick={onClick}
        // md, not sm. Mantine's Burger reserves `size + spacing-xs`, so the
        // backing goes 36 px -> 44 px: bigger to hit with a thumb, and still
        // inside the 48 px header, which is what keeps the panels below it.
        size="md"
        color="white"
        aria-label={label}
        tabIndex={hidden ? -1 : 0}
      />
    </Paper>
  );
}

/** One line of the sharing diagnostics: a name on the left, a figure on the
 *  right. Tabular digits so the numbers do not jump sideways as they change. */
function MeterRow({ label, value }) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="xs">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="xs" className="tabular-nums">
        {value}
      </Text>
    </Group>
  );
}

/** One saved photograph of a classifier, with its box drawn on top if it has
 * one. The box is stored in the picture's own pixels, so the overlay needs
 * the picture's natural size to turn that into a position on screen --
 * known only once the browser has actually loaded it. */
function ObjectViewThumb({
  view,
  onEdit,
  canDelete,
  onDelete,
  // Picking mode: a tap chooses this photo for the template method instead of
  // opening its box editor, and the number shows where it sits in that choice.
  pickMode = false,
  onTogglePick,
  pickDisabled = false,
  templateRank = null,
}) {
  const [natural, setNatural] = useState(null);
  // Deleting a photo is not instant: the server removes it, the classifier's
  // references are recomputed, and the whole list is refetched before anything
  // on screen changes. Until that lands the picture is still there, so the X
  // looked like it had done nothing at all.
  const [removing, setRemoving] = useState(false);
  const box = view.box;
  return (
    <div className="relative">
      <UnstyledButton
        onClick={() => (pickMode ? onTogglePick?.(view) : onEdit(view))}
        className="block w-full"
        aria-label={
          pickMode
            ? templateRank
              ? `Togli dalla scelta (ora e' la ${templateRank}a)`
              : "Scegli per il metodo template"
            : "Disegna il riquadro"
        }
        // An unboxed photo cannot be a reference, so in picking mode it is not
        // a candidate at all -- dimmed and inert rather than tappable and
        // silently refused by the server.
        disabled={pickMode && pickDisabled}
      >
        <div
          className={`relative overflow-hidden rounded-md${
            pickMode && pickDisabled ? " opacity-40" : ""
          }`}
        >
          <Image
            src={`${API_BASE}/objects/view/${view.name}`}
            radius="sm"
            onLoad={(event) =>
              setNatural({
                w: event.currentTarget.naturalWidth,
                h: event.currentTarget.naturalHeight,
              })
            }
          />
          {box && natural && natural.w > 0 && natural.h > 0 && (
            <div
              className="pointer-events-none absolute border-2 border-[#40c057]"
              style={{
                left: `${(box.x / natural.w) * 100}%`,
                top: `${(box.y / natural.h) * 100}%`,
                width: `${(box.w / natural.w) * 100}%`,
                height: `${(box.h / natural.h) * 100}%`,
              }}
            />
          )}
          {/* The position in the template choice. Top-left is the only free
              corner: "In uso" sits bottom-left and the delete X top-right. */}
          {templateRank && (
            <Badge
              size="xs"
              circle
              color="blue"
              variant="filled"
              className="pointer-events-none absolute left-1 top-1"
            >
              {templateRank}
            </Badge>
          )}
          {/* Which of several boxed photos the live detector actually uses
              right now -- a box alone no longer means that, since Misura and
              activation decide which boxed photos count (see the detect()
              side of this in classifier_detection.py). */}
          {view.in_detector && (
            <Badge
              size="xs"
              color="green"
              variant="filled"
              className="pointer-events-none absolute bottom-1 left-1"
            >
              In uso
            </Badge>
          )}
          {/* Made by this program, not taken by anybody -- bottom-right, the
              last free corner. Worth saying on the photo itself: a variant is
              the original with the lighting changed, so without the badge the
              grid looks like somebody took the same picture five times. */}
          {view.generated && (
            <Badge
              size="xs"
              color="grape"
              variant="filled"
              className="pointer-events-none absolute bottom-1 right-1"
            >
              {VARIANT_LABELS[view.generated] ?? "generata"}
            </Badge>
          )}
        </div>
      </UnstyledButton>
      {canDelete && (
        <CloseButton
          size={24}
          iconSize={14}
          radius="xl"
          variant="transparent"
          aria-label="Elimina"
          title="Elimina"
          disabled={removing}
          // CloseButton takes no `loading` prop, but its icon is replaceable:
          // the spinner lands exactly where the cross was and the button keeps
          // its size, position and colours.
          icon={removing ? <Loader size={14} color="white" /> : undefined}
          onClick={async () => {
            setRemoving(true);
            try {
              await onDelete(view);
            } finally {
              // Usually this component is already gone -- the photo it was
              // showing no longer exists. This is for when it is not: a
              // cancelled confirmation, or a delete the server refused.
              setRemoving(false);
            }
          }}
          // Centred on the picture's top-right corner, same as the carousel's.
          className="absolute right-0 top-0 translate-x-1/3 -translate-y-1/3
                     !bg-black/75 !text-white"
        />
      )}
    </div>
  );
}

function CameraApp({ account, onLoggedOut, setupData, setRekeyOpen, setRekeyCurrent, setRekeyNew, setRekeyConfirm }) {
  const [source, setSource] = useState("usb");
  // Whichever USB index is actually active on the backend right now
  // (0 = "This device's webcam", anything else = "USB Webcam").
  const [activeIndex, setActiveIndex] = useState(null);
  const [usbDevices, setUsbDevices] = useState(null); // null = never scanned yet
  // Whether a real Pi Camera Module is attached. Starts true so the button is
  // not hidden and then popped back in during the first scan; the scan below
  // corrects it within a second of load.
  const [hasPiCamera, setHasPiCamera] = useState(true);
  const [scanning, setScanning] = useState(false);
  // Gathering photographs of an object, for the measurement that decides
  // whether custom-object detection is worth building. Open to every operator
  // on purpose: one database, many people, each contributing the angle they
  // happen to be standing at.
  // The named objects, and which one a burst belongs to. Without this the
  // photographs went into one nameless pile and there was no way to tell what
  // you had been collecting.
  const [objectList, setObjectList] = useState([]);
  const [selectedObject, setSelectedObject] = useState(null);
  const [newObjectOpen, setNewObjectOpen] = useState(false);
  // Asked right after a classifier is created: how the photographs are taken.
  const [modeAskOpen, setModeAskOpen] = useState(false);
  const [newObjectName, setNewObjectName] = useState("");
  const [creatingObject, setCreatingObject] = useState(false);
  const [captureInto, setCaptureInto] = useState("with");
  const [capturing, setCapturing] = useState(false);
  const [captureTotals, setCaptureTotals] = useState({ with: 0, without: 0 });
  const [augmenting, setAugmenting] = useState(false);
  const [clearingGenerated, setClearingGenerated] = useState(false);
  // Flashed once per frame during a burst, so the moment a photo is actually
  // taken is visible -- otherwise the only feedback was the button's own
  // spinner, which says "capturing" for the whole four seconds and never
  // which instant.
  const [captureFlashOn, setCaptureFlashOn] = useState(false);
  const captureFlashTimeout = useRef(null);
  // The selected classifier's own saved photographs, fetched fresh from the
  // server -- every one of them, not just the last few kept in the browser --
  // so a photo a previous visit saved can still be found, boxed and deleted.
  const [objectDetail, setObjectDetail] = useState(null);
  // Which of those saved photos is being drawn on right now, and the box
  // being drawn for it.
  const [editingView, setEditingView] = useState(null);
  const [referenceBox, setReferenceBox] = useState(null);
  const [savingBox, setSavingBox] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [measurement, setMeasurement] = useState(null);
  // Which method's "Usa per il rilevamento" button is mid-request, so only
  // that one row shows a spinner rather than the whole table locking up.
  const [activatingMethod, setActivatingMethod] = useState(null);
  // null means "whatever is active now", so the picker follows the classifier
  // until somebody deliberately changes it.
  const [methodChoice, setMethodChoice] = useState(null);
  // Choosing template's references by tapping the photos. `templatePicks` is
  // the LOCAL choice, saved in one request rather than one per tap: a reshuffle
  // is one intention, not six.
  const [templatePickMode, setTemplatePickMode] = useState(false);
  const [templatePicks, setTemplatePicks] = useState([]);
  const [savingPicks, setSavingPicks] = useState(false);
  // Gathering mode, and the guided run's own state. A step counts the frames
  // TAKEN in it; what the server keeps is only known when the run is sent, and
  // it may refuse near-copies then (the summary says how many).
  // Which way photographs are gathered (the selector), and -- apart from it --
  // whether a guided run is going on. Guidata can be selected and waiting, like
  // Raffica; the run begins with its own button.
  const [captureMode, setCaptureMode] = useState("guided");
  const [guidedOn, setGuidedOn] = useState(false);
  const [guidedStep, setGuidedStep] = useState(0);
  // What each step has gathered so far, held HERE until the last step ends and
  // only then sent. Interrompi therefore has nothing to undo on the server: a
  // run that is abandoned never stored anything.
  const [guidedShots, setGuidedShots] = useState(() =>
    GUIDED_STEPS.map(() => []),
  );
  const [guidedUploading, setGuidedUploading] = useState(false);
  // The last send failed: the photographs are still here, and the button on the
  // picture says so instead of taking another one.
  const [guidedRetry, setGuidedRetry] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importDone, setImportDone] = useState(0);
  const [importTotal, setImportTotal] = useState(0);
  const [importSkipped, setImportSkipped] = useState([]);
  // Read by the import loop, which must notice a press that happened after it
  // started -- state would be the value captured when the loop began.
  const importCancelRef = useRef(false);
  // Starts true: nothing is confirmed showing until the initial
  // selectSource() below resolves, so the spinner must be up from first
  // paint.
  const [switching, setSwitching] = useState(true);
  // COCO class index -> italian name, fetched from the backend so the labels
  // always match the indices it filters on. FOR DISPLAY ONLY.
  const [cocoClasses, setCocoClasses] = useState({});
  // The same indices -> the ENGLISH names, which is what the models actually
  // report. These two were one map once, holding the Italian names, and the
  // browser then filtered MediaPipe's detections by comparing its English
  // "scissors" against our "forbici" -- so every one of the eighty classes
  // matched nothing and detected nothing. Two maps, because the label a person
  // reads and the label a model emits are different things.
  const [cocoNames, setCocoNames] = useState({});
  // Only what the picker shows for the instant before the first heartbeat
  // answers -- the real default lives in DETECTION_CONFIG on the server. Kept
  // in step with it so the field does not flicker from one class to another on
  // every load.
  const [detectionChoice, setDetectionChoice] = useState(FACE_OPTION);
  // How many hands the hand detector follows on THIS device: "1" or "2", as
  // the Select hands it back. One is the default because allowing two while
  // one is in view makes every frame cost about twice as much -- see
  // setHandCount in detection-worker.js.
  const [handCount, setHandCount] = useState("1");
  // TEMPORARY: medians shown by the diagnostic readout -- see recordTiming.
  const [detectTiming, setDetectTiming] = useState(null);
  // TEMPORARY: video frames received per second -- see fpsTimer.
  const [videoFps, setVideoFps] = useState(null);
  // What the server found in own-camera devices' frames: the strip in the
  // corner (DetectionStrip), newest first, the same on every page.
  const [savedEntries, setSavedEntries] = useState([]);
  // The hand/object picture opened bigger, or null.
  const [enlargedEntry, setEnlargedEntry] = useState(null);
  // Reading text from a frame. `readImage` is the frozen frame the dialog
  // shows and the one a save sends back, so what is saved is what was read.
  const [readOpen, setReadOpen] = useState(false);
  const [readImage, setReadImage] = useState(null);
  // The picture came from a file, not from the camera: it has no place to save.
  const [readFromFile, setReadFromFile] = useState(false);
  const [readMode, setReadMode] = useState("scene");
  const [readResult, setReadResult] = useState(null);
  // The words as corrected by the person (null: as read), and where on the live
  // picture a tapped text is being read, for the spinner.

  const [readEdited, setReadEdited] = useState(null);
  // The server has seen text in the picture that is not boxed yet.
  const [textReading, setTextReading] = useState(false);
  useEffect(() => {
    setReadEdited(null);
  }, [readResult]);
  const [readError, setReadError] = useState(null);
  const [readBusy, setReadBusy] = useState(false);
  const [readSaving, setReadSaving] = useState(false);
  // Between the press and the frozen frame: the 8 frames being taken.
  // The face picture (base64) the save/edit form was opened from, when it was
  // opened from the strip; null when opened from the live video. It is what
  // the form's extra buttons add to a person.
  const [stripFaceImage, setStripFaceImage] = useState(null);
  // The same picture, for the "Aggiungi a una persona…" dialog: null when that
  // dialog was opened from the live video's face panel.
  const pickImagesRef = useRef(null);
  // The strip entry the form was opened from. Once its picture has been saved
  // -- as a new person or added to one -- it leaves the strip; the person
  // keeps the picture in faces.db.
  const stripEntryRef = useRef(null);
  // Person ids a list of people was already asked for, so a name in the strip
  // with no colour yet (saved on another device) triggers one reload, not one
  // per render.
  const peopleAskedRef = useRef(new Set());
  // Ids already shown, so only NEW ones raise a toast. null until the first
  // load: whatever is there when the page opens is not news.
  const seenSavedRef = useRef(null);
  // The last {count, latest} the heartbeat reported, to reload only on change.
  const savedSummaryRef = useRef(null);
  // Bumped to reopen /detect_ws after it closed on its own (a server restart).
  const [detectRetry, setDetectRetry] = useState(0);
  // "Ferma" / "Avvia" in the top bar: detect AND save what is found. OFF on
  // startup, same reason detectOnlyOn below is: streaming frames the moment
  // the page opens, before anyone asked for it, is exactly the battery cost
  // the other button was just added to avoid.
  const [detectOn, setDetectOn] = useState(false);
  const [importedVideoUrl, setImportedVideoUrl] = useState(null);
  const [localCameraPreview, setLocalCameraPreview] = useState(false);
  const [importedVideoTime, setImportedVideoTime] = useState(0);
  const [importedVideoDuration, setImportedVideoDuration] = useState(0);
  const [importedVideoPlaying, setImportedVideoPlaying] = useState(false);
  const [detectionReady, setDetectionReady] = useState(false);
  const importedVideoRef = useRef(null);
  const importedVideoFrameRef = useRef(null);
  const importedVideoFrameIdRef = useRef(0);
  const importedVideoSeekIdRef = useRef(0);
  // The other button: detect WITHOUT saving anything, for watching what the
  // classifier finds without filling the strip (or draining the phone's
  // battery doing it). Mutually exclusive with detectOn -- see the two
  // buttons' onClick below -- and together they are the only two ways this
  // device's own camera sends frames to be detected at all; with both false, nothing
  // streams and nothing is detected, which is the actual battery saving.
  const [detectOnlyOn, setDetectOnlyOn] = useState(false);
  // « Leggi testo » switched on: the picture is searched for text live, boxes
  // are drawn, and views that keep showing text are kept in the strip. Never at
  // the same time as Avvia/Osserva.
  const [textOn, setTextOn] = useState(false);
  // Whether the running text reading keeps views in the strip (« Leggi testo »)
  // or only shows boxes (« Osserva testo »), and which pair of buttons is shown:
  // the objects' (Avvia/Osserva) or the text's.
  const [textSave, setTextSave] = useState(true);
  const [textMode, setTextMode] = useState(false);
  useEffect(() => {
    if (!textOn) setTextReading(false);
  }, [textOn]);
  // The last boxes the text finder sent ({w, h, items}), for tapping one, and
  // the timer that wipes them if the server stops answering.
  const textBoxesRef = useRef(null);
  const textStaleRef = useRef(null);
  // Two-finger zoom of THIS device's camera (the track's own `zoom`, where the
  // phone and browser offer it), so what is shared and detected is zoomed too.
  // Kept across the camera being reopened (sharing on/off); 1x after a reload.
  const cameraTrackRef = useRef(null);
  const zoomRef = useRef(null);
  const pinchRef = useRef(null);
  const [zoomLabel, setZoomLabel] = useState(null);
  const zoomLabelTimerRef = useRef(null);
  // Something asked for that is not working yet, shown as a spinner over the
  // video until it is. Server detection: { text, backend }, cleared by the
  // first answer of that kind. Sharing: until the first frame has left.
  // Watching another device: until its first frame is on screen.
  const [detectPending, setDetectPending] = useState(null);
  // Which webcam the "Condividi la webcam" button will start. Only a choice
  // until the button is pressed; while the webcam is on, the server's own
  // source and index are the truth and this is not read.
  const [chosenWebcam, setChosenWebcam] = useState(null);
  // Somebody, on any page, has Avvia on for the Pi's webcam: from /presence.
  const [serverSaving, setServerSaving] = useState(false);
  // The Pi's webcam is shown to the other devices (it may be on and not shared).
  const [cameraShared, setCameraShared] = useState(true);
  // What the server says about the Pi's webcam detecting at all.
  const [serverActive, setServerActive] = useState(true);
  // The Pi's camera is on, whether or not it is shown to this page.
  const [piCameraOn, setPiCameraOn] = useState(false);
  const detectPendingRef = useRef(null);
  const [sharePending, setSharePending] = useState(false);
  const [watchPending, setWatchPending] = useState(false);
  const watchPendingRef = useRef(false);
  // Set by the /detect_ws effect while this device is also sharing: the
  // sharing upload hands it each frame it sends, so detection does not encode
  // a second copy of the same picture on the phone.
  const shareFrameSinkRef = useRef(null);
  // The text inside the Detect field. Held here rather than left to Mantine
  // because clicking the field must EMPTY it (so you can type a class name
  // straight away instead of deleting the old one first), and closing it
  // without choosing anything must put the old name back.
  const [detectionSearch, setDetectionSearch] = useState(FACE_LABEL);
  // This machine's own WiFi access point, so phones can reach the app with no
  // router and no internet. null until the server has been asked; administrators
  // only, and the server enforces that regardless of what is rendered here.
  const [accessPoint, setAccessPoint] = useState(null);
  const [accessPointBusy, setAccessPointBusy] = useState(false);
  const [confirmApOff, setConfirmApOff] = useState(false);
  // Its mirror image: nothing happens until this one is answered either.
  const [confirmApOn, setConfirmApOn] = useState(false);
  // Shown once the network is actually up: the name, the address, and a QR a
  // phone can scan to join instead of being read the password out loud.
  // The data URL, not the payload -- generating it is asynchronous, so the
  // dialog opens on the picture being ready rather than on a promise.
  const [joinQr, setJoinQr] = useState(null);
  // Where detection runs. "browser" is the default because the Pi 4 spends
  // 167-548 ms a frame on it and the viewing device usually spends far less.
  // "server" is chosen with "Dove rilevare", for hands and objects: a Windows
  // PC serving the app measured 44 ms a hand detection against a phone's 120.
  //
  // locationChoice is what was picked; detectionLocation is what actually
  // applies, and faces are always "browser" because the server has no face
  // detector. It is also adopted from every page's heartbeat: with "server"
  // the server draws the marks into the one shared stream, and a page still
  // detecting on its own would draw a second set on top -- the reason the
  // original toggle was taken out.
  // detectionLocation itself is worked out further down, next to
  // capturesOwnCamera, which it depends on.
  const [locationChoice, setLocationChoice] = useState("browser");
  // Whether this device's camera is uploaded to the server for OTHER devices
  // to watch. Off by default: with detection running here, the upload serves
  // nobody but other viewers, and it is the largest cost on a phone -- JPEG
  // encoding plus a continuous WiFi uplink competing with the detection.
  const [sharing, setSharing] = useState(false);

  // How the picture is fitted into the stage.
  //
  //   "contain" -- the whole frame is shown and two bands are left. Nothing at
  //                the edge of the camera's view is ever lost.
  //   "cover"   -- the stage is filled and the overflow is cropped. On a 390 px
  //                phone with a 4:3 camera that discards about 65% of the
  //                WIDTH, and a face in the discarded part is neither visible
  //                nor tappable.
  //
  // A per-device choice, not a server setting: it is about the shape of THIS
  // screen. localStorage can throw (private mode, blocked site data), so every
  // read and write is guarded and the default survives a failure.
  const [videoFit, setVideoFit] = useState(() => {
    try {
      return localStorage.getItem("videoFit") === "cover" ? "cover" : "contain";
    } catch {
      return "contain";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("videoFit", videoFit);
    } catch {
      // A preference that cannot be remembered is not worth an error.
    }
  }, [videoFit]);
  // The class the picture, the overlay and the two geometry helpers all have to
  // agree on. One string, read in four places, so they cannot drift apart.
  const fitClass = videoFit === "cover" ? "object-cover" : "object-contain";
  // Live for the detection loop, which runs on requestAnimationFrame and must
  // not read React state.
  const videoFitRef = useRef(videoFit);
  videoFitRef.current = videoFit;

  // The server can hold a few seconds of frames back for a page that is
  // watching, and play them in order. That used to be a control here
  // ("Memoria video"), and it is asked for as zero now: it never raised the
  // frame rate -- it cannot, it only delays what already arrives -- and the
  // thing that actually held the picture back was detection running on the
  // page's own thread, which is now in a worker. The server still understands
  // the parameter, so this is one number to change if the choice ever comes
  // back.
  const bufferSeconds = 0;

  // The weight of the picture the server's camera sends. Not remembered on this
  // device: it is one setting for the whole machine, so the heartbeat is what
  // says which rung it is on, and this is only what was last heard.
  const [videoEncoding, setVideoEncoding] = useState({
    width: DEFAULT_RUNG.width,
    quality: DEFAULT_RUNG.quality,
  });
  const videoRung = rungFor(videoEncoding);

  async function setVideoRung(value) {
    const rung = VIDEO_RUNGS.find((candidate) => candidate.value === value);
    if (!rung) return;
    const previous = videoEncoding;
    // Moved at once and put back if the server refuses. Waiting for the round
    // trip first left the control sitting on the old rung for as long as the
    // link took, which reads as a control that ignored you.
    setVideoEncoding({ width: rung.width, quality: rung.quality });
    try {
      const response = await fetch(`${API_BASE}/video_encoding`, {
        method: "POST",
        headers: jsonHeaders(),
        ...SEND_COOKIE,
        body: JSON.stringify({ width: rung.width, quality: rung.quality }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.video_encoding) setVideoEncoding(data.video_encoding);
    } catch {
      setVideoEncoding(previous);
      toast.error("Non sono riuscito a cambiare la qualita' dell'immagine.");
    }
  }

  // The two slide-over panels. Open by default where there is room for them
  // beside the picture, closed on a phone where they would cover it.
  //
  // useMediaQuery returns undefined on the very first render (it has no window
  // to measure yet), so `=== true` rather than a plain truthiness test: `!==
  // false` would open both panels over the video for one frame on a phone.
  const wideScreen = useMediaQuery("(min-width: 62em)");
  // A phone or a tablet: the pointer is a finger, and there is no mouse. Used
  // only to decide whether this device should start its own camera on load --
  // a narrow WINDOW on a laptop is not a phone and must not do that.
  const touchOnly = useMediaQuery("(pointer: coarse)");
  const [piOpen, setPiOpen] = useState(false);
  const [appOpen, setAppOpen] = useState(false);
  useEffect(() => {
    if (wideScreen === undefined) return;
    setPiOpen(wideScreen === true);
    setAppOpen(wideScreen === true);
  }, [wideScreen]);
  // The hint points at this panel, where "Misura" lives: opening it is
  // exactly what it was asking for.
  useEffect(() => {
    if (piOpen) setMisuraHint(null);
  }, [piOpen]);
  // Every page currently connected, and which one is publishing. Refreshed by
  // the heartbeat below.
  const [deviceList, setDeviceList] = useState([]);
  const [publisherId, setPublisherId] = useState(null);

  // --- What the sharing is actually doing -------------------------------
  //
  // Measurement, not tuning. The picture being both delayed AND choppy has
  // several possible causes -- an uplink that cannot carry the bytes, a phone
  // too busy encoding, a viewer too slow to decode -- and they want opposite
  // corrections. Sending fewer frames fixes the first and makes the second
  // worse, so nothing gets changed until these numbers say which it is.
  //
  // The publish and viewer loops run every frame and must not touch React
  // state, so they add into this ref; the effect below turns it into something
  // rendered, once a second.
  const meterRef = useRef({
    encoded: 0, // frames drawn into the upload canvas
    sent: 0, // frames actually handed to the socket
    skipped: 0, // frames dropped because the socket was backed up
    bytesOut: 0,
    received: 0, // frames arriving on a watching page
    bytesIn: 0,
    rttTotal: 0, // sum of "next" -> the frame being on screen
    rttCount: 0,
    waitTotal: 0, // of that: "next" -> the bytes arriving (server + network)
    drawTotal: 0, // of that: the bytes arriving -> pixels on screen (decode)
    buffered: 0, // the socket's queue right now
    linkRttMs: null, // ping -> echo, on this device's own clock
  });
  const [meter, setMeter] = useState(null);
  // The last few seconds of {drawn, served, lost}, on a watching page.
  //
  // The verdict needs a HISTORY, not an instant: "behind every second" and
  // "keeping up except for one bad second in ten" produce the same reading at
  // any single moment and need opposite fixes -- lighter frames for the first,
  // a longer buffer for the second.
  const historyRef = useRef([]);
  const [verdict, setVerdict] = useState(null);
  // What this device most recently worked out its own upload delay to be, in
  // milliseconds. A ref because the heartbeat is created once and would
  // otherwise keep reading the value this had at mount.
  const uploadDelayRef = useRef(null);
  // Whether the server on the other end understands the timing ping. Starts
  // false and is only raised by a heartbeat that says so, because the cost of
  // guessing wrong is the share dying: a /camera_feed older than this change
  // reads its socket with receive_bytes(), which raises on a text frame. A
  // page is rebuilt far more often than the server is restarted, so "new page,
  // older server" is an ordinary situation, not an edge case.
  const serverEchoesPingRef = useRef(false);
  // The server's own two numbers, from the heartbeat: it sees the publisher's
  // rate, and how stale a frame was when it handed it out. Both measured
  // against one clock, so neither needs the devices to agree on the time.
  const [serverMeter, setServerMeter] = useState(null);
  // The same numbers where the once-a-second timer can reach them. That timer
  // is created once; adding serverMeter to its dependencies would tear it down
  // and rebuild it on every heartbeat, which resets the history the verdict is
  // built from and so guarantees it never has enough samples to say anything.
  const serverMeterRef = useRef(null);
  useEffect(() => {
    serverMeterRef.current = serverMeter;
  }, [serverMeter]);
  // Whether THIS page is the one drawing the stream, where the same timer can
  // reach it. Same reason as above: it is read once a second by a timer that
  // must not be rebuilt every time the value is recomputed.
  const watchingStreamRef = useRef(false);

  // Where the panels' dropdowns are rendered.
  //
  // They open through a portal -- into <body>, so a long list is not clipped by
  // the panel's own scrolling -- which puts them outside the panels' dark
  // scope: measured, a white list with black text hanging off a dark panel.
  // Marking the portal Mantine makes for itself does not work either, because
  // its colours are keyed on `.app-dark-panel[data-mantine-color-scheme=dark]`
  // and Portal forwards className but drops data attributes, so the container
  // came out with the class and no scheme. This is a host element of our own
  // carrying both, handed to the dropdowns as their portal target.
  //
  // `display: contents` so it occupies no space at all: it exists to own the
  // variables its children inherit, not to lay anything out.
  const [dropdownHost, setDropdownHost] = useState(null);
  // Rebuilt each render rather than memoised: it has to change exactly once,
  // when the host element appears, and a Select re-reading an identical object
  // costs nothing.
  const darkDropdown = {
    withinPortal: true,
    portalProps: { target: dropdownHost ?? undefined },
  };
  // Progress of the model download/initialisation: "" once ready.
  const [detectorStatus, setDetectorStatus] = useState("");
  // Live objects rather than state: these change every frame and must not
  // re-render React.
  const detectorRef = useRef(null);
  const reporterRef = useRef(null);
  const videoImgRef = useRef(null); // <img> fed one frame at a time by /video_ws
  const overlayRef = useRef(null); // <canvas> we draw the result on
  const remoteVideoRef = useRef(null); // this device's own camera, when remote
  const localCameraRef = useRef(null);
  const importedVideo = Boolean(importedVideoUrl);
  // The heartbeat below is created once, so state read inside it would stay
  // frozen at its mount value. A ref is what lets it see `switching` now.
  const switchingRef = useRef(true);
  switchingRef.current = switching;

  // --- Faces -----------------------------------------------------------
  //
  // The detection loop runs on requestAnimationFrame, so nothing in it may
  // touch React state: setState at 30 Hz re-renders the whole page and is the
  // quickest way to ruin the frame rate here. The loop writes to refs, and a
  // slow interval below copies across the little the interface actually needs.
  const trackerRef = useRef(null);
  if (trackerRef.current === null) trackerRef.current = new FaceTracker();
  const faceDetectionsRef = useRef([]);
  const faceDetectWidthRef = useRef(0);
  const selectedTrackRef = useRef(null);
  // The burst captured when the enrol dialog opened. Held in a ref rather than
  // state because it is several JPEGs and nothing renders it except the first.
  const enrollImagesRef = useRef([]);
  // Per-track bookkeeping for the automatic recogniser: when we last asked
  // about this face, and what the last few answers were.
  const recogMetaRef = useRef(new Map());
  // Recent crops per track, so "Salva questo volto" can use frames from BEFORE
  // the button was pressed.
  const cropBufferRef = useRef(new Map());
  const recogniseBusyRef = useRef(false);
  // When the selected face was last actually on screen, for the grace period
  // that keeps the panel from flickering away on a missed frame.
  const lastSeenRef = useRef(0);

  const [faceJudges, setFaceJudges] = useState(null);
  const [defaultJudge, setDefaultJudge] = useState("accettabile");
  const [selectedTrack, setSelectedTrack] = useState(null);
  const [selectedFace, setSelectedFace] = useState(null);
  const [faceCount, setFaceCount] = useState(0);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollPreview, setEnrollPreview] = useState(null);
  const [enrollPerson, setEnrollPerson] = useState(null);
  const [savingFace, setSavingFace] = useState(false);
  const [addingView, setAddingView] = useState(false);
  // The strip entry whose "Aggiungi al classificatore" is mid-request, so
  // only its own button shows a spinner.
  const [addingToClassifier, setAddingToClassifier] = useState(null);
  const [creatingClassifier, setCreatingClassifier] = useState(false);
  // Set when a photo was just added to the classifier CURRENTLY selected for
  // detection: that detector keeps running with the measurement it already
  // had, which does not learn about the new photo on its own. The name is
  // the classifier's, for the message.
  const [misuraHint, setMisuraHint] = useState(null);
  // The record pinned on screen by "Dettagli", as it was when the button was
  // pressed. It is only ever the starting point: see pinnedPerson below.
  const [pinnedSnapshot, setPinnedSnapshot] = useState(null);
  const [people, setPeople] = useState([]);
  // The "add this face to somebody already saved" picker. It exists for the
  // case a thin record cannot be recognised at all -- without it, the only
  // record that needs a new view is the one you cannot reach.
  const [pickOpen, setPickOpen] = useState(false);
  const [pickValue, setPickValue] = useState(null);
  // Defaults mirror face_embedding.py; the server overwrites both on load so
  // the two cannot drift apart.
  const [enrolMinFacePx, setEnrolMinFacePx] = useState(40);
  const minFacePxRef = useRef(29);

  selectedTrackRef.current = selectedTrack;
  // The pinned record, taken from the list loadFaces() keeps up to date rather
  // than from the snapshot: adding a view or editing the description while the
  // panel is open would otherwise leave it showing what was true when it was
  // opened. The snapshot is the fallback, for the moment between saving a new
  // person and the list coming back.
  const pinnedPerson = pinnedSnapshot
    ? (people.find((person) => person.id === pinnedSnapshot.id) ??
      pinnedSnapshot)
    : null;
  const faceMode = detectionChoice === FACE_OPTION;
  // Whether the first heartbeat has answered yet. Until it has, this page
  // knows nothing about which camera the server is on.
  const firstBeat = useRef(true);
  // Search box state for the detection picker.
  // Error message shown when this device's camera can't be used.
  // False when this page is in the background (other tab, window minimised,
  // phone screen locked, app switched away). Measured saving when the last
  // viewer stops: 4.3% -> 0.2% CPU, i.e. the camera worker stops entirely.
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  // True when this page is running on the same machine as the backend (the
  // server tells us; that works via the LAN IP too, not just localhost).
  const [clientIsServer, setClientIsServer] = useState(false);
  // Whether the machine running the server is the Raspberry. When it is not
  // -- a Windows PC during development -- the camera buttons below belong to
  // that PC, and labelling them "del Raspberry" and "/dev/videoN" describes
  // hardware that is not there. Defaults to true so the Raspberry, the normal
  // case, renders correctly on the very first paint; the first heartbeat
  // corrects it everywhere else.
  const [serverIsPi, setServerIsPi] = useState(true);
  // Lets you turn the video back on manually on the server machine.
  const [forceServerVideo, setForceServerVideo] = useState(false);

  // Another device owns the stream right now. While that is true this page is
  // a spectator: it watches what that device sends and does nothing else.
  const someoneElseShares = publisherId !== null && publisherId !== CLIENT_ID;
  // This device publishes its own camera whenever the device camera is
  // selected and nobody else already owns the stream -- the machine running
  // the server included: its own webcam through the browser is exactly the
  // own-camera path (detection, saving, GPS, Avvia/Ferma), the same as a
  // phone's. It used to exclude the server on purpose, with its own camera
  // reached only through the OpenCV "Webcam N" buttons instead -- a separate,
  // much thinner path with none of that.
  // `someoneElseShares` covers every other device: while a phone is sharing, a
  // PC that kept showing its own camera could never see what the phone was
  // sending, which is exactly what "I shared from the PC and nothing appeared
  // on the phone" was.
  const capturesOwnCamera = source === "remote" && !someoneElseShares;
  // The Pi's own USB webcam is what everybody is watching. Avvia works there
  // too: the server detects and saves from the camera's own frames.
  const serverCamera = !someoneElseShares && source === "usb";
  const canDetect =
    importedVideo || localCameraPreview || capturesOwnCamera || serverCamera;
  // A local webcam is running (the Pi Camera Module counts), as opposed to the
  // idle state, "remote" with nobody sharing.
  const webcamOn = source === "usb" || source === "picamera";
  // What the button starts when nothing was chosen: the first USB webcam the
  // scan found, or the Pi Camera Module when that is all there is.
  const defaultWebcam =
    (usbDevices?.length ?? 0) === 0 && hasPiCamera
      ? { source: "picamera", index: undefined }
      : { source: "usb", index: usbDevices?.[0] ?? 0 };
  // What the buttons show as selected: the running webcam if there is one,
  // otherwise the choice made (or the default).
  const shownWebcam = webcamOn
    ? { source, index: activeIndex }
    : (chosenWebcam ?? defaultWebcam);
  // While a phone (or another PC) is the camera source, the server machine has
  // no reason to decode the stream: displaying it costs ~4% of a core at
  // 20fps just to decode the JPEGs, on the machine already doing the
  // detection. Not while the server itself is that source, though (see
  // capturesOwnCamera above) -- there it is the operator's own picture, and
  // suppressing it would hide the only feedback they have while sharing.
  const serverVideoSuppressed =
    clientIsServer &&
    source === "remote" &&
    !capturesOwnCamera &&
    !forceServerVideo;
  const showVideo =
    pageVisible &&
    (importedVideo || localCameraPreview || !serverVideoSuppressed);
  // What actually applies, from locationChoice. Always "browser" for faces (the
  // server has no face detector) and whenever this page shows its OWN camera:
  // that picture goes from the lens straight to this screen, so boxes drawn by
  // the server could only ever land in the copy other devices watch. Choosing
  // "server" there used to switch detection off here and show it nowhere.
  const detectionLocation =
    detectionChoice === FACE_OPTION || capturesOwnCamera
      ? "browser"
      : isClassifierChoice(detectionChoice)
        ? "server"
        : locationChoice;
  // Detect only where the pixels are first-hand: on your own camera, or on the
  // Pi's stream when nobody is sharing. Detecting on someone else's shared
  // feed put boxes on a picture meant to be raw, drew them with the MJPEG
  // stream's own delay so they trailed the objects by seconds, and burned the
  // CPU the browser needed to keep up with that stream in the first place.
  // While a device shares, detection belongs to that device alone.
  //
  // Never on this page's OWN camera any more: such a page runs no detection
  // library at all -- it sends frames to /detect_ws and the server detects
  // (see the upload effect below and DetectionStrip). On a phone the in-browser
  // hand model took ~120 ms a pass and the live view lagged behind it.
  // On the Raspberry's own webcam, nothing is detected until Osserva or Avvia is
  // pressed -- the same as on a phone's camera.
  const observing = detectOn || detectOnlyOn;
  // A picture exists to be read unless the camera is off. This device's own
  // camera shows its picture without being shared.
  const cameraOn = source !== "none" || importedVideo || localCameraPreview;
  const observingRef = useRef(false);
  observingRef.current = observing;
  const detectsHere =
    !localCameraPreview &&
    !someoneElseShares &&
    source !== "remote" &&
    source !== "none" &&
    (!serverCamera || observing);
  // What the spinner over the video says, when something asked for is not
  // working yet (see detectPending). A model that failed to load is not
  // waiting for anything: that message stays in the top bar only.
  const busyText =
    (textOn && textReading ? "Lettura in corso..." : "") ||
    (detectorStatus.startsWith("Caricamento") ? detectorStatus : "") ||
    detectPending?.text ||
    (sharePending ? "Avvio condivisione…" : "") ||
    (watchPending ? "In attesa del video…" : "");
  const waitingForDetection =
    (importedVideo ||
      localCameraPreview ||
      capturesOwnCamera ||
      serverCamera) &&
    (observing || textOn) &&
    !detectionReady;
  const loadingLabel =
    busyText || (waitingForDetection ? "Caricamento del rilevamento..." : "");
  const spinnerVisible = switching || scanning || Boolean(loadingLabel);

  // True while this page has something to measure: it is either the one
  // sending the video or one of the ones watching it.
  const inShare = (sharing && capturesOwnCamera) || someoneElseShares;
  // Kept in step with the flag the verdict timer reads. `someoneElseShares` is
  // exactly the condition under which this page draws frames from /video_ws,
  // which is the only situation where "this screen" means anything.
  watchingStreamRef.current = someoneElseShares;

  // Turn the running counters into a reading, once a second, and start again
  // from zero. A second is long enough that the numbers do not jitter and short
  // enough to show a link that comes and goes.
  useEffect(() => {
    if (!inShare) {
      setMeter(null);
      return;
    }
    const id = setInterval(() => {
      const m = meterRef.current;
      // How long what is already queued will take to leave, at the rate bytes
      // are actually leaving. bytesOut is the last second's worth, so it IS a
      // rate in bytes per second.
      //
      // The empty-queue case is checked FIRST and deliberately. On a slow link
      // a whole second can pass with nothing sent, and dividing by that zero
      // rate made the answer "unknown" -- which blanked a perfectly good
      // reading roughly every other second, so the one number the user is
      // meant to read kept flickering to "…". With nothing waiting there is no
      // queueing delay, whatever the rate, and that is a fact rather than an
      // estimate.
      const queueMs =
        m.buffered === 0
          ? 0
          : m.bytesOut > 0
            ? (m.buffered / m.bytesOut) * 1000
            : null;
      const linkMs = m.linkRttMs != null ? m.linkRttMs / 2 : null;
      const uploadMs =
        queueMs != null && linkMs != null ? Math.round(queueMs + linkMs) : null;
      // Only overwrite with a real reading. A second that could not measure
      // anything must not erase the last one that could.
      if (uploadMs != null) uploadDelayRef.current = uploadMs;
      setMeter({
        encoded: m.encoded,
        sent: m.sent,
        skipped: m.skipped,
        kbOut: Math.round(m.bytesOut / 1024),
        received: m.received,
        kbIn: Math.round(m.bytesIn / 1024),
        rtt: m.rttCount ? Math.round(m.rttTotal / m.rttCount) : null,
        waitMs: m.rttCount ? Math.round(m.waitTotal / m.rttCount) : null,
        drawMs: m.rttCount ? Math.round(m.drawTotal / m.rttCount) : null,
        buffered: Math.round(m.buffered / 1024),
        linkMs: linkMs != null ? Math.round(linkMs) : null,
        queueMs: queueMs != null ? Math.round(queueMs) : null,
        uploadMs,
      });

      // --- the verdict ---------------------------------------------------
      //
      // Only on a page that is WATCHING: it compares what this screen drew
      // against what the server had ready for it, and the sharing device draws
      // nothing from the stream at all.
      const server = serverMeterRef.current;
      // Only where there is a screen drawing the stream. On the device doing
      // the SHARING these same server numbers describe what the watchers are
      // losing, so a verdict built from them would say "questo schermo" about
      // a screen on the other side of the room -- and offer to fix it by
      // changing a setting that governs somebody else's picture.
      if (watchingStreamRef.current && server && server.fps != null) {
        const history = historyRef.current;
        history.push({
          drawn: m.received,
          served: server.fps,
          lost: server.skipped_fps ?? 0,
          // Kept per second and summed over the window like the rest. Judging
          // the split on the latest second alone would let one unlucky second
          // flip the advice between two opposite recommendations.
          wait: m.rttCount ? m.waitTotal / m.rttCount : null,
          decode: m.rttCount ? m.drawTotal / m.rttCount : null,
        });
        // Twenty seconds: long enough to contain a stall that happens every ten
        // or so, short enough to follow a link that changes.
        if (history.length > 20) history.shift();

        if (history.length < 10) {
          setVerdict({ text: "Sto misurando...", tone: "dimmed" });
        } else {
          const lost = history.reduce((total, s) => total + s.lost, 0);
          // WHEN the losses happen, not how far behind the counters look.
          //
          // This used to compare drawn against served and call a second
          // "behind" when it fell short. That proxy broke as soon as the
          // server stopped making viewers wait for its poll: a screen losing
          // frames every single second now trails by a fraction rather than by
          // three frames a second, so the test stopped firing and the panel
          // started recommending a bigger buffer for a screen that was
          // chronically behind -- advice that cannot work.
          //
          // Losing something in MOST seconds is a screen that cannot keep up;
          // losing a lot in a MINORITY of them is a link that stalls, which is
          // what memory is for. That distinction is the thing itself rather
          // than a stand-in for it.
          const lossy = history.filter((s) => s.lost > 0).length;
          if (lost === 0) {
            setVerdict({
              text: "Video completo, nessun fotogramma perso.",
              tone: "teal",
            });
          } else if (lossy >= history.length * 0.6) {
            // Losing frames in most seconds: no amount of memory helps,
            // because they are not late, they are more than this screen can
            // draw.
            //
            // WHICH part is slow decides whether smaller frames are worth
            // reaching for, and the two are not close. Measured on this
            // machine with the viewer saturated: cutting a frame from 15.5 KB
            // to 4.5 KB left the draw rate identical at 23/s, because decoding
            // was 7 ms and the wait 37 ms. Telling someone to lower the
            // quality in that situation sends them to change the one thing
            // that will not move, so the advice follows the split.
            const timed = history.filter((s) => s.wait != null);
            const totalWait = timed.reduce((sum, s) => sum + s.wait, 0);
            const totalDecode = timed.reduce((sum, s) => sum + s.decode, 0);
            // A clear margin, not a bare comparison. Once the server stopped
            // making viewers wait for its poll the two halves came out close --
            // measured at 11 ms of waiting against 10 ms of decoding -- and a
            // plain `>` then flipped the recommendation between two opposite
            // sentences from one reading to the next. Advice that changes its
            // mind every few seconds is worse than advice that is cautious:
            // below this margin neither half is really to blame, and the
            // honest answer is that lighter frames will not buy much.
            const decodeBound =
              timed.length > 0 && totalDecode > totalWait * 1.3;
            setVerdict({
              text: decodeBound
                ? "Questo schermo fatica a decodificare: scendi di un gradino con la Qualita' immagine."
                : "Il tempo se ne va nell'attesa, non nelle immagini: ridurre la qualita' aiuta poco.",
              tone: "orange",
            });
          } else {
            // Keeping up most of the time and losing a lot when it does not:
            // the frames exist, the link just cannot carry them in bursts.
            // The advice used to be "hold more of them back", which only ever
            // delayed the same picture; the honest lever is fewer bytes per
            // frame.
            setVerdict({
              text: "Il collegamento si blocca a tratti: prova una Qualita' immagine piu' bassa.",
              tone: "orange",
            });
          }
        }
      } else {
        historyRef.current = [];
        setVerdict(null);
      }

      const buffered = m.buffered;
      // `buffered` and `linkRttMs` are levels, not totals: they are overwritten
      // as they are measured and must survive the reset, unlike the counts.
      meterRef.current = {
        encoded: 0,
        sent: 0,
        skipped: 0,
        bytesOut: 0,
        received: 0,
        bytesIn: 0,
        rttTotal: 0,
        rttCount: 0,
        waitTotal: 0,
        drawTotal: 0,
        buffered,
        linkRttMs: m.linkRttMs,
      };
    }, 1000);
    return () => {
      clearInterval(id);
      // A new share is a new measurement. Keeping the old seconds would let a
      // verdict about the last link be delivered about this one.
      historyRef.current = [];
    };
  }, [inShare]);

  // [{ value, label }] -- faces first, then hands, then every COCO class in
  // ITALIAN alphabetical order. Faces lead the list because that is the one
  // this app is now built around; the two named options stay out of the
  // alphabetical run so they do not have to be hunted for among eighty.
  //
  // The server hands these back keyed by COCO index, so they arrived in the
  // model's own order: persona, bicicletta, automobile, motocicletta,
  // aeroplano... Nothing about that order is visible to someone reading the
  // list, which made finding a class a matter of scrolling through all eighty.
  //
  // localeCompare with "it" rather than a plain `<`: that sorts by character
  // code, which puts every capital before every lower-case letter ("TV" above
  // "aeroplano") and misfiles accented letters. Only `label` is reordered --
  // `value` stays the COCO index the server filters on.
  // One per classifier, grouped apart from the COCO run below. Disabled
  // (and marked as such) until it has an active measurement -- it can be
  // SEEN as soon as it exists, so its absence never reads as a bug, but it
  // cannot be picked until Misura has found a method that works and an
  // administrator has activated it.
  const classifierOptions = objectList.map((item) => ({
    value: CLASSIFIER_PREFIX + item.id,
    label: item.detector ? item.name : `${item.name} (da misurare)`,
    disabled: !item.detector,
  }));

  const detectionOptions = [
    { value: FACE_OPTION, label: FACE_LABEL },
    { value: HAND_OPTION, label: HAND_LABEL },
    ...(classifierOptions.length
      ? [{ group: "Classificatori personalizzati", items: classifierOptions }]
      : []),
    ...Object.entries(cocoClasses)
      .map(([index, label]) => ({ value: index, label }))
      .sort((a, b) => a.label.localeCompare(b.label, "it")),
  ];
  // Grouped entries (the classifiers above) nest inside one item's `items`,
  // so a plain .find over detectionOptions cannot see them -- flatten once
  // for every lookup that needs to find an option by value.
  const flatDetectionOptions = detectionOptions.flatMap((o) => o.items ?? [o]);
  // What the field shows when you are NOT searching in it.
  const currentDetectionLabel =
    flatDetectionOptions.find((o) => o.value === detectionChoice)?.label ?? "";

  // Whenever the selected class really changes -- picked here, picked on
  // another device and carried over by the heartbeat, or the COCO names
  // arriving from the server and giving the current index a label -- the field
  // shows the new name. This also corrects the restore below in the one case
  // where it guesses wrong: closing the dropdown BY choosing something runs
  // that handler with the previous choice still in state, and this effect
  // immediately overwrites it with the right one.
  useEffect(() => {
    setDetectionSearch(currentDetectionLabel);
  }, [currentDetectionLabel]);

  /** A webcam button turns that camera on or off -- it does NOT share it. On:
   *  the picture shows on the server machine's pages only, until
   *  « Condividi la webcam » is pressed. Clicking the one that is running turns
   *  it off; clicking another while one is on switches to it, keeping whether
   *  it is shared. */
  function pickWebcam(nextSource, index) {
    // On a phone the panel covers the picture this click is about to change.
    if (!clientIsServer && wideScreen !== true) setPiOpen(false);
    setChosenWebcam({ source: nextSource, index });
    const running =
      webcamOn &&
      source === nextSource &&
      (nextSource !== "usb" || activeIndex === index);
    if (running) {
      selectSource("none");
      return;
    }
    selectSource(nextSource, index, undefined, webcamOn ? cameraShared : true);
  }

  /** "Condividi la webcam" / "Smetti di condividere", like the client's button:
   *  nothing is shared until this is pressed. Pressing it again only stops
   *  showing the camera to the other devices. */
  function toggleWebcam() {
    if (webcamOn) {
      // Stopping only stops SHOWING it to the other devices: the camera keeps
      // running and this page keeps the picture.
      selectSource(source, activeIndex ?? undefined, undefined, !cameraShared);
      return;
    }
    const wanted = chosenWebcam ?? defaultWebcam;
    selectSource(wanted.source, wanted.index, undefined, true);
  }

  async function selectSource(next, deviceIndex, detectionConfig, shared) {
    setSwitching(true);
    try {
      // Always state the detection config, even when only the camera changed.
      // detection_config lives on the server and is shared by every page, so
      // asserting it here stops a value left behind by some other client from
      // quietly turning server-side annotation back on -- which is what put
      // two sets of boxes on the picture.
      // `active` says whether the Raspberry's own camera detects at all: only
      // while Osserva or Avvia is on. Stated every time, so a value left by an
      // earlier choice cannot stay behind.
      const config = {
        ...(detectionConfig ??
          detectionConfigFor(detectionChoice, detectionLocation, handCount)),
        active:
          next === "usb" || next === "picamera" ? observingRef.current : true,
      };
      // The backend doesn't respond until the new source has actually
      // produced a frame (or times out), so awaiting this is what "ready"
      // means -- no separate polling needed.
      // Bound the wait. The server opens a camera and waits for a frame, and
      // a camera that never answers left this pending forever -- the page then
      // sat with every button disabled and no way back except a reload.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), SOURCE_TIMEOUT_MS);
      let response;
      try {
        response = await setServerSource(
          next,
          deviceIndex,
          config,
          abort.signal,
          shared,
        );
      } finally {
        clearTimeout(timer);
      }
      const data = await response.json();
      // The server reports whether this page is running on the server machine.
      setClientIsServer(Boolean(data.client_is_server));
      if (typeof data.shared === "boolean") setCameraShared(data.shared);
      setServerActive(data.detection_config?.active !== false);
      setSource(next);
      if (deviceIndex !== undefined) setActiveIndex(deviceIndex);

      // ready === false means the switch was accepted but no image ever
      // arrived (camera busy, wrong index, or Pi Camera missing). Without
      // this you just get a blank rectangle and no explanation.
      // "remote" is exempt: its frames only start after this call returns.
      if (next === "remote" && !data.publishing && data.client_is_server) {
        // The server watches; it has no camera of its own to fall back on.
        toast.warning(
          "Nessun dispositivo sta condividendo la sua fotocamera. " +
            "Sul telefono o sul PC premi « Condividi con gli altri ».",
          { id: TOAST_SOURCE },
        );
      } else if (next !== "remote" && next !== "none" && data.ready === false) {
        toast.warning(
          next === "picamera"
            ? "La Pi Camera non ha prodotto immagini. E' collegata? Su questo PC non e' disponibile."
            : `La camera ${deviceIndex ?? ""} non ha prodotto immagini. ` +
                "Prova un altro indice con « Scan for cameras », " +
                "o controlla che non sia gia' in uso da un altro programma.",
          { id: TOAST_SOURCE, duration: Infinity },
        );
      } else {
        // The source is showing a picture: take down whatever this switch had
        // put up last time.
        toast.dismiss(TOAST_SOURCE);
      }
    } catch (error) {
      console.error("Failed to switch camera source:", error);
      toast.error(
        error.name === "AbortError"
          ? `Il server non ha risposto entro ${SOURCE_TIMEOUT_MS / 1000} secondi. ` +
              "La videocamera scelta potrebbe non rispondere: provane un'altra."
          : "Impossibile contattare il server.",
        { id: TOAST_SOURCE },
      );
    } finally {
      // Always re-enabled, whatever went wrong: leaving this true is what made
      // the interface look permanently frozen.
      setSwitching(false);
    }
  }

  // Changing what we detect doesn't change the camera, so this reuses the
  // current source/index and only varies detection_config.
  function selectDetection(selectValue) {
    setDetectionChoice(selectValue);
    if (detectOn || detectOnlyOn) setDetectionReady(false);
    // On this device's own camera the server detects: the new kind is working
    // when its first answer comes back (objects took ~20 s the first time,
    // while the server loaded the model). Only worth waiting for if either
    // button actually has frames streaming right now.
    if (
      (capturesOwnCamera || importedVideo || localCameraPreview) &&
      (detectOn || detectOnlyOn)
    ) {
      detectPendingRef.current = {
        text: "Cambio rilevamento…",
        backend: detectionConfigFor(
          selectValue,
          capturesOwnCamera ? "browser" : detectionLocation,
          handCount,
        ).backend,
      };
      setDetectPending(detectPendingRef.current);
    }
    // Same reason the panel hides during a capture: whatever is picked here,
    // it is picked to see it find something right away, and on a phone this
    // panel (where the picker itself lives) is what is covering the video.
    // Every option, not just classifiers and YOLO classes: face and hand had
    // been left out, and that was the bug.
    setPiOpen(false);
    setAppOpen(false);
    selectSource(
      source,
      activeIndex ?? undefined,
      detectionConfigFor(
        selectValue,
        capturesOwnCamera ? "browser" : locationChoice,
        handCount,
      ),
    );
  }

  // "Dove rilevare". Stated to the server at once: detection_config is shared,
  // and with "server" it is the server that draws the marks into the one
  // stream every device watches.
  function changeLocation(value) {
    setLocationChoice(value);
    selectSource(
      source,
      activeIndex ?? undefined,
      detectionConfigFor(detectionChoice, value, handCount),
    );
  }

  // "Mani da rilevare". Detecting here, the count only reaches this page's own
  // worker (it travels with each frame); detecting on the server, the server's
  // detector is the one that has to change, so it is sent there as well.
  function changeHandCount(value) {
    setHandCount(value);
    // On this page's own camera the server detects too (/detect_ws), with the
    // shared config, so the count has to reach it there as well.
    if (detectionLocation === "server" || capturesOwnCamera) {
      selectSource(
        source,
        activeIndex ?? undefined,
        detectionConfigFor(detectionChoice, detectionLocation, value),
      );
    }
  }

  function importVideoFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setLocalCameraPreview(false);
    setImportedVideoTime(0);
    setImportedVideoDuration(0);
    setImportedVideoPlaying(false);
    importedVideoFrameIdRef.current = 0;
    importedVideoSeekIdRef.current = 0;
    setDetectionReady(false);
    setDetectOn(false);
    if (textMode) {
      setDetectOnlyOn(false);
      setTextOn(true);
      setTextSave(false);
    } else {
      setDetectOnlyOn(true);
      setTextOn(false);
    }
    setImportedVideoUrl(url);
  }

  function closeImportedVideo() {
    const currentVideo = importedVideoRef.current;
    if (currentVideo) {
      currentVideo.pause();
    }
    importedVideoFrameRef.current = null;
    setLocalCameraPreview(true);
    setDetectionReady(false);
    setImportedVideoTime(0);
    setImportedVideoDuration(0);
    setImportedVideoPlaying(false);
    setImportedVideoUrl(null);
  }

  function stopImportedVideo() {
    const video = importedVideoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = 0;
  }

  function toggleImportedVideoPlayback() {
    const video = importedVideoRef.current;
    if (!video || !detectionReady) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  function seekImportedVideo(value) {
    const video = importedVideoRef.current;
    if (!video || !Number.isFinite(value)) return;
    video.currentTime = value;
    setImportedVideoTime(value);
  }

  function formatVideoTime(value) {
    const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function currentMediaElement() {
    if (importedVideo) return importedVideoRef.current;
    if (localCameraPreview) {
      return capturesOwnCamera
        ? remoteVideoRef.current
        : localCameraRef.current;
    }
    return capturesOwnCamera ? remoteVideoRef.current : videoImgRef.current;
  }

  useEffect(() => {
    if (!importedVideoUrl) return undefined;
    return () => URL.revokeObjectURL(importedVideoUrl);
  }, [importedVideoUrl]);

  useEffect(() => {
    if (!localCameraPreview || capturesOwnCamera || !pageVisible)
      return undefined;
    const video = localCameraRef.current;
    if (!video || !navigator.mediaDevices?.getUserMedia) {
      toast.error("La videocamera di questo dispositivo non è disponibile.");
      setLocalCameraPreview(false);
      return undefined;
    }
    let cancelled = false;
    let stream = null;
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 } },
      })
      .then(async (openedStream) => {
        if (cancelled) {
          openedStream.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = openedStream;
        video.srcObject = openedStream;
        await video.play();
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Failed to open local preview camera:", error);
        toast.error("Impossibile aprire la videocamera di questo dispositivo.");
        setLocalCameraPreview(false);
      });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [localCameraPreview, capturesOwnCamera, pageVisible]);

  // Ends whoever is sharing, from here. Without it a spectator is stuck
  // watching a camera it did not start and cannot turn off.
  async function stopOtherSharing() {
    try {
      const response = await fetch(`${API_BASE}/stop_sharing`, {
        method: "POST",
        headers: jsonHeaders(),
        ...SEND_COOKIE,
      });
      await response.json();
      // Do not clear publisherId here: the server closes the publisher's
      // socket first, and the next heartbeat reports it gone. Guessing would
      // restart this device's camera before the other one has actually let go.
    } catch (error) {
      console.error("Failed to stop sharing:", error);
      toast.error("Impossibile fermare la condivisione.", {
        id: TOAST_SHARE,
      });
    }
  }

  // --- this machine's own WiFi network ---------------------------------

  // Asked once, and only for an administrator: a non-admin gets 403 from this
  // address, and a 403 in the console on every page load looks like a fault.
  useEffect(() => {
    if (!account.is_admin) return;
    let cancelled = false;
    fetch(`${API_BASE}/wifi_ap`, SEND_COOKIE)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data) setAccessPoint(data);
      })
      .catch(() => {
        // Silent on purpose. The heartbeat already reports a server that
        // cannot be reached; saying it twice helps nobody.
      });
    return () => {
      cancelled = true;
    };
  }, [account.is_admin]);

  // The WIFI: payload phones understand, with the four characters that carry
  // meaning inside it escaped. A passphrase containing a ; or a , would
  // otherwise end the field early and the phone would silently try to join
  // with half a password -- the failure would look like a wrong password
  // rather than like a bad QR.
  function wifiPayload(ssid, passphrase) {
    const escape = (value) => String(value).replace(/([\\;,:"])/g, "\\$1");
    return `WIFI:T:WPA;S:${escape(ssid)};P:${escape(passphrase)};H:false;;`;
  }

  // Returns what the dialog needs, or a version of it with no picture when the
  // passphrase is not available -- which is the case until the machine's
  // camera-ap helper is reinstalled, since older copies do not report it.
  async function buildJoinQr(data) {
    const base = {
      ssid: data.ssid ?? "CameraPi",
      address: data.ap_address,
      passphrase: data.passphrase || null,
      image: null,
    };
    if (!base.passphrase) return base;
    try {
      // Plain black on white and a generous margin: a QR is read by a camera
      // pointed at a screen, and styling it is how it stops scanning.
      base.image = await QRCode.toDataURL(
        wifiPayload(base.ssid, base.passphrase),
        { width: 240, margin: 2, color: { dark: "#000000", light: "#ffffff" } },
      );
    } catch (error) {
      console.error("Could not draw the WiFi QR code:", error);
    }
    return base;
  }

  async function applyAccessPoint(enabled) {
    setAccessPointBusy(true);
    try {
      const response = await fetch(`${API_BASE}/wifi_ap`, {
        method: "POST",
        headers: jsonHeaders(),
        ...SEND_COOKIE,
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json();
      if (!response.ok) {
        toast.error(data.detail || "Impossibile cambiare la rete WiFi.", {
          id: TOAST_WIFI,
        });
        return;
      }
      setAccessPoint(data);
      if (data.state === "on") {
        // An ordinary confirmation now, not a toast that never goes away. The
        // address it used to carry is on the panel below for as long as the
        // network is up: a thing you have to copy down belongs somewhere it
        // stays, not in a message that is also covering the page.
        toast.success(`Rete « ${data.ssid ?? "CameraPi"} » attiva.`, {
          id: TOAST_WIFI,
        });
        // ...and the dialog, which is the part you can actually point a phone
        // at. Opened whether or not a QR could be made: without the passphrase
        // it still shows the network name and the address, which is strictly
        // more than the toast alone gave.
        setJoinQr(await buildJoinQr(data));
      } else if (data.state === "off") {
        toast.success("Rete WiFi spenta.", { id: TOAST_WIFI });
      } else {
        toast.error(data.detail || "Stato della rete WiFi sconosciuto.", {
          id: TOAST_WIFI,
          duration: Infinity,
        });
      }
    } catch (error) {
      console.error("Failed to change the access point:", error);
      toast.error("Impossibile contattare il server.", { id: TOAST_WIFI });
    } finally {
      setAccessPointBusy(false);
    }
  }

  async function scanUsbDevices() {
    setScanning(true);
    try {
      const response = await fetch(`${API_BASE}/camera_devices`, SEND_COOKIE);
      const data = await response.json();
      setUsbDevices(data.devices);
      // Older servers do not send this field; treat its absence as "present"
      // so the button keeps working against them.
      setHasPiCamera(data.picamera !== false);
    } catch (error) {
      console.error("Failed to scan for cameras:", error);
      setUsbDevices([]);
    } finally {
      setScanning(false);
    }
  }

  /** One instant of the capture-burst flash. Re-triggerable mid-flash (a new
   * frame can land before the previous flash has faded), which is why this
   * resets the timeout rather than letting an old one turn it off early. */
  function flashCapture() {
    setCaptureFlashOn(true);
    if (captureFlashTimeout.current) clearTimeout(captureFlashTimeout.current);
    captureFlashTimeout.current = setTimeout(
      () => setCaptureFlashOn(false),
      150,
    );
  }

  /**
   * Keeps a burst of frames as photographs of an object.
   *
   * Grabbed from the picture already on screen, so the device holding the
   * camera stores its OWN frames at full quality: nothing makes the round trip
   * to the server and back, and a watching device stores what it is watching.
   * Same choice of element as captureCrops makes for faces.
   *
   * Spaced out rather than taken in one tick, and the reason is the whole
   * value of the set: ten frames from one instant are ten copies of one pose.
   * Move the object -- or yourself -- while this runs.
   */
  /** Sends frames to wherever that kind of frame belongs, and brings the
   *  panel's counters and gallery up to date. Returns how many the server kept,
   *  or null when it refused -- the caller has already been told by a toast.
   *
   *  Frames OF the object belong to that object, by name, in the database.
   *  Frames WITHOUT it are background shots of the room: they belong to no
   *  object in particular and are shared by every measurement, so they stay in
   *  the bench folder.
   *
   *  Extracted from captureObjectFrames because three callers now need exactly
   *  this: the burst, the guided steps, and the folder import. The duplicate
   *  version each would otherwise have grown is the kind that drifts. */
  /** What the server refused or cleaned up, as a phrase to append -- empty
   *  when there is nothing to say. */
  function dropped({ duplicates = 0, removed = 0 }) {
    const parts = [];
    if (duplicates) parts.push(`${duplicates} doppioni scartati`);
    if (removed) parts.push(`${removed} doppioni di prima eliminati`);
    return parts.length ? ` (${parts.join(", ")})` : "";
  }

  async function uploadObjectFrames(frames, into, { quiet = false } = {}) {
    const toObject = into === "with";
    try {
      const response = await fetch(
        toObject
          ? `${API_BASE}/objects/${selectedObject}/views`
          : `${API_BASE}/objects/frames`,
        {
          ...SEND_COOKIE,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            toObject ? { images: frames } : { into: "without", images: frames },
          ),
        },
      );
      if (!response.ok) {
        const detail = await response.text();
        toast.error(`Caricamento non riuscito (${response.status}).`);
        console.error("upload failed:", detail);
        return null;
      }
      const data = await response.json();
      if (toObject) {
        setObjectList((list) =>
          list.map((item) => (item.id === data.object.id ? data.object : item)),
        );
        setCaptureTotals((totals) => ({
          ...totals,
          // What was gathered, which is not what is stored: variants
          // this program made are not photographs anybody collected.
          with: data.object.real_views ?? data.object.views,
        }));
        setObjectDetail(data.object ?? null);
      } else {
        setCaptureTotals((totals) => ({ ...totals, without: data.total }));
      }
      // `quiet` is for a caller sending many batches: one toast per batch of a
      // 300-photo import would bury the screen, so it reports once at the end.
      if (!quiet) {
        toast.success(
          toObject
            ? `${data.saved} foto salvate${dropped(data)}. « ${data.object.name} » ne ha ${data.object.views}.`
            : `${data.saved} foto salvate${dropped(data)}. In totale ${data.total} senza l'oggetto.`,
        );
      }
      // Three numbers rather than one, because "5 foto salvate" after taking
      // ten looks like a failure unless it says where the other five went.
      return {
        saved: data.saved ?? 0,
        duplicates: data.duplicates ?? 0,
        removed: data.removed ?? 0,
      };
    } catch (error) {
      console.error("Failed to upload frames:", error);
      toast.error("Caricamento non riuscito.");
      return null;
    }
  }

  function guidedReset() {
    setGuidedShots(GUIDED_STEPS.map(() => []));
    setGuidedStep(0);
    setGuidedRetry(false);
  }

  /** Raffica / Guidata: the selector only. Leaving Guidata ends a run. */
  function chooseCaptureMode(mode) {
    setCaptureMode(mode);
    if (mode !== "guided") setGuidedOn(false);
  }

  /** "Inizia la procedura guidata": the run begins -- the caption and the
   *  shutter appear on the picture. It needs a classifier to file the
   *  photographs under, so without one it says so and does not start. */
  function startGuided() {
    if (!selectedObject) {
      toast.error(
        "Scegli o crea un classificatore prima di iniziare la procedura guidata.",
        { id: TOAST_GUIDED },
      );
      return;
    }
    guidedReset();
    // On a phone an open panel is the whole screen, and the button to press is
    // now on the picture: Avvia does the same.
    if (wideScreen !== true) {
      setPiOpen(false);
      setAppOpen(false);
    }
    setCaptureMode("guided");
    setGuidedOn(true);
  }

  /** "Interrompi": the run ends and everything taken in it is thrown away. */
  function guidedInterrupt() {
    guidedReset();
    setGuidedOn(false);
    toast("Procedura interrotta: le foto scattate sono state scartate.", {
      id: TOAST_GUIDED,
    });
  }

  /** One photograph, for the guided run. Held in the page until the run ends.
   *  The fifth of a step moves the run on by itself. */
  function guidedShot() {
    const step = GUIDED_STEPS[guidedStep];
    if (!step || guidedUploading) return;
    const media = currentMediaElement();
    const jpeg = frameToJpeg(media);
    if (!jpeg) {
      toast.error("Nessun fotogramma: non c'e' video sullo schermo.", {
        id: TOAST_GUIDED,
      });
      return;
    }
    flashCapture();
    const shots = guidedShots.map((list, index) =>
      index === guidedStep ? [...list, jpeg] : list,
    );
    setGuidedShots(shots);
    if (shots[guidedStep].length >= step.target) guidedAdvance(shots);
  }

  /** To the next step, or -- after the last -- to sending everything. Also what
   *  « Salta » and « Avanti » do: a step left short keeps what it has. */
  function guidedAdvance(shots = guidedShots) {
    if (guidedStep + 1 < GUIDED_STEPS.length) {
      setGuidedStep(guidedStep + 1);
      return;
    }
    guidedFinish(shots);
  }

  /** Sends the whole run: every « con l'oggetto » photograph, then every
   *  « senza ». Ten to a request, the server's cap. If a request fails the
   *  photographs stay and the button becomes « Riprova »; sending again is safe
   *  because the server refuses a photograph it already has. */
  async function guidedFinish(shots) {
    if (guidedUploading) return;
    if (shots.every((list) => list.length === 0)) {
      toast("Nessuna foto scattata: non c'e' niente da salvare.", {
        id: TOAST_GUIDED,
      });
      guidedReset();
      setGuidedOn(false);
      return;
    }
    setGuidedUploading(true);
    setGuidedRetry(false);
    try {
      const total = { with: 0, without: 0, duplicates: 0, removed: 0 };
      for (const into of ["with", "without"]) {
        const frames = GUIDED_STEPS.flatMap((step, index) =>
          step.into === into ? shots[index] : [],
        );
        for (let at = 0; at < frames.length; at += IMPORT_BATCH) {
          const result = await uploadObjectFrames(
            frames.slice(at, at + IMPORT_BATCH),
            into,
            { quiet: true },
          );
          if (result === null) {
            setGuidedRetry(true);
            toast.error(
              "Caricamento non riuscito: le foto sono ancora qui. Premi « Riprova ».",
              { id: TOAST_GUIDED },
            );
            return;
          }
          total[into] += result.saved;
          total.duplicates += result.duplicates;
          total.removed += result.removed;
        }
      }
      toast.success(
        `${total.with} foto con l'oggetto e ${total.without} senza salvate${dropped(total)}.` +
          (total.without === 0
            ? " Senza foto « senza l'oggetto » la misura non puo' dire quanto spesso sbaglia."
            : ""),
        { id: TOAST_GUIDED, duration: 10000 },
      );
      guidedReset();
      setGuidedOn(false);
    } finally {
      setGuidedUploading(false);
    }
  }

  /** Imports photographs already on this device.
   *
   *  Sequential on purpose: this is a Raspberry Pi serving video from the same
   *  process, and every image is decoded and re-encoded server-side. Decoding
   *  happens a batch at a time too -- 300 base64 strings at once is 75 MB of
   *  JavaScript string that a phone will not survive. */
  async function importImageFiles(files, into) {
    if (!files?.length || importing) return;
    if (into === "with" && !selectedObject) {
      toast.error("Scegli un classificatore prima di importare.", {
        id: TOAST_IMPORT,
      });
      return;
    }
    const pictures = [...files];
    importCancelRef.current = false;
    setImporting(true);
    setImportDone(0);
    setImportTotal(pictures.length);
    setImportSkipped([]);
    const skipped = [];
    const refused = { duplicates: 0, removed: 0 };
    let kept = 0;
    let shrunk = 0;
    try {
      for (let at = 0; at < pictures.length; at += IMPORT_BATCH) {
        if (importCancelRef.current) break;
        const batch = [];
        for (const file of pictures.slice(at, at + IMPORT_BATCH)) {
          const looksLikeImage =
            file.type.startsWith("image/") ||
            (!file.type && /\.(jpe?g|png|webp|bmp)$/i.test(file.name));
          if (!looksLikeImage) {
            skipped.push({ name: file.name, why: "non e' un'immagine" });
            continue;
          }
          const result = await fileToJpegUnderCap(file);
          if (!result) {
            skipped.push({
              name: file.name,
              why: "questo browser non la sa leggere",
            });
            continue;
          }
          if (result.shrunk) shrunk += 1;
          batch.push(result.jpeg);
        }
        if (batch.length) {
          const result = await uploadObjectFrames(batch, into, { quiet: true });
          if (result === null) break;
          kept += result.saved;
          refused.duplicates += result.duplicates;
          refused.removed += result.removed;
        }
        setImportDone(Math.min(at + IMPORT_BATCH, pictures.length));
        setImportSkipped([...skipped]);
        if (at + IMPORT_BATCH < pictures.length && !importCancelRef.current) {
          await new Promise((resolve) => setTimeout(resolve, IMPORT_GAP_MS));
        }
      }
      const heic = skipped.filter((item) =>
        /\.hei[cf]$/i.test(item.name),
      ).length;
      toast.success(
        `${kept} foto importate` +
          dropped(refused) +
          (skipped.length ? `, ${skipped.length} saltate` : "") +
          (shrunk ? `, ${shrunk} ridotte per stare nel limite` : "") +
          (importCancelRef.current ? " (interrotto)" : "") +
          (heic
            ? `. ${heic} file HEIC non leggibili da questo browser: sull'iPhone ` +
              "Impostazioni → Fotocamera → Formati → Massima compatibilita'."
            : "."),
        { id: TOAST_IMPORT, duration: 10000 },
      );
      if (into === "with") loadObjectDetail(selectedObject);
    } finally {
      setImporting(false);
    }
  }

  async function runRead(image, mode) {
    setReadBusy(true);
    setReadError(null);
    try {
      const response = await fetch(`${API_BASE}/ocr`, {
        ...SEND_COOKIE,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image, mode }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setReadResult(null);
        setReadError(
          data?.detail ??
            (response.status === 429
              ? "Troppe letture di fila: aspetta un momento."
              : `Lettura non riuscita (${response.status}).`),
        );
        return;
      }
      setReadResult(data);
    } catch (error) {
      console.error("Failed to read text:", error);
      setReadResult(null);
      setReadError("Lettura non riuscita.");
    } finally {
      setReadBusy(false);
    }
  }

  /** A picture from a file goes through the same window as a frame of the
   *  camera; it is read whole, as the other mode would re-read it. */
  async function importTextImage(file) {
    if (!file) return;
    const looksLikeImage =
      file.type.startsWith("image/") ||
      (!file.type && /\.(jpe?g|png|webp|bmp)$/i.test(file.name));
    if (!looksLikeImage) {
      toast.error("Non e' un'immagine.", { id: TOAST_READ });
      return;
    }
    const jpeg = await fileToTextJpeg(file);
    if (!jpeg) {
      toast.error("Questo browser non sa leggere l'immagine.", {
        id: TOAST_READ,
      });
      return;
    }
    setReadFromFile(true);
    setReadMode("scene");
    setReadImage(jpeg);
    setReadResult(null);
    setReadError(null);
    setReadOpen(true);
    runRead(jpeg, "scene");
  }

  /** The other mode re-reads the SAME frozen frame: the paper has not moved
   *  since the button was pressed, and reading again from the live video would
   *  be reading something else. */
  function changeReadMode(mode) {
    setReadMode(mode);
    if (readImage) runRead(readImage, mode);
  }

  // What the reading window shows and « Salva » stores: the corrected words, or
  // the lines as read.
  const readShownText =
    readEdited ?? (readResult?.lines ?? []).map((line) => line.text).join("\n");

  async function saveRead() {
    if (!readResult?.lines?.length || readSaving) return;
    setReadSaving(true);
    try {
      const position = readFromFile ? null : await currentPosition();
      const response = await fetch(`${API_BASE}/ocr/save`, {
        ...SEND_COOKIE,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: readImage,
          mode: readMode,
          lines: readResult.lines.map((line) => ({
            text: line.text,
            box: line.box,
          })),
          text: readShownText,
          position,
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        toast.error(
          data?.detail ?? `Salvataggio non riuscito (${response.status}).`,
          {
            id: TOAST_READ,
          },
        );
        return;
      }
      toast.success(
        position
          ? "Testo salvato con la posizione."
          : "Testo salvato, senza posizione.",
        { id: TOAST_READ },
      );
      setReadOpen(false);
    } catch (error) {
      console.error("Failed to save the read text:", error);
      toast.error("Salvataggio non riuscito.", { id: TOAST_READ });
    } finally {
      setReadSaving(false);
    }
  }

  async function captureObjectFrames(count = CAPTURE_BURST) {
    if (capturing) return;
    setCapturing(true);
    // The panel covers the picture, and the picture is the whole point while
    // this runs: you are aiming at the object for four seconds and cannot aim
    // at what you cannot see. Reopened afterwards only if it was open to begin
    // with, so this never opens a panel the user had deliberately closed.
    const panelWasOpen = piOpen;
    setPiOpen(false);
    try {
      const frames = await captureBurst(
        currentMediaElement,
        count,
        400,
        flashCapture,
      );
      if (!frames.length) {
        toast.error("Nessun fotogramma: non c'e' video sullo schermo.");
        return;
      }
      if ((await uploadObjectFrames(frames, captureInto)) === null) return;
    } catch (error) {
      console.error("Failed to capture frames:", error);
      toast.error("Cattura non riuscita.");
    } finally {
      setCapturing(false);
      if (panelWasOpen) setPiOpen(true);
    }
  }

  /** Extra photographs made out of the boxed ones: same framing, different
   *  light. They become references, so the detector stops depending on the one
   *  lighting the originals were taken in -- see object_augment.py for what
   *  the five transforms are and why none of them moves a pixel. */
  async function augmentObject() {
    if (!selectedObject || augmenting) return;
    setAugmenting(true);
    try {
      const response = await fetch(
        `${API_BASE}/objects/${selectedObject}/augment`,
        {
          ...SEND_COOKIE,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kinds: [] }),
        },
      );
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(
          data?.detail ?? `Generazione non riuscita (${response.status}).`,
        );
        return;
      }
      adoptObjectRecord(data.object);
      toast.success(
        `${data.generated} foto generate da ${data.sources}. ` +
          "Rimisura e riattiva perche' il rilevamento le usi.",
        { duration: 8000 },
      );
    } catch (error) {
      console.error("Failed to augment:", error);
      toast.error("Generazione non riuscita.");
    } finally {
      setAugmenting(false);
    }
  }

  async function clearGeneratedViews() {
    if (!selectedObject || clearingGenerated) return;
    setClearingGenerated(true);
    try {
      const response = await fetch(
        `${API_BASE}/objects/${selectedObject}/generated`,
        {
          ...SEND_COOKIE,
          method: "DELETE",
        },
      );
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(
          data?.detail ?? `Eliminazione non riuscita (${response.status}).`,
        );
        return;
      }
      adoptObjectRecord(data.object);
      toast.success(`${data.removed} foto generate eliminate.`);
    } catch (error) {
      console.error("Failed to clear generated views:", error);
      toast.error("Eliminazione non riuscita.");
    } finally {
      setClearingGenerated(false);
    }
  }

  /** Both endpoints answer with the whole record, and both places that show it
   *  have to move together: the panel reads objectDetail, the picker reads the
   *  list. */
  function adoptObjectRecord(record) {
    if (!record) return;
    setObjectDetail(record);
    setObjectList((list) =>
      list.map((item) => (item.id === record.id ? record : item)),
    );
  }

  // A run files its photographs under the classifier that was selected when it
  // began. Changing it halfway would send the first steps' photographs to a
  // different one than the person was looking at, so the run ends instead.
  useEffect(() => {
    if (!guidedOn) return;
    guidedReset();
    setGuidedOn(false);
    toast(
      "Classificatore cambiato: la procedura guidata e' stata interrotta.",
      { id: TOAST_GUIDED },
    );
  }, [selectedObject]);

  async function loadObjects() {
    try {
      const response = await fetch(`${API_BASE}/objects`, SEND_COOKIE);
      if (!response.ok) return;
      const data = await response.json();
      setObjectList(data.objects ?? []);
    } catch (error) {
      console.error("Failed to load objects:", error);
    }
  }

  // How many references template can afford, and how many photos could be one.
  // The cap comes from the server (object_localisers.MAX_TEMPLATE_REFERENCES)
  // rather than being written twice.
  const templateMax = objectDetail?.template_max ?? 0;
  const boxedCount = (objectDetail?.view_list ?? []).filter(
    (view) => view.box,
  ).length;
  const generatedCount = (objectDetail?.view_list ?? []).filter(
    (v) => v.generated,
  ).length;
  // What /augment can work FROM: boxed, and not itself generated -- a variant
  // of a variant would apply the same transform twice.
  const augmentSources = (objectDetail?.view_list ?? []).filter(
    (v) => v.box && !v.generated,
  ).length;

  /** Toggles one photo in the local choice. Order is tap order, which is what
   *  the numbers show; the cap is refused here as well as on the server, so the
   *  seventh tap says why instead of silently dropping the first. */
  function toggleTemplatePick(view) {
    setTemplatePicks((current) => {
      if (current.includes(view.name)) {
        return current.filter((name) => name !== view.name);
      }
      if (current.length >= templateMax) {
        toast.error(
          `Al massimo ${templateMax} riferimenti per template: togline uno prima.`,
          { id: TOAST_TEMPLATE_PICKS },
        );
        return current;
      }
      return [...current, view.name];
    });
  }

  async function saveTemplatePicks() {
    if (!selectedObject) return;
    setSavingPicks(true);
    try {
      const response = await fetch(
        `${API_BASE}/objects/${selectedObject}/template-refs`,
        {
          method: "PUT",
          headers: jsonHeaders(),
          ...SEND_COOKIE,
          body: JSON.stringify({ views: templatePicks }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        toast.error(
          detailText(data.detail) ?? `Scelta non salvata (${response.status}).`,
          { id: TOAST_TEMPLATE_PICKS },
        );
        return;
      }
      setObjectDetail(data.object ?? null);
      setObjectList(data.objects ?? []);
      toast.success(
        templatePicks.length
          ? `${templatePicks.length} riferimenti scelti per template. ` +
              "Rimisura e riattiva perche' il rilevamento li usi."
          : "Scelta azzerata: template tornera' a usare le prime foto riquadrate.",
        { id: TOAST_TEMPLATE_PICKS },
      );
    } catch {
      toast.error("Server non raggiungibile.", { id: TOAST_TEMPLATE_PICKS });
    } finally {
      setSavingPicks(false);
    }
  }

  /** The selected classifier WITH its saved photographs -- fetched fresh
   * every time, so a photo from an earlier visit, or one just added, is
   * always the one shown rather than a stale local copy. */
  async function loadObjectDetail(id) {
    if (!id) {
      setObjectDetail(null);
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/objects/${id}`, SEND_COOKIE);
      if (!response.ok) {
        setObjectDetail(null);
        return;
      }
      const record = await response.json();
      setObjectDetail(record);
      // The server's choice is the starting point; local edits live in
      // templatePicks until "Salva la scelta" sends them.
      setTemplatePicks(record.template_picks ?? []);
    } catch (error) {
      console.error("Failed to load object detail:", error);
    }
  }

  /** Creates a named classifier and selects it, so the next burst belongs to
   * it without a second decision. */
  async function createObject() {
    const name = newObjectName.trim();
    if (!name) return;
    setCreatingObject(true);
    try {
      const response = await fetch(`${API_BASE}/objects`, {
        ...SEND_COOKIE,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        // The duplicate-name refusal says which name, so it is shown as it
        // came rather than replaced with something vaguer.
        toast.error(
          data.detail ?? `Creazione non riuscita (${response.status}).`,
        );
        return;
      }
      setObjectList(data.objects ?? []);
      setSelectedObject(data.object.id);
      setNewObjectOpen(false);
      setNewObjectName("");
      setModeAskOpen(true);
      toast.success(`Classificatore « ${data.object.name} » creato.`);
    } catch (error) {
      console.error("Failed to create the object:", error);
      toast.error("Creazione non riuscita.");
    } finally {
      setCreatingObject(false);
    }
  }

  /** Removes a photo from the classifier currently open. Administrators
   * only, server-side -- see the comment on the delete route in
   * server_fastapi.py: gathering is everyone's job, undoing it is not. */
  async function deleteObjectView(view) {
    // in_detector means the live detector actually depends on this one right
    // now (see objects.py's _intact_reference_view_names) -- deleting it
    // silently used to be exactly the bug reported as "why do I keep having
    // to re-run Misura": nothing told the admin this photo was special.
    if (
      view.in_detector &&
      !window.confirm(
        "Questa foto e' usata dal rilevamento attivo. Eliminarla lo " +
          "disattiva (o lo rende meno preciso, se restano altre foto " +
          "di riferimento). Continuare?",
      )
    ) {
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/objects/views/${view.name}`, {
        method: "DELETE",
        ...SEND_COOKIE,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        toast.error(
          detail.detail ?? `Eliminazione non riuscita (${response.status}).`,
        );
        return;
      }
      const data = await response.json();
      setObjectList(data.objects ?? []);
      // Refetched rather than filtered out locally: a deleted reference can
      // change objectDetail.detector and every other photo's in_detector,
      // not just remove one row.
      await loadObjectDetail(selectedObject);
      toast.success("Foto eliminata.");
    } catch (error) {
      console.error("Failed to delete the view:", error);
      toast.error("Server non raggiungibile.");
    }
  }

  /** Deletes a whole classifier and every photo it holds. Irreversible, so a
   * confirmation comes first, same as the admin page's own delete button. */
  async function deleteClassifier(item) {
    if (
      !window.confirm(
        `Eliminare « ${item.name} » e tutte le sue ${item.views} foto?`,
      )
    )
      return;
    try {
      const response = await fetch(`${API_BASE}/objects/${item.id}`, {
        method: "DELETE",
        ...SEND_COOKIE,
      });
      if (!response.ok) {
        toast.error(`Eliminazione non riuscita (${response.status}).`);
        return;
      }
      const data = await response.json();
      setObjectList(data.objects ?? []);
      if (selectedObject === item.id) {
        setSelectedObject(null);
        setObjectDetail(null);
      }
      toast.success(`« ${item.name} » eliminato.`);
    } catch (error) {
      console.error("Failed to delete the classifier:", error);
      toast.error("Server non raggiungibile.");
    }
  }

  /** Stores the box drawn on one already-saved photo. */
  async function saveViewBox() {
    if (!editingView || !referenceBox) return;
    setSavingBox(true);
    try {
      const response = await fetch(
        `${API_BASE}/objects/views/${editingView}/box`,
        {
          ...SEND_COOKIE,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(referenceBox),
        },
      );
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        toast.error(
          detail.detail ?? `Salvataggio non riuscito (${response.status}).`,
        );
        return;
      }
      toast.success("Riquadro salvato.");
      setEditingView(null);
      setReferenceBox(null);
      loadObjectDetail(selectedObject);
    } catch (error) {
      console.error("Failed to save the box:", error);
      toast.error("Salvataggio non riuscito.");
    } finally {
      setSavingBox(false);
    }
  }

  /** Runs the comparison on the server and shows what came back. */
  async function measureObject(objectIdOverride) {
    const objectId = objectIdOverride ?? selectedObject;
    if (!objectId) return;
    setMeasuring(true);
    try {
      const response = await fetch(`${API_BASE}/objects/measure`, {
        ...SEND_COOKIE,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ object_id: objectId }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        toast.error(
          detail.detail ?? `Misura non riuscita (${response.status}).`,
        );
        return;
      }
      setMeasurement(await response.json());
    } catch (error) {
      console.error("Failed to measure:", error);
      toast.error("Misura non riuscita.");
    } finally {
      setMeasuring(false);
    }
  }

  /** Turns one Misura row into the thing live detection trusts. The server
   * re-runs that one method itself rather than taking the numbers already
   * on screen -- see the endpoint's own comment -- so this can still fail
   * if something changed between measuring and activating. */
  async function activateClassifier(method) {
    if (!selectedObject) return;
    setActivatingMethod(method);
    try {
      const response = await fetch(
        `${API_BASE}/objects/${selectedObject}/activate`,
        {
          ...SEND_COOKIE,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method }),
        },
      );
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        toast.error(
          detail.detail ?? `Attivazione non riuscita (${response.status}).`,
        );
        return;
      }
      const data = await response.json();
      setObjectList(data.objects ?? []);
      setObjectDetail(data.object ?? null);
      const references = data.object?.detector?.references ?? 1;
      toast.success(
        `« ${data.object.name} » ora si puo' scegliere in Detect ` +
          `(${references} foto di riferimento).`,
      );
    } catch (error) {
      console.error("Failed to activate the classifier:", error);
      toast.error("Attivazione non riuscita.");
    } finally {
      setActivatingMethod(null);
    }
  }

  async function loadDetectionClasses() {
    try {
      const response = await fetch(
        `${API_BASE}/detection_classes`,
        SEND_COOKIE,
      );
      const data = await response.json();
      // Italian labels; fall back to the English ones if the backend is older.
      setCocoClasses(data.classes_it ?? data.classes);
      // Never the Italian ones: this is what detections are matched against.
      setCocoNames(data.classes ?? {});
    } catch (error) {
      console.error("Failed to load detection classes:", error);
    }
  }

  // Scan once automatically on load; the "Scan for cameras" button lets
  // you re-run it later (e.g. after plugging in a different camera).
  useEffect(() => {
    scanUsbDevices();
  }, []);

  // Load the YOLO class list once so the detection picker can label options.
  // (The effect callback itself can't be async -- it must return a cleanup
  // function or nothing -- so it calls the async helper above.)
  useEffect(() => {
    loadDetectionClasses();
    loadObjects();
  }, []);

  // Refetched every time a different classifier is chosen (and after every
  // capture/box/delete on it), so the gallery below always shows what the
  // server actually has, not a locally-kept guess.
  useEffect(() => {
    loadObjectDetail(selectedObject);
  }, [selectedObject]);

  useEffect(() => () => clearTimeout(captureFlashTimeout.current), []);

  // Heartbeat. One round trip registers this device, brings back the device
  // list, AND brings back the state that lives on the server -- which camera
  // is selected and what is being detected.
  //
  // Following the server on those is the point. They were per-page state
  // before, so nothing told a page that another device had changed them: a new
  // detection class picked on the phone left the PC detecting the old one, and
  // a page opening up posted its own default and cut off whoever was sharing.
  useEffect(() => {
    let cancelled = false;
    async function beat() {
      // Captured before the request as well as after it: a heartbeat that
      // overlapped a local switch carries the state from BEFORE that switch,
      // and applying it would flip the interface back to the camera the user
      // just moved away from.
      const wasSwitching = switchingRef.current;
      try {
        const response = await fetch(`${API_BASE}/presence`, {
          method: "POST",
          headers: jsonHeaders(),
          ...SEND_COOKIE,
          // upload_ms only means anything from the device that is publishing;
          // every other page sends null and the server ignores it. It is sent
          // here rather than on its own request so that no extra round trip is
          // added to a link this is measuring the congestion of.
          body: JSON.stringify({
            client_id: CLIENT_ID,
            label: CLIENT_LABEL,
            upload_ms: uploadDelayRef.current,
          }),
        });
        const data = await response.json();
        if (cancelled) return;
        setDeviceList(data.devices ?? []);
        setPublisherId(data.publisher ?? null);
        setClientIsServer(Boolean(data.client_is_server));
        // An administrator asked THIS device to start sharing, from /admin/.
        // The server says so on exactly one beat and then forgets, so a page
        // that restarts its camera is not told to start over and over from a
        // single click. It also switched the source to "remote" already, which
        // the same answer carries below.
        if (data.share_requested) setSharing(true);
        if (typeof data.server_is_pi === "boolean")
          setServerIsPi(data.server_is_pi);
        // Server-wide, like the source and the detection settings: whoever
        // changed it, every page follows. Adopted on every beat and not only
        // the first, which is what makes two phones agree.
        if (data.video_encoding) setVideoEncoding(data.video_encoding);
        setServerSaving(Boolean(data.server_camera_saving));
        if (typeof data.camera_shared === "boolean")
          setCameraShared(data.camera_shared);
        setPiCameraOn(Boolean(data.server_camera_on));
        setServerActive(data.detection_config?.active !== false);
        // The server's half of the sharing measurements. Absent when nobody is
        // publishing, which is also when the panel that shows it is hidden.
        setServerMeter(data.share_meter ?? null);
        // Absent on a server older than the ping: stays false, and the
        // publisher below simply never pings.
        serverEchoesPingRef.current = Boolean(data.echoes_ping);
        // Another device's camera found something, or somebody deleted a
        // picture: reload the strip. Only on a change, not on every beat.
        if (data.saved) {
          const last = savedSummaryRef.current;
          if (
            !last ||
            last.count !== data.saved.count ||
            last.latest !== data.saved.latest ||
            last.version !== data.saved.version
          ) {
            loadSaved(data.saved);
          }
        }

        // The very first answer is always adopted: `switching` starts true so
        // the spinner is up from first paint, and this is what takes it down.
        // After that each page manages its own source: one client selecting a
        // server camera must not override another client's own camera.
        if (firstBeat.current) {
          if (data.source) setSource(data.source);
        }
        if (!wasSwitching && !switchingRef.current) {
          if (typeof data.device_index === "number")
            setActiveIndex(data.device_index);
        }
        const choice = choiceFromConfig(data.detection_config);
        if (choice !== null) setDetectionChoice(choice);
        // Where detection runs is shared state too -- see locationChoice.
        // Not taken from a face config: that one is always "browser" and
        // would wipe a "server" picked for hands the moment faces were shown.
        // Not from a classifier config either, for the mirror-image reason:
        // that one is always "server", and adopting it would leave every
        // OTHER backend's "Dove rilevare" stuck on "server" the moment
        // anyone picked a classifier, even after switching back to hands.
        const shared = data.detection_config;
        if (
          shared &&
          shared.backend !== "face" &&
          shared.backend !== "classifier" &&
          (shared.location === "browser" || shared.location === "server")
        ) {
          setLocationChoice(shared.location);
          if (
            shared.location === "server" &&
            (shared.num_hands === 1 || shared.num_hands === 2)
          ) {
            setHandCount(String(shared.num_hands));
          }
        }
      } catch {
        // A missed heartbeat is not worth showing: the next one is 5 s away,
        // and the server keeps the device for 20 s.
        if (firstBeat.current && !cancelled) {
          // Same id every time: the heartbeat retries every 5 s, and without
          // it each failure would add another toast to the stack.
          toast.error("Impossibile contattare il server.", {
            id: TOAST_PRESENCE,
          });
        }
      } finally {
        // In `finally`, so a server that does not answer cannot leave the page
        // spinning for ever. `switching` starts true to keep the spinner up
        // from first paint, and nothing else clears it on load now that the
        // mount POST is gone.
        if (firstBeat.current && !cancelled) {
          firstBeat.current = false;
          setSwitching(false);
        }
      }
    }
    beat();
    const timer = setInterval(beat, PRESENCE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // --- Starting this device's own camera without being asked -------------
  //
  // The catch is that the source is a SERVER-WIDE setting: choosing it here
  // switches every connected page and stops the camera they were watching.
  // These three refusals are therefore absolute, whoever is logged in:
  //
  //   - not the machine running the server, which cannot publish its camera
  //     through the browser anyway;
  //   - nobody else is publishing, so no running share is ever taken over;
  //   - and the device must actually HAVE a camera -- see below.
  //
  // Past those, there are two reasons to do it:
  //
  //   the ROLE -- an operatore's job is to be the camera. That is the whole
  //     distinction between the two roles: an amministratore watches, an
  //     operatore is watched. So an operatore's own camera is what their page
  //     should open on, regardless of what else is connected.
  //   the DEVICE -- a phone (touch-only), whoever is logged in and whatever
  //     else is connected. It used to be only a phone that was the ONLY
  //     device connected, which never fired with the PC's page open too.
  //
  // Once per page load, whatever happens afterwards: a ref, not state, because
  // a second attempt would fight whatever the user chose by hand in between.
  const autoCameraDone = useRef(false);
  useEffect(() => {
    if (autoCameraDone.current) return;
    // Nothing is known until the first heartbeat has answered.
    if (firstBeat.current || switching) return;
    if (clientIsServer) return;
    if (publisherId !== null) return;
    if (source === "remote") return;

    // Every page turns its own camera on when it opens (not shared) -- unless
    // the Pi's camera is already on: that one is not switched off by a page
    // that merely opened.
    if (piCameraOn) return;

    // Claimed BEFORE the await below, so a heartbeat arriving while the device
    // list is being read cannot start this a second time.
    autoCameraDone.current = true;
    (async () => {
      // Check there is a camera before taking the source away from everybody.
      // An operatore logging in on a desktop with no webcam would otherwise
      // stop the Raspberry's camera for every other device and then publish
      // nothing -- the whole system blank, from a page that never asked for
      // anything. enumerateDevices needs no permission to report that a video
      // input EXISTS; only the labels are withheld until permission is given.
      // Silent until now, which was wrong in one of the two cases: a browser
      // with no camera API at all looks identical to a page that simply chose
      // not to start sharing, and the user is left with no camera and no
      // reason. A missing API gets said once; a machine with no webcam stays
      // quiet, because that is ordinary and not a fault.
      if (!navigator.mediaDevices?.enumerateDevices) {
        toast.error(
          window.isSecureContext === false
            ? "La fotocamera richiede HTTPS: apri la pagina con https://."
            : "Questo browser non espone le fotocamere (Tor Browser le " +
                "disattiva): puoi guardare il video, non condividerlo.",
          { id: TOAST_SHARE, duration: Infinity },
        );
        return;
      }
      try {
        const found = await navigator.mediaDevices.enumerateDevices();
        if (!found.some((device) => device.kind === "videoinput")) return;
      } catch {
        // A browser that will not answer is not one to take the source for.
        return;
      }
      selectSource("remote");
    })();
  }, [
    account.is_admin,
    touchOnly,
    clientIsServer,
    publisherId,
    deviceList,
    source,
    switching,
    piCameraOn,
  ]);

  // On the server machine itself the device's own camera is the Pi's: the camera
  // module if there is one, otherwise the first USB webcam, and nothing if
  // neither exists. Once per page load, and not shared.
  const piStartDone = useRef(false);
  useEffect(() => {
    if (piStartDone.current) return;
    if (firstBeat.current || switching || !clientIsServer) return;
    if (usbDevices === null) return; // the scan has not answered yet
    piStartDone.current = true;
    if (source !== "none") return; // already on: leave it
    if (hasPiCamera) {
      selectSource("picamera", undefined, undefined, false);
    } else if (usbDevices.length > 0) {
      selectSource("usb", usbDevices[0], undefined, false);
    }
  }, [clientIsServer, switching, usbDevices, hasPiCamera, source]);

  useEffect(() => {
    const sync = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", sync);
    // visibilitychange alone is not enough on a phone. Coming back to a
    // minimised browser often restores the page from the back/forward cache,
    // which fires `pageshow` and not `visibilitychange`, so pageVisible stayed
    // false and the video was replaced by "Video in pausa" until a reload.
    // `focus` covers desktop window switching for the same reason.
    window.addEventListener("pageshow", sync);
    window.addEventListener("focus", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pageshow", sync);
      window.removeEventListener("focus", sync);
    };
  }, []);

  useEffect(() => {
    // Hidden page: also stop sending. Mobile browsers throttle background
    // timers to roughly once a minute anyway, so continuing would just feed
    // the server a nearly-frozen image while keeping the camera busy.
    if (!capturesOwnCamera || importedVideo || !pageVisible) {
      toast.dismiss(TOAST_SHARE);
      return;
    }

    let stream;
    let ws;
    let intervalId;
    let pingId;
    let cancelled = false;
    let videoElement = null;

    async function run() {
      // Two different faults, and they used to share one message.
      //
      // mediaDevices is missing outside a "secure context" -- plain http://
      // from a phone -- and THAT is what the HTTPS advice is for. But a browser
      // can also withhold it on purpose inside a perfectly secure context: Tor
      // Browser does, for fingerprinting resistance, and the page then told
      // somebody already on https:// to use https://, which cannot help and
      // reads as the app being broken. isSecureContext is what separates them.
      if (!navigator.mediaDevices?.getUserMedia) {
        toast.error(
          window.isSecureContext === false
            ? "La fotocamera richiede HTTPS. Apri la pagina con https:// " +
                "(vedi SSL_CERTFILE in .env) oppure da localhost."
            : "Questo browser non concede l'accesso alla fotocamera, anche su " +
                "https. Tor Browser la disattiva per impostazione predefinita: " +
                "usa un altro browser, o guarda il video senza condividere.",
          { id: TOAST_SHARE, duration: Infinity },
        );
        return;
      }

      // facingMode is a preference, not a requirement: phones pick the rear
      // camera, laptops just use the only one they have.
      stream = await navigator.mediaDevices.getUserMedia({
        // `ideal`, not `exact`: a camera that cannot do this size still opens,
        // at whatever it can manage. Without a width a phone hands back its
        // native maximum -- often 1920x1080 or more -- and every frame of that
        // is then downscaled for the detector and re-encoded for the upload
        // anyway, so the extra pixels are paid for and thrown away.
        video: { facingMode: "environment", width: { ideal: 1280 } },
      });
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      cameraTrackRef.current = stream.getVideoTracks()[0] ?? null;
      // The camera was reopened (sharing turned on or off): keep the zoom.
      if (zoomRef.current != null) applyZoom(zoomRef.current);

      // The <video> rendered above, so the picture on screen and the pixels we
      // detect on are the same frames. Detecting here removes the round trip
      // entirely: frames still go to the server for other viewers, but we no
      // longer wait for it to draw on them and send them back.
      const video = remoteVideoRef.current;
      if (!video) return;
      // Captured for the cleanup below: by the time React runs it, the ref may
      // already point at a different element (or none).
      videoElement = video;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      // Send small, not at the camera's own resolution. A phone hands back
      // 1280x720 or 1920x1080, which at 10 fps is megabytes a second of WiFi
      // uplink -- far more than the link sustains, and the server scales
      // everything down for detection anyway. See UPLOAD_WIDTH above for why
      // the default is 480 and not 640.
      const nativeWidth = video.videoWidth || 640;
      const nativeHeight = video.videoHeight || 480;
      // Re-sized on demand by the upload timer below, so changing the setting
      // does not have to restart the camera. Never scaled UP: a camera already
      // narrower than the target is sent as it is rather than padded out with
      // pixels it does not have.
      const sizeCanvasFor = (targetWidth) => {
        const scale = Math.min(1, targetWidth / nativeWidth);
        const width = Math.round(nativeWidth * scale);
        const height = Math.round(nativeHeight * scale);
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
      };
      const uploadScale = Math.min(1, UPLOAD_WIDTH / nativeWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(nativeWidth * uploadScale);
      canvas.height = Math.round(nativeHeight * uploadScale);
      const ctx = canvas.getContext("2d");

      // Sharing off: camera and detection above keep running, but nothing is
      // uploaded. Gating the socket rather than the camera is what lets this
      // be toggled without the picture even flickering.
      if (!sharing) return;
      setSharePending(true);

      // The id lets the server refuse a second publisher and name the one it
      // has -- a WebSocket cannot send custom headers, so it goes in the URL.
      ws = new WebSocket(
        `${websocketUrl("/camera_feed")}?client=${encodeURIComponent(CLIENT_ID)}`,
      );
      ws.onerror = () =>
        toast.error("Connessione al server fallita (/camera_feed).", {
          id: TOAST_SHARE,
        });
      // Every refusal says why. Silence here is what made sharing look simply
      // broken: the socket closed and nothing on screen changed.
      ws.onclose = (event) => {
        const reason = {
          4400: "Pagina non aggiornata: ricarica con Ctrl+F5.",
          4401: "Sessione scaduta: rientra con il tuo utente.",
          4408:
            "Un altro dispositivo sta gia' condividendo il video. " +
            "Ferma la condivisione la' prima di iniziare qui.",
          4409:
            "Il server non e' impostato su « Fotocamera di questo dispositivo ». " +
            "Riseleziona quella sorgente e riprova.",
          4410: "La condivisione e' stata fermata da un altro dispositivo.",
        }[event.code];
        if (reason) {
          // Drop our own switch: the button must stop claiming we are sharing
          // when the server refused us.
          setSharing(false);
          toast.error(reason, { id: TOAST_SHARE });
        } else if (event.code !== 1000 && event.code !== 1005) {
          setSharing(false);
          toast.error(`Condivisione interrotta (codice ${event.code}).`, {
            id: TOAST_SHARE,
          });
        }
      };
      // --- how far behind the upload is running -------------------------
      //
      // Two parts, and the queue is usually the larger:
      //
      //   the link   -- a short text ping is echoed by the server once a
      //                 second. Both readings are taken on THIS clock, so the
      //                 two machines never have to agree about the time. Half
      //                 the round trip is the one-way link delay.
      //   the queue  -- bytes already handed to the socket but not yet gone,
      //                 divided by the rate they are actually leaving at.
      //                 THIS is what a bigger backlog allowance buys and costs:
      //                 six queued frames are six frames the viewer has not
      //                 seen yet.
      //
      // Reported on the heartbeat so every page, not only this one, can say
      // how old the picture it is looking at really is.
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        if (!event.data.startsWith("ping:")) return;
        const sentAt = Number(event.data.slice(5));
        if (Number.isFinite(sentAt)) {
          meterRef.current.linkRttMs = performance.now() - sentAt;
        }
      };
      pingId = setInterval(() => {
        // Checked on every tick, not once when the socket opened: the flag
        // arrives on a heartbeat, which may land after this interval starts.
        // Checking here means a page that connects before the first heartbeat
        // still begins timing the link as soon as it is safe to.
        if (!serverEchoesPingRef.current) return;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(`ping:${performance.now()}`);
        }
      }, 1000);

      ws.onopen = () => {
        // We are publishing again: clear whatever refusal was on screen.
        toast.dismiss(TOAST_SHARE);

        // Paced faster than before, and bounded rather than serialised.
        //
        // This used to be setInterval(..., 100): a hard 10 fps ceiling no
        // watcher could beat, whatever the link or the phone could manage, and
        // the single biggest reason a watching device looked jerky.
        //
        // The first attempt at fixing it awaited each encode before starting
        // the next, which MEASURED WORSE -- 8 fps down to 1 -- because
        // canvas.toBlob does its work off this thread, so waiting for it wastes
        // exactly the time it was supposed to overlap. The rate therefore still
        // comes from a timer, now at UPLOAD_MIN_GAP_MS, with a cap on how many
        // encodes may be in flight at once so a phone that cannot keep up piles
        // nothing up.
        //
        // The backpressure guard below is untouched: it is what stopped the
        // holes in the footage, and a faster timer must not be allowed to
        // reintroduce them.
        let inFlight = 0;
        // Frames are numbered as they are taken, and none is sent after a
        // later one. Several encodes run at once and each finishes when it
        // finishes, so without this a late one went out after its successors:
        // measured, the watching page jumped back by up to 31 frames (~1 s),
        // 1-2 times every 15 s, once the detection upload was running too.
        let taken = 0;
        let lastSent = 0;
        let firstSent = false;
        intervalId = setInterval(() => {
          if (cancelled || ws.readyState !== WebSocket.OPEN) return;
          meterRef.current.buffered = ws.bufferedAmount;
          if (
            ws.bufferedAmount > MAX_SOCKET_BACKLOG ||
            inFlight >= UPLOAD_MAX_IN_FLIGHT
          ) {
            meterRef.current.skipped += 1;
            return;
          }
          sizeCanvasFor(UPLOAD_WIDTH);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          meterRef.current.encoded += 1;
          inFlight += 1;
          taken += 1;
          const number = taken;
          canvas.toBlob(
            (blob) => {
              inFlight -= 1;
              if (!blob) return;
              // Checked again: the encode is asynchronous, so the socket may
              // have filled up or closed while it ran.
              if (cancelled || ws.readyState !== WebSocket.OPEN) return;
              if (ws.bufferedAmount > MAX_SOCKET_BACKLOG) {
                meterRef.current.skipped += 1;
                return;
              }
              blob.arrayBuffer().then((buf) => {
                if (cancelled || ws.readyState !== WebSocket.OPEN) return;
                // A later frame already went: this one would be a step back.
                if (number <= lastSent) {
                  meterRef.current.skipped += 1;
                  return;
                }
                lastSent = number;
                meterRef.current.sent += 1;
                meterRef.current.bytesOut += buf.byteLength;
                ws.send(buf);
                // The first frame out: sharing is working.
                if (!firstSent) {
                  firstSent = true;
                  setSharePending(false);
                }
                // Detection takes its frames from here while sharing, instead
                // of encoding its own -- see the /detect_ws effect.
                shareFrameSinkRef.current?.(buf);
              });
            },
            "image/jpeg",
            UPLOAD_QUALITY,
          );
        }, UPLOAD_MIN_GAP_MS);
      };
    }

    run().catch((error) => {
      console.error("Local camera capture failed:", error);
      toast.error(`Fotocamera non disponibile: ${error.message}`, {
        id: TOAST_SHARE,
        duration: Infinity,
      });
    });

    // React runs this when source changes or the component unmounts: stop
    // sending, close the socket, and release the camera (turns the LED off).
    return () => {
      cancelled = true;
      setSharePending(false);
      if (intervalId) clearInterval(intervalId);
      if (pingId) clearInterval(pingId);
      if (ws) ws.close();
      if (stream) stream.getTracks().forEach((t) => t.stop());
      // Detach the ended stream; the element itself belongs to React.
      if (videoElement) videoElement.srcObject = null;
    };
    // React runs the cleanup above whenever `pageVisible` flips to false,
    // which releases the camera (LED off) without any extra code here.
  }, [capturesOwnCamera, importedVideo, pageVisible, sharing]);

  // Detection for this page's OWN camera, done by the server. Frames go to
  // /detect_ws at DETECT_FPS, whether or not this device is sharing; what comes
  // back is the boxes found in each frame, drawn on the overlay canvas, and
  // the pictures the server kept (DetectionStrip). The camera on screen is
  // never touched: no model runs here, which is what kept the live view of a
  // phone lagging behind it.
  useEffect(() => {
    // Neither button pressed means nothing streams at all -- the actual
    // battery saving "detects but does not save" did not give: every frame
    // still went to the server either way. detectOn sends save=1 below;
    // detectOnlyOn sends save=0; this effect does not care which, only that
    // at least one of them is on.
    if (
      (!capturesOwnCamera && !importedVideo && !localCameraPreview) ||
      !pageVisible ||
      !(detectOn || detectOnlyOn || textOn)
    )
      return;
    let cancelled = false;
    let timer = null;
    let retryTimer = null;
    // Working once the server's first answer of the chosen kind arrives.
    detectPendingRef.current = textOn
      ? { text: "Caricamento...", backend: "text" }
      : {
          text: "Avvio rilevamento…",
          backend: detectionConfigFor(
            detectionChoice,
            importedVideo ? detectionLocation : "browser",
            handCount,
          ).backend,
        };
    setDetectPending(detectPendingRef.current);
    // Where this device is, sent to the server with the frames so the
    // pictures it keeps carry it. Asked for here, when detection starts; if it
    // is refused or unavailable, pictures are simply saved without it.
    let position = null;
    let positionWatch = null;
    const sendPosition = () => {
      if (position && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "position", ...position }));
      }
    };
    if (!importedVideo && navigator.geolocation) {
      positionWatch = navigator.geolocation.watchPosition(
        (fix) => {
          position = {
            lat: fix.coords.latitude,
            lon: fix.coords.longitude,
            accuracy: fix.coords.accuracy,
          };
          sendPosition();
        },
        (error) => {
          toast.warning(
            error.code === error.PERMISSION_DENIED
              ? "Posizione non consentita: le immagini vengono salvate senza."
              : "Posizione non disponibile: le immagini vengono salvate senza.",
            { id: TOAST_GPS },
          );
        },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 },
      );
    }
    // Boxes nobody has replaced for this long are wiped, so a server that
    // stops answering does not leave frozen boxes on a moving picture.
    let staleTimer = null;
    const clearBoxes = () => {
      const canvas = overlayRef.current;
      if (canvas)
        canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    };
    // Drawn in the pixels of the frame that was sent (message.w x h), which
    // has the video's aspect ratio, so with the same fit as the video the
    // boxes land on what they were found around. The bitmap is sized to the
    // canvas as SHOWN, as the in-browser loop does, so lines stay sharp.
    const drawBoxes = (message) => {
      const pending = detectPendingRef.current;
      // The text reading's message stays until the server says "ready" (after
      // its second pass), which is when boxes can first appear.
      if (
        pending &&
        message.backend === pending.backend &&
        message.backend !== "text"
      ) {
        detectPendingRef.current = null;
        setDetectPending(null);
      }
      const canvas = overlayRef.current;
      const { w: width, h: height } = message;
      if (!canvas || !width || !height) return;
      const shownPx =
        (canvas.clientWidth || width) * (window.devicePixelRatio || 1);
      const pixelScale = Math.min(
        MAX_OVERLAY_SCALE,
        Math.max(1, shownPx / width),
      );
      const bitmapWidth = Math.round(width * pixelScale);
      const bitmapHeight = Math.round(height * pixelScale);
      if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
        canvas.width = bitmapWidth;
        canvas.height = bitmapHeight;
      }
      canvas.pixelScale = bitmapWidth / width;
      const ctx = canvas.getContext("2d");
      ctx.setTransform(canvas.pixelScale, 0, 0, canvas.pixelScale, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const items = message.items ?? [];
      if (message.backend === "face") {
        drawFaces(ctx, items, null, videoFitRef.current);
      } else {
        drawDetections(ctx, items, videoFitRef.current);
      }
      if (message.backend === "text") textBoxesRef.current = message;
      setDetectionReady(true);
      clearTimeout(staleTimer);
      if (!importedVideo || !importedVideoRef.current?.paused) {
        staleTimer = setTimeout(
          clearBoxes,
          message.backend === "text" ? 2500 : 1000,
        );
      }
    };
    let inFlight = 0;
    const gapMs = 1000 / DETECT_FPS;

    const ws = new WebSocket(
      `${websocketUrl("/detect_ws")}?client=${encodeURIComponent(CLIENT_ID)}` +
        `&save=${detectOn || (textOn && textSave) ? "1" : "0"}` +
        (importedVideo ? "&origin=video" : "") +
        (textOn ? "&mode=text" : ""),
    );
    const canSend = () =>
      !cancelled &&
      ws.readyState === WebSocket.OPEN &&
      ws.bufferedAmount <= MAX_SOCKET_BACKLOG;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    let lastSentAt = 0;
    const sendFrame = (force = false) => {
      const video = importedVideo
        ? importedVideoRef.current
        : localCameraPreview && !capturesOwnCamera
          ? localCameraRef.current
          : remoteVideoRef.current;
      if (!canSend() || !video?.videoWidth || inFlight >= 2) return;
      const now = performance.now();
      const pausedInterval = importedVideo && video.paused;
      const minGap = pausedInterval ? PAUSED_VIDEO_FRAME_GAP_MS : gapMs;
      if (!force && now - lastSentAt < minGap) return;
      lastSentAt = now;
      const frameMeta = importedVideo
        ? {
            type: "frame_meta",
            frame_id: ++importedVideoFrameIdRef.current,
            seek_id: importedVideoSeekIdRef.current,
            media_time: video.currentTime,
            paused: video.paused,
            pause_key: video.paused
              ? `${importedVideoSeekIdRef.current}:${video.currentTime.toFixed(3)}`
              : null,
            save: detectOn || importedVideo || (textOn && textSave),
          }
        : null;
      const scale = Math.min(1, UPLOAD_WIDTH / video.videoWidth);
      const width = Math.round(video.videoWidth * scale);
      const height = Math.round(video.videoHeight * scale);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.drawImage(video, 0, 0, width, height);
      inFlight += 1;
      canvas.toBlob(
        (blob) => {
          inFlight -= 1;
          if (!blob || !canSend()) {
            return;
          }
          blob.arrayBuffer().then((buffer) => {
            if (!canSend()) {
              return;
            }
            if (frameMeta) ws.send(JSON.stringify(frameMeta));
            ws.send(buffer);
          });
        },
        "image/jpeg",
        UPLOAD_QUALITY,
      );
    };

    ws.onopen = () => {
      toast.dismiss(TOAST_DETECT);
      sendPosition();
      if (sharing && !importedVideo) {
        // Sharing already encodes frames: take one of those every gapMs.
        let lastAt = 0;
        shareFrameSinkRef.current = (buffer) => {
          const now = performance.now();
          if (now - lastAt < gapMs || !canSend()) return;
          lastAt = now;
          ws.send(buffer);
        };
        return;
      }
      if (importedVideo) {
        importedVideoFrameRef.current = (seeked = false) => {
          if (seeked && canSend()) {
            ws.send(
              JSON.stringify({
                type: "video_seek",
                seek_id: importedVideoSeekIdRef.current,
              }),
            );
          }
          sendFrame(true);
        };
        sendFrame(true);
      }
      timer = setInterval(() => sendFrame(false), gapMs);
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "boxes") {
        if (importedVideo) {
          const meta = message.frame_meta;
          const video = importedVideoRef.current;
          if (meta) {
            if (meta.seek_id !== importedVideoSeekIdRef.current) {
              sendFrame(true);
              return;
            }
            const frameAgeMs = (video.currentTime - meta.media_time) * 1000;
            if (
              !video.paused &&
              (frameAgeMs < 0 || frameAgeMs > VIDEO_BOX_MAX_AGE_MS)
            )
              return;
          }
        }
        drawBoxes(message);
      } else if (message.type === "saved")
        takeSavedEntries(message.entries ?? [], false);
      else if (message.type === "text_status")
        setTextReading(Boolean(message.reading));
      else if (message.type === "ready") {
        detectPendingRef.current = null;
        setDetectPending(null);
        setDetectionReady(true);
      }
    };
    ws.onclose = (event) => {
      if (cancelled) return;
      clearInterval(timer);
      shareFrameSinkRef.current = null;
      if (event.code === 4401) {
        toast.error("Sessione scaduta: rientra con il tuo utente.", {
          id: TOAST_DETECT,
          duration: Infinity,
        });
        return;
      }
      toast.error("Rilevamento sul server interrotto: riprovo tra poco.", {
        id: TOAST_DETECT,
      });
      // A server restart closes the socket; open a new one rather than
      // leaving this camera undetected until the page is reloaded.
      retryTimer = setTimeout(() => setDetectRetry((n) => n + 1), 3000);
    };

    return () => {
      cancelled = true;
      clearInterval(timer);
      clearTimeout(retryTimer);
      clearTimeout(staleTimer);
      if (positionWatch !== null)
        navigator.geolocation.clearWatch(positionWatch);
      detectPendingRef.current = null;
      setDetectPending(null);
      // "Ferma", the page going to the background, a camera change: no more
      // boxes are coming, so the last ones must not stay on the picture.
      clearBoxes();
      shareFrameSinkRef.current = null;
      importedVideoFrameRef.current = null;
      ws.close();
    };
  }, [
    capturesOwnCamera,
    pageVisible,
    detectRetry,
    detectOn,
    detectOnlyOn,
    textOn,
    textSave,
    sharing,
    importedVideo,
    importedVideoUrl,
    localCameraPreview,
  ]);

  // Avvia on the PI'S webcam: nothing is uploaded -- the frames are the
  // camera's own and never leave the server -- so this socket only carries back
  // "ready" (the first frame was looked at) and "saved" (what was kept). The
  // server runs ONE session for every page that has this open.
  useEffect(() => {
    const serverObserving =
      detectOn || textOn || (detectOnlyOn && detectionLocation === "server");
    if (
      importedVideo ||
      localCameraPreview ||
      !serverCamera ||
      !pageVisible ||
      !serverObserving
    )
      return undefined;
    let cancelled = false;
    let retryTimer = null;
    detectPendingRef.current = textOn
      ? { text: "Caricamento...", backend: "text" }
      : {
          text: "Avvio rilevamento…",
          backend: detectionConfigFor(
            detectionChoice,
            detectionLocation,
            handCount,
          ).backend,
        };
    setDetectPending(detectPendingRef.current);
    const query = textOn
      ? `?mode=text&save=${textSave ? "1" : "0"}`
      : detectOn
        ? ""
        : "?save=0";
    const ws = new WebSocket(websocketUrl("/camera_detect_ws") + query);
    ws.onopen = () => toast.dismiss(TOAST_DETECT);
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "ready") {
        detectPendingRef.current = null;
        setDetectPending(null);
        setDetectionReady(true);
      } else if (message.type === "saved") {
        takeSavedEntries(message.entries ?? [], false);
      } else if (message.type === "boxes") {
        drawTextBoxes(message);
        setDetectionReady(true);
      } else if (message.type === "text_status") {
        setTextReading(Boolean(message.reading));
      }
    };
    ws.onclose = (event) => {
      if (cancelled) return;
      if (event.code === 4409) {
        // The server's webcam is not what is on any more (or the other of
        // Avvia and the text reading is running): nothing left to act on.
        // Switched off quietly -- nothing went wrong.
        setDetectOn(false);
        setTextOn(false);
        return;
      }
      if (event.code === 4401) {
        toast.error("Sessione scaduta: rientra con il tuo utente.", {
          id: TOAST_DETECT,
          duration: Infinity,
        });
        return;
      }
      toast.error("Rilevamento sul server interrotto: riprovo tra poco.", {
        id: TOAST_DETECT,
      });
      retryTimer = setTimeout(() => setDetectRetry((n) => n + 1), 3000);
    };
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      detectPendingRef.current = null;
      setDetectPending(null);
      clearTimeout(textStaleRef.current);
      textBoxesRef.current = null;
      overlayRef.current
        ?.getContext("2d")
        ?.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height);
      ws.close();
    };
  }, [
    serverCamera,
    pageVisible,
    detectRetry,
    detectOn,
    detectOnlyOn,
    detectionLocation,
    textOn,
    textSave,
    importedVideo,
    localCameraPreview,
  ]);

  // Avvia and Osserva are per CAMERA KIND. A button left on from the phone's
  // camera must not silently start SAVING from the Pi's webcam the moment the
  // source changes, so switching kind switches both off.
  const cameraKind = localCameraPreview
    ? "own"
    : capturesOwnCamera
      ? "own"
      : serverCamera
        ? "pi"
        : "other";
  useEffect(() => {
    if (importedVideo) return;
    setDetectionReady(false);
    setDetectOn(false);
    // Osserva starts on whenever there is a camera to observe: this device's
    // own and the Pi's webcam alike -- the objects' or, in text mode, the text's.
    const live = cameraKind === "own" || cameraKind === "pi";
    setDetectOnlyOn(live && !textMode);
    setTextOn(live && textMode);
    setTextSave(false);
  }, [cameraKind, importedVideo]);

  // Tells the server when the Pi's webcam should detect: only while Osserva or
  // Avvia is on. Sent only when what the SERVER reports differs from the
  // buttons, and never before the first answer from the server: until then the
  // page's own idea of the source is a guess, and posting it would switch the
  // camera on by itself.
  useEffect(() => {
    if (
      importedVideo ||
      localCameraPreview ||
      !serverCamera ||
      switching ||
      firstBeat.current
    )
      return;
    if (serverActive === observing) return;
    selectSource(source, activeIndex ?? undefined, { active: observing });
  }, [
    serverCamera,
    switching,
    observing,
    serverActive,
    importedVideo,
    localCameraPreview,
  ]);

  // There is deliberately no "pick a camera on load" effect here any more.
  //
  // It used to POST source=usb, index 0. The camera source is server-global, so
  // every page that opened -- or simply reloaded -- reset it for everybody, and
  // that reset ended any share in progress: /camera_feed's loop stops the
  // moment camera.source is no longer "remote". Sharing looked like it started
  // and then showed nothing, because opening the page on the second device was
  // what killed it.
  //
  // The first heartbeat above now reports what the server is already on, and
  // that is adopted instead. Nothing is posted until a button is pressed.

  // Load whichever model the current choice needs, and tear it down when
  // detection moves back to the server.
  useEffect(() => {
    // A classifier never runs in the browser -- the method needs server-side
    // MediaPipe tasks (see classifier_detection.py) -- including on this
    // device's own camera, where detectionLocation stays "browser" for every
    // OTHER backend because DetectSession already detects server-side
    // regardless of this value. Without this guard a classifier choice fell
    // through to the "yolo" default below and tried to load EfficientDet
    // here for nothing.
    if (
      detectionLocation !== "browser" ||
      !detectsHere ||
      importedVideo ||
      localCameraPreview ||
      isClassifierChoice(detectionChoice)
    ) {
      detectorRef.current?.close();
      detectorRef.current = null;
      setDetectorStatus("");
      return;
    }
    let cancelled = false;
    let backend = "yolo";
    if (detectionChoice === FACE_OPTION) backend = "face";
    else if (detectionChoice === HAND_OPTION) backend = "mediapipe";
    setDetectorStatus(
      {
        face: "Caricamento modello volti (~230 KB)...",
        mediapipe: "Caricamento modello mani (~8 MB)...",
        yolo: "Caricamento modello oggetti (~14 MB)...",
      }[backend],
    );
    const detector = detectorRef.current ?? new BrowserDetector();
    detectorRef.current = detector;
    detector
      .ensureLoaded(backend, cocoNames)
      .then(() => {
        if (!cancelled) setDetectorStatus("");
      })
      .catch((error) => {
        console.error("Detector failed to load:", error);
        if (!cancelled) {
          // The video keeps playing; only the boxes are missing. Say so rather
          // than leaving a silently empty overlay.
          setDetectorStatus(
            `Rilevamento non disponibile su questo dispositivo: ${error.message}`,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    detectionLocation,
    detectionChoice,
    detectsHere,
    importedVideo,
    localCameraPreview,
    cocoNames,
  ]);

  // Pulls the video from the server one frame at a time.
  //
  // Replaces <img src="/video_feed">, an MJPEG stream. MJPEG gives the viewer
  // no way to say "I am behind": the server pushes a frame every 50 ms whether
  // or not this page drew the last one, and the browser renders every frame it
  // receives, in order, never skipping. Frames therefore pile up in buffers and
  // the picture falls permanently behind -- the five-second delay.
  //
  // Here nothing arrives unasked. We request a frame, draw it, and only then
  // request the next, so whatever the camera produced while we were busy is
  // dropped instead of queued. The delay cannot exceed one frame plus one round
  // trip.
  useEffect(() => {
    // Only when the server's stream is what is on screen. A device showing its
    // own camera has a <video> element instead and needs no frames at all.
    if (!showVideo || capturesOwnCamera || localCameraPreview) return;

    const img = videoImgRef.current;
    if (!img) return;

    let ws;
    let closed = false;
    let currentUrl = null;
    // Set while a frame is between "received" and "drawn". Guards against
    // asking for two frames because both onload and a retry fired.
    let awaitingDraw = false;
    // TEMPORARY diagnostic: frames that actually arrived here, per second.
    // The "Diagnostica" panel counts these too, but only during a share; this
    // one also runs while watching the server's own camera.
    let framesThisSecond = 0;
    const fpsTimer = setInterval(() => {
      setVideoFps(framesThisSecond);
      framesThisSecond = 0;
    }, 1000);

    // When "next" was last asked for, so the round trip can be measured. This
    // is the viewer's own loop time -- request to pixels on screen -- not the
    // delay since the phone took the picture; the server reports that one,
    // because only it sees both ends without two clocks having to agree.
    let askedAt = 0;
    // When the bytes for the frame being drawn actually landed. It splits the
    // round trip above into its two halves -- the wait for the server and the
    // browser's own decode -- and they call for opposite fixes, so one number
    // covering both could not tell you which to reach for.
    let arrivedAt = 0;

    const askForNext = () => {
      if (closed || !ws || ws.readyState !== WebSocket.OPEN) return;
      awaitingDraw = false;
      askedAt = performance.now();
      ws.send("next");
    };

    // Fired once the browser has actually decoded and shown the frame. THIS is
    // the acknowledgement: asking here, rather than on arrival, is what keeps
    // the server from running ahead of what the screen can display.
    const onLoad = () => {
      if (watchPendingRef.current) {
        watchPendingRef.current = false;
        setWatchPending(false);
      }
      if (!awaitingDraw) return;
      if (askedAt) {
        const now = performance.now();
        meterRef.current.rttTotal += now - askedAt;
        meterRef.current.rttCount += 1;
        // Split at the moment the bytes arrived. "attesa" is the server and
        // the network; "decodifica" is this browser turning the JPEG into
        // pixels. A long wait and a long decode are different problems.
        if (arrivedAt) {
          meterRef.current.waitTotal += arrivedAt - askedAt;
          meterRef.current.drawTotal += now - arrivedAt;
        }
      }
      meterRef.current.received += 1;
      askForNext();
    };
    // A frame that fails to decode must not stall the stream for ever.
    const onError = () => askForNext();

    img.addEventListener("load", onLoad);
    img.addEventListener("error", onError);

    // The buffer is asked for at connect time, because it sizes a queue the
    // server allocates for this viewer. Changing it re-runs this effect, which
    // opens a new socket with the new size -- a second of black while it
    // reconnects, which is the honest cost of changing it.
    ws = new WebSocket(
      `${websocketUrl("/video_ws")}?buffer=${encodeURIComponent(bufferSeconds)}` +
        `&client=${encodeURIComponent(CLIENT_ID)}`,
    );
    ws.binaryType = "blob";
    ws.onopen = () => {
      // Takes down the VIDEO STREAM's toast and nothing else. This used to
      // clear the one shared warning box, which wiped the "La Pi Camera non ha
      // prodotto immagini" message /source had just put up: switching source
      // re-runs this effect, and the socket opens perfectly well when it is
      // the camera behind it that is dead. Separate toast ids make that
      // mistake impossible now -- TOAST_SOURCE is not ours to dismiss.
      toast.dismiss(TOAST_VIDEO);
      askForNext();
    };
    ws.onmessage = (event) => {
      if (closed) return;
      // While the camera has produced no new frame, the server sends a short
      // TEXT message every few seconds -- not a picture, just a poke to find
      // out whether this socket is still alive, so a viewer that vanished off
      // the network stops holding one of the four viewer slots for ever.
      // Everything else here arrives as a Blob (binaryType above), so anything
      // that is a string is one of those pokes and must not reach the <img>.
      //
      // Answering it is the point. A page the phone has minimised is FROZEN by
      // the browser: this handler stops running, the server stops hearing from
      // us, and it gives our viewer slot to somebody else instead of holding
      // it until the connection eventually rots. A page still on screen keeps
      // answering and keeps its slot.
      if (typeof event.data === "string") {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send("alive");
        return;
      }
      meterRef.current.bytesIn += event.data.size ?? 0;
      framesThisSecond += 1; // TEMPORARY, see fpsTimer
      arrivedAt = performance.now();
      const next = URL.createObjectURL(event.data);
      // Revoke the PREVIOUS url, never the one just assigned: releasing the
      // current frame's blob would blank the picture. The browser keeps the
      // decoded image, so revoking after the swap is safe.
      const previous = currentUrl;
      currentUrl = next;
      awaitingDraw = true;
      img.src = next;
      if (previous) URL.revokeObjectURL(previous);
    };
    ws.onclose = (event) => {
      if (closed) return;
      if (event.code === 4401) {
        // Nothing will fix itself here until you log in again, so this one
        // stays up instead of fading after a few seconds.
        toast.error("Sessione scaduta: rientra con il tuo utente.", {
          id: TOAST_VIDEO,
          duration: Infinity,
        });
      } else if (event.code === 4503) {
        toast.error("Troppi dispositivi stanno guardando il video.", {
          id: TOAST_VIDEO,
        });
      } else if (event.code !== 1000 && event.code !== 1005) {
        toast.error(`Video interrotto (codice ${event.code}).`, {
          id: TOAST_VIDEO,
        });
      }
    };

    return () => {
      closed = true;
      clearInterval(fpsTimer); // TEMPORARY, see fpsTimer
      setVideoFps(null);
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onError);
      if (ws) ws.close();
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [showVideo, capturesOwnCamera, source, bufferSeconds]);

  // Watching another device's camera: a spinner until its first frame is on
  // screen (cleared in onLoad above).
  useEffect(() => {
    const waiting = someoneElseShares && showVideo && !capturesOwnCamera;
    watchPendingRef.current = waiting;
    setWatchPending(waiting);
  }, [someoneElseShares, showVideo, capturesOwnCamera, source, bufferSeconds]);

  // Each spinner gives up after PENDING_TIMEOUT_MS and says what did not start.
  useEffect(() => {
    if (!detectPending) return;
    const timer = setTimeout(() => {
      detectPendingRef.current = null;
      setDetectPending(null);
      toast.error("Il rilevamento non risponde.", { id: TOAST_DETECT });
    }, PENDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [detectPending]);
  useEffect(() => {
    if (!sharePending) return;
    const timer = setTimeout(() => {
      setSharePending(false);
      toast.error("La condivisione non parte.", { id: TOAST_SHARE });
    }, PENDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [sharePending]);
  useEffect(() => {
    if (!watchPending) return;
    const timer = setTimeout(() => {
      watchPendingRef.current = false;
      setWatchPending(false);
      toast.error("Il video non arriva.", { id: TOAST_VIDEO });
    }, PENDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [watchPending]);

  // The detection loop. Draws the current frame onto the overlay canvas, runs
  // the detector on it, draws the result, and reports it to the server.
  useEffect(() => {
    // Same reason as the model-loading effect above: a classifier never runs
    // in the browser, on this device's own camera included.
    if (
      detectionLocation !== "browser" ||
      !pageVisible ||
      !detectsHere ||
      importedVideo ||
      isClassifierChoice(detectionChoice)
    )
      return;
    let frameRequest = 0;
    let running = true;
    let busy = false;
    reporterRef.current =
      reporterRef.current ?? new DetectionReporter(postDetections);
    // Carries num_hands, which the worker applies with each frame.
    const config = detectionConfigFor(detectionChoice, "browser", handCount);
    if (!detectionReady) {
      detectPendingRef.current = {
        text: "Avvio rilevamento…",
        backend: config.backend,
      };
      setDetectPending(detectPendingRef.current);
    }
    const detectWidth =
      config.backend === "face" ? FACE_DETECT_WIDTH : DETECT_WIDTH;

    // One scratch canvas for the whole loop, reused every frame: allocating a
    // new one per frame would cost more than the downscale it exists for.
    // TEMPORARY diagnostic for the skeleton's lag on a phone -- remove once it
    // has been read. Collects, per detection: the model's own time (measured
    // in the worker), the whole round trip from copying the frame to the
    // answer arriving, and the drawing after it; shows their medians twice a
    // second, with how many detections a second that came to.
    const timingSamples = [];
    let timingShownAt = performance.now();
    function recordTiming(startedAt, detectedAt, drawnAt) {
      timingSamples.push({
        model: detectorRef.current?.lastModelMs ?? null,
        roundTrip: detectedAt - startedAt,
        draw: drawnAt - detectedAt,
      });
      const now = performance.now();
      if (now - timingShownAt < 500) return;
      const median = (key) => {
        const values = timingSamples
          .map((sample) => sample[key])
          .filter((value) => value != null)
          .sort((a, b) => a - b);
        return values.length
          ? Math.round(values[Math.floor(values.length / 2)])
          : null;
      };
      setDetectTiming({
        delegate: detectorRef.current?.lastDelegate ?? null,
        renderer: detectorRef.current?.renderer ?? null,
        model: median("model"),
        roundTrip: median("roundTrip"),
        draw: median("draw"),
        perSecond:
          Math.round(
            (timingSamples.length / ((now - timingShownAt) / 1000)) * 10,
          ) / 10,
      });
      timingSamples.length = 0;
      timingShownAt = now;
    }

    const small = document.createElement("canvas");
    const smallCtx = small.getContext("2d", { willReadFrequently: false });

    async function tick(timestamp) {
      if (!running) return;
      const canvas = overlayRef.current;
      // For "remote" the page has the camera itself, so detect straight from
      // the <video> and skip the round trip through the Pi entirely.
      const media = capturesOwnCamera
        ? remoteVideoRef.current
        : videoImgRef.current;
      const sourceWidth = media?.videoWidth || media?.naturalWidth || 0;
      const sourceHeight = media?.videoHeight || media?.naturalHeight || 0;
      // Never scale UP: a source already smaller than the detect width is used
      // as it is, rather than being blown up into more pixels than it has.
      const scale = Math.min(1, detectWidth / (sourceWidth || 1));
      const width = Math.round(sourceWidth * scale);
      const height = Math.round(sourceHeight * scale);

      if (canvas && media && width && height && !busy) {
        busy = true;
        // The bitmap is made as large as the overlay is SHOWN, in device
        // pixels, and a transform maps the detector's coordinates onto it.
        // It used to be exactly the detector's size -- 480 or 640 px across
        // -- and the browser stretched it to fill the picture, so on a big or
        // high-density screen every line and caption was blown up and blurred.
        // Drawing code is unchanged: it still works in detector pixels, and
        // drawingSize() in hittest.js gives it that size back for taps and
        // caption sizing.
        const shownPx =
          (canvas.clientWidth || width) * (window.devicePixelRatio || 1);
        const bitmapWidth = Math.round(
          width * Math.min(MAX_OVERLAY_SCALE, Math.max(1, shownPx / width)),
        );
        const pixelScale = bitmapWidth / width;
        const bitmapHeight = Math.round(height * pixelScale);
        if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
          canvas.width = bitmapWidth;
          canvas.height = bitmapHeight;
        }
        canvas.pixelScale = pixelScale;
        if (small.width !== width || small.height !== height) {
          small.width = width;
          small.height = height;
        }
        const ctx = canvas.getContext("2d");
        try {
          // The one copy this loop makes, and the reason it is worth it: the
          // detector gets DETECT_WIDTH pixels instead of the camera's full
          // frame. Nothing is copied into the VISIBLE canvas -- the picture on
          // screen is still the <img>/<video> underneath it.
          const startedAt = performance.now(); // TEMPORARY, see recordTiming
          smallCtx.drawImage(media, 0, 0, width, height);
          const detections = await detectorRef.current?.detect(
            small,
            width,
            height,
            config,
            timestamp,
          );
          if (detections !== undefined && !detectionReady) {
            setDetectionReady(true);
            detectPendingRef.current = null;
            setDetectPending(null);
          }
          const detectedAt = performance.now(); // TEMPORARY, see recordTiming
          // Cleared HERE, with the new marks already in hand -- not before the
          // await. Clearing first left this layer empty for the whole detection
          // and drew on it for one frame at the end: measured at 2828 ms blank
          // against 116 ms of marks, so the boxes were on screen 4% of the time.
          // That is what made them look like they blink rather than lag. The
          // old marks now stay up until the new ones replace them, which is
          // also what the local hand-mouse program does by drawing onto the
          // frame it analysed.
          // Set on every pass: resizing the canvas above resets it.
          ctx.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);
          ctx.clearRect(0, 0, width, height);
          if (detections) {
            if (config.backend === "face") {
              const largeEnough = detections.filter(
                (detection) =>
                  detection.bbox[2] - detection.bbox[0] >= enrolMinFacePx,
              );
              // Give each face a stable id so a tap keeps pointing at the same
              // person while they move, and so the identity fetched once can be
              // reused instead of asking the server again every frame.
              const updated = trackerRef.current.update(largeEnough);
              // A track that just came back carries an identity from before it
              // vanished. It is shown at once -- that is the point of reviving
              // it -- but it is also re-checked at once, by clearing when it
              // was last asked about, so a face that changed while the box was
              // gone is corrected in about a second.
              for (const detection of updated) {
                if (!detection.revived) continue;
                const meta = recogMetaRef.current.get(detection.trackId);
                if (meta) meta.lastAt = 0;
              }
              const tracked = updated
                // A box seen in a single frame is not a face yet. Filtering
                // here means the whole app -- drawing, tapping, recognising,
                // saving -- only ever sees confirmed ones.
                .filter((detection) => detection.confirmed);
              faceDetectionsRef.current = tracked;
              faceDetectWidthRef.current = width;
              // Ask about a new face in the frame it becomes a face, rather
              // than waiting for the scheduler's next turn. That wait was up
              // to 200 ms of doing nothing at all, on the one occasion the
              // user is actually watching for an answer.
              if (!recogniseBusyRef.current) {
                const fresh = tracked.find((d) => {
                  if (recogMetaRef.current.has(d.trackId)) return false;
                  // Same floor the scheduler applies: a face too far away to
                  // identify would only come back "too_small", and asking
                  // costs a round trip somebody else is waiting for. A width
                  // of 0 means unmeasurable, which is not the same as tiny.
                  const px = sourceFaceWidth(d);
                  return !px || px >= minFacePxRef.current;
                });
                if (fresh) recogniseTrack(fresh);
              }
              // The tile sweep is the expensive path and it runs on this
              // thread; while an answer is on its way, the thread's job is to
              // be free to receive it.
              if (detectorRef.current) {
                detectorRef.current.deferSweep = recogniseBusyRef.current;
              }
              // ...and only confirmed boxes are worth re-finding next frame,
              // which is what stops a false positive from feeding itself.
              detectorRef.current?.setTrackedRegions(
                tracked.map((d) => d.bbox),
              );
              // Via the ref, not the state: this runs on requestAnimationFrame
              // and the loop is created once, so the state would stay frozen
              // at whatever the fit was when sharing started.
              drawFaces(
                ctx,
                tracked,
                selectedTrackRef.current,
                videoFitRef.current,
              );
            } else {
              drawDetections(ctx, detections, videoFitRef.current);
            }
            reporterRef.current.report(source, detections);
          }
          recordTiming(startedAt, detectedAt, performance.now()); // TEMPORARY
        } catch (error) {
          // One bad frame must not kill the loop -- MediaPipe throws if the
          // <img> is mid-refresh, which happens routinely on an MJPEG stream.
          console.debug("detect skipped a frame:", error);
        }
        busy = false;
      }
      frameRequest = requestAnimationFrame(tick);
    }

    frameRequest = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(frameRequest);
      reporterRef.current?.reset();
      setDetectTiming(null); // TEMPORARY, see recordTiming
      // Wipe the layer on the way out. The marks now survive until new ones
      // replace them, which is the point -- but when this loop STOPS there are
      // no new ones coming, so without this the last boxes would sit frozen on
      // the picture after switching what is detected, after the panel is
      // closed, or after sharing ends.
      const leftover = overlayRef.current;
      if (leftover) {
        leftover
          .getContext("2d")
          ?.clearRect(0, 0, leftover.width, leftover.height);
      }
    };
  }, [
    detectionLocation,
    detectionChoice,
    handCount,
    enrolMinFacePx,
    source,
    importedVideo,
    capturesOwnCamera,
    detectsHere,
    pageVisible,
  ]);

  /** Everyone enrolled, plus the judge colours and size limits. Kept in one
   * place so the box on the video, the traffic light and the "add to an
   * existing person" list all agree with the server rather than each other. */
  async function loadFaces() {
    try {
      const response = await fetch(`${API_BASE}/faces`, SEND_COOKIE);
      if (!response.ok) return;
      const data = await response.json();
      setFaceJudges(data.judges ?? null);
      setDefaultJudge(data.default_judge ?? "accettabile");
      setPeople(data.people ?? []);
      if (data.enrol_min_face_px) setEnrolMinFacePx(data.enrol_min_face_px);
      if (data.min_face_px) minFacePxRef.current = data.min_face_px;
      if (data.models_ready === false) {
        toast.error(
          "I modelli di riconoscimento non sono ancora sul server: i volti " +
            "vengono trovati ma non identificati.",
          { id: TOAST_FACES },
        );
      }
      return data;
    } catch {
      // The heartbeat will bring the page back; nothing here is worth a toast.
      return null;
    }
  }

  // --- The strip of what the server found (DetectionStrip) ----------------

  // The list as last rendered, for counting inside the handlers below.
  const savedEntriesRef = useRef([]);
  useEffect(() => {
    savedEntriesRef.current = savedEntries;
  }, [savedEntries]);
  // The people list as it is now, for takeSavedEntries: /detect_ws calls it
  // from a closure made when the socket opened, whose `people` is stale.
  const peopleRef = useRef([]);
  peopleRef.current = people;

  // A recognised face's caption is written in that person's semaphore colour,
  // from the list of people. A name whose person is not in the list yet --
  // saved a moment ago, or on another device -- reloads it, once per person.
  useEffect(() => {
    const missing = savedEntries.filter(
      (entry) =>
        entry.person_id &&
        !people.some((person) => person.id === entry.person_id) &&
        !peopleAskedRef.current.has(entry.person_id),
    );
    if (!missing.length) return;
    missing.forEach((entry) => peopleAskedRef.current.add(entry.person_id));
    loadFaces();
  }, [savedEntries, people]);

  function savedColour(entry) {
    return (
      people.find((person) => person.id === entry.person_id)?.color ?? null
    );
  }

  /** Puts entries into the strip -- the whole list (`replace`) or a few new
   * ones from /detect_ws -- and toasts the ones this page had not seen. */
  function takeSavedEntries(incoming, replace) {
    const seen = seenSavedRef.current;
    const fresh = seen ? incoming.filter((entry) => !seen.has(entry.id)) : [];
    seenSavedRef.current = new Set([
      ...(seen ?? []),
      ...incoming.map((entry) => entry.id),
    ]);
    const current = savedEntriesRef.current;
    const next = replace
      ? incoming
      : [
          ...incoming.filter(
            (entry) => !current.some((old) => old.id === entry.id),
          ),
          ...current,
        ];
    savedEntriesRef.current = next;
    setSavedEntries(next);
    if (fresh.length) {
      // A face's name in its person's semaphore colour, on the same dark
      // background as the strip's captions. A person
      // this page has not loaded yet (saved a moment ago, or on another
      // device) is loaded first, so the toast waits for the list.
      const unloaded = fresh.filter(
        (entry) =>
          entry.person_id &&
          !peopleRef.current.some((person) => person.id === entry.person_id),
      );
      if (unloaded.length) {
        unloaded.forEach((entry) =>
          peopleAskedRef.current.add(entry.person_id),
        );
        loadFaces().then((data) =>
          toastSaved(fresh, data?.people ?? peopleRef.current),
        );
      } else {
        toastSaved(fresh, peopleRef.current);
      }
    }
    // On opening the page, and whenever new pictures arrive while above it.
    if ((fresh.length || !seen) && next.length > SAVED_WARN_ABOVE) {
      toast.warning(
        `Ci sono ${next.length} immagini rilevate salvate: eliminane qualcuna.`,
        { id: TOAST_SAVED_MANY, duration: 10000 },
      );
    }
  }

  function toastSaved(fresh, peopleList) {
    // A recognised person gets a toast of their own, coloured with their
    // semaphore and written in black, which reads best on all three colours
    // (contrast 4.7 to 8.5; white is 2.5 on orange). Its own id, so the next
    // batch of the same person replaces it rather than stacking.
    const recognised = new Map();
    const others = [];
    for (const entry of fresh) {
      // Text somebody chose to read and keep: not something the camera
      // "detected", and the person who saved it was already told, with
      // whether a position went with it.
      if (entry.kind === "text") continue;
      if (entry.kind === "face" && entry.person_id) {
        if (!recognised.has(entry.person_id))
          recognised.set(entry.person_id, entry.label);
        continue;
      }
      const label = entry.kind === "face" ? "volto sconosciuto" : entry.label;
      if (!others.includes(label)) others.push(label);
    }
    for (const [personId, label] of recognised) {
      const colour = peopleList.find((person) => person.id === personId)?.color;
      toast(`Rilevato: ${label}`, {
        id: `${TOAST_SAVED}-${personId}`,
        style: colour
          ? { background: colour, borderColor: colour, color: "black" }
          : undefined,
      });
    }
    // Unknown faces, hands and objects: one ordinary toast, replaced -- a
    // batch is three pictures, not three messages.
    if (others.length)
      toast(`Rilevato: ${others.join(", ")}`, { id: TOAST_SAVED });
  }

  async function loadSaved(summary) {
    try {
      const response = await fetch(`${API_BASE}/detections_saved`, SEND_COOKIE);
      if (!response.ok) return;
      const data = await response.json();
      // Recorded only once the list is in hand, so a failed load is retried
      // on the next beat instead of being taken as done.
      savedSummaryRef.current = summary;
      takeSavedEntries(data.entries ?? [], true);
    } catch {
      // The next heartbeat tries again.
    }
  }

  /** Stores a corrected text of a saved read. True when it was kept. */
  async function editSavedText(entry, text) {
    try {
      const response = await fetch(
        `${API_BASE}/detections_saved/${entry.id}/text`,
        {
          ...SEND_COOKIE,
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        toast.error(
          data?.detail ?? `Correzione non riuscita (${response.status}).`,
          {
            id: TOAST_SAVED,
          },
        );
        return false;
      }
      const { entry: updated } = await response.json();
      const next = savedEntriesRef.current.map((old) =>
        old.id === updated.id ? updated : old,
      );
      savedEntriesRef.current = next;
      setSavedEntries(next);
      if (enlargedEntry?.id === updated.id) setEnlargedEntry(updated);
      toast.success("Testo corretto.", { id: TOAST_SAVED });
      return true;
    } catch {
      toast.error("Server non raggiungibile.", { id: TOAST_SAVED });
      return false;
    }
  }

  async function deleteSaved(entry) {
    try {
      const response = await fetch(`${API_BASE}/detections_saved/${entry.id}`, {
        method: "DELETE",
        ...SEND_COOKIE,
      });
      // 404: somebody else deleted it first, which is the same outcome.
      if (!response.ok && response.status !== 404) {
        toast.error("Eliminazione non riuscita.", { id: TOAST_SAVED });
        return;
      }
    } catch {
      toast.error("Server non raggiungibile.", { id: TOAST_SAVED });
      return;
    }
    const next = savedEntriesRef.current.filter((old) => old.id !== entry.id);
    savedEntriesRef.current = next;
    setSavedEntries(next);
    if (enlargedEntry?.id === entry.id) setEnlargedEntry(null);
  }

  /** The camera's zoom range, or null where the phone/browser offers none. */
  function zoomRange() {
    const track = cameraTrackRef.current;
    const range = track?.getCapabilities?.().zoom;
    return range && range.max > range.min ? range : null;
  }

  function applyZoom(value) {
    const track = cameraTrackRef.current;
    if (!track || track.readyState !== "live") return;
    track.applyConstraints({ advanced: [{ zoom: value }] }).catch(() => {
      // Refused by this camera: the picture simply stays as it is.
    });
  }

  // Pinch on the video. Throttled to one request per animation frame: a
  // finger moves far faster than a camera can change its zoom.
  function handlePinchStart(event) {
    if (event.touches.length !== 2) return;
    const range = zoomRange();
    if (!range) return;
    const [a, b] = event.touches;
    pinchRef.current = {
      distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
      zoom:
        zoomRef.current ??
        cameraTrackRef.current.getSettings?.().zoom ??
        range.min,
      range,
      frame: null,
    };
    clearTimeout(zoomLabelTimerRef.current);
  }

  function handlePinchMove(event) {
    const pinch = pinchRef.current;
    if (!pinch || event.touches.length !== 2) return;
    const [a, b] = event.touches;
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const { min, max, step } = pinch.range;
    let value = Math.min(
      max,
      Math.max(min, pinch.zoom * (distance / pinch.distance)),
    );
    if (step) value = Math.round(value / step) * step;
    zoomRef.current = value;
    setZoomLabel(`${value.toFixed(1)}×`);
    if (pinch.frame == null) {
      pinch.frame = requestAnimationFrame(() => {
        pinch.frame = null;
        applyZoom(zoomRef.current);
      });
    }
  }

  function handlePinchEnd(event) {
    if (!pinchRef.current || event.touches.length >= 2) return;
    pinchRef.current = null;
    applyZoom(zoomRef.current);
    clearTimeout(zoomLabelTimerRef.current);
    zoomLabelTimerRef.current = setTimeout(() => setZoomLabel(null), 1000);
  }

  /** "Svuota": deletes from the server every picture created up to `before`. */
  async function clearSaved(before) {
    try {
      const response = await fetch(
        `${API_BASE}/detections_saved?before=${before}`,
        {
          method: "DELETE",
          ...SEND_COOKIE,
        },
      );
      if (!response.ok) {
        toast.error("Eliminazione non riuscita.", { id: TOAST_SAVED });
        return;
      }
    } catch {
      toast.error("Server non raggiungibile.", { id: TOAST_SAVED });
      return;
    }
    const next = savedEntriesRef.current.filter((old) => old.created > before);
    savedEntriesRef.current = next;
    setSavedEntries(next);
    toast.dismiss(TOAST_SAVED_MANY);
  }

  /** Adds a strip picture of a classifier match as one more training view of
   * the SAME classifier -- the object equivalent of "Aggiungi a questa
   * persona" for a recognised face. Only offered when the entry's box carries
   * an object_id (see _save() in server_fastapi.py): a plain YOLO class has
   * none, because there is no classifier to reinforce. */
  async function addSavedToClassifier(entry, objectIdOverride) {
    // The picker's choice wins; falling back to the classifier that matched
    // keeps the one-press case for a hit that already belongs somewhere.
    const objectId = objectIdOverride ?? entry.boxes?.[0]?.object_id;
    if (!objectId || addingToClassifier) return;
    setAddingToClassifier(entry.id);
    try {
      let image;
      try {
        image = await savedBase64(entry);
      } catch {
        toast.error("Immagine non disponibile.", { id: TOAST_CLASSIFIER_ADD });
        return;
      }
      const response = await fetch(`${API_BASE}/objects/${objectId}/views`, {
        method: "POST",
        headers: jsonHeaders(),
        ...SEND_COOKIE,
        body: JSON.stringify({ images: [image] }),
      });
      const data = await response.json();
      if (!response.ok) {
        toast.error(
          detailText(data.detail) ?? "Aggiunta al classificatore non riuscita.",
          {
            id: TOAST_CLASSIFIER_ADD,
          },
        );
        return;
      }
      toast.success(
        `Foto aggiunta a ${data.object.name}. Disegnale il riquadro e rilancia ` +
          `« Misura » perche' il rilevamento la usi.`,
        { id: TOAST_CLASSIFIER_ADD },
      );
      loadObjects();
      deleteSaved(entry); // saved: it leaves the strip
      // The running detector keeps using whatever Misura last measured; a new
      // photo does not change that on its own.
      if (
        isClassifierChoice(detectionChoice) &&
        classifierIdFromChoice(detectionChoice) === objectId
      ) {
        setMisuraHint({ name: data.object.name, objectId });
      }
    } catch {
      toast.error("Server non raggiungibile.", { id: TOAST_CLASSIFIER_ADD });
    } finally {
      setAddingToClassifier(null);
    }
  }

  /** A new classifier whose first photograph is this one -- the object twin of
   *  saving a new person from a face in the strip. Two calls because that is
   *  what the server offers: create, then add the view. If the second fails the
   *  classifier stays, empty, which is recoverable; the reverse would not be. */
  async function createClassifierFromSaved(entry, name) {
    if (!name || creatingClassifier) return;
    setCreatingClassifier(true);
    try {
      const response = await fetch(`${API_BASE}/objects`, {
        method: "POST",
        headers: jsonHeaders(),
        ...SEND_COOKIE,
        body: JSON.stringify({ name }),
      });
      const data = await response.json();
      if (!response.ok) {
        toast.error(
          detailText(data.detail) ??
            `Creazione non riuscita (${response.status}).`,
          { id: TOAST_CLASSIFIER_ADD },
        );
        return;
      }
      setObjectList(data.objects ?? []);
      await addSavedToClassifier(entry, data.object.id);
    } catch {
      toast.error("Server non raggiungibile.", { id: TOAST_CLASSIFIER_ADD });
    } finally {
      setCreatingClassifier(false);
    }
  }

  /** Opens the classifier's own panel on this picture's classifier -- the twin
   *  of "Dettagli" on a recognised person. piOpen is the panel that holds
   *  "Foto di un oggetto" and "Misura", which is where the box gets drawn. */
  function openClassifierDetails(objectId) {
    if (!objectId) return;
    setEnlargedEntry(null);
    setSelectedObject(objectId);
    loadObjectDetail(objectId);
    setPiOpen(true);
  }

  /** An entry's picture as base64, the form the face endpoints take. */
  async function savedBase64(entry) {
    const response = await fetch(savedImageUrl(entry), SEND_COOKIE);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  /** A thumbnail was clicked. A face opens the save form (unknown) or the edit
   * form (recognised); a hand or an object opens bigger. */
  async function openSaved(entry) {
    if (entry.kind !== "face") {
      setEnlargedEntry(entry);
      return;
    }
    let image;
    try {
      image = await savedBase64(entry);
    } catch {
      toast.error("Immagine non disponibile.", { id: TOAST_FACES });
      return;
    }
    // Also brings the judge colours the form offers.
    const facesData = await loadFaces();
    if (entry.person_id) {
      const person = (facesData?.people ?? []).find(
        (p) => p.id === entry.person_id,
      );
      if (!person) {
        toast.error("Questa persona non e' piu' salvata.", { id: TOAST_FACES });
        return;
      }
      setStripFaceImage(image);
      stripEntryRef.current = entry;
      setEnrollPerson(person);
      setEnrollPreview(image);
      enrollImagesRef.current = [];
      setEnrollOpen(true);
      return;
    }
    setStripFaceImage(image);
    stripEntryRef.current = entry;
    await openEnrolFor([image], image);
  }

  // The form's extra buttons, when it was opened from the strip.
  async function addStripViewTo(personId) {
    if (!stripFaceImage) return;
    const entry = stripEntryRef.current;
    const updated = await addViewToSelected(
      personId,
      [stripFaceImage],
      entry?.id,
    );
    // Closed on success: the count on the button would otherwise be stale.
    if (updated) {
      setEnrollOpen(false);
      if (entry) deleteSaved(entry); // saved: it leaves the strip
    }
  }

  function pickPersonForStrip() {
    if (!stripFaceImage) return;
    setEnrollOpen(false);
    pickImagesRef.current = [stripFaceImage];
    setPickValue(null);
    setPickOpen(true);
  }

  useEffect(() => {
    if (faceMode) loadFaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faceMode]);

  // Copies the little the interface needs out of the animation loop's refs,
  // twice a second. Everything here could be read straight from the ref inside
  // tick(), and doing so would re-render the page 30 times a second.
  useEffect(() => {
    if (!faceMode) {
      setSelectedFace(null);
      setFaceCount(0);
      return;
    }
    const timer = setInterval(() => {
      const detections = faceDetectionsRef.current ?? [];
      setFaceCount(detections.length);
      const wanted = selectedTrackRef.current;
      // Exactly one face on screen selects itself: tapping is for choosing
      // between several, and it should not be a chore when there is no choice.
      if (wanted == null && detections.length === 1) {
        setSelectedTrack(detections[0].trackId);
        setSelectedFace(detections[0]);
        return;
      }
      const found = detections.find((d) => d.trackId === wanted) ?? null;
      if (found) {
        lastSeenRef.current = performance.now();
        // Only when something the panel actually shows has changed. This runs
        // five times a second now, and handing React a new object each time
        // would re-render the page five times a second to display the same
        // words.
        setSelectedFace((current) =>
          panelSignature(current) === panelSignature(found) ? current : found,
        );
      } else if (
        performance.now() - lastSeenRef.current >
        FACE_SELECTION_GRACE_MS
      ) {
        // Only clear the panel once the face has really been gone for a
        // moment. Clearing it on the first missed frame is what made the save
        // button flicker away while it was being reached for -- and the
        // actions re-resolve the live track when they run (liveSelection), so
        // a slightly stale panel cannot act on the wrong person.
        setSelectedFace(null);
      }
      // Drop a selection whose track is gone for good, so the panel does not
      // keep offering actions on somebody who left the room.
      if (wanted != null && !found && !trackerRef.current.has(wanted)) {
        setSelectedTrack(null);
      }
      // Twice a second was chosen to keep setState out of the animation loop,
      // and it also put up to half a second between a name arriving and the
      // panel showing it. Five times a second is still nowhere near the frame
      // rate, and panelSignature above means an unchanged panel costs nothing.
    }, 200);
    return () => clearInterval(timer);
  }, [faceMode]);

  // Leaving face mode throws away the tracks: ids must never be reused, and a
  // stale selection would point at whoever next takes that id.
  useEffect(() => {
    if (faceMode) return;
    trackerRef.current.reset();
    faceDetectionsRef.current = [];
    recogMetaRef.current.clear();
    cropBufferRef.current.clear();
    setSelectedTrack(null);
  }, [faceMode]);

  // Recognition runs on its own, continuously.
  //
  // It is a scheduler rather than a loop over every face: one request at a
  // time, because the server holds both models behind a single lock and firing
  // three at once would only queue them. Faces nobody has identified yet go
  // first -- that is what someone is waiting to see -- and an identity already
  // shown is re-checked every few seconds, because a cached name is a
  // hypothesis about a box, and the person in that box can change.
  useEffect(() => {
    if (!faceMode || !detectsHere || !pageVisible || importedVideo) return;
    let stopped = false;

    const timer = setInterval(() => {
      if (stopped || recogniseBusyRef.current) return;
      const detections = faceDetectionsRef.current ?? [];
      if (!detections.length) return;
      const now = performance.now();

      let candidate = null;
      let bestWait = 0;
      for (const detection of detections) {
        // Too far away to identify: the server would only answer "too_small",
        // so do not spend a round trip discovering that again and again.
        //
        // A width of 0 means we could not measure it (the <img> has not
        // reported its natural size yet), NOT that the face is tiny. Skipping
        // on that would stop recognition ever running, silently, with no error
        // anywhere -- so an unmeasurable face is tried rather than skipped.
        const width = sourceFaceWidth(detection);
        if (width && width < minFacePxRef.current) continue;
        const meta = recogMetaRef.current.get(detection.trackId);
        const identified = detection.identity?.status === "match";
        const due = identified ? FACE_REVERIFY_MS : FACE_RETRY_MS;
        const waited = now - (meta?.lastAt ?? 0);
        if (waited < due) continue;
        // Unidentified faces outrank identified ones regardless of how long
        // each has waited.
        const priority = identified ? waited : waited + 1e6;
        if (priority > bestWait) {
          bestWait = priority;
          candidate = detection;
        }
      }
      if (candidate) recogniseTrack(candidate);
      // Polled often, because half of it is dead time: a face that appears
      // just after a tick used to wait most of a second before anyone asked
      // who it was. The work inside is a walk over at most a handful of boxes.
    }, 200);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [faceMode, detectsHere, pageVisible, capturesOwnCamera, importedVideo]);

  /** Grabs `count` crops of one face, `gapMs` apart, for averaging.
   *
   * The gap matters more for enrolling than for recognising. Recognition wants
   * a quick answer and the frames only have to average out motion blur, so they
   * are taken close together. Enrolment is stored for ever, and five frames
   * from the same half-second are five copies of ONE pose -- which is what
   * makes a record that only matches you when you sit exactly as you did when
   * you saved it. Spreading them out catches a little real variation.
   */
  async function captureCrops(detection, count = 3, gapMs = 120) {
    const media = currentMediaElement();
    const crops = [];
    for (let i = 0; i < count; i++) {
      // Re-read the box each time: the person moves between captures, and a
      // stale box would crop the wall next to them.
      const live =
        faceDetectionsRef.current.find(
          (d) => d.trackId === detection.trackId,
        ) ?? detection;
      const crop = cropFaceToJpeg(media, live.bbox, faceDetectWidthRef.current);
      if (crop) crops.push(crop);
      if (i < count - 1)
        await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
    return crops;
  }

  /** The text finder's boxes for the Pi's webcam, which arrive over
   *  /camera_detect_ws (an own camera's arrive in its detection effect, which
   *  draws the same way). */
  function drawTextBoxes(message) {
    const canvas = overlayRef.current;
    const { w: width, h: height } = message;
    if (!canvas || !width || !height) return;
    const shownPx =
      (canvas.clientWidth || width) * (window.devicePixelRatio || 1);
    const pixelScale = Math.min(
      MAX_OVERLAY_SCALE,
      Math.max(1, shownPx / width),
    );
    const bitmapWidth = Math.round(width * pixelScale);
    const bitmapHeight = Math.round(height * pixelScale);
    if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
      canvas.width = bitmapWidth;
      canvas.height = bitmapHeight;
    }
    canvas.pixelScale = bitmapWidth / width;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(canvas.pixelScale, 0, 0, canvas.pixelScale, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawDetections(ctx, message.items ?? [], videoFitRef.current);
    textBoxesRef.current = message;
    clearTimeout(textStaleRef.current);
    textStaleRef.current = setTimeout(() => {
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    }, 2500);
  }

  /** A tap on a text box opens the reading window with the words the live
   *  reading already has for that line -- the ones written over the box -- on a
   *  cut-out of the picture around it. Nothing is read again: re-reading a small
   *  crop split lines, mixed up their order and lost words that the
   *  whole-picture read had right (measured), so the window would disagree with
   *  what the screen showed. */
  async function handleTextTap(event) {
    const shown = textBoxesRef.current;
    const media = currentMediaElement();
    const point = pointerToCanvas(
      overlayRef.current,
      event.clientX,
      event.clientY,
      videoFit,
    );
    if (!shown || !media || !point) return;
    const hit = (shown.items ?? []).find(
      ({ bbox }) =>
        point.x >= bbox[0] &&
        point.x <= bbox[2] &&
        point.y >= bbox[1] &&
        point.y <= bbox[3],
    );
    if (!hit || !hit.label) return;
    const naturalWidth = media.naturalWidth || media.videoWidth || 0;
    if (!naturalWidth || !shown.w) return;
    const scale = naturalWidth / shown.w;
    const [x1, y1, x2, y2] = hit.bbox.map((v) => v * scale);
    // Room around the line, so the first and last letters are not on the edge.
    const margin = Math.max(12, (y2 - y1) * 0.5);
    const originX = Math.max(0, Math.round(x1 - margin));
    const originY = Math.max(0, Math.round(y1 - margin));
    const jpeg = await averagedFrameToJpeg(media, 1, 0, undefined, undefined, {
      x: originX,
      y: originY,
      width: x2 - x1 + 2 * margin,
      height: y2 - y1 + 2 * margin,
    });
    if (!jpeg) return;
    setReadFromFile(false);
    // The window always opens on « Etichette », whatever was picked last time.
    setReadMode("scene");
    setReadImage(jpeg);
    setReadError(null);
    setReadResult({
      lines: [
        {
          text: hit.label,
          confidence: null,
          // In the pixels of the cut-out, which is not shrunk.
          box: [x1 - originX, y1 - originY, x2 - originX, y2 - originY].map(
            Math.round,
          ),
        },
      ],
      ms: 0,
    });
    setReadOpen(true);
  }

  function handleOverlayPointerDown(event) {
    if (!faceMode) return;
    const canvas = overlayRef.current;
    const point = pointerToCanvas(
      canvas,
      event.clientX,
      event.clientY,
      videoFit,
    );
    if (!point) return;
    const hit = detectionAt(faceDetectionsRef.current, point.x, point.y);
    // Tapping the picture away from any face clears the selection, which is
    // the obvious way to undo a wrong tap.
    setSelectedTrack(hit ? hit.trackId : null);
    setSelectedFace(hit ?? null);
  }

  /** The selected face as it is RIGHT NOW, not as it was when React last
   * rendered. Tracks expire after a second, so anything that takes a while --
   * filling in the enrolment form, most obviously -- can easily outlive the
   * track id it started with, and acting on the stale one silently does
   * nothing. */
  function liveSelection() {
    const detections = faceDetectionsRef.current ?? [];
    return (
      detections.find((d) => d.trackId === selectedTrackRef.current) ??
      (detections.length === 1 ? detections[0] : null)
    );
  }

  /** Face width in the SOURCE picture's own pixels, which is what the server
   * measures against. The boxes are in detect space, which is a different
   * number, and refusing on the wrong one would refuse the wrong faces. */
  function sourceFaceWidth(detection) {
    const media = currentMediaElement();
    const natural = media?.naturalWidth || media?.videoWidth || 0;
    const detectWidth = faceDetectWidthRef.current || 1;
    if (!natural) return 0;
    return (detection.bbox[2] - detection.bbox[0]) * (natural / detectWidth);
  }

  /** Keeps the crops a recognition just used, WITH the face size they were
   * taken at.
   *
   * The size is the point. Enrolment refuses a face under 40 px, and the check
   * has to be made against the pictures actually being sent -- which can be
   * seconds old -- not against the face on screen when the button was pressed.
   * Walking towards someone and then saving them used to open the form on a
   * 90 px face and submit 40 px ones. */
  function rememberCrops(trackId, images, facePx) {
    if (!images.length) return;
    const now = performance.now();
    const buffer = cropBufferRef.current.get(trackId) ?? [];
    for (const image of images) buffer.push({ at: now, image, facePx });
    const fresh = buffer
      .filter((entry) => now - entry.at < CROP_BUFFER_MS)
      .slice(-CROP_BUFFER_SIZE);
    cropBufferRef.current.set(trackId, fresh);
  }

  /**
   * Asks the server who this face is, and records the answer against the track.
   *
   * A name is only shown once FACE_CONFIRMATIONS answers in a row have named
   * the SAME person. One frame at an awkward angle can cross the threshold on
   * its own; two in a row agreeing on the same wrong person is far less likely,
   * and the cost is about a second before the name appears.
   */
  async function recogniseTrack(detection) {
    if (recogniseBusyRef.current) return;
    recogniseBusyRef.current = true;
    try {
      // The FIRST question about a face is asked with one frame, not three.
      //
      // Three crops cost 240 ms of waiting between them and 600 ms on the
      // server instead of 220 -- most of a second, spent before anybody knows
      // whether the answer was ever in doubt. Averaging exists for motion
      // blur, and a blurred single frame simply scores too low to confirm on
      // its own (it needs FACE_STRONG_SCORE), so it falls back to the vote and
      // the next check uses three. Speed when the picture is good, caution
      // when it is not.
      const previous = recogMetaRef.current.get(detection.trackId);
      const known = !!previous?.votes?.length;
      // Booked at the moment the question is asked, not when it is answered.
      // Otherwise the tick loop below, which fires as soon as it sees a face
      // with no entry here, would ask again on the very next frame.
      recogMetaRef.current.set(detection.trackId, {
        votes: previous?.votes ?? [],
        lastAt: performance.now(),
      });
      const images = await captureCrops(detection, known ? 3 : 1);
      if (!images.length) return;
      rememberCrops(
        detection.trackId,
        images,
        Math.round(sourceFaceWidth(detection)),
      );
      const response = await fetch(`${API_BASE}/faces/recognize`, {
        method: "POST",
        headers: jsonHeaders(),
        ...SEND_COOKIE,
        body: JSON.stringify({ images }),
      });
      const data = await response.json();
      if (!response.ok) {
        // This runs every couple of seconds, so a toast per failure would
        // stack up a wall of them. Only the one a user can act on is shown,
        // and it reuses a fixed id so repeats replace rather than pile up.
        if (response.status === 503) {
          toast.error(
            detailText(data.detail) ?? "Riconoscimento non disponibile.",
            {
              id: TOAST_FACES,
            },
          );
        }
        return;
      }

      let target = detection.trackId;
      let inherited = null;
      if (!trackerRef.current.has(target)) {
        // The track died while we were asking -- ordinary, since tracks live a
        // second and a round trip can take longer. Re-homing the answer is only
        // safe when exactly ONE face is on screen; with several, the face we
        // asked about may not be the one still here, and a name on the wrong
        // box is the failure this whole design exists to avoid.
        const live = faceDetectionsRef.current ?? [];
        if (live.length !== 1) return;
        // The votes move with the answer. Without this the re-homed answer
        // lands on a track with an empty history and counts as the first of
        // two all over again -- which, with a box that breaks and reforms every
        // second or so, means a second vote never arrives and nobody is ever
        // named. It is the same single face on screen either way.
        inherited = recogMetaRef.current.get(target)?.votes ?? null;
        recogMetaRef.current.delete(target);
        target = live[0].trackId;
      }

      const meta = recogMetaRef.current.get(target) ?? {
        votes: inherited ?? [],
        lastAt: 0,
      };
      meta.votes.push(
        data.status === "match" ? (data.person?.id ?? null) : null,
      );
      meta.votes = meta.votes.slice(-FACE_VOTE_WINDOW);
      meta.lastAt = performance.now();
      recogMetaRef.current.set(target, meta);

      // Who, if anyone, has been named enough times in the recent answers.
      const tally = new Map();
      for (const vote of meta.votes) {
        if (vote) tally.set(vote, (tally.get(vote) ?? 0) + 1);
      }
      let confirmedId = null;
      for (const [id, count] of tally) {
        if (count >= FACE_CONFIRMATIONS) confirmedId = id;
      }
      // One decisive answer is enough on its own. Waiting for a second assumes
      // the face will still be there to give one, and with a moving camera it
      // often is not.
      if (
        !confirmedId &&
        data.status === "match" &&
        data.score >= FACE_STRONG_SCORE &&
        data.score - (data.runner_up ?? 0) >= FACE_STRONG_MARGIN
      ) {
        confirmedId = data.person?.id ?? null;
      }

      let identity;
      if (
        confirmedId &&
        data.status === "match" &&
        data.person?.id === confirmedId
      ) {
        identity = data;
      } else if (confirmedId) {
        // Confirmed a moment ago, and this one answer disagrees. Keep the name.
        // A person who turns their head scores badly for a frame or two, and
        // blanking the label every time they do makes the whole feature look
        // broken. Only a DIFFERENT person reaching confirmation replaces it.
        identity = trackerRef.current.get(target)?.identity ?? data;
      } else if (data.status === "match") {
        // Named once, not yet often enough to show.
        identity = {
          ...data,
          status: "checking",
          maybe: data.person,
          person: null,
        };
      } else {
        identity = data;
      }

      trackerRef.current.setIdentity(target, identity);
      setSelectedFace((current) =>
        current && current.trackId === target
          ? { ...current, identity }
          : current,
      );
    } catch {
      // A dropped request is ordinary here -- the next scheduled check is a
      // couple of seconds away, and the box simply stays unidentified.
    } finally {
      recogniseBusyRef.current = false;
    }
  }

  /**
   * Adds the current view of a face to a person already enrolled.
   *
   * This is the way out of a contradiction the app had: it would advise saving
   * someone again from another angle, and then refuse the save because that
   * person is already stored. Both halves were right -- a record built from one
   * pose does need more views, and a second record for the same person really
   * would make every later match a coin flip between them. What was missing was
   * the third option: add the view to the record that exists.
   *
   * `stripImages`: pictures from the strip (DetectionStrip) to add instead of
   * crops of the face selected on the live video. Returns the updated person
   * on success, null otherwise.
   */
  async function addViewToSelected(personId, stripImages, entryId) {
    const detection = stripImages ? null : liveSelection();
    const id = personId ?? selectedFace?.identity?.person?.id;
    if ((!stripImages && !detection) || !id || addingView) return null;
    setAddingView(true);
    try {
      let images = stripImages;
      if (!images) {
        const now = performance.now();
        // Same rule as enrolling, and for the same reason: this endpoint runs
        // the same size and coherence checks, so stale or small crops fail it.
        const buffered = (cropBufferRef.current.get(detection.trackId) ?? [])
          .filter(
            (entry) =>
              now - entry.at < ENROL_CROP_MAX_AGE_MS &&
              (!entry.facePx || entry.facePx >= enrolMinFacePx),
          )
          .map((entry) => entry.image);
        const wanted = Math.max(0, 3 - buffered.length);
        const fresh = wanted ? await captureCrops(detection, wanted, 350) : [];
        images = [...buffered, ...fresh].slice(-3);
      }
      if (!images.length) {
        toast.error("Non sono riuscito a ritagliare il volto.", {
          id: TOAST_FACES,
        });
        return null;
      }
      const response = await fetch(`${API_BASE}/faces/${id}/sample`, {
        method: "POST",
        headers: jsonHeaders(),
        ...SEND_COOKIE,
        // entry_id: the strip picture, whose position goes with the photo.
        body: JSON.stringify(
          entryId ? { images, entry_id: entryId } : { images },
        ),
      });
      const data = await response.json();
      if (!response.ok) {
        toast.error(detailText(data.detail) ?? "Non riuscito.", {
          id: TOAST_FACES,
        });
        return null;
      }
      toast.success(
        `Inquadratura aggiunta a ${data.person.name} ${data.person.surname}`.trim() +
          ` (${data.person.samples} in tutto).`,
        { id: TOAST_FACES },
      );
      // Force the next scheduled check to use the widened record rather than
      // whatever it concluded before -- including its stored "unknown" votes,
      // which is the whole point of having added a view.
      if (detection) {
        recogMetaRef.current.delete(detection.trackId);
        trackerRef.current.setIdentity(detection.trackId, null);
      }
      loadFaces();
      return data.person;
    } catch (error) {
      toast.error(`Non riuscito: ${error.message}`, { id: TOAST_FACES });
      return null;
    } finally {
      setAddingView(false);
    }
  }

  async function startEnrol() {
    const detection = liveSelection();
    if (!detection) return;
    setStripFaceImage(null);
    stripEntryRef.current = null;

    // Refuse before asking for a name, not after. The server enforces the same
    // floor, but discovering it on submit means typing everything in and then
    // being told the picture was never good enough.
    const facePx = Math.round(sourceFaceWidth(detection));
    if (facePx && facePx < enrolMinFacePx) {
      toast.error(
        `Il volto è troppo piccolo per essere salvato (${facePx} px, ` +
          `ne servono ${enrolMinFacePx}). Avvicinati e riprova.`,
        { id: TOAST_FACES },
      );
      return;
    }

    // Frames from BEFORE the click, kept by the recogniser as it worked. The
    // moment worth saving is the one that was on screen when the button was
    // pressed -- capturing only afterwards saves a pose from seconds later,
    // which is not what anyone chose.
    //
    // Only RECENT ones, and only ones big enough for the server to accept: an
    // eight-second-old crop is a different distance and often a different
    // pose, which is what made the server answer either "too small" or "not
    // the same person" about a burst of one person standing still.
    const now = performance.now();
    const buffered = (cropBufferRef.current.get(detection.trackId) ?? [])
      .filter(
        (entry) =>
          now - entry.at < ENROL_CROP_MAX_AGE_MS &&
          (!entry.facePx || entry.facePx >= enrolMinFacePx),
      )
      .map((entry) => entry.image);

    // Top up to five with fresh ones, spread out: five frames from one instant
    // are one pose recorded five times, and a record made of those only
    // recognises the person sitting exactly as they were.
    const wanted = Math.max(0, 5 - buffered.length);
    const fresh = wanted ? await captureCrops(detection, wanted, 400) : [];
    const images = [...buffered, ...fresh].slice(-5);
    if (!images.length) {
      toast.error("Non sono riuscito a ritagliare il volto.", {
        id: TOAST_FACES,
      });
      return;
    }
    // Measured again after capturing, because capturing took two seconds and
    // the person may have stepped back during them. Better a toast now than a
    // filled-in form thrown away on submit.
    const afterPx = Math.round(sourceFaceWidth(liveSelection() ?? detection));
    if (afterPx && afterPx < enrolMinFacePx) {
      toast.error(
        `Il volto è troppo piccolo per essere salvato (${afterPx} px, ` +
          `ne servono ${enrolMinFacePx}). Avvicinati e riprova.`,
        { id: TOAST_FACES },
      );
      return;
    }
    // The newest buffered frame is the one closest to the moment of the click.
    await openEnrolFor(
      images,
      buffered.length ? buffered[buffered.length - 1] : images[0],
    );
  }

  /** Opens the save form for these face pictures, once the server has said it
   * would accept them. Shared by the live video (startEnrol) and the strip. */
  async function openEnrolFor(images, preview) {
    // Ask the server whether it would accept these pictures, BEFORE asking the
    // user for a name.
    //
    // The local checks above only know how wide the box is. "Nitido e
    // frontale" is YuNet's score on the submitted crop, and YuNet runs on the
    // server -- so a blurred or three-quarter face passed everything here and
    // was refused after the form had been filled in. This sends the exact
    // images the form would submit, through the exact filter that would judge
    // them, so the form opens only when saving will work.
    setSavingFace(true);
    let verdict;
    try {
      const response = await fetch(`${API_BASE}/faces/check`, {
        method: "POST",
        headers: jsonHeaders(),
        ...SEND_COOKIE,
        body: JSON.stringify({ images }),
      });
      verdict = await response.json();
      if (!response.ok) {
        toast.error(detailText(verdict.detail) ?? "Controllo non riuscito.", {
          id: TOAST_FACES,
        });
        return;
      }
    } catch {
      toast.error("Server non raggiungibile.", { id: TOAST_FACES });
      return;
    } finally {
      setSavingFace(false);
    }
    if (!verdict.ok) {
      toast.error(verdict.error, { id: TOAST_FACES });
      return;
    }

    setEnrollPerson(null);
    setEnrollPreview(preview);
    enrollImagesRef.current = images;
    setEnrollOpen(true);
  }

  function startEdit() {
    const person = selectedFace?.identity?.person;
    if (!person) return;
    setStripFaceImage(null);
    stripEntryRef.current = null;
    setEnrollPerson(person);
    setEnrollPreview(null);
    enrollImagesRef.current = [];
    setEnrollOpen(true);
  }

  async function submitEnrol(fields) {
    // Read now: the form closes (and may be reopened) before the answer comes.
    const fromStrip = stripFaceImage ? stripEntryRef.current : null;
    setSavingFace(true);
    try {
      const editing = Boolean(enrollPerson);
      const response = await fetch(
        editing ? `${API_BASE}/faces/${enrollPerson.id}` : `${API_BASE}/faces`,
        {
          method: editing ? "PATCH" : "POST",
          headers: jsonHeaders(),
          ...SEND_COOKIE,
          body: JSON.stringify(
            editing
              ? {
                  name: fields.name,
                  surname: fields.surname,
                  description: fields.description,
                  judge: fields.judge,
                }
              : {
                  ...fields,
                  images: enrollImagesRef.current,
                  ...(fromStrip ? { entry_id: fromStrip.id } : {}),
                },
          ),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        const known = data.detail?.person;
        if (response.status === 409 && known) {
          // Refusing a duplicate is right, but leaving it at a refusal is what
          // made the app contradict itself: it asks for another angle, then
          // rejects the attempt. Offer what was actually wanted instead.
          setEnrollOpen(false);
          toast.error(detailText(data.detail), {
            id: TOAST_FACES,
            duration: 14000,
            action: {
              label: "Aggiungi a questa persona",
              // From the strip there is no face selected on the video: the
              // picture the form was about to save is the one to add.
              onClick: async () => {
                const updated = await addViewToSelected(
                  known.id,
                  fromStrip ? enrollImagesRef.current : undefined,
                  fromStrip?.id,
                );
                if (updated && fromStrip) deleteSaved(fromStrip); // saved: it leaves the strip
              },
            },
            // Only a resemblance can be overridden. A confident duplicate
            // stays refused: a second record for the same face stops BOTH
            // from being recognised.
            cancel: data.detail?.certain
              ? undefined
              : {
                  label: "È un'altra persona",
                  onClick: () =>
                    submitEnrol({ ...fields, allow_similar: true }),
                },
          });
          return;
        }
        toast.error(detailText(data.detail) ?? "Salvataggio non riuscito.", {
          id: TOAST_FACES,
        });
        return;
      }
      setEnrollOpen(false);
      // Its picture is now the person's: it leaves the strip. Only for a new
      // person -- editing a name does not save the picture.
      if (fromStrip && !editing) deleteSaved(fromStrip);
      const saved = `${data.person.name} ${data.person.surname}`.trim();
      if (editing) {
        toast.success("Modifiche salvate.", { id: TOAST_FACES });
      } else if ((data.person.samples ?? 0) < 2) {
        // Near-identical frames are discarded, so a count of one means every
        // frame caught the same instant. Saying so matters: such a record only
        // recognises this person in this exact pose, and nothing else about
        // the interface would reveal that.
        toast.warning(
          `${saved} salvato, ma con una sola inquadratura utile. ` +
            "Girati un poco e usa «Aggiungi inquadratura» per riconoscerlo meglio.",
          { id: TOAST_FACES, duration: 10000 },
        );
      } else {
        toast.success(
          `${saved} salvato (${data.person.samples} inquadrature).`,
          {
            id: TOAST_FACES,
          },
        );
      }
      // Recognise again straight away rather than waiting for the scheduler,
      // so the box takes its colour the moment the record exists.
      //
      // Deliberately re-recognising instead of attaching the person we just
      // saved to the selected track: filling in the form takes far longer than
      // the one second a track lives, so the face on screen is almost always a
      // NEW track by now, and attaching to the old id quietly did nothing --
      // the record saved correctly and the box stayed grey.
      //
      // The votes for the current track are cleared first, so the fresh answers
      // are not weighed against the "unknown" ones from before the save.
      loadFaces();
      const current = liveSelection();
      if (current) {
        recogMetaRef.current.delete(current.trackId);
        await recogniseTrack(current);
      }
    } catch (error) {
      toast.error(`Salvataggio non riuscito: ${error.message}`, {
        id: TOAST_FACES,
      });
    } finally {
      setSavingFace(false);
    }
  }

  // This device's own camera as the source, and "Condividi con gli altri" --
  // shown in the right panel, "Questo dispositivo". A JSX value of its own
  // rather than inlined there because it was also shown a second time in the
  // left "Server" panel for a while; that was dropped (it read as a
  // duplicate on the machine running the server, where both panels are the
  // same device), but kept as its own value in case a reason to show it
  // somewhere else comes up again.
  const thisDeviceFieldset = (
    <Fieldset variant="filled" radius="md" p="xs" legend="Questo dispositivo">
      <Stack gap="xs">
        {/* Streams the camera of whatever device is viewing this page (phone,
            tablet, laptop) up to the server -- the machine running the server
            included: its own webcam through the browser is the same
            own-camera path as a phone's, with the same detection, saving and
            Avvia/Ferma. It used to be disabled here, with a note pointing at
            the "Webcam N" buttons instead -- that separate, much thinner path
            is still there, but is no longer the only way in. */}
        {/* NOT on the machine that runs the server. There this device's camera
            is the Raspberry's own webcam, which the left panel already starts
            and stops ("Condividi la webcam"), and showing a second sharing
            button for the same camera read as a duplicate. A phone or a PC keeps
            both: its own camera here, the Pi's webcam on the left. */}
        {!clientIsServer && (
          <>
            <Button
              variant={source === "remote" ? "filled" : "light"}
              onClick={() => {
                if (wideScreen !== true) setAppOpen(false);
                selectSource("remote");
              }}
              disabled={switching}
              title="La fotocamera del telefono o del PC che sta guardando questa pagina"
            >
              Fotocamera di questo dispositivo
            </Button>
            {/* Only meaningful for this device's own camera. The Raspberry's
              cameras have nothing to switch off: their frames start on the
              Pi, so the stream to the browser IS the video. */}
            {/* Only offered when nobody else owns the stream -- which is
              already what capturesOwnCamera means now. Previously every
              page showed this button, so any device could start publishing
              over another, and each of them showed a "stop sharing" button
              for a stream it did not own. A spectator stops the stream from
              the device list below instead. */}
            {capturesOwnCamera && (
              <Button
                variant={sharing ? "filled" : "light"}
                // Room of its own, above and below. It shares a Stack with
                // the camera button, so widening that Stack's gap would have
                // spaced the whole group instead of setting this one apart --
                // and this is the button that starts and stops the thing the
                // page is for.
                my="sm"
                // Closing the panel is part of the action, not a nicety: what
                // you want to see the instant you start sharing is the
                // picture you are sending, and this panel is covering it.
                // The floating button over the video is how you stop again,
                // so nothing becomes unreachable by closing this.
                onClick={() => {
                  setSharing((on) => !on);
                  setPiOpen(false);
                }}
                disabled={switching}
                /* Same correction as the group label above: seen from a phone
                 pointed at a Windows PC, "al Raspberry" names a machine
                 that is not involved. */
                title={
                  sharing
                    ? `Smetti di inviare il video ${serverIsPi ? "al Raspberry" : "al server"}`
                    : `Invia il video ${serverIsPi ? "al Raspberry" : "al server"} perche' gli altri dispositivi possano vederlo`
                }
              >
                {sharing ? "Smetti di condividere" : "Condividi con gli altri"}
              </Button>
            )}
          </>
        )}
      </Stack>
      {/* Who is connected, and who owns the stream. Without this there
          was no way to tell whether the video came from this device or
          another, nor why the sharing button was unavailable.

          Mantine's List, so the bullets, the indent and the hanging
          indent of a wrapped line all come from the library rather than
          from a hand-made row. Without them several devices ran together
          into one block of text with nothing marking where one ended. */}
      <List size="sm" spacing="xs" className="mt-1.5" listStyleType="disc">
        {deviceList.length === 0 && (
          <Text size="sm" c="dimmed">
            Nessun dispositivo collegato.
          </Text>
        )}
        {deviceList.map((device) => (
          // In a 300 px panel the name and the state are laid one above
          // the other rather than spread apart: side by side, "collegato"
          // was pushed off the edge.
          <List.Item key={device.client_id}>
            <Group gap="xs" wrap="nowrap">
              <Text size="sm">{device.label}</Text>
              {device.client_id === CLIENT_ID && (
                <Badge size="xs" variant="light" color="gray">
                  questo dispositivo
                </Badge>
              )}
            </Group>
            <Group gap="xs" wrap="nowrap">
              <Text size="sm" c="dimmed">
                {device.sharing ? "condivide il video" : "collegato"}
              </Text>
              {/* Anyone may end the stream, not only the device that
                  started it: everybody else is watching a camera they
                  did not switch on, and had no way to switch off. */}
              {device.sharing && device.client_id !== CLIENT_ID && (
                <Button
                  type="button"
                  variant="light"
                  size="compact-xs"
                  onClick={stopOtherSharing}
                  title="Ferma la condivisione di questo dispositivo"
                >
                  Ferma
                </Button>
              )}
            </Group>
          </List.Item>
        ))}
      </List>

      {capturesOwnCamera && (
        <Text
          className="text-xs opacity-75 leading-[1.35]"
          size="xs"
          c="dimmed"
        >
          {sharing
            ? "Visibile agli altri dispositivi. Il rilevamento gira solo qui: gli altri vedono il video senza riquadri."
            : "Solo su questo dispositivo. La fotocamera e il rilevamento funzionano, ma nulla viene inviato al Raspberry."}
        </Text>
      )}
      {/* The spectator's side of the same story: this page shows someone
          else's camera and has deliberately stopped its own. */}
      {someoneElseShares && (
        <Text
          className="text-xs opacity-75 leading-[1.35]"
          size="xs"
          c="dimmed"
        >
          Stai guardando la fotocamera di un altro dispositivo. Il rilevamento
          gira su quel dispositivo, non qui.
        </Text>
      )}
    </Fieldset>
  );

  return (
    <>
      {/* The frame is Mantine's own AppShell: Header, Navbar, Aside, Main and
        Footer, so nothing about the skeleton is hand-rolled.

        The picture is the page, and the three bars float ON it rather than
        taking height away from it. That is two supported knobs, not a pile of
        hand-written CSS -- see `offset: false` below.

        Both panels slide over the picture, and the BURGER is what closes
        them: they start at --app-shell-header-offset, i.e. below the header,
        so the burger that opened one is never covered by it. There is
        deliberately no second close button on the panel's own title row. */}
      <AppShell
        header={{ height: 48 }}
        // Full width on a phone. At 300 px a 90 px strip of the button bar was
        // left showing beside an open panel, which reads as the panel failing to
        // cover something rather than as a deliberate edge.
        navbar={{
          width: { base: "100%", sm: 300 },
          breakpoint: "md",
          collapsed: { mobile: !piOpen, desktop: !piOpen },
        }}
        aside={{
          width: { base: "100%", sm: 300 },
          breakpoint: "md",
          collapsed: { mobile: !appOpen, desktop: !appOpen },
        }}
        // Sized for the longest label, not the average one. On a 390 px phone
        // the secondary slot is 101 px wide and "Aggiungi a una persona…" wraps
        // inside it; at 128 px the bar was clipped and the last word was cut in
        // half. Measured at 164: 106 px of content, nothing clipped.
        //
        // `offset: false` is what makes this bar FLOAT. Mantine then never
        // defines --app-shell-footer-offset, and two things follow from that one
        // prop (both read out of AppShell.module.css, not guessed):
        //   .main            loses its bottom padding -> the video runs the full
        //                    height of the screen, under the bar;
        //   .navbar/.aside   are `calc(100dvh - header-offset - footer-offset)`
        //                    tall, so they now reach the BOTTOM of the screen and
        //                    cover the bar.
        // The header offset is deliberately kept: dropping it too would pull the
        // panels up over the burger that has to close them.
        footer={{
          // Nothing left to show -- the detection label moved to the top bar --
          // and the bar is removed, so the picture gets the space.
          height:
            faceMode && detectsHere
              ? { base: 164, sm: 124 }
              : someoneElseShares
                ? 52
                : 0,
          collapsed: !(faceMode && detectsHere) && !someoneElseShares,
          offset: false,
        }}
        padding={0}
      >
        {/* Transparent, so the picture reaches the top of the screen. The
          burgers keep their own backing instead -- see below. */}
        <AppShell.Header withBorder={false} className="bg-transparent">
          {/* Top-aligned: on a phone the buttons are two rows (the switch above the
            pair) and taller than this 48 px bar, and centring them put the
            switch above the top of the screen. They hang down over the picture
            instead, like the status text already does. */}
          <Group
            h="100%"
            px="sm"
            justify="space-between"
            align="flex-start"
            wrap="nowrap"
            gap="xs"
          >
            {/* `invisible`, not removed. This Group spaces three children, and
              taking one out of the DOM slides the status text sideways every
              time a panel opens. visibility:hidden also drops it out of the
              tab order and stops it taking clicks, which is the rest of what
              "hidden" has to mean here. */}
            {/* Hidden only on a PHONE, where an open panel is the whole screen
              and the other burger would sit on top of it.

              On a wide screen both panels open by themselves (see wideScreen
              above) and both are 300 px strips beside the picture, so this rule
              hid BOTH burgers at once and left no way to close either panel --
              which is exactly what "the sidebar on the desktop cannot be
              closed" was. `!== true` and not `!wideScreen`, because the media
              query is undefined on the first render and must not read as a
              phone for that frame. */}
            {/* Always visible. On a phone only one panel is open at a time:
              opening one closes the other, so both burgers stay reachable
              and each still closes its own panel. On a wide screen both
              panels may stay open side by side, as before. */}
            <BurgerPill
              opened={piOpen}
              hidden={false}
              onClick={() => {
                if (!piOpen && wideScreen !== true) setAppOpen(false);
                setPiOpen((open) => !open);
              }}
              label={serverIsPi ? "Raspberry" : "Server"}
            />
            {/* Its own backing too: white-on-white is unreadable the moment the
              camera points at something bright. What is being detected, as
              the bottom bar used to say; a loading or switching message takes
              its place while one is showing. */}
            {!(!wideScreen && (piOpen || appOpen)) && (
              <div className="relative min-w-0 mt-2 w-full">
                {/* This device's own camera only: whether it sends frames to the
                  server to be detected, and whether what is found gets saved.
                  Sharing is not affected. Full size, because a small one was
                  hard to hit on a phone, and in the bar itself; the label
                  moves under it, hanging over the video, so the bar keeps its
                height.

                Two buttons, mutually exclusive: turning one on turns the
                other off, and with both off nothing streams at all -- the
                actual battery saving, not just "detects but does not
                save" (that still sent every frame). "Avvia" detects AND
                saves; "Osserva" detects without saving, for watching the
                classifier work without filling the strip. */}
                {/* ALWAYS shown, whatever camera is selected. They only act on this
                device's own camera (that is where frames are sent and saved), so
                with any other source they are greyed out and say why, instead of
                disappearing -- or, worse, staying live and doing nothing. */}
                {/* The switch and the pair of buttons: side by side where there is
                room, the pair under the switch on a phone (a 390 px screen has
                about 280 px between the two burgers). */}
                <Group gap={6} wrap="wrap" justify="center" w="100%">
                  <Tooltip
                    label="Cosa cercare nell'immagine: oggetti, volti e mani (Avvia e Osserva) oppure il testo (Leggi testo e Osserva testo)."
                    multiline
                    w={260}
                    events={{ hover: true, focus: true, touch: true }}
                  >
                    <div>
                      <SegmentedControl
                        size="sm"
                        radius="xl"
                        color="violet"
                        value={textMode ? "text" : "objects"}
                        data={[
                          { value: "objects", label: "Oggetti" },
                          { value: "text", label: "Testo" },
                        ]}
                        onChange={(value) => {
                          if (value === "objects") {
                            setTextMode(false);
                            setTextOn(false);
                            if (canDetect) {
                              setDetectionReady(false);
                              setDetectOnlyOn(true);
                            }
                          } else {
                            setTextMode(true);
                            setDetectOn(false);
                            setDetectOnlyOn(false);
                            if (cameraOn) {
                              setDetectionReady(false);
                              setTextOn(true);
                              setTextSave(false);
                            }
                          }
                        }}
                      />
                    </div>
                  </Tooltip>
                  <Group gap={6} wrap="nowrap" className="main-actions">
                    {textMode ? (
                      <>
                        <Tooltip
                          label={
                            cameraOn
                              ? textOn && textSave
                                ? "Interrompe la ricerca del testo. Le immagini gia' salvate restano nella striscia."
                                : "Cerca il testo nell'immagine in tempo reale e salva nella striscia in basso le inquadrature con testo. Tocca un riquadro per leggerlo. Mentre e' attiva il pulsante diventa « Ferma »."
                              : "Accendi prima una camera: non c'e' nessuna immagine da leggere."
                          }
                          multiline
                          w={260}
                          events={{ hover: true, focus: true, touch: true }}
                        >
                          <div>
                            <Button
                              className="main-action-btn"
                              size="md"
                              radius="xl"
                              variant="filled"
                              color={
                                cameraOn && textOn && textSave ? "red" : "blue"
                              }
                              disabled={!cameraOn}
                              onClick={() => {
                                if (
                                  !(textOn && textSave) &&
                                  wideScreen !== true
                                ) {
                                  setPiOpen(false);
                                  setAppOpen(false);
                                }
                                if (textOn && textSave) {
                                  setTextOn(false);
                                } else {
                                  setDetectionReady(false);
                                  setTextOn(true);
                                  setTextSave(true);
                                }
                                setDetectOn(false);
                                setDetectOnlyOn(false);
                              }}
                            >
                              {cameraOn && textOn && textSave
                                ? "Ferma"
                                : "Leggi testo"}
                            </Button>
                          </div>
                        </Tooltip>
                        <Tooltip
                          label={
                            cameraOn
                              ? textOn && !textSave
                                ? "Interrompe la ricerca del testo."
                                : "Cerca il testo nell'immagine in tempo reale e mostra i riquadri, senza salvare nulla. Tocca un riquadro per leggerlo. Mentre e' attiva il pulsante diventa « Ferma »."
                              : "Accendi prima una camera: non c'e' nessuna immagine da leggere."
                          }
                          multiline
                          w={260}
                          events={{ hover: true, focus: true, touch: true }}
                        >
                          <div>
                            <Button
                              className="main-action-btn"
                              size="md"
                              radius="xl"
                              variant="filled"
                              color={
                                cameraOn && textOn && !textSave ? "red" : "teal"
                              }
                              disabled={!cameraOn}
                              onClick={() => {
                                if (
                                  !(textOn && !textSave) &&
                                  wideScreen !== true
                                ) {
                                  setPiOpen(false);
                                  setAppOpen(false);
                                }
                                if (textOn && !textSave) {
                                  setTextOn(false);
                                } else {
                                  setDetectionReady(false);
                                  setTextOn(true);
                                  setTextSave(false);
                                }
                                setDetectOn(false);
                                setDetectOnlyOn(false);
                              }}
                            >
                              {cameraOn && textOn && !textSave
                                ? "Ferma"
                                : "Osserva testo"}
                            </Button>
                          </div>
                        </Tooltip>
                        {!importedVideo && (
                          <Tooltip
                            label="Legge il testo di un'immagine che scegli dal dispositivo, senza usare la camera. Si salva senza posizione."
                            multiline
                            w={260}
                            events={{ hover: true, focus: true, touch: true }}
                          >
                            <div>
                              <FileButton
                                onChange={importTextImage}
                                accept="image/*"
                              >
                                {(props) => (
                                  <Button
                                    className="main-action-btn"
                                    {...props}
                                    size="md"
                                    radius="xl"
                                    variant="filled"
                                    color="grape"
                                  >
                                    Importa immagine
                                  </Button>
                                )}
                              </FileButton>
                            </div>
                          </Tooltip>
                        )}
                      </>
                    ) : (
                      <>
                        <Tooltip
                          label={
                            !canDetect
                              ? someoneElseShares
                                ? "Un altro dispositivo sta condividendo la sua fotocamera: qui non c'e' niente da rilevare."
                                : "Accendi prima una webcam (pannello a sinistra) oppure scegli « Fotocamera di questo dispositivo » (pannello a destra)."
                              : detectOn
                                ? "Interrompe il rilevamento di oggetti, volti e mani. Le immagini gia' salvate restano nella striscia."
                                : "Rileva oggetti, volti e mani e salva nella striscia in basso le inquadrature. Mentre e' attivo il pulsante diventa « Ferma »."
                          }
                          multiline
                          w={260}
                          events={{ hover: true, focus: true, touch: true }}
                        >
                          <div>
                            <Button
                              className="main-action-btn"
                              size="md"
                              radius="xl"
                              disabled={!canDetect}
                              color={canDetect && detectOn ? "red" : "green"}
                              onClick={() => {
                                // Starting it is done to LOOK at the result: on a phone
                                // an open panel covers the video.
                                if (!detectOn && wideScreen !== true) {
                                  setPiOpen(false);
                                  setAppOpen(false);
                                }
                                if (!detectOn) setDetectionReady(false);
                                setDetectOn((on) => !on);
                                setDetectOnlyOn(false);
                                setTextOn(false);
                              }}
                            >
                              {canDetect && detectOn ? "Ferma" : "Avvia"}
                            </Button>
                          </div>
                        </Tooltip>
                        <Tooltip
                          label={
                            !canDetect
                              ? someoneElseShares
                                ? "Un altro dispositivo sta condividendo la sua fotocamera: qui non c'e' niente da rilevare."
                                : "Accendi prima una webcam (pannello a sinistra) oppure scegli « Fotocamera di questo dispositivo » (pannello a destra)."
                              : detectOnlyOn
                                ? "Interrompe il rilevamento di oggetti, volti e mani."
                                : "Rileva oggetti, volti e mani e mostra i riquadri, senza salvare nulla. Mentre e' attivo il pulsante diventa « Ferma »."
                          }
                          multiline
                          w={260}
                          events={{ hover: true, focus: true, touch: true }}
                        >
                          <div>
                            <Button
                              className="main-action-btn"
                              size="md"
                              radius="xl"
                              variant="filled"
                              disabled={!canDetect}
                              color={canDetect && detectOnlyOn ? "red" : "teal"}
                              onClick={() => {
                                if (!detectOnlyOn && wideScreen !== true) {
                                  setPiOpen(false);
                                  setAppOpen(false);
                                }
                                if (!detectOnlyOn) setDetectionReady(false);
                                setDetectOnlyOn((on) => !on);
                                setDetectOn(false);
                                setTextOn(false);
                              }}
                            >
                              {canDetect && detectOnlyOn ? "Ferma" : "Osserva"}
                            </Button>
                          </div>
                        </Tooltip>
                      </>
                    )}
                  </Group>
                </Group>
                <Text
                  size="sm"
                  truncate
                  // A prop, not Tailwind's mt-2: Mantine's own margin wins over it.
                  mt={8}
                  className="absolute left-1/2 top-full w-max min-w-0 max-w-[70vw] -translate-x-1/2 rounded-full bg-black/45 px-2 py-0.5 text-white"
                >
                  {detectorStatus ||
                    (switching
                      ? "Cambio sorgente…"
                      : serverSaving && !(serverCamera && detectOn)
                        ? "Salvataggio attivo dalla webcam del Raspberry"
                        : textMode
                          ? "Lettura del testo"
                          : `Rilevamento: ${currentDetectionLabel}`)}
                </Text>
              </div>
            )}
            <BurgerPill
              opened={appOpen}
              hidden={false}
              onClick={() => {
                if (!appOpen && wideScreen !== true) setPiOpen(false);
                setAppOpen((open) => !open);
              }}
              label="App"
            />
          </Group>
        </AppShell.Header>

        {/* --- the picture, full screen ------------------------------------
          h-[100svh] rather than the default min-height: the stage below is a
          flex child that fills what is left after the header and the footer,
          and "at least this tall" gives it nothing to fill.

          pt-0 cancels the padding Mantine derives from the header height, so
          the picture starts at the very top of the screen and the burgers
          float on it. The header's own OFFSET is left alone -- that is what
          keeps the panels below the header, and the burger reachable. It wins
          without !important because index.css declares `utilities` after
          `mantine`, and a later layer beats an earlier one. */}
        <AppShell.Main className="flex h-[100svh] pt-0">
          {/* Explicitly relative. The overlay's `absolute inset-0` used to work
            only as a side effect of the old container being `sticky`. */}
          <div className="relative flex-1 min-w-0 bg-[#111]">
            {/* Nothing is shared: say so and say how to start, instead of a black
              rectangle that looks like a fault. */}
            {source === "none" &&
              showVideo &&
              !importedVideo &&
              !localCameraPreview && (
                <Text
                  size="sm"
                  c="gray.4"
                  className="pointer-events-none absolute inset-x-6 top-1/2 z-10 -translate-y-1/2 text-center"
                >
                  Nessuna camera accesa. Scegli una webcam (pannello a sinistra)
                  oppure « Fotocamera di questo dispositivo » (pannello a
                  destra).
                </Text>
              )}
            {/* What to photograph next, on the picture: the instruction is read
              while aiming, not in a panel that covers the video. Under the
              status line, which can run to 70% of the width. Not clickable, so
              it never steals a tap meant for the picture. */}
            {guidedOn && showVideo && GUIDED_STEPS[guidedStep] && (
              <Paper
                p="xs"
                radius="md"
                className="pointer-events-none absolute left-1/2 top-24 z-10 w-[min(92%,34rem)] -translate-x-1/2 bg-black/75 text-center"
              >
                <Text size="xs" fw={700} c="gray.4">
                  Passo {guidedStep + 1} di {GUIDED_STEPS.length} ·{" "}
                  {GUIDED_STEPS[guidedStep].label}
                </Text>
                <Text size="sm" fw={600} c="white">
                  {GUIDED_STEPS[guidedStep].message}
                </Text>
                {GUIDED_STEPS[guidedStep].into === "without" && (
                  <Text size="xs" c="gray.4">
                    Senza l'oggetto nell'inquadratura.
                  </Text>
                )}
              </Paper>
            )}
            {/* Rendered only while the page is on screen. Removing the element
              from the DOM is what actually closes the HTTP stream, which makes
              the server drop the viewer count and stop the camera worker when
              it reaches zero. Setting src="" instead is unreliable and leaves
              a broken-image icon. */}
            {showVideo ? (
              <>
                {/* When this device is the one capturing, show ITS camera, not
                  the copy that went to the Pi and came back. That round trip
                  is seconds long, and detecting on the live camera while
                  showing the delayed copy put the boxes nowhere near the
                  objects. */}
                {/* `fitClass` is the switch in the App panel, and it is the SAME
                  string that reaches hittest.js and draw.js. All three have to
                  agree: contain leaves bands and cover crops, and a tap is
                  turned back into a pixel by inverting whichever one is in
                  force. One left on the other setting is not a crash -- taps
                  land a consistent distance from the finger, or captions come
                  out the wrong size.

                  With cover, a 390x844 phone showing a 4:3 camera loses about
                  65% of the WIDTH, so a face at the edge is not there to tap.
                  That is the whole reason this is a choice and not a constant.

                  w-full h-full are NOT decoration. For an absolutely
                  positioned REPLACED element, width:auto resolves to the
                  element's INTRINSIC width, not to the space between left and
                  right -- which made the overlay 1239 px wide inside a 390 px
                  phone and pushed two faces out of reach. It rendered without
                  an error; only a tap test found it. */}
                {importedVideo ? (
                  <video
                    key="imported-video"
                    ref={importedVideoRef}
                    src={importedVideoUrl}
                    playsInline
                    preload="metadata"
                    onPlay={() => setImportedVideoPlaying(true)}
                    onPause={() => setImportedVideoPlaying(false)}
                    onEnded={() => setImportedVideoPlaying(false)}
                    onTimeUpdate={(event) =>
                      setImportedVideoTime(event.currentTarget.currentTime)
                    }
                    onLoadedMetadata={(event) => {
                      const duration = event.currentTarget.duration;
                      setImportedVideoDuration(
                        Number.isFinite(duration) ? duration : 0,
                      );
                      setImportedVideoTime(event.currentTarget.currentTime);
                    }}
                    onSeeked={() => {
                      importedVideoSeekIdRef.current += 1;
                      importedVideoFrameRef.current?.(true);
                    }}
                    onLoadedData={() => importedVideoFrameRef.current?.()}
                    onError={() =>
                      toast.error(
                        "Il browser non riesce a riprodurre questo video.",
                        {
                          id: "imported-video",
                        },
                      )
                    }
                    className={`absolute inset-0 h-full w-full ${fitClass}`}
                  />
                ) : capturesOwnCamera ? (
                  <video
                    key="device-camera"
                    ref={remoteVideoRef}
                    // Two fingers zoom the camera (see handlePinchStart), not the
                    // page: touch-none on the video only, so the strip and the
                    // rest of the page still scroll and zoom as before.
                    onTouchStart={handlePinchStart}
                    onTouchMove={handlePinchMove}
                    onTouchEnd={handlePinchEnd}
                    onTouchCancel={handlePinchEnd}
                    className={`absolute inset-0 h-full w-full touch-none ${fitClass}`}
                    muted
                    playsInline
                    autoPlay
                  />
                ) : localCameraPreview ? (
                  <video
                    key="local-camera-preview"
                    ref={localCameraRef}
                    className={`absolute inset-0 h-full w-full ${fitClass}`}
                    muted
                    playsInline
                    autoPlay
                  />
                ) : (
                  /* Fed one frame at a time by the effect below, not by an
                   MJPEG URL. `src` is set there to an object URL; leaving it
                   unset here keeps React from ever managing it. */
                  /* alt="" on purpose. With no frame yet -- no camera attached,
                   or the first one still on its way -- a non-empty alt renders
                   as large text plus a broken-image icon across the whole
                   stage, which reads as a fault rather than as "waiting". */
                  <img
                    ref={videoImgRef}
                    className={`absolute inset-0 h-full w-full ${fitClass}`}
                    alt=""
                  />
                )}
                {/* Boxes only, on a transparent layer above the picture. The
                  video is NOT copied into this canvas: doing that was a
                  full-resolution pixel copy every frame to redraw something
                  the browser was already showing.

                  Same fit as the picture, and the canvas bitmap is sized from
                  the same source, so the two share an aspect ratio -- that is
                  what keeps the boxes registered with the faces. */}
                {/* Also on this device's own camera, where the boxes come from
                  the server (/detect_ws) and are only drawn, never tapped. */}
                {((detectionLocation === "browser" && detectsHere) ||
                  capturesOwnCamera ||
                  importedVideo ||
                  localCameraPreview ||
                  textOn) && (
                  <canvas
                    ref={overlayRef}
                    // Clickable ONLY when faces are being detected here. Hands
                    // and objects keep the pointer-events: none the CSS gives
                    // it, so nothing about those two changes.
                    className={
                      `camera-overlay-canvas absolute inset-0 block h-full w-full ${fitClass} ` +
                      (((faceMode && detectsHere) || textOn) && !importedVideo
                        ? "pointer-events-auto cursor-pointer touch-manipulation"
                        : "pointer-events-none")
                    }
                    onPointerDown={
                      importedVideo
                        ? undefined
                        : textOn
                          ? handleTextTap
                          : detectsHere
                            ? handleOverlayPointerDown
                            : undefined
                    }
                  />
                )}
              </>
            ) : serverVideoSuppressed ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-sm leading-normal text-[#bbb] text-center">
                <span>
                  Video disattivato su questo PC (e' il server).
                  <br />
                  La fotocamera del telefono continua a funzionare.
                </span>
                <Button
                  variant="default"
                  size="xs"
                  onClick={() => setForceServerVideo(true)}
                >
                  Mostra comunque il video
                </Button>
              </div>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-sm leading-normal text-[#bbb] text-center">
                Video in pausa (scheda non attiva)
              </div>
            )}
            {/* The instant a burst frame is taken, like a camera shutter. White
              rather than a border or badge: it has to register in the corner
              of your eye while you are busy aiming the camera at the object,
              not be something you have to look for. Instant on, fading out
              over the transition below -- symmetric only because a one-shot
              flash is brief enough either way that the difference does not
              read. pointer-events-none: it must never intercept the pinch
              gesture also handled on this video. */}
            {capturing && (
              <div
                className={
                  "absolute inset-0 pointer-events-none bg-white transition-opacity duration-150 " +
                  (captureFlashOn ? "opacity-70" : "opacity-0")
                }
              />
            )}
            {/* Also during a scan: the backend stops the running camera to probe
              each index, then restarts it, so the feed really is unavailable. */}
            {/* And whenever something asked for is not working yet: detection
              starting or changing kind, sharing starting, another device's
              video on its way, a detection model loading here. */}
            {/* Detection not ready yet: show a one-line inline message with a
              spinner instead of covering the whole screen. */}
            {loadingLabel && (
              <div className="absolute left-1/2 bottom-4 -translate-x-1/2 z-20 flex items-center gap-2 bg-black/75 px-3 py-1 rounded-full border border-white/20">
                <Loader size="xs" color="white" />
                <Text size="xs" c="white">
                  {loadingLabel}
                </Text>
              </div>
            )}
            {/* A second way to stop sharing, where you are actually looking.
              The first one is in the left panel, and while the video fills the
              screen that panel is shut -- so stopping meant opening a panel to
              find a button, on a device that is busy publishing.

              Not a different action: the same setSharing(false) as the panel's,
              so the two can never disagree about whether this device is
              sharing.

              TWO things put it on screen rather than behind the context bar,
              and the first attempt got both wrong:

              - `fixed`, sitting one gap ABOVE the bar. The offset is
                --app-shell-footer-height, which Mantine keeps up to date
                through the breakpoint (164 px on a phone, 124 from `sm`, 52
                with no face panel), so this follows a bar that changes height
                instead of guessing at one number.
              - z-index 101. The bar is 100 and the two panels are 101; at
                z-[1] this was painted UNDER the bar, present in the DOM and
                invisible on screen. 101 puts it over the bar, and because
                Main comes before the panels in the DOM an equal z-index
                still lets an open panel cover it -- which is what should
                happen. */}
            {sharing && capturesOwnCamera && (
              <Button
                color="red"
                radius="xl"
                onClick={() => setSharing(false)}
                className="fixed left-1/2 z-[101] -translate-x-1/2 shadow-lg
                         bottom-[calc(var(--app-shell-footer-height,52px)+1rem)]"
              >
                Smetti di condividere
              </Button>
            )}
            {zoomLabel && (
              <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/60 px-3 py-1">
                <Text fw={600} c="white">
                  {zoomLabel}
                </Text>
              </div>
            )}
            {/* The arrow points left, toward the panel "Misura" lives in --
              see the useEffect above that dismisses this once it is opened.
              Fixed colours rather than Mantine's theme tokens: this sits over
              the video, outside the forced-dark MantineProvider that wraps
              the two side panels, so it must read the same in light or dark. */}
            {misuraHint && (
              <div className="fixed left-1/2 top-1/2 z-[101] flex -translate-x-1/2 -translate-y-1/2 items-center">
                <div
                  aria-hidden
                  className="h-0 w-0 border-y-[10px] border-y-transparent border-r-[14px]"
                  style={{ borderRightColor: "#fff3bf" }}
                />
                <Paper
                  shadow="lg"
                  radius="md"
                  p="sm"
                  style={{ backgroundColor: "#fff3bf" }}
                  className="max-w-[280px]"
                >
                  <Group justify="space-between" mb={4} gap="xs" wrap="nowrap">
                    <Text size="sm" fw={600} c="dark">
                      Foto aggiunta
                    </Text>
                    <CloseButton
                      size="sm"
                      onClick={() => setMisuraHint(null)}
                    />
                  </Group>
                  <Text size="sm" c="dark">
                    Disegna il riquadro sulla foto, poi Misura e attiva.
                  </Text>
                  {/* Admin-only, same as the real button it mirrors: a
                    non-administrator would only get a 403 from it. */}
                  {account.is_admin && (
                    <Button
                      mt="sm"
                      size="xs"
                      variant="light"
                      loading={measuring}
                      onClick={() => {
                        const objectId = misuraHint.objectId;
                        setMisuraHint(null);
                        setSelectedObject(objectId);
                        measureObject(objectId);
                      }}
                    >
                      Misura
                    </Button>
                  )}
                </Paper>
              </div>
            )}
            {/* What the server found in own-camera devices' frames, on every
              device -- see /detect_ws. */}
            <DetectionStrip
              entries={savedEntries}
              onOpen={openSaved}
              onDelete={deleteSaved}
              onClear={clearSaved}
              colourOf={savedColour}
              // Above "Smetti di condividere" while it is shown: at the same
              // height the strip covered it on a phone.
              raised={sharing && capturesOwnCamera}
              // The guided shutter in the middle, Interrompi on the right: one row, just above the strip's own
              // buttons, where a thumb already is.
              above={
                showVideo ? (
                  <Stack gap="xs" w="100%">
                    {importedVideo && (
                      <Group gap="xs" wrap="nowrap" className="w-full">
                        {!spinnerVisible && (
                          <>
                            <Button
                              size="compact-xs"
                              variant="default"
                              onClick={toggleImportedVideoPlayback}
                              disabled={
                                !importedVideoDuration || !detectionReady
                              }
                              aria-label={
                                importedVideoPlaying ? "Pausa" : "Riproduci"
                              }
                            >
                              {importedVideoPlaying ? (
                                <svg
                                  width="18"
                                  height="18"
                                  viewBox="0 0 24 24"
                                  fill="currentColor"
                                  aria-hidden
                                >
                                  <rect
                                    x="6"
                                    y="4"
                                    width="4"
                                    height="16"
                                    rx="2"
                                  />
                                  <rect
                                    x="14"
                                    y="4"
                                    width="4"
                                    height="16"
                                    rx="2"
                                  />
                                </svg>
                              ) : (
                                <svg
                                  width="18"
                                  height="18"
                                  viewBox="0 0 24 24"
                                  fill="currentColor"
                                  aria-hidden
                                >
                                  <polygon points="6,4 20,12 6,20" />
                                </svg>
                              )}
                            </Button>
                            <Button
                              size="compact-xs"
                              color="dark"
                              onClick={stopImportedVideo}
                              aria-label="Ferma video"
                            >
                              <svg
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                aria-hidden
                              >
                                <rect
                                  x="6"
                                  y="6"
                                  width="12"
                                  height="12"
                                  rx="2"
                                />
                              </svg>
                            </Button>
                            <Button
                              size="compact-xs"
                              color="dark"
                              onClick={closeImportedVideo}
                              aria-label="Chiudi video"
                            >
                              <svg
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2.5"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                aria-hidden
                              >
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </Button>
                          </>
                        )}
                        <Text size="xs" className="w-10 shrink-0 tabular-nums">
                          {formatVideoTime(importedVideoTime)}
                        </Text>
                        <Slider
                          aria-label="Timeline del video"
                          min={0}
                          max={Math.max(importedVideoDuration, 0.1)}
                          step={0.1}
                          value={importedVideoTime}
                          onChange={setImportedVideoTime}
                          onChangeEnd={seekImportedVideo}
                          disabled={!importedVideoDuration}
                          className="min-w-0 flex-1"
                        />
                        <Text size="xs" className="w-10 shrink-0 tabular-nums">
                          {formatVideoTime(importedVideoDuration)}
                        </Text>
                      </Group>
                    )}
                    <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2">
                      <div />
                      <div className="justify-self-center">
                        {guidedOn && GUIDED_STEPS[guidedStep] ? (
                          <Button
                            size="lg"
                            radius="xl"
                            variant="filled"
                            color={guidedRetry ? "orange" : "green"}
                            loading={guidedUploading}
                            disabled={capturing}
                            onClick={
                              guidedRetry
                                ? () => guidedFinish(guidedShots)
                                : guidedShot
                            }
                          >
                            {guidedRetry
                              ? "Riprova"
                              : `Scatta (${guidedShots[guidedStep].length}/${GUIDED_STEPS[guidedStep].target})`}
                          </Button>
                        ) : null}
                      </div>
                      <div className="justify-self-end">
                        {guidedOn && (
                          <Button
                            size="md"
                            radius="xl"
                            variant="filled"
                            color="red"
                            disabled={guidedUploading}
                            onClick={guidedInterrupt}
                          >
                            Interrompi
                          </Button>
                        )}
                      </div>
                    </div>
                  </Stack>
                ) : null
              }
            />
            <TextReadDialog
              opened={readOpen}
              image={readImage}
              mode={readMode}
              onMode={changeReadMode}
              result={readResult}
              text={readShownText}
              onText={setReadEdited}
              busy={readBusy}
              error={readError}
              saving={readSaving}
              onSave={saveRead}
              onClose={() => setReadOpen(false)}
            />
            <SavedPictureModal
              entry={enlargedEntry}
              onClose={() => setEnlargedEntry(null)}
              onDelete={deleteSaved}
              onEditText={editSavedText}
              onAddToClassifier={addSavedToClassifier}
              addingToClassifier={addingToClassifier}
              // Every classifier, not only the measured ones and not only the one
              // that matched: see the dialog's own comment.
              classifiers={objectList.map((item) => ({
                value: item.id,
                label: item.name,
              }))}
              onCreateClassifier={createClassifierFromSaved}
              creatingClassifier={creatingClassifier}
              onDetails={openClassifierDetails}
            />
          </div>
        </AppShell.Main>

        {/* --- the context bar ---------------------------------------------
          Floating on the picture rather than below it (footer `offset: false`
          above), so it needs its own backing to stay legible over a bright
          frame, and a top border to read as a bar rather than as text lying
          on the video.

          Side to side, between the two panels, not underneath them -- same
          reasoning and the same two variables as the strip (DetectionStrip):
          Mantine sets each one to the panel's width while it is open beside
          the picture (from `md` up) and to 0 otherwise, closed or on a phone. */}
        <AppShell.Footer
          withBorder={false}
          className="left-[var(--app-shell-navbar-offset,0px)] right-[var(--app-shell-aside-offset,0px)]
                   border-t border-white/10 bg-black/55 text-white backdrop-blur-sm"
        >
          {faceMode && detectsHere ? (
            <FaceDetail
              detection={selectedFace}
              judges={faceJudges}
              faceCount={faceCount}
              busy={savingFace}
              onSave={startEnrol}
              onEdit={startEdit}
              onDetails={() =>
                setPinnedSnapshot(selectedFace?.identity?.person ?? null)
              }
              onAddView={addViewToSelected}
              onPickPerson={() => {
                pickImagesRef.current = null;
                stripEntryRef.current = null;
                setPickValue(null);
                setPickOpen(true);
              }}
              addingView={addingView}
            />
          ) : someoneElseShares ? (
            <Group h="100%" px="sm" justify="center">
              <Text size="sm" c="dimmed" ta="center">
                Stai guardando la fotocamera di un altro dispositivo.
              </Text>
            </Group>
          ) : null}
        </AppShell.Footer>

        {/* --- left panel: the machine running the server ------------------- */}
        {/* No close button on this title row. The burger in the header is the
          one control that opens and closes this panel, and the panel starts
          below the header, so it never covers it. Two controls for one action,
          one of them scrolling away with the content, was the confusion. */}
        {/* Both panels dark, while the picture and its bars keep following the
          device's own light/dark setting.

          Mantine declares its dark COLOURS only at
          `:root[data-mantine-color-scheme='dark']`, so putting that attribute
          on a panel would pull in the dark component rules -- which are plain
          descendant selectors -- while leaving every colour variable at its
          light value: a panel with dark borders and white backgrounds. A
          second MantineProvider is the supported way round it. It emits the
          same variables again under a selector of our choosing, so the panels
          get a complete dark palette and nothing else on the page changes.

          getRootElement returns undefined deliberately: without it this
          provider would put its own data-mantine-color-scheme on <html> and
          darken the entire app, which is the opposite of what was asked.
          withGlobalClasses is off because the outer provider has already
          added them once and they are global by definition.

          The text colour has to be stated. AppShell's panels do not set one,
          so they INHERIT it from <body> -- which is outside the scoped
          selector and still light. Measured before this was added: a panel at
          #242424 with pure black text on a light phone, and perfectly readable
          on a dark one, because only then did the inherited colour happen to
          suit. Pointing it at Mantine's own token means it follows whatever
          the panel's palette says rather than the page's. */}
        <MantineProvider
          forceColorScheme="dark"
          // Brighter than Mantine's stock dark palette, for the panels only.
          // Two shades do all the work here: --mantine-color-text is dark-0
          // (#c9c9c9) and --mantine-color-dimmed is dark-2 (#828282), and the
          // dimmed one carries every description and diagnostic row -- the text
          // that was hardest to read once the panels went dark. Raising the
          // shades rather than colouring components one by one means labels,
          // descriptions, legends and rows all move together.
          theme={{
            colors: {
              dark: [
                "#f4f6f8", // 0  the ordinary text
                "#dfe3e8",
                "#b6bec7", // 2  the "dimmed" text
                "#8d97a3", // 3  placeholders
                "#424242",
                "#3b3b3b",
                "#2e2e2e",
                "#242424",
                "#1f1f1f",
                "#141414",
              ],
            },
          }}
          cssVariablesSelector=".app-dark-panel"
          deduplicateCssVariables={false}
          withGlobalClasses={false}
          getRootElement={() => undefined}
        >
          <div
            ref={setDropdownHost}
            className="app-dark-panel contents text-[var(--mantine-color-text)]"
            data-mantine-color-scheme="dark"
          />
          <AppShell.Navbar
            p="sm"
            className="app-dark-panel text-[var(--mantine-color-text)]"
            data-mantine-color-scheme="dark"
          >
            <AppShell.Section>
              <Text fw={600} size="sm" mb="xs">
                {serverIsPi ? "Raspberry" : "Server"}
              </Text>
            </AppShell.Section>
            <AppShell.Section grow component={ScrollArea} className="text-left">
              <Stack gap="md" pb="md">
                {/* Grouped by WHERE the hardware is. "Pi Camera" and "Camera server
              0" previously sat side by side with nothing saying that one is
              the ribbon-cable module and the other a USB stick in the same
              machine.

              Mantine's Fieldset draws the box and the legend: the panel used to
              be one undivided column where a heading was only slightly bolder
              text, and which buttons belonged to which heading was a matter of
              reading carefully. */}
                {/* The whole group is hidden when it would hold no buttons at all:
              no camera module AND no USB webcam found by the scan. It used to
              render its heading unconditionally, so a Pi with nothing attached
              showed "Videocamere del Raspberry" over an empty space. A USB
              webcam on its own still brings the group back, so no camera that
              exists ever becomes unreachable. */}
                {(hasPiCamera || (usbDevices?.length ?? 0) > 0) && (
                  /* "del Raspberry" only when it really is the Raspberry. Seen from
             the machine running the server it is "questo PC"; seen from a
             phone pointed at that same PC it is "del server", which is the
             only wording true from both ends. */
                  <Fieldset
                    variant="filled"
                    radius="md"
                    p="xs"
                    legend={
                      serverIsPi
                        ? "Videocamere del Raspberry"
                        : clientIsServer
                          ? "Videocamere di questo PC"
                          : "Videocamere del server"
                    }
                  >
                    <Stack gap="xs">
                      {/* Hidden when no camera module is attached. libcamera also
                  enumerates USB webcams, and picamera2 opens them with red and
                  blue swapped, so offering this for a webcam only produces a
                  wrong-looking picture -- those belong to the USB buttons. */}
                      {hasPiCamera && (
                        <Button
                          // "filled" is what the old `.active` class marked: the
                          // source currently selected on the server.
                          variant={
                            shownWebcam.source === "picamera"
                              ? "filled"
                              : "light"
                          }
                          onClick={() => pickWebcam("picamera")}
                          disabled={switching}
                          title="Il modulo collegato al connettore CSI con il cavo piatto"
                        >
                          Modulo Pi Camera
                        </Button>
                      )}
                      {/* One button per webcam the scan actually found. Previously
                  two buttons were hardcoded, so a second one was offered even
                  with nothing plugged in -- and labelled "Webcam USB 2" from a
                  placeholder, an index that need not exist. */}
                      {/* Nothing until the scan has answered: `usbDevices ?? [0]`
                  invented a "Webcam USB 0" button for a camera that need not
                  exist. */}
                      {(usbDevices ?? []).map((index) => (
                        <Button
                          key={index}
                          variant={
                            shownWebcam.source === "usb" &&
                            shownWebcam.index === index
                              ? "filled"
                              : "light"
                          }
                          onClick={() => pickWebcam("usb", index)}
                          disabled={switching}
                          title={
                            serverIsPi
                              ? `Webcam USB collegata al Raspberry, /dev/video${index}`
                              : `Webcam della macchina che esegue il server, indice ${index}. ` +
                                "Su Windows e' anche la webcam integrata, non serve una chiavetta USB."
                          }
                        >
                          {/* Off the Raspberry this is whatever camera the server
                      machine has, integrated laptop webcam included. Calling
                      it "USB" made it look like it needed hardware plugged in
                      that is not there. */}
                          {serverIsPi
                            ? `Webcam USB ${index}`
                            : `Webcam ${index}`}
                        </Button>
                      ))}
                      {/* Nothing is shared until this is pressed, and it is how you
                  stop: like "Condividi con gli altri" on a phone. */}
                      <Button
                        type="button"
                        variant="filled"
                        color={webcamOn && cameraShared ? "red" : "green"}
                        onClick={toggleWebcam}
                        disabled={switching || someoneElseShares}
                        title={
                          someoneElseShares
                            ? "Un altro dispositivo sta condividendo la sua fotocamera"
                            : webcamOn && cameraShared
                              ? "Gli altri dispositivi non la vedranno piu'; qui resta accesa"
                              : "Accende la webcam scelta e la mostra a tutti i dispositivi"
                        }
                      >
                        {webcamOn && cameraShared
                          ? "Smetti di condividere"
                          : "Condividi la webcam"}
                      </Button>
                    </Stack>
                  </Fieldset>
                )}

                {/* OUTSIDE the group above, deliberately. That group hides itself
              when no camera has been found, and with the rescan inside it a
              machine with nothing attached had no way to look for one -- which
              is precisely when you need this button. Verified: with no camera
              on the Pi the group is gone and this is still here.

              An ACTION, not a choice, so it must not look like the source
              buttons: filled blue against their "default". On a dark panel an
              outlined button reads as background, which is how the first
              attempt at making it "different" made it invisible instead.

              Outside the boxes too, for the same reason: it is not part of the
              "which camera" choice, it is how you go and look for one. */}
                <Button
                  type="button"
                  variant="filled"
                  color="blue"
                  onClick={scanUsbDevices}
                  loading={scanning}
                >
                  {scanning ? "Ricerca in corso..." : "Cerca videocamere"}
                </Button>

                {/* The weight of the picture the server's OWN camera sends. Not
              per device -- the camera encodes each frame once and every
              viewer gets that same JPEG -- and not applicable at all while a
              phone supplies the video, so it moved here, beside the buttons
              that choose the server's camera, and out of sight rather than
              greyed out when a phone is the source instead.

              The value is read back from the heartbeat rather than
              remembered here, for the same reason: two phones must not show
              two different answers for one setting. */}
                {source !== "remote" && (
                  <Fieldset
                    variant="filled"
                    radius="md"
                    p="xs"
                    legend="Qualita' immagine"
                  >
                    <Select
                      description={
                        videoRung
                          ? `Circa ${videoRung.kb} KB per fotogramma.` +
                            (videoRung.value === "originale"
                              ? " Se il video e' a scatti, scendi di un gradino."
                              : " Piu' leggera: arriva prima e si vede piu' fluida.") +
                            " Vale per tutti i dispositivi collegati."
                          : "Impostazione della fotocamera del server."
                      }
                      value={videoRung?.value ?? null}
                      onChange={setVideoRung}
                      data={VIDEO_RUNGS.map(({ value, label }) => ({
                        value,
                        label,
                      }))}
                      comboboxProps={darkDropdown}
                      size="sm"
                    />
                  </Fieldset>
                )}

                {/* Gathering photographs of an object.

              Everyone who logs in sees this, not just administrators: the
              record of an object is meant to be built by several people, each
              contributing the angle they happen to be standing at, and a
              button only an administrator can press cannot do that.

              The two sets matter equally, which is why this is a choice and
              not one button. Frames WITHOUT the object are what reveal a
              detector that has simply learned to say yes, and that is the
              number the whole measurement turns on -- so the count of both is
              kept on screen rather than left to be guessed at. */}
                <Fieldset
                  variant="filled"
                  radius="md"
                  p="xs"
                  legend="Foto di un oggetto"
                >
                  {/* `relative` so the overlay below covers this panel and nothing
                else. Measuring reads every photo and every box on the server;
                re-boxing or deleting one WHILE it reads means the numbers that
                come back describe a set that no longer exists. The spinner used
                to sit on the Misura button alone, which said "working" while
                leaving the photos fully editable. */}
                  <div className="relative">
                    <LoadingOverlay
                      visible={measuring}
                      zIndex={10}
                      overlayProps={{ blur: 2 }}
                      loaderProps={{ size: "sm" }}
                    />
                    <Stack gap="xs">
                      {/* WHICH object you are collecting for. Without this the
                  photographs went into one nameless pile and there was no way
                  to tell afterwards what any of them were of. */}
                      <Select
                        size="xs"
                        label="Classificatore"
                        placeholder={
                          objectList.length
                            ? "Scegli un oggetto"
                            : "Nessuno: creane uno"
                        }
                        data={objectList.map((item) => ({
                          value: item.id,
                          label: `${item.name} — ${item.views} foto`,
                        }))}
                        value={selectedObject}
                        onChange={setSelectedObject}
                        disabled={capturing}
                        searchable={objectList.length > 6}
                        // Administrators only, same restriction as deleteClassifier
                        // itself -- this used to live as its own list in the right
                        // panel ("Classificatori personalizzati"); it's the same
                        // delete, just reachable from here instead.
                        renderOption={({ option, checked }) => (
                          <Group
                            justify="space-between"
                            wrap="nowrap"
                            className="w-full"
                          >
                            <Text size="sm" className="truncate">
                              {option.label}
                            </Text>
                            {checked && <CheckIcon size={12} />}
                            {account.is_admin && (
                              <CloseButton
                                size="xs"
                                aria-label={`Elimina ${option.label}`}
                                title="Elimina"
                                // Deleting is not selecting: the click must not reach
                                // the option underneath it.
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  const item = objectList.find(
                                    (o) => o.id === option.value,
                                  );
                                  if (item) deleteClassifier(item);
                                }}
                              />
                            )}
                          </Group>
                        )}
                      />
                      <Button
                        size="compact-sm"
                        variant="light"
                        onClick={() => {
                          setNewObjectName("");
                          setNewObjectOpen(true);
                        }}
                        disabled={capturing}
                      >
                        Nuovo classificatore
                      </Button>
                      {/* How photographs are gathered. The burst is unchanged and
                  still the quick way; guided is for building a set on purpose.
                  In guided mode the with/without control is hidden, because the
                  STEP decides which set each photo goes to -- leaving it on
                  screen would let the two disagree. */}
                      <SegmentedControl
                        fullWidth
                        size="xs"
                        value={captureMode}
                        onChange={chooseCaptureMode}
                        disabled={capturing || importing || guidedUploading}
                        data={[
                          { value: "guided", label: "Guidata" },
                          { value: "burst", label: "Raffica" },
                        ]}
                      />
                      {captureMode === "burst" && (
                        <SegmentedControl
                          fullWidth
                          size="xs"
                          value={captureInto}
                          onChange={setCaptureInto}
                          disabled={capturing}
                          data={[
                            { value: "with", label: "Con l'oggetto" },
                            { value: "without", label: "Senza" },
                          ]}
                        />
                      )}
                      {captureMode === "burst" ? (
                        <>
                          <Button
                            type="button"
                            variant="filled"
                            color="blue"
                            onClick={() => captureObjectFrames()}
                            loading={capturing}
                            // Nothing to grab when no picture is being shown: the button
                            // would save ten blank rectangles and report success. And
                            // nothing to file them under until an object is chosen, which
                            // is the whole reason the photographs were unusable before.
                            disabled={
                              !showVideo ||
                              (captureInto === "with" && !selectedObject)
                            }
                          >
                            {capturing
                              ? "Cattura in corso..."
                              : `Cattura ${CAPTURE_BURST} fotogrammi`}
                          </Button>
                          {captureInto === "with" && !selectedObject && (
                            <Text size="xs" c="dimmed">
                              Scegli o crea un classificatore prima di
                              catturare.
                            </Text>
                          )}
                          <Text size="xs" c="dimmed">
                            Muovi la videocamera intorno all'oggetto mentre
                            cattura: angoli e distanze diverse sono cio' che
                            rende utili queste foto. Raccolte:{" "}
                            {captureTotals.with} con, {captureTotals.without}{" "}
                            senza.
                          </Text>
                        </>
                      ) : !guidedOn ? (
                        <>
                          <Button
                            type="button"
                            variant="filled"
                            color="blue"
                            onClick={startGuided}
                            disabled={!showVideo || !selectedObject}
                          >
                            Inizia la procedura guidata
                          </Button>
                          {!selectedObject && (
                            <Text size="xs" c="dimmed">
                              Scegli o crea un classificatore prima di iniziare.
                            </Text>
                          )}
                        </>
                      ) : (
                        <>
                          {/* Short labels above, the real instruction in the body: the
                      six messages do not fit under six circles at any size that
                      still leaves room for the video. */}
                          <Stepper
                            active={guidedStep}
                            onStepClick={(next) => setGuidedStep(next)}
                            size="xs"
                            iconSize={22}
                            allowNextStepsSelect
                            contentPadding="xs"
                          >
                            {GUIDED_STEPS.map((step, index) => (
                              <Stepper.Step
                                key={step.label}
                                label={step.label}
                                description={`${guidedShots[index].length}/${step.target}`}
                              >
                                <Text size="sm">{step.message}</Text>
                                <Progress
                                  mt="xs"
                                  size="xs"
                                  value={Math.min(
                                    100,
                                    (guidedShots[index].length / step.target) *
                                      100,
                                  )}
                                />
                                {step.into === "without" && (
                                  <Text size="xs" c="dimmed" mt={4}>
                                    Queste finiscono fra le foto « senza
                                    l'oggetto »: sono quelle che rendono onesta
                                    la misura.
                                  </Text>
                                )}
                              </Stepper.Step>
                            ))}
                          </Stepper>
                          {/* The shutter and the caption are on the picture, where the
                      eyes are; this panel only shows how far the run is. */}
                          {guidedStep < GUIDED_STEPS.length && (
                            <>
                              <Text size="xs" c="dimmed">
                                Il pulsante Scatta e la descrizione sono sullo
                                schermo principale. Dopo 5 foto si passa al
                                passo successivo; le foto vengono salvate alla
                                fine dell'ultimo passo.
                              </Text>
                              <Group gap="xs">
                                <Button
                                  size="compact-xs"
                                  variant="subtle"
                                  disabled={guidedUploading}
                                  onClick={() => guidedAdvance()}
                                >
                                  Salta
                                </Button>
                                <Button
                                  size="compact-xs"
                                  variant="light"
                                  disabled={guidedUploading}
                                  onClick={() => guidedAdvance()}
                                >
                                  Avanti
                                </Button>
                              </Group>
                            </>
                          )}
                        </>
                      )}
                      {/* Photographs already on this device. Two buttons rather than
                  one: picking a folder relies on a non-standard attribute that
                  phones ignore, so it is offered only where it works, and the
                  plain picker (which allows multiple selection everywhere) is
                  what a phone uses. */}
                      <Group gap={20} my={16}>
                        <FileButton
                          multiple
                          accept="image/*"
                          onChange={(files) =>
                            importImageFiles(
                              files,
                              captureMode === "guided" ? "with" : captureInto,
                            )
                          }
                          disabled={importing || capturing}
                        >
                          {(props) => (
                            <Button
                              {...props}
                              size="compact-xs"
                              variant="default"
                            >
                              Importa immagini
                            </Button>
                          )}
                        </FileButton>
                        <FileButton
                          multiple
                          accept="image/*"
                          inputProps={{ webkitdirectory: "", directory: "" }}
                          onChange={(files) =>
                            importImageFiles(
                              files,
                              captureMode === "guided" ? "with" : captureInto,
                            )
                          }
                          disabled={importing || capturing}
                        >
                          {(props) => (
                            <Button
                              {...props}
                              size="compact-xs"
                              variant="default"
                            >
                              Importa una cartella di immagini
                            </Button>
                          )}
                        </FileButton>
                        <FileButton accept="video/*" onChange={importVideoFile}>
                          {(props) => (
                            <Button
                              {...props}
                              size="compact-xs"
                              variant="default"
                            >
                              {importedVideo
                                ? "Sostituisci video"
                                : "Importa video"}
                            </Button>
                          )}
                        </FileButton>
                        {importing && (
                          <Button
                            size="compact-xs"
                            variant="subtle"
                            color="red"
                            onClick={() => {
                              importCancelRef.current = true;
                            }}
                          >
                            Interrompi
                          </Button>
                        )}
                      </Group>
                      {importing && (
                        <>
                          <Progress
                            size="xs"
                            value={
                              (importDone / Math.max(1, importTotal)) * 100
                            }
                          />
                          <Text size="xs" c="dimmed">
                            {importDone} di {importTotal}
                            {importSkipped.length
                              ? ` · ${importSkipped.length} saltate`
                              : ""}
                          </Text>
                        </>
                      )}
                      {/* Every photo this classifier actually has, fetched from the
                  server -- not just the last few taken in this tab. Tap one
                  to draw or redraw its box; an administrator can also delete
                  it from here, same as the carousel's close button. */}
                      {selectedObject && (
                        <>
                          {/* Two different jobs meet here -- gathering photographs
                      above, deciding what they are worth below -- and as one
                      unbroken column of small grey text they read as one
                      paragraph of instructions nobody finishes. */}
                          <Divider my="xs" />
                          <Text size="xs">
                            Tocca una foto per disegnare il riquadro. Ogni foto
                            con il riquadro diventa un riferimento per il
                            rilevamento: riquadrane diverse (angoli, distanze,
                            luci) invece di una sola.{" "}
                            {/* Photographs somebody took, both sides of the "su":
                        a variant arrives already boxed, so counting those
                        would say "12 su 13" the moment variants exist and
                        make the boxing look finished when it is not. */}
                            {(objectDetail?.view_list ?? []).some(
                              (v) => v.box && !v.generated,
                            ) &&
                              `Riquadrate: ${objectDetail.view_list.filter((v) => v.box && !v.generated).length} su ${objectDetail.view_list.filter((v) => !v.generated).length} foto.`}
                          </Text>
                          {objectDetail?.detector && (
                            <Text
                              size="xs"
                              c={
                                objectDetail.detector.references <
                                objectDetail.detector.references_pinned
                                  ? "orange"
                                  : "dimmed"
                              }
                            >
                              Rilevamento attivo: {objectDetail.detector.method}
                              ,{" "}
                              {objectDetail.detector.references <
                              objectDetail.detector.references_pinned
                                ? `${objectDetail.detector.references} di ${objectDetail.detector.references_pinned} foto di riferimento ancora valide: rimisura e riattiva per aggiornare.`
                                : `${objectDetail.detector.references} foto di riferimento.`}
                            </Text>
                          )}
                          {/* Extra photographs, made rather than taken. Only for an
                      administrator, and only once something is boxed: a
                      variant copies its original's box, so with no box there
                      is nothing to copy. The explanation says what it is for
                      and what it costs, because "genera" on its own sounds
                      like it improves the classifier by itself -- it does not
                      until Misura and the activation run again. */}
                          {account.is_admin && augmentSources > 0 && (
                            <>
                              <Group gap="xs">
                                <Button
                                  size="compact-xs"
                                  variant="light"
                                  loading={augmenting}
                                  disabled={clearingGenerated}
                                  onClick={augmentObject}
                                >
                                  Genera varianti
                                </Button>
                                {generatedCount > 0 && (
                                  <Button
                                    size="compact-xs"
                                    variant="subtle"
                                    color="red"
                                    loading={clearingGenerated}
                                    disabled={augmenting}
                                    onClick={clearGeneratedViews}
                                  >
                                    Elimina le {generatedCount} generate
                                  </Button>
                                )}
                              </Group>
                              <Text size="xs" c="dimmed">
                                Da ogni foto con il riquadro ne crea cinque con
                                luce, contrasto, colore e sfocatura diversi, con
                                lo stesso riquadro
                                {objectDetail?.augment_max
                                  ? ` (al massimo ${objectDetail.augment_max} foto per volta)`
                                  : ""}
                                . Servono come riferimenti in piu', non come
                                prove: non contano nel punteggio di « Misura ».
                              </Text>
                            </>
                          )}
                          {/* Choosing WHICH photos the template method uses.
                  It matters for template alone: that method reruns a whole
                  scale sweep per reference, so it can afford about six where
                  orb and proposals take twenty -- and left to itself it took
                  "the first six", which on a burst of one pose means six
                  frames of the same angle. Only offered when the choice can
                  change anything: more boxed photos than template can hold,
                  or a choice already made. */}
                          {templateMax > 0 &&
                            (boxedCount > templateMax ||
                              templatePicks.length > 0) && (
                              <>
                                <Switch
                                  size="xs"
                                  checked={templatePickMode}
                                  onChange={(event) =>
                                    setTemplatePickMode(
                                      event.currentTarget.checked,
                                    )
                                  }
                                  label={`Scegli i riferimenti per template (max ${templateMax})`}
                                />
                                {templatePickMode && (
                                  <>
                                    <Text size="xs" c="dimmed">
                                      Tocca le foto da usare: il numero e'
                                      l'ordine della scelta. Scelte:{" "}
                                      {templatePicks.length} di {templateMax}.
                                      Vale solo per il metodo template, e ha
                                      effetto dopo « Misura » e l'attivazione.
                                    </Text>
                                    <Group gap="xs">
                                      <Button
                                        size="compact-xs"
                                        variant="light"
                                        loading={savingPicks}
                                        onClick={saveTemplatePicks}
                                      >
                                        Salva la scelta
                                      </Button>
                                      <Button
                                        size="compact-xs"
                                        variant="subtle"
                                        disabled={
                                          savingPicks ||
                                          templatePicks.length === 0
                                        }
                                        onClick={() => setTemplatePicks([])}
                                      >
                                        Azzera
                                      </Button>
                                    </Group>
                                  </>
                                )}
                                {objectDetail?.detector?.template_stale && (
                                  <Text size="xs" c="orange">
                                    I riferimenti scelti non sono quelli con cui
                                    template e' stato attivato: rimisura e
                                    riattiva per usare la scelta nuova.
                                  </Text>
                                )}
                              </>
                            )}
                          {/* real_views, not views: generating variants should not be
                  what makes this say "you have a lot of photographs", since
                  the remedy it suggests -- delete some -- is not the remedy
                  for having generated them (that is the button above). */}
                          {(objectDetail?.real_views ??
                            objectDetail?.views ??
                            0) > VIEWS_WARN_ABOVE && (
                            <Text size="xs" c="orange">
                              {objectDetail.real_views ?? objectDetail.views}{" "}
                              foto per questo classificatore: elimina quelle che
                              non servono piu'.
                            </Text>
                          )}
                          {(objectDetail?.view_list ?? []).length === 0 ? (
                            <Text size="xs" c="dimmed">
                              Nessuna foto ancora per questo classificatore.
                            </Text>
                          ) : (
                            <SimpleGrid cols={4} spacing="xs">
                              {objectDetail.view_list.map((view) => (
                                <ObjectViewThumb
                                  key={view.name}
                                  view={view}
                                  onEdit={(v) => {
                                    setEditingView(v.name);
                                    setReferenceBox(v.box ?? null);
                                  }}
                                  // Everyone may remove a photo THEY took; an
                                  // administrator may remove any of them, same as
                                  // elsewhere. The server checks this too -- this
                                  // only avoids showing a button that would answer
                                  // 403.
                                  canDelete={
                                    account.is_admin ||
                                    view.created_by === account.username
                                  }
                                  onDelete={deleteObjectView}
                                  pickMode={templatePickMode}
                                  pickDisabled={!view.box}
                                  onTogglePick={toggleTemplatePick}
                                  // While picking, the number follows the taps -- the
                                  // local choice. Otherwise it is what the server has
                                  // stored, so a reload shows the same numbers.
                                  templateRank={
                                    templatePickMode
                                      ? templatePicks.indexOf(view.name) + 1 ||
                                        null
                                      : view.template_rank
                                  }
                                />
                              ))}
                            </SimpleGrid>
                          )}
                        </>
                      )}
                      {/* Administrators only, and the server enforces that -- this
                  merely avoids showing an operator a button that would answer
                  403. Comparing three localisers over every stored frame costs
                  whole seconds of CPU, which is why it is not everybody's. */}
                      {account.is_admin &&
                        (objectDetail?.view_list ?? []).some((v) => v.box) && (
                          <Button
                            type="button"
                            variant="light"
                            // NOT onClick={measureObject}: that hands measureObject
                            // the click event as its first argument, which it now
                            // reads as objectIdOverride (added for the hint button
                            // below) -- so it JSON.stringifies a React event instead
                            // of the real id, throws on the event's circular DOM
                            // references before fetch() ever runs, and the request
                            // never leaves the browser at all.
                            onClick={() => measureObject()}
                            loading={measuring}
                          >
                            {measuring ? "Misura in corso..." : "Misura"}
                          </Button>
                        )}
                      {/* Changing the method WITHOUT the whole measurement.
                  Until now the only way to a method was the table Misura puts
                  on screen, and that table lives in React state: close the
                  dialog or reload the page and the choice is unreachable
                  again, even though the server's /activate endpoint measures
                  one method on its own perfectly well.
                  It is still a measurement -- just one method's worth, because
                  the server re-runs it rather than trusting numbers from a
                  browser -- so the wording below says so instead of promising
                  something instant. */}
                      {account.is_admin &&
                        (objectDetail?.view_list ?? []).some((v) => v.box) && (
                          <>
                            <Group gap="xs" align="flex-end" wrap="nowrap">
                              <Select
                                label="Metodo"
                                data={[
                                  {
                                    value: "orb",
                                    label: "orb — spigoli e texture",
                                  },
                                  {
                                    value: "proposals",
                                    label: "proposals — oggetti interi",
                                  },
                                  {
                                    value: "template",
                                    label: "template — confronto diretto",
                                  },
                                ]}
                                value={
                                  methodChoice ??
                                  objectDetail?.detector?.method ??
                                  null
                                }
                                onChange={setMethodChoice}
                                size="xs"
                                className="grow"
                                comboboxProps={darkDropdown}
                                disabled={
                                  activatingMethod !== null || measuring
                                }
                              />
                              <Button
                                size="xs"
                                variant="light"
                                loading={activatingMethod !== null}
                                disabled={measuring}
                                onClick={() =>
                                  activateClassifier(
                                    methodChoice ??
                                      objectDetail?.detector?.method ??
                                      "proposals",
                                  )
                                }
                              >
                                Usa questo metodo
                              </Button>
                            </Group>
                            <Text size="xs" c="dimmed">
                              Misura solo il metodo scelto e lo attiva, senza
                              rifare l'intera misurazione. Costo per fotogramma
                              su questo Raspberry: orb ~30 ms, template ~270 ms,
                              proposals ~440 ms. Se il metodo non separa le foto
                              con l'oggetto da quelle senza, il server lo
                              rifiuta e lo dice.
                            </Text>
                          </>
                        )}
                    </Stack>
                  </div>
                </Fieldset>

                {/* What the sharing is actually doing, in numbers. Only here while
              this page is part of a share -- the rest of the time there is
              nothing to measure and it would be five dashes taking up room.

              See the comment on meterRef: this is here to decide what to
              change, not to change anything. */}
                {inShare && (
                  <Fieldset
                    variant="filled"
                    radius="md"
                    p="xs"
                    legend="Diagnostica"
                  >
                    <Stack gap={2} className="text-xs">
                      {/* The headline number, first and in full words: how far
                    behind reality the picture is. Everything under it exists
                    to explain where that number comes from.

                    On the device that is SHARING, built from its own upload
                    figure, which is a second old, rather than from the
                    server's copy of it, which arrives on a five-second
                    heartbeat. Measured: the headline read 1.0 s while the two
                    rows explaining it read 99 ms and 0 ms -- the sum was
                    right, it was just five seconds out of date, and a number
                    you watch while turning knobs has to keep up with the
                    knobs. The server's frame age is added as-is: it is
                    single-digit milliseconds next to a link measured in
                    hundreds, so its staleness cannot move the total. */}
                      <MeterRow
                        label="ritardo"
                        value={(() => {
                          const ms =
                            sharing &&
                            capturesOwnCamera &&
                            meter?.uploadMs != null
                              ? meter.uploadMs + (serverMeter?.age_ms ?? 0)
                              : serverMeter?.total_ms;
                          return ms != null
                            ? `${(ms / 1000).toFixed(1)} s`
                            : "…";
                        })()}
                      />
                      <Divider my={4} />
                      {sharing && capturesOwnCamera && (
                        <>
                          {/* Two rows, not "5 of 4". The encode is asynchronous, so a
                        frame drawn just before a second ends is sent just after
                        it, and the two counts legitimately differ by one across
                        the boundary -- which as "X di Y" reads as a fault. */}
                          <MeterRow
                            label="creati"
                            value={meter ? `${meter.encoded}/s` : "…"}
                          />
                          <MeterRow
                            label="inviati"
                            value={meter ? `${meter.sent}/s` : "…"}
                          />
                          <MeterRow
                            label="scartati"
                            value={meter ? `${meter.skipped}/s` : "…"}
                          />
                          <MeterRow
                            label="in uscita"
                            value={meter ? `${meter.kbOut} KB/s` : "…"}
                          />
                          <MeterRow
                            label="in coda"
                            value={meter ? `${meter.buffered} KB` : "…"}
                          />
                          {/* The two halves of the upload delay, separately: the
                        link's own round trip, and the time the queue will take
                        to drain. A large queue with a small link is the
                        backlog allowance being spent, which is the trade this
                        setting makes on purpose. */}
                          <MeterRow
                            label="rete (sola andata)"
                            value={
                              meter?.linkMs != null ? `${meter.linkMs} ms` : "…"
                            }
                          />
                          <MeterRow
                            label="attesa in coda"
                            value={
                              meter?.queueMs != null
                                ? `${meter.queueMs} ms`
                                : "…"
                            }
                          />
                        </>
                      )}
                      {someoneElseShares && (
                        <>
                          {/* "disegnati", not "ricevuti": this is counted when the
                        browser has finished decoding and showing the frame,
                        which is also when the next one is asked for. It is
                        therefore the rate this screen can actually manage, and
                        the number to compare against "al server" above -- a
                        gap between them is this device being the slow part. */}
                          <MeterRow
                            label="disegnati"
                            value={meter ? `${meter.received}/s` : "…"}
                          />
                          <MeterRow
                            label="in entrata"
                            value={meter ? `${meter.kbIn} KB/s` : "…"}
                          />
                          <MeterRow
                            label="giro completo"
                            value={meter?.rtt != null ? `${meter.rtt} ms` : "…"}
                          />
                          {/* The two halves of that round trip, because they call for
                        opposite fixes. A long "attesa" is the server and the
                        link; a long "decodifica" is this browser turning the
                        JPEG into pixels. Smaller frames shorten both, which is
                        why the verdict below reaches for that first. */}
                          <MeterRow
                            label="di cui attesa"
                            value={
                              meter?.waitMs != null ? `${meter.waitMs} ms` : "…"
                            }
                          />
                          <MeterRow
                            label="di cui decodifica"
                            value={
                              meter?.drawMs != null ? `${meter.drawMs} ms` : "…"
                            }
                          />
                        </>
                      )}
                      {/* The server's numbers. Its clock measures both ends of
                    "how old was this frame", so this is the one figure that
                    is a real delay rather than a round trip.

                    These three read as a chain, and each gap names a different
                    loss:
                      dal telefono -> al server   the server keeping only the
                                                  newest arrival while it is
                                                  busy with the previous one;
                      al server -> disegnati      this screen not keeping up,
                                                  which is what fills the
                                                  buffer;
                      persi dal buffer            what that full buffer threw
                                                  away to catch up in one step
                                                  -- the jump on screen.
                    Without them "it still jumps" cannot be attributed to any
                    one of the three, and a bigger buffer only ever addresses
                    the last. */}
                      {/* Tested for null, not just for serverMeter: a server that
                    has not been restarted yet answers without these two keys,
                    and `${undefined}/s` renders as the word "undefined". */}
                      <MeterRow
                        label="dal telefono"
                        value={
                          serverMeter?.arrived_fps != null
                            ? `${serverMeter.arrived_fps}/s`
                            : "…"
                        }
                      />
                      <MeterRow
                        label="al server"
                        value={serverMeter ? `${serverMeter.fps}/s` : "…"}
                      />
                      <MeterRow
                        label="persi dal buffer"
                        value={
                          serverMeter?.skipped_fps != null
                            ? `${serverMeter.skipped_fps}/s`
                            : "…"
                        }
                      />
                      {/* Only on a page that is WATCHING. On the device doing the
                    sharing this is the server's five-second-old copy of the
                    "rete" and "coda" rows above, so it showed the same
                    quantity twice with two different values -- measured once
                    at 76 ms live and 1106 ms here. A viewer has no local
                    measurement, so there it is the only source. */}
                      {someoneElseShares && (
                        <MeterRow
                          label="di cui invio"
                          value={
                            serverMeter?.upload_ms != null
                              ? `${serverMeter.upload_ms} ms`
                              : "…"
                          }
                        />
                      )}
                      {/* The age is only measured when a frame is handed to a
                    VIEWER, so with nobody watching there is nothing to
                    measure. Saying so beats a row of dots that never fills in
                    and looks like a number that failed to arrive. */}
                      <MeterRow
                        label="eta' fotogramma"
                        value={
                          serverMeter?.age_ms != null
                            ? `${serverMeter.age_ms} ms`
                            : serverMeter
                              ? "nessuno spettatore"
                              : "…"
                        }
                      />
                      {/* The conclusion, in one sentence, so the rows above do not
                    have to be interpreted to be useful. Built from the last
                    twenty seconds rather than the current one, because being
                    behind constantly and being behind once in ten seconds look
                    identical at any single moment and need opposite fixes. */}
                      {verdict && (
                        <>
                          <Divider my={4} />
                          <Text
                            size="xs"
                            c={verdict.tone}
                            className="leading-[1.35]"
                          >
                            {verdict.text}
                          </Text>
                        </>
                      )}
                    </Stack>
                  </Fieldset>
                )}

                {/* Turns this machine into a WiFi access point, so phones can reach
              the app with no router and no internet. It is the server's own
              network, which is why it sits in this panel and not the other.
              Administrators only -- the server checks that too, so hiding it
              here is convenience, not the protection. */}
                {account.is_admin && accessPoint && (
                  <Fieldset variant="filled" radius="md" p="xs" legend="Rete">
                    <Stack gap="xs">
                      {/* A button and not a switch, on purpose. A switch moves under
                  your finger and the question comes afterwards, which is the
                  wrong order for something that takes wlan0 off the router:
                  the gesture already looked done. A button does nothing except
                  open the question -- both ways round. */}
                      <Button
                        variant={
                          accessPoint.state === "on" ? "default" : "light"
                        }
                        disabled={!accessPoint.supported || accessPointBusy}
                        loading={accessPointBusy}
                        onClick={() =>
                          accessPoint.state === "on"
                            ? setConfirmApOff(true)
                            : setConfirmApOn(true)
                        }
                        size="sm"
                        title={
                          accessPoint.supported
                            ? `La rete parte da questo ${accessPoint.platform === "Windows" ? "PC" : "Raspberry"} ` +
                              `all'indirizzo ${accessPoint.ap_address}`
                            : accessPoint.detail
                        }
                      >
                        {accessPoint.state === "on"
                          ? "Spegni la rete WiFi"
                          : "Crea una rete WiFi"}
                      </Button>
                      {/* The address, while the network is up. It used to live only in
                  a toast that never expired, which covered the page and was
                  gone the moment anybody dismissed it -- and this is precisely
                  the thing you have to read off a screen and type into a
                  phone. */}
                      {accessPoint.state === "on" && accessPoint.ap_address && (
                        <Stack gap={2}>
                          <Text size="xs" c="dimmed">
                            Collega il telefono alla rete, poi apri:
                          </Text>
                          <Text size="sm" fw={600} className="break-all">
                            https://{accessPoint.ap_address}:8000
                          </Text>
                          {/* Rebuilt from the current status rather than reusing
                      whatever the switch made earlier: the dialog is closed by
                      then, and a stale one would show the previous network. */}
                          <Button
                            size="compact-xs"
                            variant="light"
                            onClick={async () =>
                              setJoinQr(await buildJoinQr(accessPoint))
                            }
                          >
                            Mostra il codice QR
                          </Button>
                        </Stack>
                      )}
                    </Stack>
                  </Fieldset>
                )}

                {/* The GPIO buttons. They act on the machine running the server, so
              this is where they belong. */}
                <Fieldset
                  variant="filled"
                  radius="md"
                  p="xs"
                  legend="Azioni hardware"
                >
                  {/* Three equal-width buttons in a narrow panel is tighter than
                "GPIO 17" fits on one line at the default padding -- wrapping
                it onto two instead of clipping it, the same fix the Misura
                table's button needed. */}
                  <Group gap="xs" grow>
                    <Button
                      color="red"
                      onClick={() => sendCommand("button1")}
                      styles={{
                        root: { height: "auto", padding: "6px 4px" },
                        label: {
                          whiteSpace: "normal",
                          textAlign: "center",
                          lineHeight: 1.2,
                        },
                      }}
                    >
                      GPIO 17
                    </Button>
                    <Button
                      color="green"
                      onClick={() => sendCommand("button2")}
                      styles={{
                        root: { height: "auto", padding: "6px 4px" },
                        label: {
                          whiteSpace: "normal",
                          textAlign: "center",
                          lineHeight: 1.2,
                        },
                      }}
                    >
                      GPIO 27
                    </Button>
                    <Button
                      color="blue"
                      onClick={() => sendCommand("button3")}
                      styles={{
                        root: { height: "auto", padding: "6px 4px" },
                        label: {
                          whiteSpace: "normal",
                          textAlign: "center",
                          lineHeight: 1.2,
                        },
                      }}
                    >
                      GPIO 22
                    </Button>
                  </Group>
                </Fieldset>
              </Stack>
            </AppShell.Section>
          </AppShell.Navbar>

          {/* --- right panel: everything that is not the server ---------------- */}
          {/* Same as the left panel: the burger is the only way in and out, so
          there is no close button on this title row either. */}
          <AppShell.Aside
            p="sm"
            className="app-dark-panel text-[var(--mantine-color-text)]"
            data-mantine-color-scheme="dark"
          >
            <AppShell.Section>
              <Text fw={600} size="sm" mb="xs">
                Questo dispositivo
              </Text>
            </AppShell.Section>
            <AppShell.Section grow component={ScrollArea} className="text-left">
              <Stack gap="md" pb="md">
                {/* This device's own camera as the source -- the panel this belongs
              under by name. See `thisDeviceFieldset` above the return. */}
                {thisDeviceFieldset}
                {/* There is deliberately no "detect on the Raspberry" button.
              detection_config lives on the SERVER and is shared by every
              connected page, so one device choosing it made the Pi annotate
              the single shared stream for everybody -- and each browser then
              drew its own boxes on top of those, giving two sets of lines per
              connected device. Detection belongs to the device that displays
              it; the server-side path stays in the code as a fallback but is
              not selectable here. */}
                <Fieldset
                  variant="filled"
                  radius="md"
                  p="xs"
                  legend="Rilevamento"
                >
                  {/* Was a hand-written combo box: an <input>, an open/closed flag, a
              filtered list, and key handling for Escape and Enter. Mantine's
              searchable Select is the same control with none of that code.
              All 82 entries: Volti, Mani and the 80 COCO classes. */}
                  <Select
                    className="detection-picker"
                    label="Detect"
                    data={detectionOptions}
                    value={detectionChoice}
                    // Mantine hands back null when a selection is cleared; there is no
                    // "detect nothing" state here, so ignore it and keep the current.
                    onChange={(value) => value && selectDetection(value)}
                    searchable
                    searchValue={detectionSearch}
                    onSearchChange={setDetectionSearch}
                    // Clicking in empties the field, so the whole list is offered and
                    // you can type over it immediately.
                    onFocus={() => setDetectionSearch("")}
                    // Clicking away (or Escape) without choosing puts the current
                    // class name back, instead of leaving the box blank or holding a
                    // half-typed word that is not what is being detected.
                    onDropdownClose={() =>
                      setDetectionSearch(currentDetectionLabel)
                    }
                    nothingFoundMessage="Nessun risultato"
                    placeholder="cerca..."
                    // Locked while another device is sharing: detection_config lives on
                    // the server and is shared by every page, so a change made here
                    // would silently alter what the SHARING device detects -- and only
                    // that device is detecting.
                    disabled={switching || someoneElseShares}
                    description={
                      someoneElseShares
                        ? "Scelto dal dispositivo che sta condividendo il video"
                        : isClassifierChoice(detectionChoice)
                          ? "I classificatori vengono rilevati sul server"
                          : undefined
                    }
                    // The list is long (every COCO class): cap it and let it scroll,
                    // and portal it so it is not clipped by the panel's overflow.
                    maxDropdownHeight={280}
                    comboboxProps={darkDropdown}
                  />
                  {/* Only while hands are being detected, and not rendered at all
              otherwise: it means nothing for faces or objects. */}
                  {detectionChoice === HAND_OPTION && (
                    <Select
                      mt="sm"
                      label="Mani da rilevare"
                      data={[
                        { value: "1", label: "1" },
                        { value: "2", label: "2" },
                      ]}
                      value={handCount}
                      onChange={(value) => value && changeHandCount(value)}
                      allowDeselect={false}
                      comboboxProps={darkDropdown}
                    />
                  )}
                  {/* Hands and objects only: faces have no server-side detector, and
              a classifier has no BROWSER detector -- the opposite gap, same
              reason there is nothing to choose. Not rendered at all for
              either, nor while this page shows its own camera (see
              detectionLocation). Locked while another device shares, like
              "Detect": the setting is the server's and shared. */}
                  {detectionChoice !== FACE_OPTION &&
                    !isClassifierChoice(detectionChoice) &&
                    !capturesOwnCamera && (
                      <Select
                        mt="sm"
                        label="Dove rilevare"
                        data={[
                          { value: "browser", label: "Questo dispositivo" },
                          { value: "server", label: "Server" },
                        ]}
                        value={locationChoice}
                        onChange={(value) => value && changeLocation(value)}
                        allowDeselect={false}
                        disabled={switching || someoneElseShares}
                        comboboxProps={darkDropdown}
                      />
                    )}
                  {/* TEMPORARY diagnostic readout -- remove with fpsTimer. */}
                  {videoFps != null && (
                    <Text size="xs" c="dimmed" mt="sm">
                      Video ricevuto: {videoFps} fotogrammi/s
                    </Text>
                  )}
                  {/* TEMPORARY diagnostic readout -- remove with recordTiming. */}
                  {detectTiming && (
                    <Text size="xs" c="dimmed" mt="sm">
                      Modello {detectTiming.model ?? "–"} ms · andata e ritorno{" "}
                      {detectTiming.roundTrip} ms · disegno {detectTiming.draw}{" "}
                      ms · {detectTiming.perSecond} rilevamenti/s ·{" "}
                      {detectTiming.delegate === "GPU"
                        ? "su GPU"
                        : detectTiming.delegate === "CPU"
                          ? "su processore"
                          : "motore sconosciuto"}
                      {detectTiming.renderer
                        ? ` (${detectTiming.renderer})`
                        : ""}
                    </Text>
                  )}
                </Fieldset>

                {/* How the picture is fitted into this screen. A property of the
              DEVICE, not of the server, so it is remembered here and changes
              nothing for anybody else.

              Worth a sentence under it rather than a bare label: "riempi lo
              schermo" sounds like an improvement with no cost, and the cost is
              that a face at the edge of the frame is cropped away and can no
              longer be tapped. */}
                <Fieldset variant="filled" radius="md" p="xs" legend="Video">
                  <Stack gap="sm">
                    <Switch
                      checked={videoFit === "cover"}
                      onChange={(event) =>
                        setVideoFit(
                          event.currentTarget.checked ? "cover" : "contain",
                        )
                      }
                      label="Riempi lo schermo"
                      description={
                        videoFit === "cover"
                          ? "I bordi dell'immagine vengono tagliati."
                          : "Immagine intera, con due bande ai lati."
                      }
                      size="sm"
                    />
                  </Stack>
                </Fieldset>

                <Fieldset variant="filled" radius="md" p="xs" legend="Account">
                  <Stack gap="xs">
                    <Text size="sm">
                      Collegato come <strong>{account.username}</strong>
                    </Text>
                    {/* User management left this page: it lives at /admin/, which
                  also does roles, renames, password resets, connected devices
                  and the face records. One place, not two that can disagree. */}
                    {account.is_admin && (
                      <>
                        <Button variant="light" component="a" href="/admin/">
                          Amministrazione
                        </Button>
                        <Button
                          variant="light"
                          size="sm"
                          onClick={() => {
                            setRekeyCurrent("");
                            setRekeyNew("");
                            setRekeyConfirm("");
                            setRekeyOpen(true);
                          }}
                        >
                          Cambia password cifratura
                        </Button>
                        {setupData && (
                          <Text size="xs" c="dimmed" ta="center">
                            Utenti: {setupData.users} (admin{" "}
                            {setupData.admins}), volti salvati:{" "}
                            {setupData.people}
                          </Text>
                        )}
                      </>
                    )}
                  </Stack>
                </Fieldset>
              </Stack>
            </AppShell.Section>

            {/* Out of the scrolling area and pinned to the bottom of the panel.
            It used to be the last item in the scroll, so on a short screen you
            had to scroll to log out, and it sat directly under
            "Amministrazione" as a subtle red line of text -- the quietest
            control in the panel for the one action that ends the session.

            Now it is bordered, full width and alone below a divider: told
            apart by its position and its weight, not only by its word. */}
            <AppShell.Section>
              <Divider mb="xs" />
              {/* Ends this session on this device. It posts /logout, the server
              clears the cookie, and the page goes back to the login form --
              nothing on the Pi stops and nobody else is disconnected. */}
              {/* Filled red with white text, not an outline: on a dark panel an
              outlined button reads as background, which is the same mistake
              "Cerca videocamere" was fixed for further up. */}
              <Button
                variant="filled"
                color="red"
                c="white"
                size="md"
                fullWidth
                onClick={onLoggedOut}
              >
                Esci
              </Button>
            </AppShell.Section>
          </AppShell.Aside>
        </MantineProvider>
      </AppShell>

      {/* Opened the moment the network is actually up. The point is the QR:
          the password is long on purpose, and reading it aloud to someone
          holding a phone is where this always went wrong.

          Deliberately NOT inside the dark panels: it is a dialog in the middle
          of the screen, and a QR is read by a camera, so it stays black on
          white whatever the rest of the app is doing. */}
      <Modal
        opened={joinQr !== null}
        onClose={() => setJoinQr(null)}
        title="Collega un telefono a questa rete"
        centered
      >
        <Stack gap="md" align="center">
          <Text size="sm" ta="center">
            Rete <strong>{joinQr?.ssid}</strong>
          </Text>
          {joinQr?.image ? (
            <>
              <Image
                src={joinQr.image}
                alt={`Codice QR per collegarsi alla rete ${joinQr?.ssid}`}
                w={240}
                h={240}
                // A white frame around it, so the code keeps its quiet zone
                // even on a dark page. A QR printed edge-to-edge on a dark
                // background is a QR that will not scan.
                className="rounded-md bg-white p-2"
              />
              <Text size="sm" c="dimmed" ta="center">
                Inquadra il codice con la fotocamera del telefono per collegarti
                senza digitare la password.
              </Text>
            </>
          ) : (
            <Text size="sm" c="dimmed" ta="center">
              La password della rete non e' disponibile su questo server, quindi
              il codice QR non puo' essere creato. Aggiorna l'assistente con{" "}
              <strong>sudo ./deploy/install-ap.sh</strong> e riaccendi la rete.
            </Text>
          )}
          <Text size="sm" ta="center">
            Poi apri <strong>https://{joinQr?.address}:8000</strong>
          </Text>
          <Button fullWidth onClick={() => setJoinQr(null)}>
            Chiudi
          </Button>
        </Stack>
      </Modal>

      {/* Switching the network OFF is asymmetric with switching it on: if the
          device you are reading this on joined through that very network, the
          request succeeds and the answer never arrives, because the network it
          would have come back over no longer exists. The page then sits there
          looking broken. Hence the warning -- and only on the off direction. */}
      {/* The direction that was never asked about, and the one that costs the
          most: on a Raspberry with only WiFi there is a single wlan0, so
          raising the network takes it off the router -- the server loses the
          internet and every device reading this page through the router loses
          the page. */}
      <Modal
        opened={confirmApOn}
        onClose={() => setConfirmApOn(false)}
        title="Creare la rete WiFi?"
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            Questo {accessPoint?.platform === "Windows" ? "PC" : "Raspberry"}{" "}
            smette di usare il WiFi di casa e crea una rete propria
            {accessPoint?.ssid ? (
              <>
                {" "}
                (<strong>{accessPoint.ssid}</strong>)
              </>
            ) : null}
            .
          </Text>
          <Text size="sm" c="dimmed">
            Il server resta senza internet, e chi sta guardando questa pagina
            attraverso il router di casa la perde: per continuare dovra'
            collegarsi alla rete nuova
            {accessPoint?.ap_address ? (
              <> e aprire https://{accessPoint.ap_address}:8000</>
            ) : null}
            .
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setConfirmApOn(false)}>
              Annulla
            </Button>
            <Button
              loading={accessPointBusy}
              onClick={() => {
                setConfirmApOn(false);
                applyAccessPoint(true);
              }}
            >
              Crea la rete
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={confirmApOff}
        onClose={() => setConfirmApOff(false)}
        title="Spegnere la rete WiFi?"
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            I dispositivi collegati a{" "}
            <strong>{accessPoint?.ssid ?? "CameraPi"}</strong> perderanno subito
            la connessione.
          </Text>
          <Text size="sm" c="dimmed">
            Se stai leggendo questa pagina proprio attraverso quella rete,
            perderai il collegamento anche tu: per riaccenderla dovrai tornare
            sul Raspberry o sul PC che esegue il server.
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setConfirmApOff(false)}>
              Annulla
            </Button>
            <Button
              color="red"
              loading={accessPointBusy}
              onClick={() => {
                setConfirmApOff(false);
                applyAccessPoint(false);
              }}
            >
              Spegni la rete
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Reaching a record by name instead of by face. The list is searchable
          because eighty COCO classes already proved that a long list you have
          to scroll is a list you cannot use. */}
      {/* Naming a classifier. Asked BEFORE any photograph is taken, because a
          pile of pictures whose subject you have to remember is the thing this
          exists to stop. */}
      <Modal
        opened={newObjectOpen}
        onClose={() => setNewObjectOpen(false)}
        title="Nuovo classificatore"
        centered
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Dai un nome all'oggetto che stai per fotografare. Lo potrai
            correggere nella pagina di amministrazione.
          </Text>
          <TextInput
            label="Nome"
            placeholder="Es. Tazza rossa"
            value={newObjectName}
            onChange={(event) => setNewObjectName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && newObjectName.trim()) createObject();
            }}
            maxLength={60}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setNewObjectOpen(false)}>
              Annulla
            </Button>
            <Button
              onClick={createObject}
              loading={creatingObject}
              disabled={!newObjectName.trim()}
            >
              Crea
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* After a classifier is created: Guidata or Raffica. */}
      <Modal
        opened={modeAskOpen}
        onClose={() => setModeAskOpen(false)}
        title="Come vuoi scattare le foto?"
        centered
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Guidata ti accompagna passo per passo; Raffica scatta molte foto in
            una volta.
          </Text>
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                setModeAskOpen(false);
                chooseCaptureMode("burst");
              }}
            >
              Raffica
            </Button>
            <Button
              onClick={() => {
                setModeAskOpen(false);
                startGuided();
              }}
            >
              Guidata
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* What the measurement found.

          The "senza" column is first among equals here on purpose: a candidate
          that boxes the object every time and also boxes something in every
          empty frame has learned to say yes, and reading the recall first
          makes that look like a success. */}
      <Modal
        opened={measurement !== null}
        onClose={() => setMeasurement(null)}
        title="Quale metodo trova il tuo oggetto"
        size="lg"
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Su {measurement?.with_frames ?? 0} fotogrammi con l'oggetto (
            {measurement?.references ?? 1}{" "}
            {measurement?.references === 1 ? "riferimento" : "riferimenti"},
            verificati anche a turno escludendo se stessi
            {measurement?.held_out
              ? `; altri ${measurement.held_out} senza riquadro`
              : ""}
            ) e {measurement?.without_frames ?? 0} senza.
            {!measurement?.without_frames && (
              <>
                {" "}
                Senza fotogrammi "senza", i falsi positivi non sono misurabili:
                e' il numero che decide se un metodo e' utilizzabile.
              </>
            )}
          </Text>
          {/* layout="fixed" (with widths below) rather than the default
              "auto": an auto table gives every column its full single-line
              width and overflows the modal instead of wrapping, which is why
              the button's own white-space: normal did nothing on its own --
              there was no narrower column forcing it to actually wrap. */}
          <Table striped withTableBorder verticalSpacing="md" layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w="20%">Metodo</Table.Th>
                <Table.Th w="16%">Trovato</Table.Th>
                <Table.Th w="14%">Falsi</Table.Th>
                <Table.Th w="12%">ms</Table.Th>
                <Table.Th w="38%" />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(measurement?.rows ?? []).map((row) => {
                const active =
                  objectDetail?.detector &&
                  objectDetail.detector.method === row.name;
                return (
                  <Table.Tr key={row.name}>
                    <Table.Td>
                      {row.name}
                      {/* template caps itself well below the other two
                          methods (see MAX_TEMPLATE_REFERENCES in
                          object_localisers.py): only worth saying when it is
                          actually dropping some of what was offered. */}
                      {row.name === "template" &&
                        row.usable_references != null &&
                        measurement?.references > row.usable_references && (
                          <Text size="xs" c="dimmed">
                            usa solo le prime {row.usable_references} foto
                          </Text>
                        )}
                    </Table.Td>
                    <Table.Td>
                      {row.error
                        ? "—"
                        : row.separates
                          ? `${row.recall}%`
                          : "non separa"}
                    </Table.Td>
                    <Table.Td>
                      {row.error || !row.separates ? "—" : `${row.false_rate}%`}
                    </Table.Td>
                    <Table.Td>{row.error ? row.error : row.ms}</Table.Td>
                    <Table.Td>
                      {/* Only where separates: a method that cannot tell the
                          object from an empty room has nothing to activate. */}
                      {!row.error && row.separates && (
                        <Button
                          size="compact-xs"
                          variant={active ? "filled" : "light"}
                          color={active ? "green" : "blue"}
                          loading={activatingMethod === row.name}
                          disabled={
                            activatingMethod !== null &&
                            activatingMethod !== row.name
                          }
                          onClick={() => activateClassifier(row.name)}
                          fullWidth
                          styles={{
                            root: { height: "auto", padding: "6px 8px" },
                            label: {
                              whiteSpace: "normal",
                              textAlign: "center",
                              lineHeight: 1.2,
                            },
                          }}
                        >
                          {active
                            ? "In uso per il rilevamento"
                            : "Usa per il rilevamento"}
                        </Button>
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
          <Text size="xs" c="dimmed">
            "Trovato" e' con la soglia migliore possibile su questi dati. "Non
            separa" significa che i punteggi con e senza l'oggetto si
            sovrappongono del tutto: nessuna soglia puo' distinguerli.
          </Text>
          {(measurement?.sheets ?? []).map((sheet) => (
            <Stack key={sheet} gap={4}>
              <Text size="xs">
                {sheet.replace("sheet-", "").replace(".png", "")}
              </Text>
              <Image src={`${API_BASE}/objects/sheet/${sheet}`} radius="sm" />
            </Stack>
          ))}
        </Stack>
      </Modal>

      {/* Drawing the box round the object.

          FULL SCREEN ON A PHONE, and that is a fix rather than a preference.
          At size="lg" the picture, the hint line and the button row together
          overflowed the viewport and left Salva half off the bottom -- and the
          canvas has touch-action: none so it can be drawn on, which means a
          finger cannot scroll the dialog to reach a button below the fold. The
          picture takes the space that is left instead of a fixed 60vh, and the
          buttons sit above it, where nothing can push them away. */}
      <Modal
        opened={editingView !== null}
        onClose={() => {
          setEditingView(null);
          setReferenceBox(null);
        }}
        title="Disegna il riquadro attorno all'oggetto"
        size="lg"
        fullScreen={wideScreen !== true}
      >
        <Stack gap="md">
          <BoxPicker
            src={editingView ? `${API_BASE}/objects/view/${editingView}` : null}
            box={referenceBox}
            onChange={setReferenceBox}
            disabled={savingBox}
          />
          {/* BELOW the picture, not above it -- and that is the second answer
              to the same complaint, not a return to the first.

              Moving these to the top did put them on screen, and put them
              exactly where a toast lands: the capture's own "8 foto salvate"
              sits at the top of the viewport, and a toast outranks a modal, so
              elementFromPoint found an <li> over the Salva button. Measured,
              not guessed -- the button reported a perfectly good rectangle
              throughout.

              At the bottom of a full-screen dialog with a bounded picture the
              row fits without scrolling (header + hint + 50vh + buttons is
              well under one phone screen) and nothing floats over it. */}
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                setEditingView(null);
                setReferenceBox(null);
              }}
            >
              Annulla
            </Button>
            <Button
              onClick={saveViewBox}
              loading={savingBox}
              disabled={!referenceBox}
            >
              Salva riquadro
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={pickOpen}
        onClose={() => setPickOpen(false)}
        title="Aggiungi questa inquadratura a…"
        // Near the top rather than centred, where the phone's keyboard covered
        // it -- but under the toasts (they start 56 px down, see main.jsx, and
        // a three-line one ends at about 170 px), which covered its title.
        yOffset={180}
        // Mantine caps a dialog at the screen height minus TWICE its offset.
        // With the phone's keyboard up that left ~120 px: the field scrolled
        // out of sight and its list closed as it opened. It may use all the
        // height below it instead.
        classNames={{ content: "!max-h-[calc(100dvh-190px)]" }}
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            L'inquadratura attuale viene aggiunta alla persona scelta, così la
            prossima volta verrà riconosciuta anche da questa angolazione.
          </Text>
          <Select
            data={people.map((person) => ({
              value: person.id,
              label:
                `${person.name} ${person.surname}`.trim() +
                ` — ${person.samples} inquadrature`,
            }))}
            value={pickValue}
            onChange={setPickValue}
            searchable
            nothingFoundMessage="Nessuna persona salvata"
            placeholder="Scegli una persona"
            maxDropdownHeight={280}
            withinPortal
            // Not focused on opening: that raised the phone's keyboard at once,
            // which pushed the dialog around. It opens when the field is tapped.
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPickOpen(false)}>
              Annulla
            </Button>
            <Button
              disabled={!pickValue}
              loading={addingView}
              onClick={async () => {
                setPickOpen(false);
                // From the strip: its picture; from the live video: null, and
                // the face selected there is used as before.
                const images = pickImagesRef.current;
                const entry = images ? stripEntryRef.current : null;
                pickImagesRef.current = null;
                const updated = await addViewToSelected(
                  pickValue,
                  images ?? undefined,
                  entry?.id,
                );
                if (updated && entry) deleteSaved(entry); // saved: it leaves the strip
              }}
            >
              Aggiungi
            </Button>
          </Group>
        </Stack>
      </Modal>

      <FaceEnrollModal
        opened={enrollOpen}
        onClose={() => setEnrollOpen(false)}
        onSubmit={submitEnrol}
        preview={enrollPreview}
        judges={faceJudges}
        defaultJudge={defaultJudge}
        saving={savingFace}
        person={enrollPerson}
        onAddView={
          stripFaceImage ? () => addStripViewTo(enrollPerson?.id) : undefined
        }
        onDetails={
          stripFaceImage
            ? () => {
                setEnrollOpen(false);
                setPinnedSnapshot(enrollPerson);
              }
            : undefined
        }
        onPickPerson={stripFaceImage ? pickPersonForStrip : undefined}
        position={
          stripFaceImage ? (stripEntryRef.current?.position ?? null) : null
        }
        addingView={addingView}
      />

      {/* Pinned by "Dettagli" and closed only by its own button: the caption
          under the video follows whoever is in front of the camera, so it is
          gone the moment you look away from the screen to talk to the person.
          This covers the screen and does not move. */}
      <FaceRecord
        person={pinnedPerson}
        judges={faceJudges}
        onClose={() => setPinnedSnapshot(null)}
      />
    </>
  );
}

// Decides what the whole page shows: the login form, or the camera.
// It asks the server (GET /me) instead of trusting anything stored in the
// browser, because the session cookie is unreadable to JavaScript by design
// (HttpOnly) and only the server can say whether it is still valid.
function App() {
  const [setupData, setSetupData] = useState({ users: 0, admins: 0, people: 0 });
  const [account, setAccount] = useState(null);
  const [checked, setChecked] = useState(false);
  // First-run setup: whether the server needs a database passphrase and
  // default accounts before anything else can happen.
  const [setup, setSetup] = useState(null); // null = not checked yet
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupPassphrase, setSetupPassphrase] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  // Change database passphrase (administrator only, after first run).
  const [rekeyOpen, setRekeyOpen] = useState(false);
  const [rekeyBusy, setRekeyBusy] = useState(false);
  const [rekeyCurrent, setRekeyCurrent] = useState("");
  const [rekeyNew, setRekeyNew] = useState("");
  const [rekeyConfirm, setRekeyConfirm] = useState("");

  async function loadSetupStatus() {
    try {
      const response = await fetch(`${API_BASE}/setup/status`, SEND_COOKIE);
      if (response.ok) {
        const data = await response.json();
        setSetup(data);
        return data;
      }
    } catch {
      // Server unreachable: stays null, login will fail too and show its own
      // "Impossibile contattare il server" error.
    }
    return null;
  }

  async function submitSetupPassphrase(event) {
    event.preventDefault();
    if (!setupPassphrase || setupPassphrase !== setupConfirm) return;
    setSetupBusy(true);
    try {
      const response = await fetch(`${API_BASE}/setup/passphrase`, {
        method: "POST",
        headers: jsonHeaders(),
        ...SEND_COOKIE,
        body: JSON.stringify({ passphrase: setupPassphrase }),
      });
      const data = await response.json();
      if (response.ok && data.ok) {
        // Setup complete: reload so the server now opens the encrypted stores
        // with the chosen passphrase and the normal login flow resumes.
        window.location.reload();
        return;
      }
      toast.error(data.detail || "Impossibile impostare la passphrase.", {
        id: "setup",
      });
    } catch {
      toast.error("Impossibile contattare il server.", { id: "setup" });
    } finally {
      setSetupBusy(false);
    }
  }

  async function submitRekey(event) {
    event.preventDefault();
    if (!rekeyCurrent || !rekeyNew || rekeyNew !== rekeyConfirm) return;
    if (rekeyNew.length < 8) return;
    setRekeyBusy(true);
    try {
      const response = await fetch(`${API_BASE}/setup/rekey`, {
        method: "POST",
        headers: jsonHeaders(),
        ...SEND_COOKIE,
        body: JSON.stringify({
          current_passphrase: rekeyCurrent,
          new_passphrase: rekeyNew,
        }),
      });
      const data = await response.json();
      if (response.ok && data.ok) {
        setRekeyOpen(false);
        setRekeyCurrent("");
        setRekeyNew("");
        setRekeyConfirm("");
        toast.success("Password di cifratura cambiata.", { id: "rekey" });
        return;
      }
      toast.error(data.detail || "Impossibile cambiare la password.", {
        id: "rekey",
      });
    } catch {
      toast.error("Impossibile contattare il server.", { id: "rekey" });
    } finally {
      setRekeyBusy(false);
    }
  }

  async function loadAccount() {
    try {
      const response = await fetch(`${API_BASE}/me`, SEND_COOKIE);
      setAccount(response.ok ? await response.json() : null);
    } catch {
      setAccount(null);
    } finally {
      setChecked(true);
    }
  }

  useEffect(() => {
    async function init() {
      const status = await loadSetupStatus();
      setChecked(true);
      if (!status?.first_run) {
        await loadAccount();
      }
    }
    init();
  }, []);

  useEffect(() => {
    if (!account || !account.is_admin) return;
    async function loadSetupDataInfo() {
      try {
        const response = await fetch(`${API_BASE}/setup/data-info`, SEND_COOKIE);
        if (response.ok) setSetupData(await response.json());
      } catch {
        // Silente: il server potrebbe non rispondere.
      }
    }
    loadSetupDataInfo();
  }, [account]);

  async function logout() {
    try {
      await fetch(`${API_BASE}/logout`, { method: "POST", ...SEND_COOKIE });
    } catch (error) {
      console.error("Logout failed:", error);
    }
    setAccount(null);
  }

  // Until the server has answered we show nothing: rendering the login form
  // first would make it flash on screen for already-logged-in users.
  if (!checked) return null;

  // First run: no database and no passphrase yet. Show the setup modal
  // instead of the login form. The modal cannot be dismissed until a
  // passphrase is chosen and submitted.
  if (setup?.first_run && !setup.passphrase_set) {
    return (
      <div className="flex items-center justify-center min-h-screen p-6 box-border">
        <Paper
          component="form"
          onSubmit={submitSetupPassphrase}
          className="flex flex-col gap-4 w-full max-w-80 p-7 border border-[#444] rounded-lg
                     dark:bg-[var(--mantine-color-dark-5)]"
          withBorder
          shadow="md"
          radius="md"
          p="xl"
        >
          <Stack gap="md">
            <Title order={1} size="h2" ta="center">
              Prima configurazione
            </Title>
            <Text size="sm" ta="center">
              Non esiste ancora un database cifrato. Scegli la password con cui
              saranno cifrati gli archivi dell'applicazione. Non c'e' recupero
              se la dimentichi: annotala fuori da questa macchina.
            </Text>
            <TextInput
              label="Password di cifratura"
              value={setupPassphrase}
              autoComplete="new-password"
              onChange={(e) => setSetupPassphrase(e.currentTarget.value)}
            />
            <TextInput
              label="Conferma password"
              value={setupConfirm}
              autoComplete="new-password"
              onChange={(e) => setSetupConfirm(e.currentTarget.value)}
            />
            <Button
              type="submit"
              loading={setupBusy}
              disabled={
                !setupPassphrase ||
                setupPassphrase !== setupConfirm ||
                setupPassphrase.length < 8
              }
              fullWidth
            >
              {setupBusy ? "Imposta…" : "Imposta la password"}
            </Button>
          </Stack>
        </Paper>
      </div>
    );
  }

  {/* Change database passphrase modal (administrator only). */}
  <Modal
    opened={rekeyOpen}
    onClose={() => setRekeyOpen(false)}
    title="Cambia password di cifratura"
    centered
  >
    <form onSubmit={submitRekey}>
      <Stack gap="md" p="xl">
        <Title order={3} size="h4">
          Cambia la password con cui sono cifrati gli archivi dell'applicazione.
          I dati non vengono toccati: cambia solo la chiave di protezione.
        </Title>
        <TextInput
          label="Password attuale"
          value={rekeyCurrent}
          autoComplete="current-password"
          onChange={(e) => setRekeyCurrent(e.currentTarget.value)}
        />
        <TextInput
          label="Nuova password"
          value={rekeyNew}
          autoComplete="new-password"
          onChange={(e) => setRekeyNew(e.currentTarget.value)}
        />
        <TextInput
          label="Conferma nuova password"
          value={rekeyConfirm}
          autoComplete="new-password"
          onChange={(e) => setRekeyConfirm(e.currentTarget.value)}
        />
        <Button
          type="submit"
          loading={rekeyBusy}
          disabled={
            !rekeyCurrent ||
            !rekeyNew ||
            rekeyNew !== rekeyConfirm ||
            rekeyNew.length < 8
          }
          fullWidth
        >
          {rekeyBusy ? "Cambia…" : "Cambia password"}
        </Button>
      </Stack>
    </form>
  </Modal>

  if (!account) {
    return (
      <Login
        apiBase={API_BASE}
        sendCookie={SEND_COOKIE}
        onLoggedIn={setAccount}
      />
    );
  }

  return <CameraApp account={account} onLoggedOut={logout} setupData={setupData} setRekeyOpen={setRekeyOpen} setRekeyCurrent={setRekeyCurrent} setRekeyNew={setRekeyNew} setRekeyConfirm={setRekeyConfirm} />;
}

export default App;
