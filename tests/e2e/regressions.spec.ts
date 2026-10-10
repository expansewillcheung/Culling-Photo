import { expect, test, type Page } from '@playwright/test';

const FILES = [
  ['raw', 'Canon___EOS_R6_Mark_II___3_2.cr3', 'IMG_0001.CR3'],
  ['gen', 'photo.jpg', 'IMG_0002.jpg'],
  ['gen', 'rotated6.jpg', 'IMG_0003.jpg'],
  ['gen', 'photo.png', 'IMG_0004.png'],
] as const;
const DIR = 'e2e-regress';

async function openShoot(page: Page, fresh: boolean) {
  await page.evaluate(
    async ({ files, fresh, DIR }) => {
      const root = await navigator.storage.getDirectory();
      if (fresh) {
        await root.removeEntry(DIR, { recursive: true }).catch(() => {});
        const dir = await root.getDirectoryHandle(DIR, { create: true });
        for (const [d, src, name] of files) {
          const res = await fetch(`/tests/fixtures/${d}/${src}`);
          const fh = await dir.getFileHandle(name, { create: true });
          await res.body!.pipeTo(await fh.createWritable());
        }
      }
      await (window as any).__culling.openHandle(await root.getDirectoryHandle(DIR));
    },
    { files: FILES as any, fresh, DIR },
  );
  await page.waitForFunction(() => !!(window as any).__culling.store.state.progress.allThumbsAt, null, { timeout: 120_000 });
}

async function listDir(page: Page, path: string) {
  return page.evaluate(
    async ({ path, DIR }) => {
      let d = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR);
      for (const p of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(p);
      const out: string[] = [];
      for await (const [n, h] of (d as any).entries()) out.push(h.kind === 'directory' ? n + '/' : n);
      return out.sort();
    },
    { path, DIR },
  );
}

test('reopening a folder does not leak preview workers', async ({ page }) => {
  await page.goto('/');
  await openShoot(page, true);
  await page.waitForTimeout(500);
  const before = page.workers().length;
  for (let i = 0; i < 3; i++) await openShoot(page, false);
  await page.waitForTimeout(500);
  expect(page.workers().length).toBe(before);
});

test('zoomed compare keeps both full-size renders drawable', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await openShoot(page, true);
  await page.evaluate(() => (window as any).__culling.store.actions.setState('sort', 'name'));
  const idle = () =>
    page.waitForFunction(() => {
      const s = (window as any).__culling.session;
      return s.pool.active === 0 && s.pool.pending === 0;
    }, null, { timeout: 60_000 });
  // Full-size render of IMG_0002 is already cached from the loupe.
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.keyboard.press('z');
  await idle();
  await page.keyboard.press('g');
  // Compare IMG_0002 with IMG_0003 and zoom in: IMG_0003's full render arrives second.
  await page.getByTestId('cell').nth(2).click({ modifiers: ['ControlOrMeta'] });
  await page.keyboard.press('c');
  const panes = page.getByTestId('viewer').locator('canvas');
  await expect(panes).toHaveCount(2);
  await panes.first().click(); // fit -> 100% (shared view)
  await idle();
  await page.waitForTimeout(300);
  const box = (await panes.first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 40, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect(errors).toEqual([]);
});

test('delivering again after a delivery does not re-move the picks', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await openShoot(page, true);
  await page.evaluate(() => (window as any).__culling.store.actions.setState('sort', 'name'));
  await page.keyboard.press('Home');
  await page.keyboard.press('p');
  await page.getByTestId('deliver-btn').click();
  await expect(page.getByTestId('deliver-summary')).toContainText('1 张保留');
  await page.getByTestId('deliver-run').click();
  await expect(page.getByTestId('deliver-result')).toContainText('完成', { timeout: 60_000 });
  await page.waitForFunction(() => !!(window as any).__culling.store.state.progress.allThumbsAt, null, { timeout: 60_000 });
  expect(await listDir(page, '_Picks')).toEqual(['IMG_0001.CR3', 'IMG_0001.xmp']);
  // The dialog is still open on the rescanned folder: the picks are already delivered.
  await expect(page.getByTestId('deliver-summary')).toContainText('0 张保留');
  const run = page.getByTestId('deliver-run');
  if (await run.isEnabled()) {
    await run.click();
    await page.waitForTimeout(3000);
  }
  expect(await listDir(page, '_Picks')).toEqual(['IMG_0001.CR3', 'IMG_0001.xmp']);
});
