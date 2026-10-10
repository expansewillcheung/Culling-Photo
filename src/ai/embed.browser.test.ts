// Best-effort: downloads transformers.js from jsDelivr and CLIP weights (~90 MB)
// from huggingface.co on first run. Skips with a message when unavailable.
import { describe, expect, test } from 'vitest';
import {
  bitmapToImageData,
  blobToImageData,
  fixtureBlob,
  GEN_DIR,
  largestEmbeddedJpeg,
  RAW_DIR,
} from './browser-test-helpers';
import { embedImage, embedLoadError, loadEmbedder } from './embed';
import { cosineSim, groupSimilar } from './group';
import { gaussianBlur, scaleBrightness, shift } from './test-helpers';

describe('embedImage (CLIP via transformers.js CDN)', () => {
  test('near-duplicates are more similar than different scenes', async (ctx) => {
    const t0 = performance.now();
    const e = await loadEmbedder();
    if (!e) return ctx.skip(`embeddings unavailable: ${String(embedLoadError())}`);
    console.log(`embedder load: ${(performance.now() - t0).toFixed(0)} ms, crossOriginIsolated=${crossOriginIsolated}`);
    const a = await blobToImageData(await fixtureBlob(GEN_DIR + 'photo.jpg'));
    const a2 = scaleBrightness(shift(a, 10, 4), 1.1); // next burst frame: small pan + exposure change
    const other = await largestEmbeddedJpeg(
      await fixtureBlob(RAW_DIR + 'Sony___ILCE_7M3___14bit_14bit_compressed__3_2_.ARW'),
    );
    const b = await bitmapToImageData(other!);
    const t1 = performance.now();
    const ea = (await embedImage(a))!;
    console.log(`embed: ${(performance.now() - t1).toFixed(0)} ms (first)`);
    const t2 = performance.now();
    const ea2 = (await embedImage(a2))!;
    console.log(`embed: ${(performance.now() - t2).toFixed(0)} ms (warm)`);
    const eb = (await embedImage(b))!;
    expect(ea.length).toBe(512);
    const eBlur = (await embedImage(gaussianBlur(a, 1.5)))!;
    console.log(`cos(blurred σ1.5)=${cosineSim(ea, eBlur).toFixed(3)}`);
    const sDup = cosineSim(ea, ea2);
    const sDiff = cosineSim(ea, eb);
    console.log(`cos(dup)=${sDup.toFixed(3)} cos(diff)=${sDiff.toFixed(3)}`);
    expect(sDup).toBeGreaterThan(0.92);
    // unrelated photos still score ~0.75-0.8 with CLIP, so thresholds must be high
    expect(sDup).toBeGreaterThan(sDiff + 0.1);
    expect(
      groupSimilar(
        [
          { id: 1, embedding: ea },
          { id: 2, embedding: eb },
          { id: 3, embedding: ea2 },
        ],
        { threshold: 0.9 },
      ),
    ).toEqual([0, 1, 0]);
  }, 300_000);
});
