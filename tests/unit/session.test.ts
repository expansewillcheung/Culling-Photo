// Session integration logic (scheduling, lifecycle, persistence restore) against a fake pool.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { store } from '../../src/store/store';
import { Session, PRIORITY } from '../../src/app/session';
import { CancelledError } from '../../src/pipeline/pool';
import type { SourceEntry, FileSource } from '../../src/fs/FileSource';
import type { PersistAdapter, SavedPhoto } from '../../src/app/persist';

const { state, actions } = store;

vi.mock('../../src/ai/client', () => ({
  createAiWorker: () => ({
    analyze: () => new Promise((r) => setTimeout(() => r({ faces: { faceCount: 2, eyesClosed: true } }), 30)),
    terminate() {},
  }),
}));

beforeAll(() => {
  const g = globalThis as any;
  g.window ??= g;
  g.requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
  g.innerWidth ??= 1440;
  g.innerHeight ??= 900;
});

const tick = (ms = 130) => new Promise((r) => setTimeout(r, ms));

interface FakeJob {
  key: string;
  priority: number;
  lane: string;
  run: (w: any) => Promise<any>;
  resolve: (v: any) => void;
  reject: (e: any) => void;
  promise: Promise<any>;
}

/** Pool double: nothing runs until the test calls run(key). */
class FakePool {
  jobs = new Map<string, FakeJob>();
  running = new Set<string>();
  terminated = false;
  enqueue(key: string, priority: number, run: (w: any) => Promise<any>, lane = 'normal') {
    if (this.terminated) return Promise.reject(new CancelledError());
    const ex = this.jobs.get(key);
    if (ex) {
      ex.priority = Math.min(ex.priority, priority);
      return ex.promise;
    }
    let resolve!: (v: any) => void, reject!: (e: any) => void;
    const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
    this.jobs.set(key, { key, priority, lane, run, resolve, reject, promise });
    return promise;
  }
  has(key: string) {
    return this.jobs.has(key);
  }
  priorityOf(key: string) {
    return this.jobs.get(key)?.priority;
  }
  setPriority(key: string, p: number) {
    const j = this.jobs.get(key);
    if (j && !this.running.has(key)) j.priority = p;
  }
  reprioritize(fn: (key: string, cur: number) => number) {
    for (const j of this.jobs.values()) if (!this.running.has(j.key)) j.priority = fn(j.key, j.priority);
  }
  cancel(pred: (key: string, priority: number) => boolean) {
    for (const [k, j] of this.jobs) {
      if (this.running.has(k)) continue;
      if (pred(k, j.priority)) {
        this.jobs.delete(k);
        j.reject(new CancelledError());
      }
    }
  }
  async run(key: string, worker: any = fakeWorker) {
    const j = this.jobs.get(key);
    if (!j) throw new Error(`no job ${key}`);
    this.running.add(key);
    try {
      j.resolve(await j.run(worker));
    } catch (e) {
      j.reject(e);
    } finally {
      this.running.delete(key);
      this.jobs.delete(key);
    }
    await j.promise.catch(() => {});
  }
  async runAll(prefix: string) {
    for (const k of [...this.jobs.keys()]) if (k.startsWith(prefix)) await this.run(k);
  }
  terminate() {
    this.terminated = true;
    this.cancel(() => true);
  }
}

const parsedFor = (name: string, exif: Record<string, unknown> = {}) => ({
  kind: name.toLowerCase().endsWith('.mp4') ? 'video' : 'jpeg',
  format: 'JPEG',
  exif: { width: 300, height: 200, ...exif },
  images: [],
});

let exifByName: Record<string, Record<string, unknown>> = {};
const fakeWorker = {
  async parseMany(files: { name: string }[]) {
    return files.map((f) => ({ parsed: parsedFor(f.name, exifByName[f.name]) }));
  },
  async thumb(file: File) {
    return { ok: true, thumb: new Blob([file.name]), width: 300, height: 200, sourceWidth: 300, sourceHeight: 200, ms: 1 };
  },
  async render() {
    return { bitmap: { close() {}, width: 10, height: 10 }, sourceWidth: 10, sourceHeight: 10 };
  },
};

function entry(relPath: string, content = relPath): SourceEntry {
  const parts = relPath.split('/');
  const name = parts.pop()!;
  return { relPath, name, dirRel: parts.join('/'), size: content.length, lastModified: 1000, file: new File([content], name) };
}

