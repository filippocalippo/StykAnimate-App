import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {OnionSkinCache} from '../src/onion-skin.mjs';
import {normalizeEditorSettings} from '../src/settings.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {layerVisible} from '../src/layers.mjs';

function fixture({count=5, objects=3, duration=5, easing=false}={}) {
  const report=emptyDocument();report.auto_easing=easing;
  report.keyframes=Array.from({length:count},(_,i)=>createFrame(Array.from({length:objects},(_,j)=>createObject(report.figure_types[0],j+1,100+i*40+j*200,250)),duration));
  const editor=new Editor({demo:false}).load(report);editor.select(1);return editor;
}
const roots=skins=>skins.map(s=>s.geometry.objects.get(0).root.x);

test('keyframe ghosts follow authored key insertion, edits, retiming, deletion and history',()=>{
  const editor=fixture({count:1,objects:1,duration:30}),target={kind:'figure',uid:1};
  const cache=new OnionSkinCache(),settings=normalizeEditorSettings({onionBefore:1,onionAfter:1});
  editor.seek(10);cache.get(editor,settings); // Enable before any authored keys exist.
  editor.addAnimationKeys([0,5,10,15,20].map(tick=>({target,property:'x',tick,value:100+tick*10})));
  editor.seek(10);
  assert.deepEqual(roots(cache.get(editor,settings)),[150,250]);
  const channel=editor.animationChannel(target,'x'),key=channel.keys.find(key=>key.tick===15);
  editor.setAnimationKey(channel.id,key.id,{value:290});
  assert.deepEqual(roots(cache.get(editor,settings)),[150,290]);
  editor.moveAnimationKeys([{channelId:channel.id,keyIds:[key.id]}],10);
  assert.deepEqual(roots(cache.get(editor,settings)),[150,300]);
  editor.undo();assert.deepEqual(roots(cache.get(editor,settings)),[150,290]);
  editor.redo();assert.deepEqual(roots(cache.get(editor,settings)),[150,300]);
  editor.deleteAnimationKeys([{channelId:channel.id,keyIds:[channel.keys.find(key=>key.tick===20).id]}]);
  assert.deepEqual(roots(cache.get(editor,settings)),[150,290]);
  editor.undo();assert.deepEqual(roots(cache.get(editor,settings)),[150,300]);
});

test('authored key sampling handles between-key playheads, spacing and extended duration',()=>{
  const editor=fixture({count:1,objects:1,duration:1}),target={kind:'figure',uid:1};
  editor.addAnimationKeys([0,5,10,15,20].map(tick=>({target,property:'x',tick,value:100+tick*10})));
  const cache=new OnionSkinCache(),settings=normalizeEditorSettings({onionBefore:1,onionAfter:1});
  editor.seek(12);assert.deepEqual(roots(cache.get(editor,settings)),[200,250]);
  assert.deepEqual(roots(cache.get(editor,{...settings,onionStep:2})),[150,300]);
  editor.seek(10);assert.deepEqual(roots(cache.get(editor,{...settings,onionStep:2})),[100,300]);
  // Output-frame mode still samples adjacent ticks, independent of key spacing.
  assert.deepEqual(roots(cache.get(editor,{...settings,onionMode:'frames'})),[190,210]);
});

test('retimed and deleted pose keys do not leave ghosts at superseded native key times',()=>{
  for(const kind of ['layer','figure']){
    const editor=fixture({count:3,objects:1}),target=kind==='layer'?{kind,id:editor.activeLayerId}:{kind,uid:1};
    const native=editor.nativePoseChannel(target),middle=native.keys[1];
    const cache=new OnionSkinCache(),settings=normalizeEditorSettings({onionBefore:1,onionAfter:1});
    editor.seek(6);cache.get(editor,settings);
    editor.moveAnimationKeys([{channelId:native.id,keyIds:[middle.id]}],2);
    assert.deepEqual(roots(cache.get(editor,settings)),[100,140]);
    editor.deleteAnimationKeys([{channelId:native.id,keyIds:[middle.id]}]);
    assert.deepEqual(roots(cache.get(editor,settings)),[100,180]);
    editor.undo();assert.deepEqual(roots(cache.get(editor,settings)),[100,140]);
  }
});

test('between keys, keyframe ghosts use the immediately preceding and following stored poses',()=>{
  const editor=fixture();editor.seek(12);
  const cache=new OnionSkinCache(),settings=normalizeEditorSettings({onionBefore:1,onionAfter:1});
  assert.deepEqual(roots(cache.get(editor,settings)),[180,220]);
  editor.seek(10);assert.deepEqual(roots(cache.get(editor,settings)),[140,220]);
});

test('Simple frame navigation retains previously sampled neighboring keys',()=>{
  const editor=fixture();editor.enableFrameDrafts();editor.selectFrame(2);
  const cache=new OnionSkinCache(),settings=normalizeEditorSettings();
  const initial=cache.get(editor,settings);editor.selectFrame(3);cache.get(editor,settings);
  editor.selectFrame(2);const builds=cache.stats.builds,back=cache.get(editor,settings);
  assert.equal(cache.stats.builds,builds);assert.equal(initial[0].geometry,back[0].geometry);
});

