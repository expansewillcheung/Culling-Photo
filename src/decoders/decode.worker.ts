// Tiny module worker used by browser tests to prove decodeFallback works off the main
// thread (same shape the preview worker pool will use).
import type { ParsedFile } from '../core/types';
import { decodeFallback, type DecodeOptions } from './index';

interface Req {
  id: number;
  blob: Blob;
  parsed: ParsedFile;
  opts: DecodeOptions;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, blob, parsed, opts } = e.data;
  const t0 = performance.now();
  try {
    const bmp = await decodeFallback(blob, parsed, opts);
    const ms = performance.now() - t0;
    (self as unknown as Worker).postMessage({ id, ms, bmp }, bmp ? [bmp] : []);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
