/**
 * The machine's speed while an engine run measures (perf/engine/README.md "Comparing two runs").
 *
 * A shared machine does not run at one speed: another program on the other half of the same core, or every core busy and
 * the clock lower for it, makes the engine 20 to 70 % slower while it still has its processor to itself (the processor time
 * it is charged does not change). Rounds interleaved within a run share such a state, so their spread does not show it, and
 * two runs of the same code half an hour apart differed by that much. So the runner times a fixed piece of plain
 * JavaScript before every round, work no change to the engine can make faster or slower, and a comparison counts both
 * runs' times at one machine speed (`atSpeed`): a run's times are scaled by how much slower its machine was than the base
 * run's, the median of its rounds' references against theirs. One factor a run, not one a round: scaled round by round, a
 * benchmark that varies for reasons of its own (the stress scene's save, slower in a run's first rounds) took on the
 * reference's noise as well, and two runs of the same code compared as a regression.
 */
import {median, round, spread} from '../../src/devtools/stats.mjs';

/**
 * The reference: arithmetic on each step of a walk through 384 KB in a scrambled order, which misses the nearest cache as
 * the engine's walks through a document do. Of three kinds of work timed beside the engine building frames for a minute on
 * a busy machine (2026-11-13), this one followed the engine's time best (a correlation of 0.66; 0.60 for a walk through
 * 8 MB, which other programs' use of the shared cache made four times noisier, 0.55 for arithmetic alone), and scaling by it
 * cut the spread of the engine's time from 42 % to 29 %.
 */
const SLOTS = 1 << 15, STEPS = 500000;
let chain = null, values = null;

/** One cycle through every slot in a scrambled order (Sattolo's shuffle, seeded): each step lands where the caches do not help. */
function prepareChain() {
  chain = new Uint32Array(SLOTS); values = new Float64Array(SLOTS);
  for (let slot = 0; slot < SLOTS; slot++) { chain[slot] = slot; values[slot] = slot % 97; }
  let state = 20261113;
  for (let slot = SLOTS - 1; slot > 0; slot--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % slot, kept = chain[slot];
    chain[slot] = chain[other]; chain[other] = kept;
  }
}

/**
 * The milliseconds the reference work takes now: arithmetic on each step of a walk through the scrambled chain, the least
 * of two tries (an interrupt makes one try slower, never faster). About 2 ms each on a quiet machine.
 */
export function reference() {
  if (!chain) prepareChain();
  let best = Infinity, sink = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = performance.now();
    let at = 0, sum = 0;
    for (let step = 0; step < STEPS; step++) { at = chain[at]; sum = sum * .999999 + values[at] * 1.000001 + (step & 7); }
    best = Math.min(best, performance.now() - started);
    sink += sum;
  }
  // Read, so that the work is not left out as unused.
  if (sink === -1) throw new Error('unreachable');
  return best;
}

/** The reference time of a run: the median of every round's (null for a run recorded without it). */
export function machineSpeed(result) {
  const all = result.workloads.flatMap(workload => workload.benchmarks.flatMap(benchmark => benchmark.reference ?? []));
  return all.length ? median(all) : null;
}

/** Whether a metric is a time (scaled with the machine's slowness) or a rate (scaled against it); sizes and counts are not scaled. */
const scaledAs = definition => (definition?.unit === 'ms' ? 'time' : definition?.unit === 'fps' ? 'rate' : null);

/**
 * `result` with every time and rate counted at the machine speed `referenceMs` (another run's `machineSpeed`): each round's
 * value scaled by how much faster or slower `result`'s machine ran (its own `machineSpeed`), then the median and spread again.
 * With `scaling`, the capacities are found again from the scaled rounds (the `scaling` function of scaling.mjs). A run
 * recorded without references is returned as it is.
 */
export function atSpeed(result, referenceMs, scaling = null) {
  const own = machineSpeed(result);
  if (!referenceMs || own === null) return result;
  const factor = referenceMs / own;
  const workloads = result.workloads.map(workload => ({...workload, benchmarks: workload.benchmarks.map(benchmark => {
    if (benchmark.error) return benchmark;
    const rounds = {...benchmark.rounds}, metrics = {...benchmark.metrics};
    for (const [metric, list] of Object.entries(benchmark.rounds ?? {})) {
      const as = scaledAs(benchmark.definitions?.[metric]);
      if (!as) continue;
      rounds[metric] = list.map(value => round(as === 'time' ? value * factor : value / factor, 4));
      metrics[metric] = spread(rounds[metric]);
    }
    return {...benchmark, rounds, metrics};
  })}));
  const sizes = workloads.filter(workload => workload.scaling);
  const rescaled = result.scaling && scaling ? scaling(sizes, Object.fromEntries(sizes[0]?.benchmarks.map(benchmark => [benchmark.id, benchmark.definitions]) ?? [])) : result.scaling;
  return {...result, workloads, scaling: rescaled, referenceMs};
}
