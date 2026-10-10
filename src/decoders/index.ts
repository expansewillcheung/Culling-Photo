// CONTRACT (owned by decoders agent). Runs inside a module Web Worker (also main thread).
import type { FileKind, ParsedFile } from '../core/types';

export interface DecodeOptions {
  /** Downscale so the long edge <= maxEdge (keeps aspect). Omit for full size. */
  maxEdge?: number;
  /**
   * RAW only: allow LibRaw's embedded thumbnail when it is at least as large as the
   * requested size (default true). Set false to force a demosaic.
   */
  allowEmbedded?: boolean;
}

/** Kinds handled by a WASM/JS fallback decoder. */
export type FallbackKind = 'heic' | 'tiff' | 'jxl' | 'raw';

/** Embedded JPEGs with a long edge below this are not good enough for a screen preview. */
export const MIN_EMBEDDED_LONG_EDGE = 1000;

/** @internal per-format decoder module shape */
export interface FormatDecoder {
  /** Load + initialise the WASM module (idempotent, cached). */
  init(): Promise<void>;
  decode(blob: Blob, parsed: ParsedFile, opts: DecodeOptions): Promise<ImageBitmap>;
}

// Each loader is a dynamic import so the libraries (and their .wasm) land in separate
// chunks that are only fetched on first use.
const loaders: Record<FallbackKind, () => Promise<FormatDecoder>> = {
  heic: () => import('./heic'),
  tiff: () => import('./tiff'),
  jxl: () => import('./jxl'),
  raw: () => import('./raw'),
};

const ready = new Map<FallbackKind, Promise<FormatDecoder>>();

function load(kind: FallbackKind): Promise<FormatDecoder> {
  let p = ready.get(kind);
  if (!p) {
    p = loaders[kind]().then(async (m) => {
      await m.init();
      return m;
    });
    // Do not cache failures: allow a retry later (e.g. transient network error).
    p.catch(() => ready.delete(kind));
    ready.set(kind, p);
  }
  return p;
}

function fallbackKind(kind: FileKind): FallbackKind | null {
  return kind === 'heic' || kind === 'tiff' || kind === 'jxl' || kind === 'raw' ? kind : null;
}

/** Warm up the decoder for `kind` (fetch + compile WASM) without decoding anything. */
export async function preloadDecoder(kind: FileKind): Promise<void> {
  const k = fallbackKind(kind);
  if (k) await load(k);
}

/**
 * Decode formats Chrome cannot decode natively, or RAWs with no usable embedded preview:
 * HEIC/HEIF (libheif-js), TIFF (utif2), JXL (@jsquash/jxl), RAW (libraw-wasm).
 * Returns an ImageBitmap with orientation already applied. WASM modules are lazily
 * imported on first use. Returns null if the format is unsupported/failed.
 */
export async function decodeFallback(blob: Blob, parsed: ParsedFile, opts: DecodeOptions = {}): Promise<ImageBitmap | null> {
  const k = fallbackKind(parsed.kind);
  if (!k) return null;
  try {
    const dec = await load(k);
    return await dec.decode(blob, parsed, opts);
  } catch (err) {
    console.warn(`decodeFallback(${parsed.format}) failed:`, err);
    return null;
  }
}

/** True if decodeFallback is needed (i.e. createImageBitmap(blob) won't work). */
export function needsFallback(parsed: ParsedFile): boolean {
  switch (parsed.kind) {
    case 'heic':
    case 'tiff':
    case 'jxl':
      return true;
    case 'raw':
      return !parsed.images.some(
        (im) =>
          im.mime === 'image/jpeg' &&
          // Unknown dimensions: trust a 'full'-role image, otherwise require a known size.
          (im.width && im.height ? Math.max(im.width, im.height) >= MIN_EMBEDDED_LONG_EDGE : im.role === 'full'),
      );
    default:
      return false;
  }
}
