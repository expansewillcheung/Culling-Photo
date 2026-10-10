import { describe, expect, test } from 'vitest';
import { analyzePixels } from './analyze';
import { BLURRY_THRESHOLD, blurDetails, blurScore, exposureStats, laplacianVariance } from './blur';
import { addNoise, boxBlur, gaussianBlur, motionBlur, scaleBrightness, syntheticPhoto } from './test-helpers';

function medianMs(fn: () => void, runs = 30): number {
  for (let i = 0; i < 5; i++) fn();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return t[t.length >> 1];
}

describe('blurScore', () => {
  const sharp = syntheticPhoto(512, 341, 3);

  test('sharp synthetic scene > 1, decreases monotonically with blur', () => {
    const s0 = blurScore(sharp);
    expect(s0).toBeGreaterThan(1);
    let prev = s0;
    for (const r of [1, 2, 4, 8]) {
      const s = blurScore(gaussianBlur(sharp, r));
      expect(s).toBeLessThan(prev);
      prev = s;
    }
    prev = s0;
    for (const r of [1, 2, 4, 8]) {
      const s = blurScore(boxBlur(sharp, r));
      expect(s).toBeLessThan(prev);
      prev = s;
    }
    expect(blurScore(gaussianBlur(sharp, 2))).toBeLessThan(BLURRY_THRESHOLD);
    expect(blurScore(boxBlur(sharp, 4))).toBeLessThan(BLURRY_THRESHOLD);
  });

  test('motion blur is detected in both directions (min-direction energy)', () => {
    const s0 = blurScore(sharp);
    const h = blurScore(motionBlur(sharp, 16, true));
    const v = blurScore(motionBlur(sharp, 16, false));
    expect(h).toBeLessThan(BLURRY_THRESHOLD);
    expect(v).toBeLessThan(BLURRY_THRESHOLD);
    // the classic Laplacian variance barely notices horizontal motion blur:
    const lv0 = laplacianVariance(sharp);
    const lvh = laplacianVariance(motionBlur(sharp, 16, true));
    expect(lvh / lv0).toBeGreaterThan(h / s0);
  });

  test('off-centre sharp subject on a blurry (bokeh) background still scores sharp', () => {
    const bg = gaussianBlur(sharp, 6);
    const comp = { data: new Uint8ClampedArray(bg.data), width: 512, height: 341 };
    // Keep only one off-centre ~1/15-of-frame region sharp (the sharpest
    // non-centre tile, ~102×113 px) — a small in-focus subject against heavy bokeh.
    const sd = blurDetails(sharp);
    const centre = Math.floor(sd.rows / 2) * sd.cols + Math.floor(sd.cols / 2);
    let t = centre === 0 ? 1 : 0;
    for (let k = 0; k < sd.tiles.length; k++) if (k !== centre && sd.tiles[k] > sd.tiles[t]) t = k;
    const tc = t % sd.cols;
    const tr = Math.floor(t / sd.cols);
    const [x0, x1] = [Math.round((tc * 512) / sd.cols), Math.round(((tc + 1) * 512) / sd.cols)];
    const [y0, y1] = [Math.floor((tr * 341) / sd.rows), Math.floor(((tr + 1) * 341) / sd.rows)];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * 512 + x) * 4;
        for (let c = 0; c < 4; c++) comp.data[i + c] = sharp.data[i + c];
      }
    }
    const d = blurDetails(comp);
    expect(blurScore(bg)).toBeLessThan(BLURRY_THRESHOLD);
    expect(sd.tiles[t]).toBeGreaterThan(1);
    expect(d.score).toBeGreaterThan(0.9 * sd.tiles[t]);
    expect(d.score).toBeGreaterThan(1);
    expect(d.global).toBeLessThan(d.score / 3); // a whole-frame metric would be fooled
  });

  test('flat image → 0, tiny images do not throw', () => {
    const flat = { data: new Uint8ClampedArray(64 * 48 * 4).fill(128), width: 64, height: 48 };
    expect(blurScore(flat)).toBe(0);
    expect(() => blurScore({ data: new Uint8ClampedArray(4 * 4), width: 2, height: 2 })).not.toThrow();
  });

  test('noise slightly inflates but blurry stays well below sharp', () => {
    const noisy = addNoise(gaussianBlur(sharp, 2), 1.5);
    expect(blurScore(noisy)).toBeLessThan(blurScore(sharp) / 3);
  });

  test('perf: 512×341 blurScore < 3 ms (median)', () => {
    const ms = medianMs(() => blurScore(sharp));
    console.log(`blurScore 512x341: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(3);
  });

  test('perf: analyzePixels (luma+blur+pHash+dHash+exposure) < 6 ms', () => {
    const ms = medianMs(() => analyzePixels(sharp));
    console.log(`analyzePixels 512x341: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(6);
  });
});

describe('exposureStats', () => {
  test('fractions and mean', () => {
    const w = 100;
    const h = 10;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = i < 100 ? 255 : i < 300 ? 0 : 128; // 10% white, 20% black, 70% grey
      data.set([v, v, v, 255], i * 4);
    }
    const e = exposureStats({ data, width: w, height: h });
    expect(e.clippedHighlights).toBeCloseTo(0.1, 5);
    expect(e.clippedShadows).toBeCloseTo(0.2, 5);
    expect(e.mean).toBeCloseTo((0.1 * 255 + 0.7 * 128) / 255, 2);
  });

  test('brightening increases clipping', () => {
    const p = syntheticPhoto(256, 170, 5);
    const a = exposureStats(p);
    const b = exposureStats(scaleBrightness(p, 2.5));
    expect(b.mean).toBeGreaterThan(a.mean);
    expect(b.clippedHighlights).toBeGreaterThan(a.clippedHighlights + 0.1);
  });
});
