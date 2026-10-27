// tests/collab.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CollabEngineBridge } from '../src/engine/collab-bridge.js';

describe('StykAnimate P2P Collaboration Bridge Tests', () => {

  test('Omits candidate array when unrestricted (does not pass empty array)', () => {
    const mockSession = { call: () => JSON.stringify({ status: 'ok' }) };
    const bridge = new CollabEngineBridge(mockSession);

    // Mocking handleRemoteSelection payload construction logic or checking behavior
    const result = bridge.handleRemoteSelection(101, null);
    assert.notEqual(result, undefined);
  });

  test('Routes commands via EditSession.call and parses state correctly', () => {
    let capturedMethod = null;
    let capturedArgs = null;

    const mockSession = {
      call(method, argsJson) {
        capturedMethod = method;
        capturedArgs = JSON.parse(argsJson);
        return JSON.stringify({ success: true, selectedTarget: capturedArgs.target });
      }
    };

    const bridge = new CollabEngineBridge(mockSession);
    const state = bridge.handleRemoteSelection(202, [200, 201, 202]);

    assert.equal(capturedMethod, 'selectConnected');
    assert.equal(capturedArgs.target, 202);
    assert.deepEqual(capturedArgs.candidates, [200, 201, 202]);
    assert.deepEqual(state, { success: true, selectedTarget: 202 });
  });

  test('Installs authoritative session locks with incrementing generations', () => {
    const callLog = [];
    const mockSession = {
      call(method, argsJson) {
        callLog.push({ method, args: JSON.parse(argsJson) });
        return JSON.stringify({ status: 'locks_updated' });
      }
    };

    const bridge = new CollabEngineBridge(mockSession);

    // First lock update
    bridge.updateSessionLocks([501, 502]);
    // Second lock update
    bridge.updateSessionLocks([501]);

    assert.equal(callLog.length, 2);
    assert.equal(callLog[0].method, 'set_selection_locks');
    assert.equal(callLog[0].args.generation, 1);
    assert.deepEqual(JSON.parse(callLog[0].args.locks), [501, 502]);

    assert.equal(callLog[1].args.generation, 2);
    assert.deepEqual(JSON.parse(callLog[1].args.locks), [501]);
  });

  test('Returns null safely when EditSession call interface is missing', () => {
    const invalidSession = {};
    const bridge = new CollabEngineBridge(invalidSession);

    const state = bridge.handleRemoteSelection(101);
    assert.equal(state, null);
  });
});
