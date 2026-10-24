// An editor the engine owns, for tests (D19): its document opened on the engine, which also holds the session that edits it.
import assert from 'node:assert/strict';
import {Editor} from '../../src/editor.mjs';
import {installEngineOwner} from '../../src/engine/engine-owner.mjs';

/** `verify`: the session's document is compared with the editor's after every call.
 * `recorded`: the identities a call draws come from the test (`setDraws`), else from the editor's own random ones. */
export async function ownedEditor(options, document, {verify = true, recorded = true} = {}) {
  const editor = new Editor(options).load(structuredClone(document));
  let pool = [];
  const owner = installEngineOwner(editor, {verify, draws: recorded ? () => pool : null});
  // The session exists from the moment the document opens: the app starts it as it loads the document.
  assert.ok(owner.ready(), 'the document has its session');
  return {editor, owner, setDraws: draws => { pool = draws; }};
}