test('layer visibility refreshes ghosts even when the explicit hidden UID list is unchanged',()=>{
  const editor=fixture();editor.selectFrame(2);
  const cache=new OnionSkinCache(),settings=normalizeEditorSettings();
  const visibility={hidden:{has:uid=>!layerVisible(editor.report,uid)},visibilityKey:[]};
  assert.ok(cache.get(editor,settings,visibility).every(s=>s.geometry.orderedObjects.length===3));
  editor.setLayerVisible('layer-1',false);
  assert.ok(cache.get(editor,settings,visibility).every(s=>s.geometry.orderedObjects.length===0));
  editor.undo();assert.ok(cache.get(editor,settings,visibility).every(s=>s.geometry.orderedObjects.length===3));
});

test('Add ghosts include the stored checkpoint, stay fixed while posing, and follow Add/Update without a document revision',()=>{
  const editor=fixture();editor.enableFrameDrafts();editor.beginFrameDraft({mode:'add',index:4});
  const cache=new OnionSkinCache(),settings=normalizeEditorSettings({onionBefore:2,onionAfter:2});
  const initial=cache.get(editor,settings),builds=cache.stats.builds;
  assert.deepEqual(roots(initial),[220,260]);
  editor.beginDrag();for(let i=0;i<8;i++){editor.moveSelection(5,0);assert.equal(cache.get(editor,settings),initial);}
  editor.commitDrag();assert.equal(cache.stats.builds,builds);assert.equal(initial[1].frame.objects[0].root_x,260);
  editor.addDraftFrame();assert.deepEqual(roots(cache.get(editor,settings)),[260,300]);
  editor.undo();assert.deepEqual(roots(cache.get(editor,settings)),[220,260]);
  editor.redo();assert.deepEqual(roots(cache.get(editor,settings)),[260,300]);
  editor.selectFrame(2);assert.deepEqual(roots(cache.get(editor,settings)),[100,260,140,220]);
});

test('output-frame Add samples the stored pose rather than the moving working copy',()=>{
  const editor=fixture();editor.enableFrameDrafts();editor.beginFrameDraft({mode:'add',index:4});
  editor.moveSelection(100,0);
  const cache=new OnionSkinCache(),settings=normalizeEditorSettings({onionBefore:1,onionAfter:1,onionMode:'frames'});
  assert.deepEqual(roots(cache.get(editor,settings)),[260]);
  editor.commitFrameDraft({mode:'add'});
  assert.deepEqual(roots(cache.get(editor,settings)),[360]);
  editor.commitFrameDraft({mode:'update'});
  assert.ok(roots(cache.get(editor,settings))[0]<360);
});

test('empty Add placeholder has no stored ghosts; zero-duration stored keys remain selectable as key ghosts',()=>{
  const editor=fixture({count:1});editor.enableFrameDrafts({mode:'add',empty:true});
  const cache=new OnionSkinCache(),settings=normalizeEditorSettings();
  assert.deepEqual(cache.get(editor,settings),[]);
  const skipped=fixture();skipped.setFramesDuration([1],0);skipped.selectFrame(2);
  assert.deepEqual(roots(cache.get(skipped,{...settings,onionBefore:1,onionAfter:0})),[140]);
});

test('output ghosts retain untouched tinted figures and rebuild joined descendants with fresh-render parity',()=>{
  const editor=fixture({objects:30});
  for(const frame of editor.report.keyframes)frame.objects[1].join={target_object_slot:0,target_handle_id:1};
  editor.selectFrame(2);
  const cache=new OnionSkinCache(),settings=normalizeEditorSettings({onionMode:'frames'});
  const before=cache.get(editor,settings);
  editor.beginDrag();editor.moveSelection(12,7);
  const after=cache.get(editor,settings),fresh=new OnionSkinCache().get(editor,settings);
  for(let i=0;i<after.length;i++){
    assert.notEqual(after[i].geometry.orderedObjects[0],before[i].geometry.orderedObjects[0]);
    assert.notEqual(after[i].geometry.orderedObjects[1],before[i].geometry.orderedObjects[1]);
    assert.equal(after[i].geometry.orderedObjects[2],before[i].geometry.orderedObjects[2]);
    assert.deepEqual(after[i].geometry.drawables,fresh[i].geometry.drawables);
    assert.equal(after[i].geometry.drawables,after[i].geometry.drawables);
  }
  editor.cancelDrag();assert.deepEqual(roots(cache.get(editor,settings)),roots(new OnionSkinCache().get(editor,settings)));
});

test('auto-easing ghosts invalidate when a neighboring slope control changes',()=>{
  const editor=fixture({easing:true});editor.selectFrame(2);
  const cache=new OnionSkinCache(),settings=normalizeEditorSettings({onionMode:'frames',onionBefore:0,onionAfter:1});
  const before=cache.get(editor,settings);
  editor.selectFrame(1);editor.moveSelection(-15,0);editor.selectFrame(2);
  const after=cache.get(editor,settings),fresh=new OnionSkinCache().get(editor,settings);
  assert.notDeepEqual(roots(before),roots(fresh));
  assert.deepEqual(after.map(s=>s.geometry.drawables),fresh.map(s=>s.geometry.drawables));
});

