import test from 'node:test';
import assert from 'node:assert/strict';
import {createImageFigure, createImageBackground, applySpriteColorKey, mediaImageFormat, preserveMediaBackground} from '../src/media-authoring.mjs';
import {Editor} from '../src/editor.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';

const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHk8AAAAASUVORK5CYII=';

test('sprite factory enters the actual editor, renders as media, and survives undo/redo/JSON', () => {
  const editor = new Editor({demo: false});
  editor.importFigure(createImageFigure({dataUrl, width: 1, height: 1, name: 'Pixel.png'}));
  const uid = editor.selectedUid, figure = editor.figure;
  assert.equal(figure.name, 'Pixel'); assert.equal(figure.image_assets[0].data_url, dataUrl);
  const shape = buildGeometry(editor.report, editor.frame).drawables.find(s => s.obj.unique_id === uid);
  assert.equal(shape.type, 'image'); assert.ok(shape.asset.anchor_length > 0);
  assert.equal(shape.start.x, editor.report.canvas_width / 2);
  editor.undo(); assert.equal(editor.frame.objects.length, 0);
  editor.redo(); assert.equal(editor.object.unique_id, uid);
  const reopened = new Editor({demo: false}).load(JSON.parse(JSON.stringify(editor.serialize())));
  assert.equal(reopened.figure.image_assets[0].data_url, dataUrl);
});

test('background creation preserves embedded image and gives an interchangeable safe name', () => {
  const background = createImageBackground({dataUrl, width: 1, height: 1, name: 'café 動画.png', backgroundId: 7});
  assert.equal(background.kind, 1); assert.equal(background.background_id, 7);
  assert.equal(background.name, 'café __'); assert.equal(background._styk.sourceName, 'café 動画.png');
  assert.equal(background.data_url, dataUrl);
});

test('opaque sprites key every matching bottom-left color; existing alpha preserves every pixel', () => {
  const opaque = new Uint8ClampedArray([255, 0, 0, 255, 0, 1, 2, 255, 0, 1, 2, 255, 0, 0, 0, 255]);
  assert.equal(applySpriteColorKey(opaque, 2, 2), true);
  assert.deepEqual([...opaque.filter((_, i) => i % 4 === 3)], [255, 0, 0, 255]);
  const alpha = new Uint8ClampedArray([0, 0, 0, 128, 0, 0, 0, 255]), original = alpha.slice();
  assert.equal(applySpriteColorKey(alpha, 2, 1), false); assert.deepEqual(alpha, original);
});

test('invalid geometry, remote media, and invalid pixel arrays fail before authoring', () => {
  assert.throws(() => createImageFigure({dataUrl, width: 0, height: 1}), /dimensions/);
  assert.throws(() => createImageFigure({dataUrl, width: 8192, height: 8192}), /dimensions/);
  assert.throws(() => createImageFigure({dataUrl: 'https://example.com/image.png', width: 1, height: 1}), /embedded/);
  assert.throws(() => applySpriteColorKey(new Uint8Array(3), 1, 1), /four bytes/);
});

test('native transparency defaults follow actual PNG/GIF/BMP signatures and explicit caller intent', () => {
  const signatures = [
    ['png', [137,80,78,71,13,10,26,10]], ['gif', [71,73,70,56,57,97]],
    ['gif', [71,73,70,56,55,97]], ['bmp', [66,77]], ['jpeg', [255,216,255]],
    ['webp', [82,73,70,70,0,0,0,0,87,69,66,80]],
  ];
  for (const [format, bytes] of signatures) {
    assert.equal(mediaImageFormat(Uint8Array.from(bytes)), format);
    assert.equal(preserveMediaBackground(format), !['png','gif','bmp'].includes(format));
    assert.equal(preserveMediaBackground(format, true), true);
    assert.equal(preserveMediaBackground(format, false), false);
  }
  assert.equal(mediaImageFormat(new Uint8Array([71,73,70,56,54,97])), null);
  assert.equal(mediaImageFormat(new Uint8Array([137,80,78])), null);
  assert.throws(() => preserveMediaBackground('png', 'false'), /true or false/);
});
