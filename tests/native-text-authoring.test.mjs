import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileTextFigure, parseTextFont, pathBounds, svgPath} from '../src/text-authoring.mjs';
import {
  textAssetFor, canEditTextFigure, readTextFigureOptions,
  compileEmbeddedTextFigure, replaceTextAssetFigure, MissingTextGlyphsError,
} from '../src/native-text-authoring.mjs';

const fixtureNames = ['text_abc_66903de7', 'text_bike_f18f65c7', 'text_speech_bubble_0f3b81ef'];
const reports = await Promise.all(fixtureNames.map(async name => JSON.parse(await readFile(
  new URL(`../../reports/browser_corpus/${name}/scene.json`, import.meta.url), 'utf8'))));
const nativeFigures = reports.flatMap(report => report.figure_types.filter(figure => figure.text_assets?.length));
const arial = nativeFigures.find(figure => figure.text_assets[0].font_name === 'Arial');
const speech = nativeFigures.find(figure => figure.text_assets[0].text === 'thought\r\nbubble');
const fontBytes = await readFile(new URL('../vendor/text/NotoSans-Regular.ttf', import.meta.url));
const {font} = parseTextFont(fontBytes, {name: 'NotoSans-Regular.ttf'});
const clone = value => structuredClone(value);
const near = (actual, expected, message) => assert.ok(
  Math.abs(actual - expected) <= Math.max(.00002, Math.abs(expected) * .0000002),
  `${message}: ${actual} ≈ ${expected}`);

test('metadata-free native figures recover their text, actual family, style and unknown point-size state', () => {
  for (const figure of nativeFigures) {
    assert.equal(figure._styk?.textAuthoring, undefined, 'This is an imported native fixture, not authored metadata.');
    assert.ok(canEditTextFigure(figure));
    const asset = figure.text_assets[0], options = readTextFigureOptions(figure);
    assert.equal(options.text, asset.text.replace(/\r\n?/g, '\n'));
    assert.equal(options.fontFamily, asset.font_name);
    assert.equal(options.bold, Boolean(asset.font_style & 1));
    assert.equal(options.italic, Boolean(asset.font_style & 2));
    assert.equal(options.fontSizeKnown, false, 'Native text files do not persist a font size.');
    assert.equal(options.embeddedScale, 100);
    assert.equal(options.fontOrigin, 'embedded');
    assert.equal(options.figureTypeId, figure.figure_type_id);
  }
  assert.equal(canEditTextFigure(reports[0].figure_types[0]), false);
});

test('no-op native edits preserve every embedded outline and placement, including CRLF and large centered offsets', () => {
  assert.ok(speech.text_assets[0].placements.some(p => p.visible && p.x > 32700));
  for (const source of nativeFigures) {
    const before = JSON.stringify(source), edited = compileEmbeddedTextFigure(readTextFigureOptions(source), source);
    assert.deepEqual(edited.text_assets[0], source.text_assets[0], `${source.name}: the portable asset is unchanged.`);
    assert.equal(edited.figure_type_id, source.figure_type_id);
    assert.equal(JSON.stringify(source), before, 'Preview compilation never mutates its source.');
    assert.equal(edited._styk.textAuthoring.fontSize, undefined);
    assert.equal(edited._styk.textAuthoring.spacingEstimated, false);
    assert.strictEqual(edited.text_assets[0], edited.side_tables.find(table => table.kind === 'text'));
  }
});

test('native horizontal and vertical opcodes retain bounds and use the correct translation axis', () => {
  for (const source of nativeFigures) for (const glyph of source.text_assets[0].glyphs) {
    assert.deepEqual(pathBounds(glyph.commands), glyph.bounds,
      `${source.name} U+${glyph.utf16_code_unit.toString(16)} bounds match the native decoder.`);
  }
  const commands = [{op: 'M', values: [1, 2]}, {op: 'H', values: [7]}, {op: 'V', values: [11]}, {op: 'Z', values: []}];
  assert.equal(svgPath(commands, 10, 100), 'M11 102 H17 V111 Z');
});

