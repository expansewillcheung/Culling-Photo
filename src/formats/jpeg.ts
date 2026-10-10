// JPEG marker walker: SOF dimensions, APP1 EXIF / XMP locations. Reads only segment headers.
import type { ExifInfo } from '../core/types';
import { Src, u16be, startsWith, utf8Decode } from './bytes';
import { parseExifTiff, type Candidate } from './exif';
import { parseXmpRating } from './xmpRating';

export interface JpegScan {
  width?: number;
  height?: number;
  /** SOF marker byte (0xC0..0xCF). */
  sof?: number;
  /** Absolute offset of the EXIF TIFF header inside APP1. */
  exifAt?: number;
  exifLen?: number;
  xmpAt?: number;
  xmpLen?: number;
}

const MAX_MARKERS = 256;
const XMP_SIG = 'http://ns.adobe.com/xap/1.0/\0';

/** Decodable by browsers natively: baseline, extended sequential, progressive (Huffman). */
export function isDecodableSof(m: number | undefined): boolean {
  return m === 0xc0 || m === 0xc1 || m === 0xc2;
}

/**
 * Walk markers of a JPEG starting at `off` (SOI). Stops at SOF (or SOS/EOI).
 * `limit` bounds the walk to the declared JPEG length.
 */
export async function scanJpeg(src: Src, off: number, limit = Infinity, wantApp = false): Promise<JpegScan | null> {
  const soi = await src.get(off, 4);
  if (soi.length < 4 || soi[0] !== 0xff || soi[1] !== 0xd8 || soi[2] !== 0xff) return null;
  const end = Math.min(src.size, off + limit);
  const res: JpegScan = {};
  let p = off + 2;
  for (let i = 0; i < MAX_MARKERS && p + 4 <= end; i++) {
    const b = await src.get(p, 12);
    if (b.length < 4) break;
    if (b[0] !== 0xff) break;
    const m = b[1];
    if (m === 0xff) { p += 1; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
    if (m === 0xd9 || m === 0xda) break;
    const len = u16be(b, 2);
    if (len < 2) break;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (b.length >= 9) {
        res.sof = m;
        res.height = u16be(b, 5);
        res.width = u16be(b, 7);
      }
      break;
    }
    if (wantApp && m === 0xe1) {
      const segStart = p + 4;
      const segLen = len - 2;
      const hdr = await src.get(segStart, 32);
      if (res.exifAt === undefined && startsWith(hdr, 0, 'Exif\0')) {
        res.exifAt = segStart + 6;
        res.exifLen = segLen - 6;
      } else if (res.xmpAt === undefined && startsWith(hdr, 0, XMP_SIG)) {
        res.xmpAt = segStart + XMP_SIG.length;
        res.xmpLen = segLen - XMP_SIG.length;
      }
    }
    p += 2 + len;
  }
  return res;
}

/** Parse EXIF + XMP rating found by `scanJpeg` into `ex`. Returns the IFD1 thumbnail if any. */
export async function readJpegMeta(src: Src, scan: JpegScan, ex: ExifInfo): Promise<{ thumb?: Candidate; pixelWidth?: number; pixelHeight?: number }> {
  const out: { thumb?: Candidate; pixelWidth?: number; pixelHeight?: number } = {};
  if (scan.exifAt !== undefined) {
    const r = await parseExifTiff(src, scan.exifAt, ex);
    if (r) {
      out.thumb = r.thumb;
      out.pixelWidth = r.pixelWidth;
      out.pixelHeight = r.pixelHeight;
    }
  }
  if (scan.xmpAt !== undefined && scan.xmpLen && ex.rating === undefined) {
    const b = await src.get(scan.xmpAt, Math.min(scan.xmpLen, 256 * 1024));
    const r = parseXmpRating(utf8Decode(b));
    if (r !== undefined) ex.rating = r;
  }
  return out;
}
