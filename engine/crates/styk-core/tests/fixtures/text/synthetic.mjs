// Fonts the fixtures need that no licence-free font in the repository provides: a CFF-outline OpenType font, a Windows
// symbol character map, a `kern` table that disagrees with a `GPOS` table, and a `GPOS` table with no kerning at all.
// Everything here is original test data. `patchSfnt` is the recipe the Rust tests repeat (tests/text_fixtures.rs).

import {createHash} from 'node:crypto';

const u16 = n => [(n >> 8) & 255, n & 255];
const i16 = n => u16(n & 0xffff);
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = s => [...s].map(c => c.charCodeAt(0));
const utf16 = s => [...s].flatMap(c => u16(c.charCodeAt(0)));

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const hex = bytes => Buffer.from(bytes).toString('hex');

const checksum = bytes => {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4)
    sum = (sum + (((bytes[i] ?? 0) << 24 | (bytes[i + 1] ?? 0) << 16 | (bytes[i + 2] ?? 0) << 8 | (bytes[i + 3] ?? 0)) >>> 0)) >>> 0;
  return sum;
};

/** Writes an sfnt from `tables` (tag → bytes): tables sorted by tag, each padded to four bytes. */
export function writeSfnt(signature, tables) {
  const tags = Object.keys(tables).sort();
  const count = tags.length, power = 2 ** Math.floor(Math.log2(count));
  const header = [...signature, ...u16(count), ...u16(power * 16), ...u16(Math.log2(power)), ...u16(count * 16 - power * 16)];
  let offset = 12 + count * 16;
  const directory = [], body = [];
  for (const tag of tags) {
    const bytes = tables[tag];
    directory.push(...ascii(tag), ...u32(checksum(bytes)), ...u32(offset), ...u32(bytes.length));
    const padded = new Uint8Array(bytes.length + ((4 - (bytes.length % 4)) % 4));
    padded.set(bytes);
    body.push(padded);
    offset += padded.length;
  }
  return Buffer.concat([Uint8Array.from([...header, ...directory]), ...body]);
}

export function readSfnt(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = [...bytes.slice(0, 4)], tables = {};
  for (let i = 0; i < view.getUint16(4); i++) {
    const at = 12 + i * 16, tag = String.fromCharCode(...bytes.slice(at, at + 4));
    tables[tag] = bytes.slice(view.getUint32(at + 8), view.getUint32(at + 8) + view.getUint32(at + 12));
  }
  return {signature, tables};
}

/** `base` with `replace` tables put in (or added) and `remove` tables left out. */
export function patchSfnt(base, {replace = {}, remove = []} = {}) {
  const {signature, tables} = readSfnt(base);
  for (const tag of remove) delete tables[tag];
  for (const [tag, bytes] of Object.entries(replace)) tables[tag] = bytes;
  return writeSfnt(signature, tables);
}

/** A `kern` table, version 0, one subtable of `[left, right, value]` pairs. */
export function kernTable(pairs) {
  const n = pairs.length;
  return Uint8Array.from([...u16(0), ...u16(1), ...u16(0), ...u16(14 + n * 6), ...u16(1), ...u16(n), ...u16(0), ...u16(0), ...u16(0),
    ...pairs.flatMap(([l, r, v]) => [...u16(l), ...u16(r), ...i16(v)])]);
}

/** A `GPOS` table whose script, feature and lookup lists are all empty: it kerns nothing and names no script. */
export function emptyGpos() {
  return Uint8Array.from([...u32(0x00010000), ...u16(10), ...u16(12), ...u16(14), ...u16(0), ...u16(0), ...u16(0)]);
}

/** A `cmap` with one (3, 0) Windows symbol subtable: `map` is character code → glyph id. */
export function symbolCmap(map) {
  const codes = Object.keys(map).map(Number).sort((a, b) => a - b);
  const segCount = codes.length + 1;
  const ends = [...codes, 0xffff], starts = [...codes, 0xffff];
  const deltas = codes.map(c => (map[c] - c) & 0xffff).concat([1]);
  const entrySelector = Math.floor(Math.log2(segCount)), searchRange = 2 * 2 ** entrySelector;
  const subtable = [...u16(4), ...u16(16 + segCount * 8), ...u16(0), ...u16(segCount * 2), ...u16(searchRange), ...u16(entrySelector),
    ...u16(segCount * 2 - searchRange), ...ends.flatMap(u16), ...u16(0), ...starts.flatMap(u16), ...deltas.flatMap(u16),
    ...new Array(segCount).fill(0).flatMap(u16)];
  return Uint8Array.from([...u16(0), ...u16(1), ...u16(3), ...u16(0), ...u32(12), ...subtable]);
}

