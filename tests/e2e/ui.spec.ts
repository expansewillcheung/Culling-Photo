import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// UI regressions found by exploratory testing (focus / selection under filters, compare marking,
// toolbar layout, loupe error state, status timings).

const FILES = [
  ['raw', 'Canon___EOS_R6_Mark_II___3_2.cr3', 'IMG_0001.CR3'],
  ['raw', 'Nikon___Z_8___8bit_8bit_compressed__3_2_.NEF', 'IMG_0002.NEF'],
  ['gen', 'DSC01234.JPG', 'IMG_0003.JPG'],
  ['gen', 'photo.jpg', 'IMG_0004.jpg'],
  ['gen', 'rotated6.jpg', 'IMG_0005.jpg'],
  ['gen', 'photo.png', 'IMG_0006.png'],
] as const;

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'culling-ui-'));
  for (const [d, src, name] of FILES) fs.copyFileSync(path.resolve('tests/fixtures', d, src), path.join(dir, name));
  // a file that looks like a photo but cannot be decoded
  fs.writeFileSync(path.join(dir, 'IMG_0007.jpg'), 'not a jpeg');
  return dir;
}

async function open(page: Page, dir: string) {
  await page.getByTestId('open-readonly').setInputFiles(dir);
  await page.waitForFunction(() => !!(window as any).__culling?.store.state.progress.allThumbsAt, null, { timeout: 120_000 });
}

const st = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__culling.store;
    const name = (id: number) => s.state.photos[id]?.stem;
    return {
      view: s.state.view as string,
      cur: name(s.state.current) as string,
      sel: s.state.selection.map(name) as string[],
      ids: s.viewIds().map(name) as string[],
      flags: Object.fromEntries(s.state.photos.map((p: any) => [p.stem, p.flag])) as Record<string, number>,
      ratings: Object.fromEntries(s.state.photos.map((p: any) => [p.stem, p.rating])) as Record<string, number>,
    };
  });

test('focus, selection and marking follow what is visible', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const dir = makeDir();
  await page.goto('/');
  await open(page, dir);

  // Initial focus is the first cell of the (time-sorted) grid.
  let s = await st(page);
  expect(s.cur).toBe(s.ids[0]);

  // Sort select gives the keyboard back: arrows navigate photos, not sort options.
  await page.locator('select[title=排序]').selectOption('name');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  s = await st(page);
  expect(s.cur).toBe('IMG_0002');
  expect(await page.evaluate(() => (window as any).__culling.store.state.sort)).toBe('name');

  // Under 未标记, picking hides the photo: focus moves to the next one, and the next P marks that one.
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: /^未标记/ }).click();
  await page.keyboard.press('p');
  s = await st(page);
  expect(s.cur).toBe('IMG_0002');
  await page.keyboard.press('p');
  s = await st(page);
  expect(s.flags).toMatchObject({ IMG_0001: 1, IMG_0002: 1 });
  expect(s.cur).toBe('IMG_0003');

  // Auto-advance does not skip a photo when the mark already moved focus.
  await page.keyboard.press('a');
  await page.keyboard.press('x');
  s = await st(page);
  expect(s.cur).toBe('IMG_0004');
  await page.keyboard.press('a');
  await page.getByRole('button', { name: /^全部/ }).click();

  // A filter drops hidden photos from the selection, so marks never reach them.
  await page.keyboard.press('Control+a');
  await page.getByRole('button', { name: /^保留/ }).click();
  s = await st(page);
  expect(s.ids).toEqual(['IMG_0001', 'IMG_0002']);
  expect(s.sel.sort()).toEqual(['IMG_0001', 'IMG_0002']);
  await page.keyboard.press('3');
  s = await st(page);
  expect(s.ratings).toMatchObject({ IMG_0001: 3, IMG_0002: 3, IMG_0003: 0, IMG_0004: 0 });
  await page.getByRole('button', { name: /^全部/ }).click();

  // Compare: Z zooms all panes; marks go to the active photo only, not the whole compared set.
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('c');
  await expect(page.getByTestId('viewer')).toHaveCount(3);
  await page.keyboard.press('z');
  await expect(page.locator('.zoomtag').first()).toHaveText('100%');
  await page.keyboard.press('z');
  await page.keyboard.press('u');
  s = await st(page);
  expect(s.cur).toBe('IMG_0003');
  expect(s.flags).toMatchObject({ IMG_0001: 1, IMG_0002: 1, IMG_0003: 0 });
  await page.keyboard.press('g');
  await expect(page.locator('.zoomtag')).toHaveCount(0);

  // An undecodable photo says so in the loupe instead of a blank canvas with a bogus zoom.
  await page.keyboard.press('Escape');
  await page.keyboard.press('End');
  expect((await st(page)).cur).toBe('IMG_0007');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('viewer')).toContainText('无法预览');
  await expect(page.locator('.zoomtag')).toHaveCount(0);
  await page.keyboard.press('g');

  // Re-opening shows fresh (non-negative) timings in the status bar.
  await page.getByTitle('关闭文件夹').click();
  await open(page, dir);
  const pr = await page.evaluate(() => ({ ...(window as any).__culling.store.state.progress }));
  expect(pr.allThumbsAt).toBeGreaterThanOrEqual(pr.startedAt);
  await expect(page.getByTestId('status')).not.toContainText('-');

  expect(errors).toEqual([]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('toolbar fits on one row at 1280px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const dir = makeDir();
  await page.goto('/');
  await open(page, dir);
  const first = await page.getByTitle('关闭文件夹').boundingBox();
  const deliver = await page.getByTestId('deliver-btn').boundingBox();
  expect(Math.abs(deliver!.y - first!.y)).toBeLessThan(4);
  expect(deliver!.x + deliver!.width).toBeLessThanOrEqual(1280);
  fs.rmSync(dir, { recursive: true, force: true });
});
