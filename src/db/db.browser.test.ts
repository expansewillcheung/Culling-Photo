import { afterAll, describe, expect, test } from 'vitest';
import { openDb, type DbClient } from './client';
import { photoKey, type PhotoInput, type PhotoRecord } from './types';

// Unique namespace per run so tests don't see each other's OPFS data.
const NAME = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function makePhotos(n: number): PhotoRecord[] {
  const out: PhotoRecord[] = [];
  for (let i = 0; i < n; i++) {
    const basename = `IMG_${String(i).padStart(4, '0')}`;
    const dirRel = i % 2 ? 'DCIM/100CANON' : 'DCIM/101CANON';
    out.push({
      key: photoKey(dirRel, basename),
      dirRel,
      basename,
      files: [
        { relPath: `${dirRel}/${basename}.CR3`, ext: 'cr3', kind: 'raw', size: 30_000_000 + i, mtime: 1_700_000_000_000 + i, previewOffset: 1024, previewLength: 500_000, previewW: 6000, previewH: 4000 },
        ...(i % 3 === 0 ? [{ relPath: `${dirRel}/${basename}.JPG`, ext: 'jpg', kind: 'jpeg' as const, size: 8_000_000, mtime: 1_700_000_000_000 + i }] : []),
      ],
      captureTs: 1_700_000_000_000 + i * 250,
      camera: 'Canon EOS R5',
      lens: 'RF24-70mm F2.8 L IS USM',
      iso: 100 * (1 + (i % 8)),
      shutter: 1 / 250,
      aperture: 2.8,
      focal: 50,
      width: 8192,
      height: 5464,
      orientation: 1,
      marks: { rating: 0, flag: 0, label: '' },
      thumbState: 0,
    });
  }
  return out;
}

const clients: DbClient[] = [];
async function open(): Promise<DbClient> {
  const c = await openDb({ name: NAME });
  clients.push(c);
  return c;
}
afterAll(async () => {
  for (const c of clients) await c.close();
  // Clean the test pool directory.
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(`.${NAME}-sahpool`, { recursive: true }).catch(() => {});
});

