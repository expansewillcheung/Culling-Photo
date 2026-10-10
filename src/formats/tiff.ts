// Generic TIFF / IFD reader. Offsets inside IFD entries are relative to `base`
// (the TIFF header position, or a MakerNote start for some vendors).
import { Src, u16, u32, i32, ascii } from './bytes';

export interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Absolute file offset of the value bytes. */
  valueOff: number;
  /** Total value size in bytes. */
  size: number;
}

export interface Ifd {
  off: number;
  entries: Map<number, IfdEntry>;
  /** Absolute offset of the next IFD in the chain, 0 if none. */
  next: number;
}

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4, 0, 0, 8, 8, 8];
const MAX_ENTRIES = 1000;
const MAX_VALUES = 4096;

export class Tiff {
  constructor(
    readonly src: Src,
    /** Absolute offset that entry offsets are relative to. */
    readonly base: number,
    readonly le: boolean,
  ) {}

  /** Parses a TIFF header at absolute offset `at`. Returns tiff + IFD0 absolute offset. */
  static async open(src: Src, at: number): Promise<{ tiff: Tiff; ifd0: number; magic: number } | null> {
    const h = await src.get(at, 8);
    if (h.length < 8) return null;
    let le: boolean;
    if (h[0] === 0x49 && h[1] === 0x49) le = true;
    else if (h[0] === 0x4d && h[1] === 0x4d) le = false;
    else return null;
    const magic = u16(h, 2, le);
    const ifd0 = u32(h, 4, le);
    return { tiff: new Tiff(src, at, le), ifd0: ifd0 ? at + ifd0 : 0, magic };
  }

  async readIfd(absOff: number): Promise<Ifd | null> {
    if (!(absOff > 0) || absOff + 2 > this.src.size) return null;
    const cb = await this.src.get(absOff, 2);
    const n = u16(cb, 0, this.le);
    if (n === 0 || n > MAX_ENTRIES) return null;
    const b = await this.src.get(absOff + 2, n * 12 + 4);
    const avail = Math.min(n, Math.floor(b.length / 12));
    if (avail === 0) return null;
    const entries = new Map<number, IfdEntry>();
    for (let i = 0; i < avail; i++) {
      const p = i * 12;
      const tag = u16(b, p, this.le);
      const type = u16(b, p + 2, this.le);
      const count = u32(b, p + 4, this.le);
      const ts = TYPE_SIZE[type] ?? 0;
      if (ts === 0) continue;
      const size = ts * count;
      if (!Number.isFinite(size)) continue;
      const valueOff = size <= 4 ? absOff + 2 + p + 8 : this.base + u32(b, p + 8, this.le);
      if (!entries.has(tag)) entries.set(tag, { tag, type, count, valueOff, size });
    }
    const nextRel = b.length >= n * 12 + 4 ? u32(b, n * 12, this.le) : 0;
    return { off: absOff, entries, next: nextRel ? this.base + nextRel : 0 };
  }

  /** Numeric values of an entry (rationals become floats). */
  async nums(e: IfdEntry | undefined, max = 64): Promise<number[]> {
    if (!e || e.count === 0) return [];
    const count = Math.min(e.count, max, MAX_VALUES);
    const ts = TYPE_SIZE[e.type] ?? 0;
    if (!ts) return [];
    const b = await this.src.get(e.valueOff, count * ts);
    const le = this.le;
    const out: number[] = [];
    const n = Math.min(count, Math.floor(b.length / ts));
    for (let i = 0; i < n; i++) {
      const o = i * ts;
      let v: number;
      switch (e.type) {
        case 1: case 2: case 7: v = b[o]; break;
        case 6: v = (b[o] << 24) >> 24; break;
        case 3: v = u16(b, o, le); break;
        case 8: v = (u16(b, o, le) << 16) >> 16; break;
        case 4: case 13: v = u32(b, o, le); break;
        case 9: v = i32(b, o, le); break;
        case 5: { const d = u32(b, o + 4, le); v = d ? u32(b, o, le) / d : NaN; break; }
        case 10: { const d = i32(b, o + 4, le); v = d ? i32(b, o, le) / d : NaN; break; }
        case 11: v = new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, le); break;
        case 12: v = new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, le); break;
        default: v = NaN;
      }
      out.push(v);
    }
    return out;
  }

  async num(ifd: Ifd | null | undefined, tag: number): Promise<number | undefined> {
    const e = ifd?.entries.get(tag);
    if (!e) return undefined;
    const v = (await this.nums(e, 1))[0];
    return v !== undefined && Number.isFinite(v) ? v : undefined;
  }

  async str(ifd: Ifd | null | undefined, tag: number, max = 256): Promise<string | undefined> {
    const e = ifd?.entries.get(tag);
    if (!e || e.count === 0) return undefined;
    if (e.type !== 2 && e.type !== 7 && e.type !== 1) return undefined;
    const b = await this.src.get(e.valueOff, Math.min(e.count, max));
    const s = ascii(b, 0, b.length).trim();
    return s || undefined;
  }

  async bytes(e: IfdEntry | undefined, max: number): Promise<Uint8Array> {
    if (!e) return new Uint8Array(0);
    return this.src.get(e.valueOff, Math.min(e.size, max));
  }

  /** Absolute offsets of sub-IFDs referenced by `tag` (LONG or IFD typed). */
  async subIfdOffsets(ifd: Ifd | null | undefined, tag: number, max = 16): Promise<number[]> {
    const e = ifd?.entries.get(tag);
    if (!e) return [];
    if (e.type !== 4 && e.type !== 13 && e.type !== 9) return [];
    const v = await this.nums(e, max);
    return v.filter((x) => x > 0).map((x) => this.base + x);
  }
}

/** Walk state guarding against IFD loops. */
export class IfdVisitor {
  private seen = new Set<number>();
  count = 0;
  constructor(readonly maxIfds = 64) {}
  visit(off: number): boolean {
    if (!(off > 0) || this.seen.has(off) || this.count >= this.maxIfds) return false;
    this.seen.add(off);
    this.count++;
    return true;
  }
}
