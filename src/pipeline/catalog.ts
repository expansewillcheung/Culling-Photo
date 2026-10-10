import type { FileKind } from '../core/types';
import { extOf, stemOf } from '../core/util';
import type { SourceEntry } from '../fs/FileSource';

const RAW_EXT = new Set([
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'ori', 'rw2', 'rwl', 'dng',
  'pef', 'srw', '3fr', 'fff', 'iiq', 'mos', 'mrw', 'x3f', 'erf', 'kdc', 'dcr',
]);

export function kindFromExt(ext: string): FileKind {
  if (RAW_EXT.has(ext)) return 'raw';
  switch (ext) {
    case 'jpg': case 'jpeg': case 'jpe': return 'jpeg';
    case 'heic': case 'heif': case 'hif': return 'heic';
    case 'avif': return 'avif';
    case 'webp': return 'webp';
    case 'png': return 'png';
    case 'gif': return 'gif';
    case 'tif': case 'tiff': return 'tiff';
    case 'jxl': return 'jxl';
    case 'mp4': case 'mov': case 'm4v': return 'video';
    case 'xmp': return 'xmp';
    default: return 'other';
  }
}

/** Display preference when several files share a basename (RAW+JPEG): fastest decodable first. */
const DISPLAY_RANK: Record<FileKind, number> = {
  jpeg: 0, webp: 1, avif: 2, png: 3, heic: 4, jxl: 5, tiff: 6, gif: 7, raw: 8, video: 9, xmp: 99, other: 99,
};

export interface CatalogItem {
  /** Stable key: dirRel + '/' + lowercase stem. */
  key: string;
  stem: string;
  dirRel: string;
  /** Media files (no sidecars), display-preferred first. */
  files: SourceEntry[];
  kinds: FileKind[];
  sidecar?: SourceEntry;
  /** Index into files of the RAW member, if any. */
  rawIndex: number;
}

export function buildCatalog(entries: SourceEntry[]): CatalogItem[] {
  const map = new Map<string, CatalogItem>();
  const sidecars = new Map<string, SourceEntry>();
  for (const e of entries) {
    const ext = extOf(e.name);
    const kind = kindFromExt(ext);
    // Sidecars: "IMG_1.xmp" or "IMG_1.CR3.xmp"
    if (kind === 'xmp') {
      let stem = stemOf(e.name);
      if (RAW_EXT.has(extOf(stem)) || kindFromExt(extOf(stem)) !== 'other') stem = stemOf(stem);
      sidecars.set(`${e.dirRel}/${stem.toLowerCase()}`, e);
      continue;
    }
    if (kind === 'other') continue;
    const stem = stemOf(e.name);
    const key = `${e.dirRel}/${stem.toLowerCase()}`;
    let item = map.get(key);
    if (!item) {
      item = { key, stem, dirRel: e.dirRel, files: [], kinds: [], rawIndex: -1 };
      map.set(key, item);
    }
    item.files.push(e);
  }
  const out: CatalogItem[] = [];
  for (const item of map.values()) {
    item.files.sort((a, b) => DISPLAY_RANK[kindFromExt(extOf(a.name))] - DISPLAY_RANK[kindFromExt(extOf(b.name))]);
    item.kinds = item.files.map((f) => kindFromExt(extOf(f.name)));
    item.rawIndex = item.kinds.indexOf('raw');
    item.sidecar = sidecars.get(item.key);
    out.push(item);
  }
  // Initial order: path then name (camera counters are near-chronological).
  out.sort((a, b) => (a.dirRel === b.dirRel ? cmpNatural(a.stem, b.stem) : cmpNatural(a.dirRel, b.dirRel)));
  return out;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function cmpNatural(a: string, b: string): number {
  return collator.compare(a, b);
}

/** Session fingerprint: changes when files are added/removed/modified. */
export function fingerprint(entries: SourceEntry[]): string {
  let acc = entries.length;
  let h = 0x811c9dc5;
  const sorted = [...entries].sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  for (const e of sorted) {
    const s = `${e.relPath}|${e.size}|${e.lastModified}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    acc = (acc + e.size) % 1e15;
  }
  return `${entries.length}-${h.toString(16)}-${acc.toString(36)}`;
}
