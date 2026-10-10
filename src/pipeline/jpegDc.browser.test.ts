// Chromium: DC-only decode of embedded RAW previews vs createImageBitmap (accuracy + timing).
import { expect, test } from 'vitest';
import { blobReader } from '../core/types';
import { fixtureBlob, GEN_DIR, RAW_DIR } from '../../tests/browser/fixtures';
import { parseFile } from '../formats/index';
import { decodeJpegDc } from './jpegDc';

const FILES = [
  'Nikon___Z_8___8bit_8bit_compressed__3_2_.NEF',
  'Canon___EOS_5D_Mark_IV___RAW__3_2_.CR2',
  'Pentax___K_1___14bit__3_2_.PEF',
  'Fujifilm___X_T5___14bit_14bit_compressed__3_2_.RAF',
  'Pentax___K_1_Mark_II___14bit__3_2_.DNG',
  'Apple___iPhone_12_Pro___8bit__4_3_.DNG',
  'Canon___EOS_R6_Mark_II___3_2.cr3',
  'Sony___ILCE_1___14bit_14bit_compressed__3_2_.ARW',
  'Sony___ILCE_7M3___14bit_14bit_compressed__3_2_.ARW',
  'Nikon___D850___12bit_12bit_compressed__Lossless___3_2_.NEF',
  'Samsung___NX1___14bit__3_2_.srw',
  'Olympus___E_M1MarkII___16bit__4_3_.ORF',
  'Panasonic___DC_S5___3_2.RW2',
];

/** Drop APP1 segments so Chrome does not apply EXIF orientation to the reference decode. */
function stripApp1(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const m = b[p + 1];
    if (m === 0xda) break;
    const len = (b[p + 2] << 8) | b[p + 3];
    if (m !== 0xe1) parts.push(b.subarray(p, p + 2 + len));
    p += 2 + len;
  }
  parts.push(b.subarray(p));
  const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

/** 8x8 box means of the full native decode, computed in strips. */
async function referenceDc(bytes: Uint8Array): Promise<{ width: number; height: number; data: Float64Array }> {
  const bmp = await createImageBitmap(new Blob([stripApp1(bytes) as BlobPart], { type: 'image/jpeg' }), { colorSpaceConversion: 'none' });
  const W = Math.ceil(bmp.width / 8), H = Math.ceil(bmp.height / 8);
  const data = new Float64Array(W * H * 4);
  const cnt = new Float64Array(W * H);
  const STRIP = 512;
  const cv = new OffscreenCanvas(bmp.width, STRIP);
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  for (let y0 = 0; y0 < bmp.height; y0 += STRIP) {
    const h = Math.min(STRIP, bmp.height - y0);
    ctx.clearRect(0, 0, bmp.width, STRIP);
    ctx.drawImage(bmp, 0, -y0);
    const px = ctx.getImageData(0, 0, bmp.width, h).data;
    for (let y = 0; y < h; y++) {
      const row = ((y0 + y) >> 3) * W;
      for (let x = 0; x < bmp.width; x++) {
        const i = (y * bmp.width + x) * 4;
        const o = row + (x >> 3);
        data[o * 4] += px[i]; data[o * 4 + 1] += px[i + 1]; data[o * 4 + 2] += px[i + 2];
        cnt[o]++;
      }
    }
  }
  bmp.close();
  for (let o = 0; o < W * H; o++) for (let c = 0; c < 3; c++) data[o * 4 + c] /= cnt[o];
  return { width: W, height: H, data };
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
const rows: string[] = [];

for (const name of FILES) {
  test(`DC decode vs createImageBitmap: ${name}`, async () => {
    const blob = await fixtureBlob(RAW_DIR + name);
    const parsed = await parseFile(blobReader(blob), name);
    // largest embedded JPEG
    const img = [...parsed.images].sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0];
    expect(img).toBeDefined();
    const jpegBlob = blob.slice(img.offset, img.offset + img.length, 'image/jpeg');
    const bytes = new Uint8Array(await jpegBlob.arrayBuffer());

    const dcT: number[] = [];
    let dc = decodeJpegDc(bytes);
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      dc = decodeJpegDc(bytes);
      dcT.push(performance.now() - t);
    }
    expect(dc, 'decodeJpegDc returned null').not.toBeNull();

    const fullT: number[] = [];
    const rsT: number[] = [];
    let w = 0, h = 0;
    for (let i = 0; i < 3; i++) {
      let t = performance.now();
      const b = await createImageBitmap(jpegBlob);
      fullT.push(performance.now() - t);
      w = b.width; h = b.height;
      b.close();
      t = performance.now();
      const r = await createImageBitmap(jpegBlob, { resizeWidth: 512, resizeQuality: 'medium' });
      rsT.push(performance.now() - t);
      r.close();
    }

    const ref = await referenceDc(bytes);
    expect([dc!.width, dc!.height]).toEqual([ref.width, ref.height]);
    const err = [0, 0, 0];
    const n = ref.width * ref.height;
    for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) err[c] += Math.abs(dc!.data[p * 4 + c] - ref.data[p * 4 + c]);
    const mae = err.map((e) => e / n);
    const row = `${name} | ${w}x${h} ${(bytes.length / 1e6).toFixed(1)}MB | dc ${median(dcT).toFixed(1)} ms | full ${median(fullT).toFixed(1)} ms | resize512 ${median(rsT).toFixed(1)} ms | MAE ${mae.map((x) => x.toFixed(2)).join('/')}`;
    rows.push(row);
    console.log(row);
    for (const e of mae) expect(e).toBeLessThan(4);
  });
}

test('photo.jpg', async () => {
  const bytes = new Uint8Array(await (await fixtureBlob(GEN_DIR + 'photo.jpg')).arrayBuffer());
  const dc = decodeJpegDc(bytes)!;
  expect(dc).not.toBeNull();
  const ref = await referenceDc(bytes);
  let e = 0;
  for (let p = 0; p < ref.width * ref.height; p++) for (let c = 0; c < 3; c++) e += Math.abs(dc.data[p * 4 + c] - ref.data[p * 4 + c]);
  const mae = e / (ref.width * ref.height * 3);
  console.log(`photo.jpg MAE ${mae.toFixed(2)}`);
  expect(mae).toBeLessThan(4);
  console.log(rows.join('\n'));
});
