// EXIF tag mapping -> normalised ExifInfo.
import type { ExifInfo } from '../core/types';
import { Src } from './bytes';
import { Tiff, Ifd, IfdVisitor } from './tiff';
import { parseXmpRating } from './xmpRating';
import { utf8Decode } from './bytes';

export const T = {
  NewSubFileType: 0xfe,
  ImageWidth: 0x100,
  ImageLength: 0x101,
  Compression: 0x103,
  Make: 0x10f,
  Model: 0x110,
  StripOffsets: 0x111,
  Orientation: 0x112,
  StripByteCounts: 0x117,
  DateTime: 0x132,
  SubIFDs: 0x14a,
  JpegOffset: 0x201,
  JpegLength: 0x202,
  XMP: 0x2bc,
  ExposureTime: 0x829a,
  FNumber: 0x829d,
  ExifIFD: 0x8769,
  ISO: 0x8827,
  RecommendedExposureIndex: 0x8832,
  ISOSpeed: 0x8833,
  DateTimeOriginal: 0x9003,
  CreateDate: 0x9004,
  FocalLength: 0x920a,
  MakerNote: 0x927c,
  SubSecTimeOriginal: 0x9291,
  SubSecTimeDigitized: 0x9292,
  PixelXDimension: 0xa002,
  PixelYDimension: 0xa003,
  LensModel: 0xa434,
} as const;

/** A JPEG location found while parsing (unvalidated). */
export interface Candidate {
  offset: number;
  length: number;
}

const finite = (v: number | undefined): number | undefined =>
  v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined;

/** "YYYY:MM:DD HH:MM:SS" (+ sub-second digits) -> ms, wall clock taken as UTC. */
export function exifDateToMs(s: string | undefined, subsec?: string): number | undefined {
  if (!s) return undefined;
  const m = /^(\d{4})[:\-/](\d{2})[:\-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?/.exec(s.trim());
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  if (y < 1800 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || se > 60) return undefined;
  let ms = Date.UTC(y, mo - 1, d, h, mi, se);
  const frac = (subsec ?? '').trim().replace(/[^0-9].*$/, '') || m[7] || '';
  if (frac) ms += Math.round(Number('0.' + frac) * 1000);
  return Number.isFinite(ms) ? ms : undefined;
}

function setIf<K extends keyof ExifInfo>(ex: ExifInfo, k: K, v: ExifInfo[K] | undefined): void {
  if (ex[k] === undefined && v !== undefined) ex[k] = v;
}

/** Fill `ex` (only fields not yet set) from IFD0-like and ExifIFD-like directories. */
export async function fillExif(t: Tiff, ifd0: Ifd | null, exif: Ifd | null, ex: ExifInfo): Promise<void> {
  if (ifd0) {
    setIf(ex, 'make', await t.str(ifd0, T.Make));
    setIf(ex, 'model', await t.str(ifd0, T.Model));
    const o = await t.num(ifd0, T.Orientation);
    if (o !== undefined && o >= 1 && o <= 8) setIf(ex, 'orientation', o);
  }
  const dirs = [exif, ifd0].filter((d): d is Ifd => !!d);
  for (const d of dirs) {
    setIf(ex, 'exposureTime', finite(await t.num(d, T.ExposureTime)));
    setIf(ex, 'fNumber', finite(await t.num(d, T.FNumber)));
    setIf(ex, 'focalLength', finite(await t.num(d, T.FocalLength)));
    let iso = finite(await t.num(d, T.ISO));
    if (iso === 65535) iso = undefined;
    iso ??= finite(await t.num(d, T.ISOSpeed));
    iso ??= finite(await t.num(d, T.RecommendedExposureIndex));
    setIf(ex, 'iso', iso);
    setIf(ex, 'lens', await t.str(d, T.LensModel));
  }
  if (ex.captureTime === undefined) {
    for (const d of dirs) {
      const v = exifDateToMs(await t.str(d, T.DateTimeOriginal), await t.str(d, T.SubSecTimeOriginal));
      if (v !== undefined) { ex.captureTime = v; break; }
    }
  }
  if (ex.captureTime === undefined) {
    for (const d of dirs) {
      const v = exifDateToMs(await t.str(d, T.CreateDate), await t.str(d, T.SubSecTimeDigitized));
      if (v !== undefined) { ex.captureTime = v; break; }
    }
  }
}

export async function readXmpRatingTag(t: Tiff, ifd: Ifd | null): Promise<number | undefined> {
  const e = ifd?.entries.get(T.XMP);
  if (!e || e.size === 0) return undefined;
  const b = await t.bytes(e, 512 * 1024);
  return parseXmpRating(utf8Decode(b));
}

export interface TiffExifResult {
  tiff: Tiff;
  ifd0: Ifd | null;
  exif: Ifd | null;
  ifd1: Ifd | null;
  /** IFD1 thumbnail (absolute offset). */
  thumb?: Candidate;
  pixelWidth?: number;
  pixelHeight?: number;
}

/**
 * Parse a self-contained EXIF TIFF blob at absolute offset `at` (APP1 payload after
 * "Exif\0\0", HEIC Exif item, WebP EXIF chunk...). Fills `ex` and returns directories.
 */
export async function parseExifTiff(src: Src, at: number, ex: ExifInfo): Promise<TiffExifResult | null> {
  const h = await Tiff.open(src, at);
  if (!h) return null;
  const { tiff } = h;
  const vis = new IfdVisitor(8);
  const ifd0 = vis.visit(h.ifd0) ? await tiff.readIfd(h.ifd0) : null;
  let exif: Ifd | null = null;
  const eo = (await tiff.subIfdOffsets(ifd0, T.ExifIFD, 1))[0];
  if (eo && vis.visit(eo)) exif = await tiff.readIfd(eo);
  await fillExif(tiff, ifd0, exif, ex);
  const res: TiffExifResult = { tiff, ifd0, exif, ifd1: null };
  if (exif) {
    res.pixelWidth = finite(await tiff.num(exif, T.PixelXDimension));
    res.pixelHeight = finite(await tiff.num(exif, T.PixelYDimension));
  }
  if (ifd0) {
    const r = await readXmpRatingTag(tiff, ifd0);
    if (r !== undefined) setIf(ex, 'rating', r);
  }
  if (ifd0 && ifd0.next && vis.visit(ifd0.next)) {
    const ifd1 = await tiff.readIfd(ifd0.next);
    res.ifd1 = ifd1;
    const off = await tiff.num(ifd1, T.JpegOffset);
    const len = await tiff.num(ifd1, T.JpegLength);
    if (off && len) res.thumb = { offset: at + off, length: len };
  }
  return res;
}
