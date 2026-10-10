import { extOf } from '../core/util';

/** One file discovered in the opened folder. */
export interface SourceEntry {
  /** Path relative to the opened root, '/'-separated, e.g. "day1/IMG_0001.CR3". */
  relPath: string;
  name: string;
  /** Directory part of relPath ('' for root). */
  dirRel: string;
  size: number;
  lastModified: number;
  file: File;
}

export interface FileSource {
  readonly name: string;
  /** True when we can write sidecars / move files (File System Access API). */
  readonly writable: boolean;
  readonly root?: FileSystemDirectoryHandle;
  list(onProgress?: (count: number) => void): Promise<SourceEntry[]>;
}

/** Extensions we care about (images, raws, sidecars, videos). Everything else is ignored. */
export const MEDIA_EXT = new Set([
  'jpg', 'jpeg', 'jpe', 'heic', 'heif', 'hif', 'avif', 'webp', 'png', 'gif', 'tif', 'tiff', 'jxl',
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'ori', 'rw2', 'rwl', 'dng',
  'pef', 'srw', '3fr', 'fff', 'iiq', 'mos', 'mrw', 'x3f', 'erf', 'kdc', 'dcr',
  'xmp',
  'mp4', 'mov', 'm4v',
]);

export const SKIP_DIRS = new Set(['_Rejects', '.Trash', '@eaDir', '__MACOSX', 'node_modules']);

export function isMediaName(name: string): boolean {
  return !name.startsWith('.') && MEDIA_EXT.has(extOf(name));
}

export class FsAccessSource implements FileSource {
  readonly writable = true;
  constructor(readonly root: FileSystemDirectoryHandle, private opts: { recursive?: boolean; maxDepth?: number } = {}) {}

  get name() {
    return this.root.name;
  }

  async list(onProgress?: (count: number) => void): Promise<SourceEntry[]> {
    const out: SourceEntry[] = [];
    const maxDepth = this.opts.recursive === false ? 0 : (this.opts.maxDepth ?? 6);
    const walk = async (dir: FileSystemDirectoryHandle, dirRel: string, depth: number) => {
      const files: Promise<void>[] = [];
      const subdirs: [FileSystemDirectoryHandle, string][] = [];
      for await (const handle of (dir as any).values() as AsyncIterable<FileSystemHandle>) {
        if (handle.kind === 'directory') {
          if (depth < maxDepth && !handle.name.startsWith('.') && !SKIP_DIRS.has(handle.name)) {
            subdirs.push([handle as FileSystemDirectoryHandle, dirRel ? `${dirRel}/${handle.name}` : handle.name]);
          }
        } else if (isMediaName(handle.name)) {
          files.push(
            (handle as FileSystemFileHandle).getFile().then((file) => {
              out.push({
                relPath: dirRel ? `${dirRel}/${file.name}` : file.name,
                name: file.name,
                dirRel,
                size: file.size,
                lastModified: file.lastModified,
                file,
              });
              if (onProgress && out.length % 200 === 0) onProgress(out.length);
            }),
          );
        }
      }
      await Promise.all(files);
      for (const [h, rel] of subdirs) await walk(h, rel, depth + 1);
    };
    await walk(this.root, '', 0);
    onProgress?.(out.length);
    return out;
  }
}

/** Read-only fallback: <input webkitdirectory> or a dropped FileList. */
export class FileListSource implements FileSource {
  readonly writable = false;
  constructor(private files: File[], readonly name: string) {}

  async list(onProgress?: (count: number) => void): Promise<SourceEntry[]> {
    const out: SourceEntry[] = [];
    for (const file of this.files) {
      const rel = (file as any).webkitRelativePath || file.name;
      // webkitRelativePath includes the picked folder name as first segment: strip it.
      const parts = rel.split('/');
      if (parts.length > 1) parts.shift();
      if (parts.some((p: string) => p.startsWith('.') || SKIP_DIRS.has(p))) continue;
      if (!isMediaName(file.name)) continue;
      const relPath = parts.join('/');
      const dirRel = parts.slice(0, -1).join('/');
      out.push({ relPath, name: file.name, dirRel, size: file.size, lastModified: file.lastModified, file });
    }
    onProgress?.(out.length);
    return out;
  }
}

export async function getFileHandle(root: FileSystemDirectoryHandle, relPath: string): Promise<FileSystemFileHandle> {
  const parts = relPath.split('/');
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  return dir.getFileHandle(parts[parts.length - 1]);
}

export async function getDirHandle(root: FileSystemDirectoryHandle, dirRel: string, create = false): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  if (!dirRel) return dir;
  for (const p of dirRel.split('/')) dir = await dir.getDirectoryHandle(p, { create });
  return dir;
}
