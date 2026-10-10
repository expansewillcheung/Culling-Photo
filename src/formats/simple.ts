// Natively decodable / simple containers: JPEG, PNG, WebP, GIF, JXL, XMP sidecars.
import { ascii, startsWith, u16, u32, u32be, utf8Decode } from './bytes';
import { children } from './bmff';
import { addCand, type Ctx } from './ctx';
import { parseExifTiff } from './exif';
import { readJpegMeta, scanJpeg } from './jpeg';
import { parseXmpRating } from './xmpRating';

export async function parseJpegFile(ctx: Ctx): Promise<void> {
  const { src, out } = ctx;
  const scan = await scanJpeg(src, 0, Infinity, true);
  if (!scan) return;
  if (scan.width && scan.height) {
    out.exif.width = scan.width;
    out.exif.height = scan.height;
  }
  const m = await readJpegMeta(src, scan, out.exif);
  if (m.thumb) addCand(ctx, m.thumb.offset, m.thumb.length);
}

/** EXIF blob that may or may not start with "Exif\0\0". */
async function exifBlob(ctx: Ctx, at: number): Promise<void> {
  const h = await ctx.src.get(at, 6);
  const skip = startsWith(h, 0, 'Exif\0') ? 6 : 0;
  await parseExifTiff(ctx.src, at + skip, ctx.out.exif);
}

async function xmpBlob(ctx: Ctx, at: number, len: number): Promise<void> {
  if (ctx.out.exif.rating !== undefined) return;
  const b = await ctx.src.get(at, Math.min(len, 256 * 1024));
  const r = parseXmpRating(utf8Decode(b));
  if (r !== undefined) ctx.out.exif.rating = r;
}

export async function parsePng(ctx: Ctx): Promise<void> {
  const { src, out } = ctx;
  const h = await src.get(0, 33);
  if (startsWith(h, 12, 'IHDR')) {
    out.exif.width = u32be(h, 16) || undefined;
    out.exif.height = u32be(h, 20) || undefined;
  }
  let p = 8;
  let foundExif = false;
  for (let i = 0; i < 256 && p + 8 <= src.size; i++) {
    const c = await src.get(p, 8);
    if (c.length < 8) break;
    const len = u32be(c, 0);
    const type = ascii(c, 4, 4, false);
    if (type === 'IDAT' || type === 'IEND') break;
    if (type === 'eXIf') { await exifBlob(ctx, p + 8); foundExif = true; }
    else if (type === 'iTXt') {
      const k = await src.get(p + 8, 18);
      if (startsWith(k, 0, 'XML:com.adobe.xmp\0')) await xmpBlob(ctx, p + 8, len);
    }
    p += 12 + len;
  }
  if (!foundExif && src.size > 64) {
    // eXIf after the image data (e.g. ImageMagick): scan the file tail for the chunk.
    const tailLen = Math.min(src.size, 256 * 1024);
    const start = src.size - tailLen;
    const t = await src.get(start, tailLen);
    for (let i = t.length - 8; i >= 4; i--) {
      if (t[i] === 0x65 && t[i + 1] === 0x58 && t[i + 2] === 0x49 && t[i + 3] === 0x66) {
        const len = u32be(t, i - 4);
        if (start + i + 4 + len + 4 <= src.size) { await exifBlob(ctx, start + i + 4); break; }
      }
    }
  }
}

