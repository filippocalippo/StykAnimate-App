import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {vfxProperty} from '../src/vfx.mjs';
import {vfxVisibleKeys,setVfxVisibleChannels,vfxChannelLabel,vfxChannelGroups,vfxChannelRevision} from '../src/vfx-key-channels.mjs';

function fixture(){const doc=emptyDocument();doc.keyframes=[createFrame([createObject(doc.figure_types[0],1,200,300)],30)];const e=newOwnedEditor({demo:false}).load(doc),id=e.addVfxClip({kind:'figure',uid:1},'glow'),fx=e.getVfxClips()[0].effects[0];for(const param of ['radius','intensity'])for(const tick of [5,10])e.setVfxClipParameter(id,fx.id,param,1,{key:true,tick});return {e,id,clip:()=>e.getVfxClips()[0],radius:vfxProperty('glow',fx.id,'radius'),intensity:vfxProperty('glow',fx.id,'intensity')};}
test('visible key preferences never edit the document or undo history',()=>{
 const {e,clip,radius}=fixture();e.markSaved();const before=e.report._styk.vfxClips,undo=e._undo.length;
 setVfxVisibleChannels(e,clip(),[radius]);assert.deepEqual(e.report._styk.vfxClips,before);assert.equal(e._undo.length,undo);assert.equal(e.dirty,false);assert.equal(vfxChannelLabel(e,clip()),'Radius');
 assert.deepEqual(Object.keys(vfxVisibleKeys(e,clip())),[radius]);assert.equal(vfxVisibleKeys(e,clip())[radius],clip().keys[radius]);assert.equal(vfxVisibleKeys(e,clip()),vfxVisibleKeys(e,{...clip(),start:30}));
 const revision=vfxChannelRevision(e);assert.equal(setVfxVisibleChannels(e,clip(),[radius]),false);assert.equal(vfxChannelRevision(e),revision);
});
test('filtered diamond edits preserve hidden coincident keys and ignore hidden collisions',()=>{
 const {e,id,clip,radius,intensity}=fixture(),original=clip().keys[intensity];e.deleteVfxClipKeys(id,10,{properties:[radius]});
 const before=e.report._styk.vfxClips;e.moveVfxClipKeys(id,5,10,{properties:[radius]});assert.deepEqual(clip().keys[radius].map(k=>k.tick),[10]);assert.equal(clip().keys[intensity],original);
 e.undo();assert.deepEqual(e.report._styk.vfxClips,before);e.deleteVfxClipKeys(id,5,{properties:[radius]});assert.equal(clip().keys[radius],undefined);assert.equal(clip().keys[intensity],original);
});
test('collisions among visible channels reject the entire edit',()=>{
 const {e,id,clip,radius,intensity}=fixture(),before=e.report._styk.vfxClips;
 assert.throws(()=>e.moveVfxClipKeys(id,5,10,{properties:[radius,intensity]}),/already exists/);assert.deepEqual(e.report._styk.vfxClips,before);
 e.deleteVfxClipKeys(id,5,{properties:[]});assert.deepEqual(e.report._styk.vfxClips,before);
});
test('All, None, deleted channels and undo keep their explicit meaning',()=>{
 const {e,id,clip,radius}=fixture();setVfxVisibleChannels(e,clip(),[]);assert.deepEqual(vfxVisibleKeys(e,clip()),{});assert.equal(vfxChannelLabel(e,clip()),'No keys');
 setVfxVisibleChannels(e,clip(),[radius]);const before=clip();e.deleteVfxClipKeys(id,5,{properties:[radius]});e.deleteVfxClipKeys(id,10,{properties:[radius]});assert.deepEqual(vfxVisibleKeys(e,clip()),{});
 e.undo();assert.deepEqual(Object.keys(vfxVisibleKeys(e,clip())),[radius]);setVfxVisibleChannels(e,clip(),null);assert.equal(vfxVisibleKeys(e,clip()),clip().keys);assert.equal(vfxChannelLabel(e,before),'All keys');
});
test('key preferences reset on load and duplicate effect names remain distinct',()=>{
 const {e,id,clip,radius}=fixture();setVfxVisibleChannels(e,clip(),[radius]);const snapshot=structuredClone(e.report);e.load(snapshot);assert.equal(vfxChannelLabel(e,clip()),'All keys');
 const fx=e.addVfxGroupEffect(id,'glow');e.setVfxClipParameter(id,fx,'radius',1,{key:true});assert.deepEqual(vfxChannelGroups(clip()).map(g=>g.name),['Glow 1','Glow 2']);
 const property=vfxProperty('glow',fx,'radius');setVfxVisibleChannels(e,clip(),[property]);assert.equal(vfxChannelLabel(e,clip()),'Glow 2 · Radius');
});

test('selecting a constant value exposes its channel without adding animation or history',()=>{
 const {e,id,clip}=fixture(),property=vfxProperty('glow',clip().effects[0].id,'effectStrength'),before=e.report._styk.vfxClips,history=e._undo.length;
 setVfxVisibleChannels(e,clip(),[property]);assert.equal(vfxChannelLabel(e,clip()),'Effect strength');assert.deepEqual(vfxVisibleKeys(e,clip()),{});assert.deepEqual(e.report._styk.vfxClips,before);assert.equal(e._undo.length,history);
 e.toggleVfxClipKey(id,property);assert.deepEqual(Object.keys(vfxVisibleKeys(e,clip())),[property]);e.undo();assert.deepEqual(vfxVisibleKeys(e,clip()),{});assert.equal(vfxChannelLabel(e,clip()),'Effect strength');
});
