import { expect, test, type Page } from '@playwright/test';

const FILES = [
  ['raw', 'Canon___EOS_R6_Mark_II___3_2.cr3', 'IMG_0001.CR3'],
  ['raw', 'Nikon___Z_8___8bit_8bit_compressed__3_2_.NEF', 'IMG_0002.NEF'],
  ['raw', 'Sony___ILCE_7M3___14bit_14bit_compressed__3_2_.ARW', 'IMG_0003.ARW'],
  ['gen', 'DSC01234.ARW', 'IMG_0004.ARW'],
  ['gen', 'DSC01234.JPG', 'IMG_0004.JPG'],
  ['gen', 'photo.heic', 'IMG_0005.HEIC'],
  ['gen', 'rotated6.jpg', 'IMG_0006.jpg'],
  ['raw', 'Fujifilm___X_T5___14bit_14bit_compressed__3_2_.RAF', 'IMG_0007.RAF'],
] as const;

/** Copy fixtures into an OPFS folder and open it through the File System Access code path. */
async function openOpfsShoot(page: Page, fresh: boolean) {
  await page.evaluate(
    async ({ files, fresh }) => {
      const root = await navigator.storage.getDirectory();
      if (fresh) {
        await root.removeEntry('e2e-shoot', { recursive: true }).catch(() => {});
        const dir = await root.getDirectoryHandle('e2e-shoot', { create: true });
        for (const [d, src, name] of files) {
          const res = await fetch(`/tests/fixtures/${d}/${src}`);
          const fh = await dir.getFileHandle(name, { create: true });
          const w = await fh.createWritable();
          await res.body!.pipeTo(w);
        }
      }
      const dir = await root.getDirectoryHandle('e2e-shoot');
      await (window as any).__culling.openHandle(dir);
    },
    { files: FILES as any, fresh },
  );
  await page.waitForFunction(() => !!(window as any).__culling.store.state.progress.allThumbsAt, null, { timeout: 120_000 });
}

const marks = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries((window as any).__culling.store.state.photos.map((p: any) => [p.stem, `${p.flag}/${p.rating}/${p.label}`])),
  );

async function listDir(page: Page, path: string) {
  return page.evaluate(async (path) => {
    let d = await (await navigator.storage.getDirectory()).getDirectoryHandle('e2e-shoot');
    for (const p of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(p);
    const out: string[] = [];
    for await (const [n, h] of (d as any).entries()) out.push(h.kind === 'directory' ? n + '/' : n);
    return out.sort();
  }, path);
}

test('mark, persist, xmp, deliver, restore', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await openOpfsShoot(page, true);
  // 7 logical photos (IMG_0004 is RAW+JPEG)
  await expect(page.getByTestId('cell')).toHaveCount(7);
  await page.evaluate(() => (window as any).__culling.store.actions.setState('sort', 'name'));
  await page.keyboard.press('Home');
  await page.keyboard.press('p'); // IMG_0001 pick
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('5'); // IMG_0002 5 stars
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('x'); // IMG_0003 reject
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('p'); // IMG_0004 pick + red
  await page.keyboard.press('6');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('3'); // IMG_0005 3 stars
  await page.keyboard.press('Control+z'); // undo -> 0
  await page.keyboard.press('2'); // 2 stars
  expect(await marks(page)).toMatchObject({ IMG_0001: '1/0/', IMG_0002: '0/5/', IMG_0003: '-1/0/', IMG_0004: '1/0/red', IMG_0005: '0/2/' });

  // Loupe / zoom / compare render without errors
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('viewer')).toBeVisible();
  await page.keyboard.press('z');
  await page.waitForTimeout(800);
  await page.keyboard.press('z');
  await page.keyboard.press('c');
  await expect(page.getByTestId('viewer')).toHaveCount(2);
  await page.keyboard.press('g');

  // XMP sidecars are written (debounced)
  await page.waitForTimeout(1500);
  const files = await listDir(page, '');
  for (const x of ['IMG_0001.xmp', 'IMG_0002.xmp', 'IMG_0003.xmp', 'IMG_0004.xmp', 'IMG_0005.xmp']) expect(files).toContain(x);
  expect(files).not.toContain('IMG_0006.xmp');
  const xmp4 = await page.evaluate(async () => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('e2e-shoot');
    return (await (await d.getFileHandle('IMG_0004.xmp')).getFile()).text();
  });
  expect(xmp4).toMatch(/xmp:Label="Red"|<xmp:Label>Red/);

  // Reload: marks come back (from SQLite, or sidecars)
  await page.reload();
  await openOpfsShoot(page, false);
  expect(await marks(page)).toMatchObject({ IMG_0001: '1/0/', IMG_0002: '0/5/', IMG_0003: '-1/0/', IMG_0004: '1/0/red', IMG_0005: '0/2/' });

  // Deliver: picks (flag or >=2 stars) move to _Picks, rejects to _Rejects
  await page.getByTestId('deliver-btn').click();
  await page.locator('select').filter({ hasText: '只算' }).selectOption('2');
  await expect(page.getByTestId('deliver-summary')).toContainText('4 张保留');
  await page.getByTestId('deliver-run').click();
  await expect(page.getByTestId('deliver-result')).toContainText('完成', { timeout: 60_000 });
  const picks = await listDir(page, '_Picks');
  expect(picks).toEqual(['IMG_0001.CR3', 'IMG_0001.xmp', 'IMG_0002.NEF', 'IMG_0002.xmp', 'IMG_0004.ARW', 'IMG_0004.JPG', 'IMG_0004.xmp', 'IMG_0005.HEIC', 'IMG_0005.xmp']);
  expect(await listDir(page, '_Rejects')).toEqual(['IMG_0003.ARW', 'IMG_0003.xmp']);
  const rootAfter = await listDir(page, '');
  expect(rootAfter).toContain('_culling-log.json');
  expect(rootAfter.filter((f) => /^IMG/.test(f))).toEqual(['IMG_0006.jpg', 'IMG_0007.RAF']);

  // After rescan, the picks are still shown with their marks (read back from moved XMP)
  await page.waitForFunction(() => !!(window as any).__culling.store.state.progress.allThumbsAt, null, { timeout: 60_000 });
  const after = await marks(page);
  expect(after).toMatchObject({ IMG_0001: '1/0/', IMG_0002: '0/5/', IMG_0004: '1/0/red', IMG_0005: '0/2/' });
  expect(Object.keys(after)).not.toContain('IMG_0003'); // _Rejects is hidden

  // Restore puts everything back
  // (the delivery dialog stays open showing the result)
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('restore-btn').click();
  await expect(page.getByTestId('deliver-result')).toContainText('已还原', { timeout: 60_000 });
  const restored = await listDir(page, '');
  for (const [, , n] of FILES) expect(restored).toContain(n);
  expect(restored).not.toContain('_Picks/');
  expect(restored).not.toContain('_Rejects/');
  expect(errors).toEqual([]);
});
