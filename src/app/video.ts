// At most two <video> elements decoding at once (phone folders can hold hundreds of clips).
let active = 0;
const waiters: (() => void)[] = [];
async function acquire() {
  if (active >= 2) await new Promise<void>((r) => waiters.push(r));
  active++;
}
function release() {
  active--;
  waiters.shift()?.();
}

/** Grab a poster frame from a video file on the main thread (workers can't use <video>). */
export async function videoThumb(file: File, maxEdge = 512): Promise<Blob | null> {
  await acquire();
  try {
    return await grab(file, maxEdge);
  } finally {
    release();
  }
}

async function grab(file: File, maxEdge: number): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = url;
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error('video load'));
      setTimeout(() => rej(new Error('video timeout')), 8000);
    });
    v.currentTime = Math.min(0.5, (v.duration || 1) / 3);
    await new Promise<void>((res) => {
      v.onseeked = () => res();
      setTimeout(res, 2000);
    });
    const s = Math.min(1, maxEdge / Math.max(v.videoWidth, v.videoHeight));
    const c = new OffscreenCanvas(Math.round(v.videoWidth * s) || 1, Math.round(v.videoHeight * s) || 1);
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    return await c.convertToBlob({ type: 'image/webp', quality: 0.8 });
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