// ---- a CFF font -------------------------------------------------------------------------------------------------

const csNum = n => {
  if (n >= -107 && n <= 107) return [n + 139];
  if (n >= 108 && n <= 1131) return [247 + ((n - 108) >> 8), (n - 108) & 255];
  if (n >= -1131 && n <= -108) return [251 + ((-n - 108) >> 8), (-n - 108) & 255];
  return [28, ...i16(n)];
};
const cs = (...parts) => parts.flatMap(p => typeof p === 'number' ? csNum(p) : p);
const op = {hstem: [1], vstem: [3], vmoveto: [4], rlineto: [5], hlineto: [6], vlineto: [7], rrcurveto: [8], callsubr: [10], return: [11],
  endchar: [14], hstemhm: [18], hintmask: [19], cntrmask: [20], rmoveto: [21], hmoveto: [22], vstemhm: [23], rcurveline: [24],
  rlinecurve: [25], vvcurveto: [26], hhcurveto: [27], callgsubr: [29], vhcurveto: [30], hvcurveto: [31], flex: [12, 35],
  hflex: [12, 34], hflex1: [12, 36], flex1: [12, 37]};

const index = objects => {
  if (!objects.length) return u16(0);
  const offsets = [1];
  for (const o of objects) offsets.push(offsets.at(-1) + o.length);
  return [...u16(objects.length), 4, ...offsets.flatMap(u32), ...objects.flat()];
};
const dictInt = n => [29, ...u32(n >>> 0)];

