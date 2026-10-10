import { describe, expect, test } from 'vitest';
import { dHash, hamming, hashToHex, hexToHash, pHash } from './hash';
import { gaussianBlur, scaleBrightness, shift, syntheticPhoto } from './test-helpers';

describe('hamming', () => {
  test('popcount on 64-bit bigints', () => {
    expect(hamming(0n, 0n)).toBe(0);
    expect(hamming(0n, 0xffffffffffffffffn)).toBe(64);
    expect(hamming(0x8000000000000001n, 0n)).toBe(2);
    expect(hamming(0xf0f0n, 0x0ff0n)).toBe(8);
    expect(hamming(1n << 63n, 1n << 31n)).toBe(2);
  });
  test('hex round trip', () => {
    const h = 0x00ab_cdef_0123_4567n;
    expect(hashToHex(h)).toBe('00abcdef01234567');
    expect(hexToHash(hashToHex(h))).toBe(h);
  });
});

describe('pHash / dHash', () => {
  const a = syntheticPhoto(512, 341, 11);
  const b = syntheticPhoto(512, 341, 12);

  test('stable under blur, small shift, exposure change; different scenes far apart', () => {
    const h = pHash(a);
    expect(hamming(h, pHash(gaussianBlur(a, 2)))).toBeLessThanOrEqual(6);
    expect(hamming(h, pHash(shift(a, 6, 3)))).toBeLessThanOrEqual(12);
    expect(hamming(h, pHash(scaleBrightness(a, 1.2)))).toBeLessThanOrEqual(6);
    expect(hamming(h, pHash(b))).toBeGreaterThan(16);
    const d = dHash(a);
    expect(hamming(d, dHash(gaussianBlur(a, 2)))).toBeLessThanOrEqual(8);
    expect(hamming(d, dHash(b))).toBeGreaterThan(16);
  });

  test('scale invariance (256 vs 512 wide)', () => {
    const small = syntheticPhoto(256, 170, 11);
    // same generator at a different size is not pixel-identical; compare a real downscale instead
    const down = { data: new Uint8ClampedArray(256 * 170 * 4), width: 256, height: 170 };
    for (let y = 0; y < 170; y++)
      for (let x = 0; x < 256; x++)
        for (let c = 0; c < 4; c++)
          down.data[(y * 256 + x) * 4 + c] = a.data[(Math.min(340, y * 2) * 512 + x * 2) * 4 + c];
    expect(hamming(pHash(a), pHash(down))).toBeLessThanOrEqual(4);
    expect(typeof pHash(small)).toBe('bigint');
  });

  test('perf: 512×341 pHash < 2 ms (median)', () => {
    for (let i = 0; i < 5; i++) pHash(a);
    const t: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      pHash(a);
      t.push(performance.now() - t0);
    }
    t.sort((x, y) => x - y);
    const ms = t[15];
    console.log(`pHash 512x341: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(2);
  });
});
