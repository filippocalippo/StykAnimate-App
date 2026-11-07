// Checks the bundled TrueType fonts against the WOFF2 subsets the web build ships, for `cargo xtask fonts verify`.
//
//   node fonts-verify.mjs
//
// The native interface bundles Inter and Inter Tight as whole variable TrueType files (iced's text stack cannot read
// WOFF2). This proves they are the fonts the app's own subsets were cut from, without a Python toolchain: Node's
// zlib decodes the WOFF2 brotli stream, the untransformed tables (cmap, hmtx, head, hhea, name, fvar, GSUB) are read
// from it, and for every code point of every subset the bundled font has the same default-instance advance width. It
// also lists the OpenType features each subset keeps: a feature the subsets lost (cv11, ss01) has no effect in
// today's app and none must be drawn natively.
//
// Glyph outlines are the one thing it does not compare (WOFF2 transforms glyf); the pixel comparison with Chromium
// in `cargo xtask fonts` covers them.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const KNOWN = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

/** Tables of a WOFF2 file by tag, as the bytes of the (decompressed) table data. */
function woff2Tables(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x774f4632) throw new Error('not a WOFF2 file');
  const count = view.getUint16(12);
  const compressed = view.getUint32(20);
  let at = 48;
  const base128 = () => { let value = 0; for (let i = 0; i < 5; i += 1) { const byte = bytes[at++]; value = (value << 7) | (byte & 0x7f); if (!(byte & 0x80)) return value >>> 0; } throw new Error('bad UIntBase128'); };
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const flags = bytes[at++];
    let tag = KNOWN[flags & 0x3f];
    if ((flags & 0x3f) === 0x3f) { tag = String.fromCharCode(...bytes.slice(at, at + 4)); at += 4; }
    const version = flags >> 6;
    const length = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    entries.push({ tag, length: transformed ? base128() : length, transformed });
  }
  const data = zlib.brotliDecompressSync(bytes.slice(at, at + compressed));
  const tables = new Map();
  let offset = 0;
  for (const entry of entries) {
    tables.set(entry.tag, { bytes: data.subarray(offset, offset + entry.length), transformed: entry.transformed });
    offset += entry.length;
  }
  return tables;
}

/** Tables of a TrueType file by tag. */
function ttfTables(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map();
  for (let i = 0; i < view.getUint16(4); i += 1) {
    const at = 12 + 16 * i;
    const tag = String.fromCharCode(...bytes.slice(at, at + 4));
    tables.set(tag, { bytes: bytes.subarray(view.getUint32(at + 8), view.getUint32(at + 8) + view.getUint32(at + 12)), transformed: false });
  }
  return tables;
}

function cmap(table) {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const map = new Map();
  let best = null;
  for (let i = 0; i < view.getUint16(2); i += 1) {
    const platform = view.getUint16(4 + 8 * i), encoding = view.getUint16(6 + 8 * i), offset = view.getUint32(8 + 8 * i);
    const format = view.getUint16(offset);
    if ((platform === 3 && encoding === 10 && format === 12) || (!best && platform === 3 && encoding === 1 && format === 4) || (!best && platform === 0)) best = { offset, format };
    if (platform === 3 && encoding === 10) best = { offset, format };
  }
  if (!best) throw new Error('no usable cmap');
  const { offset, format } = best;
  if (format === 12) {
    for (let g = 0; g < view.getUint32(offset + 12); g += 1) {
      const at = offset + 16 + 12 * g;
      const start = view.getUint32(at), end = view.getUint32(at + 4), glyph = view.getUint32(at + 8);
      for (let code = start; code <= end; code += 1) map.set(code, glyph + code - start);
    }
  } else if (format === 4) {
    const segments = view.getUint16(offset + 6) / 2;
    const ends = offset + 14, starts = ends + 2 * segments + 2, deltas = starts + 2 * segments, ranges = deltas + 2 * segments;
    for (let s = 0; s < segments; s += 1) {
      const end = view.getUint16(ends + 2 * s), start = view.getUint16(starts + 2 * s), delta = view.getInt16(deltas + 2 * s), range = view.getUint16(ranges + 2 * s);
      for (let code = start; code <= end && code !== 0xffff; code += 1) {
        let glyph;
        if (range === 0) glyph = (code + delta) & 0xffff;
        else { const at = ranges + 2 * s + range + 2 * (code - start); glyph = view.getUint16(at); if (glyph) glyph = (glyph + delta) & 0xffff; }
        if (glyph) map.set(code, glyph);
      }
    }
  } else throw new Error(`cmap format ${format}`);
  return map;
}

