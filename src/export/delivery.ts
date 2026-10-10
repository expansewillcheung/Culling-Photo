// Delivery to Photomator (PLAN.md §6, method A + B): move/copy picks to `_Picks/`, rejects to
// `_Rejects/`, sidecars travel with their files, optional XMP written at the final location.
// Every run is journaled write-ahead in `_culling-log.json` at the root and can be undone with
// restoreDelivery(), including a run that crashed half-way.
import type { Marks } from '../core/types';
import { buildSidecar, sidecarCandidates, sidecarName } from '../formats/xmp';
import { FsCache, joinPath, mapLimit, splitPath } from './fsutil';
import type {
  DeliveryLog,
  DeliveryOp,
  DeliveryOptions,
  DeliveryPhoto,
  DeliveryPlan,
  DeliveryProgress,
  DeliveryRun,
  ExecuteOptions,
  PlannedFile,
  PlannedGroup,
  RestoreResult,
} from './types';

export const LOG_NAME = '_culling-log.json';
export const BACKUP_DIR = '_culling-backup';

const RAW_EXT = new Set([
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'dng', 'pef', 'srw',
  '3fr', 'iiq', 'erf', 'mos', 'mrw', 'x3f', 'rwl', 'kdc', 'dcr', 'fff',
]);

function ext(name: string): string {
  const d = name.lastIndexOf('.');
  return d < 0 ? '' : name.slice(d + 1).toLowerCase();
}
function stemOf(name: string): string {
  const d = name.lastIndexOf('.');
  return d > 0 ? name.slice(0, d) : name;
}
function isRawFile(f: { relPath: string; kind?: string }): boolean {
  return f.kind ? f.kind === 'raw' : RAW_EXT.has(ext(f.relPath));
}
function isXmpName(name: string): boolean {
  return name.toLowerCase().endsWith('.xmp');
}
function hasMarks(m: Marks): boolean {
  return (m.rating ?? 0) > 0 || (m.flag ?? 0) !== 0 || !!m.label;
}
export function ratingDirName(rating: number, style: 'stars' | 'ascii' = 'stars'): string {
  const r = Math.max(0, Math.min(5, Math.round(rating || 0)));
  if (r === 0) return 'Unrated';
  return style === 'ascii' ? `${r} star${r === 1 ? '' : 's'}` : `${r}★`;
}

/** 'IMG_0001.CR3' with stem 'IMG_0001', n=1 → 'IMG_0001 (1).CR3'; also 'IMG_0001.CR3.xmp' → 'IMG_0001 (1).CR3.xmp'. */
export function withSuffix(name: string, stem: string, n: number): string {
  if (n === 0) return name;
  const tag = ` (${n})`;
  if (stem && name.toLowerCase().startsWith(stem.toLowerCase()) && (name.length === stem.length || name[stem.length] === '.')) {
    return name.slice(0, stem.length) + tag + name.slice(stem.length);
  }
  const d = name.lastIndexOf('.');
  return d > 0 ? name.slice(0, d) + tag + name.slice(d) : name + tag;
}

// ------------------------------------------------------------------ plan

