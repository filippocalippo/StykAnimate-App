// tests/collab.test.mjs
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { CollabEngineBridge } from '../src/engine/collab-bridge.js';

// Import the real Wasm/JS bindings
let EditSession;

describe('StykAnimate P2P Collaboration Engine Bridge (Real Wasm EditSession Integration)', () => {

  before(async () => {
    // Dynamic import for the Wasm bindings compiled by wasm-pack
    const engineModule = await import('../pkg/styk_animate_engine.js');
    EditSession = engineModule.EditSession;
  });

  /**
   * Helper function to build a standard connected graph fixture:
   * Node 1 <---> Node 2 <---> Node 3 <---> Node 4
   */
  function createConnectedGraphFixture() {
    const session = new EditSession();
    // Setup 4 connected nodes in the native engine graph
    session.call('addNode', JSON.stringify([1]), null);
    session.call('addNode', JSON.stringify([2]), null);
    session.call('addNode', JSON.stringify([3]), null);
    session.call('addNode', JSON.stringify([4]), null);

    session.call('connectNodes', JSON.stringify([1, 2]), null);
    session.call('connectNodes', JSON.stringify([2, 3]), null);
    session.call('connectNodes', JSON.stringify([3, 4]), null);

    return session;
  }

  test('Real Engine: Traverses connected graph using positional selectConnected [uid, options]', () => {
    const session = createConnectedGraphFixture();
    const bridge = new CollabEngineBridge(session);

    // Starting from node 1, selectConnected should traverse the connected graph
    const result = bridge.handleRemoteSelection(1, null, false);

    assert.equal(result.status, 'ok');
    assert.ok(Array.isArray(result.selected));
    assert.deepEqual(result.selected.sort(), [1, 2, 3, 4]);
  });

  test('Real Engine: Preserves explicit empty candidate array [] vs omitted candidates', () => {
    const session = createConnectedGraphFixture();
    const bridge = new CollabEngineBridge(session);

    // 1. Omitted / Null candidates -> Unrestricted traversal across connected nodes
    const unrestricted = bridge.handleRemoteSelection(1, null);
    assert.equal(unrestricted.status, 'ok');
    assert.deepEqual(unrestricted.selected.sort(), [1, 2, 3, 4]);

    // 2. Explicit [] candidates -> Restricted strictly to no candidates
    const restrictedEmpty = bridge.handleRemoteSelection(1, []);
    assert.equal(restrictedEmpty.status, 'ok');
    assert.deepEqual(restrictedEmpty.selected, []);

    // 3. Specific candidate restriction -> Restricted only to candidates [1, 2]
    const restrictedSubset = bridge.handleRemoteSelection(1, [1, 2]);
    assert.equal(restrictedSubset.status, 'ok');
    assert.deepEqual(restrictedSubset.selected.sort(), [1, 2]);
  });

  test('Real Engine: Direct set_selection_locks enforces lock mask and increments generation', () => {
    const session = createConnectedGraphFixture();
    const bridge = new CollabEngineBridge(session, 0);

    // Lock node 2 (e.g. client1 locked node 2)
    const lockState1 = bridge.updateSessionLocks([2]);
    assert.equal(lockState1.status, 'ok');
    assert.equal(bridge.lockGeneration, 1);

    // Attempting selectConnected starting at node 1
    // Node 2 is locked: it remains traversable to reach node 3 & 4, but node 2 is excluded from active selection set
    const selection = bridge.handleRemoteSelection(1, null);
    assert.equal(selection.status, 'ok');
    assert.ok(!selection.selected.includes(2), 'Locked node 2 should be excluded from selection set');
    assert.deepEqual(selection.selected.sort(), [1, 3, 4]);

    // Release locks
    const lockState2 = bridge.updateSessionLocks([]);
    assert.equal(lockState2.status, 'ok');
    assert.equal(bridge.lockGeneration, 2);
  });

  test('Real Engine: Rejects stale-generation lock updates and allows retry with current generation', () => {
    const session = createConnectedGraphFixture();
    const bridge = new CollabEngineBridge(session, 5); // Current bridge gen = 5

    // Attempt to invoke set_selection_locks directly on session with a stale generation (e.g. gen 3)
    const staleResult = JSON.parse(session.set_selection_locks(3, JSON.stringify([1])));
    assert.equal(staleResult.status, 'rejected');
    assert.equal(staleResult.reason, 'stale_generation');

    // Bridge automatically increments and retries with next generation (gen 6)
    const validResult = bridge.updateSessionLocks([1]);
    assert.equal(validResult.status, 'ok');
    assert.equal(bridge.lockGeneration, 6);
  });

  test('Real Engine: Handles newer-generation lock release cleanly', () => {
    const session = createConnectedGraphFixture();
    const bridge = new CollabEngineBridge(session, 1);

    // Apply lock on node 3
    bridge.updateSessionLocks([3]); // Generation becomes 2
    assert.equal(bridge.lockGeneration, 2);

    // A newer remote update advances generation to 10 and releases all locks
    const releaseResult = JSON.parse(session.set_selection_locks(10, JSON.stringify([])));
    assert.equal(releaseResult.status, 'ok');

    // Sync bridge generation counter to match engine state
    bridge.syncGeneration(10);
    assert.equal(bridge.lockGeneration, 10);

    // Verify traversal is completely unlocked across all nodes
    const selection = bridge.handleRemoteSelection(1, null);
    assert.deepEqual(selection.selected.sort(), [1, 2, 3, 4]);
  });

  test('Throws TypeError on invalid candidate input type', () => {
    const session = createConnectedGraphFixture();
    const bridge = new CollabEngineBridge(session);

    assert.throws(() => {
      bridge.handleRemoteSelection(1, "invalid_candidate_string");
    }, TypeError);
  });
});
