/**
 * Named plans for `npm run perf -- run <suite>` (docs/PERFORMANCE.md "Suites"): which environments, workloads and
 * scenarios a run covers, and how many timed passes each scenario gets. A suite is sized by how long a person or an
 * agent is willing to wait for its answer, so it is made of parts: every scenario on one scene, the core scenarios on
 * the others. Options on the command line replace the parts with one of their own.
 */

/**
 * The scenarios a short run covers: what a person does most, one or two from each area. A change that makes one of
 * these worse is felt by everyone; the rest are measured by `standard`.
 */
export const CORE = Object.freeze(['file.open', 'playback.play', 'timeline.step', 'timeline.scrub', 'canvas.pan', 'canvas.zoom', 'pose.drag-joint', 'pose.move-figure',
  'history.undo', 'selection.click', 'selection.move-many', 'interface.inspector-drag', 'drawing.brush', 'file.save-as']);

/** What a feature workload is compared on against the plain busy scene: opening, playing (with the feature off too), stepping, panning, posing. */
const FEATURE = ['file.open', 'playback', 'timeline.step', 'canvas.pan', 'pose.drag-joint'];

const STANDARD = [
  {environments: ['gpu'], workloads: ['medium'], scenarios: []},
  {environments: ['gpu'], workloads: ['small', 'stress'], scenarios: CORE},
];
const MACHINES = [
  {environments: ['gpu', 'webgl', 'software', 'low-end'], workloads: ['small'], scenarios: CORE},
  {environments: ['software'], workloads: ['medium'], scenarios: CORE},
];
const FEATURES = [{environments: ['gpu'], workloads: ['medium', 'sprites', 'effects', 'movieclips', 'camera', 'text', 'shapes', 'long'], scenarios: FEATURE}];
const DRAWING = [{environments: ['gpu', 'software'], workloads: ['small', 'medium'], scenarios: ['drawing']}];

/** id → {description, passes, parts: [{environments, workloads, scenarios}]}. An empty `scenarios` is every scenario. */
export const SUITES = Object.freeze({
  quick: {
    description: 'While changing code, about four minutes: this machine\'s graphics card, a small and a large scene, the core scenarios, 2 passes.',
    passes: 2, parts: [{environments: ['gpu'], workloads: ['small', 'large'], scenarios: CORE}],
  },
  standard: {
    description: 'Before a change lands, about fifteen minutes: the graphics card, every scenario on the busy scene and the core scenarios on the small and the stress scene, 3 passes.',
    passes: 3, parts: STANDARD,
  },
  machines: {
    description: 'How the app holds up on lesser computers, about ten minutes: the core scenarios on a small scene as each desktop environment, and on the busy scene with no graphics card, 2 passes.',
    passes: 2, parts: MACHINES,
  },
  features: {
    description: 'What each heavier feature costs, about ten minutes: the busy scene plain and with pictures, effects, movieclips, a camera, text and filled shapes, and a long animation, on what a feature can slow, 2 passes.',
    passes: 2, parts: FEATURES,
  },
  drawing: {
    description: 'Painting on a drawing layer, about four minutes: the graphics card and no graphics card, on a small and a busy scene (the busy scene is the stroke among many figures), 2 passes.',
    passes: 2, parts: DRAWING,
  },
  full: {
    description: 'The whole picture, about fifty minutes: standard, machines, features and drawing together, and the core scenarios in Chrome, 3 passes.',
    passes: 3, parts: [...STANDARD, ...MACHINES, ...FEATURES, ...DRAWING, {environments: ['browser'], workloads: ['small'], scenarios: CORE}],
  },
});

/** The suite named `id`; throws with the list when there is none. */
export function suite(id) {
  const found = SUITES[id];
  if (!found) throw new Error(`Unknown suite ${JSON.stringify(id)}: one of ${Object.keys(SUITES).join(', ')}.`);
  return found;
}

/**
 * The launches a list of parts asks for: one per pair of environment and workload, in the parts' order, with the
 * scenario words of every part that names the pair (a pair that one part runs in full runs in full).
 * Returns [{environment, workload, scenarios}] of ids and words.
 */
export function launches(parts) {
  const pairs = new Map();
  for (const part of parts) {
    for (const environment of part.environments) {
      for (const workload of part.workloads) {
        const key = `${environment}/${workload}`, pair = pairs.get(key) ?? {environment, workload, scenarios: new Set(), all: false};
        if (part.scenarios.length) for (const word of part.scenarios) pair.scenarios.add(word);
        else pair.all = true;
        pairs.set(key, pair);
      }
    }
  }
  return [...pairs.values()].map(pair => ({environment: pair.environment, workload: pair.workload, scenarios: pair.all ? [] : [...pair.scenarios]}));
}
