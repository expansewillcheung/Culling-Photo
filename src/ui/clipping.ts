/** Red = blown highlights, blue = crushed shadows. Computed once per bitmap at <= 1600px. */
export function clipOverlay(bitmap: ImageBitmap): OffscreenCanvas {
  const s = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * s));
  const h = Math.max(1, Math.round(bitmap.height * s));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (r >= 252 || g >= 252 || b >= 252) {
      d[i] = 255; d[i + 1] = 0; d[i + 2] = 40; d[i + 3] = 200;
    } else if (r <= 3 && g <= 3 && b <= 3) {
      d[i] = 30; d[i + 1] = 90; d[i + 2] = 255; d[i + 3] = 200;
    } else d[i + 3] = 0;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
