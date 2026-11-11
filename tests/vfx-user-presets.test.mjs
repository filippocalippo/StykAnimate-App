import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {vfxProperty} from '../src/vfx.mjs';
import {validateVfxClips} from '../src/vfx-clips.mjs';
import {VfxPresetStore,presetFromClip,clipFromPreset,normalizeUserPresets,USER_PRESET_LIMIT} from '../src/vfx-user-presets.mjs';

const target={kind:'figure',uid:1};
function fixture(){const report=emptyDocument(),fig=report.figure_types[0];report.keyframes=[0,1,2].map(()=>createFrame([createObject(fig,1,120,180),createObject(fig,2,280,180)],10));const e=newOwnedEditor({demo:false,layerTimeline:true}).load(report);return e;}
/** A timed group: Glow with a keyed radius, then Blur, faded in. */
function group(e){
 const id=e.addVfxClip(target,'glow',{start:4,duration:20}),glow=e.getVfxClips().find(c=>c.id===id).effects[0];
 e.addVfxGroupEffect(id,'blur');e.setVfxClip(id,{fadeIn:3,strength:.8});
 e.setVfxClipParameter(id,glow.id,'radius',6,{key:true,tick:4});e.setVfxClipParameter(id,glow.id,'radius',30,{key:true,tick:14});
 return e.getVfxClips().find(c=>c.id===id);
}
const memory=(initial={})=>{const writes=[];let stored=initial;return {writes,read:async()=>structuredClone(stored),write:async value=>{writes.push(value);stored=structuredClone(value);}};};

test('a preset keeps a group’s effects, timing, fades and keys, and adds them to another figure with new ids',()=>{
 const e=fixture(),clip=group(e),preset=presetFromClip(clip,'  Pulse   glow ');
 assert.equal(preset.name,'Pulse glow');assert.equal(preset.effects.length,2);
 const n=e._undo.length,id=e.addVfxUserPreset({kind:'figure',uid:2},preset,{start:9});
 assert.equal(e._undo.length,n+1,'adding a preset is one undo step');
 const added=e.getVfxClips().find(c=>c.id===id);
 assert.deepEqual([added.name,added.start,added.duration,added.fadeIn,added.strength],['Pulse glow',9,20,3,.8]);
 assert.ok(added.effects.every((effect,i)=>effect.id!==clip.effects[i].id&&effect.type===clip.effects[i].type));
 const property=vfxProperty('glow',added.effects[0].id,'radius');
 assert.deepEqual(added.keys[property].map(k=>[k.tick,k.value]),[[0,6],[10,30]],'keys move onto the new effect');
 // The same sampled look, frame for frame, relative to each clip's start.
 for(const delta of [0,5,10,15])assert.deepEqual(e.sampleVfxClip(id,9+delta).map(x=>x.params),e.sampleVfxClip(clip.id,4+delta).map(x=>x.params));
 validateVfxClips(structuredClone(e.report._styk.vfxClips));
 e.undo();assert.equal(e.getVfxClips().some(c=>c.id===id),false);
});

test('a whole-animation preset starts at the first frame; saved data is independent of the project',()=>{
 const e=fixture(),id=e.addVfxClip(target,'outline'),clip=e.getVfxClips().find(c=>c.id===id),preset=presetFromClip(clip,'Line');
 e.setVfxClipParameter(id,clip.effects[0].id,'width',9);
 assert.notEqual(preset.effects[0].params.width,9,'later edits never reach a saved preset');
 const made=clipFromPreset(preset,{kind:'scene'},{start:50});assert.equal(made.start,0);assert.equal(made.duration,null);
});

test('stored presets are normalized: invalid, unknown and duplicate entries are left out, newest first, bounded',()=>{
 const e=fixture(),good=presetFromClip(group(e),'Good',{created:2}),older=presetFromClip(group(e),'Older',{created:1});
 const unknown={...structuredClone(good),id:'x1',effects:[{...good.effects[0],type:'no-such-effect'}]};
 const presets=normalizeUserPresets({presets:[older,good,unknown,{id:'bad'},null,{...good}]});
 assert.deepEqual(presets.map(p=>p.name),['Good','Older']);
 assert.deepEqual(normalizeUserPresets(null),[]);
 const many=Array.from({length:USER_PRESET_LIMIT+5},(_,i)=>({...structuredClone(good),id:`p${i}`,name:`P${i}`,created:i}));
 assert.equal(normalizeUserPresets({presets:many}).length,USER_PRESET_LIMIT);
});

test('the store saves, replaces by name, renames without collisions and deletes, writing every change',async()=>{
 const e=fixture(),io=memory(),store=new VfxPresetStore(io),seen=[];store.subscribe(list=>seen.push(list.length));
 const clip=group(e);
 const saved=await store.save(clip,'Pulse');await store.save(clip,'Flash');
 assert.deepEqual(store.presets.map(p=>p.name),['Flash','Pulse']);
 e.setVfxClip(clip.id,{strength:.3});
 const replaced=await store.save(e.getVfxClips().find(c=>c.id===clip.id),'pulse');
 assert.equal(replaced.id,saved.id,'a name in use replaces that preset in place');assert.equal(store.presets.length,2);assert.equal(store.find(saved.id).strength,.3);
 await assert.rejects(store.rename(saved.id,'FLASH'),/already exists/);
 await store.rename(saved.id,'Soft pulse');assert.equal(store.find(saved.id).name,'Soft pulse');
 await store.remove(saved.id);assert.deepEqual(store.presets.map(p=>p.name),['Flash']);
 assert.deepEqual(io.writes.at(-1).presets.map(p=>p.name),['Flash']);assert.equal(io.writes.at(-1).version,1);
 const reloaded=new VfxPresetStore({read:io.read,write:io.write});await reloaded.load();
 assert.deepEqual(reloaded.presets,store.presets,'what was written loads back');
 assert.ok(seen.length>=5);
});

test('a failed write keeps the previous list and reports the error',async()=>{
 const e=fixture(),store=new VfxPresetStore({read:async()=>({}),write:async()=>{throw new Error('Disk full');}});
 await assert.rejects(store.save(group(e),'Pulse'),/Disk full/);
 assert.deepEqual(store.presets,[]);
});
