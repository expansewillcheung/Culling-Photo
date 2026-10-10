import { Show } from 'solid-js';
import { store } from '../store/store';

export function StatusBar() {
  const { state, counts, viewIds } = store;
  const pr = () => state.progress;
  const pct = () => (pr().total ? Math.round((pr().thumbsDone / pr().total) * 100) : 0);
  const secs = (t?: number) => (t ? ((t - pr().startedAt) / 1000).toFixed(1) + 's' : '');
  return (
    <footer class="status" data-testid="status">
      <span>
        显示 {viewIds().length} / {counts().total}
      </span>
      <Show when={state.selection.length > 1}>
        <span>已选 {state.selection.length}</span>
      </Show>
      <span class="pick">✓ {counts().picks}</span>
      <span class="reject">✕ {counts().rejects}</span>
      <span>★ {counts().rated}</span>
      <div class="spacer" />
      <Show when={pr().phase === 'listing'}>
        <span>正在扫描文件… {pr().listed}</span>
      </Show>
      <Show when={pr().total > 0 && pr().metaDone < pr().total}>
        <span>读取元数据 {pr().metaDone}/{pr().total}</span>
      </Show>
      <Show when={pr().total > 0 && pr().thumbsDone < pr().total}>
        <span>缩略图 {pr().thumbsDone}/{pr().total}</span>
        <div class="bar">
          <i style={{ width: `${pct()}%` }} />
        </div>
      </Show>
      <Show when={pr().allThumbsAt}>
        <span title="首屏缩略图 / 全部缩略图耗时">
          完成 · 首屏 {secs(pr().firstThumbAt)} · 全部 {secs(pr().allThumbsAt)}
        </span>
      </Show>
      <Show when={pr().errors > 0}>
        <span class="warn">{pr().errors} 个文件无法预览</span>
      </Show>
      <Show when={!state.persistent && state.screen === 'library'}>
        <span class="warn" title="标记只保存在内存/XMP 中：可能有其他标签页正在使用数据库">未持久化</span>
      </Show>
      <Show when={state.settings.autoAdvance}>
        <span>自动前进</span>
      </Show>
    </footer>
  );
}
