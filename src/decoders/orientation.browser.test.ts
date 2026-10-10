import { expect, test } from 'vitest';
import { fixtureBlob, GEN_DIR } from '../../tests/browser/fixtures';
import { decodeFallback } from './index';
import { orientBitmap } from './pixels';

// Display position of stored pixel (sx, sy) in a w x h image for each EXIF orientation.
const MAP: Record<number, (sx: number, sy: number, w: number, h: number) => [number, number]> = {
  1: (x, y) => [x, y],
  2: (x, y, w) => [w - 1 - x, y],
  3: (x, y, w, h) => [w - 1 - x, h - 1 - y],
  4: (x, y, _w, h) => [x, h - 1 - y],
  5: (x, y) => [y, x],
  6: (x, y, _w, h) => [h - 1 - y, x],
  7: (x, y, w, h) => [h - 1 - y, w - 1 - x],
  8: (x, y, w) => [y, w - 1 - x],
};

test.each([1, 2, 3, 4, 5, 6, 7, 8])('orientBitmap orientation %i', async (o) => {
  const w = 3, h = 2;
  const src = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) src.data.set([i * 40, 255 - i * 40, (i * 97) % 256, 255], i * 4);
  const out = orientBitmap(await createImageBitmap(src), o);
  const swap = o >= 5;
  expect([out.width, out.height]).toEqual(swap ? [h, w] : [w, h]);
  const c = new OffscreenCanvas(out.width, out.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(out, 0, 0);
  const d = ctx.getImageData(0, 0, out.width, out.height).data;
  for (let sy = 0; sy < h; sy++)
    for (let sx = 0; sx < w; sx++) {
      const [dx, dy] = MAP[o](sx, sy, w, h);
      const i = sy * w + sx;
      expect(d[(dy * out.width + dx) * 4]).toBe(i * 40);
    }
});

test('TIFF with orientation 6 matches Chrome-rotated JPEG', async () => {
  const bmp = await decodeFallback(await fixtureBlob(GEN_DIR + 'photo.tif'), { kind: 'tiff', format: 'TIFF', exif: { orientation: 6 }, images: [] }, { maxEdge: 1024 });
  expect(bmp).not.toBeNull();
  expect([bmp!.width, bmp!.height]).toEqual([683, 1024]);
  const ref = await createImageBitmap(await fixtureBlob(GEN_DIR + 'rotated6.jpg'));
  expect([ref.width, ref.height]).toEqual([2667, 4000]);
  const w = 128, h = 192;
  const px = (b: ImageBitmap) => {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(b, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  };
  const a = px(bmp!), b = px(ref);
  let s = 0;
  for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  expect(s / (a.length / 4) / 3).toBeLessThan(25);
});
