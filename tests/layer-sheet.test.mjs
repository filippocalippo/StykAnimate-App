import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {engineEditor} from './support/owned-editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {validateLayerSheet} from '../src/layer-sheet.mjs';
import {createLayerState} from '../src/layers.mjs';
import {animationChannelId, normalizeAnimationTarget, validateAnimationDocument} from '../src/animation-channels.mjs';
import {keyEasing} from '../src/keyframe-easing.mjs';
import {isDiscreteAnimationProperty} from '../src/animation-properties.mjs';

/** The curve a new key of a property takes: the nearest earlier key's, or Hold. */
const inheritedEasing=(keys,property)=>isDiscreteAnimationProperty(property)||!keys.length?keyEasing({interpolation:'hold'}):keyEasing({...keys.at(-1),interpolation:keys.at(-1).interpolation??'linear'});

function frames(){
  const report=emptyDocument(),figure=report.figure_types[0];
  report.keyframes=[0,10,20].map(x=>createFrame([createObject(figure,1,x,200),createObject(figure,2,100+x,200)],10));
  return report;
}
function fixture(){
  const e=engineEditor({demo:false,propertyChannels:true,layerTimeline:true}, frames());
  const layer=e.createLayer('Effects');e.assignFiguresToLayer([2],layer.id);return e;
}
/** A document from a file of the native timeline: the same frames with the figure 2 on a second layer, and the property channels it
 * authors (`channels`: {target, property, keys: [{tick, value, ...easing}]}). */
function legacyDocument(channels=[]){
  const report=frames(),layers=report._styk.layers=createLayerState();
  layers.byId['layer-2']={name:'Effects',visible:true,locked:false};layers.order.push('layer-2');layers.nextId=3;layers.assignments['2']='layer-2';layers.activeId='layer-2';
  if(channels.length){
    let nextKeyId=1;
    report._styk.animation={version:1,nextKeyId:1,channels:channels.map(({target,property,keys})=>{
      const normalized=normalizeAnimationTarget(target),stored=[];
      for(const {tick,value,...easing} of keys)stored.push({id:`key-${nextKeyId++}`,tick,value,...inheritedEasing(stored,property),...easing});
      return {id:animationChannelId(normalized,property),target:normalized,property,keys:stored};
    })};
    report._styk.animation.nextKeyId=nextKeyId;validateAnimationDocument(report);
  }
  return report;
}
/** The document as the native timeline evaluates it, read from the session. */
const legacyEditor=document=>engineEditor({demo:false,propertyChannels:true,layerTimeline:false}, document);
function sample(e,tick){e.seek(tick,{allowBeyondEnd:true});return e.evaluatedFrame.objects.map(o=>({uid:o.unique_id,x:o.root_x}));}
test('native import uses exact original evaluation and holds object identities',()=>{
  const old=legacyEditor(legacyDocument()),e=engineEditor({demo:false,layerTimeline:true}, old.serialize());
  for(let i=0;i<=20;i++)assert.deepEqual(sample(e,i),sample(old,i));
  assert.equal(e.report._styk.animation,undefined);assert.equal(e.report._styk.layerSheet.duration,21);
});
test('existing independent property animation remains exact on import',()=>{
  const old=legacyEditor(legacyDocument([{target:{kind:'figure',uid:1},property:'x',keys:[{tick:0,value:0,interpolation:'bezier',bezier:[.2,.1,.8,.9]},{tick:20,value:200}]}]));
  const e=engineEditor({demo:false,layerTimeline:true}, old.serialize());for(let i=0;i<20;i++)assert.deepEqual(sample(e,i),sample(old,i));
});
test('key insertion and retiming affect only the selected layer',()=>{
  const e=fixture(),before=e.serialize();e.sheetInsertKey(['layer-1'],5);e.sheetMoveFrames(['layer-1'],5,5,2);
  assert.deepEqual(e.layerFrameKeys('layer-1').map(k=>k.tick),[0,7,10,20]);assert.deepEqual(e.layerFrameKeys('layer-2').map(k=>k.tick),[0,10,20]);
  assert.equal(sample(e,5).find(o=>o.uid===2)?.x,105);
  e.undo();e.undo();assert.deepEqual(e.serialize(),before);
});
test('held cells edit one authored layer pose; F6 creates a new boundary',()=>{
  const e=fixture();e.sheetSetEasing(['layer-1'],0,20,{interpolation:'constant'});e.seek(5);e.select(1);e.updateObject({root_x:42});
  assert.equal(sample(e,0).find(o=>o.uid===1).x,42);assert.equal(sample(e,9).find(o=>o.uid===1).x,42);
  e.sheetInsertKey(['layer-1'],5);e.seek(7);e.select(1);e.updateObject({root_x:77});
  assert.equal(sample(e,4).find(o=>o.uid===1).x,42);assert.equal(sample(e,5).find(o=>o.uid===1).x,77);
});
test('blank frames stop only their layer and selection survives the gap',()=>{
  const e=fixture();e.sheetInsertKey(['layer-1'],5,{blank:true});e.selectSheetLayer('layer-1');e.seek(5);assert.equal(e.selectedUid,null);
  assert.deepEqual(sample(e,5).map(o=>o.uid),[2]);e.seek(10);assert.equal(e.selectedUid,1);
});
test('copy between layers remaps instances once across the entire copied range',()=>{
  const e=fixture();e.sheetCopyFrames(['layer-1'],0,10);e.sheetPasteFrames(['layer-2'],0);
  const start=sample(e,0),end=sample(e,10),copy=start.find(o=>o.uid!==1);assert.ok(copy);assert.equal(copy.uid,end.find(o=>o.uid!==1).uid);assert.notEqual(copy.uid,1);
  assert.equal(e.layerForUid(copy.uid),'layer-2');assert.equal(e.layerForUid(1),'layer-1');
});
test('locks and invalid input leave the complete project unchanged',()=>{
  const e=fixture();const before=e.serialize();assert.throws(()=>e.sheetMoveFrames(['layer-1'],0,0,-1),/before/);assert.deepEqual(e.serialize(),before);
  e.setLayerLocked('layer-1',true);const locked=e.serialize();assert.throws(()=>e.sheetInsertKey(['layer-1'],4),/Unlock/);assert.deepEqual(e.serialize(),locked);
});

