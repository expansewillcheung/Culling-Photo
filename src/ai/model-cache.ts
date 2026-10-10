/** Cache Storage bucket for downloaded model files (shared by main thread and workers). */
export const MODEL_CACHE = 'culling-ai-models-v1';

/**
 * Fetch a (large, immutable) model file, caching the response in Cache Storage.
 * Works in windows and workers (secure contexts). Falls back to a plain fetch
 * when Cache Storage is unavailable. Throws on network/HTTP failure.
 */
export async function fetchModel(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  let cache: Cache | undefined;
  try {
    cache = typeof caches !== 'undefined' ? await caches.open(MODEL_CACHE) : undefined;
  } catch {
    cache = undefined;
  }
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) return new Uint8Array(await hit.arrayBuffer());
    } catch {
      /* corrupted entry: refetch */
    }
  }
  const res = await fetch(url, { mode: 'cors', credentials: 'omit', signal });
  if (!res.ok) throw new Error(`model fetch ${url}: HTTP ${res.status}`);
  const buf = await res.clone().arrayBuffer();
  if (cache) {
    try {
      await cache.put(url, res);
    } catch {
      /* quota etc. — non-fatal */
    }
  }
  return new Uint8Array(buf);
}

/** True when `url` is already in the model cache (no network). */
export async function isModelCached(url: string): Promise<boolean> {
  try {
    if (typeof caches === 'undefined') return false;
    return !!(await (await caches.open(MODEL_CACHE)).match(url));
  } catch {
    return false;
  }
}
