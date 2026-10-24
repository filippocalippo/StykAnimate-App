// Complete return views from the actual editor, beyond the older depth4 probe.
import {readFileSync, readdirSync, mkdirSync, writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {open} from './fixture-kit.mjs';

const source = new URL('../tests/session-live/', import.meta.url);
const target = new URL('../tests/session-live-return/', import.meta.url);
mkdirSync(target, {recursive: true});
Object.defineProperty(performance, 'now', {value: () => 0, configurable: true});
const json = value => JSON.stringify(value, (key, item) => key === 'runtime_segments' ? undefined : item);
let calls = 0;
for (const name of readdirSync(source).filter(name => name.endsWith('.json') && !name.includes('preflight')).sort()) {
  const reference = JSON.parse(readFileSync(new URL(name, source), 'utf8'));
  const editor = open(JSON.parse(reference.steps[0].document), reference.options);
  const steps = [];
  let document = reference.steps[0].document, frame = reference.steps[0].frame;
  for (const expected of reference.steps.slice(1)) {
    let result, error = null;
    try { result = await editor[expected.call[0]](...expected.call.slice(1)); }
    catch (caught) { error = {message: caught.message, key: caught.messageKey ?? null, name: caught.name}; }
    document = expected.document ?? document; frame = expected.frame ?? frame;
    assert.equal(json(editor.report), document, `${name}: ${expected.call[0]} document`);
    const display = editor._drag?.motionPath ? editor._drag.display?.frame ?? editor.evaluatedFrame : editor.evaluatedFrame;
    assert.equal(json(display), frame, `${name}: ${expected.call[0]} frame`);
    assert.deepEqual(error, expected.error, `${name}: error`);
    steps.push({call: expected.call, resultDefined: result !== undefined,
      ...(result !== undefined ? {resultJSON: json(result)} : {}), error});
    calls++;
  }
  writeFileSync(new URL(name, target), json({name: reference.name, steps}) + '\n');
}
console.log(`18 complete actual-editor live return tapes / ${calls} calls generated.`);