test('key replacement preserves incoming poses, identities, intervening keys and exact undo',()=>{
  for(const copy of [false,true])for(const delta of [10,-10]){
    const e=fixture();e.sheetInsertKey(['layer-1'],15);
    const start=delta>0?0:10,end=start+10,before=e.serialize(),duration=e.totalTicks;
    const track=()=>e.report._styk.layerSheet.tracks['layer-1'];
    const sources=structuredClone(track().keys.filter(k=>k.tick>=start&&k.tick<=end));
    const poses=sources.map(key=>sample(e,key.tick).find(o=>o.uid===1));
    const other=structuredClone(e.report._styk.layerSheet.tracks['layer-2']);
    e.sheetMoveFrames(['layer-1'],start,end,delta,{copy});
    for(const source of sources){
      const moved=track().keys.find(k=>k.tick===source.tick+delta);
      assert.equal(moved.interpolation,source.interpolation);
      assert.deepEqual(sample(e,moved.tick).find(o=>o.uid===1),poses[sources.indexOf(source)]);
      if(copy)assert.notEqual(moved.id,source.id);else assert.equal(moved.id,source.id);
    }
    if(delta>0)assert.ok(track().keys.some(k=>k.tick===15));
    assert.equal(e.totalTicks,duration);assert.deepEqual(e.report._styk.layerSheet.tracks['layer-2'],other);
    validateLayerSheet(e.report);const after=e.serialize();e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.deepEqual(e.serialize(),after);
  }
});

test('disabled replacement rejects collisions atomically and still permits free destinations',()=>{
  for(const copy of [false,true]){
    const e=fixture(),before=e.serialize();
    assert.throws(()=>e.sheetMoveFrames(['layer-2','layer-1'],0,0,10,{copy,replace:false}),/destination contains/);
    assert.deepEqual(e.serialize(),before);
    e.sheetMoveFrames(['layer-1'],10,10,2,{copy,replace:false});
    assert.ok(e.layerFrameKeys('layer-1').some(key=>key.tick===12));
    e.undo();assert.deepEqual(e.serialize(),before);
  }
});
test('property controls preview, commit and undo a layer pose without property tracks',()=>{
  const e=fixture();e.seek(0);e.select(1);const before=e.serialize();e.beginAnimationEdit({kind:'figure',uid:1},'x');e.previewAnimationEdit(45);
  assert.equal(e.evaluatedFrame.objects.find(o=>o.unique_id===1).root_x,45);e.commitAnimationEdit();assert.equal(e.animationChannels.length,0);assert.equal(sample(e,0).find(o=>o.uid===1).x,45);
  e.undo();assert.deepEqual(e.serialize(),before);
});

