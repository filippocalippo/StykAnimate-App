// Loaded Editor documents and the existing rig compiler are the validation oracle.
import {readFileSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';
import {rigConstraintPlan} from '../../src/rig-constraints.mjs';
const document = 'origin-rig-pose-support-sheet.document.json';
const report = JSON.parse(readFileSync(new URL(`../tests/edit/${document}`, import.meta.url), 'utf8'));
const figure = report.figure_types[0];
const index = kind => figure.segments.findIndex(segment => segment._stykRig?.[kind]);
const paths = Object.fromEntries(['stretch', 'follow', 'angleLock', 'connector'].map(kind => [kind, ['segments', index(kind), '_stykRig', kind]]));
const cases = [];
const add = (name, path, value, remove = false) => cases.push({name, path, value, ...(remove ? {remove: true} : {})});
const field = (kind, key, name, value, remove = false) => add(`${kind}-${key}-${name}`, [...paths[kind], key], value, remove);
for (const [name, value] of [['missing', null], ['string', '1'], ['null', null], ['nan', {specialNumber: 'NaN'}], ['infinite', {specialNumber: 'Infinity'}], ['negative-infinite', {specialNumber: '-Infinity'}]]) {
  for (const [kind, key] of [['stretch', 'restLength'], ['stretch', 'min'], ['stretch', 'max'], ['follow', 'influence'], ['angleLock', 'angle'], ['angleLock', 'multiplier'], ['connector', 'restLength']]) field(kind, key, name, value, name === 'missing');
}
for (const [name, value] of [['negative', -1], ['zero', 0], ['below-epsilon', 1e-9], ['overflow', 1000001]]) {
  field('stretch', 'restLength', name, value);field('connector', 'restLength', name, value);
}
for (const [kind, key, name, value] of [
  ['stretch', 'min', 'negative', -.1], ['stretch', 'min', 'overflow', 101], ['stretch', 'max', 'zero', 0], ['stretch', 'max', 'below-minimum', .001], ['stretch', 'max', 'overflow', 101],
  ['stretch', 'width', 'unknown', 'future'], ['stretch', 'branch', 'string', 'true'], ['stretch', 'branch', 'number', 1],
  ['stretch', 'source', 'unknown', 'future'], ['stretch', 'source', 'without-connector', 'span'], ['stretch', 'restPosition', 'zero', 0], ['stretch', 'restPosition', 'overflow', 1.1], ['stretch', 'restPosition', 'string', '.5'],
  ['follow', 'influence', 'below-range', -4.1], ['follow', 'influence', 'above-range', 4.1], ['follow', 'automatic', 'string', 'true'],
  ['follow', 'mode', 'unknown', 'future'], ['angleLock', 'angle', 'overflow', 1000001], ['angleLock', 'multiplier', 'overflow', 10.1], ['angleLock', 'space', 'unknown', 'future'],
  ['angleLock', 'secondary', 'wrong-mode', {reference: 44, restAngle: 0, multiplier: 1}],
]) field(kind, key, name, value);
for (const [name, value] of [['missing', null], ['string', '44'], ['fractional', 44.5], ['negative', -1], ['nonexistent', 999], ['nan', {specialNumber: 'NaN'}], ['infinite', {specialNumber: 'Infinity'}]]) {
  field('connector', 'start', name, value, name === 'missing');field('follow', 'driver', name, value, name === 'missing');
}
field('connector', 'end', 'same-anchor', figure.segments[index('connector')]._stykRig.connector.start);
field('connector', 'start', 'self-cycle', figure.segments[index('connector')].segment_id);
field('follow', 'driver', 'disabled-driver', 33);
field('follow', 'driver', 'self-cycle', figure.segments[index('follow')].segment_id);
for (const kind of ['stretch', 'follow', 'connector', 'angleLock']) for (const [name, value] of [['boolean', true], ['array', []]]) add(`${kind}-descriptor-${name}`, paths[kind], value);
// Metadata not read by the rig owner remains intact, including valid boundary values.
for (const [kind, key, name, value] of [
  ['stretch', 'restLength', 'epsilon', 1e-8], ['stretch', 'restLength', 'maximum', 1e6], ['stretch', 'min', 'zero-valid', 0], ['stretch', 'max', 'maximum-valid', 100],
  ['stretch', 'width', 'inverse-valid', 'inverse'], ['stretch', 'width', 'scale-valid', 'scale'], ['stretch', 'branch', 'false-valid', false],
  ['follow', 'influence', 'minimum-valid', -4], ['follow', 'influence', 'maximum-valid', 4], ['follow', 'automatic', 'false-valid', false],
  ['angleLock', 'angle', 'minimum-valid', -1e6], ['angleLock', 'multiplier', 'minimum-valid', -10], ['angleLock', 'space', 'authored-valid', 'authored'],
  ['angleLock', 'secondary', 'null-valid', null], ['connector', 'restLength', 'epsilon', 1e-8],
  ['stretch', 'futureMetadata', 'retained', {name: 'unchanged', values: [1, 2, 3]}], ['connector', 'futureMetadata', 'retained', {name: 'unchanged'}],
]) field(kind, key, name, value);
for (const kind of ['stretch', 'follow', 'connector', 'angleLock']) for (const [name, value] of [['null', null], ['false', false], ['zero', 0]]) add(`${kind}-descriptor-${name}-valid`, paths[kind], value);
for (const [name, value] of [['null', null], ['false', false], ['zero', 0]]) {
  add(`stretch-descriptor-${name}-without-followers-valid`, paths.stretch, value);cases.at(-1).removeFollowers = true;
}
let accepted = 0;
for (const test of cases) {
  const copy = structuredClone(report);let at = copy.figure_types[0];
  if (test.removeFollowers) for (const segment of at.segments) if (segment._stykRig) delete segment._stykRig.follow;
  for (const key of test.path.slice(0, -1)) at = at[key];
  const key = test.path.at(-1);
  if (test.remove) delete at[key];else at[key] = test.value?.specialNumber ? Number(test.value.specialNumber) : structuredClone(test.value);
  try {rigConstraintPlan(copy.figure_types[0]);test.refused = false;} catch (error) {test.refused = true;test.key = error.messageKey ?? null;}
  try {open(copy);test.loadRefused = false;} catch (error) {test.loadRefused = true;test.loadKey = error.messageKey ?? null;}
  if (test.refused !== test.loadRefused || (test.refused && test.key !== test.loadKey)) throw Error(`${test.name}: compiler/load disagree`);
  accepted += !test.refused;
}
writeFileSync(new URL('../crates/styk-eval/tests/fixtures/origin-invalid-rig.json', import.meta.url), JSON.stringify({document, cases}, null, 1) + '\n');
console.log(`${cases.length - accepted} malformed rig refusals and ${accepted} accepted boundary/metadata cases recorded from compiler and Editor.load`);