export function planDelivery(photos: DeliveryPhoto[], options: DeliveryOptions): DeliveryPlan {
  const o: DeliveryPlan['options'] = {
    picks: options.picks,
    rejects: options.rejects,
    picksDir: options.picksDir ?? '_Picks',
    rejectsDir: options.rejectsDir ?? '_Rejects',
    splitByRating: options.splitByRating ?? false,
    ratingDirStyle: options.ratingDirStyle ?? 'stars',
    include: options.include ?? 'both',
    writeXmp: options.writeXmp ?? false,
    preserveSubdirs: options.preserveSubdirs ?? false,
    ...(options.minRating !== undefined ? { minRating: options.minRating } : {}),
  };
  const groups: PlannedGroup[] = [];
  const summary = { picks: 0, rejects: 0, files: 0, xmp: 0 };

  for (const photo of photos) {
    const m = photo.marks ?? { rating: 0, flag: 0, label: '' };
    const members = photo.files.filter((f) => !isXmpName(f.relPath));
    if (members.length === 0) continue;
    const isReject = m.flag === -1;
    const isPick = !isReject && (m.flag === 1 || (o.minRating !== undefined && (m.rating ?? 0) >= o.minRating));
    const raws = members.filter(isRawFile);
    const others = members.filter((f) => !isRawFile(f));

    let action: PlannedGroup['action'] = 'stay';
    let category: PlannedGroup['category'] = 'other';
    let delivered = members;
    let destDir = '';
    const sub = o.preserveSubdirs ? splitPath(members[0].relPath).dir : '';
    if (isReject && o.rejects === 'move') {
      action = 'move';
      category = 'reject';
      destDir = joinPath(o.rejectsDir, sub);
    } else if (isPick && o.picks !== 'none') {
      action = o.picks;
      category = 'pick';
      if (raws.length && others.length) delivered = o.include === 'raw' ? raws : o.include === 'jpeg' ? others : members;
      destDir = joinPath(o.picksDir, o.splitByRating ? ratingDirName(m.rating, o.ratingDirStyle) : '', sub);
    }
    const primaryFile = (action === 'stay' ? members : delivered).find(isRawFile) ?? (action === 'stay' ? members : delivered)[0];
    const stem = stemOf(splitPath(primaryFile.relPath).name);

    const files: PlannedFile[] = [];
    if (action !== 'stay') {
      const deliveredSet = new Set(delivered.map((f) => f.relPath));
      const seen = new Set<string>();
      for (const f of delivered) files.push({ src: f.relPath, role: 'file' });
      // Declared sidecars: per-file ones ('IMG.CR3.xmp') follow their file; basename ones
      // ('IMG.xmp') follow the photo as long as at least one member is delivered.
      for (const f of members) {
        for (const sc of [f.sidecarRelPath, ...(f.sidecars ?? [])]) {
          if (!sc || seen.has(sc.toLowerCase())) continue;
          const perFile = splitPath(sc).name.toLowerCase() === splitPath(f.relPath).name.toLowerCase() + '.xmp';
          if (perFile && !deliveredSet.has(f.relPath)) continue;
          seen.add(sc.toLowerCase());
          files.push({ src: sc, role: 'sidecar' });
        }
      }
    }
    const g: PlannedGroup = {
      key: photo.key ?? members[0].relPath.toLowerCase(),
      action,
      category,
      destDir,
      stem,
      files,
      primary: primaryFile.relPath,
    };
    if (o.writeXmp && (hasMarks(m) || action !== 'stay')) {
      g.xmp = { rating: m.rating ?? 0, flag: m.flag ?? 0, label: m.label ?? '' };
      summary.xmp++;
    }
    if (action === 'stay' && !g.xmp) continue;
    if (category === 'pick') summary.picks++;
    if (category === 'reject') summary.rejects++;
    summary.files += files.filter((f) => f.role === 'file').length;
    groups.push(g);
  }
  return { options: o, groups, summary };
}

// ------------------------------------------------------------------ journal

export async function readDeliveryLog(root: FileSystemDirectoryHandle): Promise<DeliveryLog | undefined> {
  const fs = new FsCache(root);
  return readLogWith(fs);
}

async function readLogWith(fs: FsCache): Promise<DeliveryLog | undefined> {
  const text = await fs.readText(LOG_NAME);
  if (text === undefined) return undefined;
  const parsed = JSON.parse(text) as DeliveryLog;
  if (parsed?.version !== 1 || !Array.isArray(parsed.runs)) throw new Error(`${LOG_NAME}: unsupported format`);
  return parsed;
}

async function writeLogWith(fs: FsCache, log: DeliveryLog): Promise<void> {
  // createWritable() writes to a swap file and atomically replaces on close().
  await fs.writeFile(LOG_NAME, JSON.stringify(log));
}

// ------------------------------------------------------------------ execute

class SimulatedCrash extends Error {}

/**
 * Execute a plan against `root`. Writes the journal before each batch (intended ops, state
 * 'pending'), performs them, then records completion. Never overwrites (collisions get
 * ' (n)' suffixes applied consistently to all members + sidecars of a photo) and never deletes
 * a source without a verified copy. Returns the updated log (this run is the last entry).
 */
