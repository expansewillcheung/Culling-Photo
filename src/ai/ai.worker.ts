/// <reference lib="webworker" />
// Module worker exposing the AI analysis via comlink. Create with
// `createAiWorker()` from ./client (new Worker(new URL(...), {type:'module'})).
import * as Comlink from 'comlink';
import { analyzePixels } from './analyze';
import type { ExposureStats } from './blur';
import { embedImage, loadEmbedder } from './embed';
import { detectFaces, type FaceResult, loadFaceLandmarker } from './faces';
import { hashToHex } from './hash';

export interface AnalyzeOptions {
  /** Run the face/blink model (downloads ~3.7 MB once). */
  faces?: boolean;
  /** Long edge for the pure metrics (default 512 — thresholds are calibrated for it). */
  maxEdge?: number;
  /** Long edge for face detection (default 1024; faces need more pixels). */
  faceMaxEdge?: number;
  /** Compute a CLIP embedding (best-effort; downloads transformers.js + ~90 MB weights once). */
  embed?: boolean;
  /** Close the bitmap after use (default true; it's usually transferred to us). */
  close?: boolean;
}

export interface AnalyzeResult {
  width: number;
  height: number;
  blurScore: number;
  /** pHash as 16-char hex (bigint survives structured clone, hex is DB-friendly). */
  phash: string;
  dhash: string;
  exposure: ExposureStats;
  /** Present when opts.faces; null when the model is unavailable. */
  faces?: FaceResult | null;
  /** Present when opts.embed; L2-normalised, null when unavailable. */
  embedding?: Float32Array | null;
  ms: number;
}

function drawScaled(bmp: ImageBitmap, maxEdge: number): OffscreenCanvas {
  const s = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('OffscreenCanvas 2d unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  return c;
}

const api = {
  async analyze(bitmap: ImageBitmap, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
    const t0 = performance.now();
    try {
      const c = drawScaled(bitmap, opts.maxEdge ?? 512);
      const img = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
      const a = analyzePixels(img);
      const out: AnalyzeResult = {
        width: img.width,
        height: img.height,
        blurScore: a.blurScore,
        phash: hashToHex(a.phash),
        dhash: hashToHex(a.dhash),
        exposure: a.exposure,
        ms: 0,
      };
      if (opts.faces) {
        const fEdge = opts.faceMaxEdge ?? 1024;
        const small = Math.max(c.width, c.height);
        const src = Math.max(bitmap.width, bitmap.height) > small && fEdge > small ? drawScaled(bitmap, fEdge) : c;
        out.faces = await detectFaces(src);
      }
      if (opts.embed) out.embedding = await embedImage(img);
      out.ms = performance.now() - t0;
      return out;
    } finally {
      if (opts.close !== false) bitmap.close();
    }
  },
  /** Preload the face model; resolves true when usable. */
  async warmupFaces(): Promise<boolean> {
    return (await loadFaceLandmarker()) !== null;
  },
  /** Preload the embedding model; resolves true when usable. */
  async warmupEmbed(): Promise<boolean> {
    return (await loadEmbedder()) !== null;
  },
};

export type AiWorkerApi = typeof api;

Comlink.expose(api);
