import { batch } from 'solid-js';
import { produce, unwrap } from 'solid-js/store';
import type { Marks, ParsedFile } from '../core/types';
import { hash64 } from '../core/util';
import type { FileSource, SourceEntry } from '../fs/FileSource';
import { buildCatalog, fingerprint, type CatalogItem } from '../pipeline/catalog';
import { CancelledError, WorkerPool } from '../pipeline/pool';
import { cacheGet, cacheList } from '../cache/opfs';
import { groupBursts, hamming, pickBest } from '../ai';
import { store, emptyProgress } from '../store/store';
import type { Photo } from '../store/types';
import { RenderCache, type RenderEntry } from './renderCache';
import { MemoryPersist, type PersistAdapter } from './persist';
import { videoThumb } from './video';

const { state, actions } = store;
const set = actions.setState;

export const PRIORITY = {
  loupe: -100,
  preload: -50,
  visible: 0,
  meta: 500,
  background: 1000,
} as const;

function thumbName(e: SourceEntry) {
  return `${hash64(`${e.relPath}|${e.size}|${e.lastModified}`)}.webp`;
}

function mergeExif(parsed: (ParsedFile | null)[], display: number) {
  // Display file's EXIF wins, RAW fills gaps (JPEG from camera usually has full EXIF too).
  const out: ParsedFile['exif'] = {};
  const order = [display, ...parsed.map((_, i) => i).filter((i) => i !== display)];
  for (const i of order) {
    const ex = parsed[i]?.exif;
    if (!ex) continue;
    for (const [k, v] of Object.entries(ex)) if (v !== undefined && (out as any)[k] === undefined) (out as any)[k] = v;
  }
  return out;
}

export class Session {
  pool: WorkerPool;
  renders = new RenderCache(14, 2);
  source?: FileSource;
  cacheNs = '';
  persist: PersistAdapter = new MemoryPersist();
  private cachedThumbs = new Set<string>();
  private objectUrls: string[] = [];
  private renderWaiters = new Map<string, Promise<RenderEntry | undefined>>();
  private disposed = false;
  private unsubscribe?: () => void;
  private analyzeTimer = 0;
  private saveTimer = 0;
  private dirtyMarks = new Set<number>();
  onDirtyMarks?: (ids: number[]) => void;
  /** Hooks wired by the app (XMP reader etc.). */
  hooks: {
    readSidecar?: (entry: SourceEntry) => Promise<Partial<Marks> | null>;
    afterOpen?: (s: Session) => void;
  } = {};

  constructor(pool?: WorkerPool) {
    this.pool = pool ?? new WorkerPool();
  }

  async open(source: FileSource, persist?: PersistAdapter) {
    this.source = source;
    if (persist) this.persist = persist;
    const t0 = performance.now();
    set('progress', { ...emptyProgress(), phase: 'listing', startedAt: t0 });
    set('sourceName', source.name);
    set('writable', source.writable);
    const entries = await source.list((n) => set('progress', 'listed', n));
    const catalog = buildCatalog(entries);
    this.cacheNs = hash64(`ns|${source.name}`);
    const [cached, saved] = await Promise.all([
      cacheList(this.cacheNs),
      this.persist.open(source.name, fingerprint(entries)).catch(() => new Map()),
    ]);
    this.cachedThumbs = cached;
    set('persistent', this.persist.persistent);

    const photos: Photo[] = catalog.map((item, id) => this.makePhoto(item, id));
    const restoredIds: number[] = [];
    const restoredMarks: Marks[] = [];
    for (const p of photos) {
      const s = saved.get(p.key);
      if (!s) continue;
      if (s.marks) {
        restoredIds.push(p.id);
        restoredMarks.push(s.marks);
      }
      p.captureTime = s.captureTime ?? p.captureTime;
      p.blurScore = s.blurScore;
      p.phash = s.phash;
      p.faceCount = s.faceCount;
      p.eyesClosed = s.eyesClosed;
    }
    batch(() => {
      set('photos', photos);
      set('screen', 'library');
      set('current', photos.length ? 0 : -1);
      set('selection', []);
      set('view', 'grid');
      set('progress', (p) => ({ ...p, phase: 'meta', total: photos.length }));
    });
    if (restoredIds.length) actions.loadMarks(restoredIds, restoredMarks);
    this.unsubscribe = store.actions.onMarks((ids) => this.markDirty(ids));
    this.hooks.afterOpen?.(this);
    void this.runMeta(saved);
    return { entries: entries.length, photos: photos.length, listMs: performance.now() - t0 };
  }

  private makePhoto(item: CatalogItem, id: number): Photo {
    return {
      id,
      key: item.key,
      stem: item.stem,
      dirRel: item.dirRel,
      item,
      display: 0,
      kinds: item.kinds,
      parsed: item.files.map(() => null),
      metaDone: false,
      exif: {},
      rating: 0,
      flag: 0,
      label: '',
      thumbState: 'none',
      aspect: 1.5,
    };
  }

