import { batch, createMemo, createRoot } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import type { ColorLabel, Flag, Marks } from '../core/types';
import { DEFAULT_FILTER, DEFAULT_SETTINGS, type Filter, type Photo, type Progress, type Settings, type SortKey, type ViewMode } from './types';

export interface AppState {
  screen: 'welcome' | 'library';
  sourceName: string;
  writable: boolean;
  photos: Photo[];
  view: ViewMode;
  /** Id of the focused photo. */
  current: number;
  /** Extra selected ids (multi-select / compare set). Always includes current when non-empty. */
  selection: number[];
  filter: Filter;
  sort: SortKey;
  sortDesc: boolean;
  settings: Settings;
  progress: Progress;
  /** 1 = fit, otherwise zoom factor relative to 100% (1:1 pixels). */
  zoom: 'fit' | number;
  toast: string;
  dialog: '' | 'deliver' | 'help' | 'settings' | 'smart';
  persistent: boolean;
}

const SETTINGS_KEY = 'culling.settings.v1';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

export const emptyProgress = (): Progress => ({
  phase: 'idle', listed: 0, metaDone: 0, thumbsDone: 0, facesDone: 0, total: 0, startedAt: 0, errors: 0,
});

interface Change {
  ids: number[];
  before: Marks[];
  after: Marks[];
}

