import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {engineEditor} from './support/owned-editor.mjs';
/** The editor the engine owns, on a layer sheet. */
const layerEditor=(options={},document)=>engineEditor({...options,layerTimeline:true},document);
import {movieclipAsset,movieclipTime,playbackSettings,validateMovieclipGraph} from '../src/movieclips.mjs';
import {timeline} from '../src/pivot/read-view.mjs';
import {pivotDocument, figureDocument} from './support/engine-export.mjs';
import {sceneAt} from './support/engine-geometry.mjs';

const near=(a,b,tolerance=1e-9)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b}`);

// The scene the engine draws at a tick, movieclip contents included (a clip's own geometry is its handle: engine-geometry.mjs).
const sample=sceneAt;
const scene=geometry=>geometry.drawables.map(s=>({type:s.type,points:s.points.map(p=>[p.x,p.y]),rgb:s.rgb,alpha:s.alpha}));
function close(actual,expected){assert.equal(actual.length,expected.length);for(let i=0;i<actual.length;i++){assert.equal(actual[i].type,expected[i].type);assert.deepEqual(actual[i].rgb,expected[i].rgb);assert.equal(actual[i].points.length,expected[i].points.length);for(let j=0;j<actual[i].points.length;j++)for(let k=0;k<2;k++)assert.ok(Math.abs(actual[i].points[j][k]-expected[i].points[j][k])<.0001,`${i}/${j}/${k}: ${actual[i].points[j][k]} != ${expected[i].points[j][k]}`);}}
/** The same scene at `tick` of two documents or editors. */
const sameScene=(actual,expected,tick)=>close(scene(sample(actual,tick)),scene(sample(expected,tick)));
/** How many shapes the figure `uid` draws on the stage at `tick` (an ordinary figure: a clip's contents are not in the interface's geometry). */
const drawn=(editor,tick,uid)=>{const at=editor.tick;editor.seek(tick);const count=editor.geometry.drawables.filter(s=>s.obj.unique_id===uid).length;editor.seek(at);return count;};
/** Whether the frame on show at `tick` holds the figure `uid`. */
const present=(editor,tick,uid)=>{const at=editor.tick;editor.seek(tick);const has=editor.evaluatedFrame.objects.some(o=>o.unique_id===uid);editor.seek(at);return has;};

test('movieclip sampling is deterministic at loop, once, hold, offset and FPS boundaries',()=>{
  const asset={duration:12,document:{fps:24}},base=playbackSettings(null,{start:12});
  assert.equal(movieclipTime(asset,base,11,24),null);assert.equal(movieclipTime(asset,base,12,24),0);
  assert.equal(movieclipTime(asset,base,23,24),11);assert.equal(movieclipTime(asset,base,24,24),0);
  assert.equal(movieclipTime(asset,{...base,mode:'once'},24,24),null);
  assert.equal(movieclipTime(asset,{...base,mode:'hold'},80,24),11);
  assert.equal(movieclipTime(asset,{...base,mode:'single',offset:7},80,24),7);
  assert.equal(movieclipTime(asset,base,14,48),1);
});
test('range conversion preserves all sampled poses and leaves unrelated figures intact',()=>{
  const editor=layerEditor({propertyChannels:true}),source=structuredClone(editor.report);
  editor.select(1);const figure=editor.createMovieclip({start:3,end:24});
  for(let tick=3;tick<24;tick++)sameScene(editor,source,tick);
  assert.equal(movieclipAsset(figure).duration,21);
  editor.undo();assert.equal(editor.report.figure_types.length,3);sameScene(editor,source,10);
  editor.redo();sameScene(editor,source,10);
});

test('native document round trip retains source baselines and rejects cyclic clips',()=>{
  const editor=layerEditor({propertyChannels:true});editor.select(1);editor.createMovieclip({start:2,end:19});
  const saved=JSON.parse(JSON.stringify(editor.report)),reopened=layerEditor({},saved);assert.equal(sample(saved,8).drawables.length,12);
  const figure=reopened.report.figure_types.at(-1);movieclipAsset(figure).document.figure_types.push(figure);
  assert.throws(()=>validateMovieclipGraph(reopened.report),/cycle|nested/);
});

test('global playback settings and frame-local Make unique retain sources with undo',()=>{
  const editor=layerEditor({propertyChannels:true});editor.select(1);editor.createMovieclip({start:3,end:24});const uid=editor.selectedUid;
  editor.setMovieclipPlayback({speed:2,offset:2},{allFrames:true});
  for(const tick of [3,4,10,20]){editor.seek(tick);editor.select(uid);assert.equal(editor.object._stykMovieclip.speed,2);assert.equal(editor.object._movieclipSample,(2+(tick-3)*2)%21);}
  const original=editor.figure.figure_type_id;editor.makeMovieclipUnique();const unique=editor.figure.figure_type_id,uniqueUid=editor.selectedUid;assert.notEqual(unique,original);assert.notEqual(uniqueUid,uid);
  for(const tick of [3,10,20,21]){editor.seek(tick);editor.select(tick===20?uniqueUid:uid);assert.equal(editor.object.figure_type_id,tick===20?unique:original);assert.equal(editor.object._movieclipSample,(2+(tick-3)*2)%21);}
  editor.undo();editor.seek(3);editor.select(uid);assert.equal(editor.figure.figure_type_id,original);editor.undo();assert.equal(editor.object._stykMovieclip.speed,1);
});

test('Bake animation produces ordinary editable poses and one reversible command',async()=>{
  const editor=layerEditor({propertyChannels:true});editor.select(1);editor.createMovieclip({start:2,end:17});const uid=editor.selectedUid,before=structuredClone(editor.report),count=editor._undo.length;
  const children=await editor.bakeMovieclip();assert.ok(children.length);assert.equal(editor._undo.length,count+1);
  for(let tick=2;tick<17;tick++){sameScene(editor,before,tick);assert.equal(present(editor,tick,uid),false);}
  editor.undo();sameScene(editor,before,8);assert.equal(present(editor,8,uid),true);
  editor.redo();assert.ok(drawn(editor,8,children[0])>0);
});

test('mirrored movieclips and their legacy export agree',()=>{
  const editor=layerEditor({propertyChannels:true});editor.select(1);editor.createMovieclip({start:0,end:8});
  const unrelated=new Set(editor.evaluatedFrame.objects.map(o=>o.unique_id).filter(uid=>uid!==editor.selectedUid));
  const old=sample(editor,0),root=editor.geometry.objects.get(editor.selectedSlot).root;
  const before=scene(old);
  editor.mirrorFigure();
  // The clip's shapes mirror about its root; the figures beside it stay where they were.
  const expected=before.map((shape,i)=>unrelated.has(old.drawables[i].obj.unique_id)?shape:{...shape,points:shape.points.map(([x,y])=>[2*root.x-x,y])});
  close(scene(sample(editor,0)),expected);
  const flat=pivotDocument(editor.report);assert.equal(sample(flat,0).drawables.length,before.length);
});

test('portable movieclip imports restart and shared editing recovery retains the root project',()=>{
  const editor=layerEditor({propertyChannels:true});editor.select(1);const f=editor.createMovieclip({start:5,end:17});
  const portable=figureDocument(editor.report,{figureUid:editor.selectedUid,tick:5}),other=layerEditor();other.seek(10);other.importFigure(portable);
  assert.equal(other.object._stykMovieclip.clock,'presence');assert.equal(other.object._movieclipSample,0);assert.equal(other.figure._styk.movieclip.duration,12);
  const parent=editor.report;editor.enterMovieclip(f.figure_type_id);editor.select(1);editor.moveSelection(7,0);
  const recovered=editor.movieclipProjectReport();assert.equal(recovered.keyframes.length,parent.keyframes.length);assert.equal(recovered.figure_types.at(-1)._styk.movieclip.document,editor.report);
  const reopened=layerEditor({},structuredClone(recovered));assert.equal(reopened.totalTicks,timeline(parent).at(-1).start+timeline(parent).at(-1).count);
});

test('nested conversion preserves the enclosing clip and shared edits update all instances',()=>{
  const editor=layerEditor({propertyChannels:true});editor.select(1);const first=editor.createMovieclip({start:3,end:22}),uid=editor.selectedUid,before=structuredClone(editor.report);
  editor.enterMovieclip(first.figure_type_id);editor.select(1);editor.createMovieclip({start:0,end:19});editor.leaveMovieclip();
  for(let tick=3;tick<22;tick++)sameScene(editor,before,tick);
  editor.seek(3);editor.select(uid);const shared=editor.figure;editor.enterMovieclip();const nested=editor.report.figure_types.find(f=>f._styk?.movieclip);editor.enterMovieclip(nested.figure_type_id);editor.select(1);editor.moveSelection(10,0);editor.leaveMovieclip();editor.leaveMovieclip();
  assert.notEqual(editor.figure,shared);assert.equal(editor._movieclipScopes.length,0);
  const saved=JSON.parse(JSON.stringify(editor.report));sameScene(saved,editor,3);
});

test('rig topology inside a captured clip repairs retained source poses and is reversible',()=>{
  const editor=layerEditor({propertyChannels:true});editor.select(1);editor.addAnimationKey({kind:'segment',uid:1,handleId:3},'opacity',4,.4);
  editor.createMovieclip({start:0,end:16});const type=editor.figure.figure_type_id;editor.enterMovieclip(type);editor.select(1,2);
  const count=editor.figure.segments.length;editor.splitSegment(.3);assert.equal(editor.figure.segments.length,count+1);
  layerEditor({},JSON.parse(JSON.stringify(editor.report)));
  editor.undo();assert.equal(editor.figure.segments.length,count);layerEditor({},JSON.parse(JSON.stringify(editor.report)));
  editor.redo();editor.leaveMovieclip();layerEditor({},JSON.parse(JSON.stringify(editor.report)));assert.ok(sample(editor,7).drawables.length>0);
});

test('library insertion follows its current exposure and remains one undo action',()=>{
  const editor=layerEditor({propertyChannels:true});editor.select(1);const clip=editor.createMovieclip({start:0,end:12,replace:false}),before=structuredClone(editor.report);
  // The inserted clip draws what the scene without it does not.
  const added=tick=>sample(editor,tick).drawables.length-sample(before,tick).drawables.length;
  editor.seek(6);const count=editor._undo.length;editor.addFigure(clip.figure_type_id);
  assert.equal(editor._undo.length,count+1);assert.equal(added(5),0);
  assert.equal(editor.object._stykMovieclip.clock,'presence');assert.equal(editor.object._stykMovieclip.end,undefined);
  for(const tick of [6,7])assert.ok(added(tick)>0);
  assert.equal(added(8),0);editor.undo();assert.equal(added(6),0);editor.redo();assert.ok(added(7)>0);
});

test('conversion preserves the complete scene before, inside and after the range',()=>{
  for(const nested of [false,true]){
    const e=layerEditor({propertyChannels:true});e.select(1);
    if(nested){e.createMovieclip({start:0,end:40});e.enterMovieclip();e.select(1);}
    const before=structuredClone(e.report);e.createMovieclip({start:3,end:24});
    for(let t=0;t<40;t++)sameScene(e,before,t);
  }
});

test('breaking adjacent frames leaves one clip with gaps and exact ordinary poses',()=>{
  const e=layerEditor({propertyChannels:true});e.select(1);e.createMovieclip({start:0,end:5});const uid=e.selectedUid,before=structuredClone(e.report),undo=e._undo.length;
  const children=[];
  for(const tick of [0,1]){e.seek(tick);e.select(uid);children.push(e.breakApartMovieclip());}
  assert.equal(e._undo.length,undo+2);
  assert.deepEqual(children[0],children[1]);
  assert.equal(e.animationChannels.length,0);
  for(let t=0;t<30;t++){
    sameScene(e,before,t);
    assert.equal(present(e,t,uid),t>=2&&t<5);
    assert.equal(drawn(e,t,children[0][0]),t<2?10:0);
  }
  const restored=JSON.parse(JSON.stringify(e.report));
  for(let t=0;t<6;t++)sameScene(restored,e,t);
  e.undo();assert.equal(present(e,1,uid),true);e.redo();assert.equal(present(e,1,uid),false);
});

test('conversion rejects interleaved stacking later in the range without a partial edit',()=>{
  const stacked=engineEditor({propertyChannels:true});
  for(const frame of stacked.report.keyframes){frame.object_draw_order=[0,1,2];frame.object_draw_order_unique_ids=frame.objects.map(o=>o.unique_id);}
  stacked.report.keyframes[1].object_draw_order=[0,2,1];stacked.report.keyframes[1].object_draw_order_unique_ids=[1,3,2];
  const e=layerEditor({propertyChannels:true},stacked.serialize());e._selectIds([1,2]);const count=e._undo.length,definitions=e.report.figure_types.length;
  assert.throws(()=>e.createMovieclip({start:0,end:20}),/stacking order/);
  assert.equal(e._undo.length,count);assert.equal(e.report.figure_types.length,definitions);
});


test('a figure joined to a movieclip that is not shown stays where the clip had it',()=>{
  // The clip's placement ends at tick 3; the figure joined to its root comes loose there and goes on following the clip's place
  // in the timeline (it is never refused, and the clip's own geometry is gone from the frame).
  const document=JSON.parse(readFileSync(new URL('../engine/tests/edit/clip-playback-all-native.document.json',import.meta.url),'utf8'));
  const e=layerEditor({propertyChannels:true},document);
  e.addFigure();e.select(2);e.joinFigure(1,0);e.select(1);e.setMovieclipPlayback({start:0,end:3,mode:'loop'},{allFrames:true});
  const placed=tick=>{e.seek(tick,{allowBeyondEnd:true});return e.evaluatedFrame.objects.map(o=>[o.unique_id,o.join??null,o.root_x,o.root_y,o._movieclipSample??null]);};
  const groups=tick=>{e.seek(tick,{allowBeyondEnd:true});const {objects,orderedObjects}=e.geometry;return {slots:[...objects.keys()],roots:orderedObjects.map(g=>[g.obj.unique_id,g.root.x,g.root.y])};};
  // While the clip plays the figure stays joined to it, at its root.
  const playing=placed(1);
  assert.deepEqual(playing.map(o=>o[0]),[1,2,3]);
  assert.equal(playing[1][1].target_object_slot,0);
  // When the placement has ended the frame holds the two figures that remain, the joined one detached at the clip's last place.
  assert.deepEqual(placed(3),[[2,null,196.25,146.375,null],[3,null,480,270,null]]);
  const later=placed(5);
  assert.deepEqual(later.map(o=>[o[0],o[1]]),[[2,null],[3,null]]);
  near(later[0][2],180+32.5*5/6);near(later[0][3],150-7.25*5/6);
  for(const tick of [3,5]){
    const shown=groups(tick);
    assert.deepEqual(shown.slots,[0,1]);
    assert.deepEqual(shown.roots.map(r=>r[0]),[2,3]);
    near(shown.roots[0][1],placed(tick)[0][2]);near(shown.roots[0][2],placed(tick)[0][3]);
  }
});
