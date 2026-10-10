// Creates a benchmark folder of N photos by hard-linking fixtures (no extra disk space).
// usage: node scripts/make-bench-dir.mjs <outDir> <count>
import fs from 'node:fs';
import path from 'node:path';

const [out = 'bench-data/shoot', countArg = '3000'] = process.argv.slice(2);
const count = Number(countArg);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const srcDirs = [path.join(root, 'tests/fixtures/raw'), path.join(root, 'tests/fixtures/gen')];
const sources = srcDirs.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).map((f) => path.join(d, f)) : []))
  .filter((f) => !/\.(json|txt)$/i.test(f) && !path.basename(f).startsWith('DSC01234'))
  // BENCH_MIX=raw: camera RAW files only (a typical shoot); default: every format.
  .filter((f) => process.env.BENCH_MIX !== 'raw' || f.includes('/raw/'));
// Weighted mix: mostly RAW (typical shoot), some JPEG/HEIC.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
let n = 0;
for (let i = 0; i < count; i++) {
  const src = sources[i % sources.length];
  const ext = path.extname(src);
  const name = `IMG_${String(i + 1).padStart(5, '0')}${ext}`;
  fs.linkSync(src, path.join(out, name));
  n++;
}
// a few RAW+JPEG pairs
const arw = path.join(root, 'tests/fixtures/gen/DSC01234.ARW');
if (fs.existsSync(arw)) {
  for (let i = 0; i < 20; i++) {
    fs.linkSync(arw, path.join(out, `PAIR_${i}.ARW`));
    fs.linkSync(path.join(root, 'tests/fixtures/gen/DSC01234.JPG'), path.join(out, `PAIR_${i}.JPG`));
  }
}
console.log(`created ${n} files (+pairs) in ${out}`);
