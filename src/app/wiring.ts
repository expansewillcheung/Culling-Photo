import type { FileSource } from '../fs/FileSource';
import { parseXmp } from '../formats/xmp';
import { writeSidecars } from '../export';
import { store } from '../store/store';
import type { Session } from './session';
import { MemoryPersist, SqlitePersist } from './persist';

const { state, actions } = store;

/** Connect persistence (SQLite) and XMP sidecar IO to a session. */
export async function wireSession(s: Session, source: FileSource): Promise<void> {
  // Read-only mode also remembers marks in the DB (keyed by folder name + file stats).
  s.persist = typeof Worker !== 'undefined' ? new SqlitePersist() : new MemoryPersist();

  s.hooks.readSidecar = async (entry) => {
    const text = await entry.file.text();
    const m = parseXmp(text);
    return Object.keys(m).length ? m : null;
  };

  // Photos that have (or had) a sidecar: unmarking them must update the file too.
  const hasSidecar = new Set<number>();
  s.hooks.afterOpen = () => {
    for (const p of state.photos) if (p.item.sidecar) hasSidecar.add(p.id);
  };

  let writing: Promise<unknown> = Promise.resolve();
  s.onDirtyMarks = (ids) => {
    const root = source.root;
    if (!root || !source.writable || !state.settings.writeXmp) return;
    const items = ids
      .map((id) => state.photos[id])
      .filter((p) => p && (p.rating || p.flag || p.label || hasSidecar.has(p.id)))
      .map((p) => {
        hasSidecar.add(p.id);
        const primary = p.item.rawIndex >= 0 ? p.item.files[p.item.rawIndex] : p.item.files[0];
        return { relPath: primary.relPath, marks: { rating: p.rating, flag: p.flag, label: p.label } };
      });
    if (!items.length) return;
    writing = writing
      .then(() => writeSidecars(root, items))
      .then((res) => {
        const errors = res.filter((r) => r.status === 'error');
        if (errors.length) actions.toast(`XMP 写入失败 ${errors.length} 个：${errors[0].error}`, 5000);
      })
      .catch((e) => actions.toast(`XMP 写入失败：${(e as Error).message}`, 5000));
  };
}
