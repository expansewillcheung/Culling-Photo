// ISO-BMFF: CR3 (Canon) and HEIC/HEIF/AVIF item-based images.
import { Src, ascii, u16be, u32be, u64be, utf8Decode } from './bytes';
import { addCand, type Ctx } from './ctx';
import { fillExif, parseExifTiff, T } from './exif';
import { Tiff } from './tiff';
import { parseXmpRating } from './xmpRating';

export interface Box {
  type: string;
  /** Absolute offset of the box start. */
  off: number;
  size: number;
  /** Absolute offset of the payload (after size/type/largesize/uuid). */
  data: number;
  end: number;
  uuid?: string;
}

const MAX_BOXES = 4096;

export async function readBox(src: Src, off: number, limit: number): Promise<Box | null> {
  if (off + 8 > limit) return null;
  const b = await src.get(off, 32);
  if (b.length < 8) return null;
  let size = u32be(b, 0);
  const type = ascii(b, 4, 4, false);
  let hdr = 8;
  if (size === 1) {
    if (b.length < 16) return null;
    size = u64be(b, 8);
    hdr = 16;
  } else if (size === 0) size = limit - off;
  if (size < hdr) return null;
  const box: Box = { type, off, size, data: off + hdr, end: Math.min(off + size, limit) };
  if (type === 'uuid') {
    if (b.length < hdr + 16) return null;
    box.uuid = Array.from(b.subarray(hdr, hdr + 16), (x) => x.toString(16).padStart(2, '0')).join('');
    box.data += 16;
  }
  return box;
}

/** Iterate child boxes in [start, end). */
export async function children(src: Src, start: number, end: number, max = 256): Promise<Box[]> {
  const out: Box[] = [];
  let off = start;
  end = Math.min(end, src.size);
  while (off + 8 <= end && out.length < Math.min(max, MAX_BOXES)) {
    const b = await readBox(src, off, end);
    if (!b) break;
    out.push(b);
    if (b.off + b.size <= off) break;
    off = b.off + b.size;
  }
  return out;
}

const find = (boxes: Box[], type: string) => boxes.find((b) => b.type === type);

// ---------------------------------------------------------------- CR3

const UUID_CANON = '85c0b687820f11e08111f4ce462b6a48';
const UUID_PRVW = 'eaf42b5e1c984b88b9fbb7dc406e4d16';
const UUID_XMP = 'be7acfcb97a942e89c71999491e3afac';

export async function parseCr3(ctx: Ctx): Promise<void> {
  const { src, out } = ctx;
  const ex = out.exif;
  const top = await children(src, 0, src.size, 64);
  const moov = find(top, 'moov');
  if (moov) {
    const mc = await children(src, moov.data, moov.end);
    const canon = mc.find((b) => b.type === 'uuid' && b.uuid === UUID_CANON);
    if (canon) {
      const cc = await children(src, canon.data, canon.end);
      const cmt1 = find(cc, 'CMT1');
      const cmt2 = find(cc, 'CMT2');
      const h1 = cmt1 ? await Tiff.open(src, cmt1.data) : null;
      const h2 = cmt2 ? await Tiff.open(src, cmt2.data) : null;
      const ifd0 = h1 ? await h1.tiff.readIfd(h1.ifd0) : null;
      const exifIfd = h2 ? await h2.tiff.readIfd(h2.ifd0) : null;
      if (h2 && exifIfd) await fillExif(h2.tiff, null, exifIfd, ex);
      if (h1 && ifd0) {
        await fillExif(h1.tiff, ifd0, null, ex);
        const w = await h1.tiff.num(ifd0, T.ImageWidth);
        const hh = await h1.tiff.num(ifd0, T.ImageLength);
        if (w && hh) { ex.width = w; ex.height = hh; }
      }
      const thmb = find(cc, 'THMB');
      if (thmb) {
        const b = await src.get(thmb.data, 16);
        addCand(ctx, thmb.data + 16, u32be(b, 8));
      }
    }
    // Track 1 holds the full-size JPEG in mdat.
    const trak = find(mc, 'trak');
    if (trak) {
      const stbl = await descend(src, trak, ['mdia', 'minf', 'stbl']);
      if (stbl) {
        const sc = await children(src, stbl.data, stbl.end);
        const stsz = find(sc, 'stsz');
        const co64 = find(sc, 'co64');
        const stco = find(sc, 'stco');
        let size = 0;
        let off = 0;
        if (stsz) {
          const b = await src.get(stsz.data, 16);
          size = u32be(b, 4) || u32be(b, 12);
        }
        if (co64) off = u64be(await src.get(co64.data + 8, 8), 0);
        else if (stco) off = u32be(await src.get(stco.data + 8, 4), 0);
        addCand(ctx, off, size);
      }
    }
  }
  for (const b of top) {
    if (b.type !== 'uuid') continue;
    if (b.uuid === UUID_PRVW) {
      const pc = await children(src, b.data + 8, b.end, 4);
      const prvw = find(pc, 'PRVW');
      if (prvw) {
        const h = await src.get(prvw.data, 16);
        addCand(ctx, prvw.data + 16, u32be(h, 12));
      }
    } else if (b.uuid === UUID_XMP && ex.rating === undefined) {
      const x = await src.get(b.data, Math.min(b.end - b.data, 256 * 1024));
      const r = parseXmpRating(utf8Decode(x));
      if (r !== undefined) ex.rating = r;
    }
  }
}

async function descend(src: Src, box: Box, path: string[]): Promise<Box | null> {
  let cur: Box | undefined = box;
  for (const t of path) {
    const c: Box[] = await children(src, cur.data, cur.end);
    cur = find(c, t);
    if (!cur) return null;
  }
  return cur;
}

// ---------------------------------------------------------------- HEIF / AVIF

