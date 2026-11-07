// Generates the fixtures of the Rust text compiler from the JavaScript module it must equal bit for bit.
//   node engine/crates/styk-core/tests/fixtures/text/generate.mjs [--corpus <dir> <out-dir>]
// Writes cases.json (the inputs and, per step, either the JSON text of `compileTextFigure`'s result or the error it threw),
// expected/<id>.json (that text), recipes.json (the derived fonts) and synthetic-cff.otf. Nothing here is tuned to pass:
// a Rust mismatch changes the Rust.

import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from '../../../../../../vendor/text/opentype.mjs';
import {compileTextFigure, parseTextFont, textOptionsWithDefaults} from '../../../../../../src/text-authoring.mjs';
import {compileEmbeddedTextFigure, readTextFigureOptions, replaceTextAssetFigure} from '../../../../../../src/native-text-authoring.mjs';
import {emptyGpos, hex, kernTable, patchSfnt, readSfnt, sha256, symbolCmap, syntheticCff} from './synthetic.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '../../../../../..');
const bytesOf = async path => new Uint8Array(await readFile(join(root, path)));

const NOTO = ['Regular', 'Bold', 'Italic', 'BoldItalic'].map(s => `vendor/text/NotoSans-${s}.ttf`);
const FIRA = 'vendor/iced/graphics/fonts/FiraSans-Regular.ttf';
const INTER = 'engine/crates/styk-design/fonts/Inter.ttf';

// ---- fonts ----------------------------------------------------------------------------------------------------------

const notoRegular = await bytesOf(NOTO[0]);
const glyphOf = (bytes, char) => parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).charToGlyph(char).index;
const glyphA = glyphOf(notoRegular, 'A'), glyphV = glyphOf(notoRegular, 'V'), glyphT = glyphOf(notoRegular, 'T'), glyphO = glyphOf(notoRegular, 'o');

