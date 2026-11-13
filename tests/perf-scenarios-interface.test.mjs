// The pure parts the timeline, selection and interface scenarios add to the performance runner (perf/scenarios/
// timeline.mjs, selection.mjs, interface.mjs): how far a scrub's picture trails the pointer, read out of a capture's
// `shown` series. The scenarios themselves are verified by running them (`npm run perf -- run quick --scenario timeline`).
import assert from 'node:assert/strict';
import test from 'node:test';
import {scrubTrail} from '../perf/lib/latency.mjs';
import {SCENARIOS} from '../perf/scenarios/index.mjs';

/** A drag pressed at 100 ms and released at 1100 ms, from tick 10 to tick 110: the pointer crosses a tick every 10 ms. */
const drag = (at, tick) => ({at, tick, prepared: at.map(() => 0), inputs: [100, 400, 700, 1100]});

test('a scrub that keeps up shows each tick as the pointer reaches it: no trail, every tick it painted counted', () => {
  const at = [], tick = [];
  for (let step = 1; step <= 100; step++) { at.push(100 + step * 10 + 2); tick.push(10 + step); }
  const result = scrubTrail(drag(at, tick), {fromTick: 10, toTick: 110});
  assert.equal(result.pictures, 99, 'the picture after the release is not part of the drag');
  assert.equal(result.ticks, 99);
  assert.ok(Math.abs(result.perSecond - 99) < 1e-9);
  assert.equal(result.trail.p95, 2);
  assert.equal(result.behind.p95, 0);
  assert.equal(result.releaseMs, 2, 'the picture of the final tick 2 ms after the release');
});

test('a scrub that shows old places of the pointer trails by their age, in time and in ticks', () => {
  // Every picture shows where the pointer was 150 ms (15 ticks) earlier, five a second.
  const at = [300, 500, 700, 900, 1100, 1260], tick = [15, 35, 55, 75, 95, 110];
  const result = scrubTrail(drag(at, tick), {fromTick: 10, toTick: 110});
  assert.deepEqual(result.trail, {p50: 150, p95: 150, worst: 150});
  assert.deepEqual(result.behind, {p50: 15, p95: 15});
  assert.equal(result.ticks, 5);
  assert.equal(result.releaseMs, 160);
});

test('a scrub backwards reads the same way, and a capture without a drag has no answer', () => {
  // The pointer reaches tick 100 at 200 ms and tick 80 at 400 ms.
  const result = scrubTrail(drag([300, 1100], [100, 80]), {fromTick: 110, toTick: 10});
  assert.deepEqual(result.trail, {p50: 100, p95: 700, worst: 700});
  assert.equal(result.behind.p95, 70, 'at the release the pointer was at tick 10, 70 ticks past the picture of tick 80');
  assert.equal(scrubTrail({at: [], tick: [], prepared: [], inputs: [5]}, {fromTick: 0, toTick: 10}), null);
});

test('the interface scenarios are listed once each, in their areas, with what the runner needs', () => {
  const ours = SCENARIOS.filter(scenario => ['timeline', 'selection', 'interface'].includes(scenario.area));
  assert.ok(ours.length >= 15);
  assert.equal(new Set(ours.map(scenario => scenario.id)).size, ours.length);
  for (const scenario of ours) {
    assert.match(scenario.id, new RegExp(`^${scenario.id.split('.')[0]}\\.[a-z-]+$`));
    assert.ok(['gesture', 'operation'].includes(scenario.kind), scenario.id);
    assert.equal(typeof scenario.run, 'function', scenario.id);
    assert.ok(scenario.description.length > 40, `${scenario.id} says what it does`);
  }
});
