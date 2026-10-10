// Real-image validation of blurScore / pHash on fixture photos and embedded RAW previews.
import { beforeAll, describe, expect, test } from 'vitest';
import { BLURRY_THRESHOLD, blurScore, SHARP_THRESHOLD } from './blur';
import {
  bitmapToImageData,
  blobToImageData,
  fixtureBlob,
  GEN_DIR,
  largestEmbeddedJpeg,
  RAW_DIR,
} from './browser-test-helpers';
import { hamming, pHash } from './hash';
import { boxBlur, gaussianBlur, motionBlur } from './test-helpers';

const RAWS = [
  'Apple___iPhone_12_Pro___8bit__4_3_.DNG',
  'Canon___EOS_5D_Mark_IV___RAW__3_2_.CR2',
  'Canon___EOS_R5___RAW__1.6_crop__dual_pixel__3_2_.CR3',
  'Canon___EOS_R6_Mark_II___3_2.cr3',
  'Fujifilm___X_T3___14bit_14bit_compressed__3_2_.RAF',
  'Fujifilm___X_T5___14bit_14bit_compressed__3_2_.RAF',
  'Nikon___D850___12bit_12bit_compressed__Lossless___3_2_.NEF',
  'Nikon___Z_8___8bit_8bit_compressed__3_2_.NEF',
  'Olympus___E_M1MarkII___16bit__4_3_.ORF',
  'Panasonic___DC_S5___3_2.RW2',
  'Pentax___K_1_Mark_II___14bit__3_2_.DNG',
  'Pentax___K_1___14bit__3_2_.PEF',
  'Samsung___NX1___14bit__3_2_.srw',
  'Sony___ILCE_1___14bit_14bit_compressed__3_2_.ARW',
  'Sony___ILCE_7M3___14bit_14bit_compressed__3_2_.ARW',
];

const images: { name: string; img: ImageData }[] = [];

beforeAll(async () => {
  images.push({ name: 'gen/photo.jpg', img: await blobToImageData(await fixtureBlob(GEN_DIR + 'photo.jpg')) });
  for (const r of RAWS) {
    const bmp = await largestEmbeddedJpeg(await fixtureBlob(RAW_DIR + r));
    if (!bmp) continue;
    images.push({ name: r.split('___').slice(0, 2).join(' '), img: await bitmapToImageData(bmp) });
    bmp.close();
  }
}, 120_000);

describe('blurScore on real photos (~512px)', () => {
  test('found enough sharp previews', () => {
    expect(images.length).toBeGreaterThanOrEqual(12);
  });

  test('sharp > 1; gaussian σ≥2 / box r≥4 / 17px motion < 0.3 (box r2 < 0.5); strictly monotonic', () => {
    const rows: string[] = [];
    const checks: (() => void)[] = [];
    for (const { name, img } of images) {
      const s0 = blurScore(img);
      const g = [1, 2, 4, 8].map((r) => blurScore(gaussianBlur(img, r)));
      const b = [2, 4, 8].map((r) => blurScore(boxBlur(img, r)));
      const m = [8, 16].map((l) => blurScore(motionBlur(img, l)));
      const mv = blurScore(motionBlur(img, 16, false));
      rows.push(
        `${name.padEnd(28)} ${img.width}x${img.height} sharp=${s0.toFixed(2)} gauss1/2/4/8=${g.map((v) => v.toFixed(3)).join('/')} ` +
          `box2/4/8=${b.map((v) => v.toFixed(3)).join('/')} motion9/17=${m.map((v) => v.toFixed(3)).join('/')} vmotion17=${mv.toFixed(3)}`,
      );
      checks.push(() => {
        expect(s0, name).toBeGreaterThan(SHARP_THRESHOLD);
        let prev = s0;
        for (const v of g) {
          expect(v, name).toBeLessThan(prev);
          prev = v;
        }
        prev = s0;
        for (const v of b) {
          expect(v, name).toBeLessThan(prev);
          prev = v;
        }
        expect(m[0], name).toBeLessThan(s0);
        expect(m[1], name).toBeLessThan(m[0]);
        expect(b[0], name).toBeLessThan(0.5);
        for (const v of [...g.slice(1), ...b.slice(1), m[1], mv]) expect(v, name).toBeLessThan(BLURRY_THRESHOLD);
      });
    }
    console.log(rows.join('\n'));
    for (const c of checks) c();
  }, 240_000);
});

describe('pHash on real photos', () => {
  test('same picture across codecs/sizes is near-identical; different scenes are far', async () => {
    const jpg = pHash(await blobToImageData(await fixtureBlob(GEN_DIR + 'photo.jpg')));
    const png = pHash(await blobToImageData(await fixtureBlob(GEN_DIR + 'photo.png'))); // 2000px resize
    const webp = pHash(await blobToImageData(await fixtureBlob(GEN_DIR + 'photo.webp')));
    const small = pHash(await blobToImageData(await fixtureBlob(GEN_DIR + 'photo.jpg'), 160));
    expect(hamming(jpg, png)).toBeLessThanOrEqual(4);
    expect(hamming(jpg, webp)).toBeLessThanOrEqual(4);
    expect(hamming(jpg, small)).toBeLessThanOrEqual(6);
    const blurred = pHash(gaussianBlur(images[0].img, 3));
    expect(hamming(jpg, blurred)).toBeLessThanOrEqual(8);

    // pairwise across distinct camera previews (different scenes)
    const hs = images.slice(1).map((x) => pHash(x.img));
    const ds: number[] = [];
    for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) ds.push(hamming(hs[i], hs[j]));
    ds.sort((a, b) => a - b);
    console.log(`pHash distinct-scene distances: min=${ds[0]} median=${ds[ds.length >> 1]} max=${ds[ds.length - 1]}`);
    // Most distinct scenes are > 12 bits apart (the burst threshold); some sample
    // fixtures are near-identical test charts, so only check the bulk.
    expect(ds[Math.floor(ds.length * 0.1)]).toBeGreaterThan(12);
  });
});