function advances(tables) {
  const hhea = new DataView(tables.get('hhea').bytes.buffer, tables.get('hhea').bytes.byteOffset);
  const count = hhea.getUint16(34);
  const hmtx = tables.get('hmtx');
  if (hmtx.transformed) throw new Error('hmtx is transformed');
  const view = new DataView(hmtx.bytes.buffer, hmtx.bytes.byteOffset, hmtx.bytes.byteLength);
  return (glyph) => view.getUint16(4 * Math.min(glyph, count - 1));
}

function features(table) {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const list = view.getUint16(6);
  const tags = new Set();
  for (let i = 0; i < view.getUint16(list); i += 1) tags.add(String.fromCharCode(...table.slice(list + 2 + 6 * i, list + 6 + 6 * i)));
  return tags;
}

function axes(table) {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const first = view.getUint16(4), count = view.getUint16(8), size = view.getUint16(10);
  return Array.from({ length: count }, (_, i) => String.fromCharCode(...table.slice(first + size * i, first + size * i + 4)));
}

let failures = 0;
const fail = (message) => { console.error(`FAIL ${message}`); failures += 1; };
const families = [
  { name: 'Inter', ttf: 'engine/crates/styk-design/fonts/Inter.ttf', prefix: 'inter-', suffix: '-opsz-normal.woff2', axes: ['opsz', 'wght'] },
  { name: 'Inter Tight', ttf: 'engine/crates/styk-design/fonts/InterTight.ttf', prefix: 'inter-tight-', suffix: '-wght-normal.woff2', axes: ['wght'] },
];
for (const family of families) {
  const bundled = ttfTables(fs.readFileSync(path.join(root, family.ttf)));
  const bundledMap = cmap(bundled.get('cmap').bytes);
  const bundledAdvance = advances(bundled);
  const bundledAxes = axes(bundled.get('fvar').bytes);
  if (bundledAxes.join() !== family.axes.join()) fail(`${family.name}: axes ${bundledAxes} (want ${family.axes})`);
  const bundledFeatures = features(bundled.get('GSUB').bytes);
  const files = fs.readdirSync(path.join(root, 'assets/fonts')).filter((file) => file.startsWith(family.prefix) && file.endsWith(family.suffix) && (family.prefix !== 'inter-' || !file.startsWith('inter-tight')));
  let checked = 0;
  const kept = new Set();
  for (const file of files) {
    const subset = woff2Tables(fs.readFileSync(path.join(root, 'assets/fonts', file)));
    const subsetMap = cmap(subset.get('cmap').bytes);
    const subsetAdvance = advances(subset);
    for (const tag of features(subset.get('GSUB').bytes)) kept.add(tag);
    const version = /Version [\d.]+/.exec(String.fromCharCode(...subset.get('name').bytes.filter((byte) => byte >= 32 && byte < 127)))?.[0];
    for (const [code, glyph] of subsetMap) {
      const mine = bundledMap.get(code);
      if (mine === undefined) { fail(`${file}: U+${code.toString(16)} is missing from ${family.ttf}`); continue; }
      if (bundledAdvance(mine) !== subsetAdvance(glyph)) fail(`${file}: U+${code.toString(16)} advance ${subsetAdvance(glyph)} against ${bundledAdvance(mine)}`);
      checked += 1;
    }
    if (!version) fail(`${file}: no version in the name table`);
  }
  const lost = [...bundledFeatures].filter((tag) => !kept.has(tag)).sort();
  console.log(`${family.name}: ${files.length} subsets, ${checked} code points have the same advance in ${path.basename(family.ttf)}; axes ${bundledAxes.join(', ')}`);
  console.log(`  GSUB features in the bundled font but in no shipped subset (no effect in today's app): ${lost.join(' ') || 'none'}`);
}
if (failures) process.exit(1);
console.log('fonts verify: ok');
