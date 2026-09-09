/** Windows symbol faces map typed bytes to their U+F000 private-use glyphs. */
function hasSymbolCmap(buffer) {
  const view = new DataView(buffer), size = view.byteLength;
  if (size < 12) return false;
  const signature = view.getUint32(0);
  if (![0x00010000, 0x4f54544f, 0x74727565].includes(signature)) return false;
  const count = view.getUint16(4);
  if (12 + count * 16 > size) return false;
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    if (view.getUint32(record) !== 0x636d6170) continue;
    const offset = view.getUint32(record + 8), length = view.getUint32(record + 12);
    if (length < 4 || offset + length > size) return false;
    const entries = view.getUint16(offset + 2);
    if (4 + entries * 8 > length) return false;
    for (let j = 0; j < entries; j++) {
      const entry = offset + 4 + j * 8;
      if (view.getUint16(entry) === 3 && view.getUint16(entry + 2) === 0) return true;
    }
  }
  return false;
}

export function applyWindowsSymbolMapping(font, bytes) {
  // OS/2 bit 31 also identifies symbol faces which expose a Unicode cmap.
  const symbol = ((font.tables?.os2?.ulCodePageRange1 ?? 0) >>> 31) !== 0 || hasSymbolCmap(bytes);
  const map = font.tables?.cmap?.glyphIndexMap;
  if (!symbol || !map) return font;
  for (let code = 0x20; code <= 0xff; code++) {
    const glyph = map[0xf000 + code];
    if (!map[code] && glyph) map[code] = glyph;
  }
  return font;
}
