import { afterAll, describe, expect, test } from 'vitest';
import { analyzePixels } from './analyze';
import { blobToImageData, fixtureBlob, GEN_DIR } from './browser-test-helpers';
import { createAiWorker } from './client';
import { hamming, hashToHex, hexToHash } from './hash';

const ai = createAiWorker();
afterAll(() => ai.terminate());

describe('ai.worker (comlink, module worker)', () => {
  test('analyze() matches main-thread pure functions', async () => {
    const blob = await fixtureBlob(GEN_DIR + 'photo.jpg');
    const bmp = await createImageBitmap(blob);
    const r = await ai.analyze(bmp, { faces: false });
    console.log('worker analyze photo.jpg:', JSON.stringify(r));
    expect(r.width).toBe(512);
    expect(r.blurScore).toBeGreaterThan(1);
    expect(r.phash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.faces).toBeUndefined();
    // main thread (different resampler: createImageBitmap resize vs drawImage) — close, not identical
    const local = analyzePixels(await blobToImageData(blob, 512));
    expect(hamming(hexToHash(r.phash), local.phash)).toBeLessThanOrEqual(4);
    expect(r.blurScore / local.blurScore).toBeGreaterThan(0.5);
    expect(r.blurScore / local.blurScore).toBeLessThan(2);
    expect(Math.abs(r.exposure.mean - local.exposure.mean)).toBeLessThan(0.02);
    expect(hashToHex(local.phash)).toHaveLength(16);
  });

  test('faces in the worker (network on first use; skips offline)', async (ctx) => {
    let portrait: Blob | null = null;
    try {
      const res = await fetch('https://storage.googleapis.com/mediapipe-assets/portrait.jpg');
      portrait = res.ok ? await res.blob() : null;
    } catch {
      portrait = null;
    }
    if (!portrait) return ctx.skip('network unavailable: cannot download test portrait');
    if (!(await ai.api.warmupFaces())) return ctx.skip('face model unavailable in worker (offline?)');
    const r = await ai.analyze(await createImageBitmap(portrait), { faces: true });
    console.log('worker analyze portrait:', JSON.stringify(r));
    expect(r.faces).toBeTruthy();
    expect(r.faces!.faceCount).toBe(1);
    expect(r.faces!.eyesClosed).toBe(false);
    // throughput with model warm
    const bmps = await Promise.all(Array.from({ length: 5 }, () => createImageBitmap(portrait!)));
    const t0 = performance.now();
    for (const b of bmps) await ai.analyze(b, { faces: true });
    console.log(`worker analyze+faces: ${((performance.now() - t0) / 5).toFixed(1)} ms/image (820x1024)`);
  }, 120_000);

  test('embedding in the worker (best-effort; skips when CDN/HF unreachable)', async (ctx) => {
    if (!(await ai.api.warmupEmbed())) return ctx.skip('embeddings unavailable in worker');
    const blob = await fixtureBlob(GEN_DIR + 'photo.jpg');
    const r = await ai.analyze(await createImageBitmap(blob), { embed: true });
    expect(r.embedding).toBeInstanceOf(Float32Array);
    expect(r.embedding!.length).toBe(512);
    console.log(`worker analyze+embed: ${r.ms.toFixed(0)} ms`);
  }, 300_000);
});
