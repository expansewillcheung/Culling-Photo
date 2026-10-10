import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { ColorLabel, Flag, Marks } from '../core/types';
import { buildSidecar, isWellFormedXml, JPEG_XMP_HEADER, parseXmp, sidecarCandidates, sidecarName } from './xmp';

const LIGHTROOM = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000 1.000000, 0000/00/00-00:00:00        ">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:tiff="http://ns.adobe.com/tiff/1.0/"
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
    xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   tiff:Make="Canon"
   tiff:Model="Canon EOS R5"
   exif:ExposureTime="1/250"
   exif:FNumber="28/10"
   xmp:ModifyDate="2024-05-01T10:11:12.34+02:00"
   xmp:CreatorTool="Adobe Photoshop Lightroom Classic 13.2 (Macintosh)"
   xmp:Rating="2"
   xmp:Label="Blue"
   xmpMM:DocumentID="xmp.did:5b1c2a5e-1234-4a7f-9a1f-000000000001"
   photoshop:DateCreated="2024-05-01T10:11:12.34"
   crs:Version="16.2"
   crs:ProcessVersion="15.4"
   crs:WhiteBalance="As Shot"
   crs:Exposure2012="+0.35"
   crs:Contrast2012="+12"
   crs:Highlights2012="-48"
   crs:Shadows2012="+31"
   crs:Texture="+8"
   crs:LensProfileEnable="1"
   crs:HasSettings="True">
   <xmpMM:History>
    <rdf:Seq>
     <rdf:li
      stEvt:action="saved"
      stEvt:instanceID="xmp.iid:5b1c2a5e-1234-4a7f-9a1f-000000000001"
      stEvt:when="2024-05-01T10:11:12+02:00"
      stEvt:softwareAgent="Adobe Photoshop Lightroom Classic 13.2 (Macintosh)"
      stEvt:changed="/metadata"/>
    </rdf:Seq>
   </xmpMM:History>
   <crs:ToneCurvePV2012>
    <rdf:Seq>
     <rdf:li>0, 0</rdf:li>
     <rdf:li>255, 255</rdf:li>
    </rdf:Seq>
   </crs:ToneCurvePV2012>
   <dc:subject>
    <rdf:Bag>
     <rdf:li>wedding &amp; party</rdf:li>
    </rdf:Bag>
   </dc:subject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;

const DARKTABLE = `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 4.4.0-Exiv2">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
    xmlns:darktable="http://darktable.sf.net/"
   exif:DateTimeOriginal="2024:05:01 10:11:12.340"
   xmp:Rating="1"
   xmpMM:DerivedFrom="IMG_0001.CR3"
   darktable:import_timestamp="63851234567000000"
   darktable:xmp_version="5"
   darktable:raw_params="0"
   darktable:auto_presets_applied="1"
   darktable:history_end="2"
   darktable:iop_order_version="4">
   <darktable:colorlabels>
    <rdf:Seq>
     <rdf:li>2</rdf:li>
    </rdf:Seq>
   </darktable:colorlabels>
   <darktable:history>
    <rdf:Seq>
     <rdf:li
      darktable:num="0"
      darktable:operation="exposure"
      darktable:enabled="1"
      darktable:modversion="6"
      darktable:params="00000000000080b93333333f00004842000080c0"
      darktable:multi_name=""
      darktable:multi_priority="0"
      darktable:blendop_version="13"
      darktable:blendop_params="gz11eJxjYIAAFgYWBgYWBgYGBgYGBgY="/>
     <rdf:li
      darktable:num="1"
      darktable:operation="filmicrgb"
      darktable:enabled="1"
      darktable:modversion="7"
      darktable:params="gz02eJxjYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGA="
      darktable:multi_name="&lt;default&gt;"
      darktable:multi_priority="0"
      darktable:blendop_version="13"
      darktable:blendop_params="gz11eJxjYIAAFgYWBgYWBgYGBgYGBgY="/>
    </rdf:Seq>
   </darktable:history>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;

/** Element form + non-standard prefix (as written by some DAMs / exiv2 variants). */
const ELEMENT_FORM = `﻿<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <r:Description r:about="" xmlns:xap="http://ns.adobe.com/xap/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/">
      <xap:Rating>4</xap:Rating>
      <xap:Label>Red</xap:Label>
      <photoshop:Headline>Keep me</photoshop:Headline>
    </r:Description>
  </r:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const dir = mkdtempSync(join(tmpdir(), 'xmp-test-'));
afterAll(() => { if (!process.env.KEEP_XMP) rmSync(dir, { recursive: true, force: true }); });

