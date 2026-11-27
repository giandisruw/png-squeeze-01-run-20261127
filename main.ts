// PNG squeeze entry: lossless re-encoder that beats the fixed-paeth house baseline.
// Design (my own, from the kit's spec + the scale compressor's published ideas):
//  1. Decode the stored RGBA PNG, analyse it (opaque? grey? <=256 colours? one transparent key?).
//  2. Try several exact forms: palette (colour type 3, three index orderings), grey (0),
//     grey+alpha (4), RGB (2, with a tRNS key when every transparent pixel shares one
//     colour), RGBA (6). A palette form is ~1/3 the bytes of RGB, so it wins whenever it applies.
//  3. For each form, try several per-row filter selections: fixed 0/1/2/4, the PNG-spec
//     minimum-sum heuristic, a fewest-distinct-pairs heuristic, and per-row brute force
//     (each filter weighed by a real level-4 deflate of the row against the 32 KiB before
//     it). Every candidate is weighed by a real zlib level-6 deflate of its filtered data.
//  4. Deflate the winner three ways and keep the smallest valid stream:
//     zlib level 9, zlib level 9 with Z_FILTERED, and my own zopfli-style deflate
//     (hash-chain lazy LZ77 whose match choice maximises bit savings against the
//     ~2-bit average literal cost of filtered screenshot data, then per-block dynamic
//     Huffman with package-merge length limiting). The custom stream is verified by
//     inflating it and comparing bytes; any failure falls back to zlib.
// Deterministic: no clock, no env-based variation, no randomness; the same input always
// yields the same bytes. Only Node builtins are used; no network, no files outside
// /input, /output, /tmp (plus MAKEFUN_*_DIR overrides, as the starter does, for local runs).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync, constants } from 'node:zlib';

// ---------- CRC32 (PNG chunk checksums) ----------
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- PNG writing ----------
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
function ihdr(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  d[8] = 8; // bit depth
  d[9] = colourType;
  return d;
}
function pngOf(chunks: [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  let total = 8;
  for (const [t, d] of chunks) {
    const c = chunk(t, d);
    parts.push(c);
    total += c.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------- PNG decoding (input is a stored type-6 PNG; handle the other types too) ----------
function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}
function decodePng(buf: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  let width = 0;
  let height = 0;
  let colourType = 6;
  let bitDepth = 8;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let o = 8;
  while (o + 8 <= buf.length) {
    const len = (buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3];
    const type = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      bitDepth = data[8];
      colourType = data[9];
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    o += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('unsupported bit depth ' + bitDepth);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType] ?? 4;
  const total = idat.reduce((s, p) => s + p.length, 0);
  const comp = new Uint8Array(total);
  let at = 0;
  for (const p of idat) {
    comp.set(p, at);
    at += p.length;
  }
  const raw = inflateSync(comp);
  const stride = width * channels;
  const samples = new Uint8Array(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[src++];
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const bpp = channels;
    for (let x = 0; x < stride; x++) {
      const v = raw[src++];
      const left = x >= bpp ? cur[x - bpp] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= bpp ? prev[x - bpp] : 0;
      if (f === 0) cur[x] = v;
      else if (f === 1) cur[x] = (v + left) & 0xff;
      else if (f === 2) cur[x] = (v + up) & 0xff;
      else if (f === 3) cur[x] = (v + ((left + up) >> 1)) & 0xff;
      else cur[x] = (v + paeth(left, up, upLeft)) & 0xff;
    }
  }
  // Expand samples to RGBA.
  const rgba = new Uint8Array(width * height * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    for (let i = 0, d = 0, s = 0; i < width * height; i++, d += 4, s += 3) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = 255;
    }
  } else if (colourType === 0) {
    for (let i = 0, d = 0; i < width * height; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, d = 0, s = 0; i < width * height; i++, d += 4, s += 2) {
      const g = samples[s];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = samples[s + 1];
    }
  } else if (colourType === 3 && plte) {
    for (let i = 0, d = 0; i < width * height; i++, d += 4) {
      const idx = samples[i];
      rgba[d] = plte[idx * 3];
      rgba[d + 1] = plte[idx * 3 + 1];
      rgba[d + 2] = plte[idx * 3 + 2];
      rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------- Image analysis ----------
type Colour = { rgba: number[]; word: number; count: number };
function analyse(rgba: Uint8Array) {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours: Colour[] | null = null;
  if (!many) {
    colours = [...counts.keys()].map((c) => {
      const b = new Uint8Array(Uint32Array.of(c).buffer);
      return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) ?? 0 };
    });
  }
  return { opaque, grey, colours };
}

// One fully transparent value the image may key by tRNS instead of an alpha channel.
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// ---------- Palette forms ----------
// Order palette entries: transparent first (by alpha), then by count, by luminance,
// or along a greedy nearest-neighbour path through RGB space (smooth index order makes
// Sub-filtered rows small). Ties broken by word value so the order is deterministic.
function paletteOrder(colours: Colour[], order: string): Colour[] {
  const lum = (c: Colour) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const trans = [...colours].filter((c) => c.rgba[3] !== 255);
  const opaq = [...colours].filter((c) => c.rgba[3] === 255);
  trans.sort((a, b) => a.rgba[3] - b.rgba[3] || a.word - b.word);
  if (order === 'luminance') {
    opaq.sort((a, b) => lum(a) - lum(b) || a.word - b.word);
  } else if (order === 'path') {
    opaq.sort((a, b) => b.count - a.count || a.word - b.word);
    const placed: Colour[] = [];
    const rest = [...opaq];
    if (rest.length > 0) placed.push(rest.shift() as Colour);
    while (rest.length > 0) {
      const last = placed[placed.length - 1];
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < rest.length; i++) {
        const c = rest[i];
        const dr = c.rgba[0] - last.rgba[0];
        const dg = c.rgba[1] - last.rgba[1];
        const db = c.rgba[2] - last.rgba[2];
        const d = dr * dr + dg * dg + db * db - c.count * 0.001;
        if (d < bd || (d === bd && c.word < rest[bi].word)) {
          bd = d;
          bi = i;
        }
      }
      placed.push(rest.splice(bi, 1)[0]);
    }
    return [...trans, ...placed];
  } else {
    opaq.sort((a, b) => b.count - a.count || a.word - b.word);
  }
  return [...trans, ...opaq];
}

function paletteForm(rgba: Uint8Array, colours: Colour[], order: string) {
  const entries = paletteOrder(colours, order);
  const index = new Map<number, number>(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns =
    transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]) ?? 0;
  return { plte, trns, indices };
}

