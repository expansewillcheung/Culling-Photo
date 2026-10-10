import { describe, expect, test } from 'vitest';
import { type CullPhoto, pickBest, smartCullSuggestions } from './score';

const ok = { mean: 0.45, clippedHighlights: 0, clippedShadows: 0 };

describe('pickBest', () => {
  test('sharpest wins; eyes closed and blown highlights penalised', () => {
    expect(pickBest([])).toBe(-1);
    expect(
      pickBest([
        { id: 1, blurScore: 1 },
        { id: 2, blurScore: 3 },
        { id: 3, blurScore: 2 },
      ]),
    ).toBe(2);
    expect(
      pickBest([
        { id: 1, blurScore: 3, eyesClosed: true },
        { id: 2, blurScore: 1.5 },
      ]),
    ).toBe(2);
    // but a blurry open-eyes frame doesn't beat a sharp blink
    expect(
      pickBest([
        { id: 1, blurScore: 3, eyesClosed: true },
        { id: 2, blurScore: 0.2 },
      ]),
    ).toBe(1);
    expect(
      pickBest([
        { id: 1, blurScore: 3, exposure: { mean: 0.7, clippedHighlights: 0.2, clippedShadows: 0 } },
        { id: 2, blurScore: 2, exposure: ok },
      ]),
    ).toBe(2);
    // missing blurScore treated as group mean; ties → first
    expect(pickBest([{ id: 7 }, { id: 8 }])).toBe(7);
    // face bonus when another frame lost the face
    expect(
      pickBest([
        { id: 1, blurScore: 2, faceCount: 0 },
        { id: 2, blurScore: 1.8, faceCount: 1 },
      ]),
    ).toBe(2);
  });
});

describe('smartCullSuggestions', () => {
  test('blurry, eyes-closed, duplicate, exposure', () => {
    const H = 0xabcdef0123456789n;
    const photos: CullPhoto[] = [
      { id: 1, captureTime: 0, hash: H, blurScore: 3, exposure: ok }, // best of burst
      { id: 2, captureTime: 200, hash: H ^ 0b1011n, blurScore: 2, exposure: ok }, // dup (3 bits)
      { id: 3, captureTime: 400, hash: H ^ 0xff00n, blurScore: 2.5, exposure: ok }, // same burst, 8 bits: not dup
      { id: 4, captureTime: 600, hash: H ^ 1n, blurScore: 0.1, exposure: ok }, // blurry + dup
      { id: 5, captureTime: 10_000, blurScore: 2, eyesClosed: true },
      { id: 6, captureTime: 20_000, blurScore: 2, exposure: { mean: 0.8, clippedHighlights: 0.3, clippedShadows: 0 } },
      { id: 7, captureTime: 30_000, blurScore: 2, exposure: { mean: 0.04, clippedShadows: 0.7, clippedHighlights: 0 } },
      { id: 8, captureTime: 40_000, blurScore: 2, exposure: ok },
    ];
    const s = smartCullSuggestions(photos);
    expect(s.map((x) => [x.id, x.reason])).toEqual([
      [2, 'duplicate'],
      [4, 'blurry'],
      [5, 'eyes-closed'],
      [6, 'overexposed'],
      [7, 'underexposed'],
    ]);
    expect(s.find((x) => x.id === 4)!.reasons).toEqual(['blurry', 'duplicate']);
  });

  test('uses provided group ids', () => {
    const photos: CullPhoto[] = [
      { id: 1, group: 0, hash: 0n, blurScore: 2 },
      { id: 2, group: 0, hash: 1n, blurScore: 1 },
      { id: 3, group: 1, hash: 1n, blurScore: 1 },
    ];
    expect(smartCullSuggestions(photos)).toEqual([{ id: 2, reason: 'duplicate', reasons: ['duplicate'] }]);
  });
});