/** A six-glyph CFF font: .notdef, space, A, B, C, V. Every Type 2 operator the interpreter handles appears in B or C. */
export function syntheticCff() {
  const defaultWidthX = 600, nominalWidthX = 500;
  const glyphs = [
    cs(op.endchar),
    cs(-200, op.endchar), // the space declares a width of 300, hmtx says 500
    // A: width 700; a triangle, then a square by vmoveto and hlineto/vlineto
    cs(200, 50, 0, op.rmoveto, 300, 0, -150, 700, op.rlineto, 100, 200, op.rmoveto, 100, 100, -100, op.hlineto, 100, op.vmoveto, 80, -80, 60, op.vlineto),
    // B: width 650; hints and a hint mask, curves of every kind, local and global subroutines
    cs(150, 0, 100, 50, 100, op.hstemhm, 0, 100, op.vstem, op.hintmask, [0xe0], 100, 0, op.rmoveto,
      20, 0, 40, 40, 0, 60, op.rrcurveto, -107, op.callsubr, -107, op.callgsubr,
      30, 40, 50, 60, op.hvcurveto, 30, 40, 50, 60, 10, op.vhcurveto, 5, 30, 40, 50, 60, op.hhcurveto, 5, 30, 40, 50, 60, op.vvcurveto,
      10, 10, 20, 20, 30, 30, 15, 15, op.rcurveline, 5, 5, 6, 6, 10, 20, 30, 40, 50, 60, op.rlinecurve, op.endchar),
    // C: width 640; flex operators
    cs(140, 0, 0, op.rmoveto, 10, 5, 10, 5, 10, 5, 10, 5, 10, 5, 10, 5, 50, op.flex, 20, 10, 5, 10, 20, 20, 20, op.hflex,
      10, 5, 10, 5, 10, 20, 20, 5, 10, op.hflex1, 10, 5, 10, 5, 10, 5, 10, 5, 10, 5, 12, op.flex1, 1, op.hstem, op.cntrmask, [0x80], op.endchar),
    // V: width 700; a wedge
    cs(200, 0, 700, op.rmoveto, 250, -700, 250, 700, op.rlineto, -120, 0, -130, -560, op.rlineto, op.endchar),
  ];
  const localSubrs = [cs(50, 50, op.rlineto, op.return)];
  const globalSubrs = [cs(0, -100, op.rlineto, op.return)];
  const advances = [600, 500, 720, 680, 640, 700];

  const privateDict = [...dictInt(defaultWidthX), 20, ...dictInt(nominalWidthX), 21, ...dictInt(18), 19];
  const header = [1, 0, 4, 1];
  const nameIndex = index([ascii('StykTest')]);
  const stringIndex = index([]);
  const gsubrIndex = index(globalSubrs);
  const topDictFor = (charset, charStrings, privateOffset) => [...dictInt(charset), 15, ...dictInt(charStrings), 17,
    ...dictInt(privateDict.length), ...dictInt(privateOffset), 18];
  const topSize = index([topDictFor(0, 0, 0)]).length;
  const afterGsubrs = header.length + nameIndex.length + topSize + stringIndex.length + gsubrIndex.length;
  const charset = [0, ...[1, 2, 3, 4, 5].flatMap(u16)];
  const charStringsOffset = afterGsubrs + charset.length;
  const charStringsIndex = index(glyphs);
  const privateOffset = charStringsOffset + charStringsIndex.length;
  const cff = Uint8Array.from([...header, ...nameIndex, ...index([topDictFor(afterGsubrs, charStringsOffset, privateOffset)]),
    ...stringIndex, ...gsubrIndex, ...charset, ...charStringsIndex, ...privateDict, ...index(localSubrs)]);

  const codes = [[0x20, 1], [0x41, 2], [0x42, 3], [0x43, 4], [0x56, 5]];
  const segCount = codes.length + 1;
  const entrySelector = Math.floor(Math.log2(segCount)), searchRange = 2 * 2 ** entrySelector;
  const cmapSub = [...u16(4), ...u16(16 + segCount * 8), ...u16(0), ...u16(segCount * 2), ...u16(searchRange), ...u16(entrySelector),
    ...u16(segCount * 2 - searchRange), ...[...codes.map(c => c[0]), 0xffff].flatMap(u16), ...u16(0),
    ...[...codes.map(c => c[0]), 0xffff].flatMap(u16), ...[...codes.map(([c, g]) => (g - c) & 0xffff), 1].flatMap(u16), ...new Array(segCount).fill(0).flatMap(u16)];
  const cmap = [...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...cmapSub];

  const nameRecords = [
    [3, 1, 0x409, 1, utf16('Styk Test CFF')], [3, 1, 0x409, 2, utf16('Regular')],
    [1, 0, 0, 1, ascii('Styk Test CFF')],
    [3, 1, 0x407, 16, utf16('Prefam')], // the preferred family exists in German only
  ];
  let stringOffset = 0;
  const records = nameRecords.map(([p, e, l, id, bytes]) => {
    const r = [...u16(p), ...u16(e), ...u16(l), ...u16(id), ...u16(bytes.length), ...u16(stringOffset)];
    stringOffset += bytes.length;
    return r;
  });
  const name = [...u16(0), ...u16(nameRecords.length), ...u16(6 + nameRecords.length * 12), ...records.flat(), ...nameRecords.flatMap(r => r[4])];

  const head = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0x5f0f3cf5), ...u16(0), ...u16(1000), ...new Array(16).fill(0), ...i16(0), ...i16(-200),
    ...i16(1000), ...i16(900), ...u16(0), ...u16(8), ...i16(2), ...i16(0), ...i16(0)];
  const hhea = [...u32(0x00010000), ...i16(900), ...i16(-200), ...i16(0), ...u16(720), ...new Array(22).fill(0), ...u16(advances.length)];
  const maxp = [...u32(0x00005000), ...u16(advances.length)];
  const hmtx = advances.flatMap(a => [...u16(a), ...i16(0)]);
  const os2 = [...u16(1), ...i16(500), ...u16(400), ...u16(5), ...u16(0), ...new Array(22).fill(0), ...new Array(10).fill(0),
    ...new Array(16).fill(0), ...ascii('STYK'), ...u16(0x0021), ...u16(0x20), ...u16(0x56), ...i16(900), ...i16(-200), ...i16(0), ...u16(900), ...u16(200),
    ...u32(0), ...u32(0)];
  const post = [...u32(0x00030000), ...new Array(28).fill(0)];
  return writeSfnt(ascii('OTTO'), {'CFF ': Uint8Array.from([...cff]), 'OS/2': Uint8Array.from(os2), cmap: Uint8Array.from(cmap), head: Uint8Array.from(head),
    hhea: Uint8Array.from(hhea), hmtx: Uint8Array.from(hmtx), maxp: Uint8Array.from(maxp), name: Uint8Array.from(name), post: Uint8Array.from(post),
    kern: kernTable([[2, 5, -80], [5, 2, -60]])});
}

// ---- character maps ---------------------------------------------------------------------------------------------------

