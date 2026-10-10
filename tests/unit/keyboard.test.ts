import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { store } from '../../src/store/store';

// Loupe.tsx pulls in the DOM renderer; keyboard only needs its view signal.
vi.mock('../../src/ui/Loupe', async () => {
  const { createSignal } = await import('solid-js');
  const [loupeView, setLoupeView] = createSignal<any>({ zoom: 'fit', cx: 0.5, cy: 0.5 });
  return { loupeView, setLoupeView };
});

const { state, actions } = store;
let handleKey: (e: KeyboardEvent) => boolean;

beforeAll(async () => {
  (globalThis as any).window ??= globalThis;
  ({ handleKey } = await import('../../src/ui/keyboard'));
});

const key = (k: string, repeat = false) => ({ key: k, repeat, target: null, shiftKey: false, metaKey: false, ctrlKey: false }) as unknown as KeyboardEvent;
const photo = (id: number) => ({ id, key: `/p${id}`, stem: `p${id}`, dirRel: '', kinds: ['jpeg'], exif: {}, rating: 0, flag: 0, label: '', thumbState: 'none', aspect: 1.5 }) as any;

afterEach(() => {
  actions.setState({ photos: [], current: -1, selection: [], screen: 'welcome' });
  actions.setSettings({ autoAdvance: false });
});

it('holding P (key repeat) leaves the photo picked instead of toggling it on and off', () => {
  actions.setState({ screen: 'library', photos: [photo(0), photo(1)], current: 0, selection: [] });
  actions.setSettings({ autoAdvance: false });
  handleKey(key('p'));
  handleKey(key('p', true));
  handleKey(key('p', true));
  handleKey(key('p', true));
  expect(state.photos[0].flag).toBe(1);
});

it('holding a settings toggle does not flip it on every repeat', () => {
  actions.setState({ screen: 'library', photos: [photo(0)], current: 0, selection: [] });
  const before = state.settings.showInfo;
  handleKey(key('i'));
  handleKey(key('i', true));
  expect(state.settings.showInfo).toBe(!before);
  handleKey(key('i'));
});
