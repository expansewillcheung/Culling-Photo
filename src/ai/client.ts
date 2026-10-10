// Main-thread helper to spin up the AI worker.
import * as Comlink from 'comlink';
import type { AiWorkerApi, AnalyzeOptions, AnalyzeResult } from './ai.worker';

export type { AiWorkerApi, AnalyzeOptions, AnalyzeResult };

export interface AiWorkerHandle {
  api: Comlink.Remote<AiWorkerApi>;
  /** Transfers the bitmap to the worker (it is closed there). */
  analyze(bitmap: ImageBitmap, opts?: AnalyzeOptions): Promise<AnalyzeResult>;
  terminate(): void;
}

export function createAiWorker(): AiWorkerHandle {
  const worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module', name: 'ai' });
  const api = Comlink.wrap<AiWorkerApi>(worker);
  return {
    api,
    analyze: (bitmap, opts) => api.analyze(Comlink.transfer(bitmap, [bitmap]), opts),
    terminate: () => {
      api[Comlink.releaseProxy]();
      worker.terminate();
    },
  };
}
