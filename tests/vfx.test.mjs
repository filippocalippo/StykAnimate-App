import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {createVfx,vfxStack,vfxProperty,validateVfxStack,validateVfxValue,resolvedVfx,VFX_REGISTRY} from '../src/vfx.mjs';
import {VFX_PRESETS,presetAvailable} from '../src/vfx-presets.mjs';
import {validateVfxClips} from '../src/vfx-clips.mjs';
import {isGeneratorType} from '../src/vfx-registry.mjs';
import {validateAnimationDocument} from '../src/animation-channels.mjs';
import {readFileSync} from 'node:fs';
import {effectAvailable} from '../src/vfx-registry.mjs';
function fixture(){const report=emptyDocument(),fig=report.figure_types[0];report.keyframes=[0,1,2].map(()=>createFrame([createObject(fig,1,120,180),createObject(fig,2,280,180)],10));return newOwnedEditor({demo:false,layerTimeline:true}).load(report);}
const target={kind:'figure',uid:1};
/** Keys the stack with `effect` added at the playhead: what `changeVfxStack(target,stack=>stack.push(effect))` does, with the stack as data. */
const pushVfx=(e,effect)=>e.addAnimationKey(target,'vfxStack',e.tick,validateVfxStack([...e.vfxEffects(target),effect]),{exactTarget:true});
test('registry validates effect payloads and rejects malformed/oversized values',()=>{assert.throws(()=>createVfx('bogus','fx1'));assert.throws(()=>validateVfxValue(vfxProperty('glow','fx1','radius'),Infinity));assert.throws(()=>validateVfxStack(Array.from({length:17},(_,i)=>createVfx('glow','f'+i))));assert.throws(()=>validateVfxStack([createVfx('glow','same'),createVfx('blur','same')]));});
test('effects survive edit/undo/reopen and isolate instances',()=>{const editor=fixture();editor.sheetInsertKey([editor.layerForUid(1)],10);editor.seek(10);const before=editor._undo.length,[id]=editor.addVfx(target,'glow');assert.equal(editor._undo.length,before+1);assert.equal(editor.vfxEffects(target)[0].id,id);assert.equal(vfxStack(editor.evaluatedFrame.objects[1]).length,0);editor.seek(5);assert.equal(editor.vfxEffects(target).length,0);editor.seek(10);editor.setVfxParameter(target,id,'radius',22);assert.equal(editor.vfxEffects(target)[0].params.radius,22);editor.undo();assert.equal(editor.vfxEffects(target)[0].params.radius,12);editor.redo();const reopened=newOwnedEditor({demo:false}).load(structuredClone(editor.report));reopened.seek(10);assert.equal(reopened.vfxEffects(target)[0].params.radius,22);validateAnimationDocument(editor.report);});
test('effect preview cancellation restores the original pose',()=>{const editor=fixture(),[id]=editor.addVfx(target,'tint');const property=vfxProperty('tint',id,'mix');editor.beginAnimationEdit(target,property,{exactTarget:true});editor.previewAnimationEdit(.8);assert.equal(editor.vfxEffects(target)[0].params.mix,.8);editor.cancelAnimationEdit();assert.equal(editor.vfxEffects(target)[0].params.mix,.5);});
test('held exposures use the same edit boundary as Properties without creating a VFX timeline',()=>{
 const e=fixture(true),layer=e.layerForUid(1);e.sheetSetEasing([layer],0,29,{interpolation:'constant'});const count=e.report._styk.layerSheet.tracks[layer].keys.length;
 e.seek(5);const [id]=e.addVfx(target,'glow');e.setVfxParameter(target,id,'radius',28);
 assert.equal(e.report._styk.layerSheet.tracks[layer].keys.length,count);assert.equal(e.report._styk.animation,undefined);
 e.seek(0);assert.equal(e.vfxEffects(target)[0].params.radius,28);e.undo();assert.equal(e.vfxEffects(target)[0].params.radius,12);
});
test('existing layer tween and frame insertion own effect timing',()=>{
 const e=fixture(true),layer=e.layerForUid(1),[id]=e.addVfx(target,'glow');
 const effect=structuredClone(e.vfxEffects(target)[0]);e.seek(10);pushVfx(e,effect);e.setVfxParameter(target,id,'radius',32);e.sheetSetEasing([layer],0,0,{interpolation:'linear'});
 e.seek(5);assert.equal(e.vfxEffects(target)[0].params.radius,22);
 e.sheetInsertFrames([layer],0,5);e.seek(10);assert.equal(e.vfxEffects(target)[0].params.radius,22);
});
test('effect order, duplicate, reset and presets use atomic document history',()=>{
 const e=fixture(true),[id]=e.addVfx(target,'glow');e.setVfxParameter(target,id,'radius',30);const duplicate=e.duplicateVfx(target,id);
 e.moveVfx(target,duplicate,-1);assert.equal(e.vfxEffects(target)[0].id,duplicate);e.resetVfx(target,duplicate);assert.equal(e.vfxEffects(target)[0].params.radius,12);
 const count=e._undo.length;e.applyVfxPreset([target,{kind:'figure',uid:2}],'Ghost');assert.equal(e._undo.length,count+1);assert.equal(e.vfxEffects({kind:'figure',uid:2}).length,2);e.undo();assert.equal(e.vfxEffects({kind:'figure',uid:2}).length,0);
});
test('splitting a rig keeps effects on both physical pieces and undo restores ownership',()=>{
 const e=fixture(true);e.select(1,0);const original=e.figure.segments[0].segment_id,type=e.figure.figure_type_id,node={kind:'segment',uid:1,figureTypeId:type,handleId:original};
 e.addVfx(node,'tint');const before=e.serialize();e.splitSegment(.4);const added=e.figure.segments[0].segment_id;
 assert.notEqual(added,original);assert.equal(e.vfxEffects({...node,handleId:added})[0].type,'tint');assert.equal(e.vfxEffects(node)[0].type,'tint');e.undo();assert.deepEqual(e.serialize(),before);
});
test('legacy effects receive compatible defaults without mutating saved poses',()=>{
 const old={version:1,id:'old',type:'outline',enabled:true,params:{color:123,width:3,opacity:1}},snapshot=structuredClone(old),result=resolvedVfx(old);
 assert.equal(result.version,2);assert.equal(result.params.rounded,0);assert.equal(result.params.mode,0);assert.deepEqual(old,snapshot);assert.equal(resolvedVfx(old),result);
});
test('every VFX color supports bounded gradients, alpha, undo and native exposure interpolation',()=>{
 const paint={type:'linear',angle:90,stops:[{offset:0,color:[255,0,0],opacity:.4},{offset:1,color:[0,80,255],opacity:1}]};
 for(const [type,definition] of Object.entries(VFX_REGISTRY))for(const [param,d] of Object.entries(definition.params))if(d.type==='color')assert.deepEqual(validateVfxValue(vfxProperty(type,'test',param),paint),paint);
 const e=fixture(true),layer=e.layerForUid(1),[id]=e.addVfx(target,'glow');e.setVfxParameter(target,id,'color',paint);const before=e.serialize(),effect=structuredClone(e.vfxEffects(target)[0]);e.seek(10);pushVfx(e,effect);const next=structuredClone(paint);next.stops[0].color=[0,255,0];e.setVfxParameter(target,id,'color',next);e.sheetSetEasing([layer],0,0,{interpolation:'linear'});e.seek(5);assert.deepEqual(e.vfxEffects(target)[0].params.color.stops[0].color,[128,128,0]);
 const reopen=newOwnedEditor({demo:false}).load(structuredClone(e.report));reopen.seek(5);assert.deepEqual(reopen.vfxEffects(target),e.vfxEffects(target));assert.ok(before);
 assert.throws(()=>validateVfxValue(vfxProperty('glow',id,'color'),{...paint,stops:Array(33).fill(paint.stops[0])}));
});
test('presets validate, reordering is one history entry, and paste updates matching effect identities',()=>{
 // An older project's per-pose stack takes a preset's filters; one with a generated effect needs a clip and is refused.
 const e=fixture(true);for(const [name,preset] of Object.entries(VFX_PRESETS)){const clean=fixture(true);
  if(preset.effects.some(([type])=>isGeneratorType(type))){assert.throws(()=>clean.applyVfxPreset(target,name),name);continue;}
  if(!presetAvailable(preset,false,effectAvailable))continue;
  clean.applyVfxPreset(target,name);assert.equal(clean.vfxEffects(target).length,preset.effects.length,name);validateVfxStack(clean.vfxEffects(target));}
 e.applyVfxPreset(target,'Neon');const old=e.vfxEffects(target).map(e=>e.id),history=e._undo.length;e.reorderVfx(target,old[0],1);assert.equal(e._undo.length,history+1);assert.deepEqual(e.vfxEffects(target).map(e=>e.id),old.toReversed());e.undo();assert.deepEqual(e.vfxEffects(target).map(e=>e.id),old);e.pasteVfx(target,e.vfxEffects(target));assert.equal(new Set(e.vfxEffects(target).map(e=>e.id)).size,2);
});

