import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';

// Opt-in measurement check on a folder of labelled person photos (e.g. the FIT dataset, see docs/TESTING.md).
// VFR_DATASET=/abs/dir npx playwright test e2e/dataset.spec.ts
// The folder holds meta.json ([{ id, body_height, ... }]) and <id>_person.jpg. The kiosk's own tracker and
// body code run on each photo; raw pixel measurements land in <dir>/measurements.json for offline scoring.
const dir = process.env.VFR_DATASET;
test.skip(!dir, 'set VFR_DATASET to a folder with meta.json and <id>_person.jpg');

test('measure bodies in labelled photos', async ({ page }) => {
  const meta: { id: string }[] = JSON.parse(fs.readFileSync(path.join(dir!, 'meta.json'), 'utf8'));
  test.setTimeout(60_000 + meta.length * 20_000);
  await page.goto('/');
  const out = [];
  for (const { id } of meta) {
    const file = path.join(dir!, `${id}_person.jpg`);
    if (!fs.existsSync(file)) continue;
    const src = `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;
    const r = await page.evaluate(async (src) => {
      const { Tracker } = await import('/src/vision/tracker.ts');
      const B = await import('/src/vision/body.ts');
      const img = new Image();
      img.src = src;
      await img.decode();
      const W = img.naturalWidth, H = img.naturalHeight;
      // A fresh tracker per photo so tracking state from the previous person can't leak in; a few frames let it settle.
      const tracker = await Tracker.create();
      let res = null;
      for (let i = 1; i <= 5; i++) res = tracker.detect(img as unknown as HTMLVideoElement, i * 33, true);
      tracker.close();
      if (!res?.landmarks) return { W, H, error: 'no person' };
      const body = B.bodyFromLandmarks(res.landmarks, W, H);
      if (!body) return { W, H, error: 'shoulders not visible' };
      let chest = null, chestRun = null, maskTop = null, maskBottom = null;
      if (res.mask && body.torsoLength) {
        const { data, width, height } = res.mask;
        const sMidY = (body.leftShoulder.y + body.rightShoulder.y) / 2;
        const cy = sMidY + body.torsoLength * 0.22;
        chest = B.chestWidthFromMask(data, width, height, body.center.x, cy, W, H, body.shoulderSpan);
        // Ungated mask run at the chest row, to tell "arms merged in" from "centre off the mask" when chest is null.
        const row = Math.round((cy / H) * (height - 1)) * width;
        let l = Math.round((body.center.x / W) * (width - 1)), r = l;
        if (data[row + l] >= 0.5) {
          while (l > 0 && data[row + l - 1] >= 0.5) l--;
          while (r < width - 1 && data[row + r + 1] >= 0.5) r++;
          chestRun = ((r - l + 1) / width) * W;
        }
        for (let y = 0; y < height; y++) {
          let on = false;
          for (let x = 0; x < width && !on; x++) on = data[y * width + x] >= 0.5;
          if (on) { maskTop ??= (y / height) * H; maskBottom = ((y + 1) / height) * H; }
        }
      }
      const lm = res.landmarks;
      const y = (i: number) => (lm[i] && (lm[i].visibility ?? 1) >= B.MIN_VIS ? lm[i].y * H : null);
      return {
        W, H, shoulderSpan: body.shoulderSpan, chest, chestRun, torso: body.torsoLength, visibility: body.visibility,
        inFrame: body.inFrame, maskTop, maskBottom, noseY: y(0), heelY: Math.max(y(29) ?? 0, y(30) ?? 0) || null,
      };
    }, src);
    out.push({ id, ...r });
    console.log(id, JSON.stringify(r));
  }
  fs.writeFileSync(path.join(dir!, 'measurements.json'), JSON.stringify(out, null, 1));
});
