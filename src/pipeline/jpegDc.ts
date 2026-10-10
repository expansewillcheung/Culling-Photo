/**
 * DC-only JPEG decoder: produces a 1/8-scale RGBA image (one pixel per 8x8 luma block)
 * without any IDCT. AC coefficients are entropy-decoded only far enough to skip them.
 *
 * Supports baseline (SOF0) and extended sequential Huffman (SOF1), 8-bit, 1 or 3
 * components, any sampling factors, restart intervals, multi-scan sequential files.
 * Returns null for anything else (progressive, arithmetic, lossless, 12-bit, CMYK,
 * truncated or corrupt data) so the caller can fall back to createImageBitmap.
 *
 * Each output pixel is the mean of its 8x8 pixel block: DC*q0/8 + 128 for full-resolution
 * components. A subsampled chroma block covers several output pixels; for those we also read
 * its three lowest AC coefficients (zigzag 1, 2, 4) and evaluate the exact mean of the
 * corresponding sub-block, which keeps colour edges as sharp as the true box average.
 * Sampling ratios that do not divide 8 fall back to bilinear interpolation of the DC grid.
 * EXIF orientation is not applied.
 */

export interface DcImage {
  width: number;
  height: number;
  /** RGBA, width*height*4. */
  data: Uint8ClampedArray;
}

/** True when a 1/8-scale decode still covers a thumbnail of `targetLongEdge` px. */
export function dcDecodeWorthIt(width: number, height: number, targetLongEdge: number): boolean {
  return Math.max(width, height) / 8 >= targetLongEdge * 0.9;
}

const LB = 12; // fast-lookup bits
const LSIZE = 1 << LB;
const LMASK = LSIZE - 1;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const EMPTY16 = new Int16Array(0);

interface Huff {
  /** Fast table indexed by the next LB bits; 0 = code longer than LB (slow path).
   *  DC: (len + size) | (diff << 8) when the code and its value bits fit in LB, else
   *      len | 0x80 | (size << 8).
   *  AC: bits 0-4  bits consumed by the first symbol (code + value bits)
   *      bits 5-11 coefficient advance of the first symbol (run + 1; 16 = ZRL; 64 = EOB)
   *      bits 12-16 bits consumed by first + second symbol (when both fit in LB, else = first)
   *      bits 17+  advance of first + second symbol. */
  lut: Int32Array;
  /** Single-symbol table: len | (symbol << 8); 0 = longer than LB. */
  one: Int32Array;
  /** AC symbol + value table, for codes whose value bits also fit in LB:
   *  (len + size) | (run << 5) | (size == 0 ? 512 : 0) | (value << 16); 0 = not fast. */
  acv: Int32Array;
  /** maxcode[l] for l=1..16 (-1 if none) and vals offset per length (vals[valoff[l] + code]). */
  maxcode: Int32Array;
  valoff: Int32Array;
  vals: Uint8Array;
}

