import { expect, test } from 'vitest';
import { fixtureFile, GEN_DIR, RAW_DIR } from './fixtures';
import { blobReader } from '../../src/core/types';
import { parseFile } from '../../src/formats';
import { decodeOriented } from '../../src/pipeline/image';

const FILES = [
  RAW_DIR + 'Canon___EOS_R6_Mark_II___3_2.cr3',
  RAW_DIR + 'Nikon___Z_8___8bit_8bit_compressed__3_2_.NEF',
  RAW_DIR + 'Sony___ILCE_7M3___14bit_14bit_compressed__3_2_.ARW',
  RAW_DIR + 'Fujifilm___X_T5___14bit_14bit_compressed__3_2_.RAF',
  RAW_DIR + 'Panasonic___DC_S5___3_2.RW2',
  RAW_DIR + 'Olympus___E_M1MarkII___16bit__4_3_.ORF',
  GEN_DIR + 'DSC01234.ARW',
  GEN_DIR + 'rotated6.jpg',
  GEN_DIR + 'photo.jpg',
];

// The loupe's 100% zoom and the "low-res preview" warning rely on sourceWidth/Height being the
// oriented size of the decoded source, whatever size the bitmap was scaled to.
test.each(FILES)('source size does not depend on the requested edge: %s', async (path) => {
  const file = await fixtureFile(path);
  const parsed = await parseFile(blobReader(file), file.name);
  const sizes: string[] = [];
  for (const edge of [512, 1536, 0]) {
    const r = await decodeOriented(file, parsed, edge);
    sizes.push(`${r.sourceWidth}x${r.sourceHeight}`);
    r.bitmap.close();
  }
  expect(new Set(sizes).size, sizes.join(' ')).toBe(1);
});
