import { createMemo, createSignal, For } from 'solid-js';
import { store } from '../store/store';
import { ImageView, type View } from './ImageView';
import { Filmstrip } from './Loupe';

/** Up to 4 photos side by side with synchronised zoom/pan. */
export function Compare() {
  const { state, viewIds } = store;
  const [view, setView] = createSignal<View>({ zoom: 'fit', cx: 0.5, cy: 0.5 });
  const ids = createMemo(() => {
    if (state.selection.length >= 2) return state.selection.slice(0, 4);
    // No multi-selection: compare current with the next photo.
    const all = viewIds();
    const i = Math.max(0, store.currentIndex());
    return all.slice(i, i + 2);
  });
  const cols = () => (ids().length <= 2 ? ids().length : 2);
  const rows = () => (ids().length <= 2 ? 1 : 2);
  return (
    <div class="loupe">
      <div class="compare" style={{ 'grid-template-columns': `repeat(${cols()}, 1fr)`, 'grid-template-rows': `repeat(${rows()}, 1fr)`, position: 'relative' }}>
        <For each={ids()}>
          {(id) => (
            <ImageView
              id={id}
              view={view()}
              onView={setView}
              active={state.current === id}
              onActivate={() => store.actions.setState('current', id)}
              showClipping={state.settings.showClipping}
            />
          )}
        </For>
      </div>
      <Filmstrip />
    </div>
  );
}
