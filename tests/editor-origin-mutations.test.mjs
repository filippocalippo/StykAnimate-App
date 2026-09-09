import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {buildGeometry,evaluatedFrame} from '../src/pivot/geometry.mjs';
import {cameraMatrix} from '../src/renderer-geometry.mjs';

function fixture(){
  const report=emptyDocument(),figure=report.figure_types[0];
  report.keyframes=[0,1,2].map(index=>{
    const object=createObject(figure,1,170+index*35,210-index*15);
    object.angles=object.angles.map((angle,i)=>angle+index*.12*(i%2?1:-1));
    return createFrame([object,createObject(figure,2,430,260)],4);
  });
  const editor=new Editor({demo:false}).load(report);editor.select(1);editor.setOrigin(4);return editor;
}
function points(editor,index,{evaluated=true,projected=false}={}){
  const raw=editor.report.keyframes[index],frame=evaluated?evaluatedFrame(editor.report,index,0,editor.timeline[index].start):raw;
  const matrix=projected?cameraMatrix({report:editor.report,frame}):[1,0,0,1,0,0];
  return [...buildGeometry(editor.report,frame).objects.values()].flatMap(object=>[...object.joints].map(([id,p])=>
    [object.obj.unique_id,id,matrix[0]*p.x+matrix[2]*p.y+matrix[4],matrix[1]*p.x+matrix[3]*p.y+matrix[5]]));
}
function close(actual,expected){assert.equal(actual.length,expected.length);for(let i=0;i<actual.length;i++){
  assert.deepEqual(actual[i].slice(0,2),expected[i].slice(0,2));
  // Native source roots are float32; virtual-pivot correction retains double
  // precision. Compare within one source-coordinate rounding unit.
  for(const j of [2,3])assert.ok(Math.abs(actual[i][j]-expected[i][j])<1e-4,`${actual[i]} != ${expected[i]}`);
}}
test('unchanged and style-only pivot synchronization preserves shared metadata references',()=>{
  const editor=fixture(),frame=editor.frame,object=frame.objects[0],origin=object._stykAnimationOrigin;
  editor._synchronizeAnimationOrigins(frame,frame.objects);
  assert.equal(object._stykAnimationOrigin,origin);
  const before=structuredClone(object),styled={...object,field28:93};
  editor._synchronizeAnimationOrigins({...frame,objects:[styled]},[before]);
  assert.equal(styled._stykAnimationOrigin,origin);
});
for(const [name,apply]of [
  ['relative translation',editor=>editor.moveSelectionInFrames(23,-17,[0,2])],
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
test('native camera baking preserves rerooted projected joints and leaves other keys unchanged',()=>{
  const editor=fixture();
  for(const index of [0,2])editor.report.keyframes[index].camera={is_default:false,x:40-index*30,y:15+index*20,scale:.8+index*.4,angle_rad:.4-index*.15};
  editor._invalidate();const before=editor.serialize(),middle=editor.report.keyframes[1],middleBefore=structuredClone(middle),history=editor._undo.length,expected=[0,2].map(index=>points(editor,index,{projected:true}));
  assert.equal(editor.applyCameraToFigures([0,2]),2);assert.equal(editor._undo.length,history+1);
  for(const [i,index]of [0,2].entries())close(points(editor,index,{projected:true}),expected[i]);
  assert.equal(editor.report.keyframes[1],middle);assert.deepEqual(middle,middleBefore);
  const after=editor.serialize();editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();assert.deepEqual(editor.serialize(),after);
});
