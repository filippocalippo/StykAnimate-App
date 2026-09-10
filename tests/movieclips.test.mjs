import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {movieclipAsset,movieclipTime,playbackSettings,validateMovieclipGraph} from '../src/movieclips.mjs';
import {movieclipCacheStats} from '../src/movieclip-geometry.mjs';
import {buildGeometry,evaluatedFrame,timeline} from '../src/pivot/geometry.mjs';
import {createObject,createFrame} from '../src/demo.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';
import {storedFrameReport} from '../src/pivot-frame-draft.mjs';
import {nativeFigureDocument} from '../src/native-figure.mjs';
import {exportSVG} from '../src/svg-export.mjs';
import {requiresCompatibilityTexture} from '../src/renderer-geometry.mjs';

const sample=(report,tick)=>{const rows=timeline(report);let i=0;while(i+1<rows.length&&rows[i+1].start<=tick)i++;return buildGeometry(report,evaluatedFrame(report,i,rows[i].count?(tick-rows[i].start)/rows[i].count:0,tick));};
const scene=geometry=>geometry.drawables.map(s=>({type:s.type,points:s.points.map(p=>[p.x,p.y]),rgb:s.rgb,alpha:s.alpha}));
function coordinates(geometry,uid){return geometry.drawables.filter(s=>s.obj.unique_id===uid).map(s=>({type:s.type,points:s.points.map(p=>[p.x,p.y]),rgb:s.rgb,alpha:s.alpha}));}
function close(actual,expected){assert.equal(actual.length,expected.length);for(let i=0;i<actual.length;i++){assert.equal(actual[i].type,expected[i].type);assert.deepEqual(actual[i].rgb,expected[i].rgb);assert.equal(actual[i].points.length,expected[i].points.length);for(let j=0;j<actual[i].points.length;j++)for(let k=0;k<2;k++)assert.ok(Math.abs(actual[i].points[j][k]-expected[i].points[j][k])<.0001,`${i}/${j}/${k}: ${actual[i].points[j][k]} != ${expected[i].points[j][k]}`);}}

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
  const editor=new Editor({propertyChannels:true}),source=structuredClone(editor.report);
  editor.select(1);const figure=editor.createMovieclip({start:3,end:24}),uid=editor.selectedUid;
  for(let tick=3;tick<24;tick++){const actual=sample(editor.report,tick),expected=sample(source,tick);close(coordinates(actual,uid),coordinates(expected,1));close(coordinates(actual,3),coordinates(expected,3));}
  assert.equal(movieclipAsset(figure).duration,21);
  editor.undo();assert.equal(editor.report.figure_types.length,3);close(coordinates(sample(editor.report,10),1),coordinates(sample(source,10),1));
  editor.redo();close(coordinates(sample(editor.report,10),uid),coordinates(sample(source,10),1));
});
test('many instances share bounded local geometry and keep parent selection identities',()=>{
  const editor=new Editor();editor.select(1);const figure=editor.createMovieclip({start:0,end:20,replace:false});
  const objects=Array.from({length:100},(_,i)=>createObject(figure,100+i,i*10,0,{_stykMovieclip:{start:0}}));
  const report={...editor.report,figure_types:[figure],keyframes:[createFrame(objects,40),createFrame(objects.map(o=>({...o})),1)]};
  const geometry=sample(report,7),stats=movieclipCacheStats(figure);
  assert.equal(stats.misses,1);assert.equal(stats.hits,99);assert.equal(geometry.objects.size,100);
  assert.equal(geometry.orderedObjects[30].drawables[0].obj.unique_id,130);
  for(let i=0;i<100;i++)sample(report,i/10);
  assert.ok(movieclipCacheStats(figure).frames<=48);
});
test('nested editing restores parent history, saves shared asset and supports cancel',()=>{
  const editor=new Editor({propertyChannels:true});editor.select(1);const figure=editor.createMovieclip({start:0,end:12});
  const parent=editor.report,old=movieclipAsset(figure);editor.enterMovieclip(figure.figure_type_id);
  assert.equal(editor.totalTicks,12);editor.select(1);editor.moveSelection(20,0);editor.leaveMovieclip();
  assert.equal(editor.report,parent);assert.notEqual(movieclipAsset(editor.report.figure_types.at(-1)),old);
  editor.undo();assert.equal(movieclipAsset(editor.report.figure_types.at(-1)),old);
  editor.enterMovieclip(figure.figure_type_id);editor.leaveMovieclip({save:false});assert.equal(editor.report,parent);
});
test('native document round trip retains source baselines and rejects cyclic clips',()=>{
  const editor=new Editor({propertyChannels:true});editor.select(1);editor.createMovieclip({start:2,end:19});
  const reopened=new Editor();reopened.load(JSON.parse(JSON.stringify(editor.report)));assert.equal(sample(reopened.report,8).drawables.length,12);
  const figure=reopened.report.figure_types.at(-1);movieclipAsset(figure).document.figure_types.push(figure);
  assert.throws(()=>validateMovieclipGraph(reopened.report),/cycle|nested/);
});

