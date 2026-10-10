// Needs network on first run: face_landmarker.task (storage.googleapis.com) and a
// test portrait (MediaPipe's own test asset). Skips with a message when offline.
import { describe, expect, test } from 'vitest';
import { blobToImageData } from './browser-test-helpers';
import { detectFaces, FACE_MODEL_URL, faceLandmarks, faceLoadError, loadFaceLandmarker } from './faces';
import { isModelCached } from './model-cache';

const PORTRAIT_URL = 'https://storage.googleapis.com/mediapipe-assets/portrait.jpg';

async function tryFetch(url: string): Promise<Blob | null> {
  try {
    const r = await fetch(url);
    return r.ok ? await r.blob() : null;
  } catch {
    return null;
  }
}

// Subject-relative eye contours from the 468-point face mesh.
const EYE_RINGS = [
  [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
];
const LOWER_LIDS = [
  [33, 7, 163, 144, 145, 153, 154, 155, 133],
  [263, 249, 390, 373, 374, 380, 381, 382, 362],
];

/** Paints over both eyes with surrounding skin + a lash line → synthetic "eyes closed". */
function closeEyes(img: ImageData, pts: { x: number; y: number }[]): ImageData {
  const c = new OffscreenCanvas(img.width, img.height);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.putImageData(img, 0, 0);
  const P = (i: number) => ({ x: pts[i].x * img.width, y: pts[i].y * img.height });
  EYE_RINGS.forEach((ring, k) => {
    const ps = ring.map(P);
    const cx = ps.reduce((s, p) => s + p.x, 0) / ps.length;
    const cy = ps.reduce((s, p) => s + p.y, 0) / ps.length;
    const eh = Math.max(...ps.map((p) => p.y)) - Math.min(...ps.map((p) => p.y));
    const xs = ps.map((p) => p.x);
    const ew = Math.max(...xs) - Math.min(...xs);
    // Cover the eye with an ellipse of under-eye skin texture (copied from
    // below the eye), soft-edged via a radial alpha mask.
    const rw = ew * 0.75;
    const rh = Math.max(eh * 1.4, ew * 0.35);
    const src = new OffscreenCanvas(Math.ceil(2 * rw), Math.ceil(2 * rh));
    const sctx = src.getContext('2d')!;
    sctx.drawImage(c, cx - rw, cy - rh + rh * 1.9, 2 * rw, 2 * rh, 0, 0, 2 * rw, 2 * rh);
    const g = sctx.createRadialGradient(rw, rh, 0, rw, rh, rw);
    g.addColorStop(0.6, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    sctx.globalCompositeOperation = 'destination-in';
    sctx.setTransform(1, 0, 0, rh / rw, 0, rh - (rh * rh) / rw);
    sctx.fillStyle = g;
    sctx.fillRect(0, 0, 2 * rw, 2 * rw);
    ctx.drawImage(src, cx - rw, cy - rh);
    // closed-lid lash line along the lower lid
    ctx.save();
    ctx.strokeStyle = 'rgb(40,25,20)';
    ctx.lineWidth = Math.max(2, eh * 0.25);
    ctx.lineCap = 'round';
    ctx.beginPath();
    LOWER_LIDS[k].map(P).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.restore();
  });
  return ctx.getImageData(0, 0, img.width, img.height);
}

describe('detectFaces (MediaPipe FaceLandmarker, main thread)', () => {
  test('portrait: one face, eyes open; synthetic closed eyes detected', async (ctx) => {
    const portrait = await tryFetch(PORTRAIT_URL);
    if (!portrait) return ctx.skip('network unavailable: cannot download test portrait');
    const lm = await loadFaceLandmarker();
    if (!lm) return ctx.skip(`face model unavailable (offline?): ${String(faceLoadError())}`);
    expect(await isModelCached(FACE_MODEL_URL)).toBe(true);

    const img = await blobToImageData(portrait, 1024);
    const t0 = performance.now();
    const open = await detectFaces(img);
    const ms = performance.now() - t0;
    console.log('open eyes:', JSON.stringify(open), `${ms.toFixed(1)} ms`);
    expect(open).not.toBeNull();
    expect(open!.faceCount).toBe(1);
    expect(open!.eyesClosed).toBe(false);
    const f = open!.faces[0];
    expect(f.box.w).toBeGreaterThan(0.1);
    expect(f.box.x + f.box.w / 2).toBeGreaterThan(0.3);
    expect(f.box.x + f.box.w / 2).toBeLessThan(0.7);

    const pts = (await faceLandmarks(img))![0];
    const closed = await detectFaces(closeEyes(img, pts));
    console.log('synthetic closed eyes:', JSON.stringify(closed));
    expect(closed!.faceCount).toBe(1);
    expect(closed!.faces[0].blink.left).toBeGreaterThan(open!.faces[0].blink.left);
    expect(closed!.faces[0].blink.right).toBeGreaterThan(open!.faces[0].blink.right);
    expect(closed!.eyesClosed).toBe(true);

    // plain {data,width,height} input and a no-face image
    const plain = await detectFaces({ data: img.data, width: img.width, height: img.height });
    expect(plain!.faceCount).toBe(1);
    const blank = new ImageData(256, 256);
    expect((await detectFaces(blank))!.faceCount).toBe(0);
  }, 120_000);
});
