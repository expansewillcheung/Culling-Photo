// Compares parseFile against exiftool for every fixture in tests/fixtures/{raw,gen}.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedFile } from '../core/types';
import { parseFile } from './index';
import { exifDateToMs } from './exif';
import { FIXTURES, fileReader, listFixtures, replayReader } from './nodeReader.testutil';

type GT = Record<string, unknown>;
const gtPath = join(FIXTURES, 'groundtruth.json');
const groundtruth = new Map<string, GT>();
if (existsSync(gtPath)) {
  for (const e of JSON.parse(readFileSync(gtPath, 'utf8')) as GT[]) {
    groundtruth.set(String(e.SourceFile).split('/').pop()!, e);
  }
}
const fixtures = listFixtures().filter((f) => groundtruth.has(f.name));

/** Fields exiftool reports that we knowingly cannot produce, per fixture. */
const KNOWN_GAPS: Record<string, string[]> = {
  // Exif lives in a Brotli-compressed 'brob' box; decoding Brotli is out of scope.
  'photo.jxl': ['make', 'model', 'iso', 'fNumber', 'exposureTime', 'focalLength', 'orientation', 'captureTime', 'lens'],
};

const MAX_BYTES = 2 * 1024 * 1024;
const RAW_KINDS = new Set(['CR2', 'CR3', 'NEF', 'NRW', 'ARW', 'DNG', 'PEF', 'SRW', 'ORF', 'RW2', 'RAF']);

function g(e: GT, ...keys: string[]): unknown {
  for (const k of keys) if (e[k] !== undefined && e[k] !== '') return e[k];
  return undefined;
}

function expectedFormat(e: GT, name: string): string {
  let f = String(e['File:FileType']).replace(/^Extended /, '').toUpperCase();
  // exiftool labels some newer Nikon NEFs as NRW by heuristic; we label by extension.
  if (f === 'NRW' && /\.nef$/i.test(name)) f = 'NEF';
  return f;
}

function close(a: number | undefined, b: number, rel = 1e-6): boolean {
  return a !== undefined && Math.abs(a - b) <= Math.max(Math.abs(b) * rel, 1e-9);
}

function sha(b: Uint8Array): string {
  return createHash('sha1').update(b).digest('hex');
}

function readRange(path: string, off: number, len: number): Uint8Array {
  const fd = openSync(path, 'r');
  const b = new Uint8Array(len);
  readSync(fd, b, 0, len, off);
  closeSync(fd);
  return b;
}

/** Largest binary image tag exiftool reports (group-qualified), by byte length. */
function largestExiftoolImage(e: GT, tags: string[]): { key: string; len: number } | undefined {
  let best: { key: string; len: number } | undefined;
  for (const [k, v] of Object.entries(e)) {
    const tag = k.split(':')[1];
    if (!tags.includes(tag)) continue;
    const m = /Binary data (\d+) bytes/.exec(String(v));
    if (!m) continue;
    const len = Number(m[1]);
    if (!best || len > best.len) best = { key: k, len };
  }
  return best;
}

const parsed = new Map<string, { p: ParsedFile; bytes: number }>();

async function parseFixture(path: string, name: string) {
  const hit = parsed.get(path);
  if (hit) return hit;
  const r = fileReader(path);
  try {
    const p = await parseFile(r, name);
    const res = { p, bytes: r.bytesRead };
    parsed.set(path, res);
    return res;
  } finally {
    r.close();
  }
}

