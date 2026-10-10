// SQL layer: schema + batched statements over an sqlite-wasm oo1 Database.
// Runs inside db.worker.ts (synchronous API); kept separate from the worker plumbing.
//
// Schema (adapted from PLAN.md §5) — the "hot" per-photo state lives in narrow tables so
// that rating 3000 photos dirties ~10 pages instead of the whole photo table (each dirty
// page = journal write + db write through the SAH pool):
//
//   session(sid INTEGER PK, id TEXT UNIQUE (uuid, public), root_name, fingerprint,
//           created_at, opened_at, settings_json)
//   photo  (id INTEGER PK, session → session.sid, key TEXT, UNIQUE(session, key),
//           dir_rel, basename, files_json, capture_ts, camera, lens, iso, shutter,
//           aperture, focal, width, height, orientation)          -- cold, written on scan
//   pstate (photo_id PK → photo.id, rating, flag, label INT code, thumb_state)  -- hot
//   ai     (photo_id PK → photo.id, blur_score, phash TEXT hex16, group_id,
//           eyes_closed, face_count)                               -- Phase 3
//   history(session, seq, ts, cmd_json, undone) WITHOUT ROWID      -- optional undo log
//
// Differences from PLAN §5: member files (PLAN's `file` table) are denormalised into
// photo.files_json (always read/written with the photo, no join on load); label is an int
// code (0 none, 1 red … 5 purple); embedding BLOB is not stored yet.
// Bulk paths: upsert uses one INSERT…SELECT FROM json_each(?) per table; load builds the
// whole result with json_group_array (one string across the WASM boundary, one JSON.parse).
import type { Database, PreparedStatement, SqlValue } from '@sqlite.org/sqlite-wasm';
import type { ColorLabel, Flag } from '../core/types';
import type {
  AiFieldsUpdate,
  FileRecord,
  HistoryEntry,
  MarksUpdate,
  PhotoInput,
  PhotoRecord,
  SessionInfo,
  ThumbState,
  UpsertOptions,
} from './types';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  sid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  root_name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  opened_at INTEGER NOT NULL,
  settings_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_fp ON session(root_name, fingerprint);

CREATE TABLE IF NOT EXISTS photo (
  id INTEGER PRIMARY KEY,
  session INTEGER NOT NULL,
  key TEXT NOT NULL,
  dir_rel TEXT NOT NULL,
  basename TEXT NOT NULL,
  files_json TEXT NOT NULL,
  capture_ts REAL,
  camera TEXT, lens TEXT,
  iso INTEGER, shutter REAL, aperture REAL, focal REAL,
  width INTEGER, height INTEGER, orientation INTEGER,
  UNIQUE (session, key)
);
CREATE INDEX IF NOT EXISTS idx_photo_sort ON photo(session, capture_ts);