// ---------- Filtering ----------
function filterRow(
  t: number,
  cur: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
  out: Uint8Array,
): void {
  const n = cur.length;
  if (t === 0) {
    out.set(cur);
    return;
  }
  for (let x = 0; x < n; x++) {
    const left = x >= bpp ? cur[x - bpp] : 0;
    const up = prev ? prev[x] : 0;
    const upLeft = prev && x >= bpp ? prev[x - bpp] : 0;
    let pred = 0;
    if (t === 1) pred = left;
    else if (t === 2) pred = up;
    else if (t === 3) pred = (left + up) >> 1;
    else pred = paeth(left, up, upLeft);
    out[x] = (cur[x] - pred) & 0xff;
  }
}
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}
const PAIR_SEEN = new Uint32Array(65536);
let pairStamp = 0;
function pairsOf(row: Uint8Array): number {
  const stamp = ++pairStamp;
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (PAIR_SEEN[pair] !== stamp) {
      PAIR_SEEN[pair] = stamp;
      n++;
    }
  }
  return n;
}

const BRUTE_CONTEXT = 32768;
type FilterChoice = number | 'minsum' | 'pairs' | 'brute';
function filtered(
  samples: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  choice: FilterChoice,
): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1));
      else {
        cost = deflateSync(trial[t], {
          level: 4,
          memLevel: 9,
          ...(before.length === 0 ? {} : { dictionary: before }),
        }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------- Screening: forms x filter choices, weighed by real zlib level 6 ----------
type Form = {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: FilterChoice[];
};
function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0]],
      ['luminance', [0, 'minsum', 'brute']],
      ['path', [0, 'minsum']],
    ] as [string, FilterChoice[]][]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) {
      trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
    }
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] ?? 4;
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'],
  });
  return forms;
}

