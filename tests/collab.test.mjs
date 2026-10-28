// tests/collab.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CollabEngineBridge } from '../src/engine/collab-bridge.js';

describe('StykAnimate P2P Collaboration Engine Bridge (PR #20 Wasm Real-API Alignment)', () => {

  test('Passes positional command arguments as JSON array [uid, options]', () => {
    let capturedMethod = null;
    let capturedArgs = null;

    const mockSession = {
      call(method, argsJson, viewJson) {
        capturedMethod = method;
        capturedArgs = JSON.parse(argsJson);
        return JSON.stringify({ status: 'ok', selected: [1, 2, 3] });
      }
    };

    const bridge = new CollabEngineBridge(mockSession);
    const result = bridge.handleRemoteSelection(1, null, false);

    assert.equal(capturedMethod, 'selectConnected');
    assert.deepEqual(capturedArgs, [1, { add: false }]);
    assert.deepEqual(result, { status: 'ok', selected: [1, 2, 3] });
  });

  test('Preserves explicit empty candidate array [] vs omitted candidates', () => {
    let capturedArgsUnrestricted = null;
    let capturedArgsExplicitEmpty = null;

    const mockSession = {
      call(method, argsJson) {
        const parsed = JSON.parse(argsJson);
        if (!capturedArgsUnrestricted) {
          capturedArgsUnrestricted = parsed;
        } else {
          capturedArgsExplicitEmpty = parsed;
        }
        return JSON.stringify({ status: 'ok' });
      }
    };

    const bridge = new CollabEngineBridge(mockSession);

    // 1. Omitted / Null candidates -> Unrestricted
    bridge.handleRemoteSelection(1, null);
    assert.equal(capturedArgsUnrestricted[1].candidates, undefined);

    // 2. Explicit [] candidates -> Restricted to none
    bridge.handleRemoteSelection(1, []);
    assert.deepEqual(capturedArgsExplicitEmpty[1].candidates, []);
  });

  test('Calls set_selection_locks directly on EditSession and increments generation after success', () => {
    const lockCalls = [];

    const mockSession = {
      set_selection_locks(generation, locksJson) {
        lockCalls.push({ generation, locks: JSON.parse(locksJson) });
        return JSON.stringify({ status: 'ok', selection: [1, 3] });
      }
    };

    const bridge = new CollabEngineBridge(mockSession, 0);

    // First lock update (denying UID 2)
    const state1 = bridge.updateSessionLocks([2]);
    assert.equal(lockCalls.length, 1);
    assert.equal(lockCalls[0].generation, 1);
    assert.deepEqual(lockCalls[0].locks, [2]);
    assert.deepEqual(state1, { status: 'ok', selection: [1, 3] });
    assert.equal(bridge.lockGeneration, 1);

    // Second lock update (lock release)
    const state2 = bridge.updateSessionLocks([]);
    assert.equal(lockCalls.length, 2);
    assert.equal(lockCalls[2 - 1].generation, 2);
    assert.deepEqual(lockCalls[2 - 1].locks, []);
    assert.equal(bridge.lockGeneration, 2);
  });

  test('Throws TypeError on invalid candidate input type', () => {
    const bridge = new CollabEngineBridge({ call: () => {} });
    assert.throws(() => {
      bridge.handleRemoteSelection(1, "invalid_candidate_string");
    }, TypeError);
  });
});