CREATE TABLE IF NOT EXISTS pstate (
  photo_id INTEGER PRIMARY KEY,
  rating INTEGER NOT NULL DEFAULT 0,
  flag INTEGER NOT NULL DEFAULT 0,
  label INTEGER NOT NULL DEFAULT 0,
  thumb_state INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ai (
  photo_id INTEGER PRIMARY KEY,
  blur_score REAL, phash TEXT, group_id INTEGER, eyes_closed INTEGER, face_count INTEGER
);

CREATE TABLE IF NOT EXISTS history (
  session INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  cmd_json TEXT NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session, seq)
) WITHOUT ROWID;
`;

const LABELS: readonly ColorLabel[] = ['', 'red', 'yellow', 'green', 'blue', 'purple'];

function clampRating(r: unknown): number | null {
  if (typeof r !== 'number' || !Number.isFinite(r)) return null;
  return Math.max(0, Math.min(5, Math.round(r)));
}
function normFlag(f: unknown): Flag | null {
  return f === 1 || f === -1 || f === 0 ? f : null;
}
function labelCode(l: unknown): number | null {
  const i = typeof l === 'string' ? LABELS.indexOf(l as ColorLabel) : -1;
  return i < 0 ? null : i;
}
/** JSON-safe number or null. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function phashToHex(v: string | bigint): string {
  if (typeof v === 'bigint') return BigInt.asUintN(64, v).toString(16).padStart(16, '0');
  const h = v.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{1,16}$/.test(h)) throw new Error(`invalid phash: ${v}`);
  return h.padStart(16, '0');
}

export class Store {
  private stmts = new Map<string, PreparedStatement>();
  private sids = new Map<string, number>();

  constructor(readonly db: Database) {
    db.exec('PRAGMA journal_mode = TRUNCATE; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -16000;');
    db.transaction(() => {
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  private stmt(sql: string): PreparedStatement {
    let st = this.stmts.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.stmts.set(sql, st);
    }
    return st;
  }

  /** Run a cached statement once; returns sqlite3_changes(). */
  private run(sql: string, bind: SqlValue[]): number {
    const st = this.stmt(sql);
    try {
      st.bind(bind).step();
    } finally {
      st.reset();
    }
    return this.db.changes() as number;
  }

  close(): void {
    for (const st of this.stmts.values()) st.finalize();
    this.stmts.clear();
    this.db.close();
  }

  /** Internal integer id of a session (throws for unknown ids). */
  private sid(id: string): number {
    let sid = this.sids.get(id);
    if (sid === undefined) {
      const v = this.db.selectValue('SELECT sid FROM session WHERE id = ?', [id]);
      if (v === undefined || v === null) throw new Error(`unknown session ${id}`);
      sid = Number(v);
      this.sids.set(id, sid);
    }
    return sid;
  }

  // ------------------------------------------------------------ sessions

  openSession(rootName: string, fingerprint: string): { sessionId: string; isNew: boolean } {
    const now = Date.now();
    const id = this.db.selectValue(
      'SELECT id FROM session WHERE root_name = ? AND fingerprint = ? ORDER BY opened_at DESC LIMIT 1',
      [rootName, fingerprint],
    );
    if (typeof id === 'string') {
      this.db.exec({ sql: 'UPDATE session SET opened_at = ? WHERE id = ?', bind: [now, id] });
      return { sessionId: id, isNew: false };
    }
    const sessionId = crypto.randomUUID();
    this.db.exec({
      sql: 'INSERT INTO session (id, root_name, fingerprint, created_at, opened_at) VALUES (?, ?, ?, ?, ?)',
      bind: [sessionId, rootName, fingerprint, now, now],
    });
    return { sessionId, isNew: true };
  }

  listSessions(): SessionInfo[] {
    const rows = this.db.selectArrays(
      `SELECT s.id, s.root_name, s.fingerprint, s.created_at, s.opened_at, s.settings_json,
              (SELECT COUNT(*) FROM photo p WHERE p.session = s.sid)
       FROM session s ORDER BY s.opened_at DESC`,
    );
    return rows.map((r) => ({
      id: String(r[0]),
      rootName: String(r[1]),
      fingerprint: String(r[2]),
      createdAt: Number(r[3]),
      openedAt: Number(r[4]),
      settings: r[5] === null ? undefined : JSON.parse(String(r[5])),
      photoCount: Number(r[6]),
    }));
  }

  deleteSession(id: string): void {
    const v = this.db.selectValue('SELECT sid FROM session WHERE id = ?', [id]);
    if (v === undefined || v === null) return;
    const sid = Number(v);
    this.db.transaction(() => {
      this.db.exec({ sql: 'DELETE FROM pstate WHERE photo_id IN (SELECT id FROM photo WHERE session = ?)', bind: [sid] });
      this.db.exec({ sql: 'DELETE FROM ai WHERE photo_id IN (SELECT id FROM photo WHERE session = ?)', bind: [sid] });
      this.db.exec({ sql: 'DELETE FROM photo WHERE session = ?', bind: [sid] });
      this.db.exec({ sql: 'DELETE FROM history WHERE session = ?', bind: [sid] });
      this.db.exec({ sql: 'DELETE FROM session WHERE sid = ?', bind: [sid] });
    });
    this.sids.delete(id);
  }

  setSessionSettings(id: string, settings: unknown): void {
    this.db.exec({ sql: 'UPDATE session SET settings_json = ? WHERE sid = ?', bind: [JSON.stringify(settings ?? null), this.sid(id)] });
  }

  private countPhotos(sid: number): number {
    return Number(this.db.selectValue('SELECT COUNT(*) FROM photo WHERE session = ?', [sid]) ?? 0);
  }

  // ------------------------------------------------------------ photos

  upsertFiles(sessionId: string, rows: PhotoInput[], opts: UpsertOptions = {}): { inserted: number; updated: number } {
    const sid = this.sid(sessionId);
    const keepMarks = opts.keepMarks ? 1 : 0;
    const keepAi = opts.keepAi === false ? 0 : 1;
    // Positional JSON rows: one string crosses into WASM, SQLite does the rest.
    const payload = JSON.stringify(
      rows.map((r) => {
        const m = r.marks ?? { rating: 0, flag: 0, label: '' };
        return [
          r.key, r.dirRel, r.basename, JSON.stringify(r.files ?? []),
          num(r.captureTs), str(r.camera), str(r.lens), num(r.iso), num(r.shutter), num(r.aperture), num(r.focal),
          num(r.width), num(r.height), num(r.orientation),
          clampRating(m.rating) ?? 0, normFlag(m.flag) ?? 0, labelCode(m.label) ?? 0, r.thumbState ?? 0,
          num(r.blurScore), r.phash === undefined ? null : phashToHex(r.phash), num(r.groupId),
          r.eyesClosed === undefined ? null : r.eyesClosed ? 1 : 0, num(r.faceCount),
        ];
      }),
    );
    const before = this.countPhotos(sid);
    this.db.transaction(() => {
      this.db.exec({
        sql: `INSERT INTO photo (session, key, dir_rel, basename, files_json, capture_ts, camera, lens, iso,
                                 shutter, aperture, focal, width, height, orientation)
          SELECT ?1, j.value->>0, j.value->>1, j.value->>2, j.value->>3, j.value->>4, j.value->>5, j.value->>6,
                 j.value->>7, j.value->>8, j.value->>9, j.value->>10, j.value->>11, j.value->>12, j.value->>13
          FROM json_each(?2) AS j WHERE true
          ON CONFLICT (session, key) DO UPDATE SET
            dir_rel = excluded.dir_rel, basename = excluded.basename, files_json = excluded.files_json,
            capture_ts = excluded.capture_ts, camera = excluded.camera, lens = excluded.lens, iso = excluded.iso,
            shutter = excluded.shutter, aperture = excluded.aperture, focal = excluded.focal,
            width = excluded.width, height = excluded.height, orientation = excluded.orientation`,
        bind: [sid, payload],
      });
      this.db.exec({
        sql: `INSERT INTO pstate (photo_id, rating, flag, label, thumb_state)
          SELECT p.id, j.value->>14, j.value->>15, j.value->>16, j.value->>17
          FROM json_each(?2) AS j CROSS JOIN photo AS p ON p.session = ?1 AND p.key = j.value->>0 WHERE true
          ON CONFLICT (photo_id) DO UPDATE SET
            rating = CASE WHEN ?3 THEN rating ELSE excluded.rating END,
            flag = CASE WHEN ?3 THEN flag ELSE excluded.flag END,
            label = CASE WHEN ?3 THEN label ELSE excluded.label END,
            thumb_state = excluded.thumb_state`,
        bind: [sid, payload, keepMarks],
      });
      this.db.exec({
        sql: `INSERT INTO ai (photo_id, blur_score, phash, group_id, eyes_closed, face_count)
          SELECT p.id, j.value->>18, j.value->>19, j.value->>20, j.value->>21, j.value->>22
          FROM json_each(?2) AS j CROSS JOIN photo AS p ON p.session = ?1 AND p.key = j.value->>0 WHERE true
          ON CONFLICT (photo_id) DO UPDATE SET
            blur_score = CASE WHEN ?3 THEN COALESCE(excluded.blur_score, blur_score) ELSE excluded.blur_score END,
            phash = CASE WHEN ?3 THEN COALESCE(excluded.phash, phash) ELSE excluded.phash END,
            group_id = CASE WHEN ?3 THEN COALESCE(excluded.group_id, group_id) ELSE excluded.group_id END,
            eyes_closed = CASE WHEN ?3 THEN COALESCE(excluded.eyes_closed, eyes_closed) ELSE excluded.eyes_closed END,
            face_count = CASE WHEN ?3 THEN COALESCE(excluded.face_count, face_count) ELSE excluded.face_count END`,
        bind: [sid, payload, keepAi],
      });
    });
    const inserted = this.countPhotos(sid) - before;
    return { inserted, updated: rows.length - inserted };
  }

  deletePhotos(sessionId: string, keys: string[]): number {
    const sid = this.sid(sessionId);
    const payload = JSON.stringify(keys);
    let total = 0;
    this.db.transaction(() => {
      const ids = `SELECT p.id FROM json_each(?2) AS j CROSS JOIN photo AS p ON p.session = ?1 AND p.key = j.value`;
      this.db.exec({ sql: `DELETE FROM pstate WHERE photo_id IN (${ids})`, bind: [sid, payload] });
      this.db.exec({ sql: `DELETE FROM ai WHERE photo_id IN (${ids})`, bind: [sid, payload] });
      this.db.exec({ sql: `DELETE FROM photo WHERE id IN (${ids})`, bind: [sid, payload] });
      total = this.db.changes() as number;
    });
    return total;
  }

  loadSession(sessionId: string): PhotoRecord[] {
    const sid = this.sids.get(sessionId) ?? Number(this.db.selectValue('SELECT sid FROM session WHERE id = ?', [sessionId]) ?? -1);
    const json = this.db.selectValue(
      `SELECT json_group_array(json_array(
          p.key, p.dir_rel, p.basename, json(p.files_json), p.capture_ts, p.camera, p.lens, p.iso, p.shutter,
          p.aperture, p.focal, p.width, p.height, p.orientation,
          s.rating, s.flag, s.label, s.thumb_state,
          a.blur_score, a.phash, a.group_id, a.eyes_closed, a.face_count) ORDER BY p.capture_ts, p.key)
       FROM photo AS p LEFT JOIN pstate AS s ON s.photo_id = p.id LEFT JOIN ai AS a ON a.photo_id = p.id
       WHERE p.session = ?`,
      [sid],
    );
    const rows = JSON.parse(typeof json === 'string' ? json : '[]') as unknown[][];
    const out: PhotoRecord[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const p: PhotoRecord = {
        key: r[0] as string,
        dirRel: r[1] as string,
        basename: r[2] as string,
        files: r[3] as FileRecord[],
        marks: { rating: (r[14] as number) ?? 0, flag: ((r[15] as number) ?? 0) as Flag, label: LABELS[(r[16] as number) ?? 0] ?? '' },
        thumbState: ((r[17] as number) ?? 0) as ThumbState,
      };
      if (r[4] !== null) p.captureTs = r[4] as number;
      if (r[5] !== null) p.camera = r[5] as string;
      if (r[6] !== null) p.lens = r[6] as string;
      if (r[7] !== null) p.iso = r[7] as number;
      if (r[8] !== null) p.shutter = r[8] as number;
      if (r[9] !== null) p.aperture = r[9] as number;
      if (r[10] !== null) p.focal = r[10] as number;
      if (r[11] !== null) p.width = r[11] as number;
      if (r[12] !== null) p.height = r[12] as number;
      if (r[13] !== null) p.orientation = r[13] as number;
      if (r[18] !== null) p.blurScore = r[18] as number;
      if (r[19] !== null) p.phash = r[19] as string;
      if (r[20] !== null) p.groupId = r[20] as number;
      if (r[21] !== null) p.eyesClosed = r[21] !== 0;
      if (r[22] !== null) p.faceCount = r[22] as number;
      out[i] = p;
    }
    return out;
  }

  /**
   * One-statement bulk UPDATE: `rows` are JSON objects {k: key, …fields}; a field that is
   * absent stays unchanged, JSON null sets NULL. Duplicate keys: last one wins.
   * (MATERIALIZED + CROSS JOIN pin the plan to: scan input → index lookup → rowid update;
   * without them SQLite picks a full scan of the target with json_each in the inner loop.)
   */
  private bulkUpdate(table: 'pstate' | 'ai', sid: number, rows: Map<string, Record<string, unknown>>, cols: Record<string, string>): number {
    if (rows.size === 0) return 0;
    const payload = JSON.stringify([...rows.values()]);
    const set = Object.entries(cols)
      .map(([col, f]) => `${col} = CASE WHEN json_type(u.v, '$.${f}') IS NULL THEN ${col} ELSE u.v->>'${f}' END`)
      .join(',\n        ');
    let changes = 0;
    this.db.transaction(() => {
      this.db.exec({
        sql: `WITH u AS MATERIALIZED (
            SELECT p.id AS pid, j.value AS v FROM json_each(?2) AS j
            CROSS JOIN photo AS p ON p.session = ?1 AND p.key = j.value->>'k')
          UPDATE ${table} SET
            ${set}
          FROM u WHERE ${table}.photo_id = u.pid`,
        bind: [sid, payload],
      });
      changes = this.db.changes() as number;
    });
    return changes;
  }

  setMarks(sessionId: string, updates: MarksUpdate[]): number {
    const sid = this.sid(sessionId);
    const rows = new Map<string, Record<string, unknown>>();
    for (const { key, marks } of updates) {
      const o: Record<string, unknown> = rows.get(key) ?? { k: key };
      const r = clampRating(marks?.rating);
      const f = normFlag(marks?.flag);
      const l = labelCode(marks?.label);
      if (r !== null) o.r = r;
      if (f !== null) o.f = f;
      if (l !== null) o.l = l;
      rows.set(key, o);
    }
    return this.bulkUpdate('pstate', sid, rows, { rating: 'r', flag: 'f', label: 'l' });
  }

  setAiFields(sessionId: string, updates: AiFieldsUpdate[]): number {
    const sid = this.sid(sessionId);
    const rows = new Map<string, Record<string, unknown>>();
    for (const up of updates) {
      const o: Record<string, unknown> = rows.get(up.key) ?? { k: up.key };
      if (up.blurScore !== undefined) o.b = num(up.blurScore);
      if (up.phash !== undefined) o.h = up.phash === null ? null : phashToHex(up.phash);
      if (up.groupId !== undefined) o.g = num(up.groupId);
      if (up.eyesClosed !== undefined) o.e = up.eyesClosed === null ? null : up.eyesClosed ? 1 : 0;
      if (up.faceCount !== undefined) o.c = num(up.faceCount);
      rows.set(up.key, o);
    }
    return this.bulkUpdate('ai', sid, rows, { blur_score: 'b', phash: 'h', group_id: 'g', eyes_closed: 'e', face_count: 'c' });
  }

  setThumbState(sessionId: string, updates: { key: string; thumbState: ThumbState }[]): number {
    const sid = this.sid(sessionId);
    const rows = new Map<string, Record<string, unknown>>();
    for (const up of updates) if (up.thumbState === 0 || up.thumbState === 1 || up.thumbState === 2) rows.set(up.key, { k: up.key, t: up.thumbState });
    return this.bulkUpdate('pstate', sid, rows, { thumb_state: 't' });
  }

  // ------------------------------------------------------------ history

  appendHistory(sessionId: string, entries: HistoryEntry[]): number[] {
    const sid = this.sid(sessionId);
    const seqs: number[] = [];
    this.db.transaction(() => {
      let next = Number(this.db.selectValue('SELECT COALESCE(MAX(seq), 0) FROM history WHERE session = ?', [sid])) + 1;
      for (const e of entries) {
        const seq = e.seq ?? next;
        next = Math.max(next, seq) + 1;
        this.run('INSERT OR REPLACE INTO history (session, seq, ts, cmd_json, undone) VALUES (?, ?, ?, ?, ?)', [
          sid,
          seq,
          e.ts,
          JSON.stringify(e.cmd ?? null),
          e.undone ? 1 : 0,
        ]);
        seqs.push(seq);
      }
    });
    return seqs;
  }

  loadHistory(sessionId: string, limit = 10_000): HistoryEntry[] {
    const rows = this.db.selectArrays(
      'SELECT seq, ts, cmd_json, undone FROM (SELECT * FROM history WHERE session = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq',
      [this.sid(sessionId), limit],
    );
    return rows.map((r) => ({ seq: Number(r[0]), ts: Number(r[1]), cmd: JSON.parse(String(r[2])), undone: r[3] !== 0 }));
  }

  truncateHistory(sessionId: string, afterSeq?: number): void {
    this.db.exec({ sql: 'DELETE FROM history WHERE session = ? AND seq > ?', bind: [this.sid(sessionId), afterSeq ?? -1] });
  }

  setHistoryUndone(sessionId: string, seqs: number[], undone: boolean): void {
    const sid = this.sid(sessionId);
    this.db.transaction(() => {
      for (const seq of seqs) this.run('UPDATE history SET undone = ? WHERE session = ? AND seq = ?', [undone ? 1 : 0, sid, seq]);
    });
  }
}
