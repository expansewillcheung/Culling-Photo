import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { store } from '../store/store';
import { ImageView, type View } from './ImageView';

export const [loupeView, setLoupeView] = createSignal<View>({ zoom: 'fit', cx: 0.5, cy: 0.5 });

export function Loupe() {
  const { state } = store;
  // Reset zoom when moving to another photo unless "sticky" (shift held is handled by keyboard).
  createEffect(on(() => state.current, () => setLoupeView((v) => (v.zoom === 'fit' ? v : { ...v })), { defer: true }));
  return (
    <div class="loupe">
      <Show when={state.current >= 0} fallback={<div class="empty">没有照片</div>}>
        <ImageView id={state.current} view={loupeView()} onView={setLoupeView} showClipping={state.settings.showClipping} />
      </Show>
      <Filmstrip />
    </div>
  );
}

export function Filmstrip() {
  const { state, actions, viewIds } = store;
  const W = 112;
  const span = 14;
  const idx = () => store.currentIndex();
  const items = createMemo(() => {
    const ids = viewIds();
    const i = Math.max(0, idx());
    const lo = Math.max(0, i - span);
    return ids.slice(lo, i + span + 1).map((id, k) => ({ id, index: lo + k }));
  });
  let host!: HTMLDivElement;
  const [hostW, setHostW] = createSignal(1200);
  onMount(() => {
    const ro = new ResizeObserver(() => setHostW(host.clientWidth));
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });
  const offset = () => hostW() / 2 - W / 2 - Math.max(0, idx()) * W;
  return (
    <div class="filmstrip" ref={host}>
      <div class="track" style={{ transform: `translateX(${offset()}px)`, width: '0' }}>
        <For each={items()}>
          {(it) => {
            const p = () => state.photos[it.id];
            return (
              <div
                class="fs"
                classList={{ current: state.current === it.id, rejected: p().flag === -1 }}
                style={{ position: 'absolute', left: `${it.index * W}px` }}
                onClick={(e) => actions.select(it.id, e.metaKey || e.ctrlKey ? 'toggle' : e.shiftKey ? 'range' : 'single')}
              >
                <Show when={p().thumbUrl}>
                  <img src={p().thumbUrl} draggable={false} alt="" />
                </Show>
                <Show when={p().flag !== 0}>
                  <span class="flag" classList={{ pick: p().flag === 1, reject: p().flag === -1 }}>{p().flag === 1 ? '✓' : '✕'}</span>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