test('global instance settings and Make unique update retained sources with undo',()=>{
  const editor=new Editor({propertyChannels:true});editor.select(1);editor.createMovieclip({start:3,end:24});const uid=editor.selectedUid;
  editor.setMovieclipPlayback({speed:2,offset:2},{allFrames:true});
  for(const tick of [3,4,10,20]){editor.seek(tick);editor.select(uid);assert.equal(editor.object._stykMovieclip.speed,2);assert.equal(editor.object._movieclipSample,(2+(tick-3)*2)%21);}
  const original=editor.figure.figure_type_id;editor.makeMovieclipUnique();const unique=editor.figure.figure_type_id;assert.notEqual(unique,original);
  for(const tick of [3,10,20]){editor.seek(tick);editor.select(uid);assert.equal(editor.object.figure_type_id,unique);}
  editor.undo();editor.seek(3);editor.select(uid);assert.equal(editor.figure.figure_type_id,original);editor.undo();assert.equal(editor.object._stykMovieclip.speed,1);
});

test('moving and trimming placements retain poses and affect no unrelated object',()=>{
  const editor=new Editor({propertyChannels:true});editor.select(1);editor.createMovieclip({start:3,end:20});const uid=editor.selectedUid,before=structuredClone(editor.report);
  editor.placeMovieclip({start:8,end:25},{move:true});
  for(let tick=8;tick<25;tick++){close(coordinates(sample(editor.report,tick),uid),coordinates(sample(before,tick-5),uid));close(coordinates(sample(editor.report,tick),3),coordinates(sample(before,tick),3));}
  assert.equal(coordinates(sample(editor.report,7),uid).length,0);editor.undo();close(coordinates(sample(editor.report,8),uid),coordinates(sample(before,8),uid));
  editor.placeMovieclip({end:30});assert.ok(coordinates(sample(editor.report,25),uid).length);assert.equal(coordinates(sample(editor.report,30),uid).length,0);
});

test('split plays continuously and preserves scene geometry at the cut',()=>{
  const editor=new Editor({propertyChannels:true});editor.select(1);editor.createMovieclip({start:0,end:20});const uid=editor.selectedUid;
  editor.seek(15);editor.moveSelection(90,30);const channel=editor.animationChannel({kind:'figure',uid},'pose');editor.setAnimationKey(channel.id,channel.keys[0].id,{interpolation:'linear'});
  const before=structuredClone(editor.report);
  editor.seek(9);editor.select(uid);editor.splitMovieclip();const second=editor.selectedUid;
  for(let tick=0;tick<20;tick++)close(coordinates(sample(editor.report,tick),tick<9?uid:second),coordinates(sample(before,tick),uid));
  editor.undo();for(let tick=0;tick<20;tick++)close(coordinates(sample(editor.report,tick),uid),coordinates(sample(before,tick),uid));
});

