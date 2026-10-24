import {messageError} from './localized-error.mjs';
import {createVfxClip,validateVfxClips,vfxClips,sampleVfxClip,clipTime,sameVfxTarget} from './vfx-clips.mjs';
import {createVfx,vfxProperty,vfxDescriptor,validateVfxValue} from './vfx.mjs';
import {VFX_PRESETS,GENERATOR_DURATIONS} from './vfx-presets.mjs';
import {isGeneratorType} from './vfx-registry.mjs';
import {normalizeAnimationTarget} from './animation-channels.mjs';
import {connectedVfxConflict} from './vfx-connected.mjs';
import {clipFromPreset} from './vfx-user-presets.mjs';
import {editorDraws} from './editor-draws.mjs';
const id=()=>editorDraws.uuid(),bytes=new WeakMap();
function size(c){let n=bytes.get(c);if(n===undefined){n=JSON.stringify(c).length*2;bytes.set(c,n);}return n;}
function unlocked(editor,target){const layer=editor.getLayer(target.kind==='scene'?'scene':editor.layerForUid(target.uid));if(layer?.locked)throw messageError(new Error(''), "errors.editorVfxClips.unlockBeforeEditingEffects", {name: layer.name});}
function publish(editor,clips,label){
 const before=editor.report._styk.vfxClips??null,after={version:1,clips};validateVfxClips(after,{immutable:true});
 const old=new Set(before?.clips??[]),next=new Set(clips);for(const c of [...old,...next])if(!old.has(c)||!next.has(c))unlocked(editor,c.target);
 if(editor._drag)editor.commitDrag();if(editor._animationEdit)editor.commitAnimationEdit();
 if(editor._vfxClipEdit){editor.report._styk.vfxClips=after;editor._invalidate({timing:true});editor._emit('preview',{vfxClips:true});return true;}
 const beforeSelection=editor._selectionState();editor.report._styk.vfxClips=after;
 const end=Math.max(1,...clips.map(c=>c.duration===null?0:c.start+c.duration)),sheet=editor.report._styk.layerSheet;let layerSheetPatch;
 if(sheet&&end>sheet.duration){const tracks={...sheet.tracks};for(const [key,t] of Object.entries(tracks))if(t.end===sheet.duration)tracks[key]={...t,end};const updated={...sheet,duration:end,tracks};layerSheetPatch={before:sheet,after:updated};editor.report._styk.layerSheet=updated;}
 editor._invalidate({timing:true});
 const changed=[...old].filter(c=>!next.has(c)).concat(clips.filter(c=>!old.has(c)));
 editor._record({kind:'vfx-clips',label,before,after,beforeSelection,afterSelection:editor._selectionState(),timing:true,layerSheetPatch,precomputedBytes:changed.reduce((n,c)=>n+size(c),512)+(old.size+next.size)*8+(layerSheetPatch?Object.keys(sheet.tracks).length*160:0)});
 editor._emit('edit',{label,vfxClips:true,timing:true,frameIndices:[]});return true;
}
/** Generated effects start at the playhead for a useful length; each gets its
 * own random seed so repeated effects never look identical. */