let hasExiftool = true;
try {
  execFileSync('exiftool', ['-ver']);
} catch {
  hasExiftool = false;
}

function exif(xml: string, name = 'a.xmp'): Record<string, unknown> {
  const p = join(dir, name);
  writeFileSync(p, xml);
  const out = execFileSync('exiftool', ['-j', '-n', '-XMP:all', p], { encoding: 'utf8' });
  return JSON.parse(out)[0];
}

const LABELS: ColorLabel[] = ['', 'red', 'yellow', 'green', 'blue', 'purple'];
const FLAGS: Flag[] = [-1, 0, 1];

describe('sidecar names', () => {
  test('sidecarName replaces extension', () => {
    expect(sidecarName('IMG_0001.CR3')).toBe('IMG_0001.xmp');
    expect(sidecarName('a/b/DSC.0001.NEF')).toBe('a/b/DSC.0001.xmp');
    expect(sidecarName('noext')).toBe('noext.xmp');
    expect(sidecarName('dir.x/noext')).toBe('dir.x/noext.xmp');
  });
  test('sidecarCandidates', () => {
    expect(sidecarCandidates('IMG_0001.CR3')).toEqual(['IMG_0001.xmp', 'IMG_0001.XMP', 'IMG_0001.CR3.xmp']);
    expect(sidecarCandidates('d/IMG_0001.CR3')[2]).toBe('d/IMG_0001.CR3.xmp');
  });
});

describe('buildSidecar / parseXmp round trip', () => {
  test('all combinations are lossless and well-formed', () => {
    for (const flag of FLAGS)
      for (let rating = 0; rating <= 5; rating++)
        for (const label of LABELS) {
          const m: Marks = { rating, flag, label };
          const xml = buildSidecar(m);
          expect(isWellFormedXml(xml)).toBe(true);
          expect(parseXmp(xml)).toEqual(m);
          // re-merge into itself with other marks, then back
          const other: Marks = { rating: (rating + 2) % 6, flag: ((flag + 2) % 3) - 1 as Flag, label: LABELS[(LABELS.indexOf(label) + 1) % 6] };
          const merged = buildSidecar(other, xml);
          expect(parseXmp(merged)).toEqual(other);
          expect(parseXmp(buildSidecar(m, merged))).toEqual(m);
        }
  });

  test('reject writes Rating -1, hides stars in cull:Rating', () => {
    const xml = buildSidecar({ rating: 3, flag: -1, label: '' });
    expect(xml).toContain('xmp:Rating="-1"');
    expect(xml).toContain('cull:Rating="3"');
    expect(xml).not.toContain('xmp:Label');
  });

  test.skipIf(!hasExiftool)('exiftool reads our packets', () => {
    const j = exif(buildSidecar({ rating: 4, flag: 1, label: 'purple' }));
    expect(j.Rating).toBe(4);
    expect(j.Label).toBe('Purple');
    expect(j.Flag).toBe(1);
    const r = exif(buildSidecar({ rating: 2, flag: -1, label: 'green' }));
    expect(r.Rating).toBe(-1);
    expect(r.Label).toBe('Green');
  });
});

