import {messageError} from './localized-error.mjs';
import {createVfx,vfxStack,vfxProperty,validateVfxStack} from './vfx.mjs';
import {normalizeAnimationTarget} from './animation-channels.mjs';
import {VFX_PRESETS} from './vfx-presets.mjs';
import {effectAvailable} from './vfx-registry.mjs';
import {connectedVfxConflict} from './vfx-connected.mjs';
import {editorDraws} from './editor-draws.mjs';
const copy=value=>structuredClone(value);
function targetFor(editor,target){
  target=normalizeAnimationTarget(target);if(!['scene','figure','segment'].includes(target.kind))throw messageError(new Error(''), "errors.editorVfx.selectAFigureNodeMovieclipOrScene", {});
  const layer=editor.getLayer(target.kind==='scene'?'scene':editor.layerForUid(target.uid));if(layer?.locked)throw messageError(new Error(''), "errors.editorVfx.unlockThisLayerBeforeEditingEffects", {});
  if(editor.animationValue(target,'vfxStack')===undefined)throw messageError(new Error(''), "errors.editorVfx.thisTargetIsNotPresentAtThisFrame", {});return target;
}
function owner(editor,target){return target.kind==='scene'?editor.evaluatedFrame:editor.evaluatedFrame.objects.find(o=>o.unique_id===target.uid);}
const freshId=()=>`fx-${editorDraws.uuid().replaceAll('-','')}`;
export const editorVfxMethods={
  setVfxScope(target,includeAttached){
    target=targetFor(this,target);if(target.kind!=='figure')throw messageError(new Error(''), "errors.editorVfx.selectAWholeFigureToIncludeAttachedParts", {});
    if(typeof includeAttached!=='boolean')throw messageError(new Error(''), "errors.editorVfx.chooseWhetherToIncludeAttachedParts", {});
    const conflict=includeAttached&&connectedVfxConflict(this.evaluatedFrame,target.uid);if(conflict)throw new Error(conflict);
    return this.addAnimationKey(target,'vfxScope',this.tick,Number(includeAttached),{exactTarget:true});
  },
  vfxEffects(target){return vfxStack(owner(this,target),target);},
  addVfx(targets,type){
    if(!Array.isArray(targets))targets=[targets];targets=targets.map(target=>targetFor(this,target));
    if(targets.some(target=>!effectAvailable(type,target.kind==='scene')))throw messageError(new Error(''), "errors.editorVfx.thisEffectIsNotAvailableForTheSelected", {});
    const entries=[],ids=[];for(const target of targets){const stack=this.vfxEffects(target),effect=createVfx(type,freshId());ids.push(effect.id);
      entries.push({target,property:'vfxStack',tick:this.tick,value:validateVfxStack([...stack,effect]),...(this.report._styk?.layerSheet?{}:{interpolation:'constant'}),exactTarget:true});}
    this.addAnimationKeys(entries);return ids;
  },
  changeVfxStack(target,mutate){target=targetFor(this,target);const next=copy(this.vfxEffects(target));mutate(next);return this.addAnimationKey(target,'vfxStack',this.tick,validateVfxStack(next),{exactTarget:true});},
  removeVfx(target,id){return this.changeVfxStack(target,stack=>{const i=stack.findIndex(e=>e.id===id);if(i>=0)stack.splice(i,1);});},
  resetVfx(target,id){return this.changeVfxStack(target,stack=>{const i=stack.findIndex(e=>e.id===id);if(i<0)throw messageError(new Error(''), "errors.editorVfx.theEffectNoLongerExists", {});stack[i]=createVfx(stack[i].type,id);});},
  duplicateVfx(target,id){let newId;this.changeVfxStack(target,stack=>{const i=stack.findIndex(e=>e.id===id);if(i<0)throw messageError(new Error(''), "errors.editorVfx.theEffectNoLongerExists", {});newId=freshId();stack.splice(i+1,0,{...copy(stack[i]),id:newId});});return newId;},
  moveVfx(target,id,direction){if(![-1,1].includes(direction))throw messageError(new Error(''), "errors.editorVfxClips.chooseAnEffectOrder", {});return this.changeVfxStack(target,stack=>{const i=stack.findIndex(e=>e.id===id),j=i+direction;if(i<0||j<0||j>=stack.length)return;[stack[i],stack[j]]=[stack[j],stack[i]];});},
  reorderVfx(target,id,index){return this.changeVfxStack(target,stack=>{const from=stack.findIndex(e=>e.id===id);if(from<0||!Number.isInteger(index)||index<0||index>=stack.length)throw messageError(new Error(''), "errors.editorVfx.invalidEffectPosition", {});const [effect]=stack.splice(from,1);stack.splice(index,0,effect);});},
  pasteVfx(targets,stack,{includeAttached}={}){
    if(!Array.isArray(targets))targets=[targets];const effects=validateVfxStack(stack);
    if(includeAttached!==undefined&&typeof includeAttached!=='boolean')throw messageError(new Error(''), "errors.editorVfx.chooseWhetherToIncludeAttachedParts", {});
    const entries=[];for(const t of targets){const target=targetFor(this,t),next=copy(this.vfxEffects(target)),pasted=[];
      for(const effect of effects){if(!effectAvailable(effect.type,target.kind==='scene'))throw messageError(new Error(''), "errors.editorVfx.thisEffectIsNotAvailableForTheSelected", {});
        const index=next.findIndex(e=>e.id===effect.id),value={...copy(effect),id:index>=0&&next[index].type!==effect.type?freshId():effect.id};
        if(index>=0&&next[index].type===effect.type)next[index]=value;else next.push(value);pasted.push(value);}
      entries.push({target,property:'vfxStack',tick:this.tick,exactTarget:true,value:validateVfxStack(next)});
      if(target.kind==='figure'&&includeAttached!==undefined){
        const conflict=includeAttached&&connectedVfxConflict(this.evaluatedFrame,target.uid);if(conflict)throw new Error(conflict);
        entries.push({target,property:'vfxScope',tick:this.tick,exactTarget:true,value:Number(includeAttached)});
      }
      // Legacy authored scalar channels override pose payloads. Paste must write
      // those values too, with a previous endpoint when the parameter is new.
      if(!this.report._styk?.layerSheet){
        const stackChannel=this.animationChannel(target,'vfxStack',{exactTarget:true});
        let before=-1;for(const key of stackChannel?.keys??[])if(key.tick<this.tick)before=Math.max(before,key.tick);
        for(const row of this.timeline)if(row.start<this.tick)before=Math.max(before,row.start);else break;
        for(const effect of pasted)for(const [param,value] of Object.entries({...effect.params,enabled:Number(effect.enabled)})){
          const property=vfxProperty(effect.type,effect.id,param),channel=this.animationChannel(target,property,{exactTarget:true});
          if(before>=0&&!channel?.keys.some(k=>k.tick<this.tick)){
            const previous=this.animationValue(target,property,before,{exactTarget:true});
            if(previous!==undefined)entries.push({target,property,tick:before,value:previous,exactTarget:true});
          }
          entries.push({target,property,tick:this.tick,value,exactTarget:true});
        }
      }
    }
    return this.addAnimationKeys(entries);
  },
  setVfxParameter(target,id,param,value){target=targetFor(this,target);const effect=this.vfxEffects(target).find(e=>e.id===id);if(!effect)throw messageError(new Error(''), "errors.editorVfx.theEffectNoLongerExists", {});return this.addAnimationKey(target,vfxProperty(effect.type,id,param),this.tick,value,{exactTarget:true});},
  applyVfxPreset(targets,name){
    const preset=VFX_PRESETS[name]?.effects;if(!preset)throw messageError(new Error(''), "errors.editorVfx.chooseAnAvailablePreset", {});if(!Array.isArray(targets))targets=[targets];
    const entries=targets.map(target=>{target=targetFor(this,target);const effects=preset.map(([type,params])=>{const effect=createVfx(type,freshId());return {...effect,params:{...effect.params,...params}};});return {target,property:'vfxStack',tick:this.tick,value:validateVfxStack([...this.vfxEffects(target),...effects]),exactTarget:true};});return this.addAnimationKeys(entries);
  },
};