function buildHuff(counts: Uint8Array, vals: Uint8Array, isAc: boolean): Huff {
  const maxcode = new Int32Array(18).fill(-1);
  const valoff = new Int32Array(18);
  const one = new Int32Array(LSIZE);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = counts[l - 1];
    if (n) {
      valoff[l] = k - code;
      for (let i = 0; i < n; i++, k++, code++) {
        if (code >= 1 << l) throw new Error('bad huffman table');
        if (l <= LB) {
          const shift = LB - l;
          one.fill(l | (vals[k] << 8), code << shift, (code + 1) << shift);
        }
      }
      maxcode[l] = code - 1;
    }
    code <<= 1;
  }
  const lut = new Int32Array(LSIZE);
  const acv = new Int32Array(isAc ? LSIZE : 0);
  for (let idx = 0; idx < LSIZE; idx++) {
    const o = one[idx];
    if (!o) continue;
    const len = o & 255;
    const sym = o >> 8;
    if (!isAc) {
      const s = sym;
      if (s > 15) continue; // invalid; left to the slow path, which rejects it
      if (len + s <= LB) {
        let d = s ? (idx >> (LB - len - s)) & ((1 << s) - 1) : 0;
        if (s && d < 1 << (s - 1)) d += 1 - (1 << s);
        lut[idx] = (len + s) | (d << 8);
      } else {
        lut[idx] = len | 0x80 | (s << 8);
      }
      continue;
    }
    const size = sym & 15;
    const run = sym >> 4;
    const adv = size === 0 ? (run === 15 ? 16 : 64) : run + 1;
    const b1 = len + size;
    if (b1 <= LB) {
      let v = size ? (idx >> (LB - b1)) & ((1 << size) - 1) : 0;
      if (size && v < 1 << (size - 1)) v += 1 - (1 << size);
      acv[idx] = b1 | (run << 5) | (size === 0 ? 512 : 0) | (v << 16);
    }
    let b2 = b1;
    let a2 = adv;
    if (adv < 64 && b1 < LB) {
      const o2 = one[(idx << b1) & LMASK];
      const len2 = o2 & 255;
      if (o2 && len2 <= LB - b1) {
        const sym2 = o2 >> 8;
        const size2 = sym2 & 15;
        if (b1 + len2 + size2 <= LB) {
          b2 = b1 + len2 + size2;
          a2 = adv + (size2 === 0 ? (sym2 >> 4 === 15 ? 16 : 64) : (sym2 >> 4) + 1);
        }
      }
    }
    lut[idx] = b1 | (adv << 5) | (b2 << 12) | (a2 << 17);
  }
  return { lut, one, acv, maxcode, valoff, vals };
}

interface Comp {
  id: number;
  h: number;
  v: number;
  tq: number;
  /** Quantization table (zigzag order) captured at the component's first scan. */
  q: Uint16Array | null;
  /** Blocks per line / column actually covered by image data. */
  bw: number;
  bh: number;
  /** Storage stride (blocks per padded MCU row). */
  stride: number;
  dc: Int16Array;
  /** Output pixels per block horizontally / vertically (hmax/h, vmax/v). */
  nx: number;
  ny: number;
  /** Zigzag coefficients 1, 2, 4 per block (subsampled components with nx, ny dividing 8). */
  ac: Int16Array | null;
}

let scratch = new Uint8Array(0);

/** Remove byte stuffing and RST markers from the scan starting at `pos`; records the
 *  unstuffed offset of each restart segment. Returns the data as big-endian 32-bit words
 *  (zero padded); `end` is the terminating marker's position or -1 if truncated. */
function unstuff(bytes: Uint8Array, pos: number, segStarts: number[]): { end: number; len: number; words: Uint32Array } {
  const need = (bytes.length - pos + 512) & ~3;
  if (scratch.length < need) scratch = new Uint8Array(need);
  const out = scratch;
  let o = 0;
  const n = bytes.length;
  let end = -1;
  while (pos < n) {
    const i = bytes.indexOf(0xff, pos);
    if (i < 0) {
      out.set(bytes.subarray(pos, n), o);
      o += n - pos;
      pos = n;
      break;
    }
    if (i > pos) {
      out.set(bytes.subarray(pos, i), o);
      o += i - pos;
    }
    if (i + 1 >= n) { pos = n; break; }
    const m = bytes[i + 1];
    if (m === 0) {
      out[o++] = 0xff;
      pos = i + 2;
    } else if (m === 0xff) {
      pos = i + 1; // fill byte
    } else if (m >= 0xd0 && m <= 0xd7) {
      segStarts.push(o);
      pos = i + 2;
    } else {
      end = i;
      break;
    }
  }
  out.fill(0, o, o + 256);
  const nw = ((o + 3) >> 2) + 16;
  const words = new Uint32Array(out.buffer, 0, nw);
  if (LITTLE_ENDIAN) {
    for (let i = 0; i < nw; i++) {
      const x = words[i];
      words[i] = (x << 24) | ((x & 0xff00) << 8) | ((x >>> 8) & 0xff00) | (x >>> 24);
    }
  }
  return { end, len: o, words };
}

