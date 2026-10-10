// Fujifilm RAF: fixed big-endian header pointing to an embedded JPEG (with EXIF) and a
// tag directory holding the sensor geometry.
import { u16be, u32be } from './bytes';
import { addCand, type Ctx } from './ctx';
import { readJpegMeta, scanJpeg } from './jpeg';

export async function parseRaf(ctx: Ctx): Promise<void> {
  const { src, out } = ctx;
  const ex = out.exif;
  const h = await src.get(0, 160);
  if (h.length < 100) return;
  const jpegOff = u32be(h, 84);
  const jpegLen = u32be(h, 88);
  const dirOff = u32be(h, 92);
  if (jpegOff && jpegLen) {
    addCand(ctx, jpegOff, jpegLen);
    const scan = await scanJpeg(src, jpegOff, jpegLen, true);
    if (scan) {
      const m = await readJpegMeta(src, scan, ex);
      if (m.thumb) addCand(ctx, m.thumb.offset, m.thumb.length);
    }
  }
  if (dirOff && dirOff < src.size) {
    const d = await src.get(dirOff, 4096);
    const n = u32be(d, 0);
    let p = 4;
    let full: [number, number] | undefined;
    let crop: [number, number] | undefined;
    for (let i = 0; i < n && i < 128 && p + 4 <= d.length; i++) {
      const tag = u16be(d, p);
      const size = u16be(d, p + 2);
      const v = p + 4;
      if (size === 4 && v + 4 <= d.length) {
        // (height, width)
        if (tag === 0x100) full = [u16be(d, v + 2), u16be(d, v)];
        else if (tag === 0x111) crop = [u16be(d, v + 2), u16be(d, v)];
      }
      p = v + size;
    }
    const dim = crop && crop[0] && crop[1] ? crop : full;
    if (dim && dim[0] && dim[1]) {
      ex.width = dim[0];
      ex.height = dim[1];
    }
  }
}
