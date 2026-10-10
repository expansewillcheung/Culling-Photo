import { expect, test } from 'vitest';
import { fixtureBlob, GEN_DIR, RAW_DIR } from './fixtures';

test('browser env has OPFS and OffscreenCanvas', async () => {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle('smoke.txt', { create: true });
  const w = await fh.createWritable();
  await w.write('hi');
  await w.close();
  expect(await (await fh.getFile()).text()).toBe('hi');
  expect(typeof OffscreenCanvas).toBe('function');
});

test('can fetch and decode fixtures', async () => {
  const b = await fixtureBlob(GEN_DIR + 'photo.jpg');
  const bmp = await createImageBitmap(b);
  expect(bmp.width).toBe(4000);
  const raw = await fixtureBlob(RAW_DIR + 'Canon___EOS_R6_Mark_II___3_2.cr3');
  expect(raw.size).toBeGreaterThan(1_000_000);
});
