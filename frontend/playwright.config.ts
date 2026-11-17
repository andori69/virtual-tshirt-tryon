import { defineConfig } from '@playwright/test';

// Runs against the dev stack (backend :8000 + vite :5173), which must already be running.
// Chromium's built-in fake camera is used so camera code paths run without hardware; it shows a test
// pattern, not a person, so body tracking itself still needs a manual webcam test.
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 900 },
    permissions: ['camera'],
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  },
});
