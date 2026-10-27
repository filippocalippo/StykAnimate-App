import test from 'node:test';
import assert from 'node:assert/strict';
import {createImageFigure, createImageBackground, applySpriteColorKey, mediaImageFormat, preserveMediaBackground} from '../src/media-authoring.mjs';

const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHk8AAAAASUVORK5CYII=';

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

test('all image formats preserve pixels by default and honor explicit color-key intent', () => {
  const signatures = [
    ['png', [137,80,78,71,13,10,26,10]], ['gif', [71,73,70,56,57,97]],
    ['gif', [71,73,70,56,55,97]], ['bmp', [66,77]], ['jpeg', [255,216,255]],
    ['webp', [82,73,70,70,0,0,0,0,87,69,66,80]],
  ];
  for (const [format, bytes] of signatures) {
    assert.equal(mediaImageFormat(Uint8Array.from(bytes)), format);
    assert.equal(preserveMediaBackground(format), true);
    assert.equal(preserveMediaBackground(format, true), true);
    assert.equal(preserveMediaBackground(format, false), false);
  }
  assert.equal(mediaImageFormat(new Uint8Array([71,73,70,56,54,97])), null);
  assert.equal(mediaImageFormat(new Uint8Array([137,80,78])), null);
  assert.throws(() => preserveMediaBackground('png', 'false'), /true or false/);
});
