import { afterAll, describe, expect, test } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import type { Marks } from '../core/types';
import { parseXmp } from '../formats/xmp';
import {
  BACKUP_DIR,
  executeDelivery,
  exportCsv,
  exportXmpZip,
  LOG_NAME,
  planDelivery,
  readDeliveryLog,
  restoreDelivery,
  writeSidecars,
  type DeliveryPhoto,
} from './index';

type IterDir = FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };

const LR_SIDECAR = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmp:Rating="1"
   crs:Exposure2012="+0.35"
   crs:HasSettings="True"/>
 </rdf:RDF>
</x:xmpmeta>
`;

let opfs: FileSystemDirectoryHandle;
const made: string[] = [];
async function freshRoot(tag: string): Promise<FileSystemDirectoryHandle> {
  opfs ??= await navigator.storage.getDirectory();
  const name = `export-${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  made.push(name);
  return opfs.getDirectoryHandle(name, { create: true });
}
afterAll(async () => {
  for (const n of made) await opfs.removeEntry(n, { recursive: true }).catch(() => {});
});

async function put(root: FileSystemDirectoryHandle, path: string, content: string): Promise<void> {
  const parts = path.split('/');
  let d = root;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
}

async function tree(root: FileSystemDirectoryHandle, prefix = '', out = new Map<string, string>()): Promise<Map<string, string>> {
  for await (const [name, h] of (root as IterDir).entries()) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (h.kind === 'directory') {
      out.set(p + '/', '');
      await tree(h as FileSystemDirectoryHandle, p, out);
    } else out.set(p, await (await (h as FileSystemFileHandle).getFile()).text());
  }
  return out;
}
function sorted(m: Map<string, string>, skipLog = true): [string, string][] {
  return [...m.entries()].filter(([k]) => !skipLog || k !== LOG_NAME).sort(([a], [b]) => (a < b ? -1 : 1));
}
const M = (rating: number, flag: -1 | 0 | 1 = 0, label: Marks['label'] = ''): Marks => ({ rating, flag, label });

/** A small shoot: pairs, singles, sidecars of both conventions, a sub-folder. */
async function makeShoot(root: FileSystemDirectoryHandle): Promise<DeliveryPhoto[]> {
  await put(root, 'IMG_0001.CR3', 'raw-1');
  await put(root, 'IMG_0001.JPG', 'jpg-1');
  await put(root, 'IMG_0001.xmp', LR_SIDECAR); // declared
  await put(root, 'IMG_0002.CR3', 'raw-2');
  await put(root, 'IMG_0002.CR3.xmp', '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>'); // darktable, undeclared
  await put(root, 'IMG_0003.JPG', 'jpg-3');
  await put(root, 'IMG_0004.NEF', 'raw-4');
  await put(root, 'IMG_0004.JPG', 'jpg-4');
  await put(root, 'IMG_0005.ARW', 'raw-5');
  await put(root, 'sub/IMG_0006.DNG', 'raw-6');
  return [
    { key: '/img_0001', marks: M(5, 1, 'red'), files: [{ relPath: 'IMG_0001.CR3', kind: 'raw', sidecarRelPath: 'IMG_0001.xmp' }, { relPath: 'IMG_0001.JPG', kind: 'jpeg' }] },
    { key: '/img_0002', marks: M(3, 1), files: [{ relPath: 'IMG_0002.CR3', kind: 'raw' }] },
    { key: '/img_0003', marks: M(0, -1), files: [{ relPath: 'IMG_0003.JPG', kind: 'jpeg' }] },
    { key: '/img_0004', marks: M(2, -1), files: [{ relPath: 'IMG_0004.NEF', kind: 'raw' }, { relPath: 'IMG_0004.JPG', kind: 'jpeg' }] },
    { key: '/img_0005', marks: M(4, 0, 'blue'), files: [{ relPath: 'IMG_0005.ARW' }] },
    { key: 'sub/img_0006', marks: M(0, 1), files: [{ relPath: 'sub/IMG_0006.DNG' }] },
  ];
}

