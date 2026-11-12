/**
 * The machines a profiling run can measure the app as (docs/PERFORMANCE.md "Environments").
 *
 * A development machine with a recent graphics card says little about the computers many people animate on. Each
 * environment starts the app with the switches and the limits that put it on the same code paths as such a computer:
 *
 *   switches      Chromium switches of the launch: which graphics the app gets;
 *   cpuSlowdown   how many times slower the page's threads run (the inspector's processor throttling);
 *   page          what the page reports and the live parameters it starts with (src/devtools/early.js): the
 *                 processor count and memory the app sizes its threads and caches by, and the engine's own limits.
 *
 * What an environment cannot do is make the graphics process itself slower or take real memory away: `software` and
 * `low-end` run the software rasterizer at this machine's processor speed, so a real computer without a graphics card
 * is slower still. Read their numbers as a floor for that computer, never as its measurement.
 */

/** The switches that take the graphics card away: Chromium composites and draws WebGL on the processor (SwiftShader). */
const NO_GPU = ['--disable-gpu'];

export const ENVIRONMENTS = Object.freeze({
  gpu: {
    id: 'gpu', title: 'Graphics card', host: 'desktop',
    description: 'The desktop app as it starts on this machine: WebGPU on the graphics card, every processor core.',
    switches: [], cpuSlowdown: 1, page: {},
  },
  webgl: {
    id: 'webgl', title: 'Graphics card without WebGPU', host: 'desktop',
    description: 'A graphics card whose driver Chromium does not trust for WebGPU: the engine draws with WebGL2 on the card.',
    // The software WebGPU adapter is not part of Electron: asking for it leaves the page without a WebGPU adapter, as a blocked driver does.
    switches: ['--use-webgpu-adapter=swiftshader'], cpuSlowdown: 1, page: {},
  },
  software: {
    id: 'software', title: 'No graphics card', host: 'desktop',
    description: 'No usable graphics card (a virtual machine, a remote desktop, a blocked driver): Chromium draws the interface and the stage (WebGL2) on the processor.',
    switches: NO_GPU, cpuSlowdown: 1, page: {},
  },
  'low-end': {
    id: 'low-end', title: 'Old laptop', host: 'desktop',
    description: 'No graphics card, four processor threads four times slower, 4 GB of memory: two engine threads, small caches and a 1 GiB engine memory.',
    switches: NO_GPU, cpuSlowdown: 4,
    page: {hardwareConcurrency: 4, deviceMemoryGiB: 4, parameters: {'engine.workers': 2, 'engine.memoryMaximumMiB': 1024}},
  },
  browser: {
    id: 'browser', title: 'Chrome', host: 'browser',
    description: 'The web build\'s host: this checkout\'s sources in headless Chrome on the graphics card.',
    switches: [], cpuSlowdown: 1, page: {},
  },
});

/** The environment named `id`; throws with the list when there is none. */
export function environment(id) {
  const found = ENVIRONMENTS[id];
  if (!found) throw new Error(`Unknown environment ${JSON.stringify(id)}: one of ${Object.keys(ENVIRONMENTS).join(', ')}.`);
  return found;
}
