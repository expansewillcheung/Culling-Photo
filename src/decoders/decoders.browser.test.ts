import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ExifInfo, FileKind, ParsedFile } from '../core/types';
import { fixtureBlob, GEN_DIR, RAW_DIR } from '../../tests/browser/fixtures';
import { decodeFallback, needsFallback, preloadDecoder, type DecodeOptions } from './index';

const KIND_BY_EXT: Record<string, [FileKind, string]> = {
  heic: ['heic', 'HEIC'],
  tif: ['tiff', 'TIFF'],
  jxl: ['jxl', 'JXL'],
  rw2: ['raw', 'RW2'],
  orf: ['raw', 'ORF'],
  cr3: ['raw', 'CR3'],
  dng: ['raw', 'DNG'],
};

function parsedFor(name: string, exif: ExifInfo = {}): ParsedFile {
  const ext = name.split('.').pop()!.toLowerCase();
  const [kind, format] = KIND_BY_EXT[ext];
  return { kind, format, exif, images: [] };
}

interface Stats {
  mean: [number, number, number];
  luma: number;
}

function pixels(bmp: ImageBitmap, w = bmp.width, h = bmp.height): Uint8ClampedArray {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

function stats(d: Uint8ClampedArray): Stats {
  let r = 0, g = 0, b = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
  }
  r /= n; g /= n; b /= n;
  return { mean: [r, g, b], luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
}

/** Mean absolute difference per channel, comparing both images at a small common size. */
function meanAbsDiff(a: ImageBitmap, b: ImageBitmap, w = 256): [number, number, number] {
  const h = Math.round((w * a.height) / a.width);
  const pa = pixels(a, w, h);
  const pb = pixels(b, w, h);
  const s = [0, 0, 0];
  for (let i = 0; i < pa.length; i += 4) for (let c = 0; c < 3; c++) s[c] += Math.abs(pa[i + c] - pb[i + c]);
  const n = pa.length / 4;
  return [s[0] / n, s[1] / n, s[2] / n];
}

const timings: { file: string; mode: string; where: string; ms: number; w: number; h: number }[] = [];

async function timed(file: string, blob: Blob, parsed: ParsedFile, opts: DecodeOptions, mode: string) {
  const t0 = performance.now();
  const bmp = await decodeFallback(blob, parsed, opts);
  const ms = performance.now() - t0;
  expect(bmp, `${file} decoded`).not.toBeNull();
  timings.push({ file, mode, where: 'main', ms: Math.round(ms), w: bmp!.width, h: bmp!.height });
  return bmp!;
}

function expectDims(bmp: ImageBitmap, expW: number, expH: number, maxEdge?: number, tol = 0.02) {
  const expLong = maxEdge ? Math.min(maxEdge, Math.max(expW, expH)) : Math.max(expW, expH);
  const long = Math.max(bmp.width, bmp.height);
  expect(Math.abs(long - expLong) / expLong).toBeLessThanOrEqual(tol);
  // orientation: same landscape/portrait as expected
  expect(bmp.width >= bmp.height).toBe(expW >= expH);
  expect(Math.abs(bmp.width / bmp.height - expW / expH)).toBeLessThan(0.02);
}

let reference: ImageBitmap;

beforeAll(async () => {
  reference = await createImageBitmap(await fixtureBlob(GEN_DIR + 'photo.jpg'));
});

afterAll(() => {
  console.log('decode timings (ms)\n' + timings.map((t) => `${t.file.padEnd(48)} ${t.mode.padEnd(14)} ${t.where.padEnd(6)} ${String(t.ms).padStart(6)}  ${t.w}x${t.h}`).join('\n'));
});

describe('needsFallback', () => {
  test('kinds', () => {
    expect(needsFallback(parsedFor('a.heic'))).toBe(true);
    expect(needsFallback(parsedFor('a.tif'))).toBe(true);
    expect(needsFallback(parsedFor('a.jxl'))).toBe(true);
    expect(needsFallback({ kind: 'jpeg', format: 'JPEG', exif: {}, images: [] })).toBe(false);
    const raw = parsedFor('a.cr3');
    expect(needsFallback(raw)).toBe(true);
    raw.images.push({ offset: 0, length: 1, mime: 'image/jpeg', width: 1620, height: 1080, role: 'preview' });
    expect(needsFallback(raw)).toBe(false);
  });
});

// Non-RAW: [file, width, height] from exiftool.
const STILLS: [string, number, number][] = [
  ['photo.heic', 4000, 2668],
  ['photo.tif', 2000, 1334],
  ['photo.jxl', 4000, 2667],
];

describe.each(STILLS)('%s', (file, W, H) => {
  let blob: Blob;
  beforeAll(async () => {
    blob = await fixtureBlob(GEN_DIR + file);
    const t0 = performance.now();
    await preloadDecoder(parsedFor(file).kind);
    timings.push({ file, mode: 'init (wasm)', where: 'main', ms: Math.round(performance.now() - t0), w: 0, h: 0 });
  });

  for (const maxEdge of [1024, undefined]) {
    test(`maxEdge ${maxEdge ?? 'full'}`, async () => {
      const bmp = await timed(file, blob, parsedFor(file), { maxEdge }, `max ${maxEdge ?? 'full'}`);
      expectDims(bmp, W, H, maxEdge);
      const s = stats(pixels(bmp, Math.min(bmp.width, 512), Math.round((Math.min(bmp.width, 512) * bmp.height) / bmp.width)));
      expect(s.luma).toBeGreaterThan(10);
      expect(s.luma).toBeLessThan(245);
      const diff = meanAbsDiff(bmp, reference);
      for (const d of diff) expect(d).toBeLessThan(25);
      bmp.close();
    }, 120_000);
  }
});

// RAW: [file, exif width/height (exiftool), extra exif given to the decoder]
const RAWS: [string, number, number, ExifInfo][] = [
  ['Panasonic___DC_S5___3_2.RW2', 6000, 4000, { width: 6000, height: 4000 }],
  ['Olympus___E_M1MarkII___16bit__4_3_.ORF', 5240, 3912, {}],
  ['Canon___EOS_R6_Mark_II___3_2.cr3', 6000, 4000, {}],
  // orientation 6: decoded result must be portrait
  ['Apple___iPhone_12_Pro___8bit__4_3_.DNG', 3024, 4032, { orientation: 6 }],
];

describe.each(RAWS)('%s', (file, W, H, exif) => {
  let blob: Blob;
  beforeAll(async () => {
    blob = await fixtureBlob(RAW_DIR + file);
    const t0 = performance.now();
    await preloadDecoder('raw');
    timings.push({ file, mode: 'init (wasm)', where: 'main', ms: Math.round(performance.now() - t0), w: 0, h: 0 });
  });

  const cases: [string, DecodeOptions][] = [
    ['max 1024', { maxEdge: 1024 }],
    ['max 1024 demos', { maxEdge: 1024, allowEmbedded: false }],
    ['full', {}],
    ['full demosaic', { allowEmbedded: false }],
  ];
  for (const [mode, opts] of cases) {
    test(mode, async () => {
      const bmp = await timed(file, blob, parsedFor(file, exif), opts, mode);
      expectDims(bmp, W, H, opts.maxEdge, 0.03);
      const s = stats(pixels(bmp, 512, Math.round((512 * bmp.height) / bmp.width)));
      expect(s.luma).toBeGreaterThan(10);
      expect(s.luma).toBeLessThan(245);
      bmp.close();
    }, 180_000);
  }
});

describe('module worker', () => {
  let worker: Worker;
  let nextId = 0;
  beforeAll(() => {
    worker = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });
  });
  afterAll(() => worker.terminate());

  function inWorker(blob: Blob, parsed: ParsedFile, opts: DecodeOptions): Promise<{ ms: number; bmp: ImageBitmap | null; error?: string }> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const onMsg = (e: MessageEvent) => {
        if (e.data.id !== id) return;
        worker.removeEventListener('message', onMsg);
        resolve(e.data);
      };
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', (e) => reject(new Error(e.message)), { once: true });
      worker.postMessage({ id, blob, parsed, opts });
    });
  }

  const ALL: [string, string, number, number, ExifInfo, DecodeOptions][] = [
    ...STILLS.map(([f, w, h]) => [GEN_DIR, f, w, h, {}, { maxEdge: 1024 }] as [string, string, number, number, ExifInfo, DecodeOptions]),
    ...RAWS.map(([f, w, h, ex]) => [RAW_DIR, f, w, h, ex, { maxEdge: 1024, allowEmbedded: false }] as [string, string, number, number, ExifInfo, DecodeOptions]),
  ];
  test.each(ALL)('%s%s', async (dir, file, W, H, exif, opts) => {
    const blob = await fixtureBlob(dir + file);
    const res = await inWorker(blob, parsedFor(file, exif), opts);
    expect(res.error).toBeUndefined();
    expect(res.bmp).toBeTruthy();
    const bmp = res.bmp!;
    timings.push({ file, mode: opts.allowEmbedded === false ? 'max 1024 demos' : 'max 1024', where: 'worker', ms: Math.round(res.ms), w: bmp.width, h: bmp.height });
    expectDims(bmp, W, H, opts.maxEdge, 0.03);
    const s = stats(pixels(bmp));
    expect(s.luma).toBeGreaterThan(10);
    expect(s.luma).toBeLessThan(245);
    if (dir === GEN_DIR) for (const d of meanAbsDiff(bmp, reference)) expect(d).toBeLessThan(25);
    bmp.close();
  }, 180_000);
});
