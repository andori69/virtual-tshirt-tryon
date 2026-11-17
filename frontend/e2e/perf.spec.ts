import fs from 'node:fs';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';

// Opt-in performance probe: VFR_PERF_VIDEO=/abs/clip.y4m npx playwright test e2e/perf.spec.ts
// Uses full Chromium with the Metal ANGLE backend so WebGL and MediaPipe run on the real GPU (the default headless
// shell renders in software and says nothing about kiosk speed). Prints the GL renderer so the result can be trusted.
const clip = process.env.VFR_PERF_VIDEO;
test.skip(!clip, 'set VFR_PERF_VIDEO to a .y4m clip of a person');

test('frame rate on this machine', async ({ baseURL }) => {
  test.setTimeout(240_000);
  const browser = await chromium.launch({
    channel: 'chromium',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`,
      '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const page = await (await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, permissions: ['camera'] })).newPage();
  await page.goto('/');
  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'none';
  });
  const shirt = page.getByRole('list', { name: 'Shirts' }).getByRole('button').and(page.locator(':enabled')).first();
  await shirt.click();
  await expect(page.locator('.pill').first()).toHaveText('Tracking', { timeout: 120_000 });
  await page.keyboard.press('Alt+KeyD');
  const fps: number[] = [], detect: number[] = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000);
    const t = (await page.locator('.stats').textContent()) ?? '';
    fps.push(Number(t.match(/(\d+) fps/)?.[1] ?? 0));
    detect.push(Number(t.match(/detect ([\d.]+) ms/)?.[1] ?? 0));
  }
  const res = { gpu, fps, detect, fpsMedian: [...fps].sort((a, b) => a - b)[5], stats: await page.locator('.stats').textContent() };
  fs.mkdirSync(path.join('e2e', 'output'), { recursive: true });
  fs.writeFileSync(path.join('e2e', 'output', 'perf.json'), JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res));
  await browser.close();
});