/** Slow path for codes longer than LB bits. Returns (len | symbol << 8) or -1. */
function slowDecode(h: Huff, code16: number): number {
  const mc = h.maxcode;
  for (let l = LB + 1; l <= 16; l++) {
    const c = code16 >>> (16 - l);
    if (c <= mc[l]) return l | (h.vals[h.valoff[l] + c] << 8);
  }
  return -1;
}

/** Decode a scan, storing each block's DC value (and low AC terms where wanted).
 *  The bit reader peeks 32 bits at an absolute bit position from big-endian words, so there is
 *  no refill loop. Returns false on error/truncation. */
function decodeScan(
  W: Uint32Array,
  dataLen: number,
  segStarts: number[],
  comps: Comp[],
  dcT: Huff[],
  acT: Huff[],
  mcusX: number,
  mcusY: number,
  restart: number,
): boolean {
  const nc = comps.length;
  // For single-component scans an MCU is one block over the component's own grid.
  const single = nc === 1;
  const mx = single ? comps[0].bw : mcusX;
  const my = single ? comps[0].bh : mcusY;
  // Flattened per-MCU block list.
  const bComp: number[] = [];
  const bInner: number[] = [];
  const bRow: number[] = [];
  const bCol: number[] = [];
  const bNeedAc: number[] = [];
  const bDcLut: Int32Array[] = [];
  const bAcLut: Int32Array[] = [];
  const bOne: Int32Array[] = [];
  const bAcv: Int32Array[] = [];
  const bDcH: Huff[] = [];
  const bAcH: Huff[] = [];
  const bArr: Int16Array[] = [];
  const bAc: Int16Array[] = [];
  for (let c = 0; c < nc; c++) {
    const cp = comps[c];
    const H = single ? 1 : cp.h;
    const V = single ? 1 : cp.v;
    for (let v = 0; v < V; v++) {
      for (let h = 0; h < H; h++) {
        bComp.push(c);
        bInner.push(v * cp.stride + h);
        bRow.push(V * cp.stride);
        bCol.push(H);
        bNeedAc.push(cp.ac ? 1 : 0);
        bDcLut.push(dcT[c].lut);
        bAcLut.push(acT[c].lut);
        bOne.push(acT[c].one);
        bAcv.push(acT[c].acv);
        bDcH.push(dcT[c]);
        bAcH.push(acT[c]);
        bArr.push(cp.dc);
        bAc.push(cp.ac ?? EMPTY16);
      }
    }
  }
  const nb = bComp.length;
  const offs = new Int32Array(nb);
  const pred = new Int32Array(nc);
  const limit = (dataLen + 64) * 8;
  let todo = restart > 0 ? restart : -1;
  let seg = 0;
  let pos = 0; // bit position
  let w = 0, sh = 0, peek = 0;

  for (let y = 0; y < my; y++) {
    if (pos > limit) return false;
    for (let b = 0; b < nb; b++) offs[b] = y * bRow[b] + bInner[b];
    for (let x = 0; x < mx; x++) {
      if (todo === 0) {
        // restart: jump to the next segment (or byte-align if markers are missing), reset predictors
        if (seg < segStarts.length) pos = segStarts[seg++] * 8;
        else pos = (pos + 7) & ~7;
        for (let c = 0; c < nc; c++) pred[c] = 0;
        todo = restart;
      }
      if (todo > 0) todo--;
      for (let b = 0; b < nb; b++) {
        const c = bComp[b];
        const bi = offs[b] + x * bCol[b];
        // ---- DC ----
        w = pos >>> 5; sh = pos & 31;
        peek = (W[w] << sh) | ((W[w + 1] >>> 1) >>> (31 - sh));
        let e = bDcLut[b][peek >>> (32 - LB)];
        if (e !== 0 && (e & 0x80) === 0) {
          pos += e & 31;
          pred[c] += e >> 8;
        } else {
          if (e === 0) {
            e = slowDecode(bDcH[b], peek >>> 16);
            if (e < 0) return false;
          }
          pos += e & 31;
          const s = e >> 8;
          if (s > 15) return false;
          if (s !== 0) {
            w = pos >>> 5; sh = pos & 31;
            peek = (W[w] << sh) | ((W[w + 1] >>> 1) >>> (31 - sh));
            let d = peek >>> (32 - s);
            pos += s;
            if (d < 1 << (s - 1)) d += 1 - (1 << s);
            pred[c] += d;
          }
        }
        bArr[b][bi] = pred[c];
        let k = 1;
        // ---- low AC terms (zigzag 1, 2, 4) for subsampled chroma ----
        if (bNeedAc[b] !== 0) {
          let z1 = 0, z2 = 0, z4 = 0;
          const one = bOne[b];
          const acv = bAcv[b];
          while (k <= 4) {
            w = pos >>> 5; sh = pos & 31;
            peek = (W[w] << sh) | ((W[w + 1] >>> 1) >>> (31 - sh));
            const f = acv[peek >>> (32 - LB)];
            if (f !== 0) {
              pos += f & 31;
              if ((f & 512) !== 0) {
                if (((f >> 5) & 15) !== 15) { k = 64; break; } // EOB
                k += 16;
                continue;
              }
              k += (f >> 5) & 15;
              if (k === 1) z1 = f >> 16;
              else if (k === 2) z2 = f >> 16;
              else if (k === 4) z4 = f >> 16;
              k++;
              continue;
            }
            let o1 = one[peek >>> (32 - LB)];
            if (o1 === 0) {
              o1 = slowDecode(bAcH[b], peek >>> 16);
              if (o1 < 0) return false;
            }
            pos += o1 & 31;
            const sym = o1 >> 8;
            const size = sym & 15;
            if (size === 0) {
              if (sym !== 0xf0) { k = 64; break; } // EOB
              k += 16;
              continue;
            }
            k += sym >> 4;
            w = pos >>> 5; sh = pos & 31;
            peek = (W[w] << sh) | ((W[w + 1] >>> 1) >>> (31 - sh));
            let v = peek >>> (32 - size);
            pos += size;
            if (v < 1 << (size - 1)) v += 1 - (1 << size);
            if (k === 1) z1 = v;
            else if (k === 2) z2 = v;
            else if (k === 4) z4 = v;
            k++;
          }
          const a = bAc[b];
          a[bi * 3] = z1; a[bi * 3 + 1] = z2; a[bi * 3 + 2] = z4;
          if (k >= 64) continue;
        }
        // ---- AC: skip ----
        const alut = bAcLut[b];
        for (;;) {
          w = pos >>> 5; sh = pos & 31;
          peek = (W[w] << sh) | ((W[w + 1] >>> 1) >>> (31 - sh));
          e = alut[peek >>> (32 - LB)];
          if (e !== 0) {
            if (k + ((e >> 5) & 127) >= 64) { pos += e & 31; break; }
            pos += (e >> 12) & 31;
            k += e >> 17;
            if (k >= 64) break;
          } else {
            e = slowDecode(bAcH[b], peek >>> 16);
            if (e < 0) return false;
            const sym = e >> 8;
            const size = sym & 15;
            pos += (e & 31) + size;
            if (size === 0) {
              if (sym !== 0xf0) break; // EOB
              k += 16;
            } else {
              k += (sym >> 4) + 1;
            }
            if (k >= 64) break;
          }
        }
      }
    }
  }
  return pos <= (dataLen + 4) * 8;
}

