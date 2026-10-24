// The existing JavaScript validator is the oracle for malformed retained support.
import './v8-pin.mjs';
import {readFileSync, writeFileSync} from 'node:fs';
import {validateOriginSupport} from '../../src/animation-origin-validation.mjs';
const document = JSON.parse(readFileSync(new URL('../tests/edit/origin-reroot-support-native.document.json', import.meta.url), 'utf8'));
const figure = document.figure_types[0];
validateOriginSupport(figure);
const cases = [], add = (name, path, value, remove = false) => cases.push({name, path, value, ...(remove ? {remove: true} : {})});
for (const [name, value] of [['large', 100001], ['negative', -2], ['fractional', .5], ['string', '0'], ['null', null], ['nan', {specialNumber: 'NaN'}], ['infinite', {specialNumber: 'Infinity'}], ['negative-infinite', {specialNumber: '-Infinity'}]]) {
  add(`vertex-${name}`, ['support', 'vertices', '0'], value);
  add(`parent-${name}`, ['support', 'bones', 0, 'parent'], value);
  add(`rotation-${name}`, ['support', 'rotation'], value);
  add(`path-bone-${name}`, ['support', 'path', 0, 'bone'], value);
}
add('vertex-missing', ['support', 'vertices', '0'], null, true);
add('vertex-invalid-handle', ['support', 'vertices', 'bad'], -1);
add('vertex-noncanonical-handle', ['support', 'vertices', '022'], 6);
add('vertex-duplicate-node', ['support', 'vertices', '0'], 2);
add('vertices-array', ['support', 'vertices'], []);
add('vertices-null', ['support', 'vertices'], null);
add('parent-self', ['support', 'bones', 0, 'parent'], 0);
add('path-negative-one', ['support', 'path', 0, 'bone'], -1);
add('rotation-negative-one', ['support', 'rotation'], -1);
add('parent-missing', ['support', 'bones', 0, 'parent'], null, true);
add('binding-missing', ['support', 'bones', 0, 'handleId'], null, true);
add('binding-negative', ['support', 'bones', 0, 'handleId'], -1);
add('binding-fractional', ['support', 'bones', 0, 'handleId'], 22.5);
add('binding-string', ['support', 'bones', 0, 'handleId'], '22');
add('binding-duplicate', ['support', 'bones', 2, 'handleId'], 44);
add('binding-nan', ['support', 'bones', 0, 'handleId'], {specialNumber: 'NaN'});
add('reversed-string', ['support', 'bones', 0, 'reversed'], 'true');
add('bone-pose-missing', ['support', 'bones', 0, 'angle_rad'], null, true);
add('bone-pose-string', ['support', 'bones', 0, 'angle_rad'], '0');
add('bone-pose-nan', ['support', 'bones', 0, 'angle_rad'], {specialNumber: 'NaN'});
add('bone-length-overflow', ['support', 'bones', 0, 'length'], 1e100);
for (const [name, value] of [['zero', 0], ['large', 2], ['string', '-1'], ['infinite', {specialNumber: 'Infinity'}]]) add(`path-sign-${name}`, ['support', 'path', 0, 'sign'], value);
add('path-record', ['support', 'path'], {});
add('path-null', ['support', 'path'], null);
add('bones-null', ['support', 'bones'], null);
add('bones-empty', ['support', 'bones'], []);
add('bone-null', ['support', 'bones', 0], null);
add('support-boolean', ['support'], true);
add('support-null', ['support'], null);
add('support-version', ['support', 'version'], 2);
add('rotation-handle-mismatch', ['rotationHandleId'], 22);
add('origin-pivot-mismatch', ['handleId'], 33);
add('origin-reversed-string', ['reversed'], 'true');
for (const test of cases) {
  const copy = structuredClone(figure);
  let at = copy._styk.animationOrigin;
  for (const key of test.path.slice(0, -1)) at = at[key];
  const key = test.path.at(-1);
  if (test.remove) delete at[key];
  else at[key] = test.value?.specialNumber ? Number(test.value.specialNumber) : test.value;
  try {validateOriginSupport(copy); test.refused = false;}
  catch {test.refused = true;}
  if (!test.refused) throw new Error(`JavaScript accepted ${test.name}`);
}
writeFileSync(new URL('../crates/styk-eval/tests/fixtures/origin-invalid-support.json', import.meta.url), JSON.stringify({document: 'origin-reroot-support-native.document.json', cases}, null, 1) + '\n');
console.log(`${cases.length} JavaScript malformed-support refusals recorded`);