export async function executeDelivery(
  root: FileSystemDirectoryHandle,
  plan: DeliveryPlan,
  onProgress?: (p: DeliveryProgress) => void,
  opts: ExecuteOptions = {},
): Promise<DeliveryLog> {
  const t0 = performance.now();
  const fs = new FsCache(root);
  const log: DeliveryLog = (await readLogWith(fs)) ?? { version: 1, runs: [] };
  const run: DeliveryRun = {
    runId: `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`,
    startedAt: Date.now(),
    status: 'running',
    options: plan.options,
    createdDirs: [],
    ops: [],
    stats: { moved: 0, copied: 0, xmp: 0, failed: 0, nativeMoves: 0 },
  };
  log.runs.push(run);
  await writeLogWith(fs, log);

  const batchSize = Math.max(1, opts.batchSize ?? 250);
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const reserved = new Set<string>(); // lower-cased dst paths claimed by this run
  const total = plan.groups.reduce((n, g) => n + g.files.length + (g.xmp ? 1 : 0), 0);
  let done = 0;
  let fileOps = 0;
  const backupRoot = joinPath(BACKUP_DIR, run.runId);

  const isFree = async (path: string) => !reserved.has(path.toLowerCase()) && !(await fs.exists(path));

  /** Turn one planned group into concrete ops (choosing collision-free names). */
  const expand = async (g: PlannedGroup): Promise<DeliveryOp[]> => {
    const ops: DeliveryOp[] = [];
    if (g.action === 'stay') {
      if (g.xmp) {
        const dst = sidecarName(g.primary);
        const { dir, name } = splitPath(dst);
        const actual = (await fs.actualName(dir, name)) ?? name;
        const real = joinPath(dir, actual);
        ops.push({ i: 0, g: 0, type: 'xmp', dst: real, marks: g.xmp, backup: joinPath(backupRoot, real), expectExisting: await fs.exists(real), state: 'pending' });
      }
      return ops;
    }
    // Discover sidecars present next to delivered files that the plan didn't declare.
    const files = [...g.files];
    const have = new Set(files.map((f) => f.src.toLowerCase()));
    for (const f of g.files) {
      if (f.role !== 'file') continue;
      const { dir, name } = splitPath(f.src);
      for (const cand of sidecarCandidates(name)) {
        const actual = await fs.actualName(dir, cand);
        if (!actual) continue;
        const p = joinPath(dir, actual);
        if (have.has(p.toLowerCase())) continue;
        // Per-file sidecars of members not being delivered stay (handled by plan); candidates
        // here are derived from delivered files only, so they're safe to take along.
        have.add(p.toLowerCase());
        files.push({ src: p, role: 'sidecar' });
      }
    }
    await fs.dir(g.destDir, true); // create now so createdDirs is journaled with the batch
    let n = 0;
    let dsts: string[] = [];
    for (;;) {
      dsts = files.map((f) => joinPath(g.destDir, withSuffix(splitPath(f.src).name, g.stem, n)));
      let ok = true;
      for (const d of dsts) if (!(await isFree(d))) ok = false;
      // the sidecar we'll write must not collide with someone else's file either
      if (ok && g.xmp) {
        const sc = joinPath(g.destDir, withSuffix(splitPath(sidecarName(g.primary)).name, g.stem, n));
        if (!dsts.some((d) => d.toLowerCase() === sc.toLowerCase()) && !(await isFree(sc))) ok = false;
      }
      if (ok) break;
      n++;
    }
    files.forEach((f, k) => {
      reserved.add(dsts[k].toLowerCase());
      ops.push({ i: 0, g: 0, type: g.action === 'copy' ? 'copy' : 'move', src: f.src, dst: dsts[k], state: 'pending' });
    });
    if (g.xmp) {
      const primaryIdx = files.findIndex((f) => f.src === g.primary);
      const primaryDst = primaryIdx >= 0 ? dsts[primaryIdx] : joinPath(g.destDir, withSuffix(splitPath(g.primary).name, g.stem, n));
      const dst = sidecarName(primaryDst);
      const movedHere = dsts.findIndex((d) => d.toLowerCase() === dst.toLowerCase());
      const real = movedHere >= 0 ? dsts[movedHere] : dst;
      reserved.add(real.toLowerCase());
      ops.push({ i: 0, g: 0, type: 'xmp', dst: real, marks: g.xmp, backup: joinPath(backupRoot, real), expectExisting: movedHere >= 0, state: 'pending' });
    }
    return ops;
  };

  const runOp = async (op: DeliveryOp) => {
    if (op.type === 'xmp') {
      const existing = await fs.readText(op.dst);
      if (existing !== undefined) await fs.writeFile(op.backup, existing); // backup BEFORE modifying
      await fs.writeFile(op.dst, buildSidecar(op.marks, existing));
      run.stats.xmp++;
    } else if (op.type === 'move') {
      const r = await fs.moveFile(op.src, op.dst, { allowNativeMove: opts.nativeMove !== false });
      op.size = r.size;
      op.method = r.method;
      run.stats.moved++;
      if (r.method === 'move') run.stats.nativeMoves++;
    } else {
      op.size = await fs.copyFile(op.src, op.dst);
      op.method = 'copy';
      run.stats.copied++;
    }
  };

  try {
    let gi = 0;
    while (gi < plan.groups.length) {
      if (opts.signal?.aborted) {
        run.status = 'aborted';
        break;
      }
      // Plan a batch (sequentially: collision-free names are reserved as we go).
      const batch: DeliveryOp[][] = [];
      let count = 0;
      while (gi < plan.groups.length && count < batchSize) {
        const ops = await expand(plan.groups[gi]);
        for (const op of ops) {
          op.g = gi;
          op.i = run.ops.length;
          run.ops.push(op);
        }
        gi++;
        count += ops.length;
        if (ops.length) batch.push(ops);
      }
      run.createdDirs = [...fs.created];
      await writeLogWith(fs, log); // write-ahead: intended ops are durable before we touch anything

      let crashed: SimulatedCrash | undefined;
      await mapLimit(batch, concurrency, async (ops) => {
        let groupFailed = false;
        for (const op of ops) {
          if (crashed) return;
          // After a failure keep the photo's remaining members/sidecar where they are
          // (restoreDelivery can bring back what did move).
          if (opts.signal?.aborted || groupFailed) {
            op.state = 'skipped';
            continue;
          }
          try {
            await runOp(op);
            op.state = 'done';
          } catch (e) {
            op.state = 'failed';
            op.error = (e as Error)?.message ?? String(e);
            run.stats.failed++;
            groupFailed = true;
          }
          done++;
          if (op.type !== 'xmp') fileOps++;
          onProgress?.({ phase: op.type === 'xmp' ? 'xmp' : 'move', done, total, current: op.type === 'xmp' ? op.dst : op.src });
          if (opts.crashAfterOps !== undefined && fileOps >= opts.crashAfterOps) crashed ??= new SimulatedCrash('simulated crash');
        }
      });
      if (crashed) throw crashed; // all in-flight ops have settled
      if (opts.signal?.aborted) run.status = 'aborted';
      run.createdDirs = [...fs.created];
      await writeLogWith(fs, log);
    }
    if (run.status === 'running') run.status = run.stats.failed ? 'done-with-errors' : 'done';
    if (run.status === 'aborted') for (const op of run.ops) if (op.state === 'pending') op.state = 'skipped';
  } catch (e) {
    if (e instanceof SimulatedCrash) throw e; // leave the journal as a crash would
    run.status = 'crashed';
    run.finishedAt = Date.now();
    await writeLogWith(fs, log).catch(() => {});
    throw e;
  }
  run.finishedAt = Date.now();
  run.stats.durationMs = Math.round(performance.now() - t0);
  run.createdDirs = [...fs.created];
  await writeLogWith(fs, log);
  return log;
}

