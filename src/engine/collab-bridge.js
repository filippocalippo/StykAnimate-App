// src/engine/collab-bridge.js

export class CollabEngineBridge {
  constructor(editSession) {
    // Expects the actual Wasm EditSession instance
    this.session = editSession;
    this.lockGeneration = 0;
  }

  /**
   * Installs session-scoped denied UIDs authoritatively into the engine.
   * Uses an incrementing generation counter for policy updates/releases.
   */
  updateSessionLocks(deniedUids = []) {
    if (!this.session || typeof this.session.call !== 'function') {
      return;
    }

    this.lockGeneration += 1;
    const payload = {
      generation: this.lockGeneration,
      locks: JSON.stringify(deniedUids)
    };

    // Route lock policy setter through EditSession command interface
    this.session.call(
      'set_selection_locks', 
      JSON.stringify(payload), 
      JSON.stringify({})
    );
  }

  /**
   * Handles remote selection requests, routing through the supported 
   * EditSession.call interface and properly handling candidate eligibility.
   */
  handleRemoteSelection(uid, eligibleCandidates = null) {
    if (!this.session || typeof this.session.call !== 'function') {
      console.warn(`[Engine] EditSession call interface unavailable.`);
      return null;
    }

    // Build command arguments
    const selectArgs = { target: uid, add: false };

    // Omit candidates when unrestricted; do NOT pass an empty array []
    if (Array.isArray(eligibleCandidates) && eligibleCandidates.length > 0) {
      selectArgs.candidates = eligibleCandidates;
    }

    const argsJson = JSON.stringify(selectArgs);
    const viewJson = JSON.stringify({});

    // Route through the supported session/owner command interface
    const rawResult = this.session.call('selectConnected', argsJson, viewJson);

    if (!rawResult) {
      return null;
    }

    // Parse and return the state for normal application path consumption
    try {
      return typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
    } catch (e) {
      console.error(`[Engine] Failed to parse selection result:`, e);
      return null;
    }
  }
}
