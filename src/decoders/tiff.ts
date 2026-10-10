// TIFF via utif2 (pure JS; pako for deflate). Decodes the largest full-resolution page.
import type { ParsedFile } from '../core/types';
import type { DecodeOptions } from './index';
import { finishBitmap, normOrientation, rgbaImageData } from './pixels';

type UTIFModule = typeof import('utif2');
type IFD = import('utif2').IFD;

let utifP: Promise<UTIFModule> | null = null;

function getUTIF(): Promise<UTIFModule> {
  if (!utifP) {
    utifP = import('utif2').then((m) => ((m as unknown as { default?: UTIFModule }).default ?? m) as UTIFModule);
    utifP.catch(() => (utifP = null));
  }
  return utifP;
}

export async function init(): Promise<void> {
  await getUTIF();
}

function tag(ifd: IFD, t: number): number | undefined {
  const v = ifd['t' + t] as number[] | undefined;
  return Array.isArray(v) ? (v[0] as number) : undefined;
}

/** All IFDs including SubIFDs (t330) and EXIF-linked ones utif exposes as `subIFD`. */
function allIfds(ifds: IFD[]): IFD[] {
  const out: IFD[] = [];
  const walk = (list: IFD[] | undefined) => {
    for (const ifd of list ?? []) {
      out.push(ifd);
      walk((ifd as unknown as { subIFD?: IFD[] }).subIFD);
    }
  };
  walk(ifds);
  return out;
}

/** Pick the largest image IFD that is not flagged as a reduced-resolution / mask page. */
export function pickPage(ifds: IFD[]): IFD | undefined {
  let best: IFD | undefined;
  let bestArea = 0;
  for (const ifd of allIfds(ifds)) {
    const w = tag(ifd, 256);
    const h = tag(ifd, 257);
    if (!w || !h) continue;
    const subfile = tag(ifd, 254) ?? 0;
    if (subfile & 0b101) continue; // reduced-resolution (bit0) or transparency mask (bit2)
    if (w * h > bestArea) {
      best = ifd;
      bestArea = w * h;
    }
  }
  return best;
}

export async function decode(blob: Blob, parsed: ParsedFile, opts: DecodeOptions): Promise<ImageBitmap> {
  const UTIF = await getUTIF();
  const buf = await blob.arrayBuffer();
  const ifds = UTIF.decode(buf);
  const page = pickPage(ifds);
  if (!page) throw new Error('TIFF: no image page');
  (UTIF.decodeImage as (b: ArrayBuffer, ifd: IFD, all?: IFD[]) => void)(buf, page, ifds);
  const w = page.width;
  const h = page.height;
  // toRGBA8 handles 1/8/16/32-bit, gray/RGB(A)/palette/CMYK; 16-bit is scaled down to 8.
  const rgba = UTIF.toRGBA8(page);
  (page as { data?: Uint8Array }).data = undefined; // drop the decoded strip buffer early
  const orientation = normOrientation(parsed.exif.orientation ?? tag(page, 274));
  return finishBitmap(rgbaImageData(rgba, w, h), w, h, orientation, opts.maxEdge);
}
