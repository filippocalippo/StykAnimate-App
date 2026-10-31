import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {EASING_MODES} from '../src/keyframe-easing.mjs';
import {EXPORT_SMOOTHING} from '../src/export-sampling.mjs';
import {restoreMessageError} from '../src/localized-error.mjs';
import {Localization, loadLocales} from '../src/localization.mjs';
await loadLocales();

test('core descriptors retain English fallback captions and presentation keys', () => {
  assert.deepEqual(EASING_MODES.map(mode => [mode.id, mode.label]), [
    ['auto', 'Auto'], ['bezier', 'Bezier'], ['ease-in', 'Ease in'],
    ['ease-out', 'Ease out'], ['linear', 'Linear'], ['constant', 'Constant'],
  ]);
  assert.deepEqual(EXPORT_SMOOTHING.map(option => [option.value, option.label, option.description]), [
    ['edges', 'Smooth edges', 'Smooth figure edges while keeping sharp sprite pixels.'],
    ['none', 'No smoothing', 'Aliased figure edges and unfiltered sprite pixels.'],
    ['sprites', 'Smooth sprites', 'Render at twice the size, then downsample for smoother sprites.'],
  ]);
  const italian = new Localization({locale: 'it'});
  for (const option of [...EASING_MODES, ...EXPORT_SMOOTHING]) {
    assert.notEqual(italian.t(option.labelKey), option.labelKey);
    if (option.descriptionKey) assert.notEqual(italian.t(option.descriptionKey), option.descriptionKey);
  }
});

test('worker easing failures retain English diagnostics and translate complete parameters after transport', async t => {
  const easingURL = new URL('../src/keyframe-easing.mjs', import.meta.url).href;
  const errorsURL = new URL('../src/localized-error.mjs', import.meta.url).href;
  const worker = new Worker(`
    const {parentPort} = require('node:worker_threads');
    Promise.all([import(${JSON.stringify(easingURL)}), import(${JSON.stringify(errorsURL)})]).then(([easing, errors]) => {
      const failures = ['paint', 'zIndex', 'backgroundId'].map(property => {
        try { easing.validateKeyEasing({interpolation: 'linear'}, property); }
        catch (error) { return {property, message: error.message, ...errors.errorMessageData(error)}; }
        throw new Error('Discrete easing unexpectedly accepted.');
      });
      parentPort.postMessage(failures);
    }).catch(error => { throw error; });
  `, {eval: true});
  t.after(() => worker.terminate());
  const [failures] = await once(worker, 'message');
  const italian = new Localization({locale: 'it'});
  const expected = {
    paint: ['keyframeEasing.gradientLayouts', 'Gradient layouts'],
    zIndex: ['keyframeEasing.zIndexValues', 'Z-index values'],
    backgroundId: ['keyframeEasing.backgroundIdentities', 'Background identities'],
  };
  assert.equal(failures.length, 3);
  for (const failure of failures) {
    const [messageKey, diagnosticValue] = expected[failure.property];
    assert.equal(failure.message, `${diagnosticValue} use Constant easing.`);
    assert.equal(failure.messageKey, 'errors.keyframeEasing.useConstantEasing');
    assert.deepEqual(failure.messageParams, {value: {messageKey, diagnosticValue}});
    const restored = restoreMessageError(new Error(), failure);
    assert.equal(restored.message, failure.message);
    const translated = italian.t(restored.messageKey, restored.messageParams);
    assert.ok(translated.includes(italian.t(messageKey)), translated);
    assert.ok(!translated.includes(diagnosticValue), translated);
  }
});
