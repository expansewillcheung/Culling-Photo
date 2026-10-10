import * as Comlink from 'comlink';
import type { PreviewApi } from '../workers/preview.worker';

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
  }
}

/**
 * normal: cheap JS/native decode. heavy: WASM decoders that block a worker for seconds
 * (HEIC, JXL, TIFF) — capped so they never occupy every worker. raw: LibRaw demosaic —
 * pinned to worker 0 so only one LibRaw instance (256 MB+ shared memory) ever exists.
 * meta: header parsing, served by a dedicated worker so it never queues behind decodes.
 */
export type Lane = 'normal' | 'heavy' | 'raw' | 'meta';

interface Job<T = unknown> {
  key: string;
  priority: number;
  seq: number;
  lane: Lane;
  run: (w: Comlink.Remote<PreviewApi>) => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  promise: Promise<T>;
}

interface Slot {
  api: Comlink.Remote<PreviewApi>;
  worker: Worker;
  active: number;
  heavy: number;
  raw: number;
}

function spawn(name: string): Slot {
  const worker = new Worker(new URL('../workers/preview.worker.ts', import.meta.url), { type: 'module', name });
  return { api: Comlink.wrap<PreviewApi>(worker), worker, active: 0, heavy: 0, raw: 0 };
}

/**
 * Worker pool with a priority queue (lower number = sooner), key de-duplication,
 * lanes, and cancellation of queued (not yet started) jobs.
 */
export class WorkerPool {
  readonly size: number;
  private workers: Slot[] = [];
  private meta: Slot;
  private queue = new Map<string, Job<any>>();
  private running = new Map<string, Promise<unknown>>();
  private seq = 0;
  private perWorker: number;
  private maxHeavy: number;
  private heavyActive = 0;
  onIdle?: () => void;
  /** Jobs at or above this priority (background work) always leave one slot free for interactive jobs. */
  backgroundPriority = 1000;

  constructor(size = defaultPoolSize(), perWorker = 2) {
    this.size = size;
    this.perWorker = perWorker;
    this.maxHeavy = Math.max(1, Math.ceil((size * 2) / 3));
    for (let i = 0; i < size; i++) this.workers.push(spawn(`preview-${i}`));
    this.meta = spawn('meta');
  }

  get pending() {
    return this.queue.size;
  }
  get active() {
    return this.running.size;
  }

  enqueue<T>(key: string, priority: number, run: (w: Comlink.Remote<PreviewApi>) => Promise<T>, lane: Lane = 'normal'): Promise<T> {
    const r = this.running.get(key);
    if (r) return r as Promise<T>;
    const existing = this.queue.get(key);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      return existing.promise as Promise<T>;
    }
    let resolve!: (v: T) => void, reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.queue.set(key, { key, priority, seq: this.seq++, lane, run, resolve, reject, promise });
    this.pump();
    return promise;
  }

  has(key: string) {
    return this.queue.has(key) || this.running.has(key);
  }

  setPriority(key: string, priority: number) {
    const j = this.queue.get(key);
    if (j) j.priority = priority;
  }

  reprioritize(fn: (key: string, current: number) => number) {
    for (const j of this.queue.values()) j.priority = fn(j.key, j.priority);
  }

  cancel(pred: (key: string) => boolean) {
    for (const [k, j] of this.queue) {
      if (pred(k)) {
        this.queue.delete(k);
        j.reject(new CancelledError());
      }
    }
  }

  /** Slot a job of this lane could start on right now, if any. */
  private slotFor(lane: Lane): Slot | undefined {
    if (lane === 'meta') return this.meta.active < 8 ? this.meta : undefined;
    if (lane === 'raw') {
      const w = this.workers[0];
      return w.raw === 0 && w.active < this.perWorker ? w : undefined;
    }
    if (lane === 'heavy' && this.heavyActive >= this.maxHeavy) return undefined;
    let best: Slot | undefined;
    for (const w of this.workers) {
      if (w.active >= this.perWorker) continue;
      if (lane === 'heavy' && w.heavy > 0) continue;
      // Prefer workers not busy with a blocking WASM decode.
      const load = w.active + w.heavy * 2 + w.raw * 2;
      if (!best || load < best.active + best.heavy * 2 + best.raw * 2) best = w;
    }
    return best;
  }

  private pump() {
    for (;;) {
      // Best job per lane in one pass, then the highest-priority lane with capacity.
      const bestByLane = new Map<Lane, Job>();
      for (const j of this.queue.values()) {
        const b = bestByLane.get(j.lane);
        if (!b || j.priority < b.priority || (j.priority === b.priority && j.seq < b.seq)) bestByLane.set(j.lane, j);
      }
      let pick: Job | undefined;
      let slot: Slot | undefined;
      const capacity = this.workers.length * this.perWorker;
      let busy = 0;
      for (const w of this.workers) busy += w.active;
      for (const j of [...bestByLane.values()].sort((a, b) => a.priority - b.priority || a.seq - b.seq)) {
        if (j.lane !== 'meta' && j.priority >= this.backgroundPriority && busy >= capacity - 1) continue;
        const s = this.slotFor(j.lane);
        if (s) {
          pick = j;
          slot = s;
          break;
        }
      }
      if (!pick || !slot) {
        if (this.running.size === 0 && this.queue.size === 0) this.onIdle?.();
        return;
      }
      const job = pick;
      const w = slot;
      this.queue.delete(job.key);
      w.active++;
      if (job.lane === 'heavy') {
        w.heavy++;
        this.heavyActive++;
      } else if (job.lane === 'raw') w.raw++;
      const p = job.run(w.api);
      this.running.set(job.key, p);
      p.then(job.resolve, job.reject).finally(() => {
        w.active--;
        if (job.lane === 'heavy') {
          w.heavy--;
          this.heavyActive--;
        } else if (job.lane === 'raw') w.raw--;
        this.running.delete(job.key);
        this.pump();
      });
    }
  }

  terminate() {
    this.cancel(() => true);
    for (const w of [...this.workers, this.meta]) w.worker.terminate();
    this.workers = [];
  }
}

export function defaultPoolSize(): number {
  const n = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(2, Math.min(8, n - 1));
}
