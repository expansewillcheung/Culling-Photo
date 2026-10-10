import { defineConfig } from '@playwright/test';

const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = Number(process.env.E2E_PORT ?? 5199);
// E2E_PROD=1 runs against the production build (vite preview) instead of the dev server.
const prod = process.env.E2E_PROD === '1';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 300_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    launchOptions: { executablePath: CHROMIUM, args: ['--enable-unsafe-webgpu'] },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: prod ? `npx vite build && npx vite preview --port ${PORT} --strictPort` : `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
