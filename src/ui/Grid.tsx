import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { store } from '../store/store';
import { session } from '../app/session';
import type { Photo } from '../store/types';
import { LABEL_COLORS } from './labels';

const GAP = 6;
const FOOT = 24;

export function Grid() {
  const { state, actions, viewIds } = store;
  let scroller!: HTMLDivElement;
  const [width, setWidth] = createSignal(800);
  const [height, setHeight] = createSignal(600);
  const [scrollTop, setScrollTop] = createSignal(0);

  const cell = () => state.settings.thumbSize;
  const cols = createMemo(() => Math.max(1, Math.floor((width() - GAP) / (cell() + GAP))));
  const cellW = createMemo(() => (width() - GAP) / cols() - GAP);
  const cellH = createMemo(() => cellW() * 0.82 + FOOT);
  const rows = createMemo(() => Math.ceil(viewIds().length / cols()));

  const range = createMemo(() => {
    const rh = cellH() + GAP;
    const first = Math.max(0, Math.floor(scrollTop() / rh) - 1);
    const last = Math.min(rows() - 1, Math.ceil((scrollTop() + height()) / rh) + 1);
    return { first, last };
  });

  const visible = createMemo(() => {
    const { first, last } = range();
    const ids = viewIds();
    return ids.slice(first * cols(), (last + 1) * cols());
  });

  // Request thumbnails for visible cells (+ a few rows ahead in scroll direction).
  let lastTop = 0;
  createEffect(() => {
    const vis = visible();
    const s = session;
    if (!s) return;
    const ids = viewIds();
    const { last, first } = range();
    const down = scrollTop() >= lastTop;
    lastTop = scrollTop();
    const aheadRows = 4;
    const ahead = down
      ? ids.slice((last + 1) * cols(), (last + 1 + aheadRows) * cols())
      : ids.slice(Math.max(0, (first - aheadRows) * cols()), first * cols());
    s.setVisible(vis, ahead);
  });

  // Keep the current photo in view.
  createEffect(
    on(
      () => [state.current, cols(), cellH(), store.viewIndex().get(state.current)] as const,
      ([cur]) => {
        const i = store.viewIndex().get(cur);
        if (i === undefined || !scroller) return;
        const rh = cellH() + GAP;
        const top = Math.floor(i / cols()) * rh;
        if (top < scroller.scrollTop) scroller.scrollTop = top;
        else if (top + rh > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + rh - scroller.clientHeight + GAP;
      },
    ),
  );

  onMount(() => {
    const ro = new ResizeObserver(() => {
      setWidth(scroller.clientWidth);
      setHeight(scroller.clientHeight);
    });
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
    scroller.focus({ preventScroll: true });
  });

  const selected = createMemo(() => new Set(state.selection));
  // Expose grid columns for keyboard up/down navigation.
  createEffect(() => ((window as any).__gridCols = cols()));

  const pos = (i: number) => {
    const c = i % cols();
    const r = Math.floor(i / cols());
    return { left: GAP + c * (cellW() + GAP), top: GAP + r * (cellH() + GAP) };
  };

  const onClick = (e: MouseEvent, id: number) => {
    if (e.metaKey || e.ctrlKey) actions.select(id, 'toggle');
    else if (e.shiftKey) actions.select(id, 'range');
    else actions.select(id);
  };

  return (
    <div class="grid-scroll" ref={scroller} tabindex="-1" onScroll={() => setScrollTop(scroller.scrollTop)} data-testid="grid">
      <Show when={viewIds().length === 0 && state.photos.length === 0 && state.progress.phase !== 'listing'}>
        <div class="empty">
          <div>这个文件夹（包括子文件夹）里没有可以识别的照片或视频</div>
        </div>
      </Show>
      <Show when={viewIds().length === 0 && state.photos.length > 0}>
        <div class="empty">
          <div>没有符合筛选条件的照片</div>
          <button onClick={() => actions.resetFilter()}>清除筛选</button>
        </div>
      </Show>
      <div class="grid-inner" style={{ height: `${rows() * (cellH() + GAP) + GAP}px` }}>
        <For each={visible()}>
          {(id) => {
            const p = () => state.photos[id];
            const idx = () => store.viewIndex().get(id) ?? 0;
            return (
              <Cell
                photo={p()}
                style={{ ...px(pos(idx())), width: `${cellW()}px`, height: `${cellH()}px` }}
                current={state.current === id}
                selected={selected().has(id)}
                onClick={(e) => onClick(e, id)}
                onDblClick={() => {
                  actions.select(id);
                  actions.setView('loupe');
                }}
              />
            );
          }}
        </For>
      </div>
    </div>
  );
}

function px(o: { left: number; top: number }) {
  return { transform: `translate(${o.left}px, ${o.top}px)` };
}

function Cell(props: {
  photo: Photo;
  style: Record<string, string>;
  current: boolean;
  selected: boolean;
  onClick: (e: MouseEvent) => void;
  onDblClick: () => void;
}) {
  const p = () => props.photo;
  const kindBadge = () => {
    const k = p().kinds;
    const ext = p().item.files.map((f) => f.name.split('.').pop()!.toUpperCase());
    if (k.length > 1 && k.includes('raw')) return `${ext[p().item.rawIndex]}+${k.includes('jpeg') ? 'J' : ext.find((_, i) => i !== p().item.rawIndex)}`;
    return ext[0];
  };
  return (
    <div
      class="cell"
      classList={{ current: props.current, selected: props.selected, rejected: p().flag === -1 }}
      style={{ ...props.style, left: '0', top: '0' }}
      onClick={props.onClick}
      onDblClick={props.onDblClick}
      data-id={p().id}
      data-testid="cell"
    >
      <div class="img">
        <Show
          when={p().thumbUrl}
          fallback={
            p().thumbState === 'error' ? <div class="err">无法预览<br />{p().error?.slice(0, 60)}</div> : <div class="ph" />
          }
        >
          <img src={p().thumbUrl} decoding="async" draggable={false} alt="" />
        </Show>
      </div>
      <div class="badges">
        <span class="badge">{kindBadge()}</span>
        <Show when={(p().groupSize ?? 0) > 1}>
          <span class="badge group" classList={{ best: p().groupBest }} title={p().groupBest ? '连拍组中的推荐照片' : '连拍组'}>
            {p().groupBest ? '★ ' : ''}×{p().groupSize}
          </span>
        </Show>
        <Show when={p().suggestion}>
          <span class="badge warn" title="智能筛选建议">{SUGGESTION_LABEL[p().suggestion!] ?? p().suggestion}</span>
        </Show>
      </div>
      <Show when={p().flag !== 0}>
        <span class="flag" classList={{ pick: p().flag === 1, reject: p().flag === -1 }}>{p().flag === 1 ? '✓' : '✕'}</span>
      </Show>
      <div class="foot">
        <span class="name" title={p().item.files.map((f) => f.relPath).join('\n')}>{p().stem}</span>
        <Show when={p().rating > 0}>
          <span class="stars">{'★'.repeat(p().rating)}</span>
        </Show>
      </div>
      <Show when={p().label}>
        <div class="labelbar" style={{ background: LABEL_COLORS[p().label] }} />
      </Show>
    </div>
  );
}

export const SUGGESTION_LABEL: Record<string, string> = {
  blurry: '模糊',
  'eyes-closed': '闭眼',
  duplicate: '重复',
  overexposed: '过曝',
  underexposed: '欠曝',
};