describe('planDelivery', () => {
  test('categorises picks/rejects, include filter, sidecar ownership', () => {
    const photos: DeliveryPhoto[] = [
      { key: 'a', marks: M(5, 1), files: [{ relPath: 'A.CR3', kind: 'raw', sidecars: ['A.xmp', 'A.CR3.xmp'] }, { relPath: 'A.JPG', kind: 'jpeg', sidecars: ['A.JPG.xmp'] }] },
      { key: 'b', marks: M(4), files: [{ relPath: 'B.NEF' }] },
      { key: 'c', marks: M(0, -1), files: [{ relPath: 'C.JPG' }] },
      { key: 'd', marks: M(0), files: [{ relPath: 'D.JPG' }] },
    ];
    let plan = planDelivery(photos, { picks: 'move', rejects: 'move', include: 'raw' });
    expect(plan.groups.map((g) => [g.key, g.category, g.action])).toEqual([['a', 'pick', 'move'], ['c', 'reject', 'move']]);
    expect(plan.groups[0].files).toEqual([
      { src: 'A.CR3', role: 'file' },
      { src: 'A.xmp', role: 'sidecar' },
      { src: 'A.CR3.xmp', role: 'sidecar' },
    ]);
    plan = planDelivery(photos, { picks: 'copy', rejects: 'none', include: 'jpeg', minRating: 4, splitByRating: true, writeXmp: true });
    expect(plan.groups.map((g) => [g.key, g.action, g.destDir])).toEqual([
      ['a', 'copy', '_Picks/5★'],
      ['b', 'copy', '_Picks/4★'],
      ['c', 'stay', ''],
    ]);
    expect(plan.groups[0].files.map((f) => f.src)).toEqual(['A.JPG', 'A.xmp', 'A.JPG.xmp']);
    expect(plan.summary).toEqual({ picks: 2, rejects: 0, files: 2, xmp: 3 });
  });
});

