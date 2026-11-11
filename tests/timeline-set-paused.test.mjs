import test from 'node:test';
import assert from 'node:assert/strict';
import {Timeline} from '../src/layer-timeline.mjs';

test('pausing a timeline that is paused already asks for no animation frame, and a change of state does', () => {
  const asked = [];
  const timeline = Object.assign(Object.create(Timeline.prototype), {
    paused: false, update(dirty) { asked.push(['update', dirty]); }, _centerSoon() { asked.push(['center']); },
  });
  timeline.setPaused(false);
  assert.deepEqual(asked, [], 'a stepping key pauses before it seeks: a frame asked for here would run before the stage\'s');
  timeline.setPaused(true);
  assert.deepEqual(asked, [['update', false]]);
  timeline.setPaused(true);
  assert.equal(asked.length, 1);
  timeline.setPaused(false);
  assert.deepEqual(asked.slice(1), [['update', true], ['center']], 'resuming repaints and centres');
});
