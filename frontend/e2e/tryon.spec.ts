import fs from 'node:fs';
import path from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';

// Opt-in try-on cases: one fake-camera clip per case.
// VFR_CASES=/abs/dir npx playwright test e2e/tryon.spec.ts   (dir holds <case>.y4m; front.y4m also runs the TEXT test)
// Optional: VFR_SHIRT=<label> picks the shirt (default: first ready shirt), VFR_STYLE=slim|regular|oversized.
// Screenshots and live geometry numbers land in e2e/output/cases/ for review.
const dir = process.env.VFR_CASES;
const cases = dir ? fs.readdirSync(dir).filter((f) => f.endsWith('.y4m')).map((f) => f.replace(/\.y4m$/, '')).sort() : [];
const out = path.join('e2e', 'output', 'cases');

type Stats = {
  hemY: number; collarFrontY: number; collarTopY: number; chinY: number | null; W: number; H: number;
  hipsVisible: boolean; yaw: number; span: number; visibleLengthFrac: number; fps: number; widthRatio: number | null;
  head: { center: { x: number; y: number }; rx: number; ry: number } | null;
};

async function startCase(page: Page, shirt?: string) {
  await page.goto('/');
  const list = page.getByRole('list', { name: 'Shirts' });
  const btn = shirt ? list.getByRole('button', { name: shirt }) : list.getByRole('button').and(page.locator(':enabled')).first();
  await expect(btn).toBeVisible({ timeout: 60_000 });
  await btn.click();
  if (process.env.VFR_STYLE) await page.getByRole('radio', { name: new RegExp(process.env.VFR_STYLE, 'i') }).click();
  await expect(page.locator('.pill').first()).toHaveText('Tracking', { timeout: 120_000 });
  // VFR_DEBUG=wireframe,landmarks,mask turns on the kiosk's debug views (Alt+D panel).
  const dbg = (process.env.VFR_DEBUG ?? '').split(',').filter(Boolean);
  if (dbg.length) {
    await page.keyboard.press('Alt+KeyD');
    for (const k of dbg) await page.getByLabel(k).check();
  }
  await page.waitForTimeout(2500); // springs, light estimate and fade settle
}

const stats = (page: Page) => page.evaluate(() => (window as unknown as { __vfr: Stats | null }).__vfr);

function checkGeometry(s: Stats) {
  expect(s, 'shirt is drawn').not.toBeNull();
  expect(s.hemY, 'hem stays inside the frame').toBeLessThanOrEqual(s.H + 1);
  if (s.chinY != null) expect(s.collarFrontY, 'crew front sits below the chin').toBeGreaterThan(s.chinY);
  if (s.head) expect(s.collarFrontY, 'collar is below the face ellipse centre').toBeGreaterThan(s.head.center.y);
  // Regular fit: drawn chest no more than 1.4x the measured body chest (when the silhouette could measure it).
  if (s.widthRatio != null && (process.env.VFR_STYLE ?? 'regular') === 'regular') {
    expect(s.widthRatio, 'shirt is not poncho-wide').toBeLessThanOrEqual(1.4);
    expect(s.widthRatio, 'shirt covers the body').toBeGreaterThanOrEqual(0.95);
  }
}

