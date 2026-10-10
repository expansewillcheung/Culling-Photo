import type { Marks } from '../core/types';
import type { Photo } from '../store/types';
import { openDb, type DbClient, type PhotoInput, type PhotoRecord } from '../db';

/** What we restore for a photo from a previous session. */
export interface SavedPhoto {
  key: string;
  marks?: Marks;
  captureTime?: number;
  blurScore?: number;
  phash?: string;
  faceCount?: number;
  eyesClosed?: boolean;
}

export interface PersistAdapter {
  readonly persistent: boolean;
  open(rootName: string, fingerprint: string, files: Map<string, { size: number; mtime: number }>): Promise<Map<string, SavedPhoto>>;
  saveAll(photos: Photo[]): Promise<void>;
  saveMarks(photos: Photo[]): Promise<void>;
  close(): Promise<void>;
}

export class MemoryPersist implements PersistAdapter {
  readonly persistent = false;
  async open() {
    return new Map<string, SavedPhoto>();
  }
  async saveAll() {}
  async saveMarks() {}
  async close() {}
}

let dbPromise: Promise<DbClient> | undefined;
/** One DB connection per tab (the OPFS pool is exclusive), shared by all sessions. */
export function sharedDb(): Promise<DbClient> {
  if (!dbPromise) {
    dbPromise = openDb();
    dbPromise.catch(() => (dbPromise = undefined));
  }
  return dbPromise;
}

function toRecord(p: Photo): PhotoInput {
  return {
    key: p.key,
    dirRel: p.dirRel,
    basename: p.stem,
    files: p.item.files.map((f, i) => ({
      relPath: f.relPath,
      ext: f.name.split('.').pop()!.toLowerCase(),
      kind: p.kinds[i],
      size: f.size,
      mtime: f.lastModified,
      sidecarRelPath: p.item.sidecar?.relPath,
    })),
    captureTs: p.captureTime,
    camera: p.exif.model,
    lens: p.exif.lens,
    iso: p.exif.iso,
    shutter: p.exif.exposureTime,
    aperture: p.exif.fNumber,
    focal: p.exif.focalLength,
    width: p.exif.width,
    height: p.exif.height,
    orientation: p.exif.orientation,
    marks: { rating: p.rating, flag: p.flag, label: p.label },
    thumbState: p.thumbState === 'ready' ? 1 : p.thumbState === 'error' ? 2 : 0,
    blurScore: p.blurScore,
    phash: p.phash,
    groupId: p.groupId,
    eyesClosed: p.eyesClosed,
    faceCount: p.faceCount,
  };
}

/**
 * SQLite (OPFS) persistence. A folder is matched by name; if its contents changed since the
 * last visit, the most recent session for that name is used but marks are restored only for
 * photos whose files are byte-for-byte unchanged (same size + mtime). This keeps marks when a
 * few files are added, without applying an old shoot's marks to a reused card folder.
 */
export class SqlitePersist implements PersistAdapter {
  persistent = false;
  private db?: DbClient;
  private sessionId = '';

  async open(rootName: string, fingerprint: string, files: Map<string, { size: number; mtime: number }>) {
    const out = new Map<string, SavedPhoto>();
    const db = (this.db = await sharedDb());
    this.persistent = db.status.persistent;
    const { sessionId, isNew } = await db.openSession({ rootName, fingerprint });
    this.sessionId = sessionId;
    let records: PhotoRecord[] = [];
    let validate = false;
    if (!isNew) records = await db.loadSession(sessionId);
    else {
      const prev = (await db.listSessions())
        .filter((s) => s.rootName === rootName && s.id !== sessionId)
        .sort((a, b) => b.openedAt - a.openedAt)[0];
      if (prev) {
        records = await db.loadSession(prev.id);
        validate = true;
      }
    }
    for (const r of records) {
      if (validate && !r.files.every((f) => {
        const cur = files.get(f.relPath);
        return cur && cur.size === f.size && cur.mtime === f.mtime;
      })) continue;
      out.set(r.key, {
        key: r.key,
        marks: r.marks,
        captureTime: r.captureTs,
        blurScore: r.blurScore,
        phash: r.phash,
        faceCount: r.faceCount,
        eyesClosed: r.eyesClosed,
      });
    }
    return out;
  }

  async saveAll(photos: Photo[]) {
    if (!this.db || !this.sessionId) return;
    await this.db.upsertFiles(this.sessionId, photos.map(toRecord), { keepMarks: false, keepAi: false });
  }

  async saveMarks(photos: Photo[]) {
    if (!this.db || !this.sessionId) return;
    await this.db.setMarks(this.sessionId, photos.map((p) => ({ key: p.key, marks: { rating: p.rating, flag: p.flag, label: p.label } })));
  }

  async close() {
    // Keep the shared connection open for the next folder.
  }
}
