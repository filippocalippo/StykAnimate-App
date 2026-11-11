import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {geometryOfFrame} from './support/engine-geometry.mjs';
import {ownedScope} from './support/owned-scope.mjs';

const open = ownedScope();

function fixture(){
  const report=emptyDocument(),figure=report.figure_types[0];
  report.keyframes=[0,1,2].map(index=>{
    const object=createObject(figure,1,170+index*35,210-index*15);
    object.angles=object.angles.map((angle,i)=>angle+index*.12*(i%2?1:-1));
    return createFrame([object,createObject(figure,2,430,260)],4);
  });
  const editor=open({demo:false}, report);editor.select(1);editor.setOrigin(4);return editor;
}
/** Where the engine puts every joint at keyframe `index`: as it evaluates the frame on show there, or (`evaluated: false`) as the stored keyframe stands. */
function points(editor,index,{evaluated=true}={}){
  let geometry;
  if(evaluated){editor.seek(editor.timeline[index].start);geometry=editor.geometry;}
  else geometry=geometryOfFrame(editor,editor.report.keyframes[index]);
  return [...geometry.objects.values()].flatMap(object=>[...object.joints].map(([id,p])=>[object.obj.unique_id,id,p.x,p.y]));
}
function close(actual,expected){assert.equal(actual.length,expected.length);for(let i=0;i<actual.length;i++){
  assert.deepEqual(actual[i].slice(0,2),expected[i].slice(0,2));
  // Native source roots are float32; virtual-pivot correction retains double
  // precision. Compare within one source-coordinate rounding unit.
  for(const j of [2,3])assert.ok(Math.abs(actual[i][j]-expected[i][j])<1e-4,`${actual[i]} != ${expected[i]}`);
}}
for(const [name,apply]of [
  ['rotation',editor=>editor.rotateFiguresInFrames(.3,[0,2])],
  ['scale',editor=>editor.scaleFiguresInFrames(1.6,[0,2])],
  ['vertical mirror',editor=>editor.mirrorFiguresInFrames('vertical',[0,2])],
  ['center',editor=>editor.centerFiguresInFrames([0,2])],
  ['default pose',editor=>editor.resetPoseInFrames([0,2])],
])test(`rerooted ${name} range keeps edited physical poses through evaluation and undo`,()=>{
  const editor=fixture(),before=editor.serialize(),middle=editor.report.keyframes[1],history=editor._undo.length;
  apply(editor);assert.equal(editor._undo.length,history+1);assert.equal(editor.report.keyframes[1],middle);
  for(const index of [0,2])close(points(editor,index),points(editor,index,{evaluated:false}));
  const after=editor.serialize();editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();assert.deepEqual(editor.serialize(),after);
});
