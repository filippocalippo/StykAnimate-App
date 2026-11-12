import test from 'node:test';
import assert from 'node:assert/strict';
import {DrawingController} from '../src/drawing-controller.mjs';
import {UserLibrary} from '../src/user-library.mjs';

// While the playhead is dragged the chrome waits for the release (docs/TIMELINE.md, "Scrub integration"): nothing reads the frame
// on show for an intermediate tick.

test('a seek with nothing selected in a drawing queues no pass of the chrome', () => {
  let ui = 0, renders = 0;
  const controller = Object.assign(Object.create(DrawingController.prototype), {selection: null, marquee: null, onUI: () => ui++, onRender: () => renders++});
  controller.cancelSelection();
  assert.equal(ui, 0, 'every tick of a scrub cancels; with nothing to cancel the inspector is not rendered for it');
  assert.equal(renders, 1);
  controller.marquee = {mask: null};
  controller.cancelSelection();
  assert.equal(ui, 1);
  assert.equal(controller.marquee, null);
});

test('the library looks at the selection on show once the playhead rests, not while it is dragged', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let held = true, synced = 0;
  const library = Object.assign(Object.create(UserLibrary.prototype), {playheadHeld: () => held});
  library.syncSelection = () => synced++;
  library.editorChanged({detail: {kind: 'seek'}});
  t.mock.timers.tick(1000);
  assert.equal(synced, 0, 'a held playhead keeps the read of the frame for the release');
  held = false;
  t.mock.timers.tick(250);
  assert.equal(synced, 1);
  library.editorChanged({detail: {kind: 'selection'}});
  assert.equal(synced, 2, 'any other change is shown at once');
});
