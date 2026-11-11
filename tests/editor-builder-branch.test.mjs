import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {createImageFigure} from '../src/media-authoring.mjs';
import {compileTextFigure} from '../src/text-authoring.mjs';
import {parse} from '../vendor/text/opentype.mjs';
import {roundTrip} from './support/codec.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

const near = (a, b, tolerance = .0002) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

test('native Split keeps tiny-bend second angles and uses a single signed-pi wrap for larger bends', () => {
  for (const [angle,bend,expected] of [[.2,.002,.2],[.2,-.002,.2],[3.13,.04,3.15-2*Math.PI],[-3.13,-.04,-3.15+2*Math.PI]]) {
    const report=emptyDocument(),figure=report.figure_types[0];
    figure.segments=[{...figure.segments[0],angle_rad:angle,bend_rad:bend}];figure.segment_count=1;
    report.keyframes=[createFrame([createObject(figure,1,100,100)],1)];
    const editor=ownedEditorFor({demo:false}, report);editor.select(1,0);editor.splitBuilderSegments({branch:false});
    assert.equal(editor.figure.segments[0].angle_rad,angle);near(editor.figure.segments[1].angle_rad,expected,1e-12);
    near(editor.object.angles[1],expected,1e-12);assert.equal(editor.figure.segments[0].bend_rad,bend/2);assert.equal(editor.figure.segments[1].bend_rad,bend/2);
  }
});

test('branch capacity preflight is atomic and deep 15,000-segment splitting reaches native limit without recursion', () => {
  const report = emptyDocument(), figure = report.figure_types[0], base = figure.segments[0];
  figure.segments = Array.from({length:15000},(_,i) => ({...base,segment_id:i+1,parent_id:i,length:.01,bend_rad:0,angle_rad:0}));
  figure.segment_count = 15000; report.keyframes = [createFrame([createObject(figure,1,0,0)],1)];
  const editor = ownedEditorFor({demo:false}, report); editor.select(1,0);
  assert.equal(editor.splitSegmentBranch(),true); assert.equal(editor.figure.segments.length,30000); assert.equal(editor.object.angles.length,30000);
  const history = editor._undo.length, segments = editor.figure.segments;
  assert.throws(() => editor.splitSegmentBranch(), /30,000/); assert.equal(editor._undo.length,history); assert.equal(editor.figure.segments,segments);
  editor.undo(); assert.equal(editor.figure.segments.length,15000); editor.redo(); assert.equal(editor.figure.segments.length,30000);
});

test('native STK and PIV roundtrip retain split image/text references, primitive kinds and gradients', async () => {
  const fontBytes = await readFile(new URL('../vendor/text/NotoSans-Regular.ttf',import.meta.url));
  const font = parse(fontBytes.buffer.slice(fontBytes.byteOffset,fontBytes.byteOffset+fontBytes.byteLength));
  const image = createImageFigure({dataUrl:png,width:1,height:1}), text = compileTextFigure({text:'Ab',fontSize:30},font);
  const figure = {...image,segments:[image.segments[0],{...text.segments[0],segment_id:2,parent_id:1,z_order:2}],text_assets:text.text_assets,segment_count:2};
  figure.segments.forEach(s => {s.secondary={rgb:[230,100,20],a:77};s.transparency=25;});
  const report = emptyDocument(); report.figure_types=[figure]; report.keyframes=[createFrame([createObject(figure,1,100,100)],1)];
  const editor = ownedEditorFor({demo:false}, report); editor.select(1,0);
  const assets = [editor.figure.image_assets[0],editor.figure.text_assets[0]];
  editor.splitBuilderSegments({branch:true}); assert.deepEqual(editor.figure.segments.map(s=>s.primitive_code),[2,2,5,5]);
  assert.equal(editor.figure.image_assets[0],assets[0]); assert.equal(editor.figure.text_assets[0],assets[1]);
  const serialized = editor.serialize(), out = {};
  for (const kind of ['piv','stk']) out[kind] = await roundTrip({document:serialized,format:kind,figureTypeId:1});
  for (const document of Object.values(out)) {
    const saved = document.figure_types.find(f=>f.segments.length===4); assert.ok(saved);
    assert.deepEqual(saved.segments.map(s=>s.primitive_code),[2,2,5,5]);
    assert.equal(saved.image_assets.length,1); assert.equal(saved.text_assets.length,1); assert.equal(saved.text_assets[0].text,'Ab');
    for(const s of saved.segments) {assert.deepEqual(s.secondary,{rgb:[230,100,20],a:77});assert.equal(s.transparency,25);}
  }
});
