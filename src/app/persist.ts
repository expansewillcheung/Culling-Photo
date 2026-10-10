import type { Marks } from '../core/types';
import type { Photo } from '../store/types';

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
  open(rootName: string, fingerprint: string): Promise<Map<string, SavedPhoto>>;
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
