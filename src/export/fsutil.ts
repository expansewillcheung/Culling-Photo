// File System Access helpers over a FileSystemDirectoryHandle root (local folder or OPFS).
// Paths are '/'-separated and relative to the root.

type MovableFileHandle = FileSystemFileHandle & {
  move?: (dest: FileSystemDirectoryHandle, newName: string) => Promise<void>;
};
type IterableDir = FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> };

export function splitPath(relPath: string): { dir: string; name: string } {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? { dir: '', name: relPath } : { dir: relPath.slice(0, i), name: relPath.slice(i + 1) };
}

export function joinPath(...parts: string[]): string {
  return parts.filter((p) => p !== '').join('/');
}

export function isNotFound(e: unknown): boolean {
  return (e as DOMException)?.name === 'NotFoundError';
}

/** Caches directory handles and (lowercased) child-name listings for one operation run. */
export class FsCache {
  private dirs = new Map<string, Promise<FileSystemDirectoryHandle>>();
  private listings = new Map<string, Promise<Map<string, string>>>();
  /** Directories this cache created (relative paths, parents first). */
  readonly created: string[] = [];

  constructor(readonly root: FileSystemDirectoryHandle) {
    this.dirs.set('', Promise.resolve(root));
  }

  dir(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    const hit = this.dirs.get(path);
    if (hit) return hit;
    const { dir, name } = splitPath(path);
    const p = (async () => {
      const parent = await this.dir(dir, create);
      try {
        return await parent.getDirectoryHandle(name);
      } catch (e) {
        if (!create || !isNotFound(e)) throw e;
        const h = await parent.getDirectoryHandle(name, { create: true });
        this.created.push(path);
        (await this.listing(dir)).set(name.toLowerCase(), name);
        return h;
      }
    })();
    this.dirs.set(path, p);
    p.catch(() => this.dirs.delete(path));
    return p;
  }

  /** lower-cased name → actual name, for a directory (empty if it does not exist). Kept up to date by our ops. */
  listing(path: string): Promise<Map<string, string>> {
    let l = this.listings.get(path);
    if (!l) {
      l = (async () => {
        const out = new Map<string, string>();
        let d: FileSystemDirectoryHandle;
        try {
          d = await this.dir(path);
        } catch (e) {
          if (isNotFound(e)) return out;
          throw e;
        }
        for await (const k of (d as IterableDir).keys()) out.set(k.toLowerCase(), k);
        return out;
      })();
      this.listings.set(path, l);
    }
    return l;
  }

  /** Actual-case name of an existing entry matching `name` case-insensitively. */
  async actualName(dir: string, name: string): Promise<string | undefined> {
    return (await this.listing(dir)).get(name.toLowerCase());
  }

  async exists(relPath: string): Promise<boolean> {
    const { dir, name } = splitPath(relPath);
    return (await this.listing(dir)).has(name.toLowerCase());
  }

  async fileHandle(relPath: string): Promise<FileSystemFileHandle> {
    const { dir, name } = splitPath(relPath);
    return (await this.dir(dir)).getFileHandle(name);
  }

  /** File handle or undefined when missing. */
  async tryFile(relPath: string): Promise<File | undefined> {
    try {
      return await (await this.fileHandle(relPath)).getFile();
    } catch (e) {
      if (isNotFound(e) || (e as DOMException)?.name === 'TypeMismatchError') return undefined;
      throw e;
    }
  }

  noteAdded(relPath: string): void {
    const { dir, name } = splitPath(relPath);
    void this.listing(dir).then((s) => s.set(name.toLowerCase(), name));
  }
  noteRemoved(relPath: string): void {
    const { dir, name } = splitPath(relPath);
    void this.listing(dir).then((s) => s.delete(name.toLowerCase()));
  }

  async readText(relPath: string): Promise<string | undefined> {
    return (await this.tryFile(relPath))?.text();
  }

  /** Write (create or truncate) a small file. */
  async writeFile(relPath: string, data: string | Blob | Uint8Array, createDirs = true): Promise<void> {
    const { dir, name } = splitPath(relPath);
    const d = await this.dir(dir, createDirs);
    const fh = await d.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(data as FileSystemWriteChunkType);
      await w.close();
    } catch (e) {
      await w.abort().catch(() => {});
      throw e;
    }
    (await this.listing(dir)).set(name.toLowerCase(), name);
  }

  async remove(relPath: string): Promise<void> {
    const { dir, name } = splitPath(relPath);
    await (await this.dir(dir)).removeEntry(name);
    (await this.listing(dir)).delete(name.toLowerCase());
  }

  /** Try removing an (empty) directory; returns false if it isn't empty or doesn't exist. */
  async removeEmptyDir(path: string): Promise<boolean> {
    const { dir, name } = splitPath(path);
    try {
      await (await this.dir(dir)).removeEntry(name);
    } catch {
      return false;
    }
    this.dirs.delete(path);
    this.listings.delete(path);
    (await this.listing(dir)).delete(name.toLowerCase());
    return true;
  }

  /**
   * Move a file. Uses FileSystemFileHandle.move() when available; otherwise (or if it fails)
   * copies, verifies the size, then removes the source. Never overwrites: callers must pick a
   * free `dst`; we re-check right before acting.
   */
  async moveFile(src: string, dst: string, opts: { allowNativeMove?: boolean } = {}): Promise<{ method: 'move' | 'copy'; size: number }> {
    if (await this.exists(dst)) throw new DOMException(`destination exists: ${dst}`, 'InvalidModificationError');
    const fh = (await this.fileHandle(src)) as MovableFileHandle;
    const size = (await fh.getFile()).size;
    const { dir: dDir, name: dName } = splitPath(dst);
    const destDir = await this.dir(dDir, true);
    if (opts.allowNativeMove !== false && typeof fh.move === 'function') {
      try {
        await fh.move(destDir, dName);
        this.noteRemoved(src);
        (await this.listing(dDir)).set(dName.toLowerCase(), dName);
        return { method: 'move', size };
      } catch (e) {
        // Fall through to copy unless the source vanished.
        if (isNotFound(e) && !(await this.tryFile(src))) throw e;
      }
    }
    await this.copyFile(src, dst);
    const copied = await this.tryFile(dst);
    if (!copied || copied.size !== size) {
      throw new Error(`copy verification failed for ${src} → ${dst} (${copied?.size} != ${size})`);
    }
    await this.remove(src);
    return { method: 'copy', size };
  }

  /** Stream-copy src → dst (dst must not exist). Returns the byte size. */
  async copyFile(src: string, dst: string): Promise<number> {
    if (await this.exists(dst)) throw new DOMException(`destination exists: ${dst}`, 'InvalidModificationError');
    const file = await (await this.fileHandle(src)).getFile();
    const { dir, name } = splitPath(dst);
    const d = await this.dir(dir, true);
    const out = await d.getFileHandle(name, { create: true });
    (await this.listing(dir)).set(name.toLowerCase(), name);
    const w = await out.createWritable();
    try {
      await file.stream().pipeTo(w); // closes w on success
    } catch (e) {
      await w.abort().catch(() => {});
      await d.removeEntry(name).catch(() => {});
      (await this.listing(dir)).delete(name.toLowerCase());
      throw e;
    }
    const got = (await out.getFile()).size;
    if (got !== file.size) throw new Error(`copy size mismatch for ${dst}: ${got} != ${file.size}`);
    return got;
  }
}

/** Run `fn` over items with bounded concurrency, preserving result order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
