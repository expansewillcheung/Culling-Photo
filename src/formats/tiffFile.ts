// TIFF-container files: CR2, NEF/NRW, ARW, DNG, PEF, SRW, ORF, RW2, 3FR/IIQ (best effort) and plain TIFF.
import { startsWith } from './bytes';
import { addCand, type Ctx } from './ctx';
import { fillExif, readXmpRatingTag, T } from './exif';
import { readJpegMeta, scanJpeg } from './jpeg';
import { Ifd, IfdVisitor, Tiff } from './tiff';

interface IfdInfo {
  ifd: Ifd;
  sub?: number;
  w?: number;
  h?: number;
}

/** NewSubFileType bits other than "reduced resolution" mark masks/depth maps/etc. */
const isImageSubfile = (sub: number | undefined) => sub === undefined || (sub & ~1) === 0;

export async function parseTiffFile(ctx: Ctx, at = 0): Promise<void> {
  const { src, out } = ctx;
  const ex = out.exif;
  const h = await Tiff.open(src, at);
  if (!h) return;
  const t = h.tiff;
  const vis = new IfdVisitor(64);
  const infos: IfdInfo[] = [];
  let ifd0: Ifd | null = null;
  let exifIfd: Ifd | null = null;

  const collect = async (ifd: Ifd, info: IfdInfo) => {
    if (!isImageSubfile(info.sub)) return;
    const jo = await t.num(ifd, T.JpegOffset);
    const jl = await t.num(ifd, T.JpegLength);
    if (jo && jl) addCand(ctx, t.base + jo, jl);
    const comp = await t.num(ifd, T.Compression);
    if ((comp === 6 || comp === 7) && info.sub !== 0) {
      const so = ifd.entries.get(T.StripOffsets);
      const sc = ifd.entries.get(T.StripByteCounts);
      if (so && sc && so.count === 1 && sc.count === 1) {
        const o = (await t.nums(so, 1))[0];
        const l = (await t.nums(sc, 1))[0];
        if (o && l) addCand(ctx, t.base + o, l);
      }
    }
  };

  const walk = async (start: number, depth: number): Promise<void> => {
    let cur = start;
    for (let n = 0; n < 16 && cur && vis.visit(cur); n++) {
      const ifd = await t.readIfd(cur);
      if (!ifd) break;
      ifd0 ??= ifd;
      const info: IfdInfo = {
        ifd,
        sub: await t.num(ifd, T.NewSubFileType),
        w: await t.num(ifd, T.ImageWidth),
        h: await t.num(ifd, T.ImageLength),
      };
      infos.push(info);
      await collect(ifd, info);
      if (!exifIfd) {
        const eo = (await t.subIfdOffsets(ifd, T.ExifIFD, 1))[0];
        if (eo && vis.visit(eo)) exifIfd = await t.readIfd(eo);
      }
      if (depth < 3) for (const so of await t.subIfdOffsets(ifd, T.SubIFDs, 16)) await walk(so, depth + 1);
      cur = ifd.next;
    }
  };
  await walk(h.ifd0, 0);

  const isRw2 = h.magic === 0x55;
  if (isRw2 && ifd0) await panasonic(ctx, t, ifd0);

  await fillExif(t, ifd0, exifIfd, ex);
  const rating = await readXmpRatingTag(t, ifd0);
  if (rating !== undefined && ex.rating === undefined) ex.rating = rating;

  if (exifIfd) await makerNote(ctx, t, exifIfd);

  // Full image dimensions.
  if (ex.width === undefined) {
    const big = (i: IfdInfo) => (i.w ?? 0) >= 1000 && (i.h ?? 0) > 0;
    const main =
      infos.find((i) => i.sub === 0 && big(i)) ??
      (infos[0] && big(infos[0]) && isImageSubfile(infos[0].sub) ? infos[0] : undefined) ??
      infos.filter((i) => i.w && i.h && isImageSubfile(i.sub)).sort((a, b) => b.w! * b.h! - a.w! * a.h!)[0];
    if (main) {
      ex.width = main.w;
      ex.height = main.h;
    } else if (exifIfd) {
      const pw = await t.num(exifIfd, T.PixelXDimension);
      const ph = await t.num(exifIfd, T.PixelYDimension);
      if (pw && ph) { ex.width = pw; ex.height = ph; }
    }
  }
}

/** RW2/RWL: sensor geometry, ISO, and the JpgFromRaw (0x2E) that carries the real EXIF. */
async function panasonic(ctx: Ctx, t: Tiff, ifd0: Ifd): Promise<void> {
  const ex = ctx.out.exif;
  const top = await t.num(ifd0, 0x04);
  const left = await t.num(ifd0, 0x05);
  const bottom = await t.num(ifd0, 0x06);
  const right = await t.num(ifd0, 0x07);
  if (right && bottom && right > (left ?? 0) && bottom > (top ?? 0)) {
    ex.width = right - (left ?? 0);
    ex.height = bottom - (top ?? 0);
  } else {
    const sw = await t.num(ifd0, 0x02);
    const sh = await t.num(ifd0, 0x03);
    if (sw && sh) { ex.width = sw; ex.height = sh; }
  }
  const iso = await t.num(ifd0, 0x17);
  if (iso && iso > 0 && iso < 65535) ex.iso = iso;
  const jfr = ifd0.entries.get(0x2e);
  if (jfr && jfr.size > 4) {
    addCand(ctx, jfr.valueOff, jfr.size);
    // IFD0 values (make/model/orientation) take precedence; JPEG EXIF fills the rest.
    await fillExif(t, ifd0, null, ex);
    const scan = await scanJpeg(ctx.src, jfr.valueOff, jfr.size, true);
    if (scan) {
      const m = await readJpegMeta(ctx.src, scan, ex);
      if (m.thumb) addCand(ctx, m.thumb.offset, m.thumb.length);
    }
  }
}

/** Vendor MakerNote previews. Currently: Olympus / OM System CameraSettings PreviewImage. */
async function makerNote(ctx: Ctx, t: Tiff, exifIfd: Ifd): Promise<void> {
  const e = exifIfd.entries.get(T.MakerNote);
  if (!e || e.size < 16) return;
  const { src } = ctx;
  const mn = e.valueOff;
  const hdr = await src.get(mn, 16);
  let base: number, le: boolean, ifdOff: number;
  if (startsWith(hdr, 0, 'OLYMPUS\0')) {
    base = mn; le = hdr[8] === 0x49; ifdOff = mn + 12;
  } else if (startsWith(hdr, 0, 'OM SYSTEM\0')) {
    base = mn; le = hdr[12] === 0x49; ifdOff = mn + 16;
  } else if (startsWith(hdr, 0, 'OLYMP\0') || startsWith(hdr, 0, 'EPSON\0')) {
    base = t.base; le = t.le; ifdOff = mn + 8;
  } else return;
  const mt = new Tiff(src, base, le);
  const ifd = await mt.readIfd(ifdOff);
  if (!ifd) return;
  const th = ifd.entries.get(0x0100);
  if (th && th.type === 7 && th.size > 100) addCand(ctx, th.valueOff, th.size);
  const cs = ifd.entries.get(0x2020);
  if (!cs) return;
  let csOff: number;
  if (cs.type === 7) csOff = cs.valueOff;
  else csOff = base + ((await mt.nums(cs, 1))[0] ?? 0);
  if (csOff === base) return;
  const csIfd = await mt.readIfd(csOff);
  const ps = await mt.num(csIfd, 0x0101);
  const pl = await mt.num(csIfd, 0x0102);
  if (ps && pl) addCand(ctx, base + ps, pl);
}