test('adding and pasting figures owns the active layer and undoes definitions and poses together',()=>{
  const e=fixture();e.selectSheetLayer('layer-2');e.sheetInsertKey(['layer-2'],5,{blank:true});e.seek(5);
  const before=e.serialize();e.addFigure();const uid=e.selectedUid;
  assert.equal(e.layerForUid(uid),'layer-2');assert.deepEqual(sample(e,5).map(o=>o.uid),[1,uid]);
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.equal(e.layerForUid(uid),'layer-2');
  e.select(uid);e.copySelection();e.selectSheetLayer('layer-1');e.pasteSelection();assert.equal(e.layerForUid(e.selectedUid),'layer-1');
});

test('deleting a layer removes its contents, never moves them into another layer',()=>{
  const e=fixture(),before=e.serialize();e.deleteLayer('layer-1');
  for(let t=0;t<e.totalTicks;t++)assert.deepEqual(sample(e,t).map(o=>o.uid),[2]);
  assert.equal(e.report._styk.layers.order.length,1);e.undo();assert.deepEqual(e.serialize(),before);e.redo();validateLayerSheet(e.report);
});

test('copying a child to another layer does not copy its external attachment parent',()=>{
  const e=fixture();e.seek(0);e.select(2);e.joinTo(1,1);e.sheetCopyFrames(['layer-2'],0,3);
  const layer=e.createLayer('Paste');e.sheetPasteFrames([layer.id],0);
  const objects=e.evaluatedFrame.objects,pasted=objects.filter(o=>e.layerForUid(o.unique_id)===layer.id);
  assert.equal(pasted.length,1);assert.equal(pasted[0].join,null);assert.equal(objects.length,3);
  assert.equal(pasted[0].root_x,e.geometry.objects.get(objects.find(o=>o.unique_id===2).object_slot).root.x);
});

test('attachment changes and moving connected layer keys keep one instance of every member',()=>{
  const e=fixture();e.assignFiguresToLayer([2],'layer-1');e.seek(5);e.select(2);e.joinTo(1,1);
  e.sheetMoveFrames(['layer-1'],5,5,2);
  for(let t=0;t<e.totalTicks;t++){sample(e,t);const objects=e.evaluatedFrame.objects;assert.equal(objects.length,2);assert.equal(new Set(objects.map(o=>o.unique_id)).size,2);
    const child=objects.find(o=>o.unique_id===2);if(t>=7&&t<10){assert.ok(child.join);assert.deepEqual(e.geometry.objects.get(child.object_slot).root,e.geometry.objects.get(child.join.target_object_slot).joints.get(1));}}
});

test('a keyframe placed after a layer ends extends its last exposure instead of padding blank cells',()=>{
  const e=fixture();e.sheetRemoveFrames(['layer-1'],10,20);
  assert.deepEqual(e.layerFrameKeys('layer-1').map(k=>k.tick),[0]);
  e.sheetInsertKey(['layer-1'],15);
  assert.deepEqual(e.layerFrameKeys('layer-1').map(k=>k.tick),[0,15]);
  assert.ok(!e.layerFrameKeys('layer-1').some(k=>k.empty));
  assert.deepEqual(sample(e,12).map(o=>o.uid),[1,2]);
  assert.equal(sample(e,15).find(o=>o.uid===1).x,0);
});

test('appending a scene frame keeps an ended layer absent through the gap',()=>{
  const e=fixture();e.sheetRemoveFrames(['layer-1'],10,20);e.sheetAppendFrame();
  assert.deepEqual(sample(e,15).map(o=>o.uid),[2]);
  assert.equal(e.layerFrameKeys('layer-1').find(k=>k.tick===10)?.empty,true);
});

test('removing frames beyond a short layer does not shorten existing content',()=>{
  const e=fixture();e.sheetRemoveFrames(['layer-2'],30,35);assert.equal(e.report._styk.layerSheet.tracks['layer-2'].end,21);
});

test('scene colors use fixed scene poses and undo',()=>{
  const e=fixture(),before=e.serialize();e.setBackgroundColor(0xff336699);assert.equal(e.evaluatedFrame._stykBackgroundColor,0xff336699);
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.equal(e.evaluatedFrame._stykBackgroundColor,0xff336699);
});

