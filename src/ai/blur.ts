import { type Pixels, toLuma } from './pixels';

/**
 * Normalisation constant: the raw per-tile energy (mean square of the 1-D
 * second derivative of 8-bit luma, minimum over 4 directions) is divided by
 * this. Calibrated on ~512px long-edge thumbnails of 16 real camera previews
 * (tests/fixtures) and synthetically blurred copies (see blur.browser.test.ts):
 *   sharp originals          1.2 … 28
 *   gaussian σ=1px           0.09 … 0.83  (soft; "uncertain" zone)
 *   gaussian σ=2px           ≤ 0.15
 *   gaussian σ≥4px           ≤ 0.02
 *   motion blur 9px / 17px   ≤ 0.41 / ≤ 0.12
 * The variance-of-Laplacian of the same images (classic metric) is reported by
 * {@link laplacianVariance} for reference; it barely reacts to motion blur.
 */
export const BLUR_NORM = 100;
/** Documented thresholds (at ~512px long edge). */
export const SHARP_THRESHOLD = 1;
export const BLURRY_THRESHOLD = 0.3;

export interface BlurDetails {
  /** Final score = max(maxTile, center) / BLUR_NORM. */
  score: number;
  /** Sharpest tile (min-direction energy), normalised. */
  maxTile: number;
  /** Gaussian centre-weighted (tile-level weights) min-direction energy, normalised. */
  center: number;
  /** Whole-frame min-direction energy, normalised. */
  global: number;
  cols: number;
  rows: number;
  /** Per-tile normalised min-direction energy, row-major cols×rows. */
  tiles: Float64Array;
}

/**
 * Directional-second-derivative sharpness. For every pixel the 1-D second
 * derivative along x, y and both diagonals is computed; per tile we keep the
 * mean square of each (≈ variance, the mean of a derivative is ~0). A tile's
 * sharpness is the MINIMUM over the four directions, so linear motion blur
 * (which only kills detail along its direction) and defocus both score low,
 * while a sharp subject with texture in every direction scores high.
 *
 * Robust to off-centre subjects and bokeh: the frame is split into a ~16 tile
 * grid (5×3 for 3:2) and the score is the sharpest tile, max()-combined with a
 * Gaussian centre-weighted aggregate of the tile energies (helps when the
 * subject straddles tile borders in the middle of the frame).
 * Thresholds assume ~512px long edge input: > 1 sharp, < 0.3 blurry.
 */
export function blurDetails(img: Pixels, luma?: Uint8Array): BlurDetails {
  const w = img.width;
  const h = img.height;
  const y = luma ?? toLuma(img);
  const cols = Math.max(2, Math.round(Math.sqrt((16 * w) / h)));
  const rows = Math.max(2, Math.round(16 / cols));
  const nt = cols * rows;
  // 4 directional energies per tile + pixel count
  const E = new Float64Array(nt * 4);
  const N = new Float64Array(nt);
  // Column ranges per tile, interior pixels only (x in [1, w-2]).
  const xs = new Int32Array(cols + 1);
  for (let t = 0; t <= cols; t++) xs[t] = Math.min(w - 1, Math.max(1, Math.round((t * w) / cols)));
  for (let yy = 1; yy < h - 1; yy++) {
    const tyBase = Math.min(rows - 1, Math.floor((yy * rows) / h)) * cols;
    const row = yy * w;
    for (let t = 0; t < cols; t++) {
      let ex = 0;
      let ey = 0;
      let e1 = 0;
      let e2 = 0;
      const end = row + xs[t + 1];
      for (let i = row + xs[t]; i < end; i++) {
        const c2 = 2 * y[i];
        const up = i - w;
        const dn = i + w;
        const lx = c2 - y[i - 1] - y[i + 1];
        const ly = c2 - y[up] - y[dn];
        const l1 = c2 - y[up - 1] - y[dn + 1];
        const l2 = c2 - y[up + 1] - y[dn - 1];
        ex += lx * lx;
        ey += ly * ly;
        e1 += l1 * l1;
        e2 += l2 * l2;
      }
      const k = (tyBase + t) * 4;
      E[k] += ex;
      E[k + 1] += ey;
      E[k + 2] += e1;
      E[k + 3] += e2;
      N[tyBase + t] += xs[t + 1] - xs[t];
    }
  }
  // Diagonal neighbours are sqrt(2) px away: halve their energy so isotropic
  // content gives roughly equal energies in all four directions.
  const tiles = new Float64Array(nt);
  const gE = [0, 0, 0, 0];
  const cE = [0, 0, 0, 0];
  let gN = 0;
  let cW = 0;
  let maxTile = 0;
  for (let t = 0; t < nt; t++) {
    const n = N[t];
    const k = t * 4;
    if (n > 0) {
      tiles[t] = Math.min(E[k], E[k + 1], E[k + 2] / 2, E[k + 3] / 2) / n / BLUR_NORM;
      if (tiles[t] > maxTile) maxTile = tiles[t];
    }
    const cx = ((t % cols) + 0.5) / cols - 0.5;
    const cy = (Math.floor(t / cols) + 0.5) / rows - 0.5;
    // Gaussian weight, sigma = 1/4 of the frame in each dimension
    const wt = Math.exp(-8 * (cx * cx + cy * cy));
    for (let d = 0; d < 4; d++) {
      gE[d] += E[k + d];
      cE[d] += E[k + d] * wt;
    }
    gN += n;
    cW += n * wt;
  }
  const dirMin = (e: number[], div: number) =>
    div > 0 ? Math.min(e[0], e[1], e[2] / 2, e[3] / 2) / div / BLUR_NORM : 0;
  const global = dirMin(gE, gN);
  const center = dirMin(cE, cW);
  return { score: Math.max(maxTile, center), maxTile, center, global, cols, rows, tiles };
}

/** Sharpness score (higher = sharper). See {@link blurDetails}. */
export function blurScore(img: Pixels, luma?: Uint8Array): number {
  return blurDetails(img, luma).score;
}

export interface ExposureStats {
  /** Mean luma 0..1. */
  mean: number;
  /** Fraction of pixels with luma >= 250 (blown highlights). */
  clippedHighlights: number;
  /** Fraction of pixels with luma <= 5 (crushed shadows). */
  clippedShadows: number;
}

export function exposureStats(img: Pixels, luma?: Uint8Array): ExposureStats {
  const y = luma ?? toLuma(img);
  const n = img.width * img.height;
  let s = 0;
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const v = y[i];
    s += v;
    if (v >= 250) hi++;
    else if (v <= 5) lo++;
  }
  const d = Math.max(1, n);
  return { mean: s / d / 255, clippedHighlights: hi / d, clippedShadows: lo / d };
}

/**
 * Classic whole-frame variance of the 4-neighbour Laplacian (raw, not
 * normalised). Kept for reference/debugging; {@link blurScore} is the robust
 * metric the app uses.
 */
export function laplacianVariance(img: Pixels, luma?: Uint8Array): number {
  const w = img.width;
  const h = img.height;
  const y = luma ?? toLuma(img);
  let s = 0;
  let q = 0;
  for (let yy = 1; yy < h - 1; yy++) {
    for (let x = 1, i = yy * w + 1; x < w - 1; x++, i++) {
      const l = 4 * y[i] - y[i - 1] - y[i + 1] - y[i - w] - y[i + w];
      s += l;
      q += l * l;
    }
  }
  const n = Math.max(1, (w - 2) * (h - 2));
  return q / n - (s / n) ** 2;
}