// The engine's registry (engine/crates/styk-eval/src/vfx/registry.rs) is the source of every effect's parameters and of which
// effects the scene's stack takes (`Kind::on_scene`); the interface's registry must say the same.
test('the interface registry agrees with the engine registry: parameters, defaults, ranges and the scene catalogue',()=>{
 const rust=readFileSync(new URL('../engine/crates/styk-eval/src/vfx/registry.rs',import.meta.url),'utf8');
 const number=text=>Number(text.trim().replace(/u32$/,''));
 const kinds=new Map();
 for(const block of rust.matchAll(/^ {4}(\w+) = "(\w+)", "[^"]*", "\w+", generator: (true|false), scene_only: (true|false) \{\n([\s\S]*?)^ {4}\}/gm)){
  const params={effectStrength:{default:1,min:0,max:1}};
  for(const field of block[5].matchAll(/^ {8}\w+: \w+ = \("(\w+)", ([^,]+), ([^,]+), ([^)]+)\),$/gm))params[field[1]]={default:number(field[2]),min:number(field[3]),max:number(field[4])};
  kinds.set(block[1],{name:block[2],sceneOnly:block[4]==='true',params});
 }
 assert.equal(kinds.size,Object.keys(VFX_REGISTRY).length,'every effect type');
 for(const {name,sceneOnly,params} of kinds.values()){
  const definition=VFX_REGISTRY[name];
  assert.ok(definition,name);
  assert.deepEqual(Object.keys(definition.params).sort(),Object.keys(params).sort(),`${name}: parameter names`);
  for(const [param,spec] of Object.entries(params)){
   const js=definition.params[param],jsDefault=typeof js.default==='object'?null:js.default;
   if(jsDefault!==null)assert.equal(jsDefault,spec.default,`${name}.${param}: default`);
   assert.equal(js.min,spec.min,`${name}.${param}: minimum`);assert.equal(js.max,spec.max,`${name}.${param}: maximum`);
  }
  assert.equal(Boolean(definition.scene),sceneOnly,`${name}: a camera effect`);
 }
 const onScene=rust.match(/pub fn on_scene\(self\) -> bool \{\s*matches!\(\s*self,([^)]*)\)/);
 assert.ok(onScene,'Kind::on_scene lists the scene effects');
 const scene=new Set([...onScene[1].matchAll(/Kind::(\w+)/g)].map(m=>kinds.get(m[1]).name));
 for(const type of Object.keys(VFX_REGISTRY)){
  assert.equal(effectAvailable(type,true),scene.has(type),`${type} on the scene`);
  assert.equal(effectAvailable(type,false),!VFX_REGISTRY[type].scene&&type!=='vignette',`${type} on a figure`);
 }
});