describe('executeDelivery / restoreDelivery on OPFS', () => {
  test('move picks + rejects, pairs, sidecars travel, XMP merged, then restore', async () => {
    const root = await freshRoot('move');
    const photos = await makeShoot(root);
    const before = sorted(await tree(root));
    const plan = planDelivery(photos, { picks: 'move', rejects: 'move', include: 'both', writeXmp: true });
    const progress: number[] = [];
    const log = await executeDelivery(root, plan, (p) => progress.push(p.done));
    const run = log.runs.at(-1)!;
    expect(run.status).toBe('done');
    expect(run.stats.failed).toBe(0);
    expect(run.stats.nativeMoves).toBe(run.stats.moved);
    expect(progress.at(-1)).toBe(run.ops.length);

    const t = await tree(root);
    const paths = [...t.keys()].filter((k) => !k.endsWith('/')).sort();
    expect(paths).toEqual([
      'IMG_0005.ARW',
      'IMG_0005.xmp', // stays, but marked → XMP written in place
      LOG_NAME,
      '_Picks/IMG_0001.CR3',
      '_Picks/IMG_0001.JPG',
      '_Picks/IMG_0001.xmp',
      '_Picks/IMG_0002.CR3',
      '_Picks/IMG_0002.CR3.xmp',
      '_Picks/IMG_0002.xmp',
      '_Picks/IMG_0006.DNG',
      '_Picks/IMG_0006.xmp',
      '_Rejects/IMG_0003.JPG',
      '_Rejects/IMG_0003.xmp',
      '_Rejects/IMG_0004.JPG',
      '_Rejects/IMG_0004.NEF',
      '_Rejects/IMG_0004.xmp',
      `${BACKUP_DIR}/${run.runId}/_Picks/IMG_0001.xmp`,
    ].sort());
    expect(t.get('_Picks/IMG_0001.CR3')).toBe('raw-1');
    // Existing Lightroom sidecar merged (develop settings kept), others created.
    const merged = t.get('_Picks/IMG_0001.xmp')!;
    expect(merged).toContain('crs:Exposure2012="+0.35"');
    expect(parseXmp(merged)).toEqual({ rating: 5, flag: 1, label: 'red' });
    expect(parseXmp(t.get('_Rejects/IMG_0004.xmp')!)).toEqual({ rating: 2, flag: -1, label: '' });
    expect(parseXmp(t.get('IMG_0005.xmp')!)).toEqual({ rating: 4, flag: 0, label: 'blue' });
    expect(t.get('_Picks/IMG_0002.CR3.xmp')).toBe('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');

    const persisted = await readDeliveryLog(root);
    expect(persisted!.runs.at(-1)!.ops.every((o) => o.state === 'done')).toBe(true);

    const res = await restoreDelivery(root);
    expect(res.errors).toEqual([]);
    expect(sorted(await tree(root))).toEqual(before);
    expect((await readDeliveryLog(root))!.runs.at(-1)!.status).toBe('restored');
    // A second restore is a no-op.
    expect((await restoreDelivery(root)).runs).toBe(0);
  });

  test('copy picks, include raw/jpeg, split by rating', async () => {
    const root = await freshRoot('copy');
    const photos = await makeShoot(root);
    const before = sorted(await tree(root));
    // ASCII folder names: headless Chromium's in-memory OPFS drops non-ASCII directory names.
    await executeDelivery(root, planDelivery(photos, { picks: 'copy', rejects: 'none', include: 'raw', splitByRating: true, ratingDirStyle: 'ascii' }));
    let t = await tree(root);
    for (const [k, v] of before) expect(t.get(k), k).toBe(v); // sources untouched
    expect([...t.keys()].filter((k) => k.startsWith('_Picks/') && !k.endsWith('/')).sort()).toEqual([
      '_Picks/3 stars/IMG_0002.CR3',
      '_Picks/3 stars/IMG_0002.CR3.xmp',
      '_Picks/5 stars/IMG_0001.CR3',
      '_Picks/5 stars/IMG_0001.xmp',
      '_Picks/Unrated/IMG_0006.DNG',
    ]);
    await restoreDelivery(root);
    expect(sorted(await tree(root))).toEqual(before);

    await executeDelivery(root, planDelivery(photos, { picks: 'move', rejects: 'none', include: 'jpeg' }));
    t = await tree(root);
    expect(t.has('_Picks/IMG_0001.JPG')).toBe(true);
    expect(t.has('_Picks/IMG_0001.xmp')).toBe(true); // basename sidecar follows the delivered member
    expect(t.has('IMG_0001.CR3')).toBe(true); // RAW stays
    await restoreDelivery(root);
    expect(sorted(await tree(root))).toEqual(before);
  });

  test('name collisions get consistent " (n)" suffixes, never overwrite', async () => {
    const root = await freshRoot('collide');
    await put(root, '_Picks/IMG_0001.CR3', 'already-there');
    await put(root, '_Picks/IMG_0009.xmp', 'foreign sidecar');
    await put(root, 'IMG_0001.CR3', 'raw-1');
    await put(root, 'IMG_0001.JPG', 'jpg-1');
    await put(root, 'IMG_0001.xmp', LR_SIDECAR);
    await put(root, 'b/IMG_0001.CR3', 'raw-b1');
    await put(root, 'IMG_0009.CR3', 'raw-9');
    const before = sorted(await tree(root));
    const photos: DeliveryPhoto[] = [
      { key: '/img_0001', marks: M(5, 1), files: [{ relPath: 'IMG_0001.CR3' }, { relPath: 'IMG_0001.JPG' }] },
      { key: 'b/img_0001', marks: M(4, 1), files: [{ relPath: 'b/IMG_0001.CR3' }] },
      { key: '/img_0009', marks: M(1, 1), files: [{ relPath: 'IMG_0009.CR3' }] },
    ];
    await executeDelivery(root, planDelivery(photos, { picks: 'move', rejects: 'none', writeXmp: true }));
    const t = await tree(root);
    expect(t.get('_Picks/IMG_0001.CR3')).toBe('already-there');
    expect(t.get('_Picks/IMG_0001 (1).CR3')).toBe('raw-1');
    expect(t.get('_Picks/IMG_0001 (1).JPG')).toBe('jpg-1');
    expect(parseXmp(t.get('_Picks/IMG_0001 (1).xmp')!)).toMatchObject({ rating: 5, flag: 1 });
    expect(t.get('_Picks/IMG_0001 (1).xmp')).toContain('crs:HasSettings');
    expect(t.get('_Picks/IMG_0001 (2).CR3')).toBe('raw-b1');
    expect(parseXmp(t.get('_Picks/IMG_0001 (2).xmp')!)).toMatchObject({ rating: 4 });
    // IMG_0009.xmp exists (someone else's) → the whole photo gets a suffix
    expect(t.get('_Picks/IMG_0009.xmp')).toBe('foreign sidecar');
    expect(t.get('_Picks/IMG_0009 (1).CR3')).toBe('raw-9');
    expect(parseXmp(t.get('_Picks/IMG_0009 (1).xmp')!)).toMatchObject({ rating: 1 });
    await restoreDelivery(root);
    expect(sorted(await tree(root))).toEqual(before);
  });

  for (const nativeMove of [true, false]) {
    test(`crash in the middle (nativeMove=${nativeMove}) → restore from journal`, async () => {
      const root = await freshRoot('crash');
      const photos: DeliveryPhoto[] = [];
      for (let i = 0; i < 40; i++) {
        const b = `IMG_${String(i).padStart(4, '0')}`;
        await put(root, `${b}.CR3`, `raw-${i}`);
        if (i % 2 === 0) await put(root, `${b}.JPG`, `jpg-${i}`);
        if (i % 5 === 0) await put(root, `${b}.xmp`, LR_SIDECAR);
        photos.push({
          key: `/${b.toLowerCase()}`,
          marks: M(i % 6, i % 3 === 0 ? -1 : 1),
          files: [{ relPath: `${b}.CR3`, kind: 'raw' }, ...(i % 2 === 0 ? [{ relPath: `${b}.JPG`, kind: 'jpeg' as const }] : [])],
        });
      }
      const before = sorted(await tree(root));
      const plan = planDelivery(photos, { picks: 'move', rejects: 'move', splitByRating: true, ratingDirStyle: 'ascii', writeXmp: true });
      await expect(executeDelivery(root, plan, undefined, { batchSize: 16, crashAfterOps: 23, nativeMove })).rejects.toThrow('simulated crash');
      const log = (await readDeliveryLog(root))!;
      const run = log.runs.at(-1)!;
      expect(run.status).toBe('running'); // what a crashed tab leaves behind
      expect(run.ops.some((o) => o.state === 'pending')).toBe(true);
      const midway = await tree(root);
      expect([...midway.keys()].some((k) => k.startsWith('_Picks/') || k.startsWith('_Rejects/'))).toBe(true);

      const res = await restoreDelivery(root);
      expect(res.errors).toEqual([]);
      expect(sorted(await tree(root))).toEqual(before);
    });
  }

  test('simulated half-finished copy fallback (dst partial, src intact) is cleaned up', async () => {
    const root = await freshRoot('partial');
    await put(root, 'A.CR3', 'the original raw bytes');
    const before = sorted(await tree(root));
    const plan = planDelivery([{ marks: M(1, 1), files: [{ relPath: 'A.CR3' }] }], { picks: 'move', rejects: 'none' });
    await expect(executeDelivery(root, plan, undefined, { crashAfterOps: 0 })).rejects.toThrow();
    // crashAfterOps: 0 → crashed right after the first op; emulate a torn copy instead:
    await restoreDelivery(root);
    expect(sorted(await tree(root))).toEqual(before);

    // Hand-craft a journal whose move is pending while a partial copy exists at the dst.
    await put(root, '_Picks/A.CR3', 'the orig');
    const log = (await readDeliveryLog(root))!;
    log.runs.push({ ...log.runs[0], runId: 'torn', status: 'running', createdDirs: [], ops: [{ i: 0, g: 0, type: 'move', src: 'A.CR3', dst: '_Picks/A.CR3', state: 'pending' }] });
    const res = await restoreDelivery(root, log);
    expect(res.errors).toEqual([]);
    const t = await tree(root);
    expect(t.get('A.CR3')).toBe('the original raw bytes');
    expect(t.has('_Picks/A.CR3')).toBe(false);
  });

  test('a failing op (missing source) skips the rest of that photo, run is done-with-errors', async () => {
    const root = await freshRoot('fail');
    await put(root, 'A.CR3', 'a');
    await put(root, 'B.CR3', 'b');
    const before = sorted(await tree(root));
    const photos: DeliveryPhoto[] = [
      { marks: M(1, 1), files: [{ relPath: 'GONE.CR3' }, { relPath: 'A.CR3' }] },
      { marks: M(2, 1), files: [{ relPath: 'B.CR3' }] },
    ];
    const log = await executeDelivery(root, planDelivery(photos, { picks: 'move', rejects: 'none', writeXmp: true }));
    const run = log.runs.at(-1)!;
    expect(run.status).toBe('done-with-errors');
    expect(run.ops.map((o) => [o.dst, o.state])).toEqual([
      ['_Picks/GONE.CR3', 'failed'],
      ['_Picks/A.CR3', 'skipped'],
      ['_Picks/GONE.xmp', 'skipped'],
      ['_Picks/B.CR3', 'done'],
      ['_Picks/B.xmp', 'done'],
    ]);
    await restoreDelivery(root);
    expect(sorted(await tree(root))).toEqual(before);
  });

  test('abort via signal stops between ops; restore undoes the done part', async () => {
    const root = await freshRoot('abort');
    const photos: DeliveryPhoto[] = [];
    for (let i = 0; i < 30; i++) {
      await put(root, `P${i}.JPG`, `j${i}`);
      photos.push({ marks: M(0, 1), files: [{ relPath: `P${i}.JPG` }] });
    }
    const before = sorted(await tree(root));
    const ac = new AbortController();
    const log = await executeDelivery(root, planDelivery(photos, { picks: 'move', rejects: 'none' }), (p) => p.done === 10 && ac.abort(), { signal: ac.signal, batchSize: 8 });
    const run = log.runs.at(-1)!;
    expect(run.status).toBe('aborted');
    // ops already in flight (concurrency 4) finish; nothing new starts after the abort
    expect(run.stats.moved).toBeGreaterThanOrEqual(10);
    expect(run.stats.moved).toBeLessThanOrEqual(13);
    expect(run.ops.filter((o) => o.state === 'skipped').length).toBe(run.ops.length - run.stats.moved); // later batches never journaled
    await restoreDelivery(root);
    expect(sorted(await tree(root))).toEqual(before);
  });

  test('perf: 3000 small files moved < 10 s (and restored)', async () => {
    const root = await freshRoot('perf');
    const N = 3000;
    const photos: DeliveryPhoto[] = [];
    const dir = await root.getDirectoryHandle('DCIM', { create: true });
    await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const name = `IMG_${String(i).padStart(4, '0')}.JPG`;
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(`x${i}`);
        await w.close();
        photos[i] = { marks: M(i % 6, i % 4 === 0 ? -1 : 1), files: [{ relPath: `DCIM/${name}`, kind: 'jpeg' }] };
      }),
    );
    const plan = planDelivery(photos, { picks: 'move', rejects: 'move', splitByRating: true, ratingDirStyle: 'ascii' });
    let t = performance.now();
    const log = await executeDelivery(root, plan);
    const moveMs = performance.now() - t;
    const run = log.runs.at(-1)!;
    expect(run.stats.moved).toBe(N);
    expect(run.stats.failed).toBe(0);
    t = performance.now();
    const res = await restoreDelivery(root);
    const restoreMs = performance.now() - t;
    expect(res.errors).toEqual([]);
    expect(res.reverted).toBe(N);
    console.log(`[export perf] move3000=${moveMs.toFixed(0)}ms (native ${run.stats.nativeMoves}) restore3000=${restoreMs.toFixed(0)}ms`);
    expect(moveMs).toBeLessThan(10_000);
  });
});