test('moving and copying clip keys retain their playback clock at the destination',()=>{
  const e=engineEditor({layerTimeline:true,propertyChannels:true});e.select(1);e.createMovieclip({start:0,end:10});const uid=e.selectedUid;
  e.sheetCopyFrames(['layer-1'],0,9);const destination=e.createLayer('Clip copy');e.sheetPasteFrames([destination.id],15);
  e.seek(15);const copy=e.evaluatedFrame.objects.find(o=>e.layerForUid(o.unique_id)===destination.id&&o._stykMovieclip);assert.ok(copy);assert.equal(copy._movieclipSample,0);
  e.sheetMoveFrames([destination.id],15,24,20);e.seek(35);const moved=e.evaluatedFrame.objects.find(o=>o.unique_id===copy.unique_id);assert.ok(moved);assert.equal(moved._movieclipSample,0);
});

test('camera and scene previews publish no legacy channels and undo exactly',async()=>{
  const e=fixture(),before=e.serialize();e.beginCameraDrag();e.updateCameraDrag({x:25,y:10});assert.equal(e.evaluatedFrame.camera.x,25);assert.equal(e.animationChannels.length,0);
  e.commitCameraDrag();assert.equal(e.evaluatedFrame.camera.x,25);e.undo();assert.deepEqual(e.serialize(),before);
  e.beginCameraDrag();e.updateCameraDrag({x:50});e.cancelCameraDrag();assert.deepEqual(e.serialize(),before);
  e.setSceneColor(0xffaabbcc);assert.equal(e.evaluatedFrame._stykBackgroundColor,0xffaabbcc);assert.equal(e.animationChannels.length,0);e.undo();
  assert.deepEqual(e.serialize(),before);
});

test('exposure property preview is non-mutating and commits only its selected layer',async()=>{
  const {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit,cancelNativePropertyEdit}=await import('../src/native-property-edit.mjs');
  const e=fixture();e.selectSheetLayer('layer-1');const before=e.serialize();const token=beginNativePropertyEdit(e,'duration');previewNativePropertyEdit(token,15);assert.deepEqual(e.serialize(),before);
  commitNativePropertyEdit(token);assert.deepEqual(e.layerFrameKeys('layer-1').map(k=>k.tick),[0,15,25]);assert.deepEqual(e.layerFrameKeys('layer-2').map(k=>k.tick),[0,10,20]);
  e.undo();assert.deepEqual(e.serialize(),before);
});

test('range edits use the selected layer poses and keep native source frames unchanged',()=>{
  const e=fixture();e.seek(5);e.select(1);const before=e.serialize();e.updateFiguresInFrames({field28:100},[e.frameIndex],{ticks:[5,15]});
  assert.equal(e.animationChannels.length,0);assert.deepEqual(e.serialize().keyframes,before.keyframes);
  for(const tick of [5,15]){e.seek(tick);assert.equal(e.evaluatedFrame.objects.find(o=>o.unique_id===1).field28,100);assert.equal(e.evaluatedFrame.objects.find(o=>o.unique_id===2).field28,0);}
  e.undo();assert.deepEqual(e.serialize(),before);
});

test('copying frames between projects imports definitions and remaps identities atomically',()=>{
  const e=fixture();e.sheetCopyFrames(['layer-1'],0,10);e.load(emptyDocument());const before=e.serialize();e.sheetPasteFrames(['layer-1'],3);
  e.seek(3);assert.equal(e.evaluatedFrame.objects.length,1);assert.ok(e.figure??e.report.figure_types.some(f=>f.figure_type_id===e.evaluatedFrame.objects[0].figure_type_id));
  new Editor({demo:false,layerTimeline:true}).load(e.serialize());e.undo();assert.deepEqual(e.serialize(),before);e.redo();e.seek(3);assert.equal(e.evaluatedFrame.objects.length,1);
});

test('extending a movieclip exposure continues its loop through the added cells',()=>{
  const e=engineEditor({layerTimeline:true,propertyChannels:true});e.select(1);e.createMovieclip({start:0,end:10});const uid=e.selectedUid;e.sheetInsertFrames(['layer-1'],10,10);
  e.seek(15);const clip=e.evaluatedFrame.objects.find(o=>o.unique_id===uid);assert.ok(clip);assert.equal(clip._stykMovieclip.clock,'presence');assert.equal(clip._movieclipSample,5);
  e.undo();e.seek(15);assert.ok(!e.evaluatedFrame.objects.some(o=>o.unique_id===uid));
});

