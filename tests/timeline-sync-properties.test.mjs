import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit} from '../src/native-property-edit.mjs';
import {isFigurePoseTransform} from '../src/animation-properties.mjs';
import {sceneValuesAt} from '../src/editor-scene.mjs';

function fixture(count=3) {
  const report=emptyDocument();report.keyframes=Array.from({length:count},(_,i)=>createFrame([createObject(report.figure_types[0],1,100+i*50,200)],5));
  const e=new Editor({demo:false,propertyChannels:true}).load(report);e.select(1);return e;
}
function numeric(e,key,value,options) {const token=beginNativePropertyEdit(e,key,options);previewNativePropertyEdit(token,value);commitNativePropertyEdit(token);}
const assertNoTransformTracks=e=>assert.ok(!e.animationChannels.some(channel=>isFigurePoseTransform(channel.target,channel.property)));
const sample=e=>Array.from({length:e.totalTicks},(_,tick)=>{e.seek(tick);return structuredClone(e.evaluatedFrame.objects.map(({unique_id,root_x,root_y,scale,angles,lengths,bends,field28,color_override_raw,_stykStyle,join})=>({unique_id,root_x,root_y,scale,angles,lengths,bends,field28,color_override_raw,_stykStyle,join})));});

for(const mode of ['advanced','simple'])test(`${mode}: position and rotation use Pose, scale stays independent, and switching preserves every tick`,()=>{
  const e=fixture();e.selectFrame(1);e.select(1);if(mode==='simple')e.enableFrameDrafts({mode:'update'});
  numeric(e,'root_x',420);numeric(e,'root_y',310);numeric(e,'rotation',45);numeric(e,'scale',125);
  assertNoTransformTracks(e);assert.ok(e.animationChannels.some(channel=>channel.property==='pose'));
  assert.ok(e.animationChannel({kind:'figure',uid:1},'scale'));
  assert.equal(e.evaluatedFrame.objects[0].root_x,420);assert.equal(e.evaluatedFrame.objects[0].root_y,310);
  assert.ok(Math.abs(e.animationValue({kind:'figure',uid:1},'rotation')-Math.PI/4)<1e-8);
  if(mode==='simple'){e.updateDraftFrame();e.disableFrameDrafts();}
  const before=sample(e),channels=structuredClone(e.animationChannels),count=e.report.keyframes.length;
  for(let i=0;i<4;i++){e.enableFrameDrafts();e.disableFrameDrafts();}
  assert.deepEqual(sample(e),before);assert.deepEqual(e.animationChannels,channels);assert.equal(e.report.keyframes.length,count);
  const reopened=new Editor({demo:false,propertyChannels:true}).load(e.serialize());assert.deepEqual(sample(reopened),before);
});

test('absolute position ranges author Pose keys despite independent appearance channels',()=>{
  const e=fixture();e.updateFigureStyle({outlineWidth:8});
  numeric(e,'root_x',420,{indices:[0,2]});assertNoTransformTracks(e);
  e.seek(0);assert.equal(e.evaluatedFrame.objects[0].root_x,420);e.seek(10);assert.equal(e.evaluatedFrame.objects[0].root_x,420);
  e.undo();e.seek(0);assert.equal(e.evaluatedFrame.objects[0].root_x,100);
});

test('posing one figure does not create property channels for other figures in a dense layer',()=>{
  const report=emptyDocument(),figure=report.figure_types[0];
  report.keyframes=Array.from({length:100},()=>createFrame(Array.from({length:100},(_,i)=>createObject(figure,i+1,i*10,200)),2));
  const e=new Editor({demo:false,propertyChannels:true}).load(report);e.selectFrame(50);e.select(1);numeric(e,'root_y',310);
  assert.ok(e.animationChannels.every(channel=>channel.target.kind==='figure'&&channel.target.uid===1));
  assert.ok(e.animationChannels.length<=8);assertNoTransformTracks(e);
  const y=()=>e.evaluatedFrame.objects.find(object=>object.unique_id===1).root_y;
  e.selectFrame(0);assert.equal(y(),200);
  e.selectFrame(50);assert.equal(y(),310);
  e.selectFrame(51);assert.equal(y(),200);
  e.undo();assert.equal(e.animationChannels.length,0);e.redo();assert.ok(e.animationChannels.length<=8);
});

