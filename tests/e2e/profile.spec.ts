import { test } from '@playwright/test';
import path from 'node:path';

// Diagnostic: CPU-profile the main thread while scrolling during thumbnail generation.
test('profile scroll', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto('/');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('culling-cache', { recursive: true }).catch(() => {});
  });
  await page.getByTestId('open-readonly').setInputFiles(path.resolve('bench-data/shoot-600'));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=cell] img').length > 10, null, { timeout: 60000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  await page.getByTestId('grid').hover();
  for (let i = 0; i < 20; i++) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(3000);
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map<string, number>();
  const dt = profile.timeDeltas!;
  const byId = new Map(profile.nodes.map((n: any) => [n.id, n]));
  profile.samples!.forEach((id: number, i: number) => {
    const n: any = byId.get(id);
    const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`;
    self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  // inclusive time per function
  const parent = new Map<number, number>();
  for (const n of profile.nodes as any[]) for (const c of n.children ?? []) parent.set(c, n.id);
  const incl = new Map<string, number>();
  const name = (n: any) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()?.split('?')[0]}:${n.callFrame.lineNumber}`;
  profile.samples!.forEach((id: number, i: number) => {
    const seen = new Set<string>();
    for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
      const k = name(byId.get(cur));
      if (seen.has(k)) continue;
      seen.add(k);
      incl.set(k, (incl.get(k) ?? 0) + (dt[i] ?? 0) / 1000);
    }
  });
  console.log('INCLUSIVE\n' + [...incl.entries()].filter(([k]) => !k.startsWith('(')).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${v.toFixed(0).padStart(6)}ms ${k}`).join('\n'));
  console.log([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${v.toFixed(0).padStart(6)}ms ${k}`).join('\n'));
});
