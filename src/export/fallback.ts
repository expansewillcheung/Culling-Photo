// Read-only fallback exports (PLAN.md §6 method D, and the XMP zip for <input webkitdirectory> mode).
import { zipSync, strToU8, type Zippable } from 'fflate';
import type { Marks } from '../core/types';
import { buildSidecar, sidecarName } from '../formats/xmp';

export interface ExportPhoto {
  key?: string;
  marks: Marks;
  files: { relPath: string; kind?: string }[];
  /** Existing sidecar content to merge into (exportXmpZip). */
  existingXmp?: string;
}

const RAW_EXT = /\.(cr2|cr3|crw|nef|nrw|arw|srf|sr2|raf|orf|rw2|dng|pef|srw|3fr|iiq|erf|mos|mrw|x3f|rwl|kdc|dcr|fff)$/i;

function primary(p: ExportPhoto): string | undefined {
  const files = p.files.filter((f) => !/\.xmp$/i.test(f.relPath));
  return (files.find((f) => (f.kind ? f.kind === 'raw' : RAW_EXT.test(f.relPath))) ?? files[0])?.relPath;
}

function csvField(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV (RFC 4180, CRLF) with one row per photo: files are ';'-joined. */
export function exportCsv(photos: ExportPhoto[]): string {
  const rows: string[] = ['key,files,rating,flag,label'];
  for (const p of photos) {
    const flag = p.marks.flag === 1 ? 'pick' : p.marks.flag === -1 ? 'reject' : '';
    const files = p.files.map((f) => f.relPath).filter((r) => !/\.xmp$/i.test(r));
    rows.push([p.key ?? (files[0] ?? '').toLowerCase(), files.join(';'), p.marks.rating ?? 0, flag, p.marks.label ?? ''].map(csvField).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

/**
 * Zip of XMP sidecars at their would-be paths (relative to the folder root), for when the
 * folder can't be written: the user unzips it over the folder. Includes every photo with marks.
 */
export function exportXmpZip(photos: ExportPhoto[], opts: { includeUnmarked?: boolean } = {}): Blob {
  const files: Zippable = {};
  const mtime = new Date();
  for (const p of photos) {
    const m = p.marks;
    if (!opts.includeUnmarked && !(m.rating > 0 || m.flag !== 0 || m.label)) continue;
    const rel = primary(p);
    if (!rel) continue;
    files[sidecarName(rel)] = [strToU8(buildSidecar(m, p.existingXmp)), { mtime, level: 6 }];
  }
  const zipped = zipSync(files);
  return new Blob([zipped as BlobPart], { type: 'application/zip' });
}
