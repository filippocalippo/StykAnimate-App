import {messageError} from './localized-error.mjs';
import {createVfx,validateVfxStack,validateVfxValue,vfxDescriptor,vfxOwnerKey} from './vfx.mjs';
import {validateKeyEasing} from './keyframe-easing.mjs';

const VFX_CLIP_LIMIT=4096;
const empty=Object.freeze([]),validated=new WeakSet();
export const vfxClips=report=>report?._styk?.vfxClips?.clips??empty;
export const sameVfxTarget=(a,b)=>a.kind===b.kind&&a.uid===b.uid&&a.handleId===b.handleId&&a.figureTypeId===b.figureTypeId;
export const clipContains=(clip,tick)=>clip.duration===null||tick>=clip.start&&tick<clip.start+clip.duration;
export const clipTime=(clip,tick)=>Math.max(0,tick-clip.start+clip.offset);
export function createVfxClip(target,type,id,effectId,{start=0,duration=null,includeAttached=false}={}){
 return {id,name:'',target:{...target},start,duration,offset:0,enabled:true,strength:1,fadeIn:0,fadeOut:0,includeAttached:target.kind==='figure'&&includeAttached,effects:[createVfx(type,effectId)],keys:{}};
}
export function validateVfxClips(state,{immutable=false}={}){
 if(state===undefined)return;
 if(!state||state.version!==1||!Array.isArray(state.clips)||state.clips.length>VFX_CLIP_LIMIT)throw messageError(new Error(''), "errors.vfxClips.invalidEffectsTimeline", {});
 const ids=new Set(),events=new Map();let count=0;
 for(const c of state.clips){
  if(!c||typeof c.id!=='string'||!/^[\w-]{1,80}$/.test(c.id)||ids.has(c.id))throw messageError(new Error(''), "errors.vfxClips.invalidEffectClipIdentity", {});ids.add(c.id);
  if(!immutable||!validated.has(c)){
   const t=c.target;
   if(!t||!['figure','segment','scene'].includes(t.kind)||t.kind!=='scene'&&(!Number.isInteger(t.uid)||t.uid<0)||t.kind==='segment'&&(!Number.isInteger(t.handleId)||t.handleId<1||t.handleId>65535||t.figureTypeId!==undefined&&(!Number.isSafeInteger(t.figureTypeId)||t.figureTypeId<1)))throw messageError(new Error(''), "errors.vfxClips.invalidEffectClipTarget", {});
   if(typeof c.name!=='string'||c.name.length>120||typeof c.enabled!=='boolean'||typeof c.includeAttached!=='boolean'||![c.start,c.offset,c.fadeIn,c.fadeOut].every(n=>Number.isInteger(n)&&n>=0&&n<=10000000)||c.duration!==null&&(!Number.isInteger(c.duration)||c.duration<1||c.start+c.duration>10000000)||c.duration===null&&(c.start!==0||c.offset!==0)||!Number.isFinite(c.strength)||c.strength<0||c.strength>1)throw messageError(new Error(''), "errors.vfxClips.invalidEffectClipTiming", {});
   validateVfxStack(c.effects);
   if(!c.keys||typeof c.keys!=='object'||Array.isArray(c.keys)||Object.keys(c.keys).length>512)throw messageError(new Error(''), "errors.vfxClips.invalidEffectKeys", {});
   for(const [property,keys] of Object.entries(c.keys)){
    const d=vfxDescriptor(property);if(!d?.id||!c.effects.some(e=>e.id===d.id&&e.type===d.effectType)||!Array.isArray(keys)||keys.length>100000)throw messageError(new Error(''), "errors.vfxClips.invalidEffectKeyChannel", {});
    let previous=-1;for(const k of keys){if(!Number.isInteger(k.tick)||k.tick<0||k.tick<=previous||k.tick>10000000)throw messageError(new Error(''), "errors.vfxClips.effectKeysMustBeOrderedAndUnique", {});previous=k.tick;validateVfxValue(property,k.value);validateKeyEasing(k,property);}
   }
   if(immutable)validated.add(c);
  }
  for(const keys of Object.values(c.keys))count+=keys.length;
  if(count>1000000)throw messageError(new Error(''), "errors.vfxClips.tooManyEffectKeys", {});
  const target=`${c.target.kind}/${c.target.uid??''}/${vfxOwnerKey(c.target)}`,list=events.get(target)??[];
  if(c.enabled){list.push([c.start,c.effects.length]);if(c.duration!==null)list.push([c.start+c.duration,-c.effects.length]);}events.set(target,list);
 }
 for(const list of events.values()){let active=0;list.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);for(const [,change] of list){active+=change;if(active>64)throw messageError(new Error(''), "errors.vfxClips.aTargetSupportsUpTo64SimultaneousEffects", {});}}
}
export const vfxFadeAt=(clip,elapsed)=>clip.duration===null?1:Math.min(clip.fadeIn?Math.max(0,Math.min(1,elapsed/clip.fadeIn)):1,clip.fadeOut?Math.max(0,Math.min(1,(clip.duration-elapsed)/clip.fadeOut)):1);
