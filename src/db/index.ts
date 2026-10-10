// Persistence module (SQLite-WASM in a worker, OPFS SAH pool VFS). Schema: see ./store.ts.
export { openDb, createDbWorker } from './client';
export type { DbClient } from './client';
export * from './types';