// Built-in presets (src/vfx-presets.mjs): a moment starts at the playhead and carries its length, fades and keys on the
// new effects; a look lasts the whole animation. Adding one is one undo step and changes no other clip.
test('a built-in moment starts at the playhead with its length, fades and keys, as one undo step',()=>{
 const e=fixture(true);e.addVfxClip(target,'glow');e.seek(7);
 const before=JSON.stringify(e.getVfxClips()),history=e._undo.length;
 const id=e.addVfxGroup(target,'Damage',{}),damage=e.getVfxClips().find(c=>c.id===id),tint=damage.effects[0];
 assert.deepEqual([damage.name,damage.start,damage.duration,damage.fadeIn,damage.fadeOut],['Damage',7,8,0,0]);
 const mix=vfxProperty('tint',tint.id,'mix');
 assert.deepEqual(Object.keys(damage.keys),[mix],'the keys follow the new effect');
 assert.deepEqual(damage.keys[mix].map(k=>[k.tick,k.value,k.interpolation??'linear']),[[0,.85,'ease-out'],[8,0,'linear']]);
 assert.equal(e._undo.length,history+1,'one undo step');
 e.undo();assert.equal(JSON.stringify(e.getVfxClips()),before,'undo leaves the other clips as they were');
 e.redo();assert.deepEqual(e.getVfxClips().find(c=>c.id===id).keys[mix].map(k=>k.value),[.85,0]);
 // Fades, keys on several effects, held jumps, a generated effect.
 const add=name=>{const added=e.addVfxGroup(target,name,{});return e.getVfxClips().find(c=>c.id===added);};
 const flash=add('Hit flash');assert.deepEqual([flash.start,flash.duration,flash.fadeIn,flash.fadeOut],[7,4,0,3]);
 const impact=add('Impact');assert.equal(Object.keys(impact.keys).length,3);assert.ok(Object.keys(impact.keys).every(p=>impact.effects.some(fx=>p.includes(`:${fx.id}:`))));
 const glitch=add('Glitch');assert.ok(Object.values(glitch.keys).every(keys=>keys.slice(0,-1).every(k=>k.interpolation==='constant')),'a glitch jumps');
 const power=add('Power up');assert.deepEqual([power.effects[0].type,power.duration,power.fadeIn,power.fadeOut],['aura',36,3,8]);assert.notEqual(power.effects[0].params.seed,1,'its aura draws its own seed');
 // A look lasts the whole animation.
 const neon=add('Neon');assert.deepEqual([neon.start,neon.duration,Object.keys(neon.keys).length],[0,null,0]);
 // A moment asked to start beyond the timeline's range still fits in it.
 const late=e.addVfxGroup(target,'Teleport',{start:9999999});assert.equal(e.getVfxClips().find(c=>c.id===late).start,10000000-16);
 validateVfxClips(e.report._styk.vfxClips);
});

test('every built-in preset adds a clip that validates, where it is offered',()=>{
 for(const [name,preset] of Object.entries(VFX_PRESETS)){
  const e=fixture(true),scene=!presetAvailable(preset,false,effectAvailable);
  assert.ok(presetAvailable(preset,scene,effectAvailable),`${name} is offered somewhere`);
  e.seek(3);const id=e.addVfxGroup(scene?{kind:'scene'}:target,name,{}),clip=e.getVfxClips().find(c=>c.id===id);
  assert.equal(clip.effects.length,preset.effects.length,name);assert.equal(clip.duration,preset.duration??null,name);
  validateVfxClips(e.report._styk.vfxClips);
 }
 // Weather is the scene's: rain is not offered on a figure, an aura not on the scene.
 assert.equal(presetAvailable(VFX_PRESETS.Rain,false,effectAvailable),false);assert.equal(presetAvailable(VFX_PRESETS['Power up'],true,effectAvailable),false);
});
