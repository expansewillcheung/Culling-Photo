import { test } from '@playwright/test';
import path from 'node:path';

// Diagnostic: Chrome trace of main-thread tasks while scrolling during thumbnailing.
test('trace scroll', async ({ page, browser }) => {
  test.setTimeout(600_000);
  await page.goto('/');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('culling-cache', { recursive: true }).catch(() => {});
  });
  await page.getByTestId('open-readonly').setInputFiles(path.resolve('bench-data/shoot-600'));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=cell] img').length > 10, null, { timeout: 60000 });
  await browser.startTracing(page, { path: 'test-results/scroll-trace.json', categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
  await page.getByTestId('grid').hover();
  for (let i = 0; i < 20; i++) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(2000);
  await browser.stopTracing();
  console.log(JSON.stringify(await page.evaluate(() => (globalThis as any).__perf)));
});