export function decodeJpegDc(bytes: Uint8Array): DcImage | null {
  try {
    return decodeInner(bytes);
  } catch {
    return null;
  }
}

function decodeInner(bytes: Uint8Array): DcImage | null {
  const n = bytes.length;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const qt: (Uint16Array | undefined)[] = [];
  const dcTables: (Huff | undefined)[] = [];
  const acTables: (Huff | undefined)[] = [];
  let comps: Comp[] | null = null;
  let width = 0;
  let height = 0;
  let hmax = 1;
  let vmax = 1;
  let mcusX = 0;
  let mcusY = 0;
  let restart = 0;
  let adobe = -1;
  let scans = 0;
  let pos = 2;

  while (pos < n) {
    if (bytes[pos] !== 0xff) {
      pos++; // garbage between segments: scan forward to the next marker
      continue;
    }
    const m = bytes[pos + 1];
    if (m === 0xff) { pos++; continue; }
    pos += 2;
    if (m === 0xd9) break; // EOI
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    if (pos + 2 > n) return null;
    const len = (bytes[pos] << 8) | bytes[pos + 1];
    if (len < 2 || pos + len > n) return null;
    const seg = pos + 2;
    const segEnd = pos + len;
    switch (m) {
      case 0xdb: { // DQT
        let q = seg;
        while (q < segEnd) {
          const pq = bytes[q] >> 4;
          const tq = bytes[q] & 15;
          if (tq > 3 || q + 1 + 64 * (pq ? 2 : 1) > segEnd) return null;
          const t = new Uint16Array(64);
          for (let i = 0; i < 64; i++) t[i] = pq ? (bytes[q + 1 + 2 * i] << 8) | bytes[q + 2 + 2 * i] : bytes[q + 1 + i];
          qt[tq] = t;
          q += 1 + 64 * (pq ? 2 : 1);
        }
        break;
      }
      case 0xc4: { // DHT
        let q = seg;
        while (q < segEnd) {
          const tc = bytes[q] >> 4;
          const th = bytes[q] & 15;
          if (tc > 1 || th > 3) return null;
          const counts = bytes.subarray(q + 1, q + 17);
          let total = 0;
          for (let i = 0; i < 16; i++) total += counts[i];
          if (q + 17 + total > segEnd) return null;
          const t = buildHuff(counts, bytes.slice(q + 17, q + 17 + total), tc === 1);
          if (tc === 0) dcTables[th] = t;
          else acTables[th] = t;
          q += 17 + total;
        }
        break;
      }
      case 0xdd: // DRI
        restart = (bytes[seg] << 8) | bytes[seg + 1];
        break;
      case 0xee: // APP14 Adobe: transform flag
        if (len >= 14 && bytes[seg] === 0x41 && bytes[seg + 1] === 0x64 && bytes[seg + 2] === 0x6f &&
            bytes[seg + 3] === 0x62 && bytes[seg + 4] === 0x65) adobe = bytes[seg + 11];
        break;
      case 0xc0:
      case 0xc1: { // SOF0 / SOF1
        if (comps) return null;
        if (bytes[seg] !== 8) return null;
        height = (bytes[seg + 1] << 8) | bytes[seg + 2];
        width = (bytes[seg + 3] << 8) | bytes[seg + 4];
        const nc = bytes[seg + 5];
        if (!width || !height || (nc !== 1 && nc !== 3) || len < 8 + 3 * nc) return null;
        comps = [];
        for (let i = 0; i < nc; i++) {
          const b = seg + 6 + i * 3;
          const h = bytes[b + 1] >> 4;
          const v = bytes[b + 1] & 15;
          if (h < 1 || h > 4 || v < 1 || v > 4) return null;
          comps.push({ id: bytes[b], h, v, tq: bytes[b + 2] & 3, q: null, bw: 0, bh: 0, stride: 0, dc: EMPTY16, nx: 1, ny: 1, ac: null });
          hmax = Math.max(hmax, h);
          vmax = Math.max(vmax, v);
        }
        mcusX = Math.ceil(width / (8 * hmax));
        mcusY = Math.ceil(height / (8 * vmax));
        for (const c of comps) {
          c.bw = Math.ceil(Math.ceil((width * c.h) / hmax) / 8);
          c.bh = Math.ceil(Math.ceil((height * c.v) / vmax) / 8);
          c.stride = mcusX * c.h;
          const blocks = c.stride * mcusY * c.v;
          c.dc = new Int16Array(blocks);
          c.nx = hmax / c.h;
          c.ny = vmax / c.v;
          const ok = (r: number) => Number.isInteger(r) && 8 % r === 0;
          if (nc > 1 && (c.nx > 1 || c.ny > 1) && ok(c.nx) && ok(c.ny)) c.ac = new Int16Array(blocks * 3);
        }
        break;
      }
      case 0xda: { // SOS
        if (!comps) return null;
        const ns = bytes[seg];
        if (ns < 1 || ns > comps.length || len < 6 + 2 * ns) return null;
        const sc: Comp[] = [];
        const dcT: Huff[] = [];
        const acT: Huff[] = [];
        for (let i = 0; i < ns; i++) {
          const id = bytes[seg + 1 + i * 2];
          const t = bytes[seg + 2 + i * 2];
          const c = comps.find((x) => x.id === id);
          const d = dcTables[t >> 4];
          const a = acTables[t & 15];
          if (!c || !d || !a) return null;
          if (!c.q) {
            const q = qt[c.tq];
            if (!q) return null;
            c.q = q;
          }
          sc.push(c);
          dcT.push(d);
          acT.push(a);
        }
        const segStarts: number[] = [];
        const { end, len: dataLen, words } = unstuff(bytes, segEnd, segStarts);
        if (end < 0) return null; // truncated
        if (!decodeScan(words, dataLen, segStarts, sc, dcT, acT, mcusX, mcusY, restart)) return null;
        scans++;
        pos = end;
        continue;
      }
      default:
        // SOF2/3/5-7/9-15 (progressive, lossless, hierarchical, arithmetic), DAC, DNL
        if ((m >= 0xc2 && m <= 0xcf && m !== 0xc4 && m !== 0xc8) || m === 0xdc) return null;
    }
    pos = segEnd;
  }
  if (!comps || !scans) return null;
  for (const c of comps) if (!c.q) return null; // component never coded
  return toRgba(comps, width, height, adobe);
}