// ------------------------------------------------------------------ restore

/**
 * Undo every not-yet-restored run in the journal (newest first). Works from the actual state of
 * the file system, so it also repairs a run that crashed with ops still 'pending'. Never deletes
 * the only copy of a file.
 */
export async function restoreDelivery(
  root: FileSystemDirectoryHandle,
  log?: DeliveryLog,
  onProgress?: (p: DeliveryProgress) => void,
): Promise<RestoreResult> {
  const fs = new FsCache(root);
  const current = log ?? (await readLogWith(fs));
  const result: RestoreResult = { runs: 0, reverted: 0, skipped: 0, errors: [] };
  if (!current) return result;
  const runs = current.runs.filter((r) => r.status !== 'restored').reverse();
  const total = runs.reduce((n, r) => n + r.ops.length, 0);
  let done = 0;

  for (const run of runs) {
    result.runs++;
    let errors = 0;
    // Undo photo groups newest first, several at a time; ops within a group in reverse order.
    const groups = new Map<number, DeliveryOp[]>();
    for (const op of run.ops) {
      const g = op.g ?? op.i;
      let list = groups.get(g);
      if (!list) groups.set(g, (list = []));
      list.push(op);
    }
    const ordered = [...groups.values()].reverse();
    await mapLimit(ordered, 4, async (ops) => {
      for (let k = ops.length - 1; k >= 0; k--) {
        const op = ops[k];
        done++;
        onProgress?.({ phase: 'restore', done, total, current: op.dst });
        if (op.state === 'reverted' || op.state === 'skipped') {
          result.skipped++;
          continue;
        }
        try {
          const reverted = await revertOp(fs, op);
          if (reverted) {
            op.state = 'reverted';
            result.reverted++;
          } else result.skipped++;
        } catch (e) {
          errors++;
          const msg = (e as Error)?.message ?? String(e);
          op.error = `restore: ${msg}`;
          result.errors.push({ op, error: msg });
        }
      }
    });
    // Backups and directories we created.
    if (!errors) await removeTree(fs, joinPath(BACKUP_DIR, run.runId));
    await fs.removeEmptyDir(BACKUP_DIR);
    for (const d of [...run.createdDirs].reverse()) await fs.removeEmptyDir(d);
    run.status = errors ? 'restore-incomplete' : 'restored';
    run.restoredAt = Date.now();
  }
  await writeLogWith(fs, current);
  return result;
}

