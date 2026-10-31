// Runs a call with the editor's random draws (identities, seeds, fractions) recorded in order, or replaced by the values a recording drew.
import {editorDraws} from '../../src/editor-draws.mjs';

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