function source(name: string, names: string[], gate?: Promise<void>): FileSource {
  return {
    name,
    writable: false,
    async list() {
      await gate;
      return names.map((n) => entry(n));
    },
  };
}

class FixedPersist implements PersistAdapter {
  persistent = false;
  constructor(private saved: Map<string, SavedPhoto>) {}
  async open() {
    return this.saved;
  }
  async saveAll() {}
  async saveMarks() {}
  async close() {}
}

let live: Session[] = [];
async function openSession(src: FileSource, persist?: PersistAdapter) {
  const pool = new FakePool();
  const s = new Session(pool as any);
  live.push(s);
  await s.open(src, persist);
  return { s, pool };
}

afterEach(async () => {
  for (const s of live) await s.dispose();
  live = [];
  exifByName = {};
  actions.resetFilter();
  actions.setState({ photos: [], current: -1, selection: [] });
});

const stems = () => store.viewIds().map((id) => state.photos[id].stem);

describe('session lifecycle', () => {
  it('undo does not leak across folders', async () => {
    const a = await openSession(source('A', ['a1.jpg', 'a2.jpg']));
    actions.select(0);
    actions.setFlag(1);
    expect(state.photos[0].flag).toBe(1);
    await a.s.dispose();
    await openSession(source('B', ['b1.jpg', 'b2.jpg']));
    expect(actions.undo()).toBe(false);
    expect(state.photos[0].flag).toBe(0);
    expect(state.photos[0].stem).toBe('b1');
  });

  it('a thumbnail finished by a disposed session never lands on the next folder', async () => {
    const a = await openSession(source('A', ['a1.jpg', 'a2.jpg']));
    a.s.requestThumb(0, 0);
    await tick(0);
    // Result arrives, update queued for the next frame...
    await a.pool.run('thumb:0');
    // ...but the folder is switched before that frame.
    await a.s.dispose();
    const b = await openSession(source('B', ['b1.jpg', 'b2.jpg']));
    await tick();
    expect(state.photos[0].stem).toBe('b1');
    expect(state.photos[0].thumbUrl).toBeUndefined();
    expect(b.s).toBeTruthy();
  });

  it('thumb requests while the next folder is still listing do not use the old photos', async () => {
    const a = await openSession(source('A', ['a1.jpg', 'a2.jpg']));
    await a.s.dispose();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pool = new FakePool();
    const s = new Session(pool as any);
    live.push(s);
    const opening = s.open(source('B', ['b1.jpg', 'b2.jpg'], gate));
    // Grid still shows A's photos and asks the (new) session for visible thumbs.
    s.setVisible([0, 1]);
    release();
    await opening;
    await tick(0);
    s.setVisible([0, 1]);
    await tick(0);
    // Whatever thumb job exists must be for B's file.
    const j = pool.jobs.get('thumb:0');
    expect(j).toBeTruthy();
    let seen = '';
    await j!.run({ ...fakeWorker, thumb: async (f: File) => ((seen = f.name), fakeWorker.thumb(f)) }).catch(() => {});
    expect(seen).toBe('b1.jpg');
  });

  it('a video whose poster frame fails still completes the thumbnail pass', async () => {
    const { s, pool } = await openSession(source('V', ['clip.mp4', 'b.jpg']));
    await pool.runAll('meta:');
    await tick();
    await tick(0);
    await pool.runAll('thumb:');
    await tick();
    expect(state.photos.find((p) => p.stem === 'clip')!.thumbState).toBe('error');
    expect(state.progress.allThumbsAt).toBeTruthy();
    expect(s).toBeTruthy();
  });

  it('face analysis stops writing once its folder is closed', async () => {
    const { analyzeFaces } = await import('../../src/app/faces');
    const a = await openSession(source('A', ['a1.jpg', 'a2.jpg', 'a3.jpg']));
    await a.pool.runAll('meta:');
    await tick();
    void analyzeFaces(a.s);
    await tick(0);
    await a.pool.runAll('face:'); // decodes done, detection in flight
    await a.s.dispose();
    await openSession(source('B', ['b1.jpg', 'b2.jpg', 'b3.jpg']));
    await tick(100);
    expect(state.photos.map((p) => p.faceCount)).toEqual([undefined, undefined, undefined]);
  });

  it('flushMarks waits for sidecar writes', async () => {
    const { s } = await openSession(source('A', ['a1.jpg']));
    let written = false;
    s.onDirtyMarks = () => new Promise<void>((r) => setTimeout(() => ((written = true), r()), 50));
    actions.select(0);
    actions.setFlag(1);
    await s.flushMarks();
    expect(written).toBe(true);
  });
});