test('legacy Pivot holds remain held on import and can become explicit modern tweens',()=>{
  const source=legacyDocument();source.version=4;const e=engineEditor({demo:false,layerTimeline:true}, source);
  assert.equal(sample(e,5).find(o=>o.uid===1).x,0);e.sheetSetEasing(['layer-1'],0,0,{interpolation:'linear'});
  assert.equal(sample(e,5).find(o=>o.uid===1).x,5);
});

test('explicit paste destinations win over the active layer and redo retains ownership',()=>{
  const e=fixture();e.sheetCopyFrames(['layer-2'],0,10);e.selectSheetLayer('layer-2');const before=e.serialize();e.sheetPasteFrames(['layer-1'],0);
  const copy=e.evaluatedFrame.objects.find(o=>o.unique_id!==2);assert.equal(e.layerForUid(copy.unique_id),'layer-1');e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.equal(e.layerForUid(copy.unique_id),'layer-1');
});

test('layer metadata edits cannot mutate earlier pose history snapshots',()=>{
  const e=fixture();e.sheetInsertKey(['layer-1'],5);const after=e.serialize();const layer=e.createLayer('Later');e.renameLayer(layer.id,'Renamed');e.undo();e.undo();e.undo();e.redo();assert.deepEqual(e.serialize(),after);
});

for(const operation of ['split','delete','replace'])test(`imported segment animations survive ${operation} rig edits, save and undo`,()=>{
  const base=frames(),segments=base.figure_types[0].segments,joint=operation==='split'?0:segments.length-1,handle=segments[joint].segment_id;
  const old=legacyDocument([{target:{kind:'segment',uid:1,handleId:handle},property:'opacity',keys:[{tick:0,value:.2},{tick:20,value:.8}]}]);
  const e=engineEditor({demo:false,propertyChannels:true,layerTimeline:true}, old);e.select(1,joint);const before=e.serialize();
  if(operation==='split')e.splitSegment(.4);
  else if(operation==='delete')e.deleteSegment();
  else{const definition=structuredClone(e.figure);definition.segments=definition.segments.filter(s=>s.segment_id!==handle);e.replaceFigureDefinition(definition.figure_type_id,definition);}
  const after=e.serialize();new Editor({demo:false,layerTimeline:true}).load(after);assert.equal(e.animationChannels.length,0);
  const channels=e.report._styk.layerSheet.legacyAnimation.channels;
  if(operation==='split')assert.equal(channels.filter(c=>c.target.kind==='segment'&&c.property==='opacity').length,2);
  else assert.ok(!channels.some(c=>c.target.kind==='segment'&&c.target.handleId===handle));
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.deepEqual(e.serialize(),after);
});

test('camera and scene ranges use exact selected cells within one native exposure',()=>{
  const e=fixture();e.seek(3);const indices=[e.frameIndex];indices.sheetTicks=[3,7];const before=e.serialize();
  e.setCameraValues({x:25},indices);for(const tick of indices.sheetTicks){e.seek(tick);assert.equal(e.evaluatedFrame.camera.x,25);}
  assert.deepEqual(e.layerFrameKeys('camera').map(k=>k.tick),[0,3,7,10,20]);e.undo();assert.deepEqual(e.serialize(),before);
  e.setSceneColor(0xffabcdef,{indices});for(const tick of indices.sheetTicks){e.seek(tick);assert.equal(e.evaluatedFrame._stykBackgroundColor,0xffabcdef);}e.undo();assert.deepEqual(e.serialize(),before);
  e.seek(3);e.beginCameraDrag({indices});e.updateCameraDrag({x:12});assert.equal(e.evaluatedFrame.camera.x,12);e.commitCameraDrag();e.seek(7);assert.equal(e.evaluatedFrame.camera.x,12);e.undo();assert.deepEqual(e.serialize(),before);
});

