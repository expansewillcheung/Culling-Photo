import { createMemo, For } from 'solid-js';
import { store } from '../store/store';
import { ImageView } from './ImageView';
import { Filmstrip, loupeView, setLoupeView } from './Loupe';

/** Up to 4 photos side by side with synchronised zoom/pan. */
export function Compare() {
  const { state } = store;
  const ids = createMemo(() => store.compareIds());
  const cols = () => (ids().length <= 2 ? ids().length : 2);
  const rows = () => (ids().length <= 2 ? 1 : 2);
  return (
    <div class="loupe">
      <div class="compare" style={{ 'grid-template-columns': `repeat(${cols()}, 1fr)`, 'grid-template-rows': `repeat(${rows()}, 1fr)`, position: 'relative' }}>
        <For each={ids()}>
          {(id) => (
            <ImageView
              id={id}
              view={loupeView()}
              onView={setLoupeView}
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
