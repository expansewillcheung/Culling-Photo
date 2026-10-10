import { For } from 'solid-js';
import { store } from '../store/store';
import { SHORTCUTS } from './keyboard';
import { cacheDrop, cacheUsage } from '../cache/opfs';
import { createResource } from 'solid-js';
import { formatBytes } from '../core/util';

export function Modal(props: { title: string; children: any; onClose: () => void; wide?: boolean }) {
  return (
    <div class="backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="dialog" role="dialog" aria-label={props.title} style={props.wide ? { width: 'min(760px, 100%)' } : {}}>
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

export function HelpDialog() {
  const close = () => store.actions.setState('dialog', '');
  return (
    <Modal title="快捷键" onClose={close}>
      <table>
        <tbody>
          <For each={SHORTCUTS}>
            {([k, d]) => (
              <tr>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{d}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <div class="foot">
        <button onClick={close}>关闭</button>
      </div>
    </Modal>
  );
}

export function SettingsDialog(props: { onAnalyzeFaces: () => void }) {
  const { state, actions } = store;
  const close = () => actions.setState('dialog', '');
  const [usage, { refetch }] = createResource(cacheUsage);
  const s = () => state.settings;
  return (
    <Modal title="设置" onClose={close}>
      <div class="row">
        <label>自动前进</label>
        <input type="checkbox" checked={s().autoAdvance} onChange={(e) => actions.setSettings({ autoAdvance: e.currentTarget.checked })} />
        <span class="count">标记后自动跳到下一张</span>
      </div>
      <div class="row">
        <label>写入 XMP sidecar</label>
        <input type="checkbox" checked={s().writeXmp} disabled={!state.writable} onChange={(e) => actions.setSettings({ writeXmp: e.currentTarget.checked })} />
        <span class="count">标记后自动写入 照片名.xmp（Lightroom / Capture One / darktable 都能读取）</span>
      </div>
      <div class="row">
        <label>清晰度 / 连拍分析</label>
        <input type="checkbox" checked={s().analyze} onChange={(e) => actions.setSettings({ analyze: e.currentTarget.checked })} />
      </div>
      <div class="row">
        <label>连拍间隔</label>
        <input
          type="number"
          min="200"
          max="10000"
          step="100"
          value={s().burstGapMs}
          onChange={(e) => actions.setSettings({ burstGapMs: Number(e.currentTarget.value) || 2000 })}
          style={{ width: '90px' }}
        />
        <span class="count">毫秒</span>
      </div>
      <div class="row">
        <label>闭眼检测</label>
        <button onClick={() => (close(), props.onAnalyzeFaces())} disabled={state.photos.length === 0}>
          分析人脸…
        </button>
        <span class="count">首次使用需下载约 4 MB 模型（MediaPipe）</span>
      </div>
      <div class="row">
        <label>缓存</label>
        <span>{usage() ? `${formatBytes(usage()!.usage)} / ${formatBytes(usage()!.quota)}` : '…'}</span>
        <button onClick={async () => (await cacheDrop(), refetch(), actions.toast('缓存已清除'))}>清除缩略图缓存</button>
      </div>
      <div class="foot">
        <button onClick={close}>完成</button>
      </div>
    </Modal>
  );
}
