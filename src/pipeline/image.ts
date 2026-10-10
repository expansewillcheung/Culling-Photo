// Worker-safe image helpers (OffscreenCanvas / createImageBitmap only).
import type { EmbeddedImage, ParsedFile } from '../core/types';
import { blobReader } from '../core/types';
import { parseFile, pickEmbedded } from '../formats';
import { decodeFallback, needsFallback } from '../decoders';
import { dcDecodeWorthIt, decodeJpegDc } from './jpegDc';

/**
 * Fast path for thumbnails from large JPEGs: DC-only decode at 1/8 scale (2-3x faster than a
 * full decode, which Chrome always does even with resize options). Returns null to fall back.
 */
async function dcThumb(jpeg: Blob, w: number | undefined, h: number | undefined, maxEdge: number, orientation: number): Promise<ImageBitmap | null> {
  if (!w || !h || !maxEdge || !dcDecodeWorthIt(w, h, maxEdge)) return null;
  const dc = decodeJpegDc(new Uint8Array(await jpeg.arrayBuffer()));
  if (!dc) return null;
  const [dw, dh] = fitSize(dc.width, dc.height, maxEdge);
  const bmp = await createImageBitmap(new ImageData(dc.data as Uint8ClampedArray<ArrayBuffer>, dc.width, dc.height), {
    resizeWidth: dw,
    resizeHeight: dh,
    resizeQuality: 'high',
  });
  if (orientation === 1) return bmp;
  const c = orientBitmap(bmp, orientation);
  bmp.close();
  return c instanceof OffscreenCanvas ? c.transferToImageBitmap() : c;
}

const NATIVE = new Set(['jpeg', 'png', 'webp', 'avif', 'gif']);

export function fitSize(w: number, h: number, maxEdge: number): [number, number] {
  const s = Math.min(1, maxEdge / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/** Draw bitmap with EXIF orientation applied (for pixels that ignore it). */
export function orientBitmap(src: ImageBitmap, orientation: number, maxEdge?: number): ImageBitmap | OffscreenCanvas {
  const swap = orientation >= 5 && orientation <= 8;
  const [w, h] = maxEdge ? fitSize(src.width, src.height, maxEdge) : [src.width, src.height];
  const cw = swap ? h : w;
  const ch = swap ? w : h;
  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, cw, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, cw, ch); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, ch); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, cw, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, cw, ch); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, ch); break;
  }
  ctx.drawImage(src, 0, 0, w, h);
  return canvas;
}

async function embeddedHasOrientation(file: Blob, emb: EmbeddedImage): Promise<number | undefined> {
  // Embedded JPEGs (RW2, RAF, some NEF) may carry their own EXIF. Parse just its head.
  const head = file.slice(emb.offset, emb.offset + Math.min(emb.length, 128 * 1024));
  try {
    const p = await parseFile(blobReader(head), 'embedded.jpg');
    return p.exif.orientation;
  } catch {
    return undefined;
  }
}

export interface DecodeResult {
  bitmap: ImageBitmap;
  /** Source pixel size before downscale (oriented). */
  sourceWidth: number;
  sourceHeight: number;
  source: 'embedded' | 'native' | 'fallback';
}

/**
 * Decode `file` to an oriented bitmap whose long edge is <= maxEdge (0 = full size).
 * Prefers embedded previews for RAW; never fully decodes a RAW if a good preview exists.
 */
