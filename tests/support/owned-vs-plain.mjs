// A call run on an editor the engine owns (D19) and compared with what an editor alone gave for it (the frozen references
// of tests/support/owner-references.mjs): the documents they show after it, the history entries it left and what undo
// and redo give back are the same, and the engine session took the call itself (nothing was refused). The expectations of the
// call are the tests' own.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Editor} from '../../src/editor.mjs';
import {installEngineOwner} from '../../src/engine/engine-owner.mjs';
import {canonical} from './owner-references.mjs';

const folder = new URL('../../engine/tests/edit/', import.meta.url);
/** A recorded tape's document, a fresh copy. */
export const recordedDocument = name => JSON.parse(readFileSync(new URL(`${name}.document.json`, folder), 'utf8'));

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** The identities a call draws at random, numbered by where they first appear: two runs make the same document. */
export function normalized(text) {
  const seen = new Map();
  return text.replace(UUID, id => { if (!seen.has(id)) seen.set(id, `<id ${seen.size}>`); return seen.get(id); });
}
/** The document the interface reads (the pose caches are not part of it). */
export const documentText = editor => normalized(JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' || key === '_movieclipSample' ? undefined : value));

/** Where two texts part, with what surrounds it (a different key order shows only here). */
const parting = (a, b) => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}: ${a.slice(Math.max(0, i - 80), i + 120)}\n  <> ${b.slice(Math.max(0, i - 80), i + 120)}`;
};

/** The first places two JSON documents part, as paths: what a failed comparison says. */
export function differences(a, b, path = '', found = []) {
  if (found.length >= 4) return found;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    if (!Object.is(a, b)) found.push(`${path}: ${JSON.stringify(a)?.slice(0, 160)} <> ${JSON.stringify(b)?.slice(0, 160)}`);
    return found;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[key], b[key], `${path}/${key}`, found);
  return found;
}

/**
 * @param {Function} take the test's references (`ownerReferences(...).test`): what an editor alone gave
 * @param {object} document the document the owned editor opens
 * @param {(editor, mark: (name: string) => void) => unknown} act the calls to make (it may be asynchronous); `mark` records
 *   the document at that point
 * @param {object} [settings] `options`: the editor's; `expectEntries`: how many history entries the calls leave (default:
 *   at least one); `unchanged`: the calls change nothing (they raise an error the same way in both)
 * @returns {Promise<{plain, owned}>} what each editor showed (`states`, the history `entries` it left and `result`, what `act`
 *   returned, as text), and for the owned one the `editor`
 */
export async function bothWays(take, document, act, {options = {}, expectEntries = null, unchanged = false} = {}) {
  const run = async () => {
    const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true, ...options}).load(structuredClone(document));
    const owner = installEngineOwner(editor);
    try {
      const states = [], mark = name => states.push({name, document: documentText(editor), undo: editor.undoLabel, redo: editor.redoLabel, depth: editor._undo.length, dirty: editor.dirty});
      const depth = editor._undo.length;
      mark('before');
      const result = await act(editor, mark);
      mark('after');
      const entries = editor._undo.length - depth;
      for (let i = 0; i < entries; i++) { await editor.undo(); mark(`undo ${i + 1}`); }
      for (let i = 0; i < entries; i++) { await editor.redo(); mark(`redo ${i + 1}`); }
      return {states, entries, result, editor, refused: Object.keys(owner.refused)};
    } finally { owner.release(); }
  };
  const plain = take('plain');
  const owned = await run();
  const ownedStates = canonical(owned.states);
  if (!unchanged) assert.ok(plain.entries >= (expectEntries ?? 1), `the call left ${plain.entries} history entries`);
  if (expectEntries !== null) assert.equal(plain.entries, expectEntries);
  ownedStates.forEach((state, i) => {
    const other = plain.states[i];
    assert.equal(state.document === other.document, true, `${state.name}: the documents differ\n${differences(JSON.parse(state.document), JSON.parse(other.document)).join('\n')}\n${parting(state.document, other.document)}`);
  });
  assert.deepEqual(ownedStates, plain.states);
  const at = name => plain.states.find(state => state.name === name).document;
  if (unchanged) assert.equal(at('after'), at('before'), 'the call changed nothing');
  else assert.notEqual(at('after'), at('before'), 'the call changed the document');
  assert.deepEqual(owned.refused, [], 'the session refused nothing');
  assert.equal(normalized(JSON.stringify(owned.result) ?? ''), plain.result, 'the calls gave the same');
  return {plain, owned};
}