describe('writeSidecars / fallbacks', () => {
  test('writeSidecars creates, merges, dedupes pairs, reports unchanged', async () => {
    const root = await freshRoot('sidecars');
    await put(root, 'A.CR3', 'a');
    await put(root, 'A.JPG', 'a');
    await put(root, 'B.NEF', 'b');
    await put(root, 'B.XMP', LR_SIDECAR);
    const r1 = await writeSidecars(root, [
      { relPath: 'A.CR3', marks: M(3, 1, 'green') },
      { relPath: 'A.JPG', marks: M(3, 1, 'green') },
      { relPath: 'B.NEF', marks: M(0, -1) },
    ]);
    expect(r1.map((r) => [r.sidecar, r.status])).toEqual([['A.xmp', 'created'], ['B.XMP', 'updated']]);
    const t = await tree(root);
    expect(parseXmp(t.get('A.xmp')!)).toEqual({ rating: 3, flag: 1, label: 'green' });
    expect(t.get('B.XMP')).toContain('crs:Exposure2012');
    expect(parseXmp(t.get('B.XMP')!)).toEqual({ rating: 0, flag: -1, label: '' });
    const r2 = await writeSidecars(root, [{ relPath: 'A.CR3', marks: M(3, 1, 'green') }]);
    expect(r2[0].status).toBe('unchanged');
  });

  test('exportCsv and exportXmpZip', async () => {
    const photos = [
      { key: 'a', marks: M(5, 1, 'red'), files: [{ relPath: 'd/A.CR3', kind: 'raw' }, { relPath: 'd/A.JPG', kind: 'jpeg' }] },
      { key: 'b, "q"', marks: M(0, -1), files: [{ relPath: 'B.JPG' }], existingXmp: LR_SIDECAR },
      { key: 'c', marks: M(0), files: [{ relPath: 'C.JPG' }] },
    ];
    expect(exportCsv(photos)).toBe('key,files,rating,flag,label\r\na,d/A.CR3;d/A.JPG,5,pick,red\r\n"b, ""q""",B.JPG,0,reject,\r\nc,C.JPG,0,,\r\n');
    const zip = exportXmpZip(photos);
    expect(zip.type).toBe('application/zip');
    const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['B.xmp', 'd/A.xmp']);
    expect(parseXmp(strFromU8(files['d/A.xmp']))).toEqual({ rating: 5, flag: 1, label: 'red' });
    const b = strFromU8(files['B.xmp']);
    expect(b).toContain('crs:Exposure2012');
    expect(parseXmp(b)).toEqual({ rating: 0, flag: -1, label: '' });
  });
});
