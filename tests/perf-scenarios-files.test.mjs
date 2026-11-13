// The pure parts of the performance runner's file scenarios (perf/scenarios/save.mjs, export.mjs, perf/lib/files.mjs):
// how a save's and an export's phases are read from what the app records, and the scratch files a scenario writes.
import assert from 'node:assert/strict';
import {existsSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {scratchFolder, sizeOf, written} from '../perf/lib/files.mjs';
import {exportPhases} from '../perf/scenarios/export.mjs';
import {saveMetrics} from '../perf/scenarios/save.mjs';

test('a save\'s phases come from the timings the app keeps, and add up to the save', () => {
  // state.lastExport after a .styk save: the exporter's total, the worker's, and the engine's phases inside it.
  const timings = {format: 'styk', total_ms: 215, worker_ms: 60, engine: {prepare_ms: 5, lift_ms: 26, check_ms: 3, frames_ms: 11, assemble_ms: 2, total_ms: 47}};
  const values = saveMetrics(358, timings, 2 * 1048576);
  assert.deepEqual(values, {duration: 358, 'save.fileMB': 2, 'save.make': 215, 'save.write': 143, 'save.worker': 60, 'save.start': 155,
    'save.engine.prepare': 5, 'save.engine.lift': 26, 'save.engine.check': 3, 'save.engine.frames': 11, 'save.engine.assemble': 2});
  assert.equal(values['save.start'] + values['save.worker'] + values['save.write'], values.duration);
  // What the app did not record is left out, not reported as zero.
  assert.deepEqual(saveMetrics(100, null, 1048576), {duration: 100, 'save.fileMB': 1});
});

test('an export\'s phases are read from the stages its dialog showed', () => {
  const stages = {'exportProgress.preparingAnimation': 1, 'exportProgress.renderingFrames': 200, 'exportProgress.encodingFrames': 210, 'exportProgress.finishingYourFile': 1400};
  const values = exportPhases(stages, 1700, 24);
  assert.deepEqual(values, {duration: 1700, 'export.fps': 24 / 1.7, 'export.prepare': 200, 'export.frames': 1200, 'export.framesPerSecond': 20, 'export.finish': 300});
  assert.equal(values['export.prepare'] + values['export.frames'] + values['export.finish'], values.duration);
  // A GIF builds its palette first: that pass counts as drawing frames. A save that shows only "saving" still has its finish.
  assert.equal(exportPhases({'exportProgress.buildingGifColors': 300, 'exportProgress.savingYourFile': 900}, 1000, 10)['export.frames'], 600);
  // Too quick to paint a stage: only what was seen is reported.
  assert.deepEqual(exportPhases({}, 400, 1), {duration: 400, 'export.fps': 2.5});
});

test('a scenario\'s scratch folder gives fresh paths, waits for a written file, and leaves nothing behind', async () => {
  const files = scratchFolder('test');
  try {
    const first = files.file('export.png'), second = files.file('export.png');
    assert.notEqual(first, second);
    assert.equal(path.dirname(first), files.folder);
    assert.equal(sizeOf(first), null);
    await assert.rejects(written(first, {timeoutMs: 50, what: 'the PNG'}), /the PNG was not written: export-1\.png/);
    writeFileSync(second, '');
    await assert.rejects(written(second, {timeoutMs: 50}), /the file is empty/);
    setTimeout(() => writeFileSync(first, 'png'), 30);
    assert.equal(await written(first, {timeoutMs: 2000}), 3);
  } finally { files.remove(); }
  assert.equal(existsSync(files.folder), false);
});
