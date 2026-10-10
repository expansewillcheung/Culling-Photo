// Batch XMP sidecar writing in place (PLAN.md §6 method B), merging into existing sidecars.
import type { Marks } from '../core/types';
import { buildSidecar, sidecarName } from '../formats/xmp';
import { FsCache, joinPath, mapLimit, splitPath } from './fsutil';

export interface SidecarItem {
  /** Image file the sidecar describes (relative to root). */
  relPath: string;
  marks: Marks;
  /** Known current sidecar content; when omitted the sidecar is read from disk. */
  existing?: string;
}

export interface SidecarResult {
  relPath: string;
  sidecar: string;
  status: 'created' | 'updated' | 'unchanged' | 'error';
  error?: string;
}

/**
 * Write `IMG_0001.xmp` next to each item (Lightroom convention), merging with the existing
 * sidecar if there is one (an existing 'IMG_0001.XMP' keeps its case). RAW+JPEG pairs map to
 * the same sidecar; duplicates are collapsed (last item wins).
 */
export async function writeSidecars(
  root: FileSystemDirectoryHandle,
  items: SidecarItem[],
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<SidecarResult[]> {
  const fs = new FsCache(root);
  const byPath = new Map<string, SidecarItem & { sidecar: string }>();
  for (const it of items) {
    const sc = sidecarName(it.relPath);
    byPath.set(sc.toLowerCase(), { ...it, sidecar: sc });
  }
  const list = [...byPath.values()];
  let done = 0;
  return mapLimit(list, opts.concurrency ?? 8, async (it) => {
    const { dir, name } = splitPath(it.sidecar);
    let target = it.sidecar;
    try {
      const actual = await fs.actualName(dir, name);
      if (actual) target = joinPath(dir, actual);
      const existing = it.existing ?? (actual ? await fs.readText(target) : undefined);
      const xml = buildSidecar(it.marks, existing);
      let status: SidecarResult['status'] = existing === undefined ? 'created' : 'updated';
      if (existing === xml) status = 'unchanged';
      else await fs.writeFile(target, xml, false);
      return { relPath: it.relPath, sidecar: target, status };
    } catch (e) {
      return { relPath: it.relPath, sidecar: target, status: 'error' as const, error: (e as Error)?.message ?? String(e) };
    } finally {
      opts.onProgress?.(++done, list.length);
    }
  });
}
