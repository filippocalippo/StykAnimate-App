/**
 * Every scenario, in the order a run executes them (docs/PERFORMANCE.md "Scenarios"; perf/scenarios/README.md says
 * how to write one). A file per area of the app; a scenario's id is `<area>.<what>`.
 */
import canvas from './canvas.mjs';
import drawing from './drawing.mjs';
import files, {open} from './files.mjs';
import interfaceScenarios from './interface.mjs';
import playback from './playback.mjs';
import pose from './pose.mjs';
import selection from './selection.mjs';
import timeline from './timeline.mjs';

/** The scenario that opens the workload's document: the runner runs it first. */
export {open};

export const SCENARIOS = Object.freeze([...files, ...playback, ...timeline, ...canvas, ...pose,
  ...selection,
  ...interfaceScenarios,
  ...drawing,
]);

/**
 * The scenarios `words` name: an id (`canvas.pan`), an area (`canvas`) or part of an id. No words: all of them.
 * Throws when a word matches nothing.
 */
export function select(words = []) {
  if (!words.length) return [...SCENARIOS];
  const chosen = new Set();
  for (const word of words) {
    const matches = SCENARIOS.filter(scenario => scenario.id === word || scenario.area === word || scenario.id.includes(word));
    if (!matches.length) throw new Error(`No scenario matches ${JSON.stringify(word)}. Run \`npm run perf -- list\` for the list.`);
    for (const scenario of matches) chosen.add(scenario);
  }
  return SCENARIOS.filter(scenario => chosen.has(scenario));
}