/** Returns true if something was undone, false if there was nothing to undo. Throws on conflicts. */
async function revertOp(fs: FsCache, op: DeliveryOp): Promise<boolean> {
  if (op.type === 'xmp') {
    const backup = await fs.tryFile(op.backup);
    if (backup) {
      await fs.writeFile(op.dst, backup);
      await fs.remove(op.backup);
      return true;
    }
    const cur = await fs.readText(op.dst);
    if (cur === undefined) return false;
    // No backup: the sidecar didn't exist before (backup is always written before modifying).
    // If a sidecar was expected there (moved in), it is untouched — leave it for the move revert.
    if (op.expectExisting) return false;
    if (op.state === 'done' || cur.includes('https://culling-photo.app/ns/1.0/')) {
      await fs.remove(op.dst);
      return true;
    }
    return false;
  }
  const srcExists = await fs.exists(op.src);
  const dstExists = await fs.exists(op.dst);
  if (op.type === 'copy') {
    if (!dstExists) return false;
    if (!srcExists) throw new Error(`source ${op.src} missing; keeping the copy ${op.dst}`);
    await fs.remove(op.dst);
    return true;
  }
  // move
  if (dstExists && !srcExists) {
    await fs.moveFile(op.dst, op.src);
    return true;
  }
  if (dstExists && srcExists) {
    if (op.state === 'done') throw new Error(`both ${op.src} and ${op.dst} exist; leaving both`);
    // Interrupted copy-fallback: the source is intact, the destination is our (partial) copy.
    await fs.remove(op.dst);
    return true;
  }
  if (!dstExists && srcExists) return false; // never happened
  throw new Error(`neither ${op.src} nor ${op.dst} exists`);
}

async function removeTree(fs: FsCache, path: string): Promise<void> {
  const { dir, name } = splitPath(path);
  try {
    await (await fs.dir(dir)).removeEntry(name, { recursive: true });
  } catch {
    /* missing */
  }
}