/** Mean of cos((2x+1)*pi/16) over sub-range j of n equal parts of x = 0..7 (0 when n = 1). */
function cosMean(n: number, j: number): number {
  const a = (8 / n) * j, b = (8 / n) * (j + 1);
  let s = 0;
  for (let x = a; x < b; x++) s += Math.cos(((2 * x + 1) * Math.PI) / 16);
  return s / (b - a);
}

/** Produces one output row of a component's block means (+bias). */
class RowSampler {
  private readonly c: Comp;
  private readonly W: number;
  private readonly bias: number;
  private readonly q0: number;
  readonly row: Float32Array;
  // AC mode: per-column block index and horizontal weights
  private readonly bx: Int32Array;
  private readonly ax: Float32Array;
  private readonly cx: Float32Array;
  private readonly kv: number;
  // bilinear fallback taps
  private readonly tx: Taps | null;
  private readonly ty: Taps | null;
  private readonly tmp: Float32Array;

  constructor(c: Comp, bias: number, W: number, H: number) {
    this.c = c;
    this.W = W;
    this.bias = bias;
    const q = c.q!;
    this.q0 = q[0] / 8;
    this.row = new Float32Array(W);
    this.tmp = new Float32Array(W);
    this.bx = new Int32Array(W);
    this.ax = new Float32Array(W);
    this.cx = new Float32Array(W);
    // f(x,y) = sum C(u)C(v)/4 F(u,v) cos_u(x) cos_v(y): means over a sub-block of the u=1/v=1 terms
    const K = 1 / (4 * Math.SQRT2);
    this.kv = q[2] * K;
    const nx = c.nx;
    const mx = new Float64Array(nx);
    for (let j = 0; j < nx; j++) mx[j] = cosMean(nx, j);
    for (let x = 0; x < W; x++) {
      this.bx[x] = Math.min(Math.floor(x / nx), c.bw - 1);
      this.ax[x] = q[1] * K * mx[x % nx];
      this.cx[x] = (q[4] / 4) * mx[x % nx];
    }
    const subsampled = c.nx !== 1 || c.ny !== 1;
    this.tx = subsampled && !c.ac ? taps(W, 1 / c.nx, c.bw) : null;
    this.ty = subsampled && !c.ac ? taps(H, 1 / c.ny, c.bh) : null;
  }

