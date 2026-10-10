import { describe, expect, test } from 'vitest';
import { type BurstItem, cosineSim, groupBursts, groupSimilar } from './group';
import { mulberry32 } from './test-helpers';

function randHash(rnd: () => number): bigint {
  return (BigInt(Math.floor(rnd() * 2 ** 32)) << 32n) | BigInt(Math.floor(rnd() * 2 ** 32));
}
function flip(h: bigint, bits: number[]): bigint {
  for (const b of bits) h ^= 1n << BigInt(b);
  return h;
}

describe('groupBursts', () => {
  test('time gap + hash similarity', () => {
    const A = 0x0123456789abcdefn;
    const B = ~A & 0xffffffffffffffffn;
    const items: BurstItem[] = [
      { id: 1, captureTime: 0, hash: A },
      { id: 2, captureTime: 300, hash: flip(A, [1, 5, 9]) },
      { id: 3, captureTime: 600, hash: flip(A, [1, 5, 9, 20, 33]) }, // chained via #2
      { id: 4, captureTime: 900, hash: B }, // same time window, different scene
      { id: 5, captureTime: 1200, hash: flip(B, [0]) },
      { id: 6, captureTime: 9000, hash: flip(B, [0]) }, // gap too big
      { id: 7, captureTime: 9500 }, // no hash: time-only
      { id: 8 }, // no time and no hash: new group
      { id: 9, hash: flip(B, [3]) }, // no time, hash differs from #8 (no hash) → new
      { id: 10, hash: flip(B, [3, 4]) }, // no time, similar to #9 → joins
    ];
    expect(groupBursts(items)).toEqual([0, 0, 0, 1, 1, 2, 2, 3, 4, 4]);
    expect(groupBursts(items, { maxGapMs: 100 })).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 8]);
    expect(groupBursts(items, { maxHamming: 2 })).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 5, 5]);
  });

  test('embeddings rescue a hash mismatch; dissimilar embeddings without hashes split', () => {
    const e1 = new Float32Array([1, 0, 0.1]);
    const e2 = new Float32Array([0.98, 0.05, 0.12]);
    const e3 = new Float32Array([0, 1, 0]);
    const items: BurstItem[] = [
      { id: 1, captureTime: 0, hash: 0n, embedding: e1 },
      { id: 2, captureTime: 500, hash: 0xffffn, embedding: e2 }, // 16 bits apart, cos ≈ 0.998
      { id: 3, captureTime: 1000, embedding: e3 }, // no hash but embedding says different
    ];
    expect(cosineSim(e1, e2)).toBeGreaterThan(0.92);
    expect(groupBursts(items)).toEqual([0, 0, 1]);
  });

  test('empty input', () => {
    expect(groupBursts([])).toEqual([]);
  });

  test('perf: 3000 items < 20 ms', () => {
    const rnd = mulberry32(42);
    const items: BurstItem[] = [];
    let t = 0;
    let base = randHash(rnd);
    for (let i = 0; i < 3000; i++) {
      if (rnd() < 0.2) {
        t += 5000 + rnd() * 60000;
        base = randHash(rnd);
      } else t += 100 + rnd() * 400;
      items.push({ id: i, captureTime: t, hash: flip(base, [Math.floor(rnd() * 64), Math.floor(rnd() * 64)]) });
    }
    groupBursts(items);
    const t0 = performance.now();
    const g = groupBursts(items);
    const ms = performance.now() - t0;
    console.log(`groupBursts 3000: ${ms.toFixed(2)} ms, ${g[g.length - 1] + 1} groups`);
    expect(ms).toBeLessThan(20);
    expect(g[g.length - 1]).toBeGreaterThan(400);
  });
});

describe('groupSimilar', () => {
  test('clusters by embedding across time, hash fallback', () => {
    const a = new Float32Array([1, 0, 0]);
    const a2 = new Float32Array([0.95, 0.1, 0]);
    const b = new Float32Array([0, 1, 0]);
    const items = [
      { id: 1, embedding: a },
      { id: 2, embedding: b },
      { id: 3, embedding: a2 }, // similar to #1, not adjacent
      { id: 4, hash: 0n },
      { id: 5, hash: 0b111n }, // 3 bits from #4
      { id: 6, embedding: b },
    ];
    expect(groupSimilar(items)).toEqual([0, 1, 0, 2, 2, 1]);
    expect(groupSimilar(items, { threshold: 0.999 })).toEqual([0, 1, 2, 3, 3, 1]);
    expect(groupSimilar(items, { window: 1 })).toEqual([0, 1, 2, 3, 3, 4]);
  });

  test('perf: 3000 × 512-d embeddings, window 64 < 1000 ms', () => {
    const rnd = mulberry32(1);
    const items = Array.from({ length: 3000 }, (_, i) => ({
      id: i,
      embedding: Float32Array.from({ length: 512 }, () => rnd() - 0.5),
    }));
    const t0 = performance.now();
    const g = groupSimilar(items);
    const ms = performance.now() - t0;
    console.log(`groupSimilar 3000x512d w=64: ${ms.toFixed(1)} ms`);
    expect(new Set(g).size).toBe(3000); // random vectors are dissimilar
    expect(ms).toBeLessThan(1000);
  });
});
