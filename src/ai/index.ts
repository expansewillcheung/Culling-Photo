// CONTRACT (owned by ai agent). Pure functions over ImageData run in workers; model-based
// detectors lazily load and must degrade gracefully (return null) when unavailable/offline.

/** Sharpness: higher = sharper. Normalised so typical sharp photos > 1 and blurry < 0.3 at 512px. */
export function blurScore(_img: ImageData): number { throw new Error('not implemented'); }

/** 64-bit perceptual hash (DCT pHash) as bigint. */
export function pHash(_img: ImageData): bigint { throw new Error('not implemented'); }
export function hamming(_a: bigint, _b: bigint): number { throw new Error('not implemented'); }

export interface BurstItem { id: number; captureTime?: number; hash?: bigint; embedding?: Float32Array }
/** Returns group id per item (same order). Items must be sorted by captureTime. */
export function groupBursts(_items: BurstItem[], _opts?: { maxGapMs?: number; maxHamming?: number }): number[] {
  throw new Error('not implemented');
}