  /** Parse headers of every file in batches (fast pass, enables sort-by-time & EXIF filters). */
  private async runMeta(saved: Map<string, any>) {
    const photos = state.photos;
    const BATCH = 16;
    const jobs: Promise<void>[] = [];
    for (let start = 0; start < photos.length; start += BATCH) {
      const ids = photos.slice(start, start + BATCH).map((p) => p.id);
      jobs.push(
        this.pool
          .enqueue(`meta:${start}`, PRIORITY.meta + start / 1e6, (w) =>
            w.parseMany(ids.flatMap((id) => photos[id].item.files.map((f) => ({ file: f.file, name: f.name })))),
          )
          .then((results) => {
            if (this.disposed) return;
            let k = 0;
            set(
              'photos',
              produce((ps) => {
                for (const id of ids) {
                  const p = ps[id];
                  const n = p.item.files.length;
                  const parsed = results.slice(k, k + n).map((r) => r.parsed);
                  k += n;
                  this.applyParsed(p, parsed);
                }
              }),
            );
            set('progress', 'metaDone', (n) => n + ids.length);
          })
          .catch((e) => {
            if (!(e instanceof CancelledError)) console.error(e);
          }),
      );
    }
    await Promise.all(jobs);
    if (this.disposed) return;
    // Restore marks from sidecars for photos not restored from the DB.
    await this.readSidecars(saved);
    set('progress', 'phase', 'thumbs');
    // Queue background thumbs for everything (visible ones were already bumped).
    const order = store.viewIds();
    order.forEach((id, i) => this.requestThumb(id, PRIORITY.background + i));
    void this.persist.saveAll(state.photos).catch(() => {});
  }

  private applyParsed(p: Photo, parsed: (ParsedFile | null)[]) {
    p.parsed = parsed;
    p.metaDone = true;
    // Display: first decodable (files are already display-ranked); skip failed parses.
    let display = parsed.findIndex((x) => x && x.kind !== 'other');
    if (display < 0) display = 0;
    p.display = display;
    p.exif = mergeExif(parsed, display);
    if (p.captureTime === undefined) p.captureTime = p.exif.captureTime ?? p.item.files[0].lastModified;
    const w = p.exif.width, h = p.exif.height, o = p.exif.orientation ?? 1;
    if (w && h) p.aspect = o >= 5 && o <= 8 ? h / w : w / h;
    if (p.exif.rating !== undefined && p.rating === 0 && p.flag === 0) {
      if (p.exif.rating < 0) p.flag = -1;
      else p.rating = Math.min(5, p.exif.rating);
    }
  }

  private async readSidecars(saved: Map<string, any>) {
    const read = this.hooks.readSidecar;
    if (!read) return;
    const targets = state.photos.filter((p) => p.item.sidecar && !saved.get(p.key)?.marks);
    const ids: number[] = [];
    const marks: Marks[] = [];
    await Promise.all(
      targets.map(async (p) => {
        const m = await read(p.item.sidecar!).catch(() => null);
        if (!m) return;
        ids.push(p.id);
        marks.push({ rating: m.rating ?? p.rating, flag: m.flag ?? p.flag, label: m.label ?? p.label });
      }),
    );
    if (ids.length) actions.loadMarks(ids, marks);
  }

  displayFile(p: Photo): SourceEntry {
    return p.item.files[p.display] ?? p.item.files[0];
  }

  /** Ensure a thumbnail exists (cached or generated) at the given priority. */
  requestThumb(id: number, priority: number) {
    const p = state.photos[id];
    if (!p || p.thumbState === 'ready' || p.thumbState === 'error') return;
    const key = `thumb:${id}`;
    if (this.pool.has(key)) {
      this.pool.setPriority(key, priority);
      return;
    }
    if (p.thumbState === 'queued') return;
    set('photos', id, 'thumbState', 'queued');
    const entry = this.displayFile(p);
    const name = thumbName(entry);
    void this.loadThumb(id, entry, name, priority);
  }

