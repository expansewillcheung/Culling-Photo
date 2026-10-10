import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js';
import { session } from '../app/session';
import type { RenderEntry } from '../app/renderCache';
import { store } from '../store/store';
import { clipOverlay } from './clipping';

export interface View {
  /** 'fit' or zoom factor: 1 = 100% (one image pixel per device pixel). */
  zoom: 'fit' | number;
  /** View centre in normalised image coordinates. */
  cx: number;
  cy: number;
}

/**
 * Canvas image viewer: shows the thumbnail instantly, swaps to the screen-size render,
 * and loads the full-resolution render when zoomed in.
 */
export function ImageView(props: {
  id: number;
  view: View;
  onView: (v: View) => void;
  active?: boolean;
  onActivate?: () => void;
  showClipping?: boolean;
  hud?: boolean;
}) {
  let host!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const [size, setSize] = createSignal({ w: 0, h: 0, dpr: 1 });
  const [entry, setEntry] = createSignal<RenderEntry | undefined>();
  const [thumb, setThumb] = createSignal<HTMLImageElement | undefined>();
  const [loading, setLoading] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  let overlay: { id: number; canvas: OffscreenCanvas | HTMLCanvasElement } | undefined;

  const photo = () => store.state.photos[props.id];
  const isVideo = () => photo()?.kinds[photo()!.display] === 'video';

  onMount(() => {
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      setSize({ w: host.clientWidth, h: host.clientHeight, dpr });
    });
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });

  // Load thumbnail + screen render whenever the photo changes.
  createEffect(
    on(
      () => props.id,
      (id) => {
        const s = session;
        if (!s) return;
        overlay = undefined;
        const edge = s.screenEdge();
        const cached = s.renders.best(id, edge);
        setEntry(cached);
        const url = photo()?.thumbUrl;
        if (url && !cached) {
          const img = new Image();
          img.decoding = 'async';
          img.src = url;
          img.decode().then(
            () => props.id === id && setThumb(img),
            () => {},
          );
        } else setThumb(undefined);
        if (!cached || cached.edge < edge) {
          setLoading(true);
          s.getRender(id, edge).then((e) => {
            if (props.id !== id) return;
            setLoading(false);
            if (e && (!entry() || entry()!.edge !== 0)) setEntry(e);
          });
        }
        s.preloadAround(id);
      },
    ),
  );

  // Thumb may arrive after we opened the loupe.
  createEffect(() => {
    const url = photo()?.thumbUrl;
    if (url && !entry() && !thumb()) {
      const img = new Image();
      img.src = url;
      const id = props.id;
      img.decode().then(() => props.id === id && setThumb(img), () => {});
    }
  });

  // Full resolution when zoomed.
  createEffect(() => {
    const z = props.view.zoom;
    const id = props.id;
    const s = session;
    if (!s || z === 'fit') return;
    const e = entry();
    if (e && e.edge === 0) return;
    setLoading(true);
    s.getRender(id, 0, -200).then((full) => {
      if (props.id !== id) return;
      setLoading(false);
      if (full) setEntry(full);
    });
  });

  const geometry = () => {
    const { w, h, dpr } = size();
    const e = entry();
    const t = thumb();
    const p = photo();
    const iw = e?.sourceWidth || p?.sourceWidth || t?.naturalWidth || 1;
    const ih = e?.sourceHeight || p?.sourceHeight || t?.naturalHeight || 1;
    const W = w * dpr;
    const H = h * dpr;
    const fit = Math.min(W / iw, H / ih);
    const scale = props.view.zoom === 'fit' ? fit : props.view.zoom;
    return { W, H, iw, ih, fit, scale, dpr };
  };

  const clampCenter = (cx: number, cy: number, scale: number) => {
    const { W, H, iw, ih } = geometry();
    const hw = W / (2 * scale * iw);
    const hh = H / (2 * scale * ih);
    const nx = hw >= 0.5 ? 0.5 : Math.min(1 - hw, Math.max(hw, cx));
    const ny = hh >= 0.5 ? 0.5 : Math.min(1 - hh, Math.max(hh, cy));
    return [nx, ny] as const;
  };

  createEffect(() => {
    const { W, H, iw, ih, scale } = geometry();
    if (!canvas || !W || !H) return;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0b0c0e';
    ctx.fillRect(0, 0, W, H);
    const src: CanvasImageSource | undefined = entry()?.bitmap ?? thumb();
    if (!src) return;
    const [cx, cy] = props.view.zoom === 'fit' ? [0.5, 0.5] : clampCenter(props.view.cx, props.view.cy, scale);
    const dw = iw * scale;
    const dh = ih * scale;
    const dx = W / 2 - cx * dw;
    const dy = H / 2 - cy * dh;
    ctx.imageSmoothingEnabled = scale < 1.5;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, dx, dy, dw, dh);
    if (props.showClipping && entry()) {
      const id = props.id;
      if (!overlay || overlay.id !== id) overlay = { id, canvas: clipOverlay(entry()!.bitmap) };
      ctx.drawImage(overlay.canvas, dx, dy, dw, dh);
    }
  });

  // ---- interaction ----
  let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | undefined;

  const pointToImage = (clientX: number, clientY: number) => {
    const r = canvas.getBoundingClientRect();
    const { W, H, iw, ih, scale, dpr } = geometry();
    const [cx, cy] = props.view.zoom === 'fit' ? [0.5, 0.5] : clampCenter(props.view.cx, props.view.cy, scale);
    const x = (clientX - r.left) * dpr;
    const y = (clientY - r.top) * dpr;
    return [(x - W / 2) / (iw * scale) + cx, (y - H / 2) / (ih * scale) + cy] as const;
  };

  const onPointerDown = (e: PointerEvent) => {
    props.onActivate?.();
    if (e.button !== 0) return;
    const { scale } = geometry();
    const [cx, cy] = props.view.zoom === 'fit' ? [0.5, 0.5] : clampCenter(props.view.cx, props.view.cy, scale);
    drag = { x: e.clientX, y: e.clientY, cx, cy, moved: false };
    canvas.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag || props.view.zoom === 'fit') return;
    const { iw, ih, scale, dpr } = geometry();
    const dx = (e.clientX - drag.x) * dpr;
    const dy = (e.clientY - drag.y) * dpr;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      drag.moved = true;
      setDragging(true);
    }
    const [nx, ny] = clampCenter(drag.cx - dx / (iw * scale), drag.cy - dy / (ih * scale), scale);
    props.onView({ zoom: props.view.zoom, cx: nx, cy: ny });
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag;
    drag = undefined;
    setDragging(false);
    if (!d || d.moved) return;
    // Click toggles fit <-> 100% at the clicked point.
    if (props.view.zoom === 'fit') {
      const [x, y] = pointToImage(e.clientX, e.clientY);
      props.onView({ zoom: 1, cx: x, cy: y });
    } else props.onView({ zoom: 'fit', cx: 0.5, cy: 0.5 });
  };
  const onWheel = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey) && props.view.zoom === 'fit') return;
    e.preventDefault();
    const { scale, fit, iw, ih } = geometry();
    if (props.view.zoom !== 'fit' && !(e.ctrlKey || e.metaKey)) {
      // two-finger pan
      const [nx, ny] = clampCenter(props.view.cx + e.deltaX / (iw * scale), props.view.cy + e.deltaY / (ih * scale), scale);
      props.onView({ zoom: props.view.zoom, cx: nx, cy: ny });
      return;
    }
    const factor = Math.exp(-e.deltaY * 0.01);
    let next = scale * factor;
    if (next <= fit) {
      props.onView({ zoom: 'fit', cx: 0.5, cy: 0.5 });
      return;
    }
    next = Math.min(8, next);
    const [px, py] = pointToImage(e.clientX, e.clientY);
    const [cx, cy] = props.view.zoom === 'fit' ? [0.5, 0.5] : [props.view.cx, props.view.cy];
    // keep the point under the cursor fixed
    const k = scale / next;
    props.onView({ zoom: next, cx: px - (px - cx) * k, cy: py - (py - cy) * k });
  };

  const lowRes = () => {
    const e = entry();
    if (!e || props.view.zoom === 'fit') return false;
    return e.edge === 0 && Math.max(e.bitmap.width, e.bitmap.height) < Math.max(e.sourceWidth, e.sourceHeight) * 0.7;
  };
  const zoomLabel = () => {
    const { scale } = geometry();
    return `${Math.round(scale * 100)}%`;
  };

  return (
    <div
      class="viewer"
      ref={host}
      classList={{ zoomed: props.view.zoom !== 'fit', dragging: dragging(), active: props.active }}
      data-testid="viewer"
    >
      <Show when={!isVideo()} fallback={<VideoView id={props.id} />}>
        <canvas
          ref={canvas}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onDblClick={(e) => e.preventDefault()}
        />
      </Show>
      <Show when={props.hud !== false && photo()}>
        <Hud id={props.id} />
      </Show>
      <Show when={entry() || thumb()}>
        <div class="zoomtag">{props.view.zoom === 'fit' ? `适合 · ${zoomLabel()}` : zoomLabel()}</div>
      </Show>
      <Show when={!entry() && !thumb() && !loading() && photo()?.thumbState === 'error'}>
        <div class="empty">
          <div>无法预览这张照片</div>
          <div class="count">{photo()?.error}</div>
        </div>
      </Show>
      <Show when={loading()}>
        <div class="loading">加载中…</div>
      </Show>
      <Show when={lowRes()}>
        <div class="lowres">内嵌预览分辨率较低，100% 对焦检查可能不准确</div>
      </Show>
    </div>
  );
}

function Hud(props: { id: number }) {
  const p = () => store.state.photos[props.id];
  return (
    <div class="hud">
      <span>{p().stem}</span>
      <Show when={p().flag !== 0}>
        <span class="flag" classList={{ pick: p().flag === 1, reject: p().flag === -1 }}>{p().flag === 1 ? '✓ 保留' : '✕ 淘汰'}</span>
      </Show>
      <Show when={p().rating > 0}>
        <span class="stars">{'★'.repeat(p().rating)}</span>
      </Show>
    </div>
  );
}

function VideoView(props: { id: number }) {
  const [url, setUrl] = createSignal<string>();
  createEffect(
    on(
      () => props.id,
      (id) => {
        const s = session;
        const p = store.state.photos[id];
        if (!s || !p) return;
        const u = URL.createObjectURL(s.displayFile(p).file);
        setUrl(u);
        onCleanup(() => URL.revokeObjectURL(u));
      },
    ),
  );
  return <video src={url()} controls />;
}