/** A (3, 1) `cmap` with one format 4 subtable: `segments` are `[start, end, idDelta]`; the terminating segment is added. */
export function cmapFormat4(segments) {
  const all = [...segments, [0xffff, 0xffff, 1]];
  const segCount = all.length;
  const entrySelector = Math.floor(Math.log2(segCount)), searchRange = 2 * 2 ** entrySelector;
  const sub = [...u16(4), ...u16(16 + segCount * 8), ...u16(0), ...u16(segCount * 2), ...u16(searchRange), ...u16(entrySelector),
    ...u16(segCount * 2 - searchRange), ...all.flatMap(s => u16(s[1])), ...u16(0), ...all.flatMap(s => u16(s[0])),
    ...all.flatMap(s => u16(s[2] & 0xffff)), ...all.flatMap(() => u16(0))];
  return Uint8Array.from([...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...sub]);
}

/** A (3, 10) `cmap` with one format 12 subtable: `groups` are `[start, end, firstGlyph]`. */
export function cmapFormat12(groups) {
  const sub = [...u16(12), ...u16(0), ...u32(16 + groups.length * 12), ...u32(0), ...u32(groups.length), ...groups.flatMap(([s, e, g]) => [...u32(s), ...u32(e), ...u32(g)])];
  return Uint8Array.from([...u16(0), ...u16(1), ...u16(3), ...u16(10), ...u32(12), ...sub]);
}

// ---- a TrueType font of composite glyphs ----------------------------------------------------------------------------

/**
 * A TrueType font whose glyph `top` is a stack of composites: each level refers to the one below it twice. With
 * `bomb` false the bottom is an empty composite and the top adds one triangle (so the font draws, and resolving it
 * naively takes 2^levels steps); with `bomb` true the bottom is the triangle itself (so the resolved points double at
 * every level). 'A' maps to the top glyph.
 */
export function syntheticComposite(levels, {bomb = false} = {}) {
  const word = (flags, glyph, dx = 0, dy = 0) => [...u16(flags), ...u16(glyph), ...i16(dx), ...i16(dy)];
  const composite = components => [...i16(-1), ...i16(0), ...i16(0), ...i16(0), ...i16(0), ...components.flatMap((c, i) => word(c[0] | (i < components.length - 1 ? 0x20 : 0), c[1], c[2] ?? 0, c[3] ?? 0))];
  const triangle = [...i16(1), ...i16(0), ...i16(0), ...i16(500), ...i16(700), ...u16(2), ...u16(0), 1, 1, 1, ...i16(0), ...i16(500), ...i16(-250), ...i16(0), ...i16(0), ...i16(700)];
  const glyphs = [[], triangle];
  if (bomb) {
    for (let k = 0; k < levels; k++) glyphs.push(composite([[3, glyphs.length - 1], [3, glyphs.length - 1, 10]]));
  } else {
    glyphs.push(composite([[3, 0]]));
    for (let k = 0; k < levels; k++) glyphs.push(composite([[3, glyphs.length - 1], [3, glyphs.length - 1]]));
    glyphs.push(composite([[3, glyphs.length - 1], [3, glyphs.length - 1], [3, 1, 100]]));
  }
  const top = glyphs.length - 1;
  const loca = [0], glyf = [];
  for (const g of glyphs) {
    glyf.push(...g, ...new Array((4 - (g.length % 4)) % 4).fill(0));
    loca.push(glyf.length);
  }
  const head = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0x5f0f3cf5), ...u16(0), ...u16(1000), ...new Array(16).fill(0), ...i16(0), ...i16(-200),
    ...i16(1000), ...i16(900), ...u16(0), ...u16(8), ...i16(2), ...i16(1), ...i16(0)];
  const hhea = [...u32(0x00010000), ...i16(900), ...i16(-200), ...i16(0), ...u16(720), ...new Array(22).fill(0), ...u16(glyphs.length)];
  const name = [...u16(0), ...u16(2), ...u16(6 + 2 * 12), ...u16(3), ...u16(1), ...u16(0x409), ...u16(1), ...u16(2 * 'Styk Composite'.length), ...u16(0),
    ...u16(3), ...u16(1), ...u16(0x409), ...u16(2), ...u16(2 * 'Regular'.length), ...u16(2 * 'Styk Composite'.length), ...utf16('Styk Composite'), ...utf16('Regular')];
  return writeSfnt(u32(0x00010000), {
    head: Uint8Array.from(head), hhea: Uint8Array.from(hhea), maxp: Uint8Array.from([...u32(0x00005000), ...u16(glyphs.length)]),
    hmtx: Uint8Array.from(glyphs.flatMap(() => [...u16(600), ...i16(0)])), cmap: cmapFormat4([[0x41, 0x41, top - 0x41]]),
    name: Uint8Array.from(name), post: Uint8Array.from([...u32(0x00030000), ...new Array(28).fill(0)]),
    loca: Uint8Array.from(loca.flatMap(u32)), glyf: Uint8Array.from(glyf)});
}
