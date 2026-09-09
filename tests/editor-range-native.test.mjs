import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import backend from '../desktop/backend.cjs';
import {Editor} from '../src/editor.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {frameOrder} from '../src/pivot/structure.mjs';

test('range join, mirror, scale, appearance and order preserve native PIV geometry over three frames', () => {
  const editor = new Editor({demo: false}); editor.addFigure(); const parent = editor.selectedUid;
  const child = editor.duplicateFigure().unique_id; editor.joinTo(parent, 4);
  const leaf = editor.duplicateFigure().unique_id; editor.joinTo(child, 2);
  editor.duplicateFrame(); editor.duplicateFrame();
  editor.select(parent); editor.moveSelectionInFrames(30, -12, [1, 2]);
  editor.selectMany([parent, child]); editor.mirrorFiguresInFrames('vertical', [0, 2]);
  editor.scaleFiguresInFrames(1.4, [0, 1, 2]);
  editor.updateFiguresInFrames({color_override_raw: 0xff8844cc, opacity: 0.7}, [0, 2]);
  editor.orderFiguresInFrames('front', [0, 2]);
  editor.select(leaf); editor.detachFiguresInFrames([1]); editor.joinFiguresInFrames(parent, 1, [1]);
  editor.selectMany([parent, child]); editor.duplicateInFrames([0, 2], {offset: 18});
  const output = editor.serialize(), expected = output.keyframes.map(frame => buildGeometry(output, frame));
  const script = String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
store=server.ProjectStore(server.WORKSPACE)
data,name=store.export({'document':json.load(sys.stdin),'format':'piv'})
print(json.dumps(store.import_bytes(data,name)['document']))
`;
  const python = backend.pythonCandidates()[0], result = spawnSync(python.command, [...python.args, '-c', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify(output), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024});
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const imported = JSON.parse(result.stdout), near = (a, b) => assert.ok(Math.abs(a - b) < .001, `${a} != ${b}`);
  assert.equal(imported.keyframes.length, 3);
  for (let i = 0; i < 3; i++) {
    const frame = imported.keyframes[i], geometry = buildGeometry(imported, frame), byUid = new Map([...geometry.objects.values()].map(g => [g.obj.unique_id, g]));
    assert.deepEqual(frameOrder(frame), frameOrder(output.keyframes[i]));
    for (const original of expected[i].objects.values()) {
      const saved = byUid.get(original.obj.unique_id); assert.ok(saved);
      assert.equal(saved.obj.field28, original.obj.field28); assert.equal(saved.obj.color_override_raw, original.obj.color_override_raw);
      near(saved.root.x, original.root.x); near(saved.root.y, original.root.y);
      original.segments.forEach((segment, index) => {
        near(saved.segments[index].end.x, segment.end.x); near(saved.segments[index].end.y, segment.end.y);
      });
    }
  }
});
