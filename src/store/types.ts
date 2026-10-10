import type { ColorLabel, ExifInfo, FileKind, Flag, ParsedFile } from '../core/types';
import type { CatalogItem } from '../pipeline/catalog';

export type ThumbState = 'none' | 'queued' | 'ready' | 'error';

export interface Photo {
  id: number;
  key: string;
  stem: string;
  dirRel: string;
  item: CatalogItem;
  /** Index (into item.files) of the file used for display. */
  display: number;
  kinds: FileKind[];
  parsed: (ParsedFile | null)[];
  metaDone: boolean;
  exif: ExifInfo;
  captureTime?: number;
  // marks
  rating: number;
  flag: Flag;
  label: ColorLabel;
  // thumbnail
  thumbState: ThumbState;
  thumbUrl?: string;
  /** width / height of the oriented image (1.5 until known). */
  aspect: number;
  sourceWidth?: number;
  sourceHeight?: number;
  error?: string;
  // analysis
  blurScore?: number;
  phash?: string;
  exposure?: { mean: number; clippedHighlights: number; clippedShadows: number };
  histogram?: Uint32Array;
  groupId?: number;
  groupSize?: number;
  groupBest?: boolean;
  faceCount?: number;
  eyesClosed?: boolean;
  suggestion?: string;
}

export type ViewMode = 'grid' | 'loupe' | 'compare';
export type SortKey = 'time' | 'name' | 'rating' | 'sharpness' | 'type';

export interface Filter {
  flag: 'all' | 'picks' | 'rejects' | 'unflagged' | 'notRejected';
  minRating: number;
  labels: ColorLabel[];
  kinds: FileKind[];
  camera: string;
  lens: string;
  onlySuggested: boolean;
  text: string;
  /** Collapse bursts: show only the best of each group. */
  stacks: boolean;
}

export const DEFAULT_FILTER: Filter = {
  flag: 'all',
  minRating: 0,
  labels: [],
  kinds: [],
  camera: '',
  lens: '',
  onlySuggested: false,
  text: '',
  stacks: false,
};

export interface Settings {
  autoAdvance: boolean;
  writeXmp: boolean;
  analyze: boolean;
  faces: boolean;
  thumbSize: number;
  showInfo: boolean;
  showClipping: boolean;
  burstGapMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  autoAdvance: false,
  writeXmp: true,
  analyze: true,
  faces: false,
  thumbSize: 200,
  showInfo: false,
  showClipping: false,
  burstGapMs: 2000,
};

export interface Progress {
  phase: 'idle' | 'listing' | 'meta' | 'thumbs' | 'analyze' | 'done';
  listed: number;
  metaDone: number;
  thumbsDone: number;
  facesDone: number;
  total: number;
  startedAt: number;
  firstThumbAt?: number;
  allThumbsAt?: number;
  errors: number;
}
