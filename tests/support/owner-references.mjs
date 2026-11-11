// The frozen references of the owner tests: what an editor the engine does not own produced for the calls an owned editor
// is compared with, recorded in `tests/fixtures/owner-references/<test file>.json` (the way the edit tapes' `.reference.json`
// files are recorded). They are the oracle of the owner tests, as the tapes are: they are never recorded again from the
// JavaScript editor, which no longer edits under the owner. A test takes each reference in order with `take(label)`; the
// value is its JSON form, so the owned side is compared through `canonical` too.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const fixtures = fileURLToPath(new URL('../fixtures/owner-references/', import.meta.url));

/** A value as the fixtures keep it: JSON (`undefined` is `null`), so a reference and what is compared with it are alike. */
export const canonical = value => value === undefined ? null : JSON.parse(JSON.stringify(value));

/** The clocks the JavaScript editor put on the frame it showed when these references were recorded: the time of the effect clips, the
 * composed effect stack of the scene and the time of the camera-motion clips. The engine's frame carries the effect time only (the
 * scene's effects are the session's `vfxEffects`, the camera its `shot`), so a recorded frame is compared without them. */
export const CLOCKS = ['_cameraMotionTick', '_vfxTimelineTick', '_vfxTimelineScene'];
const unclocked = text => {
  if (typeof text !== 'string' || !text.startsWith('{') || !CLOCKS.some(key => text.includes(`"${key}"`))) return text;
  try {
    const frame = JSON.parse(text);
    for (const key of CLOCKS) delete frame[key];
    return JSON.stringify(frame);
  } catch { return text; }
};

/** The fixtures keep long texts once per file and refer to them by their place in `texts`. */
const decode = (value, texts) => {
  if (typeof value === 'string') return unclocked(value);
  if (Array.isArray(value)) return value.map(item => decode(item, texts));
  if (value !== null && typeof value === 'object') {
    if (Object.hasOwn(value, '$text')) return unclocked(texts[value.$text]);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item, texts)]));
  }
  return value;
};

/**
 * @param {string} testFile `import.meta.url` of a test file `<name>.test.mjs`; its references are `<name>.json`
 * @returns {{test: Function}} `test(name, options, body)`: a `node:test` test whose `body(take, t)` takes the references of
 *   the test called `name`
 */
export function ownerReferences(testFile) {
  const base = path.basename(fileURLToPath(testFile)).replace(/\.test\.mjs$/, '');
  let loaded = null;
  const stored = () => loaded ??= JSON.parse(readFileSync(path.join(fixtures, `${base}.json`), 'utf8'));

  /** The references of the test called `name`, taken in the order they were recorded. */
  function takes(name) {
    let read = 0;
    const wanted = (stored().tests[name] ?? assert.fail(`no references recorded for "${name}"`)).map(entry => decode(entry, stored().texts));
    const take = label => {
      const entry = wanted[read++];
      assert.ok(entry, `"${name}": the reference "${label}" was not recorded`);
      assert.equal(entry[0], label, `"${name}": the references were recorded in another order`);
      return entry[1];
    };
    take.done = () => assert.equal(read, wanted.length, `"${name}": ${wanted.length - read} recorded references were not taken`);
    return take;
  }

  return {
    test(name, options, body) {
      if (typeof options === 'function') [options, body] = [{}, options];
      nodeTest(name, options, async t => {
        const take = takes(name);
        await body(take, t);
        take.done();
      });
    },
  };
}