interface ItemLoc {
  method: number;
  base: number;
  extents: { off: number; len: number }[];
}

export async function parseHeif(ctx: Ctx): Promise<void> {
  const { src, out } = ctx;
  const ex = out.exif;
  const top = await children(src, 0, src.size, 64);
  const meta = find(top, 'meta');
  if (!meta) return;
  const mc = await children(src, meta.data + 4, meta.end);
  let primary = 0;
  const pitm = find(mc, 'pitm');
  if (pitm) {
    const b = await src.get(pitm.data, 8);
    primary = b[0] === 0 ? u16be(b, 4) : u32be(b, 4);
  }
  // iinf: item id -> type
  const types = new Map<number, string>();
  const iinf = find(mc, 'iinf');
  if (iinf) {
    const b = await src.get(iinf.data, 8);
    const start = iinf.data + (b[0] === 0 ? 6 : 8);
    for (const infe of await children(src, start, iinf.end, 4096)) {
      if (infe.type !== 'infe') continue;
      const e = await src.get(infe.data, 16);
      const v = e[0];
      if (v === 2) types.set(u16be(e, 4), ascii(e, 8, 4, false));
      else if (v >= 3) types.set(u32be(e, 4), ascii(e, 10, 4, false));
    }
  }
  const locs = await parseIloc(src, find(mc, 'iloc'));
  // Dimensions: ispe associated with the primary item.
  const iprp = find(mc, 'iprp');
  if (iprp) {
    const pc = await children(src, iprp.data, iprp.end);
    const ipco = find(pc, 'ipco');
    const ipma = find(pc, 'ipma');
    if (ipco && ipma) {
      const props = await children(src, ipco.data, ipco.end, 1024);
      const assoc = await parseIpma(src, ipma);
      const idx = assoc.get(primary) ?? [];
      for (const i of idx) {
        const p = props[i - 1];
        if (p?.type === 'ispe') {
          const b = await src.get(p.data, 12);
          const w = u32be(b, 4);
          const h = u32be(b, 8);
          if (w && h) { ex.width = w; ex.height = h; }
          break;
        }
      }
      if (ex.width === undefined) {
        // Fallback: largest ispe.
        let best = 0;
        for (const p of props) {
          if (p.type !== 'ispe') continue;
          const b = await src.get(p.data, 12);
          const w = u32be(b, 4), h = u32be(b, 8);
          if (w * h > best) { best = w * h; ex.width = w; ex.height = h; }
        }
      }
    }
  }
  for (const [id, type] of types) {
    if (type !== 'Exif') continue;
    const loc = locs.get(id);
    if (!loc || loc.method !== 0 || !loc.extents.length) continue;
    const at = loc.base + loc.extents[0].off;
    const pre = await src.get(at, 4);
    if (pre.length < 4) continue;
    const skip = u32be(pre, 0);
    if (skip > 1024) continue;
    await parseExifTiff(src, at + 4 + skip, ex);
    break;
  }
  for (const [id, type] of types) {
    if (type !== 'mime' || ex.rating !== undefined) continue;
    const loc = locs.get(id);
    if (!loc || loc.method !== 0 || !loc.extents.length) continue;
    const e = loc.extents[0];
    const x = await src.get(loc.base + e.off, Math.min(e.len || 65536, 256 * 1024));
    const r = parseXmpRating(utf8Decode(x));
    if (r !== undefined) ex.rating = r;
  }
}

async function parseIloc(src: Src, iloc: Box | undefined): Promise<Map<number, ItemLoc>> {
  const out = new Map<number, ItemLoc>();
  if (!iloc) return out;
  const b = await src.get(iloc.data, Math.min(iloc.end - iloc.data, 256 * 1024));
  const v = b[0];
  const offSize = b[4] >> 4, lenSize = b[4] & 15, baseSize = b[5] >> 4;
  const idxSize = v === 1 || v === 2 ? b[5] & 15 : 0;
  let p = 6;
  const rd = (n: number): number => {
    let x = 0;
    if (n === 4) x = u32be(b, p);
    else if (n === 8) x = u64be(b, p);
    else if (n === 2) x = u16be(b, p);
    else if (n === 1) x = b[p] ?? 0;
    p += n;
    return x;
  };
  const count = v < 2 ? rd(2) : rd(4);
  for (let i = 0; i < count && i < 4096 && p < b.length; i++) {
    const id = v < 2 ? rd(2) : rd(4);
    const method = v === 1 || v === 2 ? rd(2) & 15 : 0;
    rd(2); // data_reference_index
    const base = rd(baseSize);
    const ec = rd(2);
    const extents: { off: number; len: number }[] = [];
    for (let j = 0; j < ec && j < 1024 && p <= b.length; j++) {
      if (idxSize) rd(idxSize);
      const off = rd(offSize);
      const len = rd(lenSize);
      extents.push({ off, len });
    }
    out.set(id, { method, base, extents });
  }
  return out;
}

async function parseIpma(src: Src, ipma: Box): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  const b = await src.get(ipma.data, Math.min(ipma.end - ipma.data, 256 * 1024));
  const v = b[0];
  const flags = b[3];
  let p = 4;
  const n = u32be(b, p);
  p += 4;
  for (let i = 0; i < n && i < 4096 && p < b.length; i++) {
    const id = v < 1 ? u16be(b, p) : u32be(b, p);
    p += v < 1 ? 2 : 4;
    const ac = b[p++] ?? 0;
    const list: number[] = [];
    for (let j = 0; j < ac; j++) {
      if (flags & 1) { list.push(u16be(b, p) & 0x7fff); p += 2; }
      else { list.push((b[p] ?? 0) & 0x7f); p += 1; }
    }
    out.set(id, list);
  }
  return out;
}
