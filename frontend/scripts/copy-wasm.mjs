// Copies the WebAssembly runtime MediaPipe needs into public/wasm/, so it is
// served from this machine at a known URL.
//
// MediaPipe fetches these from a CDN by default, because FilesetResolver takes
// a URL at runtime and a bundler cannot see through it. The Raspberry Pi is on
// a LAN that may have no internet at all, and the whole point of the app is
// that it works there -- so the files have to come from us.
//
// Run automatically by the prebuild/predev npm scripts. Only the variants that
// are actually requested at runtime are copied; node_modules holds ~130 MB of
// builds for platforms we never hit.
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const FILES = [
  // MediaPipe picks the SIMD build, falling back to nosimd on older browsers.
  // vision_wasm_module_internal.* is for the graph API, which we do not use.
  ["node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js", "public/wasm/mediapipe/vision_wasm_internal.js"],
  ["node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm", "public/wasm/mediapipe/vision_wasm_internal.wasm"],
  ["node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.js", "public/wasm/mediapipe/vision_wasm_nosimd_internal.js"],
  ["node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm", "public/wasm/mediapipe/vision_wasm_nosimd_internal.wasm"],
  // The UMD build of the Tasks API, for the detection worker. It has to be
  // the UMD one and it has to be fetched with importScripts: MediaPipe's WASM
  // loader registers its module factory that way, and a module worker loading
  // the ES build dies with "ModuleFactory not set".
  ["node_modules/@mediapipe/tasks-vision/vision_bundle.js", "public/wasm/mediapipe/vision_bundle.js"],
  // onnxruntime-web is gone: object detection moved to MediaPipe's
  // ObjectDetector, which uses the runtime above. That removed a 27 MB
  // WebAssembly download that never successfully started in a browser.
];

let copied = 0;
let skipped = 0;
for (const [from, to] of FILES) {
  const source = join(root, from);
  const target = join(root, to);
  if (!existsSync(source)) {
    console.error(`copy-wasm: missing ${from} -- run npm install`);
    process.exit(1);
  }
  // Skip unchanged files: these are up to 27 MB each and the build runs often.
  if (existsSync(target) && statSync(target).size === statSync(source).size) {
    skipped++;
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  copied++;
}
console.log(`copy-wasm: ${copied} copied, ${skipped} already current`);