// (A pose at an absolute value across several frames, such as root_x, is not a command of the engine: the inspector's token refuses it.)
for(const key of ['thickness','camera_x'])test(`${key} inspector ranges author the selected sheet cells`,async()=>{
  const {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit}=await import('../src/native-property-edit.mjs');
  const e=fixture();e.seek(3);e.select(1,0);const indices=[e.frameIndex];indices.sheetTicks=[3,7];const before=e.serialize();
  const token=beginNativePropertyEdit(e,key,{indices});previewNativePropertyEdit(token,45);commitNativePropertyEdit(token);
  const id=key==='camera_x'?'camera':'layer-1';assert.ok([3,7].every(tick=>e.layerFrameKeys(id).some(k=>k.tick===tick)));assert.equal(e.animationChannels.length,0);
  for(const tick of [3,7]){e.seek(tick);if(key==='camera_x')assert.equal(e.evaluatedFrame.camera.x,45);}
  e.undo();assert.deepEqual(e.serialize(),before);
});

test('applying the sheet camera preserves visible geometry and is reversible',async()=>{
  const {cameraMatrix}=await import('../src/renderer-geometry.mjs');
  const e=fixture();e.select(2);e.joinTo(1,1);e.setCameraValues({x:35,y:16,scale:1.5,angle_rad:.2});
  const points=()=>{const m=cameraMatrix({report:e.report,frame:e.evaluatedFrame});return e.geometry.drawables.flatMap(s=>s.points.map(p=>[m[0]*p.x+m[2]*p.y+m[4],m[1]*p.x+m[3]*p.y+m[5]]));};
  const before=e.serialize(),expected=points();e.applyCameraToFigures();assert.equal(e.animationChannels.length,0);assert.deepEqual(['x','y','scale','angle_rad'].map(k=>e.evaluatedFrame.camera[k]),[0,0,1,0]);
  // Native geometry stores some joined coordinates as float32.
  const actual=points();assert.equal(actual.length,expected.length);for(let i=0;i<actual.length;i++)for(let j=0;j<2;j++)assert.ok(Math.abs(actual[i][j]-expected[i][j])<1e-3,JSON.stringify({i,j,actual:actual[i],expected:expected[i]}));
  e.undo();assert.deepEqual(e.serialize(),before);
});

test('blank Camera and Scene cells reset imported values and resume at the next key',()=>{
  const source=legacyDocument();for(const frame of source.keyframes){frame.camera={is_default:false,x:25,y:0,scale:1,angle_rad:0};frame._stykBackgroundColor=0xffabcdef;}
  const e=engineEditor({demo:false,layerTimeline:true}, source),before=e.serialize();e.sheetInsertKey(['camera','scene'],5,{blank:true});
  for(const tick of [4,5,9,10]){e.seek(tick);const blank=tick>=5&&tick<10;assert.equal(e.evaluatedFrame.camera.x,blank?0:25);assert.equal(e.evaluatedFrame._stykBackgroundColor,blank?undefined:0xffabcdef);}
  e.undo();assert.deepEqual(e.serialize(),before);
});

test('Stick Nodes project layers retain source movieclips, geometry and edits across reopen',async()=>{
  const {readFile}=await import('node:fs/promises'),{importStickNodes}=await import('../src/sticknodes/adapter.mjs');
  const data=JSON.parse(await readFile(new URL('./sticknodes-synthetic.json',import.meta.url),'utf8'));
  const {document}=await importStickNodes(Buffer.from(data.base64,'base64'),{filename:'synthetic.stknds'});
  const old=engineEditor({demo:false}, document),e=engineEditor({demo:false,propertyChannels:true,layerTimeline:true}, document);
  const geometry=editor=>editor.geometry.drawables.map(d=>[d.type,d.rgb,d.points]);
  for(let tick=0;tick<e.totalTicks;tick++){old.seek(tick);e.seek(tick);assert.deepEqual(geometry(e),geometry(old));}
  e.seek(0);const uid=e.evaluatedFrame.objects[0].unique_id;e.select(uid);const before=e.serialize();e.moveSelection(5,3);
  const reopened=engineEditor({demo:false,layerTimeline:true}, e.serialize());assert.deepEqual(geometry(reopened),geometry(e));
  e.undo();assert.deepEqual(e.serialize(),before);
});

