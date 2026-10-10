// Main-thread client for the DB worker. Usage:
//   const db = await openDb();            // spawns src/db/db.worker.ts
//   if (!db.status.persistent) showBanner(db.status.reason);
//   const { sessionId } = await db.openSession({ rootName, fingerprint });
//   const photos = await db.loadSession(sessionId);
//   await db.setMarks(sessionId, [{ key, marks: { rating: 3 } }]);
//   await db.close();                     // releases the OPFS pool + lock, terminates the worker
import * as Comlink from 'comlink';
import type { DbApi, DbOptions, DbStatus } from './types';

/** Remote API (every method returns a Promise) plus lifecycle helpers. */
export type DbClient = Omit<Comlink.Remote<DbApi>, 'close' | 'init' | 'status'> & {
  readonly status: DbStatus;
  /** Close the DB, release the SAH pool and Web Lock, terminate the worker. Idempotent. */
  close(): Promise<void>;
  /** Terminate without closing (simulates a crashed/killed tab; for tests). */
  terminate(): void;
};

export function createDbWorker(): Worker {
  return new Worker(new URL('./db.worker.ts', import.meta.url), { type: 'module', name: 'db' });
}

export async function openDb(opts: DbOptions = {}, worker: Worker = createDbWorker()): Promise<DbClient> {
  const remote = Comlink.wrap<DbApi>(worker);
  let status: DbStatus;
  try {
    status = await remote.init(opts);
  } catch (e) {
    worker.terminate();
    throw e;
  }
  let closed = false;
  const extra = {
    status,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await remote.close();
      } finally {
        remote[Comlink.releaseProxy]();
        worker.terminate();
      }
    },
    terminate() {
      closed = true;
      worker.terminate();
    },
  };
  // Forward everything else to the comlink proxy.
  return new Proxy(extra, {
    get(target, prop, recv) {
      if (prop in target) return Reflect.get(target, prop, recv);
      if (prop === 'then') return undefined; // not a thenable
      return (remote as unknown as Record<string | symbol, unknown>)[prop];
    },
  }) as unknown as DbClient;
}
