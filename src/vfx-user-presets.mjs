import {messageError} from './localized-error.mjs';
/**
 * The person's own effect presets: a saved effect clip (one effect or a group)
 * with its settings, timing, fades and keys, kept outside any project so it can
 * be added to any figure or the scene. The model is plain data; `vfxPresetStore`
 * keeps the list and persists it through the desktop bridge (its own
 * vfx-presets.json in the profile, written atomically) or, in the browser
 * build, localStorage.
 */
import {createVfxClip,validateVfxClips} from './vfx-clips.mjs';
import {VFX_LIMIT} from './vfx.mjs';

export const USER_PRESET_LIMIT=60;
export const USER_PRESET_NAME_LENGTH=60;
/** Keys a preset may carry: plenty for a looping pulse, never a whole take. */
const USER_PRESET_KEY_LIMIT=4000;
const STORAGE_KEY='stykanimate.vfx-presets.v1';
const ID=/^[\w-]{1,80}$/;

export const presetName=name=>String(name??'').replace(/\s+/g,' ').trim().slice(0,USER_PRESET_NAME_LENGTH);
const keyCount=keys=>Object.values(keys).reduce((n,list)=>n+list.length,0);

/** A preset of `clip` named `name`: its effects and everything that times or animates them, but not its target. */
export function presetFromClip(clip,name,{id=crypto.randomUUID(),created=Date.now()}={}){
 const title=presetName(name);if(!title)throw messageError(new Error(''), "errors.vfxUserPresets.nameThePreset", {});
 if(keyCount(clip.keys)>USER_PRESET_KEY_LIMIT)throw messageError(new Error(''), "errors.vfxUserPresets.thisEffectHasMoreThanKeysTooMany", {USER_PRESET_KEY_LIMIT: USER_PRESET_KEY_LIMIT});
 const preset={id,name:title,created,effects:structuredClone(clip.effects),strength:clip.strength,fadeIn:clip.fadeIn,fadeOut:clip.fadeOut,duration:clip.duration,offset:clip.duration===null?0:clip.offset,keys:structuredClone(clip.keys)};
 return validPreset(preset);
}

/** The clip a preset makes on `target`, with fresh ids and its keys moved onto them. `start` applies to a timed preset. */
export function clipFromPreset(preset,target,{start=0,includeAttached=false,makeId=()=>crypto.randomUUID()}={}){
 const ids=new Map(preset.effects.map(effect=>[effect.id,makeId()]));
 const clip=createVfxClip(target,preset.effects[0].type,makeId(),makeId(),{includeAttached});
 clip.name=preset.name;clip.strength=preset.strength;clip.fadeIn=preset.fadeIn;clip.fadeOut=preset.fadeOut;
 clip.duration=preset.duration;clip.start=preset.duration===null?0:Math.max(0,Math.min(Math.floor(start),10000000-preset.duration));clip.offset=preset.offset;
 clip.effects=preset.effects.map(effect=>({...structuredClone(effect),id:ids.get(effect.id)}));
 // A key's property names its effect: `vfx1:type:id:param`.
 clip.keys=Object.fromEntries(Object.entries(preset.keys).map(([property,keys])=>{const [prefix,type,id,...param]=property.split(':');return [[prefix,type,ids.get(id),...param].join(':'),structuredClone(keys)];}));
 return clip;
}

/** `preset` when it makes a valid clip, else an error. */
function validPreset(preset){
 if(!preset||typeof preset!=='object'||!ID.test(preset.id??'')||typeof preset.name!=='string'||!presetName(preset.name)||presetName(preset.name)!==preset.name||!Number.isFinite(preset.created))throw messageError(new Error(''), "errors.vfxUserPresets.invalidEffectPreset", {});
 if(!Array.isArray(preset.effects)||!preset.effects.length||preset.effects.length>VFX_LIMIT||!preset.keys||typeof preset.keys!=='object'||keyCount(preset.keys)>USER_PRESET_KEY_LIMIT)throw messageError(new Error(''), "errors.vfxUserPresets.invalidEffectPreset", {});
 validateVfxClips({version:1,clips:[clipFromPreset(preset,{kind:'scene'},{makeId:(n=>()=>`p${n++}`)(0)})]});
 return preset;
}

/** The valid presets of stored data, newest first, at most USER_PRESET_LIMIT; anything unreadable is left out. */
export function normalizeUserPresets(value){
 const list=Array.isArray(value?.presets)?value.presets:[],seen=new Set(),result=[];
 for(const preset of list){try{validPreset(preset);if(seen.has(preset.id))continue;seen.add(preset.id);result.push(preset);}catch{/* one bad preset never hides the others */}}
 return result.sort((a,b)=>b.created-a.created).slice(0,USER_PRESET_LIMIT);
}

/** A list of presets with one persistence path; writes are queued so the newest list always lands last. */
export class VfxPresetStore{
 constructor({read,write}={}){
  const desktop=()=>globalThis.stykDesktop;
  this.read=read??(async()=>desktop()?.getVfxPresets?desktop().getVfxPresets():JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY)||'{}'));
  this.write=write??(async value=>desktop()?.setVfxPresets?desktop().setVfxPresets(value):globalThis.localStorage?.setItem(STORAGE_KEY,JSON.stringify(value)));
  this.presets=[];this.listeners=new Set();this.loading=null;this.pending=Promise.resolve();
 }
 load(){return this.loading??=Promise.resolve().then(()=>this.read()).then(value=>{this.presets=normalizeUserPresets(value);this.emit();return this.presets;},()=>this.presets);}
 subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 emit(){for(const listener of this.listeners)listener(this.presets);}
 find(id){return this.presets.find(p=>p.id===id)??null;}
 named(name){const key=presetName(name).toLocaleLowerCase();return this.presets.find(p=>p.name.toLocaleLowerCase()===key)??null;}
 /** Saves `clip` as `name`; a preset of that name is replaced in place. Resolves once written. */
 async save(clip,name){
  await this.load();const existing=this.named(name);
  if(!existing&&this.presets.length>=USER_PRESET_LIMIT)throw messageError(new Error(''), "errors.vfxUserPresets.youCanKeepUpToPresetsDeleteOne", {USER_PRESET_LIMIT: USER_PRESET_LIMIT});
  const preset=presetFromClip(clip,name,existing?{id:existing.id}:{});
  return this.commit(existing?this.presets.map(p=>p===existing?preset:p):[preset,...this.presets],preset);
 }
 async rename(id,name){
  await this.load();const preset=this.find(id),title=presetName(name);if(!preset||!title)throw messageError(new Error(''), "errors.vfxUserPresets.nameThePreset", {});
  const other=this.named(title);if(other&&other.id!==id)throw messageError(new Error(''), "errors.vfxUserPresets.aPresetNamedAlreadyExists", {name: other.name});
  return this.commit(this.presets.map(p=>p.id===id?{...p,name:title}:p),{...preset,name:title});
 }
 async remove(id){await this.load();return this.commit(this.presets.filter(p=>p.id!==id),null);}
 /** Shows `presets` at once and writes them; a failed write restores the previous list and rejects. */
 commit(presets,result){
  const previous=this.presets;this.presets=presets;this.emit();
  const write=this.pending.catch(()=>{}).then(()=>this.write({version:1,presets}));
  this.pending=write;
  return write.then(()=>result,error=>{if(this.presets===presets){this.presets=previous;this.emit();}throw error;});
 }
}

export const vfxPresetStore=new VfxPresetStore();
