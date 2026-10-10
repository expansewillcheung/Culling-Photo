// Test-only helpers (node). Not imported by app code.
import { openSync, readSync, fstatSync, closeSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Reader } from '../core/types';

export interface CountingReader extends Reader {
  bytesRead: number;
  reads: number;
  /** Recorded reads (for replaying without I/O). */
  log: Map<string, Uint8Array>;
  close(): void;
}

export function fileReader(path: string): CountingReader {
  const fd = openSync(path, 'r');
  const size = fstatSync(fd).size;
  const r: CountingReader = {
    size,
    bytesRead: 0,
    reads: 0,
    log: new Map(),
    async read(offset, length) {
      const end = Math.min(size, offset + length);
      if (offset >= end || offset < 0) return new Uint8Array(0);
      const buf = new Uint8Array(end - offset);
      readSync(fd, buf, 0, buf.length, offset);
      r.bytesRead += buf.length;
      r.reads++;
      r.log.set(`${offset}:${length}`, buf);
      return buf;
    },
    close() {
      closeSync(fd);
    },
  };
  return r;
}

/** Replays reads recorded by `fileReader` from memory (falls back to `fallback`). */
export function replayReader(log: Map<string, Uint8Array>, size: number, fallback: Reader): Reader {
  return {
    size,
    async read(offset, length) {
      return log.get(`${offset}:${length}`) ?? fallback.read(offset, length);
    },
  };
}

export const FIXTURES = resolve(__dirname, '../../tests/fixtures');

export function listFixtures(): { path: string; name: string; dir: 'raw' | 'gen' }[] {
  const out: { path: string; name: string; dir: 'raw' | 'gen' }[] = [];
  for (const dir of ['raw', 'gen'] as const) {
    const d = join(FIXTURES, dir);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.')) continue;
      out.push({ path: join(d, name), name, dir });
    }
  }
  return out;
}