test('Simple Add interpolates scene colors and scale instead of manufacturing hold intervals',()=>{
  const e=fixture(1);e.setSceneColor(0xffff0000);numeric(e,'scale',100);
  e.enableFrameDrafts({mode:'add'});e.setSceneColor(0xff0000ff);numeric(e,'scale',200);e.addDraftFrame();e.disableFrameDrafts();
  assert.equal(e.report.keyframes.length,2);e.seek(2);
  assert.equal(e.evaluatedFrame._stykBackgroundColor,0xff990066);assert.equal(sceneValuesAt(e)._stykBackgroundColor,0xff990066);
  assert.ok(Math.abs(e.evaluatedFrame.objects[0].scale-1.4)<1e-8);assertNoTransformTracks(e);
  const colors=e.animationChannel({kind:'scene'},'color');assert.equal(colors.keys[0].interpolation,'linear');
  e.setAnimationKey(colors.id,colors.keys[0].id,{interpolation:'hold'});e.setSceneColor(0xffffff00,{indices:[1]});e.seek(2);
  assert.equal(e.evaluatedFrame._stykBackgroundColor,0xffff0000,'An explicitly selected Constant easing remains Constant');
});

test('scene color authoring ignores native Pose hold easing and repairs passthrough keys',()=>{
  const e=fixture();e.report.keyframes.forEach(frame=>{frame._styk.easing={interpolation:'hold'};});e._invalidate();
  e.setSceneColor(0xffff0000);e.selectFrame(1);e.setSceneColor(0xff0000ff);e.seek(2);
  assert.equal(e.evaluatedFrame._stykBackgroundColor,0xff990066);
  const channel=e.animationChannel({kind:'scene'},'color');channel.keys[1].passthrough=true;e._invalidate();
  e.selectFrame(1);e.setSceneColor(0xff00ff00);e.seek(2);
  assert.equal(e.evaluatedFrame._stykBackgroundColor,0xff996600);
});

for(const mode of ['advanced','simple'])test(`${mode}: the default white scene interpolates to the first authored color`,()=>{
  const e=fixture(mode==='simple'?1:2);
  if(mode==='simple')e.enableFrameDrafts({mode:'add'});else e.selectFrame(1);
  e.setSceneColor(0xff0000ff);
  if(mode==='simple'){e.addDraftFrame();e.disableFrameDrafts();}
  e.seek(2);assert.equal(e.evaluatedFrame._stykBackgroundColor,0xff9999ff);
});

test('retiming Pose leaves native scale and appearance on their original clock without expanding scalar tracks',()=>{
  const report=emptyDocument();
  report.keyframes=[1,2,3].map((scale,i)=>{
    const object=createObject(report.figure_types[0],1,100+i*50,200);
    Object.assign(object,{scale,field28:i*80,color_override_raw:[0xffff0000,0xff00ff00,0xff0000ff][i]});
    return createFrame([object],5);
  });
  const e=new Editor({demo:false,propertyChannels:true}).load(report);e.select(1);
  const appearance=()=>Array.from({length:11},(_,tick)=>{e.seek(tick);const o=e.evaluatedFrame.objects[0];return [o.scale,o.field28,o.color_override_raw];});
  const baseline=appearance();e.selectFrame(1);numeric(e,'root_x',400);
  const pose=e.animationChannel({kind:'figure',uid:1},'pose');
  assert.equal(e.animationChannels.length,1);assert.equal(pose.nativeProperties,true);
  e.setAnimationKey(pose.id,pose.keys.find(key=>key.tick===5).id,{tick:7});
  assert.deepEqual(appearance(),baseline);
  const nativeScale=e.nativePropertyChannel({kind:'figure',uid:1},'scale');
  assert.deepEqual(nativeScale.keys.map(key=>key.tick),[0,5,10]);
  const reopened=new Editor({demo:false,propertyChannels:true}).load(e.serialize());
  for(let tick=0;tick<11;tick++){reopened.seek(tick);assert.equal(reopened.evaluatedFrame.objects[0].scale,baseline[tick][0]);}
});
