// The list of the calls the owner sends to the session (src/engine/engine-commands.mjs) is held to the session's own dispatch: every
// name in it is a command the session has, and every public method of the editor that is not in it is one the session has no command
// for (or a call that only moves the view, or a history call the owner makes itself). So a command added to the session without
// a line in the list, or a line for a command that is not there, fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Editor} from '../src/editor.mjs';
import {installEngineOwner} from '../src/engine/engine-owner.mjs';
import {SESSION_COMMANDS, VIEW_CALLS} from '../src/engine/engine-commands.mjs';
import {engineBuilt} from './support/engine-node.mjs';

const document = JSON.parse(readFileSync(new URL('../engine/tests/edit/branch-thickness-locked-sheet.document.json', import.meta.url), 'utf8'));
/** What the owner makes of a call itself, besides the session's commands, and the reads the editor answers from the state the owner mirrors
 * (the session answers them too, for the replays). */
const OWNERS_OWN = new Set(['undo', 'redo', 'movieclipBatch', 'bakeMovieclip', 'segmentValues', 'motionPathFalloff']);

test('the list of session commands is the session\'s dispatch', {skip: !engineBuilt}, () => {
  const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true}).load(structuredClone(document));
  const owner = installEngineOwner(editor);
  try {
    assert.ok(owner.ready());
    const session = owner.session();
    const view = JSON.stringify({tick: 0, frameIndex: 0, selectedUid: null, selectedUids: [], selectedJoint: -1, activeLayerId: editor.activeLayerId, autoKey: false, audioRipple: false, sheetSelection: null, patch: true, changesOnly: true, draws: [], drawPool: true});
    /** Whether the session has a command of this name (it answers "no command" with the call's own name when it has none). */
    const has = name => {
      const answer = JSON.parse(session.call(name, '[]', view));
      return !(answer.status === 'unported' && answer.reason === name);
    };
    assert.equal(new Set(SESSION_COMMANDS).size, SESSION_COMMANDS.length, 'a name once');
    assert.deepEqual([...SESSION_COMMANDS], [...SESSION_COMMANDS].sort(), 'in order');
    for (const name of SESSION_COMMANDS) assert.ok(has(name), `${name} is a command of the session`);

    const methods = new Set();
    for (let prototype = Object.getPrototypeOf(editor); prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
      for (const name of Object.getOwnPropertyNames(prototype)) {
        if (typeof Object.getOwnPropertyDescriptor(prototype, name).value === 'function' && !name.startsWith('_') && name !== 'constructor') methods.add(name);
      }
    }
    const strays = [...methods].filter(name => !SESSION_COMMANDS.includes(name) && !VIEW_CALLS.has(name) && !OWNERS_OWN.has(name) && has(name));
    assert.deepEqual(strays, [], 'public methods of the editor the session has a command for that the owner does not send to it');
  } finally { owner.release(); }
});
