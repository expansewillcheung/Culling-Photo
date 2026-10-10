import { batch } from 'solid-js';
import { createAiWorker } from '../ai/client';
import { store } from '../store/store';
import { PRIORITY, type Session } from './session';

const { state, actions } = store;
let running = false;

/**
 * Background face / closed-eye pass over the current view (not-rejected photos first).
 * Uses a 1024px render per photo on the preview pool, then MediaPipe in the AI worker.
 */
export async function analyzeFaces(s: Session): Promise<void> {
  if (running) return;
  running = true;
  const ai = createAiWorker();
  const ids = store.viewIds().filter((id) => state.photos[id].flag !== -1 && state.photos[id].faceCount === undefined && state.photos[id].kinds[state.photos[id].display] !== 'video');
  actions.setState('progress', 'facesDone', 0);
  actions.toast(`正在分析 ${ids.length} 张照片的人脸（首次需要下载模型）…`, 4000);
  let done = 0;
  let failed = false;
  try {
    // Small pipeline: decode on the pool, detect serially in the AI worker.
    const CONCURRENCY = 2;
    let next = 0;
    const work = async () => {
      // Stop when the folder is closed/switched: ids would point at the next folder's photos.
      while (next < ids.length && !failed && !s.isDisposed) {
        const id = ids[next++];
        const p = state.photos[id];
        const entry = s.displayFile(p);
        try {
          const r = await s.pool.enqueue(
            `face:${id}`,
            PRIORITY.background + 5000,
            async (w) => {
              let parsed = s.parsedOf(id);
              if (!parsed) parsed = (await w.parseMany([{ file: entry.file, name: entry.name }]))[0].parsed;
              if (!parsed) throw new Error('unreadable');
              return w.render(entry.file, parsed, 1024);
            },
            s.laneFor(p),
          );
          const res = await ai.analyze(r.bitmap, { faces: true, maxEdge: 512, faceMaxEdge: 1024 });
          if (s.isDisposed) break;
          if (res.faces === null) {
            failed = true;
            actions.toast('人脸模型加载失败（需要联网下载一次），已停止分析', 5000);
            break;
          }
          batch(() => {
            actions.setState('photos', id, { faceCount: res.faces?.faceCount ?? 0, eyesClosed: !!res.faces?.eyesClosed });
            actions.setState('progress', 'facesDone', ++done);
          });
        } catch (e) {
          console.warn('face analysis failed', id, e);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, work));
  } finally {
    ai.terminate();
    running = false;
  }
  if (s.isDisposed) return;
  s.regroup();
  void s.persist.saveAll(state.photos).catch(() => {});
  if (!failed) {
    const closed = state.photos.filter((p) => p.eyesClosed).length;
    actions.toast(`人脸分析完成：${done} 张，${closed} 张可能闭眼`, 5000);
  }
}