export async function parseWebp(ctx: Ctx): Promise<void> {
  const { src, out } = ctx;
  const ex = out.exif;
  let p = 12;
  const end = Math.min(src.size, u32(await src.get(4, 4), 0, true) + 8);
  for (let i = 0; i < 64 && p + 8 <= end; i++) {
    const c = await src.get(p, 8);
    if (c.length < 8) break;
    const type = ascii(c, 0, 4, false);
    const len = u32(c, 4, true);
    const d = p + 8;
    if (type === 'VP8X') {
      const b = await src.get(d, 10);
      ex.width = (b[4] | (b[5] << 8) | (b[6] << 16)) + 1;
      ex.height = (b[7] | (b[8] << 8) | (b[9] << 16)) + 1;
    } else if (type === 'VP8 ' && ex.width === undefined) {
      const b = await src.get(d, 10);
      if (b[3] === 0x9d && b[4] === 0x01 && b[5] === 0x2a) {
        ex.width = u16(b, 6, true) & 0x3fff;
        ex.height = u16(b, 8, true) & 0x3fff;
      }
    } else if (type === 'VP8L' && ex.width === undefined) {
      const b = await src.get(d, 5);
      if (b[0] === 0x2f) {
        const bits = u32(b, 1, true);
        ex.width = (bits & 0x3fff) + 1;
        ex.height = ((bits >>> 14) & 0x3fff) + 1;
      }
    } else if (type === 'EXIF') await exifBlob(ctx, d);
    else if (type === 'XMP ') await xmpBlob(ctx, d, len);
    p = d + len + (len & 1);
  }
}

export async function parseGif(ctx: Ctx): Promise<void> {
  const h = await ctx.src.get(0, 10);
  if (h.length < 10) return;
  ctx.out.exif.width = u16(h, 6, true) || undefined;
  ctx.out.exif.height = u16(h, 8, true) || undefined;
}

export async function parseXmpSidecar(ctx: Ctx): Promise<void> {
  await xmpBlob(ctx, 0, Math.min(ctx.src.size, 1024 * 1024));
}

// ---------------------------------------------------------------- JPEG XL

class Bits {
  private pos = 0;
  constructor(private b: Uint8Array) {}
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.pos >> 3] ?? 0;
      v += ((byte >> (this.pos & 7)) & 1) * 2 ** i;
      this.pos++;
    }
    return v;
  }
  u32(d: [number, number][]): number {
    const [off, bits] = d[this.read(2)];
    return off + this.read(bits);
  }
}

/** Parse SizeHeader following the FF 0A signature. */
export function jxlSize(cs: Uint8Array): { width: number; height: number } | null {
  if (cs.length < 4 || cs[0] !== 0xff || cs[1] !== 0x0a) return null;
  const r = new Bits(cs.subarray(2));
  const dist: [number, number][] = [[1, 9], [1, 13], [1, 18], [1, 30]];
  const small = r.read(1);
  const height = small ? (r.read(5) + 1) * 8 : r.u32(dist);
  const ratio = r.read(3);
  let width: number;
  switch (ratio) {
    case 0: width = small ? (r.read(5) + 1) * 8 : r.u32(dist); break;
    case 1: width = height; break;
    case 2: width = Math.floor((height * 12) / 10); break;
    case 3: width = Math.floor((height * 4) / 3); break;
    case 4: width = Math.floor((height * 3) / 2); break;
    case 5: width = Math.floor((height * 16) / 9); break;
    case 6: width = Math.floor((height * 5) / 4); break;
    default: width = height * 2;
  }
  return width && height ? { width, height } : null;
}

export async function parseJxl(ctx: Ctx): Promise<void> {
  const { src, out } = ctx;
  const head = await src.get(0, 16);
  let cs: Uint8Array | null = null;
  if (head[0] === 0xff && head[1] === 0x0a) cs = await src.get(0, 32);
  else {
    for (const b of await children(src, 0, src.size, 128)) {
      if (!cs && b.type === 'jxlc') cs = await src.get(b.data, 32);
      else if (!cs && b.type === 'jxlp') cs = await src.get(b.data + 4, 32);
      else if (b.type === 'Exif') {
        const pre = await src.get(b.data, 4);
        const skip = u32be(pre, 0);
        if (skip < 1024) await parseExifTiff(src, b.data + 4 + skip, out.exif);
      } else if (b.type === 'xml ') await xmpBlob(ctx, b.data, b.end - b.data);
      // 'brob' (Brotli-compressed Exif/XMP) is not decoded.
    }
  }
  const s = cs ? jxlSize(cs) : null;
  if (s) {
    out.exif.width = s.width;
    out.exif.height = s.height;
  }
}
