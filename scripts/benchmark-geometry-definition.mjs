/** Isolated CPU comparison against a captured source tree; never saves the PIV. */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {buildGeometry, evaluatedFrame} from '../src/pivot/geometry.mjs';
const {startBackend} = createRequire(import.meta.url)('../desktop/backend.cjs');
const referenceRoot = process.argv[2];
if (!referenceRoot) throw new Error('Provide the captured src directory to compare.');
const reference = await import(pathToFileURL(path.resolve(referenceRoot, 'pivot/geometry.mjs')));
const source = process.argv[3] || path.join(os.homedir(), 'Desktop', 'testreallydense.piv');
const output = path.resolve('artifacts', `geometry-definition-${Date.now()}`);
await mkdir(output, {recursive: true});
const bytes = await readFile(source), hash = data => createHash('sha256').update(data).digest('hex');
const backend = await startBackend({appRoot: process.cwd()}); let report;
try {
  const response = await fetch(`${backend.origin}/api/import?filename=${encodeURIComponent(path.basename(source))}`,
    {method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: bytes});
  if (!response.ok) throw new Error(await response.text());
  report = (await response.json()).document;
} finally {backend.stop();}
const result = {source: {path: source, sha256: hash(bytes)}, referenceRoot, cpu: os.cpus()[0].model, node: process.version, cases: []};
// Hash complete per-instance geometry outside the timed region; retain segment,
// polygon, asset, style and native coordinates, not merely the displayed bounds.
const fingerprint = geometry => {
  const digest = createHash('sha256');
  const referenceFields = (key, value) => key === 'obj' ? {uid: value.unique_id} : key === 'fig' ? {id: value.figure_type_id} : value instanceof Map ? [...value] : value;
  for (const [slot, g] of geometry.objects) digest.update(JSON.stringify([slot, g], referenceFields));
  digest.update(JSON.stringify([geometry.orderedObjects.map(g => g.slot), geometry.warnings]));
  return digest.digest('hex');
};
const stats = values => {
  const sorted = [...values].sort((a,b) => a-b);
  return {values, median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2, min: sorted[0], max: sorted.at(-1)};
};
for (const multiplier of [1, 5]) {
  const r = structuredClone(report), stride = Math.max(...r.keyframes.flatMap(f => f.objects.map(o => o.unique_id))) + 1;
  for (const frame of r.keyframes) {
    const original = [...frame.objects], count = original.length, order = frame.object_draw_order || original.map((_,i) => i);
    for (let copy = 1; copy < multiplier; copy++) for (const value of original) {
      const object = structuredClone(value); object.unique_id += copy * stride; object.object_slot = frame.objects.length;
      object.root_x += 2 * copy; object.root_y += 2 * copy;
      if (object.join) {object.join.target_object_slot += copy * count; if (object.join.target_unique_id != null) object.join.target_unique_id += copy * stride;}
      frame.objects.push(object);
    }
    frame.object_draw_order = Array.from({length: multiplier}, (_,i) => order.map(slot => slot + i * count)).flat();
    frame.object_draw_order_unique_ids = frame.object_draw_order.map(slot => frame.objects[slot].unique_id);
  }
  for (const [name, frame] of [['key', r.keyframes[0]], ['tween', evaluatedFrame(r, 0, .375)]]) {
    const expected = fingerprint(reference.buildGeometry(r, frame)), actual = fingerprint(buildGeometry(r, frame));
    assert.equal(actual, expected, `${multiplier}x ${name} exact output`);
    const before = [], after = [];
    for (let trial = 0; trial < 8; trial++) {
      const variants = trial % 2 ? [[buildGeometry, after], [reference.buildGeometry, before]] : [[reference.buildGeometry, before], [buildGeometry, after]];
      for (const [build, samples] of variants) {
        globalThis.gc?.(); const start = performance.now(); const geometry = build(r, frame); samples.push(performance.now() - start);
        assert.equal(geometry.objects.size, frame.objects.length);
      }
    }
    const row = {multiplier, name, figures: frame.objects.length, fingerprint: actual, before: stats(before), after: stats(after)};
    result.cases.push(row); console.log(JSON.stringify(row));
  }
}
result.sourceUnchanged = hash(await readFile(source)) === result.source.sha256;
await writeFile(path.join(output, 'report.json'), JSON.stringify(result, null, 2));
console.log('REPORT', output);