test('known native characters reuse their outlines, rebuild first-occurrence order and expose estimated spacing', () => {
  const source = speech, original = textAssetFor(source), byUnit = new Map(original.glyphs.map(g => [g.utf16_code_unit, g]));
  const result = compileEmbeddedTextFigure({text: 'bubble\nthought bubble', alignment: 'right'}, source);
  const asset = textAssetFor(result);
  assert.equal(asset.text, 'bubble\nthought bubble');
  assert.deepEqual(asset.glyphs.map(g => g.utf16_code_unit), [...new Set(asset.text.split('').map(c => c.charCodeAt(0)))]);
  for (const glyph of asset.glyphs) {
    if (byUnit.has(glyph.utf16_code_unit)) assert.deepEqual(glyph.commands, byUnit.get(glyph.utf16_code_unit).commands);
    else assert.deepEqual(glyph.commands, [], 'Only new whitespace may have synthesized empty paths.');
  }
  for (const p of asset.placements) {
    assert.equal(p.utf16_code_unit, asset.text.charCodeAt(p.character_index));
    assert.equal(asset.glyphs[p.glyph_index].utf16_code_unit, p.utf16_code_unit);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    assert.equal(p.x, Math.fround(p.x)); assert.equal(p.y, Math.fround(p.y));
  }
  assert.ok(Object.values(asset.bounds).every(Number.isFinite));
  assert.equal(result._styk.textAuthoring.spacingEstimated, true);
  assert.equal(asset.source_start, undefined); assert.equal(asset.source_end, undefined);
  assert.strictEqual(asset, result.side_tables.find(table => table.kind === 'text'));
});

test('new visible characters explicitly require a font and never fall back to another family', () => {
  const before = JSON.stringify(arial);
  assert.throws(() => compileEmbeddedTextFigure({text: 'Abc!?!!'}, arial), error => {
    assert.ok(error instanceof MissingTextGlyphsError);
    assert.deepEqual(error.missing, ['!', '?']);
    assert.match(error.message, /Choose a font/); assert.match(error.message, /Arial/);
    return true;
  });
  assert.equal(JSON.stringify(arial), before);
  assert.throws(() => compileEmbeddedTextFigure({bold: true}, arial), /Choose a font face/);
  assert.throws(() => compileEmbeddedTextFigure({italic: true}, arial), /Choose a font face/);
});

test('native percentage scaling preserves CRLF, scales all path opcodes and positions, and maintains valid portable bounds', () => {
  for (const source of nativeFigures) {
    const original = textAssetFor(source), edited = compileEmbeddedTextFigure({embeddedScale: 200}, source), asset = textAssetFor(edited);
    assert.equal(asset.text, original.text);
    for (const [i, glyph] of asset.glyphs.entries()) for (const [j, command] of glyph.commands.entries()) {
      assert.equal(command.op, original.glyphs[i].commands[j].op);
      assert.deepEqual(command.values, original.glyphs[i].commands[j].values.map(value => Math.fround(value * 2)));
    }
    asset.placements.forEach((p, i) => {
      assert.equal(p.x, Math.fround(original.placements[i].x * 2));
      assert.equal(p.y, Math.fround(original.placements[i].y * 2));
    });
    assert.ok(Object.values(asset.bounds).every(Number.isFinite));
    near(asset.bounds.width, original.bounds.width * 2, 'Double width');
    near(asset.bounds.height, original.bounds.height * 2, 'Double height');
    near(edited.segments[0].length, source.segments[0].length * 2, 'Double native segment width');
    assert.equal(edited._styk.textAuthoring.embeddedScale, 100, 'The next edit starts from the new persisted outline size.');
  }
  for (const embeddedScale of [0, -1, Infinity, Number.NaN, 4001])
    assert.throws(() => compileEmbeddedTextFigure({embeddedScale}, arial), /scale/i);
});

test('color-only edits retain exact native layout and preserve source definition identity', () => {
  const source = speech, asset = textAssetFor(source);
  const result = compileEmbeddedTextFigure({color: [108, 70, 220], opacity: .75,
    gradientColor: [241, 102, 132], outlineWidth: 1.75, outlineColor: [31, 22, 53]}, source);
  assert.deepEqual(textAssetFor(result), asset);
  assert.deepEqual(result.segments[0].color_rgb, [108, 70, 220]);
  assert.deepEqual(result.segments[0].secondary, {rgb: [241, 102, 132], a: 64});
  assert.equal(result.segments[0].transparency, 64);
  assert.equal(result.segment_decode.global_style.outline_thickness, 1.75);
  assert.equal(result.figure_type_id, source.figure_type_id);
});

