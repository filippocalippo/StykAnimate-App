import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {createFigureHandleTransform, figureHandleTransform, editorFigureTransformMethods} from '../src/editor-figure-transform.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
Object.assign(Editor.prototype, editorFigureTransformMethods);
const near = (a,b) => assert.ok(Math.abs(a-b)<2e-4, `${a} != ${b}`);
const pointNear = (a,b) => { near(a.x,b.x); near(a.y,b.y); };
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [createFrame([
    createObject(figure,1,100,200),
    createObject(figure,2,100,122,{join:{target_object_slot:0,target_handle_id:1}}),
    createObject(figure,3,100,44,{join:{target_object_slot:1,target_handle_id:1}}),
    createObject(figure,4,100,122,{join:{target_object_slot:0,target_handle_id:1}}),
  ]),createFrame([createObject(figure,1,300,200)])];
  const editor = new Editor({demo:false}).load(report); editor.select(2,0); return editor;
}

test('Alt transforms only the picked figure subtree about its own origin, preserving parent and siblings', () => {
  const editor=fixture(), initial=editor.geometry, before=structuredClone(editor.report), origin=initial.objects.get(1).root;
  const start=initial.objects.get(1).segments[0].end;
  editor.beginFigureHandleDrag(start.x,start.y); editor.transformFigureHandle(origin.x+156,origin.y);
  const after=editor.geometry;
  for(const slot of [0,3]) for(const [id,point] of initial.objects.get(slot).joints) pointNear(after.objects.get(slot).joints.get(id),point);
  pointNear(after.objects.get(1).root,origin);
  for(const slot of [1,2]) for(const [id,point] of initial.objects.get(slot).joints)
    pointNear(after.objects.get(slot).joints.get(id),{x:origin.x-2*(point.y-origin.y),y:origin.y+2*(point.x-origin.x)});
  editor.commitFigureHandleDrag(); assert.equal(editor._undo.length,1);
  assert.deepEqual(editor.report.figure_types,before.figure_types); assert.deepEqual(editor.report.keyframes[1],before.keyframes[1]);
  editor.undo(); assert.deepEqual(editor.report.keyframes,before.keyframes); editor.redo(); near(editor.object.scale,2);
});

test('Ctrl keeps scale fixed and Shift keeps rotation fixed, matching the native modifier combinations', () => {
  for(const options of [{ctrlKey:true},{shiftKey:true},{rotate:false},{scale:false}]) {
    const editor=fixture(), initial=editor.geometry.objects.get(1), before=editor.object.angles.slice(), origin=initial.root;
    editor.beginFigureHandleDrag(initial.segments[0].end.x,initial.segments[0].end.y);
    editor.transformFigureHandle(origin.x+156,origin.y,options); editor.commitFigureHandleDrag();
    const rotates=!options.shiftKey&&options.rotate!==false, scales=!options.ctrlKey&&options.scale!==false;
    near(editor.object.scale,scales?2:1);
    editor.object.angles.forEach((angle,index)=>near(angle-before[index],rotates?Math.PI/2:0));
  }
});

test('drag math crosses the angle seam continuously and never compounds scale across pointer events', () => {
  const state=createFigureHandleTransform({x:0,y:0},{x:10,y:0});
  let result;
  for(let step=1;step<=720;step++) {
    const angle=step*Math.PI/180; result=figureHandleTransform(state,{x:20*Math.cos(angle),y:20*Math.sin(angle)});
    near(result.radians,angle); near(result.factor,2);
  }
  near(result.radians,4*Math.PI);
});

test('cancel and pointer return are exact; collapsed transforms can recover using the original reference', () => {
  const editor=fixture(), before=structuredClone(editor.report), initial=editor.geometry.objects.get(1), point=initial.segments[0].end;
  editor.beginFigureHandleDrag(point.x,point.y); editor.transformFigureHandle(initial.root.x,initial.root.y);
  near(editor.object.scale,0); editor.transformFigureHandle(point.x,point.y); assert.equal(editor.commitFigureHandleDrag(),false);
  assert.deepEqual(editor.report,before); assert.equal(editor.dirty,false);
  editor.beginFigureHandleDrag(point.x,point.y); editor.transformFigureHandle(point.x+30,point.y-10); editor.cancelFigureHandleDrag();
  assert.deepEqual(editor.report,before); assert.equal(editor.dirty,false);
});

test('authored transform adds one pose key without mutating imported frames', () => {
  const editor=fixture(); editor.adoptNativePoseTrack({kind:'layer',id:'layer-1'}); editor.seek(0); editor.select(2,0);
  const frames=structuredClone(editor.report.keyframes), history=editor._undo.length, initial=editor.geometry.objects.get(1);
  editor.beginFigureHandleDrag(initial.segments[0].end.x,initial.segments[0].end.y);
  editor.transformFigureHandle(initial.root.x+156,initial.root.y); editor.commitFigureHandleDrag();
  assert.deepEqual(editor.report.keyframes,frames); near(editor.object.scale,2); assert.equal(editor._undo.length,history+1);
  editor.undo(); near(editor.object.scale,1); editor.redo(); near(editor.object.scale,2);
});

test('invalid and origin-coincident starts leave the document and history untouched', () => {
  const editor=fixture(), before=structuredClone(editor.report), origin=editor.geometry.objects.get(1).root;
  assert.throws(()=>editor.beginFigureHandleDrag(origin.x,origin.y),/away from/);
  assert.throws(()=>editor.beginFigureHandleDrag(NaN,0),/finite/);
  assert.deepEqual(editor.report,before); assert.equal(editor._drag,null); assert.equal(editor._undo.length,0);
});
