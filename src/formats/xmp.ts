// XMP sidecar read / write / merge. Pure TS (no DOM): runs in node, workers and main thread.
//
// Written properties:
//   xmp:Rating  -1 (reject) or 0..5            (Lightroom, Capture One, darktable, Bridge…)
//   xmp:Label   Red | Yellow | Green | Blue | Purple   (Lightroom/Bridge label names; omitted when none)
//   cull:Flag   1 | 0 | -1                     (our namespace, makes pick/reject lossless)
//   cull:Rating 0..5, only when rejected       (star rating hidden behind xmp:Rating=-1)
//
// Merging into an existing sidecar is done by local text edits (values replaced in place,
// missing attributes appended to the first rdf:Description start tag) so develop settings
// (crs:*, darktable:history, …) are preserved byte-for-byte. If the existing document is
// not well-formed or has no RDF body, a fresh packet is produced instead (never invalid XML).
import type { ColorLabel, Flag, Marks } from '../core/types';

export const NS_XMP = 'http://ns.adobe.com/xap/1.0/';
export const NS_CULL = 'https://culling-photo.app/ns/1.0/';
export const NS_RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const NS_DARKTABLE = 'http://darktable.sf.net/';
/** Header that precedes the XMP packet in a JPEG APP1 segment. */
export const JPEG_XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';

const LABEL_TO_XMP: Record<Exclude<ColorLabel, ''>, string> = {
  red: 'Red',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
};
/** darktable:colorlabels indices. */
const DT_LABELS: ColorLabel[] = ['red', 'yellow', 'green', 'blue', 'purple'];

// ---------------------------------------------------------------- names

function splitDir(path: string): [string, string] {
  const i = path.lastIndexOf('/');
  return i < 0 ? ['', path] : [path.slice(0, i + 1), path.slice(i + 1)];
}

function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 'IMG_0001.CR3' → 'IMG_0001.xmp' (Lightroom / Capture One / Bridge convention). Keeps any dir prefix. */
export function sidecarName(fileName: string): string {
  const [dir, name] = splitDir(fileName);
  return dir + stem(name) + '.xmp';
}

/** Names to probe when reading, in priority order. darktable uses 'IMG_0001.CR3.xmp'. */
export function sidecarCandidates(fileName: string): string[] {
  const [dir, name] = splitDir(fileName);
  const s = stem(name);
  return [dir + s + '.xmp', dir + s + '.XMP', dir + name + '.xmp'];
}

// ---------------------------------------------------------------- small XML helpers

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const l = e.toLowerCase();
    if (l === 'amp') return '&';
    if (l === 'lt') return '<';
    if (l === 'gt') return '>';
    if (l === 'quot') return '"';
    if (l === 'apos') return "'";
    const cp = l.startsWith('#x') ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    try {
      return String.fromCodePoint(cp);
    } catch {
      return m;
    }
  });
}