test('explicit font replacement targets only its text asset and retains the surrounding native rig and aliases', () => {
  const source = clone(arial), originalAsset = source.text_assets[0];
  const secondAsset = {...clone(originalAsset), asset_index: 8, table_index: 8};
  source.text_assets.push(secondAsset); source.side_tables.push(secondAsset);
  const nonText = {segment_id: 2, parent_id: 1, primitive_code: 0, segment_type: 'line', length: 50,
    angle_rad: .75, color_rgb: [70, 90, 110], thickness: 8, visible: true};
  const otherText = {...clone(source.segments[0]), segment_id: 3, parent_id: 2, extra_u16: 8, extra: [8, 0, 0]};
  source.segments.push(nonText, otherText); source.segment_count = 3;
  source.image_assets = [{kind: 'image', asset_index: 3, table_index: 3, data_base64: 'AA=='}];
  source._styk = {customRigMarker: 'retain'};
  const before = JSON.stringify(source);
  const replacement = compileTextFigure({text: 'A new caption!', name: 'Caption', fontSize: 36,
    fontFamily: 'Explicit Test Font', color: [80, 60, 140]}, font);
  const result = replaceTextAssetFigure(source, replacement);
  assert.equal(result.figure_type_id, source.figure_type_id);
  assert.equal(result.segment_count, 3);
  assert.deepEqual(result.segments.slice(1), source.segments.slice(1));
  assert.deepEqual(result.text_assets[1], secondAsset);
  assert.deepEqual(result.image_assets, source.image_assets);
  assert.equal(result._styk.customRigMarker, 'retain');
  assert.equal(result._styk.textAuthoring.fontOrigin, 'custom');
  assert.equal(result.text_assets[0].font_name, 'Explicit Test Font');
  assert.equal(result.text_assets[0].asset_index, originalAsset.asset_index);
  assert.strictEqual(result.text_assets[0], result.side_tables[0]);
  assert.equal(JSON.stringify(source), before);
});

test('reflow after an embedded scale uses scaled advances, matching freshly compiled font positions', () => {
  const original = compileTextFigure({text: 'Ab c', fontSize: 30}, font);
  const scaled = compileEmbeddedTextFigure({fontSize: 60}, original);
  const reflowed = compileEmbeddedTextFigure({text: 'c bA'}, scaled);
  const reference = compileTextFigure({text: 'c bA', fontSize: 60}, font);
  const actualPlacements = textAssetFor(reflowed).placements, expectedPlacements = textAssetFor(reference).placements;
  actualPlacements.forEach((p, i) => {
    near(p.x, expectedPlacements[i].x, `Reflowed placement ${i} X`);
    near(p.y, expectedPlacements[i].y, `Reflowed placement ${i} Y`);
  });
});

test('no-op imported decomposed Unicode text preserves original UTF-16 units and embedded marks', () => {
  // Native Pivot persists UTF-16 units verbatim; it does not normalize combining marks.
  const source = clone(arial), asset = source.text_assets[0], units = [101, 0x301, 120];
  asset.text = 'e\u0301x';
  asset.glyphs.forEach((glyph, i) => { glyph.utf16_code_unit = units[i]; });
  asset.placements.forEach((p, i) => { p.utf16_code_unit = units[i]; });
  source.side_tables[0] = asset;
  const result = compileEmbeddedTextFigure(readTextFigureOptions(source), source);
  assert.deepEqual(result.text_assets[0], asset);
});

test('explicit asset selection edits a second text object without borrowing the first font metrics', () => {
  const source=compileTextFigure({text:'First',fontSize:120},font),other=clone(arial.text_assets[0]);
  other.asset_index=other.table_index=7;
  source.text_assets.push(other);
  source.segments.push({...clone(arial.segments[0]),segment_id:2,extra_u16:7,extra:[7,0,0]});
  source.segment_count=2;source.side_tables=[source.text_assets[0],other];
  const options=readTextFigureOptions(source,{assetIndex:7});
  assert.equal(options.fontFamily,'Arial');assert.equal(options.fontSizeKnown,false);
  const embedded=compileEmbeddedTextFigure({...options,text:'Abc Abc'},source);
  assert.deepEqual(embedded.text_assets[0],source.text_assets[0]);assert.equal(embedded.text_assets[1].text,'Abc Abc');
  assert.equal(embedded._styk.textAuthoring.glyphAdvances,undefined);
  const chosen=replaceTextAssetFigure(source,compileTextFigure({text:'Second',fontSize:24},font),{assetIndex:7});
  assert.deepEqual(chosen.text_assets[0],source.text_assets[0]);assert.deepEqual(chosen.segments[0],source.segments[0]);
  assert.equal(chosen.text_assets[1].text,'Second');assert.equal(chosen._styk.textAuthoring.assetIndex,7);
});
