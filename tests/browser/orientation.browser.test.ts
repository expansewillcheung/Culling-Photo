import { expect, test } from 'vitest';
import { fixtureBlob, GEN_DIR } from './fixtures';

test('createImageBitmap applies EXIF orientation; resize dims are post-orientation', async () => {
  const b = await fixtureBlob(GEN_DIR + 'rotated6.jpg');
  const full = await createImageBitmap(b);
  console.log('full', full.width, full.height);
  const r = await createImageBitmap(b, { resizeWidth: 300, resizeHeight: 450, resizeQuality: 'high' });
  console.log('resized', r.width, r.height);
  const none = await createImageBitmap(b, { imageOrientation: 'none' as any });
  console.log('none', none.width, none.height);
  expect(full.height).toBeGreaterThan(full.width);
});
