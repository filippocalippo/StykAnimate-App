/**
 * Values the editor draws at random: identities (`uuid`), seeds (`seed`, 31 or 32 random bits)
 * and fractions (`random`). Editing commands draw them here only, so that a call the engine
 * runs can be handed the very values the editor drew (D18, docs/engine/editing.md) and
 * command recordings stay reproducible (`withDraws`).
 */
export const editorDraws = {
  uuid: () => globalThis.crypto.randomUUID(),
  seed: () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0],
  random: () => Math.random(),
};

/** Runs `run` with every draw recorded in order as `[kind, value]`; `source`, when given,
 * replaces the draws (`source(kind)` returns the value). Returns `{result, draws}`; a thrown
 * error carries the draws made before it as `error.draws`. */
export function withDraws(run, source) {
  const saved = {...editorDraws}, draws = [];
  for (const kind of Object.keys(saved)) editorDraws[kind] = () => { const value = source ? source(kind) : saved[kind](); draws.push([kind, value]); return value; };
  try { return {result: run(), draws}; }
  catch (error) { if (error && typeof error === 'object') error.draws = draws; throw error; }
  finally { Object.assign(editorDraws, saved); }
}
