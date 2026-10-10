/** LRU of decoded ImageBitmaps for the loupe/compare views. Closes evicted bitmaps. */
export interface RenderEntry {
  bitmap: ImageBitmap;
  sourceWidth: number;
  sourceHeight: number;
  edge: number;
}

export class RenderCache {
  private map = new Map<string, RenderEntry>();
  private pinned = new Set<string>();
  constructor(private maxEntries: number, private maxFull = 2) {}

  key(id: number, edge: number) {
    return `${id}@${edge}`;
  }

  get(id: number, edge: number): RenderEntry | undefined {
    const k = this.key(id, edge);
    const e = this.map.get(k);
    if (e) {
      this.map.delete(k);
      this.map.set(k, e);
    }
    return e;
  }

  /** Best available entry for id with edge >= minEdge, else the largest one. */
  best(id: number, minEdge = 0): RenderEntry | undefined {
    let best: RenderEntry | undefined;
    for (const [k, e] of this.map) {
      if (!k.startsWith(`${id}@`)) continue;
      if (!best) best = e;
      else if (best.edge < minEdge ? e.edge > best.edge : e.edge >= minEdge && e.edge < best.edge) best = e;
    }
    return best;
  }

  set(id: number, edge: number, e: RenderEntry) {
    const k = this.key(id, edge);
    const old = this.map.get(k);
    if (old && old.bitmap !== e.bitmap) old.bitmap.close();
    this.map.delete(k);
    this.map.set(k, e);
    this.evict();
  }

  pin(keys: string[]) {
    this.pinned = new Set(keys);
  }

  private evict() {
    // full-size (edge 0) entries have their own tighter budget
    const fulls = [...this.map.keys()].filter((k) => k.endsWith('@0'));
    while (fulls.length > this.maxFull) {
      const k = fulls.shift()!;
      if (this.pinned.has(k)) continue;
      this.map.get(k)?.bitmap.close();
      this.map.delete(k);
    }
    for (const k of this.map.keys()) {
      if (this.map.size <= this.maxEntries) break;
      if (this.pinned.has(k)) continue;
      this.map.get(k)?.bitmap.close();
      this.map.delete(k);
    }
  }

  clear() {
    for (const e of this.map.values()) e.bitmap.close();
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}
