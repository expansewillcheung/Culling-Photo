// Magic-byte + extension format identification.
import type { FileKind } from '../core/types';
import { ascii, startsWith, u16 } from './bytes';

export interface Detected {
  kind: FileKind;
  format: string;
}

/** TIFF-container RAW extensions -> format label. */
const TIFF_RAW: Record<string, string> = {
  cr2: 'CR2', nef: 'NEF', nrw: 'NRW', arw: 'ARW', srf: 'SRF', sr2: 'SR2', dng: 'DNG',
  pef: 'PEF', srw: 'SRW', orf: 'ORF', ori: 'ORF', rw2: 'RW2', rwl: 'RWL', raw: 'RAW',
  '3fr': '3FR', fff: 'FFF', iiq: 'IIQ', erf: 'ERF', mef: 'MEF', mos: 'MOS', kdc: 'KDC',
  dcr: 'DCR', mrw: 'MRW', x3f: 'X3F', gpr: 'GPR',
};

const EXT_ONLY: Record<string, Detected> = {
  jpg: { kind: 'jpeg', format: 'JPEG' }, jpeg: { kind: 'jpeg', format: 'JPEG' }, jpe: { kind: 'jpeg', format: 'JPEG' },
  png: { kind: 'png', format: 'PNG' }, gif: { kind: 'gif', format: 'GIF' }, webp: { kind: 'webp', format: 'WEBP' },
  heic: { kind: 'heic', format: 'HEIC' }, heif: { kind: 'heic', format: 'HEIF' }, hif: { kind: 'heic', format: 'HEIF' },
  avif: { kind: 'avif', format: 'AVIF' }, jxl: { kind: 'jxl', format: 'JXL' },
  tif: { kind: 'tiff', format: 'TIFF' }, tiff: { kind: 'tiff', format: 'TIFF' },
  mp4: { kind: 'video', format: 'MP4' }, m4v: { kind: 'video', format: 'MP4' }, mov: { kind: 'video', format: 'MOV' },
  avi: { kind: 'video', format: 'AVI' }, mts: { kind: 'video', format: 'MTS' }, m2ts: { kind: 'video', format: 'MTS' },
  '3gp': { kind: 'video', format: '3GP' }, mkv: { kind: 'video', format: 'MKV' }, webm: { kind: 'video', format: 'WEBM' },
  xmp: { kind: 'xmp', format: 'XMP' }, cr3: { kind: 'raw', format: 'CR3' }, raf: { kind: 'raw', format: 'RAF' },
  crw: { kind: 'raw', format: 'CRW' },
};

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

/** ftyp major + compatible brands (empty if no ftyp at offset 4). */
export function ftypBrands(h: Uint8Array): string[] {
  if (!startsWith(h, 4, 'ftyp')) return [];
  const size = (h[0] << 24 >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3];
  const end = Math.min(h.length, Math.max(16, Math.min(size, 256)));
  const brands = [ascii(h, 8, 4, false)];
  for (let o = 16; o + 4 <= end; o += 4) brands.push(ascii(h, o, 4, false));
  return brands;
}

function detectBmff(brands: string[], ext: string): Detected | null {
  const has = (...b: string[]) => b.some((x) => brands.includes(x));
  if (has('crx ')) return { kind: 'raw', format: 'CR3' };
  if (has('avif', 'avis')) return { kind: 'avif', format: 'AVIF' };
  if (has('heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs')) return { kind: 'heic', format: 'HEIC' };
  if (has('mif1', 'msf1', 'miaf')) {
    if (ext === 'avif') return { kind: 'avif', format: 'AVIF' };
    return { kind: 'heic', format: 'HEIF' };
  }
  if (has('jxl ')) return { kind: 'jxl', format: 'JXL' };
  if (brands[0] === 'qt  ') return { kind: 'video', format: 'MOV' };
  if (brands.length) return { kind: 'video', format: ext === 'mov' ? 'MOV' : 'MP4' };
  return null;
}

function detectTiffFamily(h: Uint8Array, ext: string): Detected | null {
  const le = h[0] === 0x49 && h[1] === 0x49;
  const be = h[0] === 0x4d && h[1] === 0x4d;
  if (!le && !be) return null;
  const magic = u16(h, 2, le);
  if (magic === 0x4f52 || magic === 0x5352 || (be && magic === 0x4f52)) return { kind: 'raw', format: 'ORF' };
  if (magic === 0x0055) return { kind: 'raw', format: ext === 'rwl' ? 'RWL' : 'RW2' };
  if (magic !== 42) return ext in TIFF_RAW ? { kind: 'raw', format: TIFF_RAW[ext] } : null;
  if (h[8] === 0x43 && h[9] === 0x52) return { kind: 'raw', format: 'CR2' };
  if (ext in TIFF_RAW) return { kind: 'raw', format: TIFF_RAW[ext] };
  return { kind: 'tiff', format: 'TIFF' };
}

/** Identify file kind/format from extension + first bytes (>= 64 bytes recommended). */
export function detectFormat(head: Uint8Array, name: string): Detected {
  const ext = extOf(name);
  const h = head;
  if (h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return { kind: 'jpeg', format: 'JPEG' };
  if (startsWith(h, 0, '\x89PNG\r\n\x1a\n')) return { kind: 'png', format: 'PNG' };
  if (startsWith(h, 0, 'GIF87a') || startsWith(h, 0, 'GIF89a')) return { kind: 'gif', format: 'GIF' };
  if (startsWith(h, 0, 'RIFF') && startsWith(h, 8, 'WEBP')) return { kind: 'webp', format: 'WEBP' };
  if (startsWith(h, 0, 'RIFF') && startsWith(h, 8, 'AVI ')) return { kind: 'video', format: 'AVI' };
  if ((h.length >= 2 && h[0] === 0xff && h[1] === 0x0a) || startsWith(h, 0, '\0\0\0\x0cJXL \r\n\x87\n'))
    return { kind: 'jxl', format: 'JXL' };
  if (startsWith(h, 0, 'FUJIFILMCCD-RAW')) return { kind: 'raw', format: 'RAF' };
  if (ext === 'iiq' && (startsWith(h, 0, 'IIII') || startsWith(h, 0, 'II*\0'))) return { kind: 'raw', format: 'IIQ' };
  const brands = ftypBrands(h);
  if (brands.length) {
    const d = detectBmff(brands, ext);
    if (d) return d;
  }
  if (h.length >= 8) {
    const t = detectTiffFamily(h, ext);
    if (t) return t;
  }
  if (h.length >= 8 && (startsWith(h, 4, 'moov') || startsWith(h, 4, 'mdat') || startsWith(h, 4, 'wide') || startsWith(h, 4, 'free')) && (ext === 'mov' || ext === 'mp4'))
    return EXT_ONLY[ext];
  if (h.length >= 4 && h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3)
    return { kind: 'video', format: ext === 'webm' ? 'WEBM' : 'MKV' };
  if (ext === 'xmp') return EXT_ONLY.xmp;
  const text = ascii(h, 0, 256, false).replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
  if (text.startsWith('<?xpacket') || text.startsWith('<x:xmpmeta') || (text.startsWith('<?xml') && text.includes('xmpmeta')))
    return EXT_ONLY.xmp;
  // Unknown magic: trust the extension only if the head is too short to tell.
  if (h.length < 16) {
    if (ext in EXT_ONLY) return EXT_ONLY[ext];
    if (ext in TIFF_RAW) return { kind: 'raw', format: TIFF_RAW[ext] };
  }
  return { kind: 'other', format: ext ? ext.toUpperCase() : 'UNKNOWN' };
}