test('Simple static creation stays a working pose and Discard restores the original',()=>{
  const editor=new Editor({propertyChannels:true});editor.enableFrameDrafts({mode:'add'});editor.select(1);const before=structuredClone(storedFrameReport(editor.report));
  editor.createMovieclip();const uid=editor.selectedUid;assert.ok(editor.figure._styk.movieclip);assert.ok(editor.frameDraft.dirty);
  close(coordinates(sample(storedFrameReport(editor.report),0),1),coordinates(sample(before,0),1));
  editor.discardFrameDraft();assert.ok(editor.evaluatedFrame.objects.some(o=>o.unique_id===1));assert.ok(!editor.evaluatedFrame.objects.some(o=>o.unique_id===uid));
  editor.undo();assert.ok(editor.evaluatedFrame.objects.some(o=>o.unique_id===uid));editor.disableFrameDrafts();assert.ok(editor.report.figure_types.some(f=>f._styk?.movieclip));
});

test('legacy materialization matches clip geometry at every output tick',()=>{
  const editor=new Editor({propertyChannels:true});editor.select(1);editor.createMovieclip({start:2,end:21});const uid=editor.selectedUid;
  editor._objectEdit('Scale movieclip',object=>{object.scale=1.4;object.angles[0]=.4;});const flat=materializePivotDocument(editor.report);
  assert.ok(flat.figure_types.every(f=>!f._styk?.movieclip));
  for(let tick=2;tick<21;tick++){
    const expected=sample(editor.report,tick).drawables,actual=sample(flat,tick).drawables;
    close(actual.map(s=>({type:s.type,points:s.points.map(p=>[p.x,p.y]),rgb:s.rgb})),expected.map(s=>({type:s.type,points:s.points.map(p=>[p.x,p.y]),rgb:s.rgb})));
  }
});

test('Bake animation produces ordinary editable poses and one reversible command',async()=>{
  const editor=new Editor({propertyChannels:true});editor.select(1);editor.createMovieclip({start:2,end:17});const uid=editor.selectedUid,before=structuredClone(editor.report),count=editor._undo.length;
  const children=await editor.bakeMovieclip();assert.ok(children.length);assert.equal(editor._undo.length,count+1);
  for(let tick=2;tick<17;tick++){const actual=sample(editor.report,tick);close(coordinates(actual,children[0]),coordinates(sample(before,tick),uid));assert.equal(coordinates(actual,uid).length,0);}
  editor.undo();close(coordinates(sample(editor.report,8),uid),coordinates(sample(before,8),uid));
  editor.redo();assert.ok(coordinates(sample(editor.report,8),children[0]).length);
});

test('mirrored movieclips and their legacy export agree',()=>{
  const editor=new Editor({propertyChannels:true});editor.select(1);editor.createMovieclip({start:0,end:8});const uid=editor.selectedUid,old=sample(editor.report,0),root=editor.geometry.objects.get(editor.selectedSlot).root;
  editor.mirrorFigure();const mirrored=coordinates(sample(editor.report,0),uid),expected=coordinates(old,uid).map(s=>({...s,points:s.points.map(([x,y])=>[2*root.x-x,y])}));close(mirrored,expected);
  const flat=materializePivotDocument(editor.report);assert.equal(sample(flat,0).drawables.length,old.drawables.length);
});

test('portable movieclip imports restart and shared editing recovery retains the root project',()=>{
  const editor=new Editor({propertyChannels:true});editor.select(1);const f=editor.createMovieclip({start:5,end:17});
  const portable=nativeFigureDocument(editor.report,{figureUid:editor.selectedUid,tick:5}),other=new Editor();other.seek(10);other.importFigure(portable);
  assert.equal(other.object._stykMovieclip.start,10);assert.equal(other.figure._styk.movieclip.duration,12);
  const parent=editor.report;editor.enterMovieclip(f.figure_type_id);editor.select(1);editor.moveSelection(7,0);
  const recovered=editor.movieclipProjectReport();assert.equal(recovered.keyframes.length,parent.keyframes.length);assert.equal(recovered.figure_types.at(-1)._styk.movieclip.document,editor.report);
  const reopened=new Editor();reopened.load(structuredClone(recovered));assert.equal(reopened.totalTicks,timeline(parent).at(-1).start+timeline(parent).at(-1).count);
});