export async function decodeOriented(file: Blob, parsed: ParsedFile, maxEdge: number): Promise<DecodeResult> {
  const orientation = parsed.exif.orientation ?? 1;
  const target = maxEdge || 1e9;

  if (parsed.kind === 'raw' || (!NATIVE.has(parsed.kind) && parsed.images.length)) {
    const emb = pickEmbedded(parsed, maxEdge || 1e9);
    const embLong = emb ? Math.max(emb.width ?? 0, emb.height ?? 0) : 0;
    const longEnough = emb && embLong >= Math.min(target, 1000);
    if (emb && (longEnough || !needsFallback(parsed))) {
      const blob = file.slice(emb.offset, emb.offset + emb.length, 'image/jpeg');
      const own = await embeddedHasOrientation(file, emb);
      const o = own ?? orientation;
      const swapE = o >= 5 && o <= 8;
      const fast = await dcThumb(blob, emb.width, emb.height, maxEdge, o);
      if (fast) {
        const sw = emb.width ?? fast.width, sh = emb.height ?? fast.height;
        return { bitmap: fast, sourceWidth: swapE ? sh : sw, sourceHeight: swapE ? sw : sh, source: 'embedded' };
      }
      if (own !== undefined) {
        // Embedded JPEG has its own EXIF orientation: the browser applies it.
        const bmp = await createImageBitmap(blob, resizeOpts(emb.width, emb.height, target, own));
        return { bitmap: bmp, sourceWidth: bmp.width, sourceHeight: bmp.height, source: 'embedded' };
      }
      const raw = await createImageBitmap(blob, resizeOpts(emb.width, emb.height, target, 1));
      const sw = emb.width ?? raw.width;
      const sh = emb.height ?? raw.height;
      if (orientation === 1) return { bitmap: raw, sourceWidth: sw, sourceHeight: sh, source: 'embedded' };
      const oriented = orientBitmap(raw, orientation);
      raw.close();
      const bmp = oriented instanceof OffscreenCanvas ? oriented.transferToImageBitmap() : oriented;
      const swap = orientation >= 5;
      return { bitmap: bmp, sourceWidth: swap ? sh : sw, sourceHeight: swap ? sw : sh, source: 'embedded' };
    }
  }

  if (NATIVE.has(parsed.kind)) {
    const w = parsed.exif.width;
    const h = parsed.exif.height;
    if (parsed.kind === 'jpeg') {
      const fast = await dcThumb(file, w, h, maxEdge, orientation);
      if (fast) {
        const swap = orientation >= 5 && orientation <= 8;
        return { bitmap: fast, sourceWidth: swap ? h! : w!, sourceHeight: swap ? w! : h!, source: 'native' };
      }
    }
    const bmp = await createImageBitmap(file, resizeOpts(w, h, target, orientation));
    const swap = orientation >= 5 && orientation <= 8;
    const sw = w && h ? (swap ? h : w) : bmp.width;
    const sh = w && h ? (swap ? w : h) : bmp.height;
    if (Math.max(bmp.width, bmp.height) > target * 1.01) {
      // Dimensions were unknown: downscale now.
      const [dw, dh] = fitSize(bmp.width, bmp.height, target);
      const small = await createImageBitmap(bmp, { resizeWidth: dw, resizeHeight: dh, resizeQuality: 'high' });
      bmp.close();
      return { bitmap: small, sourceWidth: sw, sourceHeight: sh, source: 'native' };
    }
    return { bitmap: bmp, sourceWidth: sw, sourceHeight: sh, source: 'native' };
  }

  const fb = await decodeFallback(file, parsed, maxEdge ? { maxEdge } : {});
  if (!fb) throw new Error(`cannot decode ${parsed.format}`);
  return { bitmap: fb, sourceWidth: parsed.exif.width ?? fb.width, sourceHeight: parsed.exif.height ?? fb.height, source: 'fallback' };
}

function resizeOpts(w: number | undefined, h: number | undefined, target: number, orientation: number): ImageBitmapOptions {
  if (!w || !h || Math.max(w, h) <= target) return {};
  const swap = orientation >= 5 && orientation <= 8;
  const [dw, dh] = fitSize(w, h, target);
  // resizeWidth/Height apply after orientation in Chrome.
  return { resizeWidth: swap ? dh : dw, resizeHeight: swap ? dw : dh, resizeQuality: 'high' };
}

export function bitmapToImageData(bmp: ImageBitmap, maxEdge: number): ImageData {
  const [w, h] = fitSize(bmp.width, bmp.height, maxEdge);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}
