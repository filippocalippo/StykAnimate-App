// The geometry the session sends is a packet of numbers that keeps the sign of a zero; JSON text printed `-0` as `0`, and the interface
// reads it the same way (engine-shown.mjs `fin` and `real`): a `-0` in the geometry would reach the quaternion arithmetic of the 3D
// controls, and from there the numbers the interface sends the session back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditor} from './support/owned-editor.mjs';

const tape = JSON.parse(readFileSync(new URL('../engine/tests/edit/ik-spatial-mirrored-sheet.reference.json', import.meta.url), 'utf8'));

/** The paths of the `-0` the numbers of a group hold (not the document records it refers to, which are the document's). */
function negativeZeros(group, found = [], prefix = `slot ${group.slot}`) {
  const visit = (value, path) => {
    if (typeof value === 'number') { if (Object.is(value, -0)) found.push(path); } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) visit(item, `${path}.${key}`);
  };
  visit(group.root, `${prefix}.root`);
  for (const [id, joint] of group.joints) visit(joint, `${prefix}.joint ${id}`);
  for (const shape of group.segments) {
    for (const key of ['start', 'end', 'points', 'angle', 'bend', 'length', 'thickness', 'z', 'alpha', 'opacity', 'spatialFrame', 'handle']) visit(shape[key], `${prefix}.segment ${shape.index}.${key}`);
  }
  for (const poly of group.polys) for (const key of ['points', 'z', 'alpha', 'opacity', 'depthValues']) visit(poly[key], `${prefix}.poly ${poly.index}.${key}`);
  for (const key of ['solvedAngles', 'solvedLengths', 'bounds']) visit(group[key], `${prefix}.${key}`);
  return found;
}

test('no number of the geometry is -0 on a document with 3D bones', {skip: !engineBuilt}, async () => {
  const {editor} = await ownedEditor({demo: false, ...tape.editor}, JSON.parse(tape.steps[0].document));
  let spatial = 0;
  for (const row of editor.timeline) {
    editor.seek(row.start);
    for (const group of editor.geometry.objects.values()) {
      if (!group) continue;
      spatial += group.segments.filter(shape => shape.spatialFrame).length;
      assert.deepEqual(negativeZeros(group), [], `tick ${row.start}`);
    }
  }
  assert.ok(spatial > 0, 'the document has bones with a 3D frame to read');
});
