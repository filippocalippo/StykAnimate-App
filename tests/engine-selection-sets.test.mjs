// Real WebAssembly command parity, independent of the app's JavaScript selection routing.
import '../engine/tools/v8-pin.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {engineBuilt, sessionFromDocument} from './support/engine-node.mjs';

for (const mode of ['native', 'sheet', 'autokey-sheet']) test(`selection-set commands match recorded editor steps through WebAssembly (${mode})`, {skip: !engineBuilt}, async () => {
  const reference = JSON.parse(readFileSync(new URL(`../engine/tests/edit/selection-sets-${mode}.reference.json`, import.meta.url), 'utf8'));
  const first = reference.steps[0];
  const session = await sessionFromDocument(JSON.parse(first.document), {...first.state, ...reference.editor});
  let previous = first.state, document = first.document;
  try {
    for (const step of reference.steps.slice(1)) {
      const [method, ...args] = step.call;
      const revision = session.revision();
      const answer = JSON.parse(session.call(method, JSON.stringify(args), JSON.stringify({...previous, autoKey: Boolean(reference.editor.autoKey)})));
      assert.equal(answer.status, step.error ? 'error' : 'ok', `${mode}/${step.step}/${method}`);
      if (step.error) assert.equal(answer.error, step.error.key);
      assert.deepEqual(answer.state, step.state, `${mode}/${step.step} state`);
      assert.deepEqual(answer.events, step.events, `${mode}/${step.step} events`);
      if (step.document) document = step.document;
      assert.equal(session.report_json(), document, `${mode}/${step.step} document`);
      if (['selectSameDefinition', 'invertSelection', 'selectMarquee'].includes(method)) assert.equal(session.revision(), revision);
      if (!step.error && ['selectSameDefinition', 'invertSelection', 'selectMarquee'].includes(method)) {
        assert.deepEqual(answer.result.map(object => object.unique_id), step.result.map(object => object.unique_id));
      }
      previous = step.state;
    }
  } finally { session.free(); }
});