// ---------- Custom deflate: cost-based lazy LZ77 + dynamic Huffman ----------
// DEFLATE length/distance tables (RFC 1951).
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
function lenCode(len: number): number {
  for (let i = 28; i >= 0; i--) if (len >= LEN_BASE[i]) return i;
  return 0;
}
function distCode(d: number): number {
  for (let i = 29; i >= 0; i--) if (d >= DIST_BASE[i]) return i;
  return 0;
}

// Length-limited Huffman code lengths via package-merge (limit 15, or 7 for the
// code-length code). Returns lengths with Kraft sum 1 (complete code) for >= 2 symbols.
function codeLengths(freq: number[], limit: number): number[] {
  const syms: number[] = [];
  for (let i = 0; i < freq.length; i++) if (freq[i] > 0) syms.push(i);
  const n = syms.length;
  const lengths = new Array<number>(freq.length).fill(0);
  if (n === 0) return lengths;
  if (n === 1) {
    lengths[syms[0]] = 1;
    return lengths;
  }
  type Item = { w: number; syms: number[] };
  const singletons: Item[] = syms
    .map((s) => ({ w: freq[s], syms: [s] }))
    .sort((a, b) => a.w - b.w || a.syms[0] - b.syms[0]);
  let cur: Item[] = singletons;
  for (let level = 1; level < limit; level++) {
    const pkgs: Item[] = [];
    for (let i = 0; i + 1 < cur.length; i += 2) {
      pkgs.push({ w: cur[i].w + cur[i + 1].w, syms: cur[i].syms.concat(cur[i + 1].syms) });
    }
    if (cur.length % 2 === 1) pkgs.push(cur[cur.length - 1]);
    pkgs.sort((a, b) => a.w - b.w);
    const merged: Item[] = [];
    let i = 0;
    let j = 0;
    while (i < pkgs.length && j < singletons.length) {
      if (pkgs[i].w <= singletons[j].w) merged.push(pkgs[i++]);
      else merged.push(singletons[j++]);
    }
    while (i < pkgs.length) merged.push(pkgs[i++]);
    while (j < singletons.length) merged.push(singletons[j++]);
    cur = merged;
  }
  const take = cur.slice(0, 2 * n - 2);
  const count = new Map<number, number>();
  for (const item of take) {
    for (const s of item.syms) count.set(s, (count.get(s) ?? 0) + 1);
  }
  for (const s of syms) lengths[s] = count.get(s) ?? 0;
  return lengths;
}

function canonicalCodes(lengths: number[]): { codes: number[]; maxLen: number } {
  const maxLen = Math.max(0, ...lengths);
  const blCount = new Array<number>(maxLen + 1).fill(0);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Array<number>(maxLen + 1).fill(0);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  const codes = new Array<number>(lengths.length).fill(0);
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i];
    if (l > 0) codes[i] = nextCode[l]++;
  }
  return { codes, maxLen };
}

