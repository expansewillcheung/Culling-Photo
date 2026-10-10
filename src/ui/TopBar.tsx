import { createMemo, For, Show } from 'solid-js';
import { store } from '../store/store';
import type { SortKey } from '../store/types';
import { LABEL_COLORS, LABEL_KEYS, LABEL_NAMES } from './labels';

export function TopBar(props: { onClose: () => void }) {
  const { state, actions, counts } = store;
  const cameras = createMemo(() => [...new Set(state.photos.map((p) => p.exif.model).filter(Boolean) as string[])].sort());
  const lenses = createMemo(() => [...new Set(state.photos.map((p) => p.exif.lens).filter(Boolean) as string[])].sort());
  const kinds = createMemo(() => [...new Set(state.photos.flatMap((p) => p.kinds))].sort());
  const f = () => state.filter;

  return (
    <header class="topbar">
      <button class="ghost" title="关闭文件夹" onClick={props.onClose}>
        ‹
      </button>
      <div class="title" title={state.sourceName}>
        {state.sourceName}
        <Show when={!state.writable}>
          <span class="count">（只读）</span>
        </Show>
      </div>
      <div class="seg" role="group" aria-label="视图">
        <button classList={{ on: state.view === 'grid' }} onClick={() => actions.setView('grid')} title="网格 (G)">网格</button>
        <button classList={{ on: state.view === 'loupe' }} onClick={() => actions.setView('loupe')} title="放大 (E)">放大</button>
        <button classList={{ on: state.view === 'compare' }} onClick={() => actions.setView('compare')} title="对比 (C)">对比</button>
      </div>
      <div class="sep" />
      <div class="seg" role="group" aria-label="旗标筛选">
        <button classList={{ on: f().flag === 'all' }} onClick={() => actions.setFilter({ flag: 'all' })}>
          全部<span class="count">{counts().total}</span>
        </button>
        <button classList={{ on: f().flag === 'picks' }} onClick={() => actions.setFilter({ flag: 'picks' })}>
          保留<span class="count">{counts().picks}</span>
        </button>
        <button classList={{ on: f().flag === 'unflagged' }} onClick={() => actions.setFilter({ flag: 'unflagged' })}>
          未标记<span class="count">{counts().unflagged}</span>
        </button>
        <button classList={{ on: f().flag === 'rejects' }} onClick={() => actions.setFilter({ flag: 'rejects' })}>
          淘汰<span class="count">{counts().rejects}</span>
        </button>
        <button classList={{ on: f().flag === 'notRejected' }} onClick={() => actions.setFilter({ flag: 'notRejected' })} title="隐藏淘汰的照片">
          非淘汰
        </button>
      </div>
      <div class="stars-filter" title="最低星级" aria-label="最低星级">
        <For each={[1, 2, 3, 4, 5]}>
          {(n) => (
            <button classList={{ on: f().minRating >= n }} onClick={() => actions.setFilter({ minRating: f().minRating === n ? 0 : n })}>
              ★
            </button>
          )}
        </For>
      </div>
      <div class="labels-filter hide-sm">
        <For each={LABEL_KEYS}>
          {(l) => (
            <button
              class="dot"
              classList={{ on: f().labels.includes(l) }}
              style={{ background: LABEL_COLORS[l] }}
              title={`色标：${LABEL_NAMES[l]}`}
              onClick={() => actions.setFilter({ labels: f().labels.includes(l) ? f().labels.filter((x) => x !== l) : [...f().labels, l] })}
            />
          )}
        </For>
      </div>
      <button classList={{ on: f().stacks }} onClick={() => actions.setFilter({ stacks: !f().stacks })} title="连拍折叠：每组只显示推荐照片 (S)">
        连拍折叠
      </button>
      <button classList={{ on: f().onlySuggested }} onClick={() => actions.setFilter({ onlySuggested: !f().onlySuggested })} title="只看智能筛选建议淘汰的照片">
        建议淘汰
      </button>
      <div class="spacer" />
      <select class="hide-sm" value={f().kinds[0] ?? ''} onChange={(e) => actions.setFilter({ kinds: e.currentTarget.value ? [e.currentTarget.value as any] : [] })} title="文件类型">
        <option value="">所有类型</option>
        <For each={kinds()}>{(k) => <option value={k}>{k.toUpperCase()}</option>}</For>
      </select>
      <Show when={cameras().length > 1}>
        <select class="hide-sm" value={f().camera} onChange={(e) => actions.setFilter({ camera: e.currentTarget.value })} title="相机">
          <option value="">所有相机</option>
          <For each={cameras()}>{(c) => <option value={c}>{c}</option>}</For>
        </select>
      </Show>
      <Show when={lenses().length > 1}>
        <select class="hide-sm" value={f().lens} onChange={(e) => actions.setFilter({ lens: e.currentTarget.value })} title="镜头">
          <option value="">所有镜头</option>
          <For each={lenses()}>{(c) => <option value={c}>{c}</option>}</For>
        </select>
      </Show>
      <input
        type="search"
        placeholder="搜索文件名"
        value={f().text}
        onInput={(e) => actions.setFilter({ text: e.currentTarget.value })}
        style={{ width: '130px' }}
        class="hide-sm"
      />
      <select value={state.sort} onChange={(e) => actions.setState('sort', e.currentTarget.value as SortKey)} title="排序">
        <option value="time">按拍摄时间</option>
        <option value="name">按文件名</option>
        <option value="rating">按评分</option>
        <option value="sharpness">按清晰度</option>
        <option value="type">按类型</option>
      </select>
      <button class="ghost" onClick={() => actions.setState('sortDesc', !state.sortDesc)} title="升序 / 降序">
        {state.sortDesc ? '↓' : '↑'}
      </button>
      <input
        type="range"
        min="100"
        max="480"
        step="20"
        value={state.settings.thumbSize}
        onInput={(e) => actions.setSettings({ thumbSize: Number(e.currentTarget.value) })}
        title="缩略图大小"
        class="hide-sm"
        style={{ width: '80px' }}
      />
      <button classList={{ on: state.settings.showInfo }} onClick={() => actions.setSettings({ showInfo: !state.settings.showInfo })} title="信息面板 (I)">
        信息
      </button>
      <button class="ghost" onClick={() => actions.setState('dialog', 'settings')} title="设置">⚙</button>
      <button class="ghost" onClick={() => actions.setState('dialog', 'help')} title="快捷键 (?)">?</button>
      <button class="primary" onClick={() => actions.setState('dialog', 'deliver')} data-testid="deliver-btn">
        交付
      </button>
    </header>
  );
}
