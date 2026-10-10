// Low-level byte helpers and a small caching random-access source on top of Reader.
import type { Reader } from '../core/types';

export const HEAD_SIZE = 64 * 1024;
const CHUNK = 16 * 1024;
const MAX_CACHE_CHUNKS = 8;
/** Hard cap for a single metadata read (XMP packets, EXIF blobs...). */
export const MAX_META_READ = 1024 * 1024;

export function u8(b: Uint8Array, o: number): number {
  return o >= 0 && o < b.length ? b[o] : 0;
}
export function u16(b: Uint8Array, o: number, le: boolean): number {
  if (o < 0 || o + 2 > b.length) return 0;
  return le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
}
export function u32(b: Uint8Array, o: number, le: boolean): number {
  if (o < 0 || o + 4 > b.length) return 0;
  return le
    ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000
    : b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
}
export function i32(b: Uint8Array, o: number, le: boolean): number {
  return u32(b, o, le) | 0;
}
export function u64be(b: Uint8Array, o: number): number {
  return u32(b, o, false) * 0x100000000 + u32(b, o + 4, false);
}
export function u16be(b: Uint8Array, o: number): number {
  return u16(b, o, false);
}
export function u32be(b: Uint8Array, o: number): number {
  return u32(b, o, false);
}

/** Latin-1 decode of b[o, o+n). Stops at the first NUL when `nulTerm`. */
export function ascii(b: Uint8Array, o: number, n: number, nulTerm = true): string {
  let s = '';
  const end = Math.min(b.length, o + n);
  for (let i = Math.max(0, o); i < end; i++) {
    const c = b[i];
    if (c === 0 && nulTerm) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function startsWith(b: Uint8Array, o: number, sig: string): boolean {
  if (o < 0 || o + sig.length > b.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[o + i] !== sig.charCodeAt(i)) return false;
  return true;
}

let utf8: TextDecoder | undefined;
export function utf8Decode(b: Uint8Array): string {
  try {
    utf8 ??= new TextDecoder('utf-8', { fatal: false });
    return utf8.decode(b);
  } catch {
    return ascii(b, 0, b.length, false);
  }
}

/**
 * Random-access source with a 64 KB head buffer and a tiny chunk cache so that
 * many small header reads (IFD entries, box headers, JPEG markers) coalesce
 * into a few `Reader.read` calls.
 */
export class Src {
  readonly size: number;
  head: Uint8Array = new Uint8Array(0);
  private chunks: { off: number; data: Uint8Array }[] = [];

  constructor(private reader: Reader) {
    this.size = Number.isFinite(reader.size) && reader.size > 0 ? reader.size : 0;
  }

  async init(len = HEAD_SIZE): Promise<Uint8Array> {
    this.head = await this.reader.read(0, Math.min(this.size, len));
    return this.head;
  }

  /**
   * Returns up to `len` bytes at `off` (shorter at EOF, empty when out of range).
   * The returned array may be a view into a cache buffer: do not mutate.
   */
  async get(off: number, len: number): Promise<Uint8Array> {
    off = Math.floor(off);
    len = Math.floor(len);
    if (!(off >= 0) || !(len > 0) || off >= this.size) return new Uint8Array(0);
    len = Math.min(len, this.size - off, MAX_META_READ);
    const end = off + len;
    if (end <= this.head.length) return this.head.subarray(off, end);
    for (const c of this.chunks) {
      if (off >= c.off && end <= c.off + c.data.length) return c.data.subarray(off - c.off, end - c.off);
    }
    const readLen = Math.min(Math.max(len, CHUNK), this.size - off);
    const data = await this.reader.read(off, readLen);
    if (readLen <= CHUNK * 4) {
      this.chunks.push({ off, data });
      if (this.chunks.length > MAX_CACHE_CHUNKS) this.chunks.shift();
    }
    return data.subarray(0, Math.min(len, data.length));
  }
}
