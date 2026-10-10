import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            environment: 'node',
            include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
            exclude: ['**/*.browser.test.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'browser',
            include: ['src/**/*.browser.test.ts', 'tests/browser/**/*.browser.test.ts'],
            testTimeout: 60_000,
            browser: {
              enabled: true,
              headless: true,
              provider: 'playwright',
              instances: [
                {
                  browser: 'chromium',
                  launch: { executablePath: CHROMIUM, args: ['--enable-unsafe-webgpu'] },
                },
              ],
            },
          },
        },
      ],
    },
  }),
);
