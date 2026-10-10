// CONTRACT (owned by decoders agent). Runs inside a module Web Worker (also main thread).
import type { ParsedFile } from '../core/types';

export interface DecodeOptions {
  /** Downscale so the long edge <= maxEdge (keeps aspect). Omit for full size. */
  maxEdge?: number;
}

/**
 * Decode formats Chrome cannot decode natively, or RAWs with no usable embedded preview:
 * HEIC/HEIF (libheif-js), TIFF (utif2), JXL (@jsquash/jxl), RAW (libraw-wasm).
 * Returns an ImageBitmap with EXIF orientation already applied. WASM modules are lazily
 * imported on first use. Returns null if the format is unsupported/failed.
 */
export async function decodeFallback(_blob: Blob, _parsed: ParsedFile, _opts: DecodeOptions = {}): Promise<ImageBitmap | null> {
  throw new Error('not implemented');
}

/** True if decodeFallback is needed (i.e. createImageBitmap(blob) won't work). */
export function needsFallback(_parsed: ParsedFile): boolean {
  throw new Error('not implemented');
}
