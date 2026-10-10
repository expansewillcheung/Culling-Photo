import { expect, test } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

// Quick visual smoke: open all fixtures read-only, screenshot grid, loupe, compare.
test('smoke: fixtures render in grid and loupe', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(m.text()));
  const dir = path.resolve('bench-data/smoke');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const d of ['tests/fixtures/raw', 'tests/fixtures/gen'])
    for (const f of fs.readdirSync(d)) fs.linkSync(path.join(d, f), path.join(dir, f));
  await page.goto('/');
  await page.getByTestId('open-readonly').setInputFiles(dir);
  await page.waitForFunction(() => !!(window as any).__culling?.store.state.progress.allThumbsAt, null, { timeout: 120_000 });
  const out = process.env.SHOT_DIR ?? 'test-results';
  await page.screenshot({ path: `${out}/grid.png` });
  const state = await page.evaluate(() => (window as any).__culling.store.state.photos.map((p: any) => ({ n: p.stem, t: p.thumbState, e: p.error, k: p.kinds.join('+'), a: +p.aspect.toFixed(2) })));
  console.log(JSON.stringify(state));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/loupe.png` });
  await page.keyboard.press('z');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${out}/zoom.png` });
  await page.keyboard.press('z');
  await page.keyboard.press('c');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/compare.png` });
  console.log('ERRORS', JSON.stringify(errors.slice(0, 20)));
  expect(state.filter((s: any) => s.t !== 'ready')).toEqual([]);
});
