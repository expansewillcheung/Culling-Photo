import { hamming } from './hash';

export interface BurstItem {
  id: number;
  /** ms (ExifInfo.captureTime). */
  captureTime?: number;
  /** 64-bit pHash. */
  hash?: bigint;
  /** Image embedding (any length; cosine similarity is used). */
  embedding?: Float32Array;
}

export interface BurstOptions {
  /** Max time gap to the previous frame (default 2000 ms). */
  maxGapMs?: number;
  /** Max pHash distance to the previous frame (default 12). */
  maxHamming?: number;
  /** Embedding cosine similarity that also counts as "same scene" (default 0.92). */
  minCosine?: number;
}

/** Cosine similarity; 0 for mismatched/zero vectors. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
}

/**
 * Burst grouping. Items must be sorted by captureTime (items without one keep
 * their position, e.g. file-name order). Each item is compared with its
 * predecessor only (O(n)), so a slowly panning burst chains together:
 *
 * - both have captureTime: joins when gap <= maxGapMs AND the frames look alike
 *   (no visual signal for the pair at all — neither both hashes nor both
 *   embeddings — OR hamming <= maxHamming, OR embedding cosine >= minCosine).
 *   Embeddings can rescue a hash mismatch (e.g. subject moved a lot).
 * - either lacks captureTime: joins only on positive visual evidence (hash
 *   within maxHamming or embeddings within minCosine).
 *
 * Returns a group id per item (same order), numbered 0.. in order of appearance.
 */
export function groupBursts(items: BurstItem[], opts: BurstOptions = {}): number[] {
  const maxGap = opts.maxGapMs ?? 2000;
  const maxHam = opts.maxHamming ?? 12;
  const minCos = opts.minCosine ?? 0.92;
  const out = new Array<number>(items.length);
  let g = -1;
  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    const prev = i > 0 ? items[i - 1] : undefined;
    let join = false;
    if (prev) {
      const hashOk =
        cur.hash !== undefined && prev.hash !== undefined ? hamming(cur.hash, prev.hash) <= maxHam : undefined;
      const embOk = cur.embedding && prev.embedding ? cosineSim(cur.embedding, prev.embedding) >= minCos : undefined;
      const visual = hashOk === true || embOk === true;
      if (cur.captureTime !== undefined && prev.captureTime !== undefined) {
        const gapOk = Math.abs(cur.captureTime - prev.captureTime) <= maxGap;
        join = gapOk && ((hashOk === undefined && embOk === undefined) || visual);
      } else {
        join = visual;
      }
    }
    if (!join) g++;
    out[i] = g;
  }
  return out;
}

export interface SimilarItem {
  id: number;
  embedding?: Float32Array;
  hash?: bigint;
}

export interface SimilarOptions {
  /** Cosine similarity threshold for embeddings (default 0.9). */
  threshold?: number;
  /** Hash fallback when one side lacks an embedding (default 10 bits). */
  maxHamming?: number;
  /**
   * Compare each item with the previous `window` items only (default 64) —
   * O(n·window). Pass Infinity for all pairs (O(n²)).
   */
  window?: number;
}

/**
 * Non-time-based similarity clustering (single linkage via union-find).
 * Returns group ids per item, numbered 0.. in order of first appearance.
 */
export function groupSimilar(items: SimilarItem[], opts: SimilarOptions = {}): number[] {
  const thr = opts.threshold ?? 0.9;
  const maxHam = opts.maxHamming ?? 10;
  const win = opts.window ?? 64;
  const n = items.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  // Pre-normalise embeddings so the inner loop is a plain dot product.
  const unit: (Float32Array | undefined)[] = items.map((it) => {
    const e = it.embedding;
    if (!e || e.length === 0) return undefined;
    let s = 0;
    for (let i = 0; i < e.length; i++) s += e[i] * e[i];
    if (s === 0) return undefined;
    const inv = 1 / Math.sqrt(s);
    const u = new Float32Array(e.length);
    for (let i = 0; i < e.length; i++) u[i] = e[i] * inv;
    return u;
  });
  for (let i = 1; i < n; i++) {
    const ui = unit[i];
    const hi = items[i].hash;
    const lo = win === Infinity ? 0 : Math.max(0, i - win);
    for (let j = i - 1; j >= lo; j--) {
      const uj = unit[j];
      let same = false;
      if (ui && uj && ui.length === uj.length) {
        let d = 0;
        for (let k = 0; k < ui.length; k++) d += ui[k] * uj[k];
        same = d >= thr;
      } else if (hi !== undefined && items[j].hash !== undefined) {
        same = hamming(hi, items[j].hash!) <= maxHam;
      }
      if (same) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[a < b ? b : a] = a < b ? a : b;
      }
    }
  }
  const ids = new Map<number, number>();
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = ids.get(r);
    if (g === undefined) ids.set(r, (g = ids.size));
    out[i] = g;
  }
  return out;
}
