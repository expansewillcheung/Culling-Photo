// Runs the parser in Chromium on real Blobs and checks the embedded JPEGs decode natively.
import { expect, test } from 'vitest';
import { blobReader } from '../core/types';
import { fixtureBlob, GEN_DIR, RAW_DIR } from '../../tests/browser/fixtures';
import { parseFile, pickEmbedded } from './index';

const FILES = [
  RAW_DIR + 'Canon___EOS_R6_Mark_II___3_2.cr3',
  RAW_DIR + 'Canon___EOS_5D_Mark_IV___RAW__3_2_.CR2',
  RAW_DIR + 'Nikon___Z_8___8bit_8bit_compressed__3_2_.NEF',
  RAW_DIR + 'Sony___ILCE_7M3___14bit_14bit_compressed__3_2_.ARW',
  RAW_DIR + 'Fujifilm___X_T5___14bit_14bit_compressed__3_2_.RAF',
  RAW_DIR + 'Olympus___E_M1MarkII___16bit__4_3_.ORF',
  RAW_DIR + 'Panasonic___DC_S5___3_2.RW2',
  RAW_DIR + 'Apple___iPhone_12_Pro___8bit__4_3_.DNG',
  GEN_DIR + 'photo.jpg',
];

for (const path of FILES) {
  test(`parse + decode embedded: ${path.split('/').pop()}`, async () => {
    const blob = await fixtureBlob(path);
    let bytes = 0;
    const base = blobReader(blob);
    const reader = { size: base.size, read: async (o: number, l: number) => { const b = await base.read(o, l); bytes += b.length; return b; } };
    const t0 = performance.now();
    const parsed = await parseFile(reader, path.split('/').pop()!);
    const ms = performance.now() - t0;
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
    expect(ms).toBeLessThan(200);
    for (const img of parsed.images) {
      // Chrome applies EXIF orientation found *inside* the embedded JPEG even with
      // imageOrientation 'none' (iPhone DNG previews carry Orientation=6), so dims may be swapped.
      const bmp = await createImageBitmap(blob.slice(img.offset, img.offset + img.length, img.mime));
      const swapped = (parsed.exif.orientation ?? 1) >= 5;
      const dims = [bmp.width, bmp.height];
      expect(dims[0] === img.width && dims[1] === img.height || (swapped && dims[0] === img.height && dims[1] === img.width), `${dims} vs ${img.width}x${img.height}`).toBe(true);
      bmp.close();
    }
    if (parsed.kind === 'raw') expect(pickEmbedded(parsed, 1600)).toBeDefined();
  });
}