test('inserting frames at the start retains the opening pose and identities',()=>{
  const e=fixture(),before=e.serialize(),opening=sample(e,0);
  e.sheetInsertFrames(['scene','camera','layer-1','layer-2'],0,3);
  for(let tick=0;tick<=3;tick++)assert.deepEqual(sample(e,tick),opening);
  e.undo();assert.deepEqual(e.serialize(),before);
});
test('editing an imported Bezier curve updates its evaluated motion',()=>{
  const r=emptyDocument();r.keyframes=[0,100].map(x=>createFrame([createObject(r.figure_types[0],1,x,200)],10));
  r.keyframes[0]._styk={easing:{interpolation:'bezier',bezier:[.42,0,.58,1]}};
  const e=engineEditor({demo:false,layerTimeline:true}, r),before=e.serialize(),x=sample(e,2)[0].x;
  e.sheetSetEasing(['layer-1'],0,0,{interpolation:'bezier',bezier:[0,0,1,1]});
  assert.ok(Math.abs(sample(e,2)[0].x-20)<1e-6);assert.ok(Math.abs(x-20)>1);
  e.undo();assert.deepEqual(e.serialize(),before);
});

test('property key authoring writes one boundary per entry tick inside a tween',()=>{
  const e=fixture(),before=e.serialize();
  e.sheetSetEasing(['scene'],0,9,{interpolation:'linear'});
  e.addAnimationKeys([{target:{kind:'scene'},property:'color',tick:0,value:0xfff00000},{target:{kind:'scene'},property:'color',tick:8,value:0xff0000f0}]);
  assert.deepEqual(e.report._styk.layerSheet.tracks.scene.keys.map(k=>k.tick),[0,8,10,20]);
  for(const [tick,color] of [[0,0xfff00000],[7,0xfff00000],[8,0xff0000f0],[9,0xff0000f0]]){e.seek(tick);assert.equal(e.evaluatedFrame._stykBackgroundColor,color,`tick ${tick}`);}
  assert.equal(e.report._styk.animation,undefined);
  e.undo();assert.deepEqual(e.serialize(),before);
});
test('property edits on a held cell rewrite its preceding key',()=>{
  const e=fixture();e.sheetSetEasing(['layer-1'],0,20,{interpolation:'constant'});e.seek(5);e.select(1);
  const before=e.serialize();e.beginAnimationEdit({kind:'figure',uid:1},'x');e.previewAnimationEdit(42);e.commitAnimationEdit();
  assert.deepEqual(e.layerFrameKeys('layer-1').map(k=>k.tick),[0,10,20]);
  assert.equal(sample(e,0).find(o=>o.uid===1).x,42);assert.equal(sample(e,9).find(o=>o.uid===1).x,42);
  assert.equal(e.report._styk.animation,undefined);e.undo();assert.deepEqual(e.serialize(),before);
});
test('property edits inside a tween create a boundary at the playhead',()=>{
  const e=fixture();e.sheetSetEasing(['layer-1'],0,20,{interpolation:'linear'});e.seek(5);e.select(1);
  const before=e.serialize();e.beginAnimationEdit({kind:'figure',uid:1},'x');e.previewAnimationEdit(42);e.commitAnimationEdit();
  assert.deepEqual(e.layerFrameKeys('layer-1').map(k=>k.tick),[0,5,10,20]);
  const x=t=>sample(e,t).find(o=>o.uid===1).x;
  assert.equal(x(5),42);assert.ok(x(4)>0&&x(4)<42);assert.ok(x(9)>10&&x(9)<42);
  assert.equal(e.report._styk.animation,undefined);e.undo();assert.deepEqual(e.serialize(),before);
});
test('a pose entry without a value captures the interpolated pose at its tick',()=>{
  const e=fixture();e.sheetSetEasing(['layer-1'],0,20,{interpolation:'linear'});e.addAnimationKey({kind:'figure',uid:1},'pose',15);
  assert.deepEqual(e.layerFrameKeys('layer-1').map(k=>k.tick),[0,10,15,20]);
  assert.equal(sample(e,15).find(o=>o.uid===1).x,15);assert.equal(sample(e,19).find(o=>o.uid===1).x,19);
  assert.equal(e.report._styk.animation,undefined);
});

test('inserting opening frames keeps movieclips visible through the inserted time',()=>{
  const e=engineEditor({layerTimeline:true,propertyChannels:true});e.select(1);e.createMovieclip({start:0,end:2});
  const uid=e.selectedUid,before=e.serialize();e.sheetInsertFrames(['scene','camera',...e.report._styk.layers.order],0,3);
  for(let tick=0;tick<=3;tick++){e.seek(tick);assert.ok(e.evaluatedFrame.objects.some(o=>o.unique_id===uid),`Clip missing at ${tick}`);}
  e.undo();assert.deepEqual(e.serialize(),before);
});
