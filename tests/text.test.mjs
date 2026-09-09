import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse} from '../vendor/text/opentype.mjs';
import {compileTextFigure} from '../src/text-authoring.mjs';
import {Editor} from '../src/editor.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';

const fonts = await Promise.all(['Regular', 'Bold', 'Italic', 'BoldItalic'].map(async style => {
  const bytes = await readFile(new URL(`../vendor/text/NotoSans-${style}.ttf`, import.meta.url));
  return parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}));
const compile = options => compileTextFigure(options, fonts[Number(!!options.bold) | (Number(!!options.italic) << 1)]);

test('text enters editor as embedded geometry, preserves editing options, and undo/JSON restore work', () => {
  const figure = compile({text: 'Hello, café!\nΚαλημέρα • Привет', fontSize: 42, color: [70, 40, 170], outlineWidth: 1.5});
  const editor = new Editor({demo: false}); editor.importFigure(figure);
  const uid = editor.selectedUid;
  const shape = buildGeometry(editor.report, editor.frame).drawables.find(s => s.obj.unique_id === uid);
  assert.equal(shape.type, 'text'); assert.ok(shape.asset.normalized_svg_path.includes('C'));
  assert.ok(shape.asset.bounds.width > 200); assert.ok(shape.asset.bounds.height > 40);
  assert.equal(figure._styk.textAuthoring.text, 'Hello, café!\nΚαλημέρα • Привет');
  assert.equal(figure.segment_decode.global_style.outline_thickness, 1.5);
  editor.undo(); assert.equal(editor.frame.objects.length, 0);
  editor.redo(); assert.equal(editor.object.unique_id, uid);
  const reopened = new Editor({demo: false}).load(JSON.parse(JSON.stringify(editor.serialize())));
  assert.deepEqual(reopened.figure.text_assets[0].glyphs, figure.text_assets[0].glyphs);
  assert.deepEqual(reopened.figure._styk.textAuthoring, figure._styk.textAuthoring);
});

test('repeated characters reuse outlines and all placements have native float32 coordinates', () => {
  const asset = compile({text: 'AVA AVA\nAVA\tAVA', fontSize: 47.3}).text_assets[0];
  assert.equal(asset.glyphs.length, 5);
  assert.equal(asset.placements.length, asset.text.length);
  assert.equal(asset.placements[0].glyph_index, asset.placements[2].glyph_index);
  for (const glyph of asset.glyphs) for (const c of glyph.commands) {
    assert.ok(['M', 'L', 'C', 'Z'].includes(c.op));
    assert.ok(c.values.every(n => Number.isFinite(n) && Math.fround(n) === n));
  }
  for (const p of asset.placements) {
    assert.equal(p.utf16_code_unit, asset.text.charCodeAt(p.character_index));
    assert.equal(p.x, Math.fround(p.x)); assert.equal(p.y, Math.fround(p.y));
    if (!p.visible) assert.equal(p.x + p.y, 0);
  }
});

test('multiline center and right alignment shift the shorter line while preserving line separation', () => {
  const create = alignment => compile({text: 'Longer line\nHi', alignment, fontSize: 40, lineHeight: 1.5}).text_assets[0];
  const left = create('left'), center = create('center'), right = create('right');
  const index = left.text.indexOf('H');
  assert.equal(left.placements[index].x, 0);
  assert.ok(center.placements[index].x > 0);
  assert.ok(Math.abs(right.placements[index].x - 2 * center.placements[index].x) < 0.001);
  assert.equal(right.placements[index].y, 60);
  assert.equal(right.placements[0].x, 0);
});

test('all four real font styles change outlines and preserve native style and figure paint values', () => {
  const figures = [0, 1, 2, 3].map(style => compile({text: 'Abg', bold: !!(style & 1), italic: !!(style & 2),
    opacity: 0.75, gradientColor: [220, 130, 30], outlineWidth: 2, outlineColor: [20, 40, 60]}));
  assert.equal(new Set(figures.map(f => f.text_assets[0].glyphs[0].svg_path)).size, 4);
  figures.forEach((figure, style) => {
    assert.equal(figure.text_assets[0].font_style, style);
    assert.equal(figure.segments[0].transparency, 64);
    assert.deepEqual(figure.segments[0].secondary, {rgb: [220, 130, 30], a: 64});
    assert.deepEqual(figure.segment_decode.global_style.rgb, [20, 40, 60]);
  });
});

test('normalization composes accents and unsafe native labels preserve their source', () => {
  const figure = compile({text: 'cafe\u0301\r\nfin', name: 'Title 動画'});
  assert.equal(figure.text_assets[0].text, 'café\nfin');
  assert.equal(figure.name, 'Title __'); assert.equal(figure._styk.sourceName, 'Title 動画');
});

test('unsupported text and invalid styling fail before returning a lossy figure', () => {
  for (const text of ['', ' \t\n']) assert.throws(() => compile({text}), /visible text/);
  assert.throws(() => compile({text: '😀'}), /Unicode BMP/);
  assert.throws(() => compile({text: '水'}), /does not contain/);
  assert.throws(() => compile({text: 'x\0'}), /control/);
  assert.throws(() => compile({text: Array.from({length: 256}, (_, i) => String.fromCharCode(0x400 + i)).join('')}), /255 distinct/);
  assert.throws(() => compile({text: 'x', fontSize: Infinity}), /Font size/);
  assert.throws(() => compile({text: 'x', lineHeight: 0}), /Line height/);
  assert.throws(() => compile({text: 'x', opacity: 2}), /Opacity/);
  assert.throws(() => compile({text: 'x', color: [256, 0, 0]}), /RGB/);
  assert.throws(() => compile({text: 'x', bold: 'true'}), /true or false/);
});
