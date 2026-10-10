/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import type { ExifInfo, ParsedFile } from '../core/types';
import { blobReader } from '../core/types';
import { parseFile } from '../formats';
import { bitmapToImageData, decodeOriented } from '../pipeline/image';
import { cachePut } from '../cache/opfs';
import { blurScore, exposureStats, pHash } from '../ai';

export interface MetaResult {
  parsed: ParsedFile | null;
  error?: string;
}

export interface ThumbResult {
  ok: boolean;
  error?: string;
  width: number;
  height: number;
  /** Oriented size of the decoded source. */
  sourceWidth: number;
  sourceHeight: number;
  thumb?: Blob;
  blurScore?: number;
  phash?: string;
  exposure?: { mean: number; clippedHighlights: number; clippedShadows: number };
  histogram?: Uint32Array;
  ms: number;
}

const THUMB_EDGE = 512;

function histogram(img: ImageData): Uint32Array {
  // 256 bins x 4 (r,g,b,luma)
  const h = new Uint32Array(1024);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    h[r]++;
    h[256 + g]++;
    h[512 + b]++;
    h[768 + ((r * 54 + g * 183 + b * 19) >> 8)]++;
  }
  return h;
}

const api = {
  async parseMany(files: { file: File; name: string }[]): Promise<MetaResult[]> {
    return Promise.all(
      files.map(async ({ file, name }) => {
        try {
          return { parsed: await parseFile(blobReader(file), name) };
        } catch (e) {
          return { parsed: null, error: String(e) };
        }
      }),
    );
  },

  async thumb(file: File, parsed: ParsedFile, cacheNs: string, cacheName: string, analyze: boolean): Promise<ThumbResult> {
    const t0 = performance.now();
    try {
      const { bitmap, sourceWidth, sourceHeight } = await decodeOriented(file, parsed, THUMB_EDGE);
      const img = bitmapToImageData(bitmap, THUMB_EDGE);
      bitmap.close();
      const canvas = new OffscreenCanvas(img.width, img.height);
      canvas.getContext('2d')!.putImageData(img, 0, 0);
      const thumb = await canvas.convertToBlob({ type: 'image/webp', quality: 0.78 });
      const res: ThumbResult = { ok: true, width: img.width, height: img.height, sourceWidth, sourceHeight, thumb, ms: 0 };
      if (analyze) {
        try {
          res.blurScore = blurScore(img);
          res.phash = pHash(img).toString(16).padStart(16, '0');
          res.exposure = exposureStats(img);
        } catch {
          /* AI optional */
        }
      }
      res.histogram = histogram(img);
      await cachePut(cacheNs, cacheName, thumb).catch(() => {});
      res.ms = performance.now() - t0;
      return res;
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e), width: 0, height: 0, sourceWidth: 0, sourceHeight: 0, ms: performance.now() - t0 };
    }
  },

  /** Screen-size or full-size (maxEdge = 0) oriented bitmap for the loupe. */
  async render(file: File, parsed: ParsedFile, maxEdge: number): Promise<{ bitmap: ImageBitmap; sourceWidth: number; sourceHeight: number; source: string }> {
    const r = await decodeOriented(file, parsed, maxEdge);
    return Comlink.transfer(r, [r.bitmap]);
  },

  exif(parsed: ParsedFile): ExifInfo {
    return parsed.exif;
  },
};

export type PreviewApi = typeof api;
Comlink.expose(api);