function generatorTiming(editor,effects,duration,options){
 if(!effects.some(e=>isGeneratorType(e.type))||'start' in options||'duration' in options)return options;
 return duration===null?{...options,start:0,duration:null}:{...options,start:Math.max(0,Math.floor(editor.tick)),duration};
}
const seeded=effect=>isGeneratorType(effect.type)&&effect.params.seed===1?{...effect,params:{...effect.params,seed:1+Math.floor(editorDraws.random()*65534)}}:effect;
function find(editor,id){const c=vfxClips(editor.report).find(c=>c.id===id);if(!c)throw messageError(new Error(''), "errors.editorVfxClips.selectAnEffectClip", {});return c;}
function checkScope(editor,clip){if(clip.includeAttached&&clip.target.kind==='figure'){const conflict=connectedVfxConflict(editor.evaluatedFrame,clip.target.uid);if(conflict)throw new Error(conflict);}}
export const editorVfxClipMethods={
 beginVfxClipEdit(){this.commitVfxClipEdit();if(this._animationEdit)this.commitAnimationEdit();this._vfxClipEdit={before:this.report._styk.vfxClips};},
 commitVfxClipEdit(){const edit=this._vfxClipEdit;if(!edit)return false;const after=this.report._styk.vfxClips;this._vfxClipEdit=null;this.report._styk.vfxClips=edit.before;if(after===edit.before)return false;return publish(this,after.clips,'Edit effect');},
 cancelVfxClipEdit(){const edit=this._vfxClipEdit;if(!edit)return false;this._vfxClipEdit=null;this.report._styk.vfxClips=edit.before;this._invalidate({timing:true});this._emit('preview',{vfxClips:true});return true;},
 getVfxClips(target){return vfxClips(this.report).filter(c=>!target||sameVfxTarget(c.target,target));},
 sampleVfxClip(id,tick=this.tick){return sampleVfxClip(find(this,id),tick);},
 addVfxClip(target,type,options={}){target=normalizeAnimationTarget(target);const clip=createVfxClip(target,type,id(),id(),generatorTiming(this,[{type}],GENERATOR_DURATIONS[type]??48,options));clip.effects=clip.effects.map(seeded);checkScope(this,clip);publish(this,[...vfxClips(this.report),clip],'Add effect clip');return clip.id;},
 addVfxGroup(target,preset,options={}){const p=VFX_PRESETS[preset];if(!p)throw messageError(new Error(''), "errors.editorVfxClips.chooseAnEffectPreset", {});const effects=p.effects.map(([type,params])=>{const effect=createVfx(type,id());return seeded({...effect,params:{...effect.params,...params}});});const clip=createVfxClip(normalizeAnimationTarget(target),p.effects[0][0],id(),id(),generatorTiming(this,effects,'duration' in p?p.duration:48,options));checkScope(this,clip);clip.name=preset;clip.effects=effects;publish(this,[...vfxClips(this.report),clip],'Add effect group');return clip.id;},
 /** One of the person's own presets (vfx-user-presets.mjs) on `target`; a timed preset starts at the playhead. */
 addVfxUserPreset(target,preset,options={}){const clip=clipFromPreset(preset,normalizeAnimationTarget(target),{start:options.start??this.tick,includeAttached:Boolean(options.includeAttached),makeId:id});clip.effects=clip.effects.map(seeded);checkScope(this,clip);publish(this,[...vfxClips(this.report),clip],'Add effect preset');return clip.id;},
 setVfxClip(id,patch){const c=find(this,id);if(Object.keys(patch).some(k=>!['name','start','duration','offset','enabled','strength','fadeIn','fadeOut','includeAttached','effects','keys'].includes(k)))throw messageError(new Error(''), "errors.editorVfxClips.unsupportedEffectClipProperty", {});
  if(patch.includeAttached){const conflict=connectedVfxConflict(this.evaluatedFrame,c.target.uid);if(conflict)throw new Error(conflict);}
  const next={...c,...patch};if(Object.keys(patch).every(key=>Object.is(c[key],next[key])))return false;
  return publish(this,vfxClips(this.report).map(item=>item===c?next:item),'Edit effect clip');},
 trimVfxClipStart(id,start){const c=find(this,id);if(c.duration===null)return false;
  start=Math.max(0,Math.min(c.start+c.duration-1,Math.round(start)));const delta=start-c.start,offset=c.offset+delta;
  // Rebase only on commit when revealing time before the source origin. Keys
  // keep their document frames; pointer previews never copy channel arrays.
  const keys=offset<0?Object.fromEntries(Object.entries(c.keys).map(([property,channel])=>[property,channel.map(k=>({...k,tick:k.tick-offset}))])):c.keys;
  return this.setVfxClip(id,{start,duration:c.duration-delta,offset:Math.max(0,offset),keys});},
 deleteVfxClip(id){find(this,id);return publish(this,vfxClips(this.report).filter(c=>c.id!==id),'Delete effect clip');},
 moveVfxClipOrder(id,delta){if(![-1,1].includes(delta))throw messageError(new Error(''), "errors.editorVfxClips.chooseAnEffectOrder", {});const clips=[...vfxClips(this.report)],i=clips.findIndex(c=>c.id===id);if(i<0)return false;let j=i+delta;while(j>=0&&j<clips.length&&!sameVfxTarget(clips[i].target,clips[j].target))j+=delta;if(j<0||j>=clips.length)return false;[clips[i],clips[j]]=[clips[j],clips[i]];return publish(this,clips,'Reorder effects');},
 copyVfxClip(id){const c=find(this,id);this._vfxClipClipboard=structuredClone(c);this._vfxClipClipboardValues=structuredClone(sampleVfxClip(c,this.tick));return true;},
 pasteVfxClip(target,{animation=true,start=Math.floor(this.tick)}={}){const source=this._vfxClipClipboard;if(!source)throw messageError(new Error(''), "errors.editorVfxClips.copyAnEffectClipFirst", {});const map=new Map(source.effects.map(e=>[e.id,id()])),clip={...structuredClone(source),id:id(),target:normalizeAnimationTarget(target),effects:(animation?source.effects:this._vfxClipClipboardValues??source.effects).map(e=>({...e,id:map.get(e.id)})),keys:{}};
  if(animation)for(const [property,keys] of Object.entries(source.keys)){const d=vfxDescriptor(property);clip.keys[vfxProperty(d.effectType,map.get(d.id),d.param)]=structuredClone(keys);}
  if(clip.duration!==null)clip.start=start;publish(this,[...vfxClips(this.report),clip],animation?'Paste effect animation':'Paste effect values');return clip.id;},
 /** Re-targets copied figure clips to pasted identities with fresh clip/effect IDs, shifting timed clips by `shift` frames. */
 _pasteFigureVfxClips(clips,uidMap,typeMap,shift=0){
  const added=[];
  for(const source of clips){
   const uid=uidMap.get(source.target.uid);if(uid===undefined||uid===source.target.uid)continue;
   const effectIds=new Map(source.effects.map(e=>[e.id,id()])),target={...source.target,uid},keys={};
   if(target.figureTypeId!==undefined)target.figureTypeId=typeMap?.get(target.figureTypeId)??target.figureTypeId;
   for(const [property,channel] of Object.entries(source.keys)){const d=vfxDescriptor(property);keys[vfxProperty(d.effectType,effectIds.get(d.id),d.param)]=channel;}
   const clip={...source,id:id(),target,effects:source.effects.map(e=>({...e,id:effectIds.get(e.id)})),keys};
   if(clip.duration!==null){
    // A clip moved before the first frame keeps its phase and end, trimming its start.
    const start=clip.start+shift,cut=Math.max(0,-start);if(cut>=clip.duration||start+clip.duration>10000000)continue;
    Object.assign(clip,{start:start+cut,offset:clip.offset+cut,duration:clip.duration-cut,fadeIn:Math.max(0,clip.fadeIn-cut)});
   }
   added.push(clip);
  }
  return added.length?publish(this,[...vfxClips(this.report),...added],'Paste figure effects'):false;
 },
 duplicateVfxClip(id){this.copyVfxClip(id);const c=find(this,id);return this.pasteVfxClip(c.target,{start:c.duration===null?0:c.start+c.duration});},
 addVfxGroupEffect(id,type){const c=find(this,id),effect=seeded(createVfx(type,editorDraws.uuid()));this.setVfxClip(id,{effects:[...c.effects,effect]});return effect.id;},
 reorderVfxGroupEffect(id,effectId,index){const c=find(this,id),from=c.effects.findIndex(e=>e.id===effectId);if(from<0||!Number.isInteger(index)||index<0||index>=c.effects.length)throw messageError(new Error(''), "errors.editorVfxClips.chooseAnEffectOrder", {});if(from===index)return false;const effects=[...c.effects];effects.splice(index,0,effects.splice(from,1)[0]);return this.setVfxClip(id,{effects});},
 setVfxClipParameter(id,effectId,param,value,options){return this.setVfxClipParameters(id,effectId,{[param]:value},options);},
 // Spatial handles can edit several values. Validate and publish one record,
 // retaining untouched channel arrays and each existing key's easing.
 setVfxClipParameters(id,effectId,values,{key=false,tick=this.tick}={}){const c=find(this,id),effect=c.effects.find(e=>e.id===effectId);if(!effect)throw messageError(new Error(''), "errors.editorVfxClips.selectAnEffect", {});let updated=effect,table=c.keys;
  for(const [param,value] of Object.entries(values)){const property=vfxProperty(effect.type,effectId,param);validateVfxValue(property,value);
   if(key||this.autoKey||c.keys[property]?.length){const time=Math.floor(clipTime(c,tick)),channel=c.keys[property]??[],index=channel.findIndex(k=>k.tick===time),old=channel[index];if(old&&Object.is(old.value,value))continue;
    const keys=[...channel],next={...old,tick:time,value,interpolation:old?.interpolation??(vfxDescriptor(property).discrete?'constant':'linear')};if(index<0)keys.push(next);else keys[index]=next;keys.sort((a,b)=>a.tick-b.tick);table={...table,[property]:keys};
   }else if(param==='enabled'){if(updated.enabled!==Boolean(value))updated={...updated,enabled:Boolean(value)};}
   else if(!Object.is(updated.params[param],value))updated={...updated,params:{...updated.params,[param]:value}};
  }
  if(updated===effect&&table===c.keys)return false;
  return this.setVfxClip(id,{effects:updated===effect?c.effects:c.effects.map(e=>e===effect?updated:e),keys:table});},
 toggleVfxClipKey(id,property,tick=this.tick){const c=find(this,id),time=Math.floor(clipTime(c,tick)),keys=c.keys[property]??[],existing=keys.find(k=>k.tick===time);if(existing){const next={...c.keys,[property]:keys.filter(k=>k!==existing)};if(!next[property].length)delete next[property];return this.setVfxClip(id,{keys:next});}const d=vfxDescriptor(property),effect=sampleVfxClip(c,tick).find(e=>e.id===d.id);return this.setVfxClipParameter(id,d.id,d.param,d.param==='enabled'?+effect.enabled:effect.params[d.param],{key:true,tick});},
 moveVfxClipKey(id,property,from,to){const c=find(this,id),keys=c.keys[property]??[],time=Math.max(0,Math.round(to));if(keys.some(k=>k.tick===time&&k.tick!==from))throw messageError(new Error(''), "errors.editorVfxClips.anEffectKeyAlreadyExistsHere", {});return this.setVfxClip(id,{keys:{...c.keys,[property]:keys.map(k=>k.tick===from?{...k,tick:time}:k).sort((a,b)=>a.tick-b.tick)}});},
 // A diamond edits its visible parameters at this source frame. Check every
 // selected destination before publishing, so collisions cannot split an edit.
 moveVfxClipKeys(id,from,to,{properties=null}={}){
  const c=find(this,id),time=Math.max(0,Math.round(to));if(time===from)return false;
  const keys={...c.keys};let changed=false;
  for(const [property,channel] of Object.entries(c.keys)){
   if(properties&&!properties.includes(property))continue;
   if(!channel.some(k=>k.tick===from))continue;
   if(channel.some(k=>k.tick===time))throw messageError(new Error(''), "errors.editorVfxClips.anEffectKeyAlreadyExistsHere", {});
   keys[property]=channel.map(k=>k.tick===from?{...k,tick:time}:k).sort((a,b)=>a.tick-b.tick);changed=true;
  }
  return changed&&this.setVfxClip(id,{keys});
 },
 deleteVfxClipKeys(id,tick,{properties=null}={}){const c=find(this,id),keys={...c.keys};let changed=false;for(const [property,channel] of Object.entries(c.keys)){if(properties&&!properties.includes(property)||!channel.some(k=>k.tick===tick))continue;const next=channel.filter(k=>k.tick!==tick);if(next.length)keys[property]=next;else delete keys[property];changed=true;}return changed&&this.setVfxClip(id,{keys});},
 setVfxClipEasing(id,property,tick,interpolation){const c=find(this,id);return this.setVfxClip(id,{keys:{...c.keys,[property]:(c.keys[property]??[]).map(k=>k.tick===tick?{tick:k.tick,value:k.value,interpolation}:k)}});},
};
