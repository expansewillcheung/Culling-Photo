// Persist recently opened directory handles in IndexedDB (handles are structured-cloneable).
const DB = 'culling-recent';
const STORE = 'handles';

export interface RecentEntry {
  id: string;
  name: string;
  openedAt: number;
  handle: FileSystemDirectoryHandle;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }).finally(() => db.close());
}

export async function listRecent(): Promise<RecentEntry[]> {
  try {
    const all = await tx<RecentEntry[]>('readonly', (s) => s.getAll() as IDBRequest<RecentEntry[]>);
    return all.sort((a, b) => b.openedAt - a.openedAt).slice(0, 12);
  } catch {
    return [];
  }
}

export async function rememberRecent(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const all = await listRecent();
    for (const e of all) {
      if (await e.handle.isSameEntry(handle)) {
        await tx('readwrite', (s) => s.put({ ...e, openedAt: Date.now() }));
        return;
      }
    }
    await tx('readwrite', (s) => s.put({ id: crypto.randomUUID(), name: handle.name, openedAt: Date.now(), handle }));
  } catch {
    /* non-fatal */
  }
}

export async function forgetRecent(id: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch {
    /* ignore */
  }
}

export async function ensurePermission(handle: FileSystemDirectoryHandle, mode: 'read' | 'readwrite' = 'readwrite'): Promise<boolean> {
  const h = handle as any;
  if ((await h.queryPermission?.({ mode })) === 'granted') return true;
  return (await h.requestPermission?.({ mode })) === 'granted';
}
