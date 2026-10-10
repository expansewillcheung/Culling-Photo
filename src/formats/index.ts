// CONTRACT (owned by formats agent). Pure TS, no DOM: must run in node, workers and main thread.
import type { EmbeddedImage, EmbeddedRole, ExifInfo, ParsedFile, Reader } from '../core/types';
import { Src, HEAD_SIZE } from './bytes';
import { parseCr3, parseHeif } from './bmff';
import type { Ctx } from './ctx';
import { detectFormat as detect } from './detect';
import { isDecodableSof, scanJpeg } from './jpeg';
import { parseRaf } from './raf';
import { parseGif, parseJpegFile, parseJxl, parsePng, parseWebp, parseXmpSidecar } from './simple';
import { parseTiffFile } from './tiffFile';

export { parseXmpRating } from './xmpRating';

/** Identify file kind/format from extension + first bytes (>= 64 bytes recommended). */
export const detectFormat = detect;

/** Long edge below which an embedded JPEG is a 'thumb'. */
export const THUMB_MAX_EDGE = 640;
/** An embedded JPEG whose long edge is >= this fraction of the image's is 'full'. */
export const FULL_RATIO = 0.9;

/**
 * Parse container + EXIF, list embedded JPEG previews. Must read only what it needs
 * (headers/IFDs), never the full RAW payload. Never throws for unknown formats:
 * returns { kind: 'other', images: [] }.
 */
export async function parseFile(reader: Reader, name: string): Promise<ParsedFile> {
  const out: ParsedFile = { format: 'UNKNOWN', kind: 'other', exif: {}, images: [] };
  let src: Src;
  try {
    src = new Src(reader);
    const head = await src.init(HEAD_SIZE);
    const d = detect(head, name);
    out.format = d.format;
    out.kind = d.kind;
  } catch {
    return out;
  }
  const ctx: Ctx = { src, out, cands: [] };
  try {
    await dispatch(ctx);
  } catch {
    // partial result
  }
  try {
    await finalizeImages(ctx);
  } catch {
    // keep whatever was validated
  }
  sanitize(out.exif);
  return out;
}

async function dispatch(ctx: Ctx): Promise<void> {
  const { format, kind } = ctx.out;
  switch (kind) {
    case 'jpeg': return parseJpegFile(ctx);
    case 'png': return parsePng(ctx);
    case 'webp': return parseWebp(ctx);
    case 'gif': return parseGif(ctx);
    case 'jxl': return parseJxl(ctx);
    case 'heic':
    case 'avif': return parseHeif(ctx);
    case 'xmp': return parseXmpSidecar(ctx);
    case 'tiff': return parseTiffFile(ctx);
    case 'raw':
      if (format === 'CR3') return parseCr3(ctx);
      if (format === 'RAF') return parseRaf(ctx);
      return parseTiffFile(ctx);
    default:
      return;
  }
}

function roleFor(w: number, h: number, ex: ExifInfo): EmbeddedRole {
  const edge = Math.max(w, h);
  if (edge < THUMB_MAX_EDGE) return 'thumb';
  const imgEdge = Math.max(ex.width ?? 0, ex.height ?? 0);
  if (imgEdge > 0 && edge >= FULL_RATIO * imgEdge) return 'full';
  return 'preview';
}

/** Validate candidates (SOI + decodable SOF inside the declared length), read their dims. */
async function finalizeImages(ctx: Ctx): Promise<void> {
  const { src, out } = ctx;
  const seen = new Set<number>();
  // HEIC/AVIF expose no embedded JPEG by contract; JPEG/RAW/TIFF etc. keep their thumbs.
  if (out.kind === 'heic' || out.kind === 'avif') return;
  for (const c of ctx.cands) {
    if (seen.has(c.offset)) continue;
    seen.add(c.offset);
    try {
      if (c.offset < 0 || c.length < 64 || c.offset + c.length > src.size) continue;
      const s = await scanJpeg(src, c.offset, c.length, false);
      if (!s || !isDecodableSof(s.sof) || !s.width || !s.height) continue;
      const img: EmbeddedImage = {
        offset: c.offset,
        length: c.length,
        mime: 'image/jpeg',
        width: s.width,
        height: s.height,
        role: roleFor(s.width, s.height, out.exif),
      };
      out.images.push(img);
    } catch {
      // drop invalid entry
    }
  }
}

function sanitize(ex: ExifInfo): void {
  for (const k of Object.keys(ex) as (keyof ExifInfo)[]) {
    const v = ex[k];
    if (v === undefined || (typeof v === 'number' && !Number.isFinite(v))) delete ex[k];
  }
  if (ex.make) ex.make = ex.make.trim();
  if (ex.model) ex.model = ex.model.trim();
  if (ex.lens) ex.lens = ex.lens.trim();
}

const longEdge = (i: EmbeddedImage) => Math.max(i.width ?? 0, i.height ?? 0);

/**
 * Choose the best embedded image for a target long edge (px): smallest one whose
 * long edge >= target, else the largest. Returns undefined if none.
 */
export function pickEmbedded(parsed: ParsedFile, targetLongEdge: number): EmbeddedImage | undefined {
  const imgs = parsed.images ?? [];
  if (!imgs.length) return undefined;
  let best: EmbeddedImage | undefined;
  for (const i of imgs) {
    if (longEdge(i) >= targetLongEdge && (!best || longEdge(i) < longEdge(best))) best = i;
  }
  if (best) return best;
  for (const i of imgs) if (!best || longEdge(i) > longEdge(best)) best = i;
  return best;
}
