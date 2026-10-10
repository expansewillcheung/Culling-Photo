// Node tests for the DC-only JPEG decoder. Reference: libjpeg's own 1/8-scale decode
// (`djpeg`) full decode reduced to 8x8 box means. Test JPEGs are generated with ImageMagick/cjpeg
// and embedded previews are extracted from RAW fixtures with exiftool.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { dcDecodeWorthIt, decodeJpegDc } from './jpegDc';

const ROOT = resolve(__dirname, '../..');
const RAW = join(ROOT, 'tests/fixtures/raw');
const PHOTO = join(ROOT, 'tests/fixtures/gen/photo.jpg');
const has = (cmd: string) => {
  try { execFileSync('which', [cmd]); return true; } catch { return false; }
};
const HAVE_TOOLS = has('djpeg') && has('convert') && has('cjpeg') && has('exiftool');

let dir = '';
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'jpegdc-')); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/** Parse binary PPM (P6) / PGM (P5) into RGBA. */
function readPnm(buf: Buffer): { width: number; height: number; data: Uint8Array } {
  let i = 0;
  const tok = () => {
    while (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09) i++;
    if (buf[i] === 0x23) { while (buf[i] !== 0x0a) i++; return tok(); }
    const s = i;
    while (buf[i] > 0x20) i++;
    return buf.toString('latin1', s, i);
  };
  const magic = tok();
  const width = +tok(), height = +tok();
  tok();
  i++;
  const ch = magic === 'P6' ? 3 : 1;
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    for (let c = 0; c < 3; c++) data[p * 4 + c] = buf[i + p * ch + (ch === 3 ? c : 0)];
    data[p * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** Reference: full libjpeg decode, then 8x8 box means (edge blocks average what exists). */
function djpeg8(file: string) {
  const full = readPnm(execFileSync('djpeg', ['-pnm', file], { maxBuffer: 1 << 30 }));
  const W = Math.ceil(full.width / 8), H = Math.ceil(full.height / 8);
  const data = new Uint8Array(W * H * 4);
  for (let by = 0; by < H; by++) {
    for (let bx = 0; bx < W; bx++) {
      const s = [0, 0, 0];
      let n = 0;
      for (let y = by * 8; y < Math.min(by * 8 + 8, full.height); y++) {
        for (let x = bx * 8; x < Math.min(bx * 8 + 8, full.width); x++, n++) {
          const o = (y * full.width + x) * 4;
          s[0] += full.data[o]; s[1] += full.data[o + 1]; s[2] += full.data[o + 2];
        }
      }
      const o = (by * W + bx) * 4;
      data[o] = Math.round(s[0] / n); data[o + 1] = Math.round(s[1] / n); data[o + 2] = Math.round(s[2] / n); data[o + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

function mae(a: Uint8ClampedArray | Uint8Array, b: Uint8Array): number[] {
  const s = [0, 0, 0];
  const n = a.length / 4;
  for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) s[c] += Math.abs(a[p * 4 + c] - b[p * 4 + c]);
  return s.map((x) => x / n);
}

function checkAgainstDjpeg(file: string, maxMae = 4) {
  const bytes = new Uint8Array(readFileSync(file));
  const t0 = performance.now();
  const img = decodeJpegDc(bytes);
  const ms = performance.now() - t0;
  expect(img, file).not.toBeNull();
  const ref = djpeg8(file);
  expect([img!.width, img!.height]).toEqual([ref.width, ref.height]);
  const e = mae(img!.data, ref.data);
  for (const v of e) expect(v).toBeLessThan(maxMae);
  return { ms, e, w: img!.width, h: img!.height };
}

function convert(name: string, ...args: string[]): string {
  const out = join(dir, name);
  execFileSync('convert', [PHOTO, '-resize', '1203x803!', ...args, out]);
  return out;
}

describe.skipIf(!HAVE_TOOLS)('decodeJpegDc vs libjpeg full decode + 8x8 box mean', () => {
  test('photo.jpg', () => { checkAgainstDjpeg(PHOTO); });

  const variants: [string, string[]][] = [
    ['444', ['-sampling-factor', '1x1,1x1,1x1']],
    ['422', ['-sampling-factor', '2x1,1x1,1x1']],
    ['420', ['-sampling-factor', '2x2,1x1,1x1']],
    ['440', ['-sampling-factor', '1x2,1x1,1x1']],
    ['411', ['-sampling-factor', '4x1,1x1,1x1']],
    ['gray', ['-colorspace', 'Gray']],
    ['restart1', ['-define', 'jpeg:restart-interval=1']],
    ['restart7-420', ['-sampling-factor', '2x2,1x1,1x1', '-define', 'jpeg:restart-interval=7']],
    ['q100', ['-quality', '100']],
    ['q5', ['-quality', '5']],
    ['optimized', ['-define', 'jpeg:optimize-coding=true']],
  ];
  for (const [name, args] of variants) {
    test(`generated ${name}`, () => { checkAgainstDjpeg(convert(`${name}.jpg`, ...args)); });
  }

  test('odd sizes', () => {
    for (const [w, h] of [[1, 1], [7, 9], [17, 15], [33, 1]]) {
      const out = join(dir, `odd${w}x${h}.jpg`);
      execFileSync('convert', [PHOTO, '-resize', `${w}x${h}!`, '-sampling-factor', '2x2,1x1,1x1', out]);
      checkAgainstDjpeg(out, 6);
    }
  });

  test('cjpeg restart rows + non-interleaved multi-scan sequential', () => {
    const ppm = join(dir, 'src.ppm');
    execFileSync('convert', [PHOTO, '-resize', '640x427!', ppm]);
    const r = join(dir, 'cjpeg-restart.jpg');
    execFileSync('cjpeg', ['-restart', '1', '-outfile', r, ppm]);
    checkAgainstDjpeg(r);
    // Scan script: one component per scan (sequential, non-interleaved).
    const scans = join(dir, 'scans.txt');
    writeFileSync(scans, '0: 0 63 0 0;\n1: 0 63 0 0;\n2: 0 63 0 0;\n');
    const s = join(dir, 'cjpeg-multiscan.jpg');
    execFileSync('cjpeg', ['-scans', scans, '-outfile', s, ppm]);
    checkAgainstDjpeg(s);
  });

  test('RGB (Adobe transform 0) jpeg', () => {
    const ppm = join(dir, 'rgbsrc.ppm');
    execFileSync('convert', [PHOTO, '-resize', '320x213!', ppm]);
    const out = join(dir, 'rgb.jpg');
    try {
      execFileSync('cjpeg', ['-rgb', '-outfile', out, ppm], { stdio: 'pipe' });
    } catch {
      return; // cjpeg without -rgb support
    }
    checkAgainstDjpeg(out);
  });

  test('progressive / arithmetic / 12-bit-ish / CMYK return null', () => {
    expect(decodeJpegDc(new Uint8Array(readFileSync(convert('prog.jpg', '-interlace', 'JPEG'))))).toBeNull();
    expect(decodeJpegDc(new Uint8Array(readFileSync(convert('cmyk.jpg', '-colorspace', 'CMYK'))))).toBeNull();
    const ppm = join(dir, 'a.ppm');
    execFileSync('convert', [PHOTO, '-resize', '200x100!', ppm]);
    const ari = join(dir, 'ari.jpg');
    try {
      execFileSync('cjpeg', ['-arithmetic', '-outfile', ari, ppm], { stdio: 'pipe' });
      expect(decodeJpegDc(new Uint8Array(readFileSync(ari)))).toBeNull();
    } catch { /* no arithmetic support */ }
  });

  test('truncated / corrupt data never throws or hangs', () => {
    const bytes = new Uint8Array(readFileSync(convert('trunc.jpg', '-define', 'jpeg:restart-interval=3')));
    const t0 = performance.now();
    for (const f of [0, 0.01, 0.1, 0.5, 0.9, 0.999]) {
      const r = decodeJpegDc(bytes.subarray(0, Math.floor(bytes.length * f)));
      if (f < 0.999) expect(r).toBeNull();
    }
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let i = 0; i < 200; i++) {
      const b = bytes.slice();
      for (let j = 0; j < 20; j++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      const r = decodeJpegDc(b);
      if (r) expect(r.data.length).toBe(r.width * r.height * 4);
    }
    expect(decodeJpegDc(new Uint8Array(0))).toBeNull();
    expect(decodeJpegDc(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(performance.now() - t0).toBeLessThan(20_000);
  });

  // Embedded previews from RAW fixtures (largest of JpgFromRaw / PreviewImage / OtherImage).
  const raws = existsSync(RAW) ? (execFileSync('ls', [RAW]).toString().trim().split('\n')) : [];
  for (const name of raws) {
    test(`embedded: ${name}`, () => {
      let best: Buffer | undefined;
      for (const tag of ['-JpgFromRaw', '-PreviewImage', '-OtherImage']) {
        const b = execFileSync('exiftool', ['-b', tag, join(RAW, name)], { maxBuffer: 1 << 28 });
        if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && (!best || b.length > best.length)) best = b;
      }
      if (!best) return;
      const f = join(dir, name + '.jpg');
      writeFileSync(f, best);
      const bytes = new Uint8Array(best);
      const img = decodeJpegDc(bytes);
      if (!img) {
        // only acceptable when libjpeg confirms the file is progressive/unsupported
        const info = execFileSync('exiftool', ['-s', '-s', '-s', '-EncodingProcess', f]).toString();
        expect(info).not.toMatch(/Baseline|Extended sequential/);
        return;
      }
      const r = checkAgainstDjpeg(f);
      console.log(`${name}: ${r.w}x${r.h} ${r.ms.toFixed(1)} ms MAE ${r.e.map((x) => x.toFixed(2)).join('/')}`);
    });
  }
});

test('dcDecodeWorthIt', () => {
  expect(dcDecodeWorthIt(8256, 5504, 512)).toBe(true);
  expect(dcDecodeWorthIt(4000, 2667, 512)).toBe(true); // 500 >= 460.8
  expect(dcDecodeWorthIt(3000, 2000, 512)).toBe(false); // 375
  expect(dcDecodeWorthIt(2000, 4200, 512)).toBe(true);
  expect(dcDecodeWorthIt(1600, 1067, 512)).toBe(false);
});
