import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Editor} from '../src/editor.mjs';
import {decodeDocument} from '../src/native-container.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';

const node = (...args) => execFileSync(process.execPath, args, {cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8'});

test('a skinned glTF converts to a valid spatial figure that turns in depth', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'glb-'));
  const glb = path.join(dir, 'puppet.glb'), styk = path.join(dir, 'puppet.styk');
  node('scripts/make-test-puppet-glb.mjs', glb);
  const summary = JSON.parse(node('scripts/glb-to-styk.mjs', glb, styk, '--height', '240'));
  assert.equal(summary.joints, 17); assert.equal(summary.colors, 4); assert.deepEqual(summary.warnings, []);
  const {document} = await decodeDocument(new Uint8Array(await readFile(styk)), 'styk');
  validateScene(document);
  const mesh = document.figure_types[0]._styk.spatialMesh;
  assert.equal(mesh.bones.length, mesh.positions.length / 3 * 4);
  assert.equal(mesh.groups.length, 14);

  const e = new Editor({demo: false, layerTimeline: false, propertyChannels: false}).load(document);
  const uid = e.report.keyframes[0].objects[0].unique_id;
  const visible = () => buildGeometry(e.report, e.evaluatedFrame).objects.get(e.selectedSlot).spatialMesh.count;
  const rest = visible();
  assert.ok(rest > 0 && rest < mesh.indices.length / 3, 'only front faces are drawn at rest');
  e.select(uid, e.figure.segments.findIndex(s => s.name === 'Hips' && s._stykRig?.spatial?.origin));
  const turn = e.getSpatialPose().turn;
  e.setSpatialPose({turn: turn + 0.7}, {wholeFigure: true});
  assert.ok(visible() > rest, 'a three-quarter view shows side faces too');
});

test('a bone chain added inside a skinned mesh cuts and re-weights that part only', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chain-'));
  const glb = path.join(dir, 'puppet.glb'), styk = path.join(dir, 'puppet.styk'), extra = path.join(dir, 'chains.json');
  node('scripts/make-test-puppet-glb.mjs', glb);
  const {writeFile} = await import('node:fs/promises');
  // Hand.L is a box from y 0.95 down to 0.87 at x 0.22; give it a two-bone "finger".
  await writeFile(extra, JSON.stringify({chains: [{name: 'thumb', parent: 'Wrist.L', bind: 'Wrist.L', seedRadius: 0.1, points: [[0.22, 0.95, 0], [0.22, 0.91, 0], [0.22, 0.87, 0]]}]}));
  const plain = JSON.parse(node('scripts/glb-to-styk.mjs', glb, path.join(dir, 'plain.styk')));
  const summary = JSON.parse(node('scripts/glb-to-styk.mjs', glb, styk, '--extra', extra));
  assert.equal(summary.joints, plain.joints + 2); assert.ok(summary.vertices > plain.vertices && summary.triangles > plain.triangles, 'the part was cut at the joint');
  const {document} = await decodeDocument(new Uint8Array(await readFile(styk)), 'styk');
  validateScene(document);
  const e = new Editor({demo: false, layerTimeline: false, propertyChannels: false}).load(document);
  const uid = e.report.keyframes[0].objects[0].unique_id, evaluate = () => buildGeometry(e.report, e.evaluatedFrame).objects.get(e.selectedSlot).spatialMesh.positions.slice();
  const before = evaluate();
  e.select(uid, e.figure.segments.findIndex(s => s.name === 'thumb.2' && s._stykRig?.spatial?.origin));
  e.setSpatialPose({bend: e.getSpatialPose().bend + 0.8});
  const after = evaluate(); let moved = 0;
  for (let i = 0; i < before.length; i++) if (Math.abs(after[i] - before[i]) > 1e-3) moved++;
  assert.ok(moved > 0 && moved < before.length / 4, 'only the bent finger part moves');
});
