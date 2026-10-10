import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { store } from '../store/store';
import { session } from '../app/session';
import { appActions } from '../app/appActions';
import { Modal } from './Dialogs';
import {
  executeDelivery,
  exportCsv,
  exportXmpZip,
  planDelivery,
  readDeliveryLog,
  restoreDelivery,
  type DeliveryOptions,
  type DeliveryPhoto,
  type DeliveryProgress,
} from '../export';
import type { Photo } from '../store/types';

function toDelivery(p: Photo): DeliveryPhoto {
  return {
    key: p.key,
    marks: { rating: p.rating, flag: p.flag, label: p.label },
    files: p.item.files.map((f, i) => ({ relPath: f.relPath, kind: p.kinds[i], sidecarRelPath: p.item.sidecar?.relPath })),
  };
}

const OPTS_KEY = 'culling.deliver.v1';
function loadOpts(): DeliveryOptions {
  const d: DeliveryOptions = { picks: 'move', rejects: 'move', splitByRating: false, include: 'both', writeXmp: true, minRating: undefined };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') };
  } catch {
    return d;
  }
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export default function DeliverDialog() {
  const { state, actions } = store;
  const close = () => actions.setState('dialog', '');
  const [opts, setOpts] = createSignal<DeliveryOptions>(loadOpts());
  const [progress, setProgress] = createSignal<DeliveryProgress | null>(null);
  const [result, setResult] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const root = () => session?.source?.root;
  const [log, { refetch }] = createResource(root, (r) => readDeliveryLog(r).catch(() => undefined));
  const restorable = () => (log()?.runs ?? []).some((r) => r.status !== 'restored');

  const update = (patch: Partial<DeliveryOptions>) => {
    const next = { ...opts(), ...patch };
    setOpts(next);
    try {
      localStorage.setItem(OPTS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const plan = createMemo(() => planDelivery(state.photos.map(toDelivery), opts()));
  const hasPairs = () => state.photos.some((p) => p.item.files.length > 1);

  const run = async () => {
    const r = root();
    if (!r) return;
    setBusy(true);
    setResult('');
    try {
      await session?.flushMarks();
      const lg = await executeDelivery(r, plan(), (p) => setProgress(p));
      const run = lg.runs[lg.runs.length - 1];
      const st = run.stats;
      await refetch();
      setProgress(null);
      await appActions.reopen();
      setResult(
        `完成：移动 ${st.moved}，复制 ${st.copied}，XMP ${st.xmp}${st.failed ? `，失败 ${st.failed}` : ''}${st.nativeMoves < st.moved ? '（部分使用复制+删除）' : ''}。`,
      );
      actions.toast(`交付完成。在 Photomator 中打开「${opts().picksDir ?? '_Picks'}」文件夹即可。`, 5000);
    } catch (e) {
      setResult(`交付出错：${(e as Error).message}。可以点击「还原」撤销已完成的操作。`);
      await refetch();
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    const r = root();
    if (!r) return;
    if (!confirm('把上次交付移动的文件全部移回原位？')) return;
    setBusy(true);
    try {
      const res = await restoreDelivery(r, undefined, (p) => setProgress(p));
      setProgress(null);
      await refetch();
      await appActions.reopen();
      setResult(`已还原 ${res.reverted} 个操作${res.errors.length ? `，${res.errors.length} 个失败：${res.errors[0].error}` : ''}。`);
    } catch (e) {
      setResult(`还原出错：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const pct = () => {
    const p = progress();
    return p && p.total ? Math.round((p.done / p.total) * 100) : 0;
  };

  return (
    <Modal title="交付给 Photomator" onClose={() => !busy() && close()} wide>
      <Show
        when={state.writable}
        fallback={
          <>
            <p style={{ color: 'var(--text-2)' }}>
              当前是只读模式，不能移动文件或写入 sidecar。可以导出评分，再把 XMP 文件复制到照片文件夹，或者用 Chrome / Edge 以「打开文件夹」方式重新打开。
            </p>
            <div class="foot" style={{ 'justify-content': 'flex-start' }}>
              <button onClick={() => download(exportXmpZip(state.photos.map(toDelivery)), `${state.sourceName}-xmp.zip`)}>下载 XMP 压缩包</button>
              <button onClick={() => download(new Blob([exportCsv(state.photos.map(toDelivery))], { type: 'text/csv' }), `${state.sourceName}-marks.csv`)}>
                下载 CSV
              </button>
              <div style={{ flex: 1 }} />
              <button onClick={close}>关闭</button>
            </div>
          </>
        }
      >
        <div class="row">
          <label>保留的照片</label>
          <div class="seg">
            <For each={[['move', '移动'], ['copy', '复制'], ['none', '不处理']] as const}>
              {([v, l]) => (
                <button classList={{ on: opts().picks === v }} onClick={() => update({ picks: v })}>
                  {l}
                </button>
              )}
            </For>
          </div>
          <span class="count">到 _Picks/</span>
        </div>
        <div class="row">
          <label>淘汰的照片</label>
          <div class="seg">
            <For each={[['move', '移动'], ['none', '不处理']] as const}>
              {([v, l]) => (
                <button classList={{ on: opts().rejects === v }} onClick={() => update({ rejects: v })}>
                  {l}
                </button>
              )}
            </For>
          </div>
          <span class="count">到 _Rejects/（不会删除文件）</span>
        </div>
        <div class="row">
          <label>同时算作保留</label>
          <select value={opts().minRating ?? 0} onChange={(e) => update({ minRating: Number(e.currentTarget.value) || undefined })}>
            <option value="0">只算 ✓ 保留旗标</option>
            <For each={[1, 2, 3, 4, 5]}>{(n) => <option value={n}>✓ 或 ≥ {'★'.repeat(n)}</option>}</For>
          </select>
        </div>
        <div class="row">
          <label>按星级分文件夹</label>
          <input type="checkbox" checked={!!opts().splitByRating} onChange={(e) => update({ splitByRating: e.currentTarget.checked })} />
          <span class="count">_Picks/5★、4★ …</span>
        </div>
        <Show when={hasPairs()}>
          <div class="row">
            <label>RAW+JPEG</label>
            <div class="seg">
              <For each={[['both', '两个都交付'], ['raw', '只交付 RAW'], ['jpeg', '只交付 JPEG']] as const}>
                {([v, l]) => (
                  <button classList={{ on: opts().include === v }} onClick={() => update({ include: v })}>
                    {l}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
        <div class="row">
          <label>写入 XMP</label>
          <input type="checkbox" checked={!!opts().writeXmp} onChange={(e) => update({ writeXmp: e.currentTarget.checked })} />
          <span class="count">星级、色标、旗标随照片一起移动</span>
        </div>
        <div class="summary" data-testid="deliver-summary">
          将交付 <b>{plan().summary.picks}</b> 张保留、<b>{plan().summary.rejects}</b> 张淘汰，共 <b>{plan().summary.files}</b> 个文件操作，
          <b>{plan().summary.xmp}</b> 个 XMP。所有操作都记录在 _culling-log.json 中，可以还原。
        </div>
        <Show when={progress()}>
          <div class="progress">
            <i style={{ width: `${pct()}%` }} />
          </div>
          <div class="count" style={{ 'margin-top': '4px' }}>
            {progress()!.phase === 'restore' ? '还原' : progress()!.phase === 'xmp' ? '写入 XMP' : '移动'} {progress()!.done}/{progress()!.total} {progress()!.current ?? ''}
          </div>
        </Show>
        <Show when={result()}>
          <div class="summary" data-testid="deliver-result">{result()}</div>
        </Show>
        <div class="foot">
          <Show when={restorable()}>
            <button onClick={restore} disabled={busy()} data-testid="restore-btn">
              还原上次交付
            </button>
          </Show>
          <div style={{ flex: 1 }} />
          <button onClick={close} disabled={busy()}>
            关闭
          </button>
          <button class="primary" onClick={run} disabled={busy() || plan().summary.files + plan().summary.xmp === 0} data-testid="deliver-run">
            {busy() ? '处理中…' : '开始交付'}
          </button>
        </div>
      </Show>
    </Modal>
  );
}
