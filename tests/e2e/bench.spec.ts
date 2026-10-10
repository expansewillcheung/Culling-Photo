import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const COUNT = Number(process.env.BENCH_COUNT ?? 3000);
const MIX = process.env.BENCH_MIX ?? 'all';
const DIR = path.resolve(`bench-data/shoot-${MIX}-${COUNT}`);

test.beforeAll(() => {
  if (!fs.existsSync(DIR) || fs.readdirSync(DIR).length < COUNT) {
    execFileSync('node', ['scripts/make-bench-dir.mjs', DIR, String(COUNT)], { stdio: 'inherit' });
  }
});

test(`bench: open ${COUNT} photos, thumbnails, loupe, keys`, async ({ page }) => {
  test.setTimeout(1_800_000);
  const logs: string[] = [];
  page.on('console', (m) => m.type() === 'error' && logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(String(e)));
  await page.goto('/');
  // Fresh cache for a cold run unless BENCH_WARM=1
  if (process.env.BENCH_WARM !== '1') {
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('culling-cache', { recursive: true }).catch(() => {});
    });
  }
  await page.evaluate(() => {
    (window as any).__longtasks = [];
    new PerformanceObserver((l) => (window as any).__longtasks.push(...l.getEntries().map((e) => e.duration))).observe({ type: 'longtask', buffered: false });
    (window as any).__events = [];
    new PerformanceObserver((l) => (window as any).__events.push(...l.getEntries().map((e: any) => ({ name: e.name, d: e.duration, p: e.processingEnd - e.processingStart }))))
      .observe({ type: 'event', durationThreshold: 16, buffered: false } as any);
  });

  const t0 = Date.now();
  await page.getByTestId('open-readonly').setInputFiles(DIR);
  await page.waitForFunction(() => (window as any).__culling?.store.state.screen === 'library', null, { timeout: 120_000 });
  const tLibrary = Date.now() - t0;
  // first screen of thumbnails
  await page.waitForFunction(() => {
    const cells = [...document.querySelectorAll('[data-testid=cell]')];
    return cells.length > 0 && cells.slice(0, 20).every((c) => c.querySelector('img'));
  }, null, { timeout: 120_000, polling: 50 });
  const tFirstScreen = Date.now() - t0;

  // Scroll test while background thumbnailing runs.
  await page.evaluate(() => ((window as any).__longtasks.length = 0));
  const grid = page.getByTestId('grid');
  await grid.hover();
  for (let i = 0; i < 20; i++) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(50);
  }
  const scrollLong = await page.evaluate(() => (window as any).__longtasks.slice());
  await page.keyboard.press('Home');

  await page.waitForFunction(() => {
    const p = (window as any).__culling.store.state.progress;
    return p.metaDone >= p.total;
  }, null, { timeout: 300_000, polling: 250 });
  const tMeta = Date.now() - t0;
  for (;;) {
    const pr = await page.evaluate(() => ({ ...(window as any).__culling.store.state.progress }));
    if (pr.allThumbsAt) break;
    console.log(`t=${((Date.now() - t0) / 1000).toFixed(0)}s thumbs ${pr.thumbsDone}/${pr.total} errors ${pr.errors}`);
    await page.waitForTimeout(10_000);
  }
  const tAll = Date.now() - t0;
  const progress = await page.evaluate(() => ({ ...(window as any).__culling.store.state.progress }));

  // Keyboard marking latency (Event Timing API)
  await page.evaluate(() => ((window as any).__events.length = 0));
  for (const k of ['p', '3', 'ArrowRight', 'x', 'ArrowRight', '6', 'ArrowRight', 'u']) await page.keyboard.press(k);
  await page.waitForTimeout(300);
  const slowEvents = await page.evaluate(() => (window as any).__events.slice());

  // Loupe: open, let it preload, then measure next-photo latency.
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const loupe: number[] = [];
  const loupeCold: number[] = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(i < 6 ? 700 : 0); // first 6: preloaded; last 6: rapid fire
    const ms = await page.evaluate(async () => {
      const c = (window as any).__culling;
      const s = c.session;
      const t = performance.now();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      const id = c.store.state.current;
      const edge = s.screenEdge();
      for (;;) {
        if (s.renders.get(id, edge)) return performance.now() - t;
        await new Promise((r) => requestAnimationFrame(r));
        if (performance.now() - t > 10000) return -1;
      }
    });
    (i < 6 ? loupe : loupeCold).push(Math.round(ms));
  }
  // 100% zoom latency
  const zoomMs = await page.evaluate(async () => {
    const c = (window as any).__culling;
    const t = performance.now();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    for (;;) {
      if (c.session.renders.get(c.store.state.current, 0)) return performance.now() - t;
      await new Promise((r) => setTimeout(r, 5));
      if (performance.now() - t > 15000) return -1;
    }
  });

  const mem = await page.evaluate(async () => {
    const m = (performance as any).measureUserAgentSpecificMemory ? await (performance as any).measureUserAgentSpecificMemory().catch(() => null) : null;
    return { uaBytes: m?.bytes ?? null, jsHeap: (performance as any).memory?.usedJSHeapSize ?? null, isolated: crossOriginIsolated };
  });
  const errorCells = await page.evaluate(() => (window as any).__culling.store.state.photos.filter((p: any) => p.thumbState === 'error').map((p: any) => `${p.stem}: ${p.error}`).slice(0, 10));

  const result = {
    count: COUNT,
    mix: MIX,
    cores: await page.evaluate(() => navigator.hardwareConcurrency),
    tLibraryMs: tLibrary,
    tFirstScreenMs: tFirstScreen,
    tMetaAllMs: tMeta,
    tAllThumbsMs: tAll,
    appFirstThumbMs: Math.round(progress.firstThumbAt - progress.startedAt),
    appAllThumbsMs: Math.round(progress.allThumbsAt - progress.startedAt),
    thumbErrors: progress.errors,
    errorCells,
    scrollLongTasks: scrollLong.map(Math.round),
    slowKeyEvents: slowEvents,
    loupeNextPreloadedMs: loupe,
    loupeNextRapidMs: loupeCold,
    zoom100Ms: Math.round(zoomMs),
    memory: mem,
    consoleErrors: logs.slice(0, 10),
    thumbStatsByFormat: await page.evaluate(() =>
      Object.fromEntries(Object.entries((globalThis as any).__thumbStats).map(([k, v]: any) => [k, { n: v.n, avgMs: Math.round(v.ms / v.n), maxMs: Math.round(v.max) }])),
    ),
  };
  console.log(JSON.stringify(result, null, 2));
  fs.mkdirSync('bench-results', { recursive: true });
  fs.writeFileSync(`bench-results/bench-${MIX}-${COUNT}-${process.env.BENCH_WARM === '1' ? 'warm' : 'cold'}.json`, JSON.stringify(result, null, 2));
  expect(progress.errors).toBe(0);
});
