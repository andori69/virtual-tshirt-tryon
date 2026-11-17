// Copies MediaPipe WASM runtime and downloads model files into public/ so the kiosk runs offline.
import { mkdir, cp, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'mediapipe');

const models = {
  'pose_landmarker_full.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  'selfie_segmenter.tflite':
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
};

await mkdir(join(out, 'wasm'), { recursive: true });
await cp(join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'), join(out, 'wasm'), { recursive: true });
console.log('copied wasm runtime');

for (const [name, url] of Object.entries(models)) {
  const dest = join(out, name);
  try {
    await access(dest);
    console.log(`exists: ${name}`);
    continue;
  } catch {}
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`downloaded: ${name}`);
}
