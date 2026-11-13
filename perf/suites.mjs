/**
 * Named plans for `npm run perf -- run <suite>` (docs/PERFORMANCE.md "Suites"): which environments, workloads and
 * scenarios a run covers, and how many timed passes each scenario gets. A suite is sized by how long a person or an
 * agent is willing to wait for its answer; options on the command line replace any part of it.
 */
export const SUITES = Object.freeze({
  quick: {
    description: 'While changing code, about two minutes: this machine\'s graphics card, a small and a large scene, every scenario, 2 passes.',
    environments: ['gpu'], workloads: ['small', 'large'], scenarios: [], passes: 2,
  },
  standard: {
    description: 'Before a change lands, about six minutes: the graphics card on the new project, a small, a busy and the stress scene, 3 passes.',
    environments: ['gpu'], workloads: ['starter', 'small', 'medium', 'stress'], scenarios: [], passes: 3,
  },
  machines: {
    description: 'How the app holds up on lesser computers, about eight minutes: every desktop environment on a small and a busy scene, 2 passes.',
    environments: ['gpu', 'webgl', 'software', 'low-end'], workloads: ['small', 'medium'], scenarios: [], passes: 2,
  },
  full: {
    description: 'The whole picture, about twenty minutes: every environment, the new project and all four scene sizes, 3 passes.',
    environments: ['gpu', 'webgl', 'software', 'low-end', 'browser'], workloads: ['starter', 'small', 'medium', 'large', 'stress'], scenarios: [], passes: 3,
  },
  features: {
    description: 'What each heavier feature costs, about twelve minutes: the graphics card on the busy scene and on it with pictures, effects, movieclips, a camera, text and filled shapes, and a long animation; every scenario but drawing, 2 passes.',
    environments: ['gpu'], workloads: ['medium', 'sprites', 'effects', 'movieclips', 'camera', 'text', 'shapes', 'long'], scenarios: ['files', 'playback', 'timeline', 'canvas', 'posing'], passes: 2,
  },
  drawing: {
    description: 'Painting on a drawing layer, about four minutes: the graphics card and no graphics card, on a small and a busy scene (the busy scene is the stroke among many figures), 2 passes.',
    environments: ['gpu', 'software'], workloads: ['small', 'medium'], scenarios: ['drawing'], passes: 2,
  },
});

/** The suite named `id`; throws with the list when there is none. */
export function suite(id) {
  const found = SUITES[id];
  if (!found) throw new Error(`Unknown suite ${JSON.stringify(id)}: one of ${Object.keys(SUITES).join(', ')}.`);
  return found;
}
