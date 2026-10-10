// OPFS-backed blob cache (thumbnails, screen previews). Works in workers and main thread.
const ROOT = 'culling-cache';

async function dir(ns: string, create = true): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle(ROOT, { create });
  return base.getDirectoryHandle(ns, { create });
}

const dirCache = new Map<string, Promise<FileSystemDirectoryHandle>>();
function nsDir(ns: string) {
  let p = dirCache.get(ns);
  if (!p) {
    p = dir(ns);
    p.catch(() => dirCache.delete(ns));
    dirCache.set(ns, p);
  }
  return p;
}

export async function cachePut(ns: string, name: string, data: Blob | ArrayBuffer): Promise<void> {
  const d = await nsDir(ns);
  const fh = await d.getFileHandle(name, { create: true });
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  if (typeof (fh as any).createSyncAccessHandle === 'function' && typeof WorkerGlobalScope !== 'undefined') {
    const h = await (fh as any).createSyncAccessHandle();
    try {
      h.truncate(0);
      h.write(new Uint8Array(buf), { at: 0 });
      h.flush();
    } finally {
      h.close();
    }
    return;
  }
  const w = await fh.createWritable();
  await w.write(buf);
  await w.close();
}

export async function cacheGet(ns: string, name: string): Promise<File | null> {
  try {
    const d = await nsDir(ns);
    const fh = await d.getFileHandle(name);
    const f = await fh.getFile();
    return f.size ? f : null;
  } catch {
    return null;
  }
}

export async function cacheList(ns: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const d = await nsDir(ns);
    for await (const name of (d as any).keys() as AsyncIterable<string>) out.add(name);
  } catch {
    /* empty */
  }
  return out;
}

export async function cacheDrop(ns?: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    if (!ns) {
      await root.removeEntry(ROOT, { recursive: true });
      dirCache.clear();
      return;
    }
    const base = await root.getDirectoryHandle(ROOT);
    await base.removeEntry(ns, { recursive: true });
    dirCache.delete(ns);
  } catch {
    /* ignore */
  }
}

export async function cacheUsage(): Promise<{ usage: number; quota: number }> {
  const est = await navigator.storage.estimate();
  return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
}
