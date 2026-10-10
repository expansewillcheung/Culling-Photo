// Persistence types shared by the DB worker and its main-thread client.
// Everything here is structured-clone friendly (plain objects, no class instances).
import type { FileKind, Marks } from '../core/types';

/** 0 none / 1 synced / 2 pending write */
export type XmpState = 0 | 1 | 2;
/** 0 not processed / 1 generated / 2 failed */
export type ThumbState = 0 | 1 | 2;

/** One physical file belonging to a logical photo (RAW+JPEG pairs have two). */
export interface FileRecord {
  /** Path relative to the session root, '/'-separated, original case. */
  relPath: string;
  /** Lowercase extension without dot, e.g. 'cr3'. */
  ext: string;
  kind: FileKind;
  size: number;
  /** lastModified, ms */
  mtime: number;
  /** Existing sidecar found next to this file (relPath), if any. */
  sidecarRelPath?: string;
  previewOffset?: number;
  previewLength?: number;
  previewW?: number;
  previewH?: number;
  xmpState?: XmpState;
}

/** A logical photo (RAW+JPEG merged). `key` is stable: `${dirRel}/${basename}`.toLowerCase(). */
export interface PhotoRecord {
  key: string;
  /** Directory relative to root ('' for root), original case. */
  dirRel: string;
  /** File name without extension, original case. */
  basename: string;
  files: FileRecord[];

  /** Capture time (ms, see ExifInfo.captureTime) — sort key. */
  captureTs?: number;
  camera?: string;
  lens?: string;
  iso?: number;
  /** seconds */
  shutter?: number;
  aperture?: number;
  focal?: number;
  width?: number;
  height?: number;
  orientation?: number;

  marks: Marks;
  thumbState?: ThumbState;

  // AI fields (Phase 3); undefined = not computed.
  blurScore?: number;
  /** 64-bit perceptual hash as 16 lowercase hex chars. */
  phash?: string;
  groupId?: number;
  eyesClosed?: boolean;
  faceCount?: number;
}

/** Input row for upsertFiles: like PhotoRecord, but phash may be given as a bigint. */
export type PhotoInput = Omit<PhotoRecord, 'phash'> & { phash?: string | bigint };

export function photoKey(dirRel: string, basename: string): string {
  return `${dirRel}/${basename}`.toLowerCase();
}

export interface SessionInfo {
  id: string;
  rootName: string;
  fingerprint: string;
  createdAt: number;
  openedAt: number;
  photoCount: number;
  settings?: unknown;
}

export interface MarksUpdate {
  key: string;
  marks: Partial<Marks>;
}

/** `null` clears a field, `undefined`/absent leaves it unchanged. */
export interface AiFieldsUpdate {
  key: string;
  blurScore?: number | null;
  /** hex string or bigint (stored as 16-char hex) */
  phash?: string | bigint | null;
  groupId?: number | null;
  eyesClosed?: boolean | null;
  faceCount?: number | null;
}

export interface UpsertOptions {
  /** Keep marks already stored for existing keys (e.g. re-scan of a known folder). Default false. */
  keepMarks?: boolean;
  /** Keep AI fields already stored for existing keys. Default true. */
  keepAi?: boolean;
}

export interface HistoryEntry {
  /** Monotonic sequence inside a session (assigned by the DB when absent). */
  seq?: number;
  ts: number;
  cmd: unknown;
  undone?: boolean;
}

export interface DbStatus {
  /** true when data survives reloads (OPFS SAH pool); false = in-memory fallback. */
  persistent: boolean;
  vfs: 'opfs-sahpool' | 'memory';
  /** Why we fell back to memory, e.g. 'locked-by-other-tab', or an error message. */
  reason?: string;
  sqliteVersion: string;
}

export interface DbOptions {
  /**
   * Storage namespace: the OPFS directory of the SAH pool and the Web Lock name derive from it.
   * Default 'culling-photo'. Tests use unique names to isolate state.
   */
  name?: string;
  /** Force in-memory DB (e.g. read-only/demo mode). */
  memory?: boolean;
  /** If the pool is held by another tab, wait up to this many ms for it before falling back. Default 0. */
  lockTimeoutMs?: number;
}

/** API exposed by db.worker.ts (all calls async through comlink). */
export interface DbApi {
  init(opts?: DbOptions): Promise<DbStatus>;
  status(): DbStatus;
  openSession(args: { rootName: string; fingerprint: string }): { sessionId: string; isNew: boolean };
  listSessions(): SessionInfo[];
  deleteSession(id: string): void;
  setSessionSettings(id: string, settings: unknown): void;
  upsertFiles(sessionId: string, rows: PhotoInput[], opts?: UpsertOptions): { inserted: number; updated: number };
  deletePhotos(sessionId: string, keys: string[]): number;
  loadSession(sessionId: string): PhotoRecord[];
  setMarks(sessionId: string, updates: MarksUpdate[]): number;
  setAiFields(sessionId: string, updates: AiFieldsUpdate[]): number;
  setThumbState(sessionId: string, updates: { key: string; thumbState: ThumbState }[]): number;
  appendHistory(sessionId: string, entries: HistoryEntry[]): number[];
  /** Most recent `limit` entries, oldest first. */
  loadHistory(sessionId: string, limit?: number): HistoryEntry[];
  /** Delete entries with seq > afterSeq (redo branch discarded) — or all when omitted. */
  truncateHistory(sessionId: string, afterSeq?: number): void;
  setHistoryUndone(sessionId: string, seqs: number[], undone: boolean): void;
  close(): void;
}