const recipes = {
  // GPOS (kerning from Noto's own lookups) and a `kern` table that says something else: GPOS must win.
  'both-tables': {base: NOTO[0], replace: {kern: kernTable([[glyphA, glyphV, -400], [glyphT, glyphO, -400]])}, remove: []},
  // No GPOS: the `kern` table decides.
  'kern-only': {base: NOTO[0], replace: {kern: kernTable([[glyphA, glyphV, -400], [glyphT, glyphO, -250]])}, remove: ['GPOS']},
  // A GPOS table with no scripts and a `kern` table: GPOS still answers (with nothing), `kern` is ignored.
  'empty-gpos': {base: NOTO[0], replace: {GPOS: emptyGpos(), kern: kernTable([[glyphA, glyphV, -400]])}, remove: []},
  // Windows symbol characters at U+F000 + code: A-Z, a-z, space and digits.
  symbol: {base: NOTO[0], remove: [], replace: {cmap: symbolCmap(Object.fromEntries(
    [...' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].map(c => [0xf000 + c.charCodeAt(0), glyphOf(notoRegular, c)])))}},
};
const recipeBytes = async name => {
  const r = recipes[name];
  return patchSfnt(await bytesOf(r.base), {replace: r.replace, remove: r.remove});
};
const recipeFile = {};
for (const [name, r] of Object.entries(recipes)) {
  recipeFile[name] = {base: r.base, remove: r.remove, replace: Object.fromEntries(Object.entries(r.replace).map(([t, b]) => [t, hex(b)])),
    sha256: sha256(await recipeBytes(name))};
}
const cffBytes = syntheticCff();

/** Fresh font bytes for a font spec: `noto:<style>`, `file:<path>`, `recipe:<name>`, `synthetic-cff`. */
async function fontBytes(spec) {
  if (spec.startsWith('noto:')) return bytesOf(NOTO[Number(spec.slice(5))]);
  if (spec.startsWith('file:')) return bytesOf(spec.slice(5));
  if (spec.startsWith('recipe:')) return recipeBytes(spec.slice(7));
  if (spec === 'synthetic-cff') return cffBytes;
  throw new Error(`font ${spec}`);
}
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

/** What the text worker does for one compile: the bundled Noto style from the draft, or a loaded face's own family and style. */
function compileWith(face, options) {
  let figure;
  if (face.bundled) {
    const validated = textOptionsWithDefaults({...options, fontFamily: 'Noto Sans'});
    figure = compileTextFigure(validated, face.fonts[Number(!!validated.bold) | (Number(!!validated.italic) << 1)]);
  } else {
    figure = compileTextFigure({...options, fontFamily: face.family, bold: face.bold, italic: face.italic}, face.font);
  }
  figure._styk.textAuthoring.fontOrigin = face.bundled ? 'bundled' : 'custom';
  return figure;
}

async function openFace(spec) {
  const bytes = await fontBytes(spec);
  if (spec.startsWith('noto:')) {
    const fonts = await Promise.all(NOTO.map(async path => parse(arrayBuffer(await bytesOf(path)))));
    return {bundled: true, fonts};
  }
  return {bundled: false, ...parseTextFont(arrayBuffer(bytes), {name: basename(spec)})};
}

const errorOf = error => ({name: error?.name, message: String(error?.message ?? ''), messageKey: error?.messageKey, messageParams: error?.messageParams,
  missing: error?.missing});
const attempt = fn => { try { return {value: fn()}; } catch (error) { return {error: errorOf(error)}; } };

// ---- cases ----------------------------------------------------------------------------------------------------------

const cases = [];
const add = (id, font, steps, {digestOnly = false} = {}) => cases.push({id, font, steps, digestOnly});
const style = (bold, italic) => ({bold, italic});

// The design's strings on the four bundled styles.
for (const [index, name] of ['regular', 'bold', 'italic', 'bolditalic'].entries()) {
  const s = style(!!(index & 1), !!(index & 2));
  add(`hello-${name}`, `noto:${index}`, [{...s, text: 'Hello, World', fontSize: 47.3}]);
  add(`kerning-${name}`, `noto:${index}`, [{...s, text: 'AV To AVATAR\nTo.', fontSize: 100}]);
  add(`lines-${name}`, `noto:${index}`, [
    {...s, text: 'Long\nHi\nThird', alignment: 'center', lineHeight: 1.5, fontSize: 40},
    {...s, text: 'Long\nHi\nThird', alignment: 'right', lineHeight: 1.5, fontSize: 40}]);
  add(`tab-${name}`, `noto:${index}`, [{...s, text: 'A\tB\tAV\n\tx', fontSize: 33.3}]);
}
add('nfc', 'noto:0', [{text: 'café é Å\r\nfin\rend', name: 'Title 動画 ' + 'x'.repeat(200)}]);
add('paint-and-style', 'noto:1', [
  {text: 'Abg', opacity: 0.75, gradientColor: [220, 130, 30], outlineWidth: 2.5, outlineColor: [20, 40, 60], figureTypeId: 77, name: '', lineHeight: 0.5, fontSize: 1},
  {text: 'Abg', fontSize: 2048, lineHeight: 5, opacity: 0, color: [255, 0, 128]},
  {text: 'Wide', fontSize: 64, gradientColor: [1, 2, 3],
    paint: {type: 'linear', angle: 45, stops: [{offset: 1, color: [10.4, 20.5, 30.6], opacity: 0.25}, {offset: 0, color: [255, 0, 0], opacity: 1}]}},
  {text: 'Wide', fontSize: 64, paint: {type: 'solid', stops: [{offset: 0, color: [1, 2, 3], opacity: 0.5}]}}]);
add('limits-255', 'noto:0', [{text: [...Array(94).keys()].map(i => String.fromCharCode(0x21 + i)).join('') +
  [...Array(95).keys()].map(i => String.fromCharCode(0xa1 + i)).join('') + [...Array(66).keys()].map(i => String.fromCharCode(0x100 + i)).join(''), fontSize: 20}], {digestOnly: true});
add('limits-256', 'noto:0', [{text: [...Array(256).keys()].map(i => String.fromCharCode(0x100 + i)).join('')}]);
add('limits-16384', 'noto:0', [{text: 'a'.repeat(16384), fontSize: 10}], {digestOnly: true});
add('limits-16385', 'noto:0', [{text: 'a'.repeat(16385)}]);
add('limit-errors', 'noto:0', [{text: ''}, {text: ' \t\n'}, {text: '😀'}, {text: 'a\u0001'}, {text: 'a\u007f'}, {text: 'a', alignment: 'middle'},
  {text: 'a', fontSize: 0}, {text: 'a', fontSize: 2049}, {text: 'a', lineHeight: 0.4}, {text: 'a', color: [256, 0, 0]}, {text: 'a', color: [1.5, 0, 0]},
  {text: 'a', opacity: 1.5}, {text: 'a', gradientColor: [0, 0, -1]}, {text: 'a', outlineWidth: 129}, {text: 'a', outlineColor: [0, 0]},
  {text: 'a', figureTypeId: 0}, {text: 'a', figureTypeId: 65536}, {text: 'a', figureTypeId: 1.5}, {text: 'a', paint: {type: 'conic', stops: []}},
  {text: 'a', paint: {type: 'linear', stops: [{offset: 0, color: [0, 0, 0], opacity: 1}]}},
  {text: 'a', paint: {type: 'solid', stops: [{offset: 2, color: [0, 0, 0], opacity: 1}]}},
  {text: 'a', paint: {type: 'solid', stops: [{offset: 0, color: [0, 0], opacity: 1}]}}, {text: 'a', bold: 'yes'}, {text: ' .'},
  {text: '日', fontSize: 20}, {text: ' x'}]);
add('spaces-only-visible', 'noto:0', [{text: '.\n   \n.'}, {text: ' ', fontSize: 20}]);

add('fira', `file:${FIRA}`, [{text: 'Kerning AVATAR Ty To', fontSize: 72}, {text: 'ffi fl 123', fontSize: 30, alignment: 'center'}]);
add('inter', `file:${INTER}`, [{text: 'Variable AVATAR Ty', fontSize: 64}]);
add('both-tables', 'recipe:both-tables', [{text: 'AV To AVATAR', fontSize: 80}]);
add('kern-only', 'recipe:kern-only', [{text: 'AV To AVATAR', fontSize: 80}]);
add('empty-gpos', 'recipe:empty-gpos', [{text: 'AV To AVATAR', fontSize: 80}]);
add('symbol', 'recipe:symbol', [{text: 'ABC 123', fontSize: 50}, {text: 'abc'}, {text: ' '}]);
// The CFF font: the width of a glyph is what its charstring declares once its outline has been read, so the space
// of a text without one answers with the hmtx width until an earlier draft has read it.
add('cff', 'synthetic-cff', [{text: 'AB\nCV', fontSize: 100}, {text: 'A\tB V', fontSize: 100}, {text: 'A\tB', fontSize: 100}, {text: 'AV\nVA', fontSize: 50, alignment: 'right'},
  {text: 'A\tB', fontSize: 100}, {text: 'x'}]);
add('cff-fresh-tab', 'synthetic-cff', [{text: 'A\tB', fontSize: 100}]);

// Editing imported text: the figure comes from a compile, with and without the private metadata.
const base = (bytesSpec, options) => ({bytesSpec, options});
const nativeBases = {
  hello: base('noto:1', {text: 'Hello\nWorld', bold: true, fontSize: 60, alignment: 'center', lineHeight: 1.3, color: [200, 30, 30], gradientColor: [0, 0, 255], outlineWidth: 3}),
  plain: base('noto:0', {text: 'AV To', fontSize: 80}),
};
const nativeCases = [];
const addNative = (id, baseName, {stripMetadata = false, mix = false} = {}, steps) => nativeCases.push({id, base: baseName, stripMetadata, mix, steps});
addNative('native-noop', 'hello', {}, [{}]);
addNative('native-size', 'hello', {}, [{fontSize: 120}, {fontSize: 30.5, color: [1, 2, 3], opacity: 0.5}]);
addNative('native-text', 'hello', {}, [{text: 'Hello\nWorld!!\nHeo'}, {text: 'Hello\nWorld', alignment: 'right'}, {text: 'World Hello', lineHeight: 2}]);
addNative('native-stripped', 'hello', {stripMetadata: true}, [{}, {embeddedScale: 150}, {text: 'Hello World!', embeddedScale: 50}, {text: 'o\to', alignment: 'center'}, {embeddedScale: 0}, {embeddedScale: 4001}]);
addNative('native-plain-stripped', 'plain', {stripMetadata: true}, [{text: 'AV VA T', embeddedScale: 100}, {text: 'x'}, {text: 'AV To', bold: true}]);
addNative('native-missing', 'hello', {}, [{text: 'Hello Wörld 日本'}]);
addNative('native-mixed', 'plain', {mix: true}, [{}, {text: 'To AV', fontSize: 40}]);
const replacements = [{font: 'file:' + FIRA, options: {text: 'Replaced', fontSize: 50, assetIndex: 0}}, {font: 'noto:2', options: {text: 'AV To', fontSize: 33, alignment: 'right', italic: true, assetIndex: 0}}];

// ---- run ------------------------------------------------------------------------------------------------------------

async function run(outDir, caseList, nativeList) {
  await mkdir(join(outDir, 'expected'), {recursive: true});
  const out = [];
  for (const c of caseList) {
    const face = await openFace(c.font);
    const steps = c.steps.map(options => {
      const r = attempt(() => compileWith(face, options));
      if (r.error) return {options, error: r.error};
      const text = JSON.stringify(r.value);
      return c.digestOnly ? {options, digest: sha256(Buffer.from(text))} : {options, expected: text};
    });
    const entry = {id: c.id, font: c.font, face: face.bundled ? null : {family: face.family, style: face.style, bold: face.bold, italic: face.italic}, steps: steps.map((s, i) => {
      if (s.expected !== undefined) return {options: s.options, expected: `expected/${c.id}-${i}.json`};
      return s;
    })};
    for (const [i, s] of steps.entries()) if (s.expected !== undefined) await writeFile(join(outDir, 'expected', `${c.id}-${i}.json`), s.expected);
    out.push(entry);
  }
  const native = [];
  for (const n of nativeList) {
    const spec = nativeBases[n.base];
    const face = await openFace(spec.bytesSpec);
    const sourceText = JSON.stringify(compileWith(face, spec.options));
    const source = JSON.parse(sourceText);
    if (n.stripMetadata) delete source._styk;
    if (n.mix) {
      source.segments.push({...source.segments[0], segment_id: 2, primitive_code: 1, segment_type: 'line', extra_u16: 0, z_order: 2});
      source.segment_count = 2;
      source.side_tables = [{kind: 'text', asset_index: 0, table_index: 0, text: 'stale'}, {kind: 'image', asset_index: 0}];
    }
    const sourceFile = `expected/${n.id}-source.json`;
    await writeFile(join(outDir, sourceFile), JSON.stringify(source));
    const steps = [];
    for (const [i, options] of n.steps.entries()) {
      const r = attempt(() => compileEmbeddedTextFigure(JSON.parse(JSON.stringify(options)), JSON.parse(JSON.stringify(source))));
      if (r.error) { steps.push({options, error: r.error}); continue; }
      const file = `expected/${n.id}-${i}.json`;
      await writeFile(join(outDir, file), JSON.stringify(r.value));
      steps.push({options, expected: file});
    }
    const replaceSteps = [];
    if (n.mix) for (const [i, replacement] of replacements.entries()) {
      const target = await openFace(replacement.font);
      const compiled = compileWith(target, replacement.options);
      // The worker applies the replacement, then records where the outlines came from.
      const r = attempt(() => {
        const figure = replaceTextAssetFigure(JSON.parse(JSON.stringify(source)), compiled, {assetIndex: 0});
        figure._styk.textAuthoring.fontOrigin = target.bundled ? 'bundled' : 'custom';
        return figure;
      });
      const file = `expected/${n.id}-replace-${i}.json`;
      await writeFile(join(outDir, file), JSON.stringify(r.value));
      replaceSteps.push({font: replacement.font, options: replacement.options, expected: file});
    }
    native.push({id: n.id, source: sourceFile, readOptions: readTextFigureOptions(JSON.parse(JSON.stringify(source))), steps, replaceSteps});
  }
  await writeFile(join(outDir, 'cases.json'), JSON.stringify({cases: out, native}, null, 1));
}

const corpusAt = process.argv.indexOf('--corpus');
if (corpusAt >= 0) {
  // A local check against fonts that cannot be committed: every font file of a directory, a fixed set of strings.
  const [dir, outDir] = process.argv.slice(corpusAt + 1);
  const files = (await readdir(dir)).filter(f => /\.(ttf|otf)$/i.test(f)).sort();
  const strings = [{text: 'Hello, World AV To', fontSize: 48.7}, {text: 'ABC abc 123 ~!@\n\tÉé Ty', fontSize: 33, alignment: 'center', lineHeight: 1.1}, {text: ' ABC', fontSize: 20}];
  const corpus = files.map(file => ({id: file.replace(/[^A-Za-z0-9._-]/g, '_'), font: `file:${join(dir, file)}`, steps: strings}));
  const originalBytes = fontBytes;
  await mkdir(outDir, {recursive: true});
  await run(outDir, corpus.map(c => ({...c, font: c.font})), []);
  console.log(`corpus: ${corpus.length} fonts in ${outDir} (${originalBytes.name})`);
} else {
  await run(here, cases, nativeCases);
  await writeFile(join(here, 'recipes.json'), JSON.stringify(recipeFile, null, 1));
  await writeFile(join(here, 'synthetic-cff.otf'), cffBytes);
  console.log(`wrote ${cases.length} compile cases and ${nativeCases.length} editing cases`);
}
