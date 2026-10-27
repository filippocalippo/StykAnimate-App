/**
 * Values the editor draws at random: identities (`uuid`), seeds (`seed`, 31 or 32 random bits)
 * and fractions (`random`). Editing commands draw them here only, so that a call the engine
 * runs can be handed the very values the editor drew (D18, docs/engine/editing.md) and
 * command recordings stay reproducible (tests/support/with-draws.mjs).
 */
export const editorDraws = {
  uuid: () => globalThis.crypto.randomUUID(),
  seed: () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0],
  random: () => Math.random(),
};
