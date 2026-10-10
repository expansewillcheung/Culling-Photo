import { type Pixels, resampleLuma, toLuma } from './pixels';

// Orthonormal-ish DCT-II basis rows 0..7 for N=32 (scale irrelevant for median thresholding).
const N = 32;
const K = 8;
const COS = (() => {
  const c = new Float64Array(K * N);
  for (let k = 0; k < K; k++) {
    for (let n = 0; n < N; n++) c[k * N + n] = Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N));
  }
  return c;
})();

/**
 * Standard DCT perceptual hash (as in pHash / python imagehash.phash):
 * luma → area-average to 32×32 → 2-D DCT-II → top-left 8×8 coefficients
 * (including DC) → bit = coeff > median. Bit 63 (MSB) is coefficient (0,0),
 * row-major. Robust to scaling, mild blur, compression and small exposure
 * changes; burst frames of the same scene are typically within 0..12 bits.
 */
export function pHash(img: Pixels, luma?: Uint8Array): bigint {
  const y = luma ?? toLuma(img);
  const m = resampleLuma(y, img.width, img.height, N, N);
  // tmp[k][x] = sum_y COS[k][y] * m[y][x]  (8×32)
  const tmp = new Float64Array(K * N);
  for (let k = 0; k < K; k++) {
    for (let yy = 0; yy < N; yy++) {
      const c = COS[k * N + yy];
      const row = yy * N;
      for (let x = 0; x < N; x++) tmp[k * N + x] += c * m[row + x];
    }
  }
  // d[k][l] = sum_x tmp[k][x] * COS[l][x]  (8×8)
  const d = new Float64Array(K * K);
  for (let k = 0; k < K; k++) {
    for (let l = 0; l < K; l++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += tmp[k * N + x] * COS[l * N + x];
      d[k * K + l] = s;
    }
  }
  const sorted = Array.from(d).sort((a, b) => a - b);
  const med = (sorted[31] + sorted[32]) / 2;
  return bitsToBigint(d, med);
}

/**
 * Difference hash: luma → 9×8 area-average → bit = left > right. Cheaper and
 * more sensitive to small shifts than pHash; useful as a second opinion.
 */
export function dHash(img: Pixels, luma?: Uint8Array): bigint {
  const y = luma ?? toLuma(img);
  const m = resampleLuma(y, img.width, img.height, 9, 8);
  const diff = new Float64Array(64);
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) diff[r * 8 + c] = m[r * 9 + c] - m[r * 9 + c + 1];
  return bitsToBigint(diff, 0);
}

function bitsToBigint(v: Float64Array, thr: number): bigint {
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < 32; i++) hi = (hi << 1) | (v[i] > thr ? 1 : 0);
  for (let i = 32; i < 64; i++) lo = (lo << 1) | (v[i] > thr ? 1 : 0);
  return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}

function popcount32(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

const MASK32 = 0xffffffffn;

/** Number of differing bits between two 64-bit hashes. */
export function hamming(a: bigint, b: bigint): number {
  const x = (a ^ b) & 0xffffffffffffffffn;
  return popcount32(Number(x & MASK32)) + popcount32(Number(x >> 32n));
}

/** 16-char lowercase hex (zero-padded). */
export function hashToHex(h: bigint): string {
  return (h & 0xffffffffffffffffn).toString(16).padStart(16, '0');
}

export function hexToHash(s: string): bigint {
  return BigInt('0x' + s);
}
