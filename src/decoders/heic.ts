// HEIC / HEIF via libheif-js. We use the ESM "wasm bundle" build: the .wasm is inlined
// (base64) in the JS, so there is no separate asset to locate, no node 'fs', and it works
// unchanged in a Vite module worker (dev + build). Cost: ~1.4 MB JS chunk, fetched lazily.
import type { ParsedFile } from '../core/types';
import type { DecodeOptions } from './index';
import type { LibHeif } from 'libheif-js/libheif-wasm/libheif-bundle.mjs';
import { finishBitmap } from './pixels';

let libP: Promise<LibHeif> | null = null;

function getLib(): Promise<LibHeif> {
  if (!libP) {
    libP = import('libheif-js/libheif-wasm/libheif-bundle.mjs').then(
      ({ default: factory }) =>
        new Promise<LibHeif>((resolve, reject) => {
          // The emscripten factory returns the Module synchronously but the WASM is
          // instantiated asynchronously: wait for onRuntimeInitialized.
          let mod: LibHeif | undefined;
          let initialised = false;
          mod = factory({
            onRuntimeInitialized: () => {
              initialised = true;
              // mod may still be unassigned if init completed synchronously.
              queueMicrotask(() => resolve(mod!));
            },
            onAbort: (what) => reject(new Error(`libheif abort: ${String(what)}`)),
          });
          if (initialised) resolve(mod);
        }),
    );
    libP.catch(() => (libP = null));
  }
  return libP;
}

export async function init(): Promise<void> {
  await getLib();
}

export async function decode(blob: Blob, _parsed: ParsedFile, opts: DecodeOptions): Promise<ImageBitmap> {
  const lib = await getLib();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const decoder = new lib.HeifDecoder();
  const images = decoder.decode(bytes);
  try {
    if (!images.length) throw new Error('HEIF: no images');
    const primary =
      images.find((im) => {
        try {
          return !!lib.heif_image_handle_is_primary_image?.(im.handle);
        } catch {
          return false;
        }
      }) ?? images[0];
    // Handle dimensions are *after* transformations; libheif's decode (no options)
    // applies irot/imir/clap itself, so the pixels come out display-oriented.
    const w = primary.get_width();
    const h = primary.get_height();
    const imageData = new ImageData(w, h);
    const out = await new Promise<typeof imageData | null>((resolve) => primary.display(imageData, (r) => resolve(r ? imageData : null)));
    if (!out) throw new Error('HEIF: decode failed');
    // Per HEIF spec, EXIF orientation must be ignored (irot/imir are authoritative and
    // already applied), so orientation = 1 here.
    return await finishBitmap(out, w, h, 1, opts.maxEdge);
  } finally {
    for (const im of images) im.free();
    if (decoder.decoder) {
      lib.heif_context_free(decoder.decoder);
      decoder.decoder = null;
    }
  }
}