describe('merge into existing sidecars', () => {
  test('lightroom: only rating/label change, crs preserved byte-for-byte', () => {
    const out = buildSidecar({ rating: 5, flag: 1, label: 'red' }, LIGHTROOM);
    expect(isWellFormedXml(out)).toBe(true);
    expect(parseXmp(out)).toEqual({ rating: 5, flag: 1, label: 'red' });
    // Everything except the edited lines is identical.
    const before = LIGHTROOM.split('\n');
    const after = out.split('\n');
    const removed = before.filter((l) => !after.includes(l));
    expect(removed.map((l) => l.trim())).toEqual(['xmp:Rating="2"', 'xmp:Label="Blue"', 'crs:HasSettings="True">']);
    for (const l of before) if (/crs:|stEvt:|rdf:li|dc:/.test(l) && !l.includes('HasSettings')) expect(after).toContain(l);
    expect(out).toContain('xmp:Rating="5"');
    expect(out).toContain('xmp:Label="Red"');
    expect(out).toMatch(/crs:HasSettings="True"\n {3}xmlns:cull="https:\/\/culling-photo.app\/ns\/1.0\/"\n {3}cull:Flag="1">/);
    // Clearing the label removes the attribute.
    const cleared = buildSidecar({ rating: 0, flag: 0, label: '' }, out);
    expect(cleared).not.toContain('xmp:Label');
    expect(parseXmp(cleared)).toEqual({ rating: 0, flag: 0, label: '' });
    // Merging is idempotent.
    expect(buildSidecar({ rating: 5, flag: 1, label: 'red' }, out)).toBe(out);
  });

  test.skipIf(!hasExiftool)('lightroom merge: exiftool sees new values and keeps crs', () => {
    const out = buildSidecar({ rating: 3, flag: 0, label: 'yellow' }, LIGHTROOM);
    const j = exif(out, 'lr.xmp');
    expect(j.Rating).toBe(3);
    expect(j.Label).toBe('Yellow');
    expect(Number(j.Exposure2012)).toBe(0.35);
    expect(Number(j.Highlights2012)).toBe(-48);
    expect(j.ToneCurvePV2012).toEqual(['0, 0', '255, 255']);
    expect(j.Subject).toBe('wedding & party');
    expect(j.HistoryAction).toBe('saved');
    const orig = exif(LIGHTROOM, 'lr0.xmp');
    for (const k of Object.keys(orig)) {
      if (['Rating', 'Label', 'SourceFile', 'FileName', 'FileModifyDate', 'FileAccessDate', 'FileInodeChangeDate', 'FileSize'].includes(k)) continue;
      expect(j[k], k).toEqual(orig[k]);
    }
  });

  test('darktable: rating attribute updated, history untouched, reads colorlabels', () => {
    expect(parseXmp(DARKTABLE)).toEqual({ rating: 1, label: 'green' });
    const out = buildSidecar({ rating: 2, flag: -1, label: 'blue' }, DARKTABLE);
    expect(isWellFormedXml(out)).toBe(true);
    expect(out).toContain('xmp:Rating="-1"');
    expect(out).toContain('<darktable:history>');
    expect(out).toContain('darktable:multi_name="&lt;default&gt;"');
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(parseXmp(out)).toEqual({ rating: 2, flag: -1, label: 'blue' });
  });

  test.skipIf(!hasExiftool)('darktable merge read by exiftool', () => {
    const j = exif(buildSidecar({ rating: 4, flag: 0, label: 'red' }, DARKTABLE), 'dt.xmp');
    expect(j.Rating).toBe(4);
    expect(j.Label).toBe('Red');
    const orig = exif(DARKTABLE, 'dt0.xmp');
    expect(Object.keys(orig).length).toBeGreaterThan(10);
    for (const k of Object.keys(orig)) {
      if (['Rating', 'Label', 'SourceFile', 'FileName', 'FileModifyDate', 'FileAccessDate', 'FileInodeChangeDate'].includes(k)) continue;
      if (k === 'FileSize') continue;
      expect(j[k], k).toEqual(orig[k]);
    }
  });

  test('element form + other prefixes: replaced in place, BOM kept', () => {
    expect(parseXmp(ELEMENT_FORM)).toEqual({ rating: 4, label: 'red' });
    const out = buildSidecar({ rating: 1, flag: 1, label: 'purple' }, ELEMENT_FORM);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out).toContain('<xap:Rating>1</xap:Rating>');
    expect(out).toContain('<xap:Label>Purple</xap:Label>');
    expect(out).toContain('<photoshop:Headline>Keep me</photoshop:Headline>');
    expect(out).not.toMatch(/\sxmp:/);
    expect(isWellFormedXml(out)).toBe(true);
    expect(parseXmp(out)).toEqual({ rating: 1, flag: 1, label: 'purple' });
    const noLabel = buildSidecar({ rating: 1, flag: 1, label: '' }, out);
    expect(noLabel).not.toContain('Label');
    expect(isWellFormedXml(noLabel)).toBe(true);
  });

  test.skipIf(!hasExiftool)('element form read by exiftool after merge', () => {
    const j = exif(buildSidecar({ rating: 5, flag: 0, label: 'green' }, ELEMENT_FORM), 'el.xmp');
    expect(j.Rating).toBe(5);
    expect(j.Label).toBe('Green');
    expect(j.Headline).toBe('Keep me');
  });

  test('sidecar without xmp namespace or Description gets one', () => {
    const bare = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF></x:xmpmeta>`;
    const out = buildSidecar({ rating: 3, flag: 0, label: '' }, bare);
    expect(isWellFormedXml(out)).toBe(true);
    expect(parseXmp(out)).toEqual({ rating: 3, flag: 0, label: '' });
    const noXmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"/></rdf:RDF></x:xmpmeta>`;
    const out2 = buildSidecar({ rating: 2, flag: 1, label: 'red' }, noXmp);
    expect(out2).toContain('xmlns:dc=');
    expect(out2).toContain('xmlns:xmp="http://ns.adobe.com/xap/1.0/"');
    expect(parseXmp(out2)).toEqual({ rating: 2, flag: 1, label: 'red' });
  });

  test('invalid existing XML falls back to a fresh packet', () => {
    for (const bad of ['<x:xmpmeta><rdf:RDF', 'garbage', '<a><b></a>', '<?xml version="1.0"?><root/>']) {
      const out = buildSidecar({ rating: 2, flag: 0, label: 'red' }, bad);
      expect(isWellFormedXml(out)).toBe(true);
      expect(parseXmp(out)).toEqual({ rating: 2, flag: 0, label: 'red' });
    }
  });
});