function reEsc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** All prefixes bound (anywhere in the document) to `ns`. Scoping is ignored on purpose. */
function prefixesFor(xml: string, ns: string): string[] {
  const out: string[] = [];
  const re = /xmlns:([A-Za-z_][\w.-]*)\s*=\s*(["'])(.*?)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) if (m[3] === ns && !out.includes(m[1])) out.push(m[1]);
  return out;
}

function prefixBound(xml: string, prefix: string): string | undefined {
  const m = new RegExp(`xmlns:${reEsc(prefix)}\\s*=\\s*(["'])(.*?)\\1`).exec(xml);
  return m ? m[2] : undefined;
}

/**
 * Minimal well-formedness check: tag balance, quoted attributes, no stray '<', comments/PI/CDATA.
 * Not a validating parser, but catches anything our edits (or truncated input) could break.
 */
export function isWellFormedXml(xml: string): boolean {
  const stack: string[] = [];
  let i = 0;
  let root = 0;
  const n = xml.length;
  if (xml.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    const text = xml.slice(i, lt);
    if (stack.length === 0 && text.trim() !== '') return false;
    if (/&(?!(#x[0-9a-fA-F]+|#\d+|[A-Za-z_][\w.-]*);)/.test(text)) return false;
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      if (e < 0) return false;
      i = e + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      if (e < 0 || stack.length === 0) return false;
      i = e + 3;
    } else if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt + 2);
      if (e < 0) return false;
      if (!/^[A-Za-z_][\w.:-]*(\s[\s\S]*)?$/.test(xml.slice(lt + 2, e))) return false;
      i = e + 2;
    } else if (xml.startsWith('<!', lt)) {
      if (stack.length || root) return false;
      const e = xml.indexOf('>', lt);
      if (e < 0) return false;
      i = e + 1;
    } else if (xml[lt + 1] === '/') {
      const m = /^<\/([^\s>/]+)\s*>/.exec(xml.slice(lt, lt + 300));
      if (!m || stack.pop() !== m[1]) return false;
      i = lt + m[0].length;
    } else {
      const end = scanTagEnd(xml, lt);
      if (end < 0) return false;
      const inner = xml.slice(lt + 1, end);
      const selfClose = inner.endsWith('/');
      const body = selfClose ? inner.slice(0, -1) : inner;
      const nm = /^([A-Za-z_][\w.:-]*)/.exec(body);
      if (!nm) return false;
      const attrs = body.slice(nm[1].length);
      if (!/^(\s+[A-Za-z_][\w.:-]*\s*=\s*("[^"<]*"|'[^'<]*'))*\s*$/.test(attrs)) return false;
      if (stack.length === 0) {
        if (root) return false;
        root = 1;
      }
      if (!selfClose) stack.push(nm[1]);
      i = end + 1;
    }
  }
  if (stack.length || !root) return false;
  return xml.slice(i).trim() === '' || i >= n;
}

/** Index of the '>' closing the tag that starts at `lt`, honoring quoted attribute values. */
function scanTagEnd(xml: string, lt: number): number {
  let q = '';
  for (let j = lt + 1; j < xml.length; j++) {
    const c = xml[j];
    if (q) {
      if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>') return j;
    else if (c === '<') return -1;
  }
  return -1;
}

// ---------------------------------------------------------------- parse

interface PropHit {
  value: string;
  /** Replace range of the raw value in the source. */
  start: number;
  end: number;
  form: 'attr' | 'elem';
  /** Full range to delete the property (attribute incl. leading space, or whole element). */
  delStart: number;
  delEnd: number;
}

function findProps(xml: string, prefixes: string[], local: string): PropHit[] {
  const hits: PropHit[] = [];
  for (const p of prefixes) {
    const name = reEsc(p) + ':' + local;
    // attribute form, must be inside a tag: preceded by whitespace
    const ra = new RegExp(`(\\s+)${name}\\s*=\\s*(["'])([^"'<]*)\\2`, 'g');
    let m: RegExpExecArray | null;
    while ((m = ra.exec(xml))) {
      const vStart = m.index + m[0].length - 1 - m[3].length;
      // Make sure we're inside a start tag (last '<' before is after last '>')
      const lt = xml.lastIndexOf('<', m.index);
      const gt = xml.lastIndexOf('>', m.index);
      if (lt < 0 || gt > lt) continue;
      hits.push({
        value: m[3],
        start: vStart,
        end: vStart + m[3].length,
        form: 'attr',
        delStart: m.index,
        delEnd: m.index + m[0].length,
      });
    }
    // element form: <p:Rating ...>value</p:Rating>, or empty <p:Rating/>
    const re = new RegExp(`<${name}(\\s[^>]*)?(?:/>|>([^<]*)</${name}\\s*>)`, 'g');
    while ((m = re.exec(xml))) {
      const text = m[2] ?? '';
      const tStart = m.index + 1 + p.length + 1 + local.length + (m[1]?.length ?? 0) + 1;
      const tEnd = tStart + text.length;
      // extend deletion to preceding whitespace on the same run
      let ds = m.index;
      while (ds > 0 && /[ \t]/.test(xml[ds - 1])) ds--;
      if (ds > 0 && xml[ds - 1] === '\n') ds--;
      if (ds > 0 && xml[ds - 1] === '\r') ds--;
      hits.push({
        value: decodeEntities(text),
        start: m[2] === undefined ? -1 : tStart,
        end: m[2] === undefined ? -1 : tEnd,
        form: 'elem',
        delStart: ds,
        delEnd: m.index + m[0].length,
      });
    }
  }
  return hits.sort((a, b) => a.delStart - b.delStart);
}

function stripPacketHeader(input: string | Uint8Array): string {
  let text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: false }).decode(input);
  if (text.startsWith(JPEG_XMP_HEADER)) text = text.slice(JPEG_XMP_HEADER.length);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function parseRatingValue(v: string): number | undefined {
  const f = parseFloat(v.trim());
  if (!Number.isFinite(f)) return undefined;
  const r = Math.round(f);
  return r < 0 ? -1 : Math.min(5, r);
}

function parseLabelValue(v: string): ColorLabel | undefined {
  const l = v.trim().toLowerCase();
  if (l === '') return '';
  for (const k of DT_LABELS) if (l === k) return k;
  // Common localised Lightroom / Bridge label names.
  const alias: Record<string, ColorLabel> = {
    rot: 'red', rouge: 'red', rojo: 'red', rosso: 'red', '红': 'red', '赤': 'red',
    gelb: 'yellow', jaune: 'yellow', amarillo: 'yellow', giallo: 'yellow', '黄': 'yellow',
    'grün': 'green', vert: 'green', verde: 'green', '绿': 'green', '緑': 'green',
    blau: 'blue', bleu: 'blue', azul: 'blue', blu: 'blue', '蓝': 'blue', '青': 'blue',
    lila: 'purple', violett: 'purple', violet: 'purple', morado: 'purple', viola: 'purple', '紫': 'purple',
  };
  return alias[l];
}

/**
 * Extract marks from an XMP packet / sidecar / JPEG APP1 payload. Never throws; returns only
 * the fields it found. A rating of -1 (Lightroom/darktable reject) maps to {flag:-1, rating:0}
 * unless our own cull:Rating carries the hidden star rating.
 */
export function parseXmp(input: string | Uint8Array): Partial<Marks> {
  try {
    return parseXmpUnsafe(stripPacketHeader(input));
  } catch {
    return {};
  }
}

function parseXmpUnsafe(xml: string): Partial<Marks> {
  const out: Partial<Marks> = {};
  let xmpP = prefixesFor(xml, NS_XMP);
  if (xmpP.length === 0 && !prefixBound(xml, 'xmp')) xmpP = ['xmp'];
  let cullP = prefixesFor(xml, NS_CULL);
  if (cullP.length === 0 && !prefixBound(xml, 'cull')) cullP = ['cull'];

  const ratingHit = findProps(xml, xmpP, 'Rating')[0];
  const rating = ratingHit ? parseRatingValue(ratingHit.value) : undefined;
  const flagHit = findProps(xml, cullP, 'Flag')[0];
  const flagV = flagHit ? parseInt(flagHit.value.trim(), 10) : NaN;
  const cullFlag: Flag | undefined = flagV === 1 ? 1 : flagV === -1 ? -1 : flagV === 0 ? 0 : undefined;
  const hiddenHit = findProps(xml, cullP, 'Rating')[0];
  const hidden = hiddenHit ? parseRatingValue(hiddenHit.value) : undefined;

  if (rating === -1) {
    out.flag = -1;
    out.rating = hidden !== undefined && hidden >= 0 ? hidden : 0;
  } else if (rating !== undefined) {
    out.rating = rating;
    // A stale reject flag next to a real rating means another tool un-rejected it.
    if (cullFlag !== undefined) out.flag = cullFlag === -1 ? 0 : cullFlag;
  } else if (cullFlag !== undefined) {
    out.flag = cullFlag;
    if (cullFlag === -1 && hidden !== undefined && hidden >= 0) out.rating = hidden;
  }

  const labelHit = findProps(xml, xmpP, 'Label')[0];
  if (labelHit) {
    const l = parseLabelValue(labelHit.value);
    if (l !== undefined) out.label = l;
  } else {
    const dt = darktableLabel(xml);
    if (dt !== undefined) out.label = dt;
    // A packet carrying marks but no label means "no label" (tools drop the property).
    else if (out.rating !== undefined || out.flag !== undefined) out.label = '';
  }
  return out;
}

function darktableLabel(xml: string): ColorLabel | undefined {
  const ps = prefixesFor(xml, NS_DARKTABLE);
  for (const p of ps) {
    const m = new RegExp(`<${reEsc(p)}:colorlabels\\b[^>]*>([\\s\\S]*?)</${reEsc(p)}:colorlabels\\s*>`).exec(xml);
    if (!m) continue;
    const li = /<rdf:li>\s*(\d+)\s*<\/rdf:li>/.exec(m[1]);
    if (li) return DT_LABELS[parseInt(li[1], 10)] ?? undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------- build / merge

function wanted(marks: Marks): { rating: string; label: string; flag: string; hidden?: string } {
  const r = Math.max(0, Math.min(5, Math.round(marks.rating || 0)));
  const flag: Flag = marks.flag === 1 ? 1 : marks.flag === -1 ? -1 : 0;
  return {
    rating: flag === -1 ? '-1' : String(r),
    label: marks.label ? LABEL_TO_XMP[marks.label] ?? '' : '',
    flag: String(flag),
    hidden: flag === -1 ? String(r) : undefined,
  };
}

function freshPacket(marks: Marks): string {
  const w = wanted(marks);
  const attrs = [`xmp:Rating="${w.rating}"`];
  if (w.label) attrs.push(`xmp:Label="${w.label}"`);
  attrs.push(`cull:Flag="${w.flag}"`);
  if (w.hidden !== undefined) attrs.push(`cull:Rating="${w.hidden}"`);
  return (
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Culling-Photo">\n` +
    ` <rdf:RDF xmlns:rdf="${NS_RDF}">\n` +
    `  <rdf:Description rdf:about=""\n` +
    `    xmlns:xmp="${NS_XMP}"\n` +
    `    xmlns:cull="${NS_CULL}"\n` +
    attrs.map((a) => `   ${a}`).join('\n') +
    `/>\n` +
    ` </rdf:RDF>\n` +
    `</x:xmpmeta>\n` +
    `<?xpacket end="w"?>\n`
  );
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(xml: string, edits: Edit[]): string {
  edits.sort((a, b) => b.start - a.start);
  let out = xml;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Choose a prefix for `ns`: an existing binding, else `preferred` if free, else a numbered one. */
function choosePrefix(xml: string, ns: string, preferred: string): { prefix: string } {
  const existing = prefixesFor(xml, ns);
  if (existing.length) return { prefix: existing[0] };
  let p = preferred;
  for (let k = 1; prefixBound(xml, p) !== undefined || new RegExp(`[<\\s]${reEsc(p)}:`).test(xml); k++) {
    p = preferred + k;
  }
  return { prefix: p };
}

/**
 * Produce an XMP sidecar for `marks`. With `existingXml`, merge into it: only xmp:Rating,
 * xmp:Label and cull:* are touched (attribute or element form, in place); everything else
 * is preserved. Always returns well-formed XML.
 */
export function buildSidecar(marks: Marks, existingXml?: string): string {
  if (existingXml === undefined || existingXml.trim() === '') return freshPacket(marks);
  try {
    const bom = existingXml.charCodeAt(0) === 0xfeff ? '\uFEFF' : '';
    const merged = mergeInto(stripPacketHeader(existingXml), marks);
    if (merged !== undefined && isWellFormedXml(merged)) return bom + merged;
  } catch {
    /* fall through */
  }
  return freshPacket(marks);
}

function mergeInto(xml: string, marks: Marks): string | undefined {
  if (!isWellFormedXml(xml)) return undefined;
  // Readers (exiftool, Adobe XMP SDK) reject damaged xpacket wrappers: drop any that are malformed.
  xml = xml.replace(/<\?xpacket[^?]*\?>/g, (pi) =>
    /^<\?xpacket\s+(begin\s*=\s*(["'])[^"']*\2(\s+id\s*=\s*(["'])[^"']*\4)?|end\s*=\s*(["'])[rw]\5)\s*\?>$/.test(pi) ? pi : '',
  );
  const rdfP = prefixesFor(xml, NS_RDF);
  if (!rdfP.length) return undefined;
  const w = wanted(marks);
  const xmpC = choosePrefix(xml, NS_XMP, 'xmp');
  const cullC = choosePrefix(xml, NS_CULL, 'cull');
  const xmpPs = prefixesFor(xml, NS_XMP);
  const cullPs = prefixesFor(xml, NS_CULL);

  const edits: Edit[] = [];
  const toAdd: string[] = [];

  const setProp = (prefixes: string[], local: string, value: string | undefined, addPrefix: string) => {
    const hits = prefixes.length ? findProps(xml, prefixes, local) : [];
    if (value === undefined || value === '') {
      for (const h of hits) edits.push({ start: h.delStart, end: h.delEnd, text: '' });
      return;
    }
    const [first, ...rest] = hits;
    if (first && first.start >= 0) {
      edits.push({ start: first.start, end: first.end, text: first.form === 'attr' ? escAttr(value) : value });
    } else if (first) {
      // self-closing empty element <xmp:Label/>: replace whole element keeping its name
      const el = xml.slice(first.delStart, first.delEnd);
      const nm = /<([^\s/>]+)/.exec(el)![1];
      edits.push({ start: first.delStart, end: first.delEnd, text: el.replace(/\s*\/>$/, `>${value}</${nm}>`) });
    } else {
      toAdd.push(`${addPrefix}:${local}="${escAttr(value)}"`);
    }
    for (const h of rest) edits.push({ start: h.delStart, end: h.delEnd, text: '' });
  };

  setProp(xmpPs, 'Rating', w.rating, xmpC.prefix);
  setProp(xmpPs, 'Label', w.label, xmpC.prefix);
  setProp(cullPs, 'Flag', w.flag, cullC.prefix);
  setProp(cullPs, 'Rating', w.hidden, cullC.prefix);

  if (toAdd.length) {
    // Locate first rdf:Description start tag.
    let descStart = -1;
    for (const p of rdfP) {
      const m = new RegExp(`<${reEsc(p)}:Description(?=[\\s/>])`).exec(xml);
      if (m && (descStart < 0 || m.index < descStart)) descStart = m.index;
    }
    if (descStart >= 0) {
      const end = scanTagEnd(xml, descStart);
      if (end < 0) return undefined;
      // A binding is in scope for the first Description only if declared before its tag end
      // (everything before the first Description is an ancestor).
      const head = xml.slice(0, end);
      const decls: string[] = [];
      for (const [c, ns] of [[xmpC, NS_XMP], [cullC, NS_CULL]] as const) {
        const used = toAdd.some((a) => a.startsWith(c.prefix + ':'));
        if (used && prefixBound(head, c.prefix) !== ns) decls.push(`xmlns:${c.prefix}="${ns}"`);
      }
      const all = [...decls, ...toAdd];
      const selfClose = xml[end - 1] === '/';
      const insertAt = selfClose ? end - 1 : end;
      // Mimic indentation of existing attributes if they're on separate lines.
      const tag = xml.slice(descStart, end);
      const inds = [...tag.matchAll(/\n([ \t]+)\S/g)];
      const sep = inds.length ? '\n' + inds[inds.length - 1][1] : ' ';
      // Trim trailing whitespace right before insertion point to keep the tag tidy.
      let ws = insertAt;
      while (ws > descStart && /\s/.test(xml[ws - 1])) ws--;
      edits.push({ start: ws, end: insertAt, text: all.map((a) => sep + a).join('') });
    } else {
      // No Description: add one before </rdf:RDF>.
      const rp = rdfP[0];
      const close = xml.lastIndexOf(`</${rp}:RDF`);
      if (close < 0) return undefined;
      const allDecls = [
        `xmlns:${xmpC.prefix}="${NS_XMP}"`,
        `xmlns:${cullC.prefix}="${NS_CULL}"`,
      ];
      edits.push({
        start: close,
        end: close,
        text: ` <${rp}:Description ${rp}:about=""\n    ${allDecls.join('\n    ')}\n   ${toAdd.join('\n   ')}/>\n `,
      });
    }
  }
  return applyEdits(xml, edits);
}