test('SVG and GPU fallback preserve movieclip group opacity',async()=>{
  const editor=new Editor({propertyChannels:true});editor.select(1);editor.createMovieclip({start:0,end:8});editor._objectEdit('Fade movieclip',o=>{o.field28=128;});
  assert.equal(requiresCompatibilityTexture(editor.geometry.drawables),true);
  const svg=await exportSVG({report:editor.report,frame:editor.evaluatedFrame,geometry:editor.geometry,width:960,height:540});
  assert.match(await svg.text(),/data-movieclip-id="\d+" opacity="0.4980392"/);
});

test('nested conversion preserves the enclosing clip and shared edits update all instances',()=>{
  const editor=new Editor({propertyChannels:true});editor.select(1);const first=editor.createMovieclip({start:3,end:22}),uid=editor.selectedUid,before=structuredClone(editor.report);
  editor.enterMovieclip(first.figure_type_id);editor.select(1);editor.createMovieclip({start:0,end:19});editor.leaveMovieclip();
  for(let tick=3;tick<22;tick++)close(coordinates(sample(editor.report,tick),uid),coordinates(sample(before,tick),uid));
  editor.seek(3);editor.select(uid);const shared=editor.figure;editor.enterMovieclip();const nested=editor.report.figure_types.find(f=>f._styk?.movieclip);editor.enterMovieclip(nested.figure_type_id);editor.select(1);editor.moveSelection(10,0);editor.leaveMovieclip();editor.leaveMovieclip();
  assert.notEqual(editor.figure,shared);assert.equal(editor._movieclipScopes.length,0);
  const saved=JSON.parse(JSON.stringify(editor.report)),reopened=new Editor();reopened.load(saved);close(coordinates(sample(reopened.report,3),uid),coordinates(sample(editor.report,3),uid));
});

test('rig topology inside a captured clip repairs retained source poses and is reversible',()=>{
  const editor=new Editor({propertyChannels:true});editor.select(1);editor.addAnimationKey({kind:'segment',uid:1,handleId:3},'opacity',4,.4);
  editor.createMovieclip({start:0,end:16});const type=editor.figure.figure_type_id;editor.enterMovieclip(type);editor.select(1,2);
  const count=editor.figure.segments.length;editor.splitSegment(.3);assert.equal(editor.figure.segments.length,count+1);
  new Editor().load(JSON.parse(JSON.stringify(editor.report)));
  editor.undo();assert.equal(editor.figure.segments.length,count);new Editor().load(JSON.parse(JSON.stringify(editor.report)));
  editor.redo();editor.leaveMovieclip();new Editor().load(JSON.parse(JSON.stringify(editor.report)));assert.ok(sample(editor.report,7).drawables.length>0);
});

test('library insertion keeps playing across native exposures and remains one undo action',()=>{
  const editor=new Editor({propertyChannels:true});editor.select(1);const clip=editor.createMovieclip({start:0,end:12,replace:false});
  editor.seek(6);const count=editor._undo.length;editor.addFigure(clip.figure_type_id);const uid=editor.selectedUid;
  assert.equal(editor._undo.length,count+1);assert.equal(coordinates(sample(editor.report,5),uid).length,0);
  assert.equal(editor.object._stykMovieclip.end,18);
  for(const tick of [6,10,17])assert.ok(coordinates(sample(editor.report,tick),uid).length);
  editor.undo();assert.equal(coordinates(sample(editor.report,10),uid).length,0);editor.redo();assert.ok(coordinates(sample(editor.report,17),uid).length);
});

