// Test-only helpers (synthetic images + blur kernels). Not imported by app code.
import type { Pixels } from './pixels';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic "photo-like" synthetic scene: gradient sky, random rectangles/discs, fine texture. */
export function syntheticPhoto(width = 512, height = 341, seed = 1): Pixels {
  const rnd = mulberry32(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = 60 + (120 * y) / height;
      data[i + 1] = 90 + (80 * x) / width;
      data[i + 2] = 160 - (60 * y) / height;
      data[i + 3] = 255;
    }
  }
  for (let k = 0; k < 40; k++) {
    const cx = rnd() * width;
    const cy = rnd() * height;
    const r = 5 + rnd() * 50;
    const col = [rnd() * 255, rnd() * 255, rnd() * 255];
    const disc = rnd() < 0.5;
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(height, cy + r); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(width, cx + r); x++) {
        if (disc && (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const i = (y * width + x) * 4;
        // stripes give mid/high-frequency texture
        const tex = ((x + y) & 3) < 2 ? 25 : -25;
        data[i] = col[0] + tex;
        data[i + 1] = col[1] + tex;
        data[i + 2] = col[2] + tex;
      }
    }
  }
  return { data, width, height };
}

function convolve1d(src: Float32Array, w: number, h: number, kernel: Float32Array, horizontal: boolean): Float32Array {
  const out = new Float32Array(src.length);
  const r = (kernel.length - 1) >> 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) {
        const xx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x;
        const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k));
        s += src[yy * w + xx] * kernel[k + r];
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

function perChannel(img: Pixels, fn: (plane: Float32Array) => Float32Array): Pixels {
  const { width: w, height: h } = img;
  const n = w * h;
  const data = new Uint8ClampedArray(n * 4);
  for (let c = 0; c < 3; c++) {
    const p = new Float32Array(n);
    for (let i = 0; i < n; i++) p[i] = img.data[i * 4 + c];
    const q = fn(p);
    for (let i = 0; i < n; i++) data[i * 4 + c] = Math.round(q[i]);
  }
  for (let i = 0; i < n; i++) data[i * 4 + 3] = 255;
  return { data, width: w, height: h };
}

export function gaussianBlur(img: Pixels, sigma: number): Pixels {
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return perChannel(img, (p) =>
    convolve1d(convolve1d(p, img.width, img.height, k, true), img.width, img.height, k, false),
  );
}

export function boxBlur(img: Pixels, radius: number): Pixels {
  const k = new Float32Array(2 * radius + 1).fill(1 / (2 * radius + 1));
  return perChannel(img, (p) =>
    convolve1d(convolve1d(p, img.width, img.height, k, true), img.width, img.height, k, false),
  );
}

/** Linear motion blur of `length` px along x (horizontal) or y. */
export function motionBlur(img: Pixels, length: number, horizontal = true): Pixels {
  const r = Math.max(1, Math.round(length / 2));
  const k = new Float32Array(2 * r + 1).fill(1 / (2 * r + 1));
  return perChannel(img, (p) => convolve1d(p, img.width, img.height, k, horizontal));
}

/** Add Gaussian-ish noise (sum of uniforms) with given std-dev. */
export function addNoise(img: Pixels, std: number, seed = 7): Pixels {
  const rnd = mulberry32(seed);
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < data.length; i += 4) {
    const n = (rnd() + rnd() + rnd() - 1.5) * 2 * std;
    data[i] += n;
    data[i + 1] += n;
    data[i + 2] += n;
  }
  return { data, width: img.width, height: img.height };
}

/** Shift image by dx px (wrap-free, edge clamp) — cheap "next frame of a burst". */
export function shift(img: Pixels, dx: number, dy = 0): Pixels {
  const { width: w, height: h } = img;
  const data = new Uint8ClampedArray(img.data.length);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - dy));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - dx));
      const s = (sy * w + sx) * 4;
      const d = (y * w + x) * 4;
      data[d] = img.data[s];
      data[d + 1] = img.data[s + 1];
      data[d + 2] = img.data[s + 2];
      data[d + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** Multiply brightness (exposure change). */
export function scaleBrightness(img: Pixels, f: number): Pixels {
  const data = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < data.length; i++) data[i] = (i & 3) === 3 ? 255 : img.data[i] * f;
  return { data, width: img.width, height: img.height };
}
