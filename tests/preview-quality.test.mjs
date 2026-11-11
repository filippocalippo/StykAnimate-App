import test from 'node:test';
import assert from 'node:assert/strict';
import {previewMsaaLevels, viewportBackingSize, updatePreviewQuality, normalizePlaybackQuality, playbackQualityIndex} from '../src/preview-quality.mjs';
import {normalizeEditorSettings} from '../src/settings.mjs';

test('saved playback quality defaults to normal and rejects unknown values', () => {
  for (const value of [undefined, null, '', 'ultra', 2, {}, ['low']]) {
    assert.equal(normalizePlaybackQuality(value), 'normal');
    assert.equal(normalizeEditorSettings({playbackQuality:value}).playbackQuality, 'normal');
  }
  for (const [value,index] of [['normal',0],['medium',1],['low',2],['draft',3],['auto',0]]) {
    assert.equal(normalizeEditorSettings({playbackQuality:value}).playbackQuality,value);
    assert.equal(playbackQualityIndex(value),index);
  }
  assert.equal(normalizeEditorSettings().playbackQuality,'normal');
});

test('every preview quality level selects one or four samples', () => {
  for (const count of previewMsaaLevels) assert.ok([1, 4].includes(count));
});

test('large and high-DPI viewports fit the device without changing CSS geometry', () => {
  for (const [width, height, dpr, limit] of [[9000, 200, 1, 8192], [1000, 5000, 3, 8192], [20000, 10000, 1, 4096]]) {
    const size = viewportBackingSize(width, height, dpr, limit);
    assert.equal(size.width, width); assert.equal(size.height, height);
    assert.ok(size.pw <= limit && size.ph <= limit);
    assert.equal(size.pw, Math.round(width * size.dpr));
    assert.equal(size.ph, Math.round(height * size.dpr));
  }
  assert.deepEqual(viewportBackingSize(1200, 800, 2, 8192), {width:1200, height:800, dpr:2, pw:2400, ph:1600});
  assert.deepEqual(viewportBackingSize(1200, 800, .25, 8192), {width:1200, height:800, dpr:.25, pw:300, ph:200});
});

const sample = fps => ({fps, targetFps:60});
test('deficits after healthy or buffering samples lower quality through both levels', () => {
  const governor = {index:0};
  assert.equal(updatePreviewQuality(governor, sample(null), 1000), false);
  updatePreviewQuality(governor, sample(60), 2000);
  updatePreviewQuality(governor, sample(30), 3000);
  assert.equal(updatePreviewQuality(governor, sample(30), 4900), false);
  assert.equal(updatePreviewQuality(governor, sample(30), 5101), true);
  assert.equal(governor.index, 1);
  updatePreviewQuality(governor, sample(30), 5500, true);
  updatePreviewQuality(governor, sample(30), 6000);
  assert.equal(updatePreviewQuality(governor, sample(30), 8101), true);
  assert.equal(governor.index, 2);
  assert.equal(updatePreviewQuality(governor, sample(30), 15000), false);
});

test('paced on-target playback restores full quality one level at a time', () => {
  const governor = {index:2};
  updatePreviewQuality(governor, sample(60), 1000);
  assert.equal(updatePreviewQuality(governor, sample(60), 7101), true);
  assert.equal(governor.index, 1);
  updatePreviewQuality(governor, sample(60), 7400);
  assert.equal(updatePreviewQuality(governor, sample(60), 13501), true);
  assert.equal(governor.index, 0);
});

test('short dips and interrupted recovery do not change quality', () => {
  const governor = {index:1};
  updatePreviewQuality(governor, sample(30), 0);
  assert.equal(updatePreviewQuality(governor, sample(60), 1900), false);
  updatePreviewQuality(governor, sample(55), 5000);
  updatePreviewQuality(governor, sample(60), 6000);
  assert.equal(updatePreviewQuality(governor, sample(60), 9000), false);
  assert.equal(governor.index, 1);
});