test('conversion preserves the complete scene before, inside and after the range',()=>{
  for(const nested of [false,true]){
    const e=new Editor({propertyChannels:true});e.select(1);
    if(nested){e.createMovieclip({start:0,end:40});e.enterMovieclip();e.select(1);}
    const before=structuredClone(e.report);e.createMovieclip({start:3,end:24});
    for(let t=0;t<40;t++)close(scene(sample(e.report,t)),scene(sample(before,t)));
  }
});

test('restart changes phase at the playhead without changing placement or earlier frames',()=>{
  const e=new Editor({propertyChannels:true});e.select(1);e.createMovieclip({start:3,end:24});const uid=e.selectedUid,before=structuredClone(e.report);
  e.seek(10);e.select(uid);e.restartMovieclip();
  assert.equal(e.object._stykMovieclip.start,3);assert.equal(e.object._stykMovieclip.end,24);
  for(let t=0;t<10;t++)close(scene(sample(e.report,t)),scene(sample(before,t)));
  for(let t=10;t<24;t++){e.seek(t);assert.equal(e.evaluatedFrame.objects.find(o=>o.unique_id===uid)._movieclipSample,t-10);}
  const restarted=structuredClone(e.report);e.seek(10);e.select(uid);e.placeMovieclip({start:0,end:21},{move:true});
  for(let t=0;t<21;t++)close(coordinates(sample(e.report,t),uid),coordinates(sample(restarted,t+3),uid));
  e.placeMovieclip({start:7,end:28},{move:true});e.placeMovieclip({start:0,end:21},{move:true});
  for(let t=0;t<35;t++){const g=sample(e.report,t);assert.equal(g.drawables.filter(d=>d.obj.unique_id===uid).length,t<21?10:0);}
  e.undo();e.redo();new Editor().load(JSON.parse(JSON.stringify(e.report)));
});

test('breaking adjacent frames leaves one clip with gaps and exact ordinary poses',()=>{
  const e=new Editor({propertyChannels:true});e.select(1);e.createMovieclip({start:0,end:5});const uid=e.selectedUid,before=structuredClone(e.report),undo=e._undo.length;
  const children=[];
  for(const tick of [0,1]){e.seek(tick);e.select(uid);children.push(e.breakApartMovieclip());}
  assert.equal(e._undo.length,undo+2);
  assert.deepEqual(children[0],children[1]);
  assert.equal(e.animationChannel({kind:'figure',uid:children[0][0]},'pose').keys.length,3);
  for(let t=0;t<30;t++){
    const g=sample(e.report,t);close(scene(g),scene(sample(before,t)));
    assert.equal(coordinates(g,uid).length,t>=2&&t<5?10:0);
    assert.equal(coordinates(g,children[0][0]).length,t<2?10:0);
  }
  const restored=new Editor();restored.load(JSON.parse(JSON.stringify(e.report)));
  for(let t=0;t<6;t++)close(scene(sample(restored.report,t)),scene(sample(e.report,t)));
  e.undo();assert.equal(coordinates(sample(e.report,1),uid).length,10);e.redo();assert.equal(coordinates(sample(e.report,1),uid).length,0);
});

test('split then move backward preserves the full transform curve and never doubles the cut',()=>{
  const e=new Editor({propertyChannels:true});e.select(1);e.createMovieclip({start:0,end:24});const uid=e.selectedUid;
  e.seek(18);e.moveSelection(110,30);const channel=e.animationChannel({kind:'figure',uid},'pose');e.setAnimationKey(channel.id,channel.keys[0].id,{interpolation:'linear'});
  e.seek(7);e.select(uid);e.restartMovieclip();const before=structuredClone(e.report);
  e.seek(9);e.select(uid);e.splitMovieclip();const second=e.selectedUid;
  for(let t=0;t<35;t++)close(scene(sample(e.report,t)),scene(sample(before,t)));
  e.placeMovieclip({start:0,end:15},{move:true});
  for(let t=0;t<15;t++)close(coordinates(sample(e.report,t),second),coordinates(sample(before,t+9),uid));
  e.placeMovieclip({start:9,end:24},{move:true});
  for(let t=0;t<35;t++)close(scene(sample(e.report,t)),scene(sample(before,t)));
});

