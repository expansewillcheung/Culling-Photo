// Face + blink detection via MediaPipe FaceLandmarker (lazy, worker-friendly).
//
// WASM: served from the installed @mediapipe/tasks-vision package through Vite
// `?url` asset imports (no config change, no copy to public/). In dev these are
// /node_modules/... URLs; in a build Vite emits them as hashed assets.
//
// Workers: MediaPipe loads its wasm loader with importScripts(), which throws
// in *module* workers; it then falls back to `import(url)`. The classic loader
// (vision_wasm_internal.js) only defines a script-scoped `var ModuleFactory`,
// so under import() it isn't global and init fails ("ModuleFactory not set").
// The package's ES-module loader (vision_wasm_module_internal.js) assigns
// `globalThis.ModuleFactory`, so we use that one when there's no `document`
// (any worker) and the classic one on the main thread (<script> tag injection).
//
// Model: face_landmarker.task (~3.7 MB) from storage.googleapis.com (CORS *,
// fine under COEP require-corp), cached in Cache Storage. CPU delegate by
// default: deterministic, no WebGL context needed in the worker.
import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import wasmClassicJs from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmClassicBin from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import wasmModuleJs from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import wasmModuleBin from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';
import { fetchModel } from './model-cache';
import type { Pixels } from './pixels';

export const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export interface FaceBox {
  /** Normalised 0..1 image coordinates (from landmark extents). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Face {
  box: FaceBox;
  /** Blendshape scores 0..1 (eyeBlinkLeft / eyeBlinkRight; "left" = subject's left). */
  blink: { left: number; right: number };
}

export interface FaceResult {
  faceCount: number;
  /** True if any detected face has both eyeBlink scores > blinkThreshold (0.5). */
  eyesClosed: boolean;
  faces: Face[];
}

export interface FaceOptions {
  modelUrl?: string;
  numFaces?: number;
  delegate?: 'CPU' | 'GPU';
  minFaceDetectionConfidence?: number;
}

export type FaceInput = Pixels | ImageData | ImageBitmap | OffscreenCanvas;

let landmarker: Promise<FaceLandmarker | null> | null = null;
let lastError: unknown = null;

/** Last load/inference error (for diagnostics), or null. */
export function faceLoadError(): unknown {
  return lastError;
}

function absolute(u: string): string {
  return new URL(u, self.location.href).href;
}

/**
 * Lazily creates the singleton FaceLandmarker. Resolves to null (and records
 * the error) when the wasm/model can't be loaded, e.g. offline on first use.
 * A failed load is retried on the next call.
 */
export function loadFaceLandmarker(opts: FaceOptions = {}): Promise<FaceLandmarker | null> {
  if (landmarker) return landmarker;
  const p = (async () => {
    try {
      const { FaceLandmarker } = await import('@mediapipe/tasks-vision');
      const inWorker = typeof document === 'undefined';
      const fileset = inWorker
        ? { wasmLoaderPath: absolute(wasmModuleJs), wasmBinaryPath: absolute(wasmModuleBin) }
        : { wasmLoaderPath: absolute(wasmClassicJs), wasmBinaryPath: absolute(wasmClassicBin) };
      const model = await fetchModel(opts.modelUrl ?? FACE_MODEL_URL);
      const lm = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: model, delegate: opts.delegate ?? 'CPU' },
        runningMode: 'IMAGE',
        numFaces: opts.numFaces ?? 8,
        minFaceDetectionConfidence: opts.minFaceDetectionConfidence ?? 0.5,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
      });
      lastError = null;
      return lm;
    } catch (e) {
      lastError = e;
      console.warn('[ai/faces] FaceLandmarker unavailable:', e);
      landmarker = null; // allow retry later
      return null;
    }
  })();
  landmarker = p;
  return p;
}

function toSource(img: FaceInput): ImageData | ImageBitmap | OffscreenCanvas {
  if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) return img;
  if (typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas) return img;
  if (typeof ImageData !== 'undefined' && img instanceof ImageData) return img;
  const p = img as Pixels;
  const data =
    p.data instanceof Uint8ClampedArray
      ? p.data
      : new Uint8ClampedArray(p.data.buffer, p.data.byteOffset, p.data.byteLength);
  return new ImageData(data as Uint8ClampedArray<ArrayBuffer>, p.width, p.height);
}

/**
 * Detect faces and closed eyes. Returns null when the model is unavailable or
 * inference fails. For group shots pass ≥1024px images; tiny faces (< ~40 px)
 * are missed or give unreliable blink scores.
 */
export async function detectFaces(
  img: FaceInput,
  opts: FaceOptions & { blinkThreshold?: number } = {},
): Promise<FaceResult | null> {
  const lm = await loadFaceLandmarker(opts);
  if (!lm) return null;
  const thr = opts.blinkThreshold ?? 0.5;
  try {
    const res = lm.detect(toSource(img));
    const faces: Face[] = res.faceLandmarks.map((pts, i) => {
      let x0 = 1;
      let y0 = 1;
      let x1 = 0;
      let y1 = 0;
      for (const p of pts) {
        if (p.x < x0) x0 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.x > x1) x1 = p.x;
        if (p.y > y1) y1 = p.y;
      }
      const cats = res.faceBlendshapes[i]?.categories ?? [];
      const score = (name: string) => cats.find((c) => c.categoryName === name)?.score ?? 0;
      return {
        box: {
          x: Math.max(0, x0),
          y: Math.max(0, y0),
          w: Math.max(0, Math.min(1, x1) - Math.max(0, x0)),
          h: Math.max(0, Math.min(1, y1) - Math.max(0, y0)),
        },
        blink: { left: score('eyeBlinkLeft'), right: score('eyeBlinkRight') },
      };
    });
    return {
      faceCount: faces.length,
      eyesClosed: faces.some((f) => f.blink.left > thr && f.blink.right > thr),
      faces,
    };
  } catch (e) {
    lastError = e;
    console.warn('[ai/faces] detect failed:', e);
    return null;
  }
}

/** Raw landmarks for tests/overlays (normalised coordinates), or null. */
export async function faceLandmarks(img: FaceInput): Promise<{ x: number; y: number }[][] | null> {
  const lm = await loadFaceLandmarker();
  if (!lm) return null;
  try {
    return lm.detect(toSource(img)).faceLandmarks.map((f) => f.map((p) => ({ x: p.x, y: p.y })));
  } catch {
    return null;
  }
}

/** Release the wasm graph (e.g. when the user disables AI). */
export async function disposeFaces(): Promise<void> {
  const p = landmarker;
  landmarker = null;
  (await p)?.close();
}
