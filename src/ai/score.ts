import { BLURRY_THRESHOLD } from './blur';
import type { ExposureStats } from './blur';
import { type BurstItem, groupBursts } from './group';
import { hamming } from './hash';

export interface CandidateInfo {
  id: number;
  blurScore?: number;
  eyesClosed?: boolean;
  faceCount?: number;
  exposure?: ExposureStats;
}

/**
 * Scoring weights for {@link qualityScore} / {@link pickBest}. Units: one point
 * ≈ one doubling of sharpness.
 *
 *   sharp       = log2(1 + blurScore)                (0.3 → 0.38, 1 → 1, 3 → 2, 10 → 3.5)
 *   eyesClosed  −1.5   (= a 2.8× ratio of (1+blurScore): a blink at 3.0 loses to open eyes
 *                       at > 0.42 but beats an open-eyes frame below that)
 *   highlights  −8 × max(0, clipped − 0.01)          (10% blown → −0.72)
 *   shadows     −3 × max(0, clipped − 0.05)
 *   exposure    −2 × max(0, |mean − 0.45| − 0.25)    (only very dark/bright frames)
 *   faces       +0.3 if this frame has a face while some other member has none
 *               (subject turned away / out of frame)
 *
 * Missing blurScore is treated as the group's mean sharpness (neutral).
 */
export const PICK_WEIGHTS = {
  eyesClosed: 1.5,
  highlights: 8,
  highlightsFree: 0.01,
  shadows: 3,
  shadowsFree: 0.05,
  exposure: 2,
  exposureTarget: 0.45,
  exposureFree: 0.25,
  faceBonus: 0.3,
} as const;

export function sharpnessPoints(blurScore: number): number {
  return Math.log2(1 + Math.max(0, blurScore));
}

/** Absolute quality score for one frame (higher = better). `ctx` supplies group-relative terms. */
export function qualityScore(c: CandidateInfo, ctx: { meanSharp?: number; anyFaceless?: boolean } = {}): number {
  const W = PICK_WEIGHTS;
  let s = c.blurScore !== undefined ? sharpnessPoints(c.blurScore) : (ctx.meanSharp ?? 0);
  if (c.eyesClosed) s -= W.eyesClosed;
  const e = c.exposure;
  if (e) {
    s -= W.highlights * Math.max(0, e.clippedHighlights - W.highlightsFree);
    s -= W.shadows * Math.max(0, e.clippedShadows - W.shadowsFree);
    s -= W.exposure * Math.max(0, Math.abs(e.mean - W.exposureTarget) - W.exposureFree);
  }
  if (ctx.anyFaceless && (c.faceCount ?? 0) > 0) s += W.faceBonus;
  return s;
}

/** Best member of a group (ties → earliest). Returns -1 for an empty group. */
export function pickBest(members: CandidateInfo[]): number {
  if (members.length === 0) return -1;
  let sum = 0;
  let cnt = 0;
  let anyFace = false;
  let anyFaceless = false;
  for (const m of members) {
    if (m.blurScore !== undefined) {
      sum += sharpnessPoints(m.blurScore);
      cnt++;
    }
    if (m.faceCount !== undefined) {
      if (m.faceCount > 0) anyFace = true;
      else anyFaceless = true;
    }
  }
  const ctx = { meanSharp: cnt ? sum / cnt : 0, anyFaceless: anyFace && anyFaceless };
  let best = members[0];
  let bestS = -Infinity;
  for (const m of members) {
    const s = qualityScore(m, ctx);
    if (s > bestS) {
      bestS = s;
      best = m;
    }
  }
  return best.id;
}

export type CullReason = 'blurry' | 'eyes-closed' | 'duplicate' | 'overexposed' | 'underexposed';

export interface CullPhoto extends CandidateInfo {
  captureTime?: number;
  hash?: bigint;
  embedding?: Float32Array;
  /** Burst group id (from groupBursts). When no photo has one, groups are computed here. */
  group?: number;
}

export interface CullSuggestion {
  id: number;
  /** Highest-priority reason (blurry > eyes-closed > duplicate > overexposed > underexposed). */
  reason: CullReason;
  /** All reasons that apply. */
  reasons: CullReason[];
}

export interface CullOptions {
  /** blurScore below this → 'blurry' (default 0.3 = BLURRY_THRESHOLD). */
  blurry?: number;
  /** Non-best burst members within this pHash distance of the best → 'duplicate' (default 6). */
  duplicateHamming?: number;
  /** clippedHighlights above this, or mean > 0.85 → 'overexposed' (default 0.15). */
  overexposedClip?: number;
  /** mean below this AND clippedShadows > 0.25, or mean < 0.06 → 'underexposed' (default 0.15). */
  underexposedMean?: number;
  burst?: Parameters<typeof groupBursts>[1];
}

/**
 * Suggestions only — the UI must let the user confirm. One entry per photo
 * that has at least one reason, in input order.
 */
export function smartCullSuggestions(photos: CullPhoto[], opts: CullOptions = {}): CullSuggestion[] {
  const blurThr = opts.blurry ?? BLURRY_THRESHOLD;
  const dupHam = opts.duplicateHamming ?? 6;
  const overClip = opts.overexposedClip ?? 0.15;
  const underMean = opts.underexposedMean ?? 0.15;

  let groups: number[];
  if (photos.some((p) => p.group !== undefined)) {
    groups = photos.map((p, i) => p.group ?? -1 - i); // ungrouped → singleton
  } else {
    // Sort by time for grouping (stable; untimed keep relative order at the end).
    const order = photos.map((_, i) => i);
    order.sort((a, b) => (photos[a].captureTime ?? Infinity) - (photos[b].captureTime ?? Infinity) || a - b);
    const ids = groupBursts(
      order.map((i): BurstItem => photos[i]),
      opts.burst,
    );
    groups = new Array(photos.length);
    order.forEach((pi, k) => (groups[pi] = ids[k]));
  }

  const byGroup = new Map<number, number[]>();
  groups.forEach((g, i) => {
    const arr = byGroup.get(g);
    if (arr) arr.push(i);
    else byGroup.set(g, [i]);
  });
  const dup = new Set<number>();
  for (const idx of byGroup.values()) {
    if (idx.length < 2) continue;
    const bestId = pickBest(idx.map((i) => photos[i]));
    const best = idx.map((i) => photos[i]).find((p) => p.id === bestId)!;
    if (best.hash === undefined) continue;
    for (const i of idx) {
      const p = photos[i];
      if (p.id !== bestId && p.hash !== undefined && hamming(p.hash, best.hash) <= dupHam) dup.add(i);
    }
  }

  const out: CullSuggestion[] = [];
  photos.forEach((p, i) => {
    const reasons: CullReason[] = [];
    if (p.blurScore !== undefined && p.blurScore < blurThr) reasons.push('blurry');
    if (p.eyesClosed) reasons.push('eyes-closed');
    if (dup.has(i)) reasons.push('duplicate');
    const e = p.exposure;
    if (e) {
      if (e.clippedHighlights > overClip || e.mean > 0.85) reasons.push('overexposed');
      else if ((e.mean < underMean && e.clippedShadows > 0.25) || e.mean < 0.06) reasons.push('underexposed');
    }
    if (reasons.length) out.push({ id: p.id, reason: reasons[0], reasons });
  });
  return out;
}