test('baking a split clip with frame gaps preserves the entire scene and undo/redo',async()=>{
  const e=new Editor({propertyChannels:true});e.select(1);e.createMovieclip({start:2,end:23});const uid=e.selectedUid;
  e.seek(6);e.select(uid);e.breakApartMovieclip();e.seek(9);e.select(uid);e.restartMovieclip();e.seek(12);e.splitMovieclip();
  const before=structuredClone(e.report),second=e.selectedUid;
  await e.bakeMovieclip();
  for(let t=0;t<35;t++){close(scene(sample(e.report,t)),scene(sample(before,t)));assert.equal(coordinates(sample(e.report,t),second).length,0);}
  e.undo();for(let t=0;t<35;t++)close(scene(sample(e.report,t)),scene(sample(before,t)));
  e.redo();for(let t=0;t<35;t++)close(scene(sample(e.report,t)),scene(sample(before,t)));
});

test('Simple Add and Update keep frame breaks on the timeline through mode switches and history',()=>{
  for(const mode of ['add','update']){
    const e=new Editor({propertyChannels:true});e.select(1);e.createMovieclip({start:0,end:5});const uid=e.selectedUid,before=structuredClone(e.report);
    e.enableFrameDrafts({mode});
    for(const t of [0,1]){e.seek(t);e.select(uid);e.breakApartMovieclip();assert.equal(e.frameDraft.dirty,false);}
    e.undo();assert.equal(coordinates(sample(e.report,1),uid).length,10);e.redo();assert.equal(coordinates(sample(e.report,1),uid).length,0);
    e.disableFrameDrafts();assert.equal(e.totalTicks,47);
    for(let t=0;t<30;t++){close(scene(sample(e.report,t)),scene(sample(before,t)));assert.equal(coordinates(sample(e.report,t),uid).length,t>=2&&t<5?10:0);}
  }
});

test('loading early clips gives them an explicit end and upgrades restart poses',()=>{
  const e=new Editor({propertyChannels:true});e.select(1);e.createMovieclip({start:3,end:24});const uid=e.selectedUid;
  e.seek(10);e.select(uid);e.setMovieclipPlayback({start:10,offset:0});
  const old=structuredClone(e.report);
  for(const frame of [...old.keyframes,...Object.values(old._styk.frameSources)])for(const object of frame.objects)if(object.unique_id===uid)object._stykMovieclip.end=null;
  const loaded=new Editor();loaded.load(old);loaded.seek(3);loaded.select(uid);
  assert.equal(loaded.object._stykMovieclip.start,3);assert.equal(loaded.object._stykMovieclip.end,47);
  for(const t of [3,9,10,15]){loaded.seek(t);assert.equal(loaded.evaluatedFrame.objects.find(o=>o.unique_id===uid)._movieclipSample,t<10?t-3:t-10);}
});

test('trim after a restart then move to zero keeps the visible source phase',()=>{
  const e=new Editor({propertyChannels:true});e.select(1);e.createMovieclip({start:0,end:30});const uid=e.selectedUid;
  e.seek(3);e.restartMovieclip();e.placeMovieclip({start:10,offset:10});const before=structuredClone(e.report);
  e.placeMovieclip({start:0,end:20},{move:true});
  for(let t=0;t<20;t++)close(coordinates(sample(e.report,t),uid),coordinates(sample(before,t+10),uid));
});