  private async loadThumb(id: number, entry: SourceEntry, name: string, priority: number) {
    const p = state.photos[id];
    const needAnalysis = state.settings.analyze && p.blurScore === undefined;
    if (this.cachedThumbs.has(name) && !needAnalysis) {
      const f = await cacheGet(this.cacheNs, name);
      if (f) {
        this.setThumb(id, f);
        return;
      }
    }
    if (p.kinds[p.display] === 'video') {
      const blob = await videoThumb(entry.file).catch(() => null);
      if (blob) this.setThumb(id, blob);
      else set('photos', id, { thumbState: 'error', error: 'video' });
      return;
    }
    try {
      // Parse may not be done yet for visible items: wait for its meta batch by parsing inline.
      const r = await this.pool.enqueue(`thumb:${id}`, priority, async (w) => {
        let parsed = unwrap(state.photos[id].parsed[state.photos[id].display]);
        if (!parsed) {
          const [m] = await w.parseMany([{ file: entry.file, name: entry.name }]);
          parsed = m.parsed;
        }
        if (!parsed) throw new Error('unreadable file');
        return w.thumb(entry.file, parsed, this.cacheNs, name, state.settings.analyze);
      });
      if (this.disposed) return;
      if (!r.ok || !r.thumb) {
        set('photos', id, { thumbState: 'error', error: r.error });
        set('progress', 'errors', (n) => n + 1);
        this.bumpThumbProgress();
        return;
      }
      this.cachedThumbs.add(name);
      const fmt = state.photos[id].parsed[state.photos[id].display]?.format ?? '?';
      const st = (thumbStats[fmt] ??= { n: 0, ms: 0, max: 0 });
      st.n++;
      st.ms += r.ms;
      st.max = Math.max(st.max, r.ms);
      batch(() => {
        set('photos', id, (ph) => ({
          ...ph,
          sourceWidth: r.sourceWidth,
          sourceHeight: r.sourceHeight,
          aspect: r.width / r.height,
          blurScore: r.blurScore ?? ph.blurScore,
          phash: r.phash ?? ph.phash,
          exposure: r.exposure,
          histogram: r.histogram,
        }));
        this.setThumb(id, r.thumb!);
      });
      this.scheduleAnalysis();
    } catch (e) {
      if (e instanceof CancelledError) {
        set('photos', id, 'thumbState', 'none');
        return;
      }
      set('photos', id, { thumbState: 'error', error: String(e) });
      set('progress', 'errors', (n) => n + 1);
      this.bumpThumbProgress();
    }
  }

  private setThumb(id: number, blob: Blob) {
    const url = URL.createObjectURL(blob);
    this.objectUrls.push(url);
    set('photos', id, { thumbUrl: url, thumbState: 'ready' });
    this.bumpThumbProgress();
  }

  private bumpThumbProgress() {
    const now = performance.now();
    set('progress', (pr) => {
      const thumbsDone = pr.thumbsDone + 1;
      const next = { ...pr, thumbsDone };
      if (!pr.firstThumbAt) next.firstThumbAt = now;
      if (thumbsDone >= pr.total && !pr.allThumbsAt) {
        next.allThumbsAt = now;
        next.phase = 'done';
      }
      return next;
    });
  }

  /** Called by the grid with the ids currently on screen (in order). */
  setVisible(ids: number[], ahead: number[] = []) {
    ids.forEach((id, i) => this.requestThumb(id, PRIORITY.visible + i));
    ahead.forEach((id, i) => this.requestThumb(id, PRIORITY.visible + 100 + i));
  }

  screenEdge(): number {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const edge = Math.max(window.innerWidth, window.innerHeight) * dpr;
    // Bucket so resizes don't thrash the cache.
    return Math.min(4096, Math.ceil(edge / 512) * 512);
  }

  /** Decoded oriented bitmap for loupe/compare. edge 0 = full resolution. */
  getRender(id: number, edge: number, priority: number = PRIORITY.loupe): Promise<RenderEntry | undefined> {
    const hit = this.renders.get(id, edge);
    if (hit) return Promise.resolve(hit);
    const key = `render:${id}@${edge}`;
    const waiting = this.renderWaiters.get(key);
    if (waiting) {
      this.pool.setPriority(key, priority);
      return waiting;
    }
    const p = state.photos[id];
    if (!p || p.kinds[p.display] === 'video') return Promise.resolve(undefined);
    const entry = this.displayFile(p);
    const job = this.pool
      .enqueue(key, priority, async (w) => {
        let parsed = unwrap(state.photos[id].parsed[state.photos[id].display]);
        if (!parsed) parsed = (await w.parseMany([{ file: entry.file, name: entry.name }]))[0].parsed;
        if (!parsed) throw new Error('unreadable');
        return w.render(entry.file, parsed, edge);
      })
      .then((r) => {
        const e: RenderEntry = { bitmap: r.bitmap, sourceWidth: r.sourceWidth, sourceHeight: r.sourceHeight, edge };
        if (this.disposed) {
          r.bitmap.close();
          return undefined;
        }
        this.renders.set(id, edge, e);
        return e;
      })
      .catch((e) => {
        if (!(e instanceof CancelledError)) console.warn('render failed', id, e);
        return undefined;
      })
      .finally(() => this.renderWaiters.delete(key));
    this.renderWaiters.set(key, job);
    return job;
  }

