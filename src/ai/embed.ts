// Best-effort CLIP image embeddings for semantic similarity (groupSimilar).
//
// @huggingface/transformers is not a dependency, so it is loaded at runtime
// from jsDelivr via a dynamic import that Vite leaves alone (@vite-ignore).
// jsDelivr sends `Access-Control-Allow-Origin: *` and
// `Cross-Origin-Resource-Policy: cross-origin`, so it loads under the app's
// COEP require-corp; onnxruntime-web's wasm is fetched from jsDelivr too, and
// model weights from huggingface.co (CORS-enabled). transformers.js caches the
// weights in Cache Storage ('transformers-cache') itself.
//
// Everything degrades to `null`: offline on first use, CDN blocked (CSP), or
// any runtime failure. Works on the main thread and in module workers.
import type { Pixels } from './pixels';

export const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm';
export const DEFAULT_EMBED_MODEL = 'Xenova/clip-vit-base-patch32';

export interface EmbedOptions {
  model?: string;
  /** 'wasm' (default, works everywhere) or 'webgpu' (faster when available). */
  device?: 'wasm' | 'webgpu';
  /** Weight precision (default 'q8': ~88 MB for ViT-B/32 vision tower). */
  dtype?: 'fp32' | 'fp16' | 'q8';
  /** Override the transformers.js module URL (e.g. self-hosted). */
  libraryUrl?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Embedder {
  processor: any;
  vision: any;
  RawImage: any;
}

let embedder: Promise<Embedder | null> | null = null;
let lastError: unknown = null;

export function embedLoadError(): unknown {
  return lastError;
}

export function loadEmbedder(opts: EmbedOptions = {}): Promise<Embedder | null> {
  if (embedder) return embedder;
  const p = (async (): Promise<Embedder | null> => {
    try {
      const url = opts.libraryUrl ?? TRANSFORMERS_URL;
      const tf: any = await import(/* @vite-ignore */ url);
      tf.env.allowLocalModels = false;
      tf.env.useBrowserCache = typeof caches !== 'undefined';
      const model = opts.model ?? DEFAULT_EMBED_MODEL;
      const processor = await tf.AutoProcessor.from_pretrained(model);
      const vision = await tf.CLIPVisionModelWithProjection.from_pretrained(model, {
        device: opts.device ?? 'wasm',
        dtype: opts.dtype ?? 'q8',
      });
      lastError = null;
      return { processor, vision, RawImage: tf.RawImage };
    } catch (e) {
      lastError = e;
      console.warn('[ai/embed] embeddings unavailable:', e);
      embedder = null; // retry on next call
      return null;
    }
  })();
  embedder = p;
  return p;
}

/**
 * L2-normalised CLIP image embedding (512-d for ViT-B/32), or null when the
 * model can't be loaded. Pass ~224–512px images (the processor resizes to 224).
 */
export async function embedImage(img: Pixels, opts: EmbedOptions = {}): Promise<Float32Array | null> {
  const e = await loadEmbedder(opts);
  if (!e) return null;
  try {
    const data = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data);
    const raw = new e.RawImage(data, img.width, img.height, 4).rgb();
    const inputs = await e.processor(raw);
    const { image_embeds } = await e.vision(inputs);
    const v = Float32Array.from(image_embeds.data as ArrayLike<number>);
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
    for (let i = 0; i < v.length; i++) v[i] *= inv;
    return v;
  } catch (err) {
    lastError = err;
    console.warn('[ai/embed] embed failed:', err);
    return null;
  }
}

export async function disposeEmbedder(): Promise<void> {
  const p = embedder;
  embedder = null;
  try {
    await (await p)?.vision?.dispose?.();
  } catch {
    /* ignore */
  }
}
