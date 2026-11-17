import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

const OWNER = process.env.VFR_E2E_USER ?? 'owner';
const PASSWORD = process.env.VFR_E2E_PASSWORD ?? '';
const NAME = `E2E Tee ${Date.now()}`;
const fixture = (f: string) => path.join(import.meta.dirname, 'fixtures', f);
let productUrl = '';

async function login(page: Page) {
  await page.goto('/owner/login');
  await page.getByLabel('Username').fill(OWNER);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });
test.skip(!PASSWORD, 'set VFR_E2E_PASSWORD to the owner password');

test.afterAll(async ({ browser }) => {
  if (!productUrl) return;
  const page = await browser.newPage();
  await login(page);
  const id = productUrl.split('/').pop();
  await page.request.delete(`/api/owner/products/${id}`);
  await page.close();
});

test('protected owner pages redirect to login; wrong password is rejected', async ({ page }) => {
  await page.goto('/owner/products');
  await expect(page.getByRole('heading', { name: 'Owner sign in' })).toBeVisible();
  await page.getByLabel('Username').fill(OWNER);
  await page.getByLabel('Password').fill('definitely-wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Incorrect username or password');
});

test('owner creates, processes and publishes a T-shirt; customer sees it', async ({ page }) => {
  await login(page);

  // Create draft
  await page.getByRole('link', { name: 'Add New T-shirt' }).first().click();
  await page.getByLabel('Name *').fill(NAME);
  await page.getByLabel('Price *').fill('555');
  await page.getByRole('button', { name: 'Save as Draft' }).click();
  await expect(page.getByRole('heading', { name: NAME })).toBeVisible();
  productUrl = page.url();

  // Sizes
  const sizes = { S: ['48', '42', '66', '19'], M: ['51', '44', '69', '20'], L: ['54', '46', '72', '21'] };
  for (const [label, [c, s, l, sl]] of Object.entries(sizes)) {
    const row = page.locator('.size-table tr', { has: page.getByText(label, { exact: true }) });
    await row.getByRole('checkbox').check();
    await page.getByLabel(`${label} Chest width`, { exact: true }).fill(c);
    await page.getByLabel(`${label} Shoulder width`, { exact: true }).fill(s);
    await page.getByLabel(`${label} Body length`, { exact: true }).fill(l);
    await page.getByLabel(`${label} Sleeve length`, { exact: true }).fill(sl);
  }
  await page.getByRole('button', { name: 'Save sizes' }).click();
  await expect(page.locator('.card', { hasText: 'Sizes & measurements' }).getByText('Saved')).toBeVisible();

  // Color
  await page.getByLabel('New color name').fill('Teal');
  await page.getByRole('button', { name: 'Add color' }).click();
  const variant = page.locator('article.variant');
  await expect(variant).toBeVisible();

  // Invalid upload -> useful server error
  await variant.getByLabel('Garment image file').setInputFiles(fixture('not-an-image.png'));
  await variant.getByRole('button', { name: 'Confirm & process' }).click();
  await expect(variant.getByRole('alert').first()).toContainText('not a readable PNG, JPG or WEBP');

  // Real upload -> real background removal
  await variant.getByRole('button', { name: 'Choose another' }).click();
  await variant.getByLabel('Garment image file').setInputFiles(fixture('sample-tee-TEST-FIXTURE.jpg'));
  await variant.getByRole('button', { name: 'Confirm & process' }).click();
  await expect(variant.getByRole('img', { name: 'Processed garment' })).toBeVisible({ timeout: 60_000 });
  await expect(variant.getByRole('img', { name: 'Original garment' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish Product' })).toBeDisabled(); // anchors not confirmed yet

  // Anchor editing via keyboard, then confirm
  const neck = variant.getByRole('slider', { name: 'Neckline center' });
  await neck.focus();
  await page.keyboard.press('ArrowDown');
  await variant.getByRole('button', { name: 'Confirm anchors' }).click();
  await expect(variant.getByRole('button', { name: 'Anchors confirmed ✓' })).toBeVisible();

  // Stock: S sold out
  await variant.locator('.stock-row').getByLabel('S', { exact: true }).fill('0');
  await variant.locator('.stock-row').getByLabel('M', { exact: true }).fill('3');
  await variant.locator('.stock-row').getByLabel('L', { exact: true }).fill('1');
  await variant.getByRole('button', { name: 'Save stock' }).click();
  await expect(page.getByText('Ready to publish.')).toBeVisible();

  // Draft is not visible to customers
  const before = await (await page.request.get('/api/catalog')).json();
  expect(before.some((p: { name: string }) => p.name === NAME)).toBe(false);

  await page.getByRole('button', { name: 'Publish Product' }).click();
  await expect(page.locator('.editor-side .badge-published')).toBeVisible();
  await page.screenshot({ path: 'e2e/output/owner-editor.png', fullPage: true });

  // Customer kiosk
  const kiosk = await page.context().newPage();
  await kiosk.goto('/');
  await kiosk.getByRole('button', { name: new RegExp(NAME) }).click();
  const sizeGroup = kiosk.getByRole('radiogroup', { name: 'Size' });
  await expect(sizeGroup.getByRole('radio', { name: /^S/ })).toBeDisabled();
  await expect(sizeGroup.getByRole('radio', { name: /^M/ })).toHaveAttribute('aria-checked', 'true');
  await expect(kiosk.locator('.price')).toContainText('555');
  // Fake camera stream is live and MediaPipe loaded (no person in the fake pattern).
  await expect.poll(() => kiosk.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(kiosk.locator('.pill').first()).toHaveText(/No one detected|Detecting|Tracking/, { timeout: 45_000 });
  await kiosk.screenshot({ path: 'e2e/output/kiosk.png' });

  // Owner edit propagates
  await page.getByLabel('Price *').fill('600');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText('Saved').first()).toBeVisible();
  await kiosk.getByRole('button', { name: 'End session' }).click();
  await kiosk.getByRole('button', { name: new RegExp(NAME) }).click();
  await expect(kiosk.locator('.price')).toContainText('600');
  await expect(kiosk.getByRole('radiogroup', { name: 'Size' })).toBeVisible();
  await kiosk.getByRole('button', { name: 'End session' }).click();
  await expect(kiosk.getByRole('radiogroup', { name: 'Size' })).toHaveCount(0);
});

test('owner camera capture and calibration UI work with a camera device', async ({ page }) => {
  await login(page);
  await page.goto(productUrl);
  await page.locator('article.variant').getByRole('button', { name: 'Replace image' }).click();
  await page.getByRole('tab', { name: 'Use camera' }).click();
  const capture = page.getByRole('button', { name: 'Capture' });
  await expect(capture).toBeEnabled({ timeout: 15_000 });
  await capture.click();
  await expect(page.getByRole('img', { name: 'Captured garment' })).toBeVisible();
  await page.getByRole('button', { name: 'Retake' }).click();
  await expect(capture).toBeVisible();

  await page.locator('article.variant').getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Preview Virtual Garment' }).click();
  const dialog = page.getByRole('dialog', { name: 'Virtual garment preview' });
  await expect.poll(() => dialog.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(dialog.getByText('Loading body tracking…')).toHaveCount(0, { timeout: 45_000 });
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('link', { name: 'Camera Calibration' }).click();
  const detect = page.getByRole('button', { name: 'Capture & detect' });
  await expect(detect).toBeEnabled({ timeout: 15_000 });
  await detect.click();
  // The fake camera shows no marker, so detection must fail with guidance rather than invent a scale.
  await expect(page.getByRole('alert').first()).toContainText('No ArUco marker found');
});
