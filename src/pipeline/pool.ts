import * as Comlink from 'comlink';
import type { PreviewApi } from '../workers/preview.worker';

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
  }
}

interface Job<T = unknown> {
  key: string;
  priority: number;
  seq: number;
  run: (w: Comlink.Remote<PreviewApi>) => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  promise: Promise<T>;
}

/**
 * Worker pool with a priority queue (lower number = sooner), key de-duplication and
 * cancellation of queued (not yet started) jobs.
 */
export class WorkerPool {
  readonly size: number;
  private workers: { api: Comlink.Remote<PreviewApi>; worker: Worker; active: number }[] = [];
  private queue = new Map<string, Job<any>>();
  private running = new Map<string, Promise<unknown>>();
  private seq = 0;
  private perWorker: number;
  onIdle?: () => void;

  constructor(size = defaultPoolSize(), perWorker = 2) {
    this.size = size;
    this.perWorker = perWorker;
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('../workers/preview.worker.ts', import.meta.url), { type: 'module', name: `preview-${i}` });
      this.workers.push({ api: Comlink.wrap<PreviewApi>(worker), worker, active: 0 });
    }
  }

  get pending() {
    return this.queue.size;
  }
  get active() {
    return this.running.size;
  }

  /** Any worker, for one-off calls that should bypass the queue. */
  direct(): Comlink.Remote<PreviewApi> {
    const w = this.workers.reduce((a, b) => (b.active < a.active ? b : a));
    return w.api;
  }

  enqueue<T>(key: string, priority: number, run: (w: Comlink.Remote<PreviewApi>) => Promise<T>): Promise<T> {
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
    this.queue.set(key, { key, priority, seq: this.seq++, run, resolve, reject, promise });
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

  /** Re-prioritise all queued jobs. */
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

  private pickNext(): Job | undefined {
    let best: Job | undefined;
    for (const j of this.queue.values()) {
      if (!best || j.priority < best.priority || (j.priority === best.priority && j.seq < best.seq)) best = j;
    }
    return best;
  }

  private pump() {
    for (;;) {
      const w = this.workers.reduce((a, b) => (b.active < a.active ? b : a));
      if (w.active >= this.perWorker) return;
      const job = this.pickNext();
      if (!job) {
        if (this.running.size === 0) this.onIdle?.();
        return;
      }
      this.queue.delete(job.key);
      w.active++;
      const p = job.run(w.api);
      this.running.set(job.key, p);
      p.then(job.resolve, job.reject).finally(() => {
        w.active--;
        this.running.delete(job.key);
        this.pump();
      });
    }
  }

  terminate() {
    this.cancel(() => true);
    for (const w of this.workers) w.worker.terminate();
    this.workers = [];
  }
}

export function defaultPoolSize(): number {
  const n = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(2, Math.min(8, n - 1));
}
