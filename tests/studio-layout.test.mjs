import test from 'node:test';
import assert from 'node:assert/strict';
import {constrainStudioLayout} from '../src/studio-layout.mjs';

test('old sidebar and floating preferences cannot consume the new canvas', () => {
  const layout = constrainStudioLayout({left: 420, floating: {left: {width: 600}}}, 1280, 652);
  assert.equal(layout.right, 292);
  assert.equal(layout.timeline, 280);
  assert.ok(1280 - layout.right >= 900);
  assert.equal('left' in layout, false);
});

test('oversized saved panels still leave an editable stage at laptop sizes', () => {
  for (const [width, height] of [[1024, 700], [1280, 652], [1440, 832]]) {
    const layout = constrainStudioLayout({right: 99999, timeline: 99999}, width, height);
    assert.ok(width - layout.right >= 600);
    assert.ok(height - layout.timeline >= 210);
    assert.ok(layout.timeline >= 200);
  }
});

test('invalid stored preferences do not prevent the studio from opening', () => {
  for (const value of [null, undefined, 'invalid', {right: 'bad', timeline: 'bad'}]) {
    assert.deepEqual(constrainStudioLayout(value, 1280, 652), {right: 292, timeline: 280});
  }
});

test('compact layout clamps without changing the saved desktop preference', () => {
  const preference = {right: 380, timeline: 440};
  const small = constrainStudioLayout(preference, 760, 520);
  assert.equal(small.right, 300);
  assert.equal(small.timeline, 310);
  assert.deepEqual(preference, {right: 380, timeline: 440});
  assert.deepEqual(constrainStudioLayout(preference, 1600, 1000), preference);
});