const FUZZ_N = Number(process.env.FUZZ_N ?? 3000);
describe('parseXmp robustness', () => {
  test('foreign rejects, stale flags, JPEG APP1 header, bytes', () => {
    expect(parseXmp('<rdf:Description xmp:Rating="-1"/>')).toEqual({ rating: 0, flag: -1, label: '' });
    const stale = buildSidecar({ rating: 0, flag: -1, label: '' }).replace('xmp:Rating="-1"', 'xmp:Rating="3"');
    expect(parseXmp(stale)).toEqual({ rating: 3, flag: 0, label: '' });
    const app1 = JPEG_XMP_HEADER + buildSidecar({ rating: 4, flag: 1, label: 'blue' });
    expect(parseXmp(app1)).toEqual({ rating: 4, flag: 1, label: 'blue' });
    expect(parseXmp(new TextEncoder().encode(app1))).toEqual({ rating: 4, flag: 1, label: 'blue' });
    expect(parseXmp(`<x xmlns:xmp="${'http://ns.adobe.com/xap/1.0/'}" xmp:Rating = ' 2.0 ' />`)).toEqual({ rating: 2, label: '' });
    expect(parseXmp('<a xmp:Label="Rot"/>')).toEqual({ label: 'red' });
  });

  test('fuzz: never throws; mutated sidecars still build valid XML', { timeout: 300_000 }, () => {
    const fuzzFiles: string[] = [];
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const alphabet = '<>/="\' :xmpRatingLabel&;#\n﻿-0123456789rdfDescription';
    const bases = [LIGHTROOM, DARKTABLE, ELEMENT_FORM, buildSidecar({ rating: 3, flag: 1, label: 'red' })];
    for (let i = 0; i < FUZZ_N; i++) {
      let s: string;
      if (i % 3 === 0) {
        s = '';
        const n = Math.floor(rnd() * 200);
        for (let k = 0; k < n; k++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      } else {
        const b = bases[i % bases.length];
        const pos = Math.floor(rnd() * b.length);
        const len = Math.floor(rnd() * 20);
        s = b.slice(0, pos) + (rnd() < 0.5 ? '' : alphabet[Math.floor(rnd() * alphabet.length)]) + b.slice(pos + len);
      }
      const p = parseXmp(s);
      if (p.rating !== undefined) expect(p.rating).toBeGreaterThanOrEqual(0);
      const bytes = new Uint8Array(Math.floor(rnd() * 64)).map(() => Math.floor(rnd() * 256));
      parseXmp(bytes);
      const out = buildSidecar({ rating: 2, flag: -1, label: 'yellow' }, s);
      expect(isWellFormedXml(out)).toBe(true);
      expect(parseXmp(out)).toEqual({ rating: 2, flag: -1, label: 'yellow' });
      if (hasExiftool && i % 50 === 1) {
        writeFileSync(join(dir, `fuzz${i}.xmp`), out);
        fuzzFiles.push(join(dir, `fuzz${i}.xmp`));
      }
    }
    if (hasExiftool) {
      // exiftool as the oracle: every merged (mutated) sidecar parses and Rating/Label are seen.
      // (-G1: a mutation can damage unrelated namespaces, e.g. x:xmpmeta's, moving tags to
      // another group; we only require that the xmp-xmp group carries our values.)
      const res = JSON.parse(execFileSync('exiftool', ['-j', '-n', '-G1', '-XMP:all', '-Warning', '-Error', ...fuzzFiles], { encoding: 'utf8' }));
      expect(res.length).toBe(fuzzFiles.length);
      for (const r of res) {
        expect(r['ExifTool:Error'], r.SourceFile).toBeUndefined();
        const src = readFileSync(r.SourceFile, 'utf8');
        if (src.includes('<x:xmpmeta') && !src.includes('xmlns:x="adobe:ns:meta/"')) continue;
        expect(r['XMP-xmp:Rating'], r.SourceFile).toBe(-1);
        expect(r['XMP-xmp:Label'], r.SourceFile).toBe('Yellow');
      }
    }
  });
});
