/// <reference lib="webworker" />
// Dedicated module worker hosting SQLite (sqlite-wasm, 'opfs-sahpool' VFS). Exposed via comlink.
//
// Persistence & multi-tab: the SAH pool keeps exclusive OPFS sync-access handles, so only one
// worker per origin can use a given pool directory. We take a Web Lock named after the pool
// first; if another tab holds it (or the VFS fails to install), we fall back to an in-memory DB
// and report { persistent: false, reason }. The lock is released by close() or worker teardown.
import * as Comlink from 'comlink';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { SAHPoolUtil, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { Store } from './store';
import type { DbApi, DbOptions, DbStatus } from './types';

let sqlite3: Sqlite3Static | undefined;
let pool: SAHPoolUtil | undefined;
let store: Store | undefined;
let status: DbStatus | undefined;
let releaseLock: (() => void) | undefined;
let initPromise: Promise<DbStatus> | undefined;

/** Try to take an exclusive Web Lock; resolves to a release function, or undefined if unavailable. */
async function acquireLock(name: string, timeoutMs: number): Promise<(() => void) | undefined> {
  if (!('locks' in navigator)) return () => {};
  return new Promise((resolve) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const ac = timeoutMs > 0 ? new AbortController() : undefined;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : undefined;
    navigator.locks
      .request(name, ac ? { mode: 'exclusive', signal: ac.signal } : { mode: 'exclusive', ifAvailable: true }, (lock) => {
        clearTimeout(timer);
        if (!lock) {
          resolve(undefined);
          return;
        }
        resolve(release);
        return held;
      })
      .catch(() => resolve(undefined));
  });
}

async function doInit(opts: DbOptions = {}): Promise<DbStatus> {
  const name = (opts.name ?? 'culling-photo').replace(/[^\w-]/g, '_');
  sqlite3 ??= await sqlite3InitModule();
  const version = sqlite3.version.libVersion;
  const memory = (reason: string): DbStatus => {
    store = new Store(new sqlite3!.oo1.DB(':memory:', 'c'));
    return { persistent: false, vfs: 'memory', reason, sqliteVersion: version };
  };
  if (opts.memory) return memory('requested');
  if (typeof navigator.storage?.getDirectory !== 'function') return memory('opfs-unavailable');

  releaseLock = await acquireLock(`${name}-sahpool`, opts.lockTimeoutMs ?? 0);
  if (!releaseLock) return memory('locked-by-other-tab');
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({
      name: `${name}-sahpool`,
      directory: `.${name}-sahpool`,
      initialCapacity: 6,
    });
    if (pool.isPaused()) await pool.unpauseVfs(); // re-init after close() in the same worker
    await pool.reserveMinimumCapacity(6);
    store = new Store(new pool.OpfsSAHPoolDb(`/${name}.sqlite3`));
    return { persistent: true, vfs: 'opfs-sahpool', sqliteVersion: version };
  } catch (e) {
    // Typically NoModificationAllowedError: handles held by a context that doesn't use our lock.
    try {
      pool?.pauseVfs();
    } catch {
      /* ignore */
    }
    pool = undefined;
    releaseLock();
    releaseLock = undefined;
    return memory(`sahpool-failed: ${(e as Error)?.message ?? String(e)}`);
  }
}

function s(): Store {
  if (!store) throw new Error('db not initialised: call init() first');
  return store;
}

const api: DbApi = {
  async init(opts) {
    initPromise ??= doInit(opts).then((st) => (status = st));
    return initPromise;
  },
  status() {
    if (!status) throw new Error('db not initialised');
    return status;
  },
  openSession: ({ rootName, fingerprint }) => s().openSession(rootName, fingerprint),
  listSessions: () => s().listSessions(),
  deleteSession: (id) => s().deleteSession(id),
  setSessionSettings: (id, settings) => s().setSessionSettings(id, settings),
  upsertFiles: (sid, rows, opts) => s().upsertFiles(sid, rows, opts),
  deletePhotos: (sid, keys) => s().deletePhotos(sid, keys),
  loadSession: (sid) => s().loadSession(sid),
  setMarks: (sid, ups) => s().setMarks(sid, ups),
  setAiFields: (sid, ups) => s().setAiFields(sid, ups),
  setThumbState: (sid, ups) => s().setThumbState(sid, ups),
  appendHistory: (sid, entries) => s().appendHistory(sid, entries),
  loadHistory: (sid, limit) => s().loadHistory(sid, limit),
  truncateHistory: (sid, after) => s().truncateHistory(sid, after),
  setHistoryUndone: (sid, seqs, undone) => s().setHistoryUndone(sid, seqs, undone),
  close() {
    try {
      store?.close();
    } finally {
      store = undefined;
      try {
        pool?.pauseVfs();
      } catch {
        /* ignore */
      }
      pool = undefined;
      releaseLock?.();
      releaseLock = undefined;
      status = undefined;
      initPromise = undefined;
    }
  },
};

Comlink.expose(api);