class BitWriter {
  bytes: number[] = [];
  acc = 0;
  nbits = 0;
  write(code: number, len: number): void {
    this.acc |= (code & ((1 << len) - 1)) << this.nbits;
    this.nbits += len;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  writeRev(code: number, len: number): void {
    let rev = 0;
    for (let i = 0; i < len; i++) rev |= ((code >> (len - 1 - i)) & 1) << i;
    this.write(rev, len);
  }
  finish(): Uint8Array {
    if (this.nbits > 0) this.bytes.push(this.acc & 0xff);
    return new Uint8Array(this.bytes);
  }
}

function fixedLengths(): { lit: number[]; dist: number[] } {
  const lit = new Array<number>(288).fill(0);
  for (let i = 0; i < 144; i++) lit[i] = 8;
  for (let i = 144; i < 256; i++) lit[i] = 9;
  for (let i = 256; i < 280; i++) lit[i] = 7;
  for (let i = 280; i < 288; i++) lit[i] = 8;
  return { lit, dist: new Array<number>(32).fill(5) };
}

type Token = { lit?: number; len?: number; dist?: number };

function encodeBlock(
  bw: BitWriter,
  tokens: Token[],
  isLast: boolean,
  litLen: number[],
  distLen: number[],
): void {
  const fixed = fixedLengths();
  const fixedCost = (() => {
    let c = 3;
    for (const t of tokens) {
      if (t.lit !== undefined) c += fixed.lit[t.lit];
      else {
        const lc = lenCode(t.len as number);
        c += fixed.lit[257 + lc] + LEN_EXTRA[lc] + 5 + DIST_EXTRA[distCode(t.dist as number)];
      }
    }
    c += 7;
    return c;
  })();
  // Dynamic cost estimate (header + data) to decide fixed vs dynamic.
  const dynCost = (() => {
    let hdist = 32;
    while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
    let hlit = 288;
    while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
    const seq: number[] = [];
    for (let i = 0; i < hlit; i++) seq.push(litLen[i]);
    for (let i = 0; i < hdist; i++) seq.push(distLen[i]);
    const rle: [number, number][] = [];
    let i = 0;
    while (i < seq.length) {
      const v = seq[i];
      let run = 1;
      while (i + run < seq.length && seq[i + run] === v) run++;
      if (v === 0) {
        let r = run;
        while (r >= 11) {
          const take = Math.min(r, 138);
          rle.push([18, take]);
          r -= take;
        }
        if (r >= 3) {
          rle.push([17, r]);
          r = 0;
        }
        while (r > 0) {
          rle.push([0, 1]);
          r--;
        }
      } else {
        rle.push([v, 1]);
        let r = run - 1;
        while (r >= 3) {
          const take = Math.min(r, 6);
          rle.push([16, take]);
          r -= take;
        }
        while (r > 0) {
          rle.push([v, 1]);
          r--;
        }
      }
      i += run;
    }
    const clFreq = new Array<number>(19).fill(0);
    for (const [s] of rle) clFreq[s]++;
    const clLen = codeLengths(clFreq, 7);
    const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    let hc = 19;
    while (hc > 4 && clLen[order[hc - 1]] === 0) hc--;
    let c = 3 + 5 + 5 + 4 + 3 * hc;
    for (const [s] of rle) {
      c += clLen[s] + (s === 16 ? 2 : s === 17 ? 3 : s === 18 ? 7 : 0);
    }
    for (const t of tokens) {
      if (t.lit !== undefined) c += litLen[t.lit];
      else {
        const lc = lenCode(t.len as number);
        c += litLen[257 + lc] + LEN_EXTRA[lc] + distLen[distCode(t.dist as number)] + DIST_EXTRA[distCode(t.dist as number)];
      }
    }
    c += litLen[256];
    return c;
  })();
  const useFixed = fixedCost <= dynCost;
  const LL = useFixed ? fixed.lit : litLen;
  const DD = useFixed ? fixed.dist : distLen;
  const lc2 = canonicalCodes(LL).codes;
  const dc2 = canonicalCodes(DD).codes;
  bw.write(isLast ? 1 : 0, 1);
  if (useFixed) {
    bw.write(1, 2);
  } else {
    bw.write(2, 2);
    let hdist = 32;
    while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
    let hlit = 288;
    while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
    const seq: number[] = [];
    for (let i = 0; i < hlit; i++) seq.push(litLen[i]);
    for (let i = 0; i < hdist; i++) seq.push(distLen[i]);
    const rle: [number, number][] = [];
    let i = 0;
    while (i < seq.length) {
      const v = seq[i];
      let run = 1;
      while (i + run < seq.length && seq[i + run] === v) run++;
      if (v === 0) {
        let r = run;
        while (r >= 11) {
          const take = Math.min(r, 138);
          rle.push([18, take]);
          r -= take;
        }
        if (r >= 3) {
          rle.push([17, r]);
          r = 0;
        }
        while (r > 0) {
          rle.push([0, 1]);
          r--;
        }
      } else {
        rle.push([v, 1]);
        let r = run - 1;
        while (r >= 3) {
          const take = Math.min(r, 6);
          rle.push([16, take]);
          r -= take;
        }
        while (r > 0) {
          rle.push([v, 1]);
          r--;
        }
      }
      i += run;
    }
    const clFreq = new Array<number>(19).fill(0);
    for (const [s] of rle) clFreq[s]++;
    const clLen = codeLengths(clFreq, 7);
    const clCode = canonicalCodes(clLen).codes;
    const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    let hc = 19;
    while (hc > 4 && clLen[order[hc - 1]] === 0) hc--;
    bw.write(hlit - 257, 5);
    bw.write(hdist - 1, 5);
    bw.write(hc - 4, 4);
    for (let k = 0; k < hc; k++) bw.write(clLen[order[k]], 3);
    for (const [s, rep] of rle) {
      bw.writeRev(clCode[s], clLen[s]);
      if (s === 16) bw.write(rep - 3, 2);
      else if (s === 17) bw.write(rep - 3, 3);
      else if (s === 18) bw.write(rep - 11, 7);
    }
  }
  for (const t of tokens) {
    if (t.lit !== undefined) bw.writeRev(lc2[t.lit], LL[t.lit]);
    else {
      const lc = lenCode(t.len as number);
      bw.writeRev(lc2[257 + lc], LL[257 + lc]);
      if (LEN_EXTRA[lc]) bw.write((t.len as number) - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = distCode(t.dist as number);
      bw.writeRev(dc2[dc], DD[dc]);
      if (DIST_EXTRA[dc]) bw.write((t.dist as number) - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  bw.writeRev(lc2[256], LL[256]);
}

// Fixed-Huffman bit costs (x16) used to price match candidates while parsing.
const FIXED_COSTS = (() => {
  const f = fixedLengths();
  const len = LEN_BASE.map((b, i) => (7 + LEN_EXTRA[i]) * 16);
  const dist = DIST_BASE.map((b, i) => (5 + DIST_EXTRA[i]) * 16);
  return { lit: f.lit.map((l) => l * 16), len, dist };
})();

function hash3(d: Uint8Array, p: number): number {
  return ((d[p] << 10) ^ (d[p + 1] << 5) ^ d[p + 2]) & 32767;
}

// Lazy LZ77 parse of the whole input. A match is kept only when it saves bits
// against literals priced at ~2 bits each (filtered screenshot data is dominated
// by cheap literals, so far short matches are usually a loss); among candidates
// the one with the largest bit saving wins, which favours near matches.
function parseLZ(data: Uint8Array): Token[] {
  const n = data.length;
  const head = new Int32Array(32768).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const tokens: Token[] = [];
  const costs = FIXED_COSTS;
  const matchCost = (len: number, dist: number): number =>
    costs.len[lenCode(len)] + costs.dist[distCode(dist)];
  const LITAVG = 2 * 16; // bits x16
  const MAX_CHAIN = 64;
  const insert = (p: number): void => {
    if (p + 2 < n) {
      const h = hash3(data, p);
      prev[p] = head[h];
      head[h] = p;
    }
  };
  function longestMatch(p: number): { len: number; dist: number } {
    if (p + 3 > n) return { len: 0, dist: 0 };
    const h = hash3(data, p);
    let bestLen = 0;
    let bestDist = 0;
    let bestScore = 0;
    let cand = head[h];
    let tried = 0;
    const maxLen = Math.min(258, n - p);
    const limit = p - 32768;
    while (cand > limit && cand >= 0 && tried < MAX_CHAIN) {
      tried++;
      const floor = Math.max(2, bestLen);
      if (data[cand + floor] === data[p + floor]) {
        let l = 0;
        while (l < maxLen && data[cand + l] === data[p + l]) l++;
        if (l >= 3) {
          const score = l * LITAVG - matchCost(l, p - cand);
          if (score > bestScore) {
            bestScore = score;
            bestLen = l;
            bestDist = p - cand;
            if (l >= maxLen) break;
          }
        }
      }
      cand = prev[cand];
    }
    return bestLen >= 3 ? { len: bestLen, dist: bestDist } : { len: 0, dist: 0 };
  }
  let pos = 0;
  while (pos < n) {
    const m1 = longestMatch(pos);
    if (m1.len === 0) {
      tokens.push({ lit: data[pos] });
      insert(pos);
      pos++;
    } else {
      let take = true;
      if (pos + 1 < n && m1.len < 258) {
        const m2 = longestMatch(pos + 1);
        if (m2.len > 0) {
          const c1 = matchCost(m1.len, m1.dist);
          const c2 = costs.lit[data[pos]] + matchCost(m2.len, m2.dist);
          if (c2 < c1) take = false;
        }
      }
      if (take) {
        tokens.push({ len: m1.len, dist: m1.dist });
        for (let k = 0; k < m1.len; k++) insert(pos + k);
        pos += m1.len;
      } else {
        tokens.push({ lit: data[pos] });
        insert(pos);
        pos++;
      }
    }
  }
  return tokens;
}

function adler32(d: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < d.length; i++) {
    a = (a + d[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Custom zlib stream for `data`, or null on any internal error (caller falls back).
function deflateCustom(data: Uint8Array): Uint8Array | null {
  try {
    const tokens = parseLZ(data);
    const bw = new BitWriter();
    const BLOCK = 262144; // input bytes per dynamic-Huffman block
    const blocks: Token[][] = [];
    let start = 0;
    let covered = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      covered += t.lit !== undefined ? 1 : (t.len as number);
      if (covered >= BLOCK || i === tokens.length - 1) {
        blocks.push(tokens.slice(start, i + 1));
        start = i + 1;
        covered = 0;
      }
    }
    if (blocks.length === 0) blocks.push([]);
    for (let bi = 0; bi < blocks.length; bi++) {
      const bt = blocks[bi];
      const blf = new Array<number>(288).fill(0);
      const bdf = new Array<number>(32).fill(0);
      for (const t of bt) {
        if (t.lit !== undefined) blf[t.lit]++;
        else {
          blf[257 + lenCode(t.len as number)]++;
          bdf[distCode(t.dist as number)]++;
        }
      }
      blf[256] = 1;
      const bl = codeLengths(blf, 15);
      const bd = codeLengths(bdf, 15);
      encodeBlock(bw, bt, bi === blocks.length - 1, bl, bd);
    }
    const body = bw.finish();
    const out = new Uint8Array(2 + body.length + 4);
    out[0] = 0x78;
    out[1] = 0x9c;
    out.set(body, 2);
    const ad = adler32(data);
    out[2 + body.length] = (ad >>> 24) & 0xff;
    out[2 + body.length + 1] = (ad >>> 16) & 0xff;
    out[2 + body.length + 2] = (ad >>> 8) & 0xff;
    out[2 + body.length + 3] = ad & 0xff;
    // Self-check: the stream must inflate back to exactly `data`.
    const back = inflateSync(out);
    if (back.length !== data.length) return null;
    for (let i = 0; i < data.length; i++) if (back[i] !== data[i]) return null;
    return out;
  } catch {
    return null;
  }
}

// Best IDAT stream for one filtered data set: zlib level 9, zlib level 9 with
// Z_FILTERED, and (only for the top screened candidate, where it is worth its
// CPU cost) the custom deflate; keep the smallest valid one.
function bestIdat(data: Uint8Array, withCustom: boolean): Uint8Array {
  let idat = deflateSync(data, { level: 9, memLevel: 8 });
  const alt = deflateSync(data, { level: 9, memLevel: 8, strategy: constants.Z_FILTERED });
  if (alt.length < idat.length) idat = alt;
  if (withCustom) {
    const custom = deflateCustom(data);
    if (custom !== null && custom.length < idat.length) idat = custom;
  }
  return idat;
}

// ---------- Final encoding ----------
// The level-6 screen can mis-rank candidates under the stronger final deflates
// (the custom deflate likes different filtered data than zlib level 6 does), so
// re-encode the three best screened candidates with the final deflates and keep
// the smallest complete file.
function encodeImage(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const candidates: { form: Form; data: Uint8Array; bytes: number }[] = [];
  for (const form of formsOf(rgba)) {
    const chunks =
      (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const z = deflateSync(data, { level: 6, memLevel: 8 });
      candidates.push({ form, data, bytes: z.length + chunks });
    }
  }
  candidates.sort((a, b) => a.bytes - b.bytes);
  let bestPng: Uint8Array | null = null;
  let bestBytes = Infinity;
  for (let fi = 0; fi < candidates.slice(0, 3).length; fi++) {
    const cand = candidates[fi];
    const form = cand.form;
    const idat = bestIdat(cand.data, fi === 0);
    const overhead =
      (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
    const total = idat.length + overhead;
    if (total >= bestBytes) continue;
    bestBytes = total;
    const chunks: [string, Uint8Array][] = [['IHDR', ihdr(width, height, form.colourType)]];
    if (form.plte !== null) chunks.push(['PLTE', form.plte]);
    if (form.trns !== null) chunks.push(['tRNS', form.trns]);
    chunks.push(['IDAT', new Uint8Array(idat)]);
    chunks.push(['IEND', new Uint8Array(0)]);
    bestPng = pngOf(chunks);
  }
  if (bestPng === null) throw new Error('no candidate encoded');
  return bestPng;
}

// ---------- Main ----------
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const { width, height, rgba } = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), encodeImage(rgba, width, height));
}
