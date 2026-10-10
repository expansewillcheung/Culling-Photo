import { describe, expect, it } from 'vitest';
import { buildCatalog } from './catalog';
import type { SourceEntry } from '../fs/FileSource';

const e = (relPath: string): SourceEntry => {
  const parts = relPath.split('/');
  return { relPath, name: parts.pop()!, dirRel: parts.join('/'), size: 1, lastModified: 1, file: null as any };
};

describe('buildCatalog', () => {
  it('pairs RAW+JPEG and sidecars, prefers JPEG for display', () => {
    const cat = buildCatalog([e('a/IMG_2.CR3'), e('a/IMG_2.JPG'), e('a/IMG_2.xmp'), e('a/IMG_10.NEF'), e('a/IMG_10.NEF.xmp'), e('b/x.heic'), e('b/readme.txt')]);
    expect(cat.map((c) => c.key)).toEqual(['a/img_2', 'a/img_10', 'b/x']);
    expect(cat[0].kinds).toEqual(['jpeg', 'raw']);
    expect(cat[0].rawIndex).toBe(1);
    expect(cat[0].sidecar?.name).toBe('IMG_2.xmp');
    expect(cat[1].sidecar?.name).toBe('IMG_10.NEF.xmp');
    expect(cat[2].kinds).toEqual(['heic']);
  });
});