describe('db worker', () => {
  test('opens persistent with sahpool; CRUD', async () => {
    const db = await open();
    expect(db.status.persistent).toBe(true);
    expect(db.status.vfs).toBe('opfs-sahpool');

    const a = await db.openSession({ rootName: 'Wedding', fingerprint: 'fp1' });
    expect(a.isNew).toBe(true);
    const b = await db.openSession({ rootName: 'Wedding', fingerprint: 'fp1' });
    expect(b).toEqual({ sessionId: a.sessionId, isNew: false });

    const photos: PhotoInput[] = makePhotos(10);
    photos[0].phash = 0xdeadbeefn;
    photos[0].blurScore = 12.5;
    expect(await db.upsertFiles(a.sessionId, photos)).toEqual({ inserted: 10, updated: 0 } as never);
    let loaded = await db.loadSession(a.sessionId);
    expect(loaded.length).toBe(10);
    expect(loaded[0].phash).toBe('00000000deadbeef');
    expect(loaded[0].files).toEqual(photos[0].files);
    expect(loaded[0].eyesClosed).toBeUndefined();
    const { phash: _p, ...rest0 } = photos[0];
    expect(loaded[0]).toMatchObject(rest0);

    expect(await db.setMarks(a.sessionId, [{ key: photos[1].key, marks: { rating: 4 } }, { key: photos[2].key, marks: { flag: -1, label: 'red' } }, { key: 'nope', marks: { rating: 1 } }])).toBe(2);
    await db.setAiFields(a.sessionId, [
      { key: photos[0].key, blurScore: null, groupId: 7, eyesClosed: true, faceCount: 2 },
      { key: photos[1].key, phash: 'ABCDEF' },
    ]);
    loaded = await db.loadSession(a.sessionId);
    const by = new Map(loaded.map((p) => [p.key, p]));
    expect(by.get(photos[1].key)!.marks).toEqual({ rating: 4, flag: 0, label: '' });
    expect(by.get(photos[2].key)!.marks).toEqual({ rating: 0, flag: -1, label: 'red' });
    expect(by.get(photos[0].key)).toMatchObject({ groupId: 7, eyesClosed: true, faceCount: 2, phash: '00000000deadbeef' });
    expect(by.get(photos[0].key)!.blurScore).toBeUndefined();
    expect(by.get(photos[1].key)!.phash).toBe('0000000000abcdef');

    // Rescan with keepMarks: marks survive, metadata updates.
    const rescan = makePhotos(11).map((p) => ({ ...p, camera: 'R5 II' }));
    expect(await db.upsertFiles(a.sessionId, rescan, { keepMarks: true })).toEqual({ inserted: 1, updated: 10 });
    loaded = await db.loadSession(a.sessionId);
    expect(loaded.length).toBe(11);
    const by2 = new Map(loaded.map((p) => [p.key, p]));
    expect(by2.get(photos[1].key)!.marks.rating).toBe(4);
    expect(by2.get(photos[1].key)!.camera).toBe('R5 II');
    expect(by2.get(photos[0].key)!.groupId).toBe(7); // keepAi default

    expect(await db.deletePhotos(a.sessionId, [photos[9].key])).toBe(1);
    await db.setSessionSettings(a.sessionId, { picks: 'move' });
    const sessions = await db.listSessions();
    const s = sessions.find((x) => x.id === a.sessionId)!;
    expect(s).toMatchObject({ rootName: 'Wedding', fingerprint: 'fp1', photoCount: 10, settings: { picks: 'move' } });

    // history
    const seqs = await db.appendHistory(a.sessionId, [
      { ts: 1, cmd: { t: 'rate', keys: ['a'], v: 3 } },
      { ts: 2, cmd: { t: 'flag', keys: ['b'], v: 1 } },
    ]);
    expect(seqs).toEqual([1, 2]);
    await db.setHistoryUndone(a.sessionId, [2], true);
    let h = await db.loadHistory(a.sessionId);
    expect(h.map((e) => [e.seq, e.undone])).toEqual([[1, false], [2, true]]);
    await db.truncateHistory(a.sessionId, 1);
    h = await db.loadHistory(a.sessionId);
    expect(h.length).toBe(1);

    const other = await db.openSession({ rootName: 'Other', fingerprint: 'x' });
    await db.upsertFiles(other.sessionId, makePhotos(3));
    await db.deleteSession(other.sessionId);
    expect((await db.listSessions()).some((x) => x.id === other.sessionId)).toBe(false);
    expect(await db.loadSession(other.sessionId)).toEqual([]);
  });

  test('3000 rows: upsert, load < 150 ms, setMarks(3000) < 100 ms', async () => {
    const db = clients[0] ?? (await open());
    const { sessionId } = await db.openSession({ rootName: 'Perf', fingerprint: 'p3000' });
    const photos = makePhotos(3000);
    let t = performance.now();
    await db.upsertFiles(sessionId, photos);
    const upsertMs = performance.now() - t;

    // The machine running tests may be shared/noisy: report min and median of N runs, assert on min.
    const N = 7;
    const loadT: number[] = [];
    const marksT: number[] = [];
    const aiT: number[] = [];
    for (let k = 0; k < N; k++) {
      t = performance.now();
      const loaded = await db.loadSession(sessionId);
      loadT.push(performance.now() - t);
      expect(loaded.length).toBe(3000);

      const updates = photos.map((p, i) => ({ key: p.key, marks: { rating: (i + k) % 6, flag: (((i + k) % 3) - 1) as -1 | 0 | 1, label: 'green' as const } }));
      t = performance.now();
      expect(await db.setMarks(sessionId, updates)).toBe(3000);
      marksT.push(performance.now() - t);

      t = performance.now();
      await db.setAiFields(sessionId, photos.map((p, i) => ({ key: p.key, blurScore: (i + k) / 7, phash: BigInt(i + k) * 0x9e3779b97f4a7c15n, groupId: i >> 3 })));
      aiT.push(performance.now() - t);
    }
    const stats = (a: number[]) => {
      const s = [...a].sort((x, y) => x - y);
      return { min: s[0], med: s[s.length >> 1] };
    };
    const L = stats(loadT), M = stats(marksT), A = stats(aiT);
    const loadMs = L.min, marksMs = M.min;
    const after = await db.loadSession(sessionId);
    expect(after.filter((p) => p.marks.label === 'green').length).toBe(3000);
    const f = (x: { min: number; med: number }) => `${x.min.toFixed(1)}/${x.med.toFixed(1)}ms`;
    console.log(`[db perf] (min/median of ${N}) upsert3000=${upsertMs.toFixed(1)}ms load3000=${f(L)} setMarks3000=${f(M)} setAi3000=${f(A)}`);
    expect(loadMs).toBeLessThan(150);
    expect(marksMs).toBeLessThan(100);
  });

  test('second client while pool is held → in-memory fallback', async () => {
    const db = clients[0];
    expect(db.status.persistent).toBe(true);
    const second = await openDb({ name: NAME });
    try {
      expect(second.status).toMatchObject({ persistent: false, vfs: 'memory', reason: 'locked-by-other-tab' });
      const { sessionId } = await second.openSession({ rootName: 'Mem', fingerprint: 'm' });
      await second.upsertFiles(sessionId, makePhotos(2));
      expect((await second.loadSession(sessionId)).length).toBe(2);
    } finally {
      await second.close();
    }
  });

  test('reopen persistence: close worker, reopen, data still there', async () => {
    const db = clients[0];
    const { sessionId } = await db.openSession({ rootName: 'Persist', fingerprint: 'fpP' });
    await db.upsertFiles(sessionId, makePhotos(50));
    await db.setMarks(sessionId, [{ key: photoKey('DCIM/101CANON', 'IMG_0004'), marks: { rating: 5, flag: 1, label: 'purple' } }]);
    await db.close();
    clients.shift();

    const re = await open();
    expect(re.status.persistent).toBe(true);
    const again = await re.openSession({ rootName: 'Persist', fingerprint: 'fpP' });
    expect(again).toEqual({ sessionId, isNew: false });
    const loaded = await re.loadSession(sessionId);
    expect(loaded.length).toBe(50);
    expect(loaded.find((p) => p.basename === 'IMG_0004')!.marks).toEqual({ rating: 5, flag: 1, label: 'purple' });
    // 'Wedding' session from the first test also survived.
    expect((await re.listSessions()).map((s) => s.rootName)).toEqual(expect.arrayContaining(['Wedding', 'Perf', 'Persist']));
  });

  test('crashed worker (terminated without close) frees the lock for the next one', async () => {
    const db = clients[0];
    await db.close();
    clients.shift();
    const crashing = await openDb({ name: NAME });
    expect(crashing.status.persistent).toBe(true);
    const { sessionId } = await crashing.openSession({ rootName: 'Crash', fingerprint: 'c' });
    await crashing.upsertFiles(sessionId, makePhotos(5));
    crashing.terminate();
    // The browser releases the Web Lock and the sync access handles when the worker dies;
    // allow a short grace period via lockTimeoutMs.
    const next = await openDb({ name: NAME, lockTimeoutMs: 5000 });
    clients.push(next);
    expect(next.status.persistent).toBe(true);
    expect((await next.loadSession(sessionId)).length).toBe(5);
  });
});