  fill(y: number): Float32Array {
    const { c, W, row, bias, q0 } = this;
    const dc = c.dc;
    if (c.ac) {
      const ny = c.ny;
      const by = Math.min(Math.floor(y / ny), c.bh - 1);
      const my = cosMean(ny, y % ny);
      const r = by * c.stride;
      const ac = c.ac, bx = this.bx, ax = this.ax, cx = this.cx;
      const bv = this.kv * my;
      for (let x = 0; x < W; x++) {
        const i = r + bx[x];
        const i3 = i * 3;
        row[x] = dc[i] * q0 + ac[i3] * ax[x] + ac[i3 + 1] * bv + ac[i3 + 2] * cx[x] * my + bias;
      }
      return row;
    }
    if (!this.tx || !this.ty) {
      const r = Math.min(y, c.bh - 1) * c.stride;
      for (let x = 0; x < W; x++) row[x] = dc[r + x] * q0 + bias;
      return row;
    }
    const ty = this.ty;
    const wy = ty.w[y];
    this.hrow(ty.i0[y] * c.stride, row);
    if (wy !== 0) {
      const tmp = this.tmp;
      this.hrow(ty.i1[y] * c.stride, tmp);
      for (let x = 0; x < W; x++) row[x] += (tmp[x] - row[x]) * wy;
    }
    return row;
  }

