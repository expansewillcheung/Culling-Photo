// Shared helpers: turn decoded pixels into a (downscaled, oriented) ImageBitmap.
// Works on the main thread and in workers (OffscreenCanvas + createImageBitmap only).

/** Scale (w, h) so the long edge <= maxEdge. Never upscales. */
export function fitWithin(w: number, h: number, maxEdge?: number): { width: number; height: number } {
  if (!maxEdge || maxEdge <= 0 || Math.max(w, h) <= maxEdge) return { width: w, height: h };
  const s = maxEdge / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Normalise an EXIF orientation value to 1..8 (anything else -> 1). */
export function normOrientation(o: number | undefined): number {
  return o && o >= 1 && o <= 8 ? Math.floor(o) : 1;
}

/**
 * Draw `src` with the given EXIF orientation applied. Returns `src` untouched for
 * orientation 1; otherwise a new bitmap (src is closed).
 */
export function orientBitmap(src: ImageBitmap, orientation: number): ImageBitmap {
  const o = normOrientation(orientation);
  if (o === 1) return src;
  const w = src.width;
  const h = src.height;
  const swap = o >= 5;
  const canvas = new OffscreenCanvas(swap ? h : w, swap ? w : h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  // Standard EXIF orientation -> canvas transform table (w/h are the source dims).
  switch (o) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
  }
  ctx.drawImage(src, 0, 0);
  src.close();
  return canvas.transferToImageBitmap();
}

/** Downscale (high quality, native) then orient. `src` may be ImageData or an ImageBitmap/Blob. */
export async function finishBitmap(
  src: ImageData | ImageBitmap | Blob,
  srcW: number,
  srcH: number,
  orientation: number,
  maxEdge?: number,
): Promise<ImageBitmap> {
  const { width, height } = fitWithin(srcW, srcH, maxEdge);
  let bmp: ImageBitmap;
  if (width !== srcW || height !== srcH) {
    bmp = await createImageBitmap(src, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
    if (src instanceof ImageBitmap) src.close();
  } else if (src instanceof ImageBitmap) {
    bmp = src;
  } else {
    bmp = await createImageBitmap(src);
  }
  return orientBitmap(bmp, orientation);
}

/** Wrap an RGBA8 buffer as ImageData without copying when possible. */
export function rgbaImageData(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): ImageData {
  const clamped = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, w * h * 4);
  return new ImageData(clamped as Uint8ClampedArray<ArrayBuffer>, w, h);
}
