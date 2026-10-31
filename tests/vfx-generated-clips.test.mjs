import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {validateVfxOwner,createVfx,activeVfx,vfxProperty,validateVfxValue} from '../src/vfx.mjs';
import {validateVfxClips} from '../src/vfx-clips.mjs';
import {VFX_PRESETS,presetAvailable} from '../src/vfx-presets.mjs';
import {VFX_REGISTRY,effectAvailable,isGeneratorType} from '../src/vfx-registry.mjs';
import {filterVfxClips} from '../src/vfx-clip-inspector.mjs';
import {clipActive,clipTail} from '../src/vfx-clip-views.mjs';

/** Figure 1 walks right 40px per 20-frame key; figure 2 stands still. */
function fixture(){
 const report=emptyDocument(),fig=report.figure_types[0];
 report.keyframes=[0,1,2,3,4,5,6,7].map(i=>createFrame([createObject(fig,1,120+i*40,300),createObject(fig,2,520,300)],20));
 return newOwnedEditor({demo:false,layerTimeline:true}).load(report);
}

test('generators are timeline-only and never reach filter executors',()=>{
 for(const type of ['particles','aura','beam','explosion','smoke'])assert.equal(isGeneratorType(type),true);
 assert.throws(()=>validateVfxOwner({_stykVfx:{figure:[createVfx('explosion','fx')]}}),/effects timeline/);
 assert.deepEqual(activeVfx([createVfx('explosion','a'),createVfx('glow','b')]).map(e=>e.type),['glow']);
 const e=fixture();e.addVfxClip({kind:'figure',uid:1},'aura',{start:0,duration:20});e.addVfxClip({kind:'figure',uid:1},'glow',{start:0,duration:20});
 validateVfxClips(structuredClone(e.report._styk.vfxClips));
});

test('particles outlive their clip: the engine says for how long and the inspector keeps listing the clip',()=>{
 const e=fixture(),id=e.addVfxClip({kind:'figure',uid:2},'explosion',{start:0,duration:10}),clip=()=>e.getVfxClips()[0];
 const tail=clipTail(e,clip());assert.ok(tail>30,`an explosion's particles last (${tail})`);
 e.seek(5);assert.equal(clipActive(e,clip()),true);
 e.seek(15);assert.equal(clipActive(e,clip()),false,'the clip itself has ended');
 assert.deepEqual(filterVfxClips(e,[clip()],{tick:15}).map(c=>c.id),[id],'its particles are still showing');
 assert.deepEqual(filterVfxClips(e,[clip()],{tick:10+tail+1}).map(c=>c.id),[],'once they are gone the clip is not listed at the playhead');
 // A filter ends with its clip, and a clip with no end has no tail.
 const glow=e.addVfxClip({kind:'figure',uid:2},'glow',{start:0,duration:10}),filter=e.getVfxClips().find(c=>c.id===glow);
 assert.equal(clipTail(e,filter),0);assert.deepEqual(filterVfxClips(e,[filter],{tick:15}).map(c=>c.id),[]);
 const always=e.addVfxClip({kind:'figure',uid:2},'explosion',{duration:null});assert.equal(clipTail(e,e.getVfxClips().find(c=>c.id===always)),0);
});

test('a figure that owns connected effects is measured with the figures attached to it',()=>{
 const e=fixture();e.select(1);e.addVfxClip({kind:'figure',uid:1},'glow',{start:0,duration:20,includeAttached:true});
 e.seek(5);assert.deepEqual(e._shown.vfxGroup(1),[1],'a lone figure is its own group');
 assert.equal(e._shown.vfxGroup(2),null,'a figure with no effects owns none');
 e.seek(25);assert.equal(e._shown.vfxGroup(1),null,'past the clip nothing is connected');
});

test('new generated effects start at the playhead with their own seed and undo as one step',()=>{
 const e=fixture();e.seek(17);const n=e._undo.length;
 const a=e.addVfxClip({kind:'figure',uid:1},'explosion'),b=e.addVfxClip({kind:'figure',uid:1},'explosion'),[ca,cb]=e.getVfxClips();
 assert.deepEqual([ca.start,ca.duration],[17,36]);assert.notEqual(ca.effects[0].params.seed,cb.effects[0].params.seed);
 const smoke=e.addVfxClip({kind:'scene'},'smoke');assert.deepEqual([e.getVfxClips().find(c=>c.id===smoke).start,e.getVfxClips().find(c=>c.id===smoke).duration],[17,72]);
 assert.ok(Object.values(VFX_PRESETS).every(p=>p.effects.every(([type])=>!isGeneratorType(type))),'presets hold filters only');assert.equal(presetAvailable(VFX_PRESETS['Golden hour'],true,effectAvailable),true);
 assert.equal(effectAvailable('aura',true),false);assert.equal(effectAvailable('explosion',true),true);
 assert.equal(e._undo.length,n+3);e.undo();e.undo();e.undo();assert.equal(e.getVfxClips().length,0);assert.ok(a&&b);
});

test('style choices suggest valid values for every option',()=>{
 for(const [type,definition] of Object.entries(VFX_REGISTRY))for(const [param,d] of Object.entries(definition.params)){
  if(!d.applies)continue;
  assert.equal(d.applies.length,d.options.length,`${type}.${param} suggests values for each option`);
  for(const values of d.applies)for(const [key,value] of Object.entries(values))validateVfxValue(vfxProperty(type,'x',key),value);
 }
});
