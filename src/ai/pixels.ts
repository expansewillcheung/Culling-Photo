/**
 * Minimal RGBA pixel container. `ImageData` satisfies it, so do plain
 * `{data, width, height}` objects built in node unit tests or workers.
 */
export interface Pixels {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

let lumaScratch = new Uint8Array(0);

/**
 * 8-bit luma (BT.601-ish integer weights 77/150/29). Returns a module-level
 * scratch buffer that is overwritten by the next call (avoid per-call allocs in
 * hot loops) unless `out` is passed.
 */
export function toLuma(img: Pixels, out?: Uint8Array): Uint8Array {
  const n = img.width * img.height;
  let y = out;
  if (!y) {
    if (lumaScratch.length < n) lumaScratch = new Uint8Array(n);
    y = lumaScratch.length === n ? lumaScratch : lumaScratch.subarray(0, n);
  }
  const d = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    y[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29 + 128) >> 8;
  }
  return y;
}

/**
 * Area-average downscale of a luma plane to `ow`×`oh` floats (aspect not
 * preserved; this is what perceptual hashes want). Upscaling falls back to
 * nearest-sample.
 */
export function resampleLuma(y: Uint8Array, w: number, h: number, ow: number, oh: number): Float64Array {
  const out = new Float64Array(ow * oh);
  if (w < ow || h < oh) {
    for (let oy = 0; oy < oh; oy++) {
      const sy = Math.min(h - 1, Math.floor(((oy + 0.5) * h) / oh));
      for (let ox = 0; ox < ow; ox++) {
        const sx = Math.min(w - 1, Math.floor(((ox + 0.5) * w) / ow));
        out[oy * ow + ox] = y[sy * w + sx];
      }
    }
    return out;
  }
  // Bin boundaries: source column x belongs to output column floor(x*ow/w).
  const xs = new Int32Array(ow + 1);
  for (let b = 0; b <= ow; b++) xs[b] = Math.ceil((b * w) / ow);
  const ys = new Int32Array(oh + 1);
  for (let b = 0; b <= oh; b++) ys[b] = Math.ceil((b * h) / oh);
  for (let by = 0; by < oh; by++) {
    const o = by * ow;
    for (let yy = ys[by]; yy < ys[by + 1]; yy++) {
      const row = yy * w;
      for (let bx = 0; bx < ow; bx++) {
        let acc = 0;
        const end = row + xs[bx + 1];
        for (let i = row + xs[bx]; i < end; i++) acc += y[i];
        out[o + bx] += acc;
      }
    }
    const rows = ys[by + 1] - ys[by];
    for (let bx = 0; bx < ow; bx++) out[o + bx] /= rows * (xs[bx + 1] - xs[bx]) || 1;
  }
  return out;
}