function createAppStore() {
  const [state, setState] = createStore<AppState>({
    screen: 'welcome',
    sourceName: '',
    writable: false,
    photos: [],
    view: 'grid',
    current: -1,
    selection: [],
    filter: { ...DEFAULT_FILTER },
    sort: 'time',
    sortDesc: false,
    settings: loadSettings(),
    progress: emptyProgress(),
    zoom: 'fit',
    toast: '',
    dialog: '',
    persistent: false,
  });

  const undoStack: Change[] = [];
  const redoStack: Change[] = [];
  const marksListeners = new Set<(ids: number[]) => void>();

  /** Sorted + filtered ids. */
  const viewIds = createMemo<number[]>(() => {
    const f = state.filter;
    const photos = state.photos;
    const text = f.text.trim().toLowerCase();
    const out: Photo[] = [];
    for (const p of photos) {
      if (f.flag === 'picks' && p.flag !== 1) continue;
      if (f.flag === 'rejects' && p.flag !== -1) continue;
      if (f.flag === 'unflagged' && p.flag !== 0) continue;
      if (f.flag === 'notRejected' && p.flag === -1) continue;
      if (f.minRating && p.rating < f.minRating) continue;
      if (f.labels.length && !f.labels.includes(p.label)) continue;
      if (f.kinds.length && !p.kinds.some((k) => f.kinds.includes(k))) continue;
      if (f.camera && (p.exif.model ?? '') !== f.camera) continue;
      if (f.lens && (p.exif.lens ?? '') !== f.lens) continue;
      if (f.onlySuggested && !p.suggestion) continue;
      if (f.stacks && p.groupSize && p.groupSize > 1 && !p.groupBest) continue;
      if (text && !p.stem.toLowerCase().includes(text) && !p.dirRel.toLowerCase().includes(text)) continue;
      out.push(p);
    }
    const dir = state.sortDesc ? -1 : 1;
    // Photo ids follow catalog order, which is already natural-sorted by folder + name.
    const byName = (a: Photo, b: Photo) => a.id - b.id;
    let cmp: (a: Photo, b: Photo) => number;
    switch (state.sort) {
      case 'time':
        cmp = (a, b) => ((a.captureTime ?? Infinity) - (b.captureTime ?? Infinity) || byName(a, b)) * dir;
        break;
      case 'rating':
        cmp = (a, b) => (b.rating - a.rating || b.flag - a.flag || byName(a, b)) * dir;
        break;
      case 'sharpness':
        cmp = (a, b) => ((b.blurScore ?? -1) - (a.blurScore ?? -1) || byName(a, b)) * dir;
        break;
      case 'type':
        cmp = (a, b) => (a.kinds.join().localeCompare(b.kinds.join()) || byName(a, b)) * dir;
        break;
      default:
        cmp = (a, b) => byName(a, b) * dir;
    }
    out.sort(cmp);
    return out.map((p) => p.id);
  });

  const viewIndex = createMemo(() => {
    const m = new Map<number, number>();
    viewIds().forEach((id, i) => m.set(id, i));
    return m;
  });

  const counts = createMemo(() => {
    let picks = 0, rejects = 0, rated = 0, unflagged = 0;
    for (const p of state.photos) {
      if (p.flag === 1) picks++;
      else if (p.flag === -1) rejects++;
      else unflagged++;
      if (p.rating > 0) rated++;
    }
    return { total: state.photos.length, picks, rejects, rated, unflagged };
  });

  const photo = (id: number): Photo | undefined => state.photos[id];
  const currentPhoto = () => photo(state.current);
  const currentIndex = () => viewIndex().get(state.current) ?? -1;

  function marksOf(p: Photo): Marks {
    return { rating: p.rating, flag: p.flag, label: p.label };
  }

  function applyMarks(ids: number[], marks: Marks[], record: boolean, before?: Marks[], notify = true) {
    const prev = before ?? ids.map((id) => marksOf(state.photos[id]));
    batch(() => {
      setState(
        'photos',
        produce((photos) => {
          ids.forEach((id, i) => {
            const p = photos[id];
            const m = marks[i];
            p.rating = m.rating;
            p.flag = m.flag;
            p.label = m.label;
          });
        }),
      );
    });
    if (record) {
      undoStack.push({ ids, before: prev, after: marks });
      if (undoStack.length > 500) undoStack.shift();
      redoStack.length = 0;
    }
    if (notify) for (const l of marksListeners) l(ids);
  }

  /** Targets for a marking action: selection if any, else the current photo. */
  function targets(): number[] {
    if (state.selection.length > 1) return [...state.selection];
    return state.current >= 0 ? [state.current] : [];
  }

  function mark(patch: Partial<Marks>, ids = targets()) {
    if (!ids.length) return;
    const after = ids.map((id) => {
      const m = marksOf(state.photos[id]);
      return { ...m, ...patch };
    });
    applyMarks(ids, after, true);
  }

  const actions = {
    setState,
    setRating(r: number) {
      mark({ rating: r });
    },
    setFlag(f: Flag) {
      mark({ flag: f });
    },
    toggleLabel(l: ColorLabel) {
      const ids = targets();
      if (!ids.length) return;
      const allHave = ids.every((id) => state.photos[id].label === l);
      mark({ label: allHave ? '' : l }, ids);
    },
    undo() {
      const c = undoStack.pop();
      if (!c) return false;
      redoStack.push(c);
      applyMarks(c.ids, c.before, false);
      if (c.ids.length === 1) setState('current', c.ids[0]);
      return true;
    },
    redo() {
      const c = redoStack.pop();
      if (!c) return false;
      undoStack.push(c);
      applyMarks(c.ids, c.after, false);
      if (c.ids.length === 1) setState('current', c.ids[0]);
      return true;
    },
    /** Bulk set without undo recording (used when loading sessions / XMP). */
    loadMarks(ids: number[], marks: Marks[]) {
      applyMarks(ids, marks, false, undefined, false);
    },
    onMarks(fn: (ids: number[]) => void) {
      marksListeners.add(fn);
      return () => marksListeners.delete(fn);
    },
    go(delta: number, extend = false) {
      const ids = viewIds();
      if (!ids.length) return;
      let i = currentIndex();
      if (i < 0) i = delta > 0 ? -1 : ids.length;
      const ni = Math.max(0, Math.min(ids.length - 1, i + delta));
      actions.select(ids[ni], extend ? 'range' : 'single');
    },
    goTo(index: number) {
      const ids = viewIds();
      if (!ids.length) return;
      actions.select(ids[Math.max(0, Math.min(ids.length - 1, index))]);
    },
    select(id: number, mode: 'single' | 'toggle' | 'range' = 'single') {
      batch(() => {
        if (mode === 'single') {
          setState('selection', []);
        } else if (mode === 'toggle') {
          const sel = new Set(state.selection.length ? state.selection : state.current >= 0 ? [state.current] : []);
          if (sel.has(id) && sel.size > 1) sel.delete(id);
          else sel.add(id);
          setState('selection', [...sel]);
        } else {
          const ids = viewIds();
          const a = currentIndex();
          const anchor = state.selection.length ? viewIndex().get(state.selection[0]) ?? a : a;
          const b = viewIndex().get(id) ?? a;
          const [lo, hi] = anchor < b ? [anchor, b] : [b, anchor];
          const range = ids.slice(lo, hi + 1);
          // keep anchor first
          const anchorId = ids[anchor];
          setState('selection', [anchorId, ...range.filter((x) => x !== anchorId)]);
        }
        setState('current', id);
      });
    },
    selectAll() {
      const ids = viewIds();
      setState('selection', [...ids]);
    },
    clearSelection() {
      setState('selection', []);
    },
    setView(v: ViewMode) {
      batch(() => {
        setState('view', v);
        setState('zoom', 'fit');
      });
    },
    setFilter(patch: Partial<Filter>) {
      setState('filter', (f) => ({ ...f, ...patch }));
    },
    resetFilter() {
      setState('filter', reconcile({ ...DEFAULT_FILTER }));
    },
    setSettings(patch: Partial<Settings>) {
      setState('settings', (s) => {
        const next = { ...s, ...patch };
        try {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    toast(msg: string, ms = 2200) {
      setState('toast', msg);
      const t = msg;
      setTimeout(() => {
        if (state.toast === t) setState('toast', '');
      }, ms);
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
  };

  return { state, actions, viewIds, viewIndex, counts, photo, currentPhoto, currentIndex, marksOf };
}

export const store = createRoot(createAppStore);
export type Store = typeof store;
