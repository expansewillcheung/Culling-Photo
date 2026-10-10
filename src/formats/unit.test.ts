import { describe, expect, it } from 'vitest';
import type { EmbeddedImage, ParsedFile } from '../core/types';
import { detectFormat, pickEmbedded } from './index';
import { exifDateToMs } from './exif';
import { parseXmpRating } from './xmpRating';
import { jxlSize } from './simple';

const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const img = (w: number, h: number, role: EmbeddedImage['role'] = 'preview'): EmbeddedImage => ({
  offset: w, length: 100, mime: 'image/jpeg', width: w, height: h, role,
});

describe('pickEmbedded', () => {
  const parsed: ParsedFile = {
    format: 'NEF', kind: 'raw', exif: {},
    images: [img(1620, 1080), img(160, 120, 'thumb'), img(8256, 5504, 'full'), img(4128, 2752)],
  };
  it('smallest image whose long edge >= target', () => {
    expect(pickEmbedded(parsed, 384)?.width).toBe(1620);
    expect(pickEmbedded(parsed, 100)?.width).toBe(160);
    expect(pickEmbedded(parsed, 160)?.width).toBe(160);
    expect(pickEmbedded(parsed, 1621)?.width).toBe(4128);
    expect(pickEmbedded(parsed, 3024)?.width).toBe(4128);
    expect(pickEmbedded(parsed, 4129)?.width).toBe(8256);
  });
  it('falls back to the largest', () => {
    expect(pickEmbedded(parsed, 20000)?.width).toBe(8256);
  });
  it('portrait images use the long edge', () => {
    const p: ParsedFile = { ...parsed, images: [img(1080, 1620), img(2000, 3000)] };
    expect(pickEmbedded(p, 1500)?.height).toBe(1620);
  });
  it('undefined when there are no images', () => {
    expect(pickEmbedded({ ...parsed, images: [] }, 100)).toBeUndefined();
  });
});

describe('detectFormat', () => {
  const pad = (b: Uint8Array) => { const o = new Uint8Array(64); o.set(b); return o; };
  it('magic bytes', () => {
    expect(detectFormat(pad(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'a.bin')).toEqual({ kind: 'jpeg', format: 'JPEG' });
    expect(detectFormat(pad(enc('\x89PNG\r\n\x1a\n')), 'a')).toEqual({ kind: 'png', format: 'PNG' });
    expect(detectFormat(pad(enc('GIF89a')), 'a')).toEqual({ kind: 'gif', format: 'GIF' });
    expect(detectFormat(pad(enc('RIFF\0\0\0\0WEBPVP8 ')), 'a')).toEqual({ kind: 'webp', format: 'WEBP' });
    expect(detectFormat(pad(enc('FUJIFILMCCD-RAW 0201')), 'a.raf')).toEqual({ kind: 'raw', format: 'RAF' });
    expect(detectFormat(pad(enc('\0\0\0\x18ftypcrx \0\0\0\x01crx isom')), 'a.cr3')).toEqual({ kind: 'raw', format: 'CR3' });
    expect(detectFormat(pad(enc('\0\0\0\x18ftypheic\0\0\0\0mif1heic')), 'a.heic')).toEqual({ kind: 'heic', format: 'HEIC' });
    expect(detectFormat(pad(enc('\0\0\0\x1cftypavif\0\0\0\0avifmif1miaf')), 'a.avif')).toEqual({ kind: 'avif', format: 'AVIF' });
    expect(detectFormat(pad(enc('\0\0\0\x14ftypqt  \0\0\0\0qt  ')), 'a.mov')).toEqual({ kind: 'video', format: 'MOV' });
    expect(detectFormat(pad(enc('\0\0\0\x18ftypisom\0\0\0\0isomiso2')), 'a.mp4')).toEqual({ kind: 'video', format: 'MP4' });
    expect(detectFormat(pad(new Uint8Array([0xff, 0x0a])), 'a')).toEqual({ kind: 'jxl', format: 'JXL' });
    expect(detectFormat(pad(enc('II*\0\x10\0\0\0CR\x02\0')), 'a.cr2')).toEqual({ kind: 'raw', format: 'CR2' });
    expect(detectFormat(pad(enc('IIRO\x08\0\0\0')), 'a.orf')).toEqual({ kind: 'raw', format: 'ORF' });
    expect(detectFormat(pad(enc('IIU\0\x08\0\0\0')), 'a.rw2')).toEqual({ kind: 'raw', format: 'RW2' });
    expect(detectFormat(pad(enc('II*\0\x08\0\0\0')), 'a.NEF')).toEqual({ kind: 'raw', format: 'NEF' });
    expect(detectFormat(pad(enc('MM\0*\0\0\0\x08')), 'a.tif')).toEqual({ kind: 'tiff', format: 'TIFF' });
    expect(detectFormat(pad(enc('<?xpacket begin=')), 'a.xmp')).toEqual({ kind: 'xmp', format: 'XMP' });
    expect(detectFormat(pad(enc('hello world')), 'a.txt')).toEqual({ kind: 'other', format: 'TXT' });
  });
  it('extension fallback for short heads', () => {
    expect(detectFormat(new Uint8Array(0), 'IMG_1.CR3')).toEqual({ kind: 'raw', format: 'CR3' });
    expect(detectFormat(new Uint8Array(0), 'a.xmp')).toEqual({ kind: 'xmp', format: 'XMP' });
  });
});

describe('helpers', () => {
  it('exifDateToMs interprets wall clock as UTC with sub-seconds', () => {
    expect(exifDateToMs('2017:01:26 09:37:39', '06')).toBe(Date.UTC(2017, 0, 26, 9, 37, 39, 60));
    expect(exifDateToMs('2020:12:29 14:24:45', '700')).toBe(Date.UTC(2020, 11, 29, 14, 24, 45, 700));
    expect(exifDateToMs('0000:00:00 00:00:00')).toBeUndefined();
    expect(exifDateToMs('garbage')).toBeUndefined();
  });
  it('parseXmpRating', () => {
    expect(parseXmpRating('<rdf:Description xmp:Rating="3"/>')).toBe(3);
    expect(parseXmpRating('<xmp:Rating>5</xmp:Rating>')).toBe(5);
    expect(parseXmpRating("xmp:Rating='-1'")).toBe(-1);
    expect(parseXmpRating('xmp:Rating="9"')).toBe(5);
    expect(parseXmpRating('nothing')).toBeUndefined();
  });
  it('jxlSize decodes SizeHeader', () => {
    // small: div8, height (5+1)*8=48, ratio 1 (square)
    // bits LSB-first: small=1, h-1=5 (5 bits), ratio=1 (3 bits)
    const v = 1 | (5 << 1) | (1 << 6);
    expect(jxlSize(new Uint8Array([0xff, 0x0a, v & 0xff, v >> 8]))).toEqual({ width: 48, height: 48 });
  });
});