describe('marks restore', () => {
  it('sidecar marks do not overwrite marks made during the metadata pass', async () => {
    const pool = new FakePool();
    const s = new Session(pool as any);
    live.push(s);
    s.hooks.readSidecar = async () => ({ rating: 3, flag: 0, label: '' });
    await s.open(source('A', ['a1.jpg', 'a1.xmp', 'a2.jpg', 'a2.xmp']));
    actions.select(0);
    actions.setFlag(-1); // user culls while headers are still being parsed
    await pool.runAll('meta:');
    await tick();
    await tick(0);
    expect(state.photos[0].flag).toBe(-1);
    expect(state.photos[0].rating).toBe(0);
    expect(state.photos[1].rating).toBe(3); // untouched photo gets its sidecar marks
  });

  it('EXIF rating does not resurrect marks cleared in a previous session', async () => {
    exifByName = { 'a1.jpg': { rating: 4 }, 'a2.jpg': { rating: 4 } };
    const saved = new Map<string, SavedPhoto>([['/a1', { key: '/a1', marks: { rating: 0, flag: 0, label: '' } }]]);
    const { pool } = await openSession(source('A', ['a1.jpg', 'a2.jpg']), new FixedPersist(saved));
    await pool.runAll('meta:');
    await tick();
    expect(state.photos[0].rating).toBe(0);
    expect(state.photos[1].rating).toBe(4);
  });
});

describe('scheduling', () => {
  it('the background pass does not demote thumbnails that are on screen', async () => {
    const names = Array.from({ length: 40 }, (_, i) => `p${i}.jpg`);
    const { s, pool } = await openSession(source('A', names));
    s.setVisible([30, 31]);
    await tick(0);
    await pool.runAll('meta:');
    await tick();
    await tick(0);
    expect(pool.priorityOf('thumb:30')!).toBeLessThan(PRIORITY.background);
    expect(pool.priorityOf('thumb:30')!).toBeLessThan(pool.priorityOf('thumb:0')!);
  });

  it('scrolled-away thumbnails yield to the ones now on screen', async () => {
    const names = Array.from({ length: 40 }, (_, i) => `p${i}.jpg`);
    const { s, pool } = await openSession(source('A', names));
    s.setVisible([0, 1, 2]);
    await tick(0);
    s.setVisible([30, 31, 32]);
    await tick(0);
    expect(pool.priorityOf('thumb:30')!).toBeLessThan(pool.priorityOf('thumb:0')!);
  });

  it('preloading around one compare pane does not cancel another pane\'s render', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `p${i}.jpg`);
    const { s, pool } = await openSession(source('A', names));
    actions.setState('sort', 'name');
    actions.select(0);
    actions.select(15, 'toggle');
    actions.setView('compare');
    const edge = s.screenEdge();
    const paneA = s.getRender(0, edge);
    s.preloadAround(0);
    s.getRender(15, edge);
    s.preloadAround(15);
    expect(pool.has(`render:0@${edge}`)).toBe(true);
    await pool.run(`render:0@${edge}`);
    expect(await paneA).toBeTruthy();
  });
});

describe('selection', () => {
  it('shift-click when the current photo is filtered out selects real ids', async () => {
    await openSession(source('A', ['a1.jpg', 'a2.jpg', 'a3.jpg']));
    actions.setState('sort', 'name');
    actions.select(0);
    actions.setFlag(1);
    actions.select(1);
    actions.setFlag(1);
    actions.select(2); // current = a3 (unflagged)
    actions.setFilter({ flag: 'picks' });
    expect(stems()).toEqual(['a1', 'a2']);
    actions.select(1, 'range');
    expect(state.selection.every((id) => typeof id === 'number' && state.photos[id])).toBe(true);
    actions.setRating(3); // must not throw
    expect(state.photos[1].rating).toBe(3);
  });

  it('changing the filter drops selected photos that are no longer shown', async () => {
    await openSession(source('A', ['a1.jpg', 'a2.jpg', 'a3.jpg']));
    actions.select(0);
    actions.setFlag(1);
    actions.selectAll();
    actions.setFilter({ flag: 'picks' });
    expect(stems()).toEqual(['a1']);
    expect(state.selection.filter((id) => !store.viewIndex().has(id))).toEqual([]);
    actions.setRating(2); // must only touch what is on screen
    expect(state.photos.map((p) => p.rating)).toEqual([2, 0, 0]);
  });
});
