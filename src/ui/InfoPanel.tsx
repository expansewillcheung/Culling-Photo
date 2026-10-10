import { createEffect, For, Show } from 'solid-js';
import { store } from '../store/store';
import { formatBytes, formatShutter } from '../core/util';
import { LABEL_NAMES } from './labels';
import { SUGGESTION_LABEL } from './Grid';

export function InfoPanel() {
  const p = () => store.currentPhoto();
  let hist!: HTMLCanvasElement;

  createEffect(() => {
    const h = p()?.histogram;
    if (!hist) return;
    const W = (hist.width = hist.clientWidth * devicePixelRatio || 560);
    const H = (hist.height = 90 * devicePixelRatio);
    const ctx = hist.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    if (!h) return;
    let max = 1;
    for (let i = 0; i < 1024; i++) if (i % 256 > 1 && i % 256 < 254) max = Math.max(max, h[i]);
    ctx.globalCompositeOperation = 'lighter';
    const colors = ['rgba(255,70,70,.75)', 'rgba(70,220,90,.7)', 'rgba(80,140,255,.75)'];
    for (let c = 0; c < 3; c++) {
      ctx.fillStyle = colors[c];
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * W, H - Math.min(1, h[c * 256 + i] / max) * H);
      ctx.lineTo(W, H);
      ctx.fill();
    }
  });

  return (
    <aside class="info" data-testid="info">
      <Show when={p()} fallback={<div class="empty">未选择照片</div>}>
        <h3>直方图</h3>
        <canvas ref={hist} />
        <h3>拍摄信息</h3>
        <dl>
          <dt>文件名</dt>
          <dd>{p()!.stem}</dd>
          <Show when={p()!.exif.captureTime}>
            <dt>拍摄时间</dt>
            <dd>{new Date(p()!.exif.captureTime!).toISOString().replace('T', ' ').slice(0, 19)}</dd>
          </Show>
          <dt>相机</dt>
          <dd>{[p()!.exif.make, p()!.exif.model].filter(Boolean).join(' ') || '—'}</dd>
          <dt>镜头</dt>
          <dd>{p()!.exif.lens || '—'}</dd>
          <dt>曝光</dt>
          <dd>
            {[
              p()!.exif.focalLength ? `${Math.round(p()!.exif.focalLength!)}mm` : '',
              p()!.exif.fNumber ? `f/${p()!.exif.fNumber}` : '',
              formatShutter(p()!.exif.exposureTime),
              p()!.exif.iso ? `ISO ${p()!.exif.iso}` : '',
            ]
              .filter(Boolean)
              .join('  ') || '—'}
          </dd>
          <dt>尺寸</dt>
          <dd>{p()!.exif.width ? `${p()!.exif.width} × ${p()!.exif.height}` : '—'}</dd>
          <dt>评分</dt>
          <dd>
            {p()!.flag === 1 ? '✓ 保留' : p()!.flag === -1 ? '✕ 淘汰' : '未标记'} · {p()!.rating ? '★'.repeat(p()!.rating) : '无星'}
            {p()!.label ? ` · ${LABEL_NAMES[p()!.label]}` : ''}
          </dd>
        </dl>
        <h3>分析</h3>
        <dl>
          <dt>清晰度</dt>
          <dd>{p()!.blurScore !== undefined ? p()!.blurScore!.toFixed(2) + (p()!.blurScore! < 0.3 ? '（可能模糊）' : '') : '—'}</dd>
          <dt>连拍组</dt>
          <dd>{(p()!.groupSize ?? 0) > 1 ? `${p()!.groupSize} 张${p()!.groupBest ? '（推荐）' : ''}` : '—'}</dd>
          <Show when={p()!.faceCount !== undefined}>
            <dt>人脸</dt>
            <dd>{p()!.faceCount}{p()!.eyesClosed ? '（闭眼）' : ''}</dd>
          </Show>
          <Show when={p()!.exposure}>
            <dt>高光溢出</dt>
            <dd>{(p()!.exposure!.clippedHighlights * 100).toFixed(1)}%</dd>
          </Show>
          <Show when={p()!.suggestion}>
            <dt>建议</dt>
            <dd style={{ color: '#ffcf6e' }}>{SUGGESTION_LABEL[p()!.suggestion!]}</dd>
          </Show>
        </dl>
        <h3>文件</h3>
        <div class="files">
          <For each={p()!.item.files}>
            {(f, i) => (
              <div>
                {f.relPath} · {formatBytes(f.size)}
                {p()!.formats[i()] ? ` · ${p()!.formats[i()]}` : ''}
              </div>
            )}
          </For>
          <Show when={p()!.item.sidecar}>
            <div>{p()!.item.sidecar!.relPath}</div>
          </Show>
        </div>
      </Show>
    </aside>
  );
}