test('committing and undoing a local pose retain unchanged neighboring keyframe samples',()=>{
  const editor=new Editor();editor.selectFrame(5);
  const cache=new OnionSkinCache(),settings=normalizeEditorSettings();
  const first=cache.get(editor,settings),builds=cache.stats.builds;
  editor.moveSelection(20,0);
  assert.equal(cache.get(editor,settings),first);assert.equal(cache.stats.builds,builds);
  editor.undo();assert.equal(cache.get(editor,settings),first);assert.equal(cache.stats.builds,builds);
  editor.redo();assert.equal(cache.get(editor,settings),first);assert.equal(cache.stats.builds,builds);
});

test('editing an interpolation endpoint invalidates onion samples that depend on it',()=>{
  const editor=new Editor();editor.selectFrame(5);
  const cache=new OnionSkinCache(),settings=normalizeEditorSettings({onionMode:'frames'});
  cache.get(editor,settings);const builds=cache.stats.builds;
  editor.moveSelection(20,0);const changed=cache.get(editor,settings);
  assert.ok(cache.stats.builds>builds);
  const reference=new OnionSkinCache().get(editor,settings);
  assert.deepEqual(changed.map(s=>s.geometry.drawables),reference.map(s=>s.geometry.drawables));
});

test('onion counts, sampling and fade are independent and zero removes either direction',()=>{
  const editor=new Editor();editor.seek(12);const cache=new OnionSkinCache();
  const settings=normalizeEditorSettings({onionBefore:2,onionAfter:1,onionOpacity:.4});
  const skins=cache.get(editor,settings);assert.equal(skins.length,3);assert.deepEqual(skins.map(s=>s.opacity),[.2,.4,.4]);
  assert.equal(cache.get(editor,{...settings,onionBefore:0,onionAfter:0}).length,0);
  assert.equal(cache.get(editor,{...settings,onionBefore:0,onionAfter:2}).length,2);
});
test('opacity and color customization reuse sampled geometry and never mutate source colors',()=>{
  const editor=new Editor();editor.seek(12);const cache=new OnionSkinCache(),settings=normalizeEditorSettings();
  const original=structuredClone(editor.report.keyframes),first=cache.get(editor,settings),builds=cache.stats.builds;
  const second=cache.get(editor,{...settings,onionOpacity:.7});assert.equal(cache.stats.builds,builds);assert.equal(first[0].geometry,second[0].geometry);
  const third=cache.get(editor,{...settings,onionBeforeColor:'#ff0000'});assert.equal(cache.stats.builds,builds);
  assert.deepEqual(third[0].geometry.drawables[0].rgb,[255,0,0]);assert.deepEqual(editor.report.keyframes,original);
});
test('selected scope supports multiple figures and excludes hidden figures',()=>{
  const editor=new Editor();editor.seek(12);const cache=new OnionSkinCache(),settings=normalizeEditorSettings({onionScope:'selected'});
  const skins=cache.get(editor,settings,{selected:new Set([1,2]),hidden:new Set([2])});
  assert(skins.every(s=>s.geometry.drawables.every(d=>d.obj.unique_id===1)));
  assert(cache.get(editor,settings).every(s=>s.geometry.drawables.length===0));
});
test('output-frame sampling uses interpolated poses and keeps its cache bounded',()=>{
  const editor=new Editor(),cache=new OnionSkinCache({maxEntries:6}),settings=normalizeEditorSettings({onionMode:'frames'});
  for(let tick=3;tick<25;tick++){editor.seek(tick);cache.get(editor,settings);}
  assert(cache.samples.size<=6);const builds=cache.stats.builds;cache.invalidate({kind:'edit',live:true,frameIndex:editor.frameIndex});cache.get(editor,settings);assert(cache.stats.builds>builds);
});
test('onion preferences validate colors, scopes, counts and intervals',()=>{
  const value=normalizeEditorSettings({onionBefore:100,onionAfter:-3,onionStep:0,onionBeforeColor:'invalid',onionScope:'wrong'});
  assert.equal(value.onionBefore,10);assert.equal(value.onionAfter,0);assert.equal(value.onionStep,1);assert.equal(value.onionBeforeColor,'#e76b70');assert.equal(value.onionScope,'all');
});

test('show on top changes composition without rebuilding or restyling sampled geometry',()=>{
  const editor=new Editor();editor.seek(12);
  const cache=new OnionSkinCache(),settings=normalizeEditorSettings();
  const behind=cache.get(editor,settings),builds=cache.stats.builds;
  assert.equal(settings.onionShowOnTop,false);
  const top=cache.get(editor,normalizeEditorSettings({...settings,onionShowOnTop:true}));
  assert(top.every(skin=>skin.showOnTop));
  assert.equal(cache.stats.builds,builds);
  assert.equal(top[0].geometry,behind[0].geometry);
  assert(cache.get(editor,settings).every(skin=>!skin.showOnTop));
});
