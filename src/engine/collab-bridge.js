// src/engine/collab-bridge.js

export class CollabEngineBridge {
  constructor(editSession, initialGeneration = 0) {
    this.session = editSession;
    // Define generation ownership to prevent counter collisions across bridge reinstantiations
    this.lockGeneration = initialGeneration;
  }

  /**
   * Installs session-scoped denied UIDs directly on the EditSession native method.
   * Returns the parsed corrected state returned by the engine.
   */
  updateSessionLocks(deniedUids = []) {
    if (!this.session || typeof this.session.set_selection_locks !== 'function') {
      console.warn('[Engine] set_selection_locks native method unavailable.');
      return null;
    }

    const nextGeneration = this.lockGeneration + 1;
    const locksJson = JSON.stringify(deniedUids);

    try {
      // Direct method call on EditSession (not routed through session.call)
      const rawResult = this.session.set_selection_locks(nextGeneration, locksJson);
      if (!rawResult) return null;

      const correctedState = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
      
      // Advance generation counter only after successful call
      this.lockGeneration = nextGeneration;
      return correctedState;
    } catch (e) {
      console.error('[Engine] Failed to apply selection locks:', e);
      return null;
    }
  }

  /**
   * Invokes native selectConnected via EditSession.call using positional array arguments [uid, options].
   */
  handleRemoteSelection(uid, eligibleCandidates = null, add = false, viewJson = 'null') {
    if (!this.session || typeof this.session.call !== 'function') {
      console.warn('[Engine] EditSession call interface unavailable.');
      return null;
    }

    const options = { add: Boolean(add) };

    // Explicitly validate and preserve empty candidate array [] vs omitted/null
    if (eligibleCandidates !== null && eligibleCandidates !== undefined) {
      if (Array.isArray(eligibleCandidates)) {
        options.candidates = eligibleCandidates;
      } else {
        throw new TypeError('[Engine] eligibleCandidates must be an Array or null/undefined');
      }
    }

    // Pass positional command arguments as a JSON array: [uid, options]
    const argsJson = JSON.stringify([uid, options]);

    try {
      const rawResult = this.session.call('selectConnected', argsJson, viewJson);
      if (!rawResult) return null;

      const answer = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;

      // Check real command response status
      if (answer && answer.status && answer.status !== 'ok' && answer.status !== 'success') {
        console.warn(`[Engine] Command selectConnected returned non-success status:`, answer.status);
      }

      return answer;
    } catch (e) {
      console.error('[Engine] Failed to execute selectConnected:', e);
      return null;
    }
  }
}
