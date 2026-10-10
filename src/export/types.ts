import type { FileKind, Marks } from '../core/types';

/** A member file of a photo. Compatible with db FileRecord. */
export interface DeliveryFile {
  relPath: string;
  kind?: FileKind;
  /** Known sidecar next to this file (from the scanner). */
  sidecarRelPath?: string;
  /** More known sidecars (e.g. both IMG.xmp and darktable's IMG.CR3.xmp). */
  sidecars?: string[];
}

/** A logical photo to deliver. Structurally compatible with db PhotoRecord. */
export interface DeliveryPhoto {
  key?: string;
  marks: Marks;
  files: DeliveryFile[];
}

export interface DeliveryOptions {
  picks: 'move' | 'copy' | 'none';
  rejects: 'move' | 'none';
  /** Default '_Picks' */
  picksDir?: string;
  /** Default '_Rejects' */
  rejectsDir?: string;
  /** Put picks into '5★', '4★', … '1★', 'Unrated' subfolders. */
  splitByRating?: boolean;
  /**
   * Rating folder names: 'stars' → '5★' (default), 'ascii' → '5 stars' / '1 star'.
   * (Chromium's in-memory OPFS — incognito/headless test profiles — mishandles non-ASCII
   * directory names; real local folders are fine.)
   */
  ratingDirStyle?: 'stars' | 'ascii';
  /** For RAW+JPEG (or RAW+HEIC) pairs, which member(s) to deliver as picks. Rejects always move all. */
  include?: 'raw' | 'jpeg' | 'both';
  /**
   * A photo counts as a pick if flagged (flag 1) OR, when set, rated >= minRating.
   * Rejected photos (flag -1) are never picks.
   */
  minRating?: number;
  /** Write/merge XMP sidecars (xmp:Rating/Label + cull:Flag) at the final location of every marked photo. */
  writeXmp?: boolean;
  /** Mirror the photo's sub-directory under the destination (default false: flat). */
  preserveSubdirs?: boolean;
}

export interface PlannedFile {
  src: string;
  /** 'file' = member image; 'sidecar' = existing sidecar travelling with it. */
  role: 'file' | 'sidecar';
}

export interface PlannedGroup {
  key: string;
  /** 'move'/'copy' into destDir; 'stay' = only (maybe) write XMP in place. */
  action: 'move' | 'copy' | 'stay';
  category: 'pick' | 'reject' | 'other';
  /** Destination directory relative to root (unused for 'stay'). */
  destDir: string;
  /** Shared stem of the photo (used to rename all members consistently on collision). */
  stem: string;
  files: PlannedFile[];
  /** Member that the basename sidecar describes (RAW preferred) — relPath in `files` or remaining in place. */
  primary: string;
  /** Write a sidecar with these marks after moving (when options.writeXmp). */
  xmp?: Marks;
}

export interface DeliveryPlan {
  options: Required<Omit<DeliveryOptions, 'minRating'>> & { minRating?: number };
  groups: PlannedGroup[];
  summary: { picks: number; rejects: number; files: number; xmp: number };
}

export type OpState = 'pending' | 'done' | 'failed' | 'reverted' | 'skipped';

export type DeliveryOp =
  | { i: number; /** group (photo) index within the run */ g: number; type: 'move' | 'copy'; src: string; dst: string; size?: number; method?: 'move' | 'copy'; state: OpState; error?: string }
  | {
      i: number;
      g: number;
      type: 'xmp';
      dst: string;
      marks: Marks;
      /** Where a pre-existing sidecar is backed up before we modify it (only written if it existed). */
      backup: string;
      /** At plan time a sidecar was expected at dst (moved there or already present). */
      expectExisting: boolean;
      state: OpState;
      error?: string;
    };

export interface DeliveryRun {
  runId: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'done' | 'done-with-errors' | 'aborted' | 'crashed' | 'restored' | 'restore-incomplete';
  options: DeliveryPlan['options'];
  /** Directories created by this run (parents first) — removed on restore if empty. */
  createdDirs: string[];
  ops: DeliveryOp[];
  stats: { moved: number; copied: number; xmp: number; failed: number; nativeMoves: number; durationMs?: number };
  restoredAt?: number;
}

/** Content of `_culling-log.json`: every run, newest last. */
export interface DeliveryLog {
  version: 1;
  runs: DeliveryRun[];
}

export interface DeliveryProgress {
  phase: 'move' | 'xmp' | 'restore';
  done: number;
  total: number;
  current?: string;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
  /** Ops per write-ahead journal batch (default 250). */
  batchSize?: number;
  /** Photos processed concurrently (default 4). Ops of one photo always run in order. */
  concurrency?: number;
  /** Disable FileSystemFileHandle.move() (forces stream copy + verify + delete). */
  nativeMove?: boolean;
  /** Test hook: throw after N file operations, before the journal is updated (simulated crash). */
  crashAfterOps?: number;
}

export interface RestoreResult {
  runs: number;
  reverted: number;
  skipped: number;
  errors: { op: DeliveryOp; error: string }[];
}