/** A browser whose webcam plays this case's clip (the fake-camera file is a launch flag, so one browser per case). */
async function casePage(name: string, baseURL: string | undefined) {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${path.join(dir!, `${name}.y4m`)}`],
  });
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, permissions: ['camera'] });
  return { browser, page: await ctx.newPage() };
}

for (const name of cases) {
  test.describe(name, () => {
    test(`try-on: ${name}`, async ({ baseURL }) => {
      const { browser, page } = await casePage(name, baseURL);
      test.setTimeout(240_000);
      fs.mkdirSync(out, { recursive: true });
      await startCase(page, process.env.VFR_SHIRT);
      if (name.startsWith('stepback')) { // too close / hips out of frame: guide shown, no drifting shirt
        await expect(page.getByText(/Step back/)).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('.step-guide')).toBeVisible();
        await page.locator('.kiosk-stage').screenshot({ path: path.join(out, `${name}.png`) });
        await browser.close();
        return;
      }
      const moving = /^(sway|walk)/.test(name);
      const samples: Stats[] = [];
      for (let i = 0; i < (moving ? 4 : 1); i++) {
        if (i) await page.waitForTimeout(1500);
        samples.push((await stats(page))!);
        await page.locator('.kiosk-stage').screenshot({ path: path.join(out, moving ? `${name}-${i + 1}.png` : `${name}.png`) });
      }
      // Jitter: on a still clip the collar and hem must hold steady frame to frame.
      const steady: Stats[] = [];
      if (!moving) for (let i = 0; i < 15; i++) { steady.push((await stats(page))!); await page.waitForTimeout(100); }
      fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(samples.length > 1 ? samples : samples[0], null, 1));
      await browser.close();
      samples.forEach(checkGeometry);
      const sd = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + (x - v.reduce((a, b) => a + b, 0) / v.length) ** 2, 0) / v.length);
      if (steady.length) {
        // Jitter limit scales with how big the person is on screen: 1% of shoulder span, at least 1.5 px.
        const lim = Math.max(1.5, 0.01 * steady[0].span);
        expect(sd(steady.map((s) => s.collarFrontY)), 'collar jitter (px)').toBeLessThanOrEqual(lim);
        expect(sd(steady.map((s) => s.hemY)), 'hem jitter (px)').toBeLessThanOrEqual(lim);
      }
    });

    if (name === 'front') {
      test('TEXT print reads correctly (never mirrored)', async ({ baseURL }) => {
        const { browser, page } = await casePage(name, baseURL);
        test.setTimeout(240_000);
        fs.mkdirSync(out, { recursive: true });
        // A white tee with "TEXT" plus a red block on the print's left and a blue block on its right.
        await page.goto('/');
        const png = await page.evaluate(() => {
          const c = document.createElement('canvas');
          c.width = c.height = 1024;
          const g = c.getContext('2d')!;
          const outline = [[400, 120], [300, 150], [130, 260], [200, 420], [270, 380], [270, 900], [730, 900], [730, 380],
            [800, 420], [870, 260], [700, 150], [600, 120], [575, 165], [500, 185], [425, 165]];
          g.beginPath();
          outline.forEach(([x, y], i) => (i ? g.lineTo(x * 1.024, y * 1.024) : g.moveTo(x * 1.024, y * 1.024)));
          g.closePath();
          g.fillStyle = '#f2f2f2';
          g.fill();
          g.fillStyle = '#e01010'; g.fillRect(330, 300, 110, 110);
          g.fillStyle = '#1030e0'; g.fillRect(590, 300, 110, 110);
          g.fillStyle = '#111';
          g.font = 'bold 150px sans-serif';
          g.textAlign = 'center';
          g.fillText('TEXT', 512, 590);
          return c.toDataURL('image/png').split(',')[1];
        });
        const A = (x: number, y: number) => ({ x: (x * 1.024) / 1024, y: (y * 1.024) / 1024 });
        const anchors = {
          left_shoulder: A(316, 150), right_shoulder: A(684, 150), neckline_center: A(500, 120),
          left_sleeve: A(165, 340), right_sleeve: A(835, 340), left_hem: A(270, 900), right_hem: A(730, 900), bottom_center: A(500, 900),
        };
        await page.route('**/test-text-shirt.png', (r) => r.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }));
        await page.route('**/api/wardrobe', (r) => r.fulfill({
          contentType: 'application/json',
          body: JSON.stringify([{ id: 'text', file: 'text.png', label: 'TEXT test', status: 'ready', error: null,
            garment_url: '/test-text-shirt.png', thumb_url: '/test-text-shirt.png', back_url: null, anchors,
            attributes: { base_color_hex: '#f2f2f2', sleeve_length: 'short' } }]),
        }));
        await startCase(page, 'TEXT test');
        const shot = path.join(out, 'text.png');
        await page.locator('.kiosk-stage').screenshot({ path: shot });
        // Red must appear left of blue on screen, as on the product photo.
        const order = await page.evaluate(async (b64) => {
          const img = new Image();
          img.src = `data:image/png;base64,${b64}`;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.width; c.height = img.height;
          const g = c.getContext('2d')!;
          g.drawImage(img, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let rx = 0, rn = 0, bx = 0, bn = 0;
          for (let i = 0; i < d.length; i += 4) {
            const [r, gg, b] = [d[i], d[i + 1], d[i + 2]], x = (i / 4) % c.width;
            if (r > 120 && r > 2.2 * gg && r > 2.2 * b) { rx += x; rn++; }
            if (b > 120 && b > 2.2 * r && b > 1.8 * gg) { bx += x; bn++; }
          }
          return { red: rn ? rx / rn : null, blue: bn ? bx / bn : null, rn, bn };
        }, fs.readFileSync(shot).toString('base64'));
        fs.writeFileSync(path.join(out, 'text.json'), JSON.stringify(order));
        await browser.close();
        expect(order.rn).toBeGreaterThan(200);
        expect(order.bn).toBeGreaterThan(200);
        expect(order.red!).toBeLessThan(order.blue!);
      });
    }
  });
}

if (!cases.length) test('try-on cases', () => test.skip(true, 'set VFR_CASES to a folder of <case>.y4m clips'));
