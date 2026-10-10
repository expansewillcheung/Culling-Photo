// Robustness: truncated / corrupted inputs must never throw or hang.
import { describe, expect, it } from 'vitest';
import type { ParsedFile, Reader } from '../core/types';
import { bytesReader } from '../core/types';
import { parseFile } from './index';
import { fileReader, listFixtures } from './nodeReader.testutil';

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

/** View of `base` truncated to `size` bytes with XOR mutations applied on read. */
function mutated(base: Reader, size: number, flips: Map<number, number>): Reader & { bytes: number } {
  const r = {
    size,
    bytes: 0,
    async read(offset: number, length: number) {
      const end = Math.min(size, offset + length);
      if (offset >= end) return new Uint8Array(0);
      const src = await base.read(offset, end - offset);
      const b = new Uint8Array(src); // copy: never mutate the underlying reader's buffer
      for (const [o, x] of flips) if (o >= offset && o < end) b[o - offset] ^= x;
      r.bytes += b.length;
      return b;
    },
  };
  return r;
}

async function parseWithTimeout(r: Reader, name: string, ms = 2000): Promise<ParsedFile> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout ${name}`)), ms); });
  try {
    return await Promise.race([parseFile(r, name), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function checkShape(p: ParsedFile, size: number) {
  expect(typeof p.format).toBe('string');
  expect(typeof p.kind).toBe('string');
  expect(Array.isArray(p.images)).toBe(true);
  for (const i of p.images) {
    expect(i.offset).toBeGreaterThanOrEqual(0);
    expect(i.offset + i.length).toBeLessThanOrEqual(size);
  }
  for (const v of Object.values(p.exif)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
}

const fixtures = listFixtures();

describe.skipIf(fixtures.length === 0)('fuzz fixtures', () => {
  for (const f of fixtures) {
    it(`${f.name}: truncation + bit flips never throw`, async () => {
      const base = fileReader(f.path);
      try {
        // Record which ranges a clean parse touches so flips land where parsers look.
        await parseFile(base, f.name);
        const touched = [...base.log.keys()].map((k) => k.split(':').map(Number) as [number, number]);
        const rand = rng(f.name.length * 7919 + f.name.charCodeAt(0));
        for (let i = 0; i < 25; i++) {
          const cut = i < 5 ? Math.floor(rand() * 4096) : Math.floor(rand() * Math.min(base.size, 4 * 1024 * 1024));
          const r = mutated(base, cut, new Map());
          checkShape(await parseWithTimeout(r, f.name), cut);
          expect(r.bytes).toBeLessThan(4 * 1024 * 1024);
        }
        for (let i = 0; i < 40; i++) {
          const flips = new Map<number, number>();
          const n = 1 + Math.floor(rand() * 16);
          for (let j = 0; j < n; j++) {
            const [o, l] = touched[Math.floor(rand() * touched.length)];
            const span = Math.min(l, i < 20 ? 512 : l);
            flips.set(o + Math.floor(rand() * span), 1 + Math.floor(rand() * 255));
          }
          const r = mutated(base, base.size, flips);
          checkShape(await parseWithTimeout(r, f.name), base.size);
          expect(r.bytes).toBeLessThan(4 * 1024 * 1024);
        }
      } finally {
        base.close();
      }
    }, 60_000);
  }
});

describe('synthetic hostile inputs', () => {
  const names = ['x.cr2', 'x.nef', 'x.dng', 'x.tif', 'x.jpg', 'x.cr3', 'x.heic', 'x.raf', 'x.png', 'x.webp', 'x.jxl', 'x.rw2', 'x.orf', 'x.xmp', 'x.bin'];

  it('empty and tiny inputs', async () => {
    for (const n of names) {
      for (const bytes of [new Uint8Array(0), new Uint8Array([0xff]), new Uint8Array(7).fill(0xff)]) {
        const p = await parseWithTimeout(bytesReader(bytes), n);
        checkShape(p, bytes.length);
      }
    }
  });

  it('random garbage with valid magic', async () => {
    const magics = [
      [0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a], [0x49, 0x49, 0x55, 0x00], [0x49, 0x49, 0x52, 0x4f],
      [0xff, 0xd8, 0xff, 0xe1], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      [...'FUJIFILMCCD-RAW '].map((c) => c.charCodeAt(0)),
      [0, 0, 0, 0x18, ...'ftypcrx '].map((c) => (typeof c === 'string' ? c.charCodeAt(0) : c)),
      [0, 0, 0, 0x18, ...'ftypheic'].map((c) => (typeof c === 'string' ? c.charCodeAt(0) : c)),
      [...'RIFF\0\0\0\0WEBP'].map((c) => c.charCodeAt(0)),
      [0xff, 0x0a],
    ];
    const rand = rng(1234);
    for (const m of magics) {
      for (let i = 0; i < 50; i++) {
        const b = new Uint8Array(64 + Math.floor(rand() * 200_000));
        for (let j = 0; j < b.length; j++) b[j] = (rand() * 256) | 0;
        // sprinkle small numbers so offsets/counts point inside the buffer
        for (let j = 0; j < b.length; j += 4 + ((rand() * 32) | 0)) b[j] = (rand() * 8) | 0;
        b.set(m, 0);
        for (const n of names) checkShape(await parseWithTimeout(bytesReader(b), n), b.length);
      }
    }
  }, 60_000);

  it('self-referencing IFD chain and SubIFD loops terminate', async () => {
    // II*\0, IFD0 @8: 2 entries: SubIFDs -> 8 (self), ExifIFD -> 8; next IFD -> 8.
    const b = new Uint8Array(64);
    const dv = new DataView(b.buffer);
    b.set([0x49, 0x49, 0x2a, 0x00]);
    dv.setUint32(4, 8, true);
    dv.setUint16(8, 2, true);
    const ent = (i: number, tag: number, type: number, count: number, val: number) => {
      const o = 10 + i * 12;
      dv.setUint16(o, tag, true); dv.setUint16(o + 2, type, true);
      dv.setUint32(o + 4, count, true); dv.setUint32(o + 8, val, true);
    };
    ent(0, 0x14a, 4, 1, 8);
    ent(1, 0x8769, 4, 1, 8);
    dv.setUint32(10 + 24, 8, true);
    const p = await parseWithTimeout(bytesReader(b), 'loop.dng');
    checkShape(p, b.length);
  });

  it('BMFF boxes with zero / huge sizes terminate', async () => {
    const b = new Uint8Array(4096);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 16); b.set([...'ftypcrx '].map((c) => c.charCodeAt(0)), 4);
    dv.setUint32(16, 1); b.set([...'moov'].map((c) => c.charCodeAt(0)), 20);
    dv.setUint32(24, 0xffffffff); dv.setUint32(28, 0xffffffff); // largesize
    dv.setUint32(32, 8); b.set([...'trak'].map((c) => c.charCodeAt(0)), 36);
    checkShape(await parseWithTimeout(bytesReader(b), 'x.cr3'), b.length);
    dv.setUint32(16, 0);
    checkShape(await parseWithTimeout(bytesReader(b), 'x.heic'), b.length);
  });

  it('reader that throws yields a partial result', async () => {
    const r: Reader = { size: 1 << 20, read: async () => { throw new Error('io'); } };
    const p = await parseWithTimeout(r, 'x.cr2');
    expect(p.kind).toBe('other');
    expect(p.images).toEqual([]);
  });
});
