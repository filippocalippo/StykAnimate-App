/** Native Pivot INI is data only. This parser does not load files or execute values. */
export const MAX_LANGUAGE_BYTES = 512 * 1024;
const LEGACY_ENCODINGS = new Set(['windows-1250', 'windows-1251', 'windows-1252', 'windows-1254']);

export function parsePivotLanguage(input, { legacyEncoding = 'windows-1252' } = {}) {
  let text;
  if (typeof input === 'string') {
    if (input.length > MAX_LANGUAGE_BYTES || new TextEncoder().encode(input).length > MAX_LANGUAGE_BYTES) throw new RangeError('Language file is too large.');
    text = input;
  } else if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_LANGUAGE_BYTES) throw new RangeError('Language file is too large.');
    let encoding;
    if (input[0] === 0xff && input[1] === 0xfe) encoding = 'utf-16le';
    else if (input[0] === 0xfe && input[1] === 0xff) encoding = 'utf-16be';
    else if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) encoding = 'utf-8';
    else {
      if (!LEGACY_ENCODINGS.has(legacyEncoding)) throw new RangeError('Unsupported legacy language encoding.');
      encoding = legacyEncoding;
    }
    text = new TextDecoder(encoding, { fatal: true }).decode(input);
  } else throw new TypeError('Language data must be text or bytes.');
  const entries = Object.create(null);
  let count = 0;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_]{0,95})\s*=(.*)$/.exec(line);
    if (!match || ['constructor', 'prototype', '__proto__'].includes(match[1])) continue;
    const value = match[2].trim();
    if (value.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new RangeError('Language caption contains invalid text.');
    if (!Object.hasOwn(entries, match[1]) && ++count > 2048) throw new RangeError('Language file has too many entries.');
    entries[match[1]] = value;
  }
  return Object.freeze(entries);
}

/** Explicit semantic matches only; native hints carry obsolete shortcuts. */
export const PIVOT_CAPTION_KEYS = Object.freeze({
  'app.untitled': 'MFileUntitled',
  'common.cancel': 'CancelBitCap', 'common.close': 'BClose',
  'common.save': 'BSave', 'common.saveAs': 'BSaveAs', 'common.open': 'BOpen',
  'common.new': 'BNew', 'common.export': 'EExport', 'common.delete': 'MTLDelete',
  'common.rename': 'FiFormRename', 'common.duplicate': 'BUndoDuplicate',
  'common.paste': 'MUndoPaste', 'common.undo': 'Undo', 'common.redo': 'Redo',
  'common.restoreDefaults': 'ODefaultCap', 'common.search': 'FiFormSearch',
  'menu.file': 'MFile', 'menu.edit': 'Edit', 'menu.view': 'MView', 'menu.help': 'MHelp',
  'menu.recentFiles': 'MRecentPivs', 'menu.openRecent': 'MRecentPivs',
  'menu.newAnimation': 'MFNew', 'menu.openProject': 'MFOpen',
  'menu.importFigures': 'MFLoadFig', 'menu.importSprite': 'MFSprite',
  'menu.importBackground': 'MFBack', 'menu.createText': 'MFCreateText',
  'menu.settings': 'OFormCap', 'settings.title': 'OFormCap',
  'settings.language': 'OLangBox', 'settings.theme': 'OThemeBox',
  'settings.light': 'OLightCap', 'settings.dark': 'ODarkCap',
  'chrome.open': 'BOpen', 'chrome.export': 'EExport', 'chrome.close': 'BClose',
  'chrome.importFigures': 'MFLoadFig',
  'timeline.addFrame': 'MAddFrameCap', 'timeline.updateFrame': 'MStoreFrameCap',
  'timeline.insertInbetween': 'RFormCap', 'timeline.inbetweens': 'MTweenNum',
  'playback.play': 'MPlayCap', 'playback.stop': 'MStopCap', 'playback.loop': 'MLoopCap',
  'playback.preview': 'TPreviewCap', 'layers.camera': 'MStatusCamera',
  'properties.scale': 'MUndoScale', 'properties.width': 'OWidthCap',
  'properties.height': 'OHeightCap', 'properties.angle': 'BSegAngle',
  'properties.length': 'BSegLength', 'properties.bend': 'BSegBend',
  'properties.opacity': 'COpacityCap', 'properties.color': 'MUndoColor',
  'properties.thickness': 'BUndoThickness',
  'background.title': 'MBackCap', 'background.solid': 'CSolidCap',
  'background.linear': 'CLinearCap', 'background.radial': 'CRadialCap',
  'background.image': 'BSegImage', 'text.font': 'TFontCap', 'text.bold': 'TBoldCap',
  'text.italic': 'TItalicCap', 'text.alignment': 'TAlignCap', 'export.quality': 'IQualityCap',
});

export const PIVOT_LOCALE_KEY_OVERRIDES = Object.freeze({
  // The supplied Brazilian Cancel caption is mistakenly a confirmation message.
  'pt-BR': Object.freeze({ 'common.cancel': null }),
  // Chinese Builder captions explicitly mean figure material, not a project.
  'zh-Hans': Object.freeze({ 'common.save': 'MFSave', 'common.open': 'MFOpen', 'chrome.open': 'MFOpen' }),
});

export function mapPivotCaptions(entries, baseline, { locale } = {}) {
  const mapped = Object.create(null);
  const overrides = Object.hasOwn(PIVOT_LOCALE_KEY_OVERRIDES, locale) ? PIVOT_LOCALE_KEY_OVERRIDES[locale] : {};
  for (const [semantic, sourceKey] of Object.entries(PIVOT_CAPTION_KEYS)) {
    const native = Object.hasOwn(overrides, semantic) ? overrides[semantic] : sourceKey;
    if (!native) continue;
    if (!Object.hasOwn(entries, native)) continue;
    const value = entries[native];
    // Native files are often partially English. Keep the app's deliberate
    // English caption instead of replacing it with an old English caption.
    if (typeof value !== 'string' || !value || value === baseline?.[native]) continue;
    // Mapped captions have no formatting arguments. Preserve literal text and
    // reject accidental replacement of our app's placeholder vocabulary.
    if (/[{}]/.test(value)) continue;
    mapped[semantic] = value;
  }
  return Object.freeze(mapped);
}