describe.skipIf(fixtures.length === 0)('parseFile vs exiftool', () => {
  for (const f of fixtures) {
    describe(f.name, () => {
      const e = groundtruth.get(f.name)!;
      const gaps = new Set(KNOWN_GAPS[f.name] ?? []);
      const check = (field: string) => !gaps.has(field);

      it('format, kind and metadata', async () => {
        const { p, bytes } = await parseFixture(f.path, f.name);
        const fmt = expectedFormat(e, f.name);
        expect(p.format).toBe(fmt);
        if (RAW_KINDS.has(fmt)) expect(p.kind).toBe('raw');
        else expect(p.kind).toBe(fmt.toLowerCase());
        expect(bytes).toBeLessThan(MAX_BYTES);

        const ex = p.exif;
        const make = g(e, 'IFD0:Make');
        if (make !== undefined && check('make')) expect(ex.make).toBe(String(make).trim());
        const model = g(e, 'IFD0:Model');
        if (model !== undefined && check('model')) expect(ex.model).toBe(String(model).trim());
        const iso = g(e, 'ExifIFD:ISO', 'IFD0:ISO');
        if (iso !== undefined && check('iso')) expect(ex.iso).toBe(Number(iso));
        for (const [field, key] of [
          ['fNumber', 'ExifIFD:FNumber'],
          ['exposureTime', 'ExifIFD:ExposureTime'],
          ['focalLength', 'ExifIFD:FocalLength'],
        ] as const) {
          const v = g(e, key);
          if (v !== undefined && check(field)) expect(close(ex[field], Number(v)), `${field} ${ex[field]} vs ${v}`).toBe(true);
        }
        const orient = g(e, 'IFD0:Orientation');
        if (orient !== undefined && check('orientation')) expect(ex.orientation).toBe(Number(orient));
        const dto = g(e, 'ExifIFD:DateTimeOriginal', 'IFD0:DateTimeOriginal');
        if (dto !== undefined && check('captureTime')) {
          const sub = g(e, 'ExifIFD:SubSecTimeOriginal');
          expect(ex.captureTime).toBe(exifDateToMs(String(dto), sub === undefined ? undefined : String(sub)));
        }
        const lens = g(e, 'ExifIFD:LensModel');
        if (lens !== undefined && check('lens')) expect(ex.lens).toBe(String(lens).trim());
        const rating = g(e, 'XMP-xmp:Rating');
        if (rating !== undefined && check('rating')) expect(ex.rating).toBe(Number(rating));

        // Full image size: exiftool Composite:ImageSize; tolerance 2% per axis
        // (crop-vs-sensor differences between vendors' tags).
        const size = g(e, 'Composite:ImageSize');
        if (size !== undefined) {
          const [w, h] = String(size).split(/[ x]/).map(Number);
          expect(ex.width, 'width').toBeDefined();
          expect(Math.abs(ex.width! - w) / w).toBeLessThanOrEqual(0.02);
          expect(Math.abs(ex.height! - h) / h).toBeLessThanOrEqual(0.02);
        }
      });

      it('embedded JPEGs are valid and match exiftool', async () => {
        const { p } = await parseFixture(f.path, f.name);
        for (const img of p.images) {
          expect(img.mime).toBe('image/jpeg');
          expect(img.offset + img.length).toBeLessThanOrEqual(statSync(f.path).size);
          const head = readRange(f.path, img.offset, 2);
          expect([head[0], head[1]]).toEqual([0xff, 0xd8]);
          expect(img.width).toBeGreaterThan(0);
          expect(img.height).toBeGreaterThan(0);
        }
        const isRaw = p.kind === 'raw';
        const tags = isRaw ? ['PreviewImage', 'JpgFromRaw', 'OtherImage'] : ['ThumbnailImage'];
        const ref = largestExiftoolImage(e, tags);
        if (isRaw) {
          const longest = Math.max(0, ...p.images.map((i) => Math.max(i.width!, i.height!)));
          expect(longest).toBeGreaterThanOrEqual(1600);
          expect(ref).toBeDefined();
        }
        if (!ref || p.kind === 'heic' || p.kind === 'avif') return;
        if (!isRaw && p.kind !== 'jpeg') return; // thumbnails of PNG/WebP/JXL EXIF are not exposed
        const largest = [...p.images].sort((a, b) => b.width! * b.height! - a.width! * a.height!)[0];
        expect(largest, 'largest embedded').toBeDefined();
        const ours = readRange(f.path, largest.offset, largest.length);
        const theirs = execFileSync('exiftool', ['-b', '-ee', `-${ref.key}`, f.path], { maxBuffer: 256 * 1024 * 1024 });
        expect(theirs.length).toBe(ref.len);
        expect(largest.length).toBe(ref.len);
        expect(sha(ours)).toBe(sha(theirs));
      }, 60_000);
    });
  }
});

describe.skipIf(fixtures.length === 0)('parse performance', () => {
  it('reads < 2 MB and parses in < 5 ms on average (no I/O)', async () => {
    const recs: { name: string; log: Map<string, Uint8Array>; size: number; path: string }[] = [];
    for (const f of fixtures) {
      const r = fileReader(f.path);
      await parseFile(r, f.name);
      expect(r.bytesRead, f.name).toBeLessThan(MAX_BYTES);
      recs.push({ name: f.name, log: r.log, size: r.size, path: f.path });
      r.close();
    }
    const failing = { size: 0, read: async () => { throw new Error('unexpected read'); } };
    // warm-up
    for (const rec of recs) await parseFile(replayReader(rec.log, rec.size, failing), rec.name);
    const N = 20;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) for (const rec of recs) await parseFile(replayReader(rec.log, rec.size, failing), rec.name);
    const avg = (performance.now() - t0) / (N * recs.length);
    expect(avg).toBeLessThan(5);
  }, 60_000);
});
