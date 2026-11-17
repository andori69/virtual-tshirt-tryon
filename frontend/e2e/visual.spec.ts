import { expect, test } from '@playwright/test';

// Opt-in visual check of the real kiosk pipeline (MediaPipe + mesh + shader) on a recorded person.
// VFR_FAKE_VIDEO=/abs/path/person.y4m npx playwright test e2e/visual.spec.ts
// Chromium plays the Y4M file as its webcam. Screenshots land in e2e/output/ for human review.
const video = process.env.VFR_FAKE_VIDEO;
test.skip(!video, 'set VFR_FAKE_VIDEO to a .y4m clip of a person');
test.use({
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
  },
});

test('garment renders on a tracked person', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  // First ready shirt from the ./Tshirts folder.
  const shirt = page.getByRole('list', { name: 'Shirts' }).getByRole('button').and(page.locator(':enabled')).first();
  await expect(shirt).toBeVisible({ timeout: 60_000 });
  await shirt.click();
  await expect(page.locator('.pill').first()).toHaveText('Tracking', { timeout: 120_000 });
  await page.keyboard.press('Alt+KeyD');
  await page.waitForTimeout(3000);
  const stage = page.locator('.kiosk-stage');
  await stage.screenshot({ path: 'e2e/output/visual-shirt.png' });
  await page.locator('.kiosk-panel').screenshot({ path: 'e2e/output/visual-panel.png' });

  await page.keyboard.press('Alt+KeyR');
  await page.waitForTimeout(800);
  await stage.screenshot({ path: 'e2e/output/visual-flat.png' });
  console.log('stats:', await page.locator('.stats').textContent());
});
