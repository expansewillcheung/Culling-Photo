// JPEG XL via @jsquash/jxl (single-threaded libjxl decoder, no SharedArrayBuffer needed).
// The .wasm is imported with `?url` so Vite emits it as a hashed asset in build and serves
// it from node_modules in dev; we hand that URL to emscripten via locateFile.
import type { ParsedFile } from '../core/types';
import type { DecodeOptions } from './index';
import { finishBitmap } from './pixels';

type DecodeFn = (buf: ArrayBuffer) => Promise<ImageData>;

let decP: Promise<DecodeFn> | null = null;

function getDecoder(): Promise<DecodeFn> {
  if (!decP) {
    decP = (async () => {
      const [mod, { default: wasmUrl }] = await Promise.all([
        import('@jsquash/jxl/decode.js'),
        import('@jsquash/jxl/codec/dec/jxl_dec.wasm?url'),
      ]);
      await mod.init({ locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path) } as never);
      return mod.default;
    })();
    decP.catch(() => (decP = null));
  }
  return decP;
}

export async function init(): Promise<void> {
  await getDecoder();
}

export async function decode(blob: Blob, _parsed: ParsedFile, opts: DecodeOptions): Promise<ImageBitmap> {
  const dec = await getDecoder();
  const img = await dec(await blob.arrayBuffer());
  // libjxl applies the codestream orientation itself (keep_orientation=false), so the
  // pixels are already display-oriented: do not apply EXIF orientation again.
  return finishBitmap(img, img.width, img.height, 1, opts.maxEdge);
}
