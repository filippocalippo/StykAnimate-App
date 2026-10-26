// src/engine/collab-bridge.js
export class CollabEngineBridge {
  constructor(wasmModule) {
    this.wasm = wasmModule;
  }

  handleRemoteSelection(uid, remoteLocks = []) {
    // Check if the node is locked by another peer
    if (remoteLocks.includes(uid)) {
      console.warn(`[Engine] Figure ${uid} is locked by a remote user.`);
      return null;
    }

    // Safely invoke Rust engine's connected selection traversal
    if (typeof this.wasm.selectConnected === "function") {
      return this.wasm.selectConnected(uid, { add: false, candidates: [] });
    }
    return null;
  }
}