  /** Preload neighbours of the current photo in the loupe. */
  preloadAround(id: number, radius = 3) {
    const ids = store.viewIds();
    const i = store.viewIndex().get(id);
    if (i === undefined) return;
    const edge = this.screenEdge();
    const keep: string[] = [this.renders.key(id, edge), this.renders.key(id, 0)];
    // Drop stale preloads that are no longer near.
    this.pool.cancel((k) => k.startsWith('render:') && !k.endsWith('@0') && !this.isNear(k, ids, i, radius + 1));
    for (let d = 1; d <= radius; d++) {
      for (const j of [i + d, i - d]) {
        const nid = ids[j];
        if (nid === undefined) continue;
        keep.push(this.renders.key(nid, edge));
        void this.getRender(nid, edge, PRIORITY.preload + d);
      }
    }
    this.renders.pin(keep);
  }

  private isNear(key: string, ids: number[], i: number, r: number) {
    const id = Number(key.slice(7, key.indexOf('@')));
    const j = store.viewIndex().get(id);
    return j !== undefined && Math.abs(j - i) <= r && ids[j] === id;
  }

  private scheduleAnalysis() {
    if (this.analyzeTimer) return;
    this.analyzeTimer = window.setTimeout(() => {
      this.analyzeTimer = 0;
      this.regroup();
    }, 1500);
  }

  /** Burst grouping + best-pick + smart-cull suggestions from available analysis. */
  regroup() {
    const photos = state.photos;
    const sorted = [...photos].sort((a, b) => (a.captureTime ?? 0) - (b.captureTime ?? 0));
    const items = sorted.map((p) => ({ id: p.id, captureTime: p.captureTime, hash: p.phash ? BigInt('0x' + p.phash) : undefined }));
    let groups: number[];
    try {
      groups = groupBursts(items, { maxGapMs: state.settings.burstGapMs });
    } catch {
      return;
    }
    const members = new Map<number, Photo[]>();
    sorted.forEach((p, i) => {
      const g = groups[i];
      let arr = members.get(g);
      if (!arr) members.set(g, (arr = []));
      arr.push(p);
    });
    const best = new Map<number, number>();
    for (const [g, arr] of members) {
      if (arr.length < 2) continue;
      try {
        best.set(g, pickBest(arr.map((p) => ({ id: p.id, blurScore: p.blurScore, eyesClosed: p.eyesClosed, faceCount: p.faceCount, exposure: p.exposure }))));
      } catch {
        best.set(g, arr[0].id);
      }
    }
    set(
      'photos',
      produce((ps) => {
        sorted.forEach((sp, i) => {
          const p = ps[sp.id];
          const g = groups[i];
          const size = members.get(g)!.length;
          p.groupId = g;
          p.groupSize = size;
          p.groupBest = size < 2 || best.get(g) === p.id;
          p.suggestion = suggestionFor(p, size > 1 ? ps[best.get(g)!] : undefined);
        });
      }),
    );
  }

  private markDirty(ids: number[]) {
    for (const id of ids) this.dirtyMarks.add(id);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flushMarks(), 600);
  }

  async flushMarks() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    const ids = [...this.dirtyMarks];
    this.dirtyMarks.clear();
    if (!ids.length) return;
    const photos = ids.map((id) => state.photos[id]).filter(Boolean);
    await this.persist.saveMarks(photos).catch((e) => console.warn('save marks', e));
    this.onDirtyMarks?.(ids);
  }

  async dispose() {
    await this.flushMarks().catch(() => {});
    this.disposed = true;
    this.unsubscribe?.();
    this.pool.cancel(() => true);
    this.renders.clear();
    for (const u of this.objectUrls) URL.revokeObjectURL(u);
    this.objectUrls = [];
    await this.persist.close().catch(() => {});
  }
}

function suggestionFor(p: Photo, best?: Photo): string | undefined {
  if (p.flag !== 0) return undefined;
  if (p.blurScore !== undefined && p.blurScore < 0.3) return 'blurry';
  if (p.eyesClosed) return 'eyes-closed';
  if (best && best.id !== p.id && p.phash && best.phash) {
    try {
      if (hamming(BigInt('0x' + p.phash), BigInt('0x' + best.phash)) <= 6) return 'duplicate';
    } catch {
      /* ignore */
    }
  }
  if (p.exposure && p.exposure.clippedHighlights > 0.25) return 'overexposed';
  if (p.exposure && p.exposure.clippedShadows > 0.4) return 'underexposed';
  return undefined;
}

/** Per-format thumbnail timing (worker-side ms), for diagnostics and the benchmark. */
export const thumbStats: Record<string, { n: number; ms: number; max: number }> = {};
(globalThis as any).__thumbStats = thumbStats;

export let session: Session | undefined;
export function setSession(s: Session | undefined) {
  session = s;
}
