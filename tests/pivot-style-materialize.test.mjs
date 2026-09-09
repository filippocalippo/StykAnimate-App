import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {evaluatedFrame, timeline, buildGeometry} from '../src/pivot/geometry.mjs';
import {materializePivotDocument, needsPivotMaterialization} from '../src/pivot-export-materialize.mjs';
import {createNativeStyleTable, materializeStyledFigureForStk} from '../src/pivot-style-materialize.mjs';
import backend from '../desktop/backend.cjs';

function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  figure.segment_decode = {global_style: {u28: 1073741824, outline_thickness: 2, rgb: [30, 40, 50], u30: 0}};
  figure.segments[0].secondary = {rgb: [255, 0, 120], a: 0};
  report.keyframes = [0, 1].map(index => createFrame([createObject(figure, 1, 150 + index * 30, 200), createObject(figure, 2, 350, 200)], index ? 1 : 4));
  return new Editor({demo: false}).load(report);
}
function sample(report, tick) {
  const rows = timeline(report); let index = 0;
  while (index + 1 < rows.length && rows[index + 1].start <= tick) index++;
  return evaluatedFrame(report, index, rows[index].count ? (tick - rows[index].start) / rows[index].count : 0, tick);
}
const style = geometry => {const figure = geometry.fig; return {outline: figure.segment_decode.global_style.u30, primary: figure.segments[0].transparency, secondary: figure.segments[0].secondary.a};};
function nativeRoundtrip(report, kind = 'piv', figureTypeId) {
  const python = String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
request=json.load(sys.stdin); store=server.ProjectStore(server.WORKSPACE)
raw,name=store.export(request)
print(json.dumps(store.import_bytes(raw,name)['document']))
`;
  const candidate = backend.pythonCandidates()[0], result = spawnSync(candidate.command, [...candidate.args, '-c', python], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify({document: report, format: kind, figureTypeId}), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024});
  assert.equal(result.status, 0, result.error?.message || result.stderr); return JSON.parse(result.stdout);
}
test('native style variants deduplicate effective alpha bytes while sharing media and base geometry', () => {
  const report = fixture().report, base = report.figure_types[0], assets = base.image_assets, materialize = createNativeStyleTable(report);
  const a = materialize({figure_type_id: 1, _stykStyle: {outlineOpacity: .5, segments: {1: {opacity: .5, gradientOpacity: .4}}}});
  const b = materialize({figure_type_id: 1, _stykStyle: {outlineOpacity: .5001, segments: {1: {opacity: .5001, gradientOpacity: .4001}}}});
  // Values on opposite sides of a rounding boundary produce different native bytes.
  assert.notEqual(a, b);
  const c = materialize({figure_type_id: 1, _stykStyle: {outlineOpacity: .5002, segments: {1: {opacity: .5002, gradientOpacity: .4002}}}});
  assert.equal(b, c); assert.equal(report.figure_types.length, 3);
  assert.equal(report.figure_types[1].image_assets, assets); assert.equal(report.figure_types[1].segments[1], base.segments[1]);
  assert.equal(base.segments[0].transparency, 0); assert.equal(base.segment_decode.global_style.u30, 0);
  assert.equal(materialize({figure_type_id: 1, _stykStyle: {outlineOpacity: 1, segments: {1: {opacity: 1, gradientOpacity: 1}}}}), 1);
});
test('alpha-only native segments keyed to opaque receive a real native variant', () => {
  const report = fixture().report, segment = report.figure_types[0].segments[0]; delete segment.transparency; segment.color_alpha = .2;
  const id = createNativeStyleTable(report)({figure_type_id: 1, _stykStyle: {segments: {1: {opacity: 1}}}});
  assert.notEqual(id, 1); const variant = report.figure_types.find(figure => figure.figure_type_id === id);
  assert.equal(variant.segments[0].transparency, 0); assert.equal(variant.segments[0].color_alpha, 1);
});
test('independent outline, primary and gradient endpoint opacity bake into real PIV figure types', () => {
  const editor = fixture(); editor.addAnimationKeys([
    ...[0, 4].flatMap(tick => [
      {target: {kind: 'figure', uid: 1}, property: 'outlineOpacity', tick, value: tick ? .7 : .3},
      {target: {kind: 'segment', uid: 1, handleId: 1}, property: 'opacity', tick, value: tick ? .8 : .2},
      {target: {kind: 'segment', uid: 1, handleId: 1}, property: 'gradientOpacity', tick, value: tick ? .6 : .4},
    ]),
  ]);
  const report = editor.report, before = structuredClone(report), output = materializePivotDocument(report), native = nativeRoundtrip(output);
  assert.equal(output.keyframes.length, 5); assert.ok(output.keyframes.every(frame => frame.duration_raw === 1));
  assert.deepEqual(report, before); assert.ok(output.keyframes.every(frame => frame.objects.every(object => !object._stykStyle)));
  assert.ok(output.figure_types.length <= 6); assert.equal(output._styk.animation, undefined);
  for (let tick = 0; tick < 5; tick++) {
    const expected = buildGeometry(report, sample(report, tick)), actual = buildGeometry(native, sample(native, tick));
    for (const slot of [0, 1]) assert.deepEqual(style(actual.objects.get(slot)), style(expected.objects.get(slot)));
    assert.equal(style(actual.objects.get(1)).primary, 0);
  }
  assert.equal(needsPivotMaterialization(native), false);
});
test('captured native style overrides remain exportable after their channels are removed', () => {
  const editor = fixture(), report = editor.report;
  report.keyframes[0].objects[0]._stykStyle = {outlineOpacity: .4, segments: {1: {opacity: .6}}};
  assert.equal(editor.animationChannels.length, 0); assert.equal(needsPivotMaterialization(report), true);
  const output = materializePivotDocument(report), native = nativeRoundtrip(output);
  assert.equal(output.keyframes.length, 5); assert.equal(native.keyframes.length, 5);
  assert.equal(style(buildGeometry(native, native.keyframes[0]).objects.get(0)).primary, 102);
  assert.equal(style(buildGeometry(native, native.keyframes[4]).objects.get(0)).primary, 0);
});
test('STK resolves the selected instance and authored tick without changing its shared base', () => {
  const editor = fixture(); editor.addAnimationKeys([
    {target: {kind: 'segment', uid: 1, handleId: 1}, property: 'opacity', tick: 0, value: 1},
    {target: {kind: 'segment', uid: 1, handleId: 1}, property: 'opacity', tick: 4, value: .2},
  ]);
  const report = editor.report, before = structuredClone(report), result = materializeStyledFigureForStk(report, {figureTypeId: 1, figureUid: 1, tick: 4});
  assert.notEqual(result.figureTypeId, 1); assert.deepEqual(report, before);
  const native = nativeRoundtrip(result.report, 'stk', result.figureTypeId), saved = native.figure_types.find(figure => figure.segments[0]?.transparency === 204);
  assert.equal(saved.segments[0].transparency, 204); assert.equal(report.figure_types[0].segments[0].transparency, 0);
  assert.equal(materializeStyledFigureForStk(report, {figureTypeId: 1, figureUid: 2, tick: 4}).figureTypeId, 1);
});