  private hrow(r: number, out: Float32Array): void {
    const dc = this.c.dc, q = this.q0, bias = this.bias;
    const { i0, i1, w } = this.tx!;
    for (let x = 0; x < this.W; x++) {
      const a = dc[r + i0[x]];
      out[x] = (a + (dc[r + i1[x]] - a) * w[x]) * q + bias;
    }
  }
}

interface Taps { i0: Int32Array; i1: Int32Array; w: Float32Array }

/** Bilinear taps mapping n output samples onto a grid of `len` blocks at ratio f (<1). */
function taps(n: number, f: number, len: number): Taps {
  const i0 = new Int32Array(n), i1 = new Int32Array(n), w = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    // centre of output pixel x, in units of this component's blocks (block centres at b + 0.5)
    const t = (x + 0.5) * f - 0.5;
    let b = Math.floor(t);
    let wt = t - b;
    if (b < 0) { b = 0; wt = 0; }
    if (b >= len - 1) { b = len - 1; wt = 0; }
    i0[x] = b;
    i1[x] = Math.min(b + 1, len - 1);
    w[x] = wt;
  }
  return { i0, i1, w };
}

function toRgba(comps: Comp[], width: number, height: number, adobe: number): DcImage {
  const W = Math.ceil(width / 8);
  const H = Math.ceil(height / 8);
  const out = new Uint8ClampedArray(W * H * 4);
  if (comps.length === 1) {
    const g = new RowSampler(comps[0], 128, W, H);
    for (let y = 0, o = 0; y < H; y++) {
      const row = g.fill(y);
      for (let x = 0; x < W; x++, o += 4) {
        const v = row[x];
        out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
      }
    }
    return { width: W, height: H, data: out };
  }
  const [c0, c1, c2] = comps;
  // RGB if Adobe transform=0, or no Adobe marker and component ids spell 'RGB'.
  const rgb = adobe === 0 || (adobe < 0 && c0.id === 0x52 && c1.id === 0x47 && c2.id === 0x42);
  const sy = new RowSampler(c0, 128.5, W, H); // +0.5: round when truncating below
  const sa = new RowSampler(c1, rgb ? 128.5 : 0, W, H);
  const sb = new RowSampler(c2, rgb ? 128.5 : 0, W, H);
  const u32 = LITTLE_ENDIAN ? new Uint32Array(out.buffer) : null;
  for (let y = 0, o = 0; y < H; y++) {
    const Y = sy.fill(y), A = sa.fill(y), B = sb.fill(y);
    for (let x = 0; x < W; x++, o += 4) {
      let r: number, g: number, b: number;
      if (rgb) {
        r = Y[x] | 0; g = A[x] | 0; b = B[x] | 0;
      } else {
        const l = Y[x], cb = A[x], cr = B[x];
        r = (l + 1.402 * cr) | 0;
        g = (l - 0.344136 * cb - 0.714136 * cr) | 0;
        b = (l + 1.772 * cb) | 0;
      }
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;
      // little-endian: R in the low byte
      if (u32) u32[o >> 2] = r | (g << 8) | (b << 16) | 0xff000000;
      else { out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255; }
    }
  }
  return { width: W, height: H, data: out };
}
