// Browser-test-only helpers: decode fixtures to ~512px ImageData.
import { fixtureBlob, GEN_DIR, RAW_DIR } from '../../tests/browser/fixtures';

export { GEN_DIR, RAW_DIR, fixtureBlob };

export async function bitmapToImageData(bmp: ImageBitmap, maxEdge = 512): Promise<ImageData> {
  const s = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  // Two-step: high-quality resize via createImageBitmap, then read pixels.
  const small = s < 1 ? await createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }) : bmp;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(small, 0, 0);
  return ctx.getImageData(0, 0, w, h);
}

export async function blobToImageData(blob: Blob, maxEdge = 512): Promise<ImageData> {
  const bmp = await createImageBitmap(blob);
  try {
    return await bitmapToImageData(bmp, maxEdge);
  } finally {
    bmp.close();
  }
}

/**
 * Finds the largest decodable embedded JPEG in a RAW container by scanning for
 * SOI markers (FF D8 FF) and letting the browser decode each candidate slice.
 * Good enough for tests; the real app uses src/formats parsers.
 */
export async function largestEmbeddedJpeg(raw: Blob, minWidth = 1000): Promise<ImageBitmap | null> {
  const bytes = new Uint8Array(await raw.arrayBuffer());
  const sois: number[] = [];
  for (let i = 0; i + 3 < bytes.length && sois.length < 64; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) sois.push(i);
  }
  let best: ImageBitmap | null = null;
  for (const off of sois) {
    try {
      const bmp = await createImageBitmap(new Blob([bytes.subarray(off)], { type: 'image/jpeg' }));
      if (bmp.width >= minWidth && (!best || bmp.width * bmp.height > best.width * best.height)) {
        best?.close();
        best = bmp;
      } else bmp.close();
    } catch {
      /* not a decodable JPEG */
    }
  }
  return best;
}

export function toImageData(p: { data: Uint8ClampedArray | Uint8Array; width: number; height: number }): ImageData {
  return new ImageData(new Uint8ClampedArray(p.data), p.width, p.height);
}
