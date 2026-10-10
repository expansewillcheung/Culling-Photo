// RAW via libraw-wasm. The library runs LibRaw inside its *own* module worker
// (new Worker(new URL('./worker.js', import.meta.url), {type:'module'})), so calls never
// block the caller's thread. Calling it from our preview worker creates a nested
// dedicated worker, which Chrome supports. The build uses pthreads + shared WASM memory,
// so the page must be cross-origin isolated (COOP same-origin + COEP require-corp).
//
// Strategy (cheapest first):
//  1. LibRaw's embedded thumbnail, if it is at least as large as the requested size.
//  2. Half-size demosaic (4x fewer pixels, no interpolation) when maxEdge <= half the
//     sensor long edge.
//  3. Full demosaic.
import type LibRawType from 'libraw-wasm';
import type { LibRawSettings } from 'libraw-wasm';
import type { ParsedFile } from '../core/types';
import type { DecodeOptions } from './index';
import { finishBitmap, normOrientation } from './pixels';

type LibRawCtor = typeof LibRawType;

/** Dispose the LibRaw worker after this much idle time to give its WASM heap back. */
const IDLE_DISPOSE_MS = 20_000;

let ctorP: Promise<LibRawCtor> | null = null;
let inst: LibRawType | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
// LibRaw keeps per-instance state (open -> metadata -> imageData), so serialise decodes.
let queue: Promise<unknown> = Promise.resolve();

function getCtor(): Promise<LibRawCtor> {
  if (!ctorP) {
    ctorP = import('libraw-wasm').then((m) => m.default);
    ctorP.catch(() => (ctorP = null));
  }
  return ctorP;
}

async function getInstance(): Promise<LibRawType> {
  clearTimeout(idleTimer);
  if (!inst) {
    if (typeof SharedArrayBuffer === 'undefined' || (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === false) {
      throw new Error('libraw-wasm needs cross-origin isolation (COOP/COEP) for shared WASM memory');
    }
    const Ctor = await getCtor();
    inst = new Ctor();
  }
  return inst;
}

function scheduleDispose(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    inst?.dispose();
    inst = null;
  }, IDLE_DISPOSE_MS);
}

/** Free the LibRaw worker immediately (e.g. under memory pressure). */
export function disposeRaw(): void {
  clearTimeout(idleTimer);
  inst?.dispose();
  inst = null;
}

export async function init(): Promise<void> {
  const raw = await getInstance();
  // Any call waits for the worker's WASM runtime; metadata() before open() is harmless.
  await raw.metadata().catch(() => undefined);
  scheduleDispose();
}

/** LibRaw `flip` (0,3,5,6) -> EXIF orientation. */
export function flipToOrientation(flip: number | undefined): number {
  switch (flip) {
    case 3: return 3;
    case 5: return 8;
    case 6: return 6;
    default: return 1;
  }
}

/** EXIF orientation stored inside a JPEG (APP1/Exif IFD0 tag 0x0112), or 1. */
export function jpegOrientation(b: Uint8Array): number {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let p = 2;
  while (p + 4 < b.length && b[p] === 0xff) {
    const marker = b[p + 1];
    const len = (b[p + 2] << 8) | b[p + 3];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) {
      const t = p + 10;
      const le = b[t] === 0x49;
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const u16 = (o: number) => dv.getUint16(t + o, le);
      const u32 = (o: number) => dv.getUint32(t + o, le);
      const ifd = u32(4);
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (t + e + 12 > b.length) break;
        if (u16(e) === 0x0112) return normOrientation(u16(e + 8));
      }
      return 1;
    }
    p += 2 + len;
  }
  return 1;
}

function rgbToRgba(src: Uint8Array, w: number, h: number): ImageData {
  const out = new ImageData(w, h);
  const d = out.data;
  const n = w * h;
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 3, k += 4) {
    d[k] = src[j];
    d[k + 1] = src[j + 1];
    d[k + 2] = src[j + 2];
    d[k + 3] = 255;
  }
  return out;
}

function settings(halfSize: boolean): LibRawSettings {
  return {
    halfSize,
    useCameraWb: true, // as-shot WB, closest to the camera JPEG
    userFlip: 0, // never rotate in LibRaw: we rotate the (smaller) downscaled bitmap
    outputBps: 8,
    outputColor: 1, // sRGB
  };
}

async function decodeLocked(blob: Blob, parsed: ParsedFile, opts: DecodeOptions): Promise<ImageBitmap> {
  const raw = await getInstance();
  const maxEdge = opts.maxEdge && opts.maxEdge > 0 ? opts.maxEdge : undefined;
  const exifLong = Math.max(parsed.exif.width ?? 0, parsed.exif.height ?? 0) || undefined;
  // Choose half-size up front when we already know the sensor size.
  let half = !!(maxEdge && exifLong && maxEdge <= exifLong / 2);
  await raw.open(new Uint8Array(await blob.arrayBuffer()), settings(half));
  const meta = await raw.metadata();
  if (!meta) throw new Error('LibRaw: no metadata');
  const fullLong = Math.max(meta.width, meta.height);
  const orientation = normOrientation(parsed.exif.orientation ?? flipToOrientation(meta.flip as number | undefined));
  const target = maxEdge ? Math.min(maxEdge, fullLong) : fullLong;

  // 1. Embedded thumbnail via LibRaw (covers previews our container parser missed).
  const thumbW = Number(meta.thumb_width) || 0;
  const thumbH = Number(meta.thumb_height) || 0;
  if (opts.allowEmbedded !== false && Math.max(thumbW, thumbH) >= target * 0.95) {
    const th = await raw.thumbnailData().catch(() => undefined);
    if (th && th.format === 'jpeg') {
      // Chrome applies a JPEG's own EXIF orientation; only apply the RAW's if it has none.
      const own = jpegOrientation(th.data);
      const bmp = await createImageBitmap(new Blob([th.data as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
      return finishBitmap(bmp, bmp.width, bmp.height, own === 1 ? orientation : 1, maxEdge);
    }
    if (th && th.format === 'bitmap' && th.data.length >= th.width * th.height * 3) {
      return finishBitmap(rgbToRgba(th.data, th.width, th.height), th.width, th.height, orientation, maxEdge);
    }
  }

  // 2./3. Demosaic. Re-open in half-size mode if we only learned the size now.
  if (!half && maxEdge && maxEdge <= fullLong / 2) {
    half = true;
    await raw.open(new Uint8Array(await blob.arrayBuffer()), settings(true));
  }
  const img = await raw.imageData();
  if (!img) throw new Error('LibRaw: no image data');
  let data: ImageData;
  if (img.colors === 3 && img.bits === 8) data = rgbToRgba(img.data as Uint8Array, img.width, img.height);
  else throw new Error(`LibRaw: unexpected output ${img.colors}ch/${img.bits}bit`);
  return finishBitmap(data, img.width, img.height, orientation, maxEdge);
}

export function decode(blob: Blob, parsed: ParsedFile, opts: DecodeOptions): Promise<ImageBitmap> {
  const run = queue.then(
    () => decodeLocked(blob, parsed, opts),
    () => decodeLocked(blob, parsed, opts),
  );
  // After a failure LibRaw's state is suspect: drop the worker so the next decode starts fresh.
  queue = run.then(scheduleDispose, disposeRaw);
  return run;
}
