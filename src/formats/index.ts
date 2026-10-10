// CONTRACT (owned by formats agent). Pure TS, no DOM: must run in node, workers and main thread.
import type { FileKind, ParsedFile, Reader, EmbeddedImage } from '../core/types';

/** Identify file kind/format from extension + first bytes (>= 64 bytes recommended). */
export function detectFormat(_head: Uint8Array, _name: string): { kind: FileKind; format: string } {
  throw new Error('not implemented');
}

/**
 * Parse container + EXIF, list embedded JPEG previews. Must read only what it needs
 * (headers/IFDs), never the full RAW payload. Never throws for unknown formats:
 * returns { kind: 'other', images: [] }.
 */
export async function parseFile(_reader: Reader, _name: string): Promise<ParsedFile> {
  throw new Error('not implemented');
}

/**
 * Choose the best embedded image for a target long edge (px): smallest one whose
 * long edge >= target, else the largest. Returns undefined if none.
 */
export function pickEmbedded(_parsed: ParsedFile, _targetLongEdge: number): EmbeddedImage | undefined {
  throw new Error('not implemented');
}
