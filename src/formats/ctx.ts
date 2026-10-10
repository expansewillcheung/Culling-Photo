import type { ParsedFile } from '../core/types';
import type { Src } from './bytes';
import type { Candidate } from './exif';

/** Shared parse state: parsers fill `out.exif` and push unvalidated JPEG candidates. */
export interface Ctx {
  src: Src;
  out: ParsedFile;
  cands: Candidate[];
}

export function addCand(ctx: Ctx, offset: number | undefined, length: number | undefined): void {
  if (!offset || !length || !(offset > 0) || !(length > 0)) return;
  if (offset + length > ctx.src.size + 4096) return; // allow slightly over-declared lengths
  if (ctx.cands.length >= 64) return;
  ctx.cands.push({ offset, length: Math.min(length, ctx.src.size - offset) });
}