test('one-frame breaks stay sparse in long animations and share children sources',()=>{
  const e=new Editor({propertyChannels:true});e._selectIds([1,2,3]);e.createMovieclip({start:0,end:40});const uid=e.selectedUid;
  e.placeMovieclip({end:1000});const definitions=e.report.figure_types.length;e.seek(500);const children=e.breakApartMovieclip();
  assert.equal(children.length,3);assert.equal(e.report.figure_types.length,definitions);
  const channels=children.map(uid=>e.animationChannel({kind:'figure',uid},'pose'));
  assert.ok(channels.every(c=>c.keys.length===3));assert.equal(channels[0].keys,channels[1].keys);
  assert.equal(coordinates(sample(e.report,499),uid).length,12);assert.equal(coordinates(sample(e.report,500),uid).length,0);assert.equal(coordinates(sample(e.report,501),uid).length,12);
});

test('Simple Add places new clips at the appended frame and keeps their full duration',()=>{
  for(const library of [false,true]){
    const e=new Editor({propertyChannels:true});e.select(1);
    const asset=library?e.createMovieclip({start:0,end:12,replace:false}):null;
    e.enableFrameDrafts({mode:'add'});
    if(library)e.addFigure(asset.figure_type_id);else e.createMovieclip();
    const uid=e.selectedUid;e.addDraftFrame();const start=e.tick,object=e.evaluatedFrame.objects.find(o=>o.unique_id===uid);
    assert.ok(object);assert.equal(object._stykMovieclip.start,start);assert.ok(object._stykMovieclip.end>start);assert.ok(e.totalTicks>=object._stykMovieclip.end);
    for(let t=start;t<object._stykMovieclip.end;t++)assert.ok(coordinates(sample(e.report,t),uid).length);
    e.undo();e.redo();e.disableFrameDrafts();new Editor().load(JSON.parse(JSON.stringify(e.report)));
    assert.ok(coordinates(sample(e.report,start),uid).length);
  }
});

test('a timeline break preserves an unrelated Update draft and survives discarding that pose',()=>{
  const e=new Editor({propertyChannels:true});e.select(1);e.createMovieclip({start:0,end:5});const uid=e.selectedUid,before=structuredClone(e.report);
  e.enableFrameDrafts({mode:'update'});e.select(3);e.moveSelection(20,0);e.select(uid);e.breakApartMovieclip();
  assert.equal(e.frameDraft.dirty,true);assert.equal(coordinates(sample(e.report,0),uid).length,0);
  e.discardFrameDraft();assert.equal(coordinates(sample(e.report,0),uid).length,0);close(scene(sample(e.report,0)),scene(sample(before,0)));
});

test('clips outside their placement or Once/hide duration leave no selectable ghost',()=>{
  const e=new Editor({propertyChannels:true});e.select(1);e.createMovieclip({start:3,end:8});const uid=e.selectedUid;
  for(const tick of [0,2,8,30]){e.seek(tick);assert.ok(!e.evaluatedFrame.objects.some(o=>o.unique_id===uid));}
  e.seek(3);e.select(uid);e.placeMovieclip({end:20});e.setMovieclipPlayback({mode:'once'},{allFrames:true});e.seek(8);
  assert.ok(!e.evaluatedFrame.objects.some(o=>o.unique_id===uid));
});

test('conversion rejects interleaved stacking later in the range without a partial edit',()=>{
  const e=new Editor({propertyChannels:true});
  for(const frame of e.report.keyframes){frame.object_draw_order=[0,1,2];frame.object_draw_order_unique_ids=frame.objects.map(o=>o.unique_id);}
  e.report.keyframes[1].object_draw_order=[0,2,1];e.report.keyframes[1].object_draw_order_unique_ids=[1,3,2];
  e._invalidate({timing:true});e._selectIds([1,2]);const count=e._undo.length,definitions=e.report.figure_types.length;
  assert.throws(()=>e.createMovieclip({start:0,end:20}),/stacking order/);
  assert.equal(e._undo.length,count);assert.equal(e.report.figure_types.length,definitions);
});
