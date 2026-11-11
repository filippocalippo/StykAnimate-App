// Editors the engine owns for the tests of one file, each released when the test that opened it ends (D19).
import {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../../src/editor.mjs';
import {installEngineOwner} from '../../src/engine/engine-owner.mjs';

/** Call once at the top of a test file. `open(options, document)` is a new `Editor` (on `document` when given, else on the document
 * it starts with) that the engine owns, with the session's document compared with the editor's after every call. The owner is
 * released after the test. */
export function ownedScope() {
  const owners = [];
  afterEach(() => { while (owners.length) owners.pop().release(); });
  return (options, document = null) => {
    const editor = new Editor(options);
    if (document) editor.load(document);
    const owner = installEngineOwner(editor, {verify: true});
    owners.push(owner);
    assert.ok(owner.ready(), 'the document has its session');
    return editor;
  };
}
