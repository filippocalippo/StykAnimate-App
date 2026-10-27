import {effectMessages, presetMessages, categoryMessages} from './vfx-localization.mjs';
import {tupleMessages, messageTuple, localizedAttribute, descriptorAttributes, messageAttributes, messageHTML, localizedMarkup, appendLocalized} from './localization-bindings.mjs';

import {messageError} from './localized-error.mjs';

import {t as interfaceText} from './localization.mjs';

import {clipRowsHTML,clipKeyControls,clipClick,clipChange,selectClip,openClipMenu} from './vfx-clip-inspector.mjs';
import {focusClipBinding,groupDragStart,groupDragOver,groupDrop,groupDragEnd,groupKeydown} from './vfx-clip-controls.mjs';
import {clipActive} from './vfx-clip-views.mjs';
import {connectedVfxConflict} from './vfx-connected.mjs';
import {VFX_REGISTRY, VFX_LIMIT, vfxProperty, resolvedVfx, vfxDescriptor} from './vfx.mjs';
import {effectAvailable} from './vfx-registry.mjs';
import {VFX_PRESETS,PRESET_CATEGORIES,presetAvailable} from './vfx-presets.mjs';
import {vfxPresetStore} from './vfx-user-presets.mjs';
import {MINE,myPresetsSection,openPresetMenu,presetSummaryMessage,usablePresets} from './vfx-preset-ui.mjs';
import {hasEffectPreview,cachedEffectPreview,requestEffectPreview} from './vfx-preset-preview.mjs';
// Generated effects lead the catalogue; other categories keep registry order.
const FIRST_CATEGORIES=['Generate',...PRESET_CATEGORIES],categoryRank=name=>{const i=FIRST_CATEGORIES.indexOf(name);return i<0?FIRST_CATEGORIES.length:i;};
import {vfxPaint} from './vfx-paint.mjs';

import {paintCSS} from './paint.mjs';
import {openColorPicker} from './color-picker.mjs';
import {PropertyControls} from './property-controls.mjs';
import {updateInspectorDOM} from './inspector-dom.mjs';
import {icon} from './icons.mjs';
import {vfxIcon,vfxTile} from './vfx-icons.mjs';
import {sliderFill} from './inspector-kit.mjs';
import {showTimelineMenu} from './timeline-menu.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const identity=(target,id)=>JSON.stringify(target)+'/'+id;
/** UI-only selection, popup and disclosure state; every edit uses the existing exposure transaction. */
export class VfxInspector {
 /** `requestVisible(visible)` asks the shell to show or leave the VFX panel; the shell's dock host shows
  #vfx-panel and calls panelVisible(), and derives the timeline's VFX rows from the panel's visibility. */
 constructor({editor,root,beforeEdit,onChange,onError,requestVisible,context=()=>''}){
  Object.assign(this,{editor,root,beforeEdit,onChange,onError,requestVisible,context});
  this.scope='selection';this.visible=false;this.bindings=new Map();this.abort=new AbortController();this.selected=null;
  this.controls=new PropertyControls(root,{
   canHandle:key=>this.bindings.has(key),
   getValue:key=>this.readBinding(this.bindings.get(key)),
   begin:({key})=>{this.beforeEdit();const b=this.bindings.get(key);if(b.clip){focusClipBinding(this,b);editor.beginVfxClipEdit();return b;}b.stack=structuredClone(editor.vfxEffects(b.target));editor.beginAnimationEdit(b.target,b.derived?'vfxStack':b.property,{exactTarget:true});return b;},
   preview:({key,value,token:b})=>{if(b.clipField){editor.setVfxClip(b.clip,{[b.clipField]:value/b.factor-b.offset});}else if(b.clip){editor.setVfxClipParameter(b.clip,b.id,b.param,value/b.factor);}else if(b.derived){const next=structuredClone(b.stack),effect=next.find(e=>e.id===b.id),p={...resolvedVfx(effect).params},angle=b.param==='angle'?value*Math.PI/180:Math.atan2(p.offsetY,p.offsetX),distance=b.param==='distance'?value:Math.hypot(p.offsetX,p.offsetY);Object.assign(effect.params,{offsetX:Math.max(-256,Math.min(256,Math.cos(angle)*distance)),offsetY:Math.max(-256,Math.min(256,Math.sin(angle)*distance))});editor.previewAnimationEdit(next);}else editor.previewAnimationEdit(value/b.factor);for(const input of root.querySelectorAll('input[data-property]'))if(input.dataset.property===key){input.value=value;input.style.setProperty('--_p',sliderFill(value,input.min,input.max));}this.onChange();},
   commit:()=>{editor.commitVfxClipEdit();editor.commitAnimationEdit();this.sync();this.onChange();},cancel:()=>{editor.cancelVfxClipEdit();editor.cancelAnimationEdit();this.sync();this.onChange();},onError:error=>this.onError(error),
  });
  const listen=(name,fn)=>root.addEventListener(name,e=>this.run(()=>fn.call(this,e)),{signal:this.abort.signal});
  listen('input',function(event){if(event.target.hasAttribute('data-clip-search'))clipChange(this,event);});listen('click',this.click);listen('change',this.change);listen('keydown',this.keydown);listen('dragstart',this.dragstart);listen('dragover',this.dragover);listen('drop',this.drop);listen('dragend',this.dragend);
  listen('property-edit-end',this.sync);listen('contextmenu',this.contextmenu);
  editor.addEventListener('change',({detail})=>{
   if(detail?.kind==='vfx-channels')this.sync();
   if(detail?.kind==='vfx-selection'){this.selectedClip=editor._selectedVfxClip;const clip=editor.getVfxClips().find(c=>c.id===this.selectedClip);if(clip){this.scope=clip.target.kind==='scene'?'scene':clip.target.kind==='figure'?(clip.includeAttached?'connected':'figure'):'selection';if(detail.source==='timeline'&&(this.clipView??'playhead')==='playhead'&&!clipActive(editor,clip))this.clipView='selected';}this.sync();this.onChange();}
   if(detail?.kind==='history'){this.finishForHistory();this.sync();}
   if(['document','selection'].includes(detail?.kind)){this.scope='selection';this.selected=null;this.selectedClip=null;editor._selectedVfxClip=null;editor._selectedVfxKey=null;if(detail.kind==='document')this.clipQuery='';this.closePopup();this.sync();this.onChange();}
  },{signal:this.abort.signal});
  // The person's own presets load once and redraw the panel and an open catalogue when they change.
  const unsubscribe=vfxPresetStore.subscribe(()=>{if(this.visible)this.sync();this.redrawCatalog?.();});this.abort.signal.addEventListener('abort',unsubscribe,{once:true});
  void vfxPresetStore.load();
 }
 bindingEffects(b){return b.clip?this.editor.sampleVfxClip(b.clip):this.editor.vfxEffects(b.target);}
 readBinding(b){if(b.clipField)return (this.editor.getVfxClips().find(c=>c.id===b.clip)[b.clipField]+b.offset)*b.factor;const p=resolvedVfx(this.bindingEffects(b).find(e=>e.id===b.id)).params;return b.derived?(b.param==='angle'?Math.atan2(p.offsetY,p.offsetX)*180/Math.PI:Math.hypot(p.offsetX,p.offsetY)):p[b.param]*b.factor;}
 setVisible(visible){if(this.requestVisible)this.requestVisible(visible);else this.panelVisible(visible);}
 /** The shell showed or hid the VFX panel (panel registry onVisibility). */
 panelVisible(visible){this.commit();this.visible=visible;if(!visible)this.closePopup();this.sync();this.onChange();}
 get active(){return this.controls.active;}
 commit(){this.controls.commit();}
 cancel(){this.controls.cancel();}
 ownsHistoryTarget(target){return Boolean(this.root.contains(target)&&target.matches('input[data-property],select[data-vfx-choice],select[data-clip-easing],input[data-vfx-toggle]'));}
 finishForHistory(){this.commit();const input=this.root.ownerDocument.activeElement;if(this.ownsHistoryTarget(input))input.blur();}
 run(fn){try{fn();}catch(error){this.onError(error);}}
 targets(){const e=this.editor;if(this.scope==='scene'||this.scope==='selection'&&this.context()==='scene')return [{kind:'scene'}];const objects=e.selectedObjects??[];if(!objects.length)return [];if(this.scope==='selection'&&objects.length===1&&e.selectedJoint>=0&&!e.figure?._styk?.movieclip){const segment=e.figure?.segments?.[e.selectedJoint];if(segment)return [{kind:'segment',uid:e.object.unique_id,handleId:segment.segment_id,figureTypeId:e.object.figure_type_id}];}return objects.map(o=>({kind:'figure',uid:o.unique_id}));}
 targetIcon(target){if(target?.kind==='scene')return vfxIcon('camera');if(target?.kind==='segment')return icon('nodes');const object=this.editor.evaluatedFrame?.objects.find(o=>o.unique_id===target?.uid),figure=this.editor.report.figure_types.find(f=>f.figure_type_id===object?.figure_type_id);return figure?._styk?.movieclip?vfxIcon('movieclip'):icon('person');}
 ownerNameMessage(target){if(target.kind==='scene')return {messageKey:'vfxInspector.scene'};const object=this.editor.evaluatedFrame.objects.find(o=>o.unique_id===target.uid),figure=this.editor.report.figure_types.find(f=>f.figure_type_id===object?.figure_type_id),name=figure?.name||{messageKey:'vfxInspector.figure'};return target.kind==='segment'?{messageKey:'vfxInspector.segmentOwner',messageParams:{name,joint:{messageKey:'builderSurfaceUi.jointNumber',messageParams:{id:target.handleId}}}}:name;}
 ownerName(target){const name=this.ownerNameMessage(target);return typeof name==='string'?name:interfaceText(name.messageKey,name.messageParams);}
 ownerNameHTML(target){const name=this.ownerNameMessage(target);return typeof name==='string'?esc(name):messageHTML(name.messageKey,name.messageParams);}
 selectedEffect(){if(!this.visible)return null;if(this.selectedClip){const clip=this.editor.getVfxClips().find(c=>c.id===this.selectedClip);if(!clip||!clipActive(this.editor,clip))return null;const effects=this.editor.sampleVfxClip(clip.id),effect=effects.find(e=>e.id===this.selectedClipEffect)??effects[0];return effect?{target:clip.target,effect,clip:clip.id,includeAttached:clip.includeAttached}:null;}if(!this.selected)return null;const {target,id}=this.selected;if(!this.targets().some(t=>JSON.stringify(t)===JSON.stringify(target)))return null;const effect=this.editor.vfxEffects(target).find(e=>e.id===id);return effect?{target,effect:resolvedVfx(effect)}:null;}
 select(target,id){this.selected={target,id};this.selectedClip=null;this.editor._selectedVfxClip=null;this.editor._selectedVfxKey=null;if(target.kind==='figure')this.scope=this.editor.animationValue(target,'vfxScope')?'connected':'figure';this.editor._emit('vfx-selection');this.sync();this.onChange();}
 isSelected(target,id){return Boolean(this.selected)&&identity(target,id)===identity(this.selected.target,this.selected.id);}
 lockedTarget(target){return this.editor.getLayer(target.kind==='scene'?'scene':this.editor.layerForUid(target.uid))?.locked;}
 /** One parameter row: its scrub label, then its control (a slider and the typed value, a paint, a choice or a switch). */
 field(target,effect,param,d,ownerIndex,locked,derived=false){
  const property=derived?'vfxStack':vfxProperty(effect.type,effect.id,param),key=`${ownerIndex}-${effect.id}-${param}`,factor=d.unit==='%'?100:1,b={target,id:effect.id,param,property,factor,derived,clip:this.renderingClip};this.bindings.set(key,b);
  d={...d,...effectMessages[effect.type]?.params[param]};
  const value=derived?this.readBinding(b):effect.params[param],label=`${VFX_REGISTRY[effect.type].name} ${d.label}`,disabled=locked?' disabled':'';
  if(d.type==='color'){
   const paint=vfxPaint(value),solid=paint.type==='solid',stop=paint.stops[0],hex=stop.color.map(v=>(Math.round(v)).toString(16).padStart(2,'0')).join('').toUpperCase();
   const caption=solid?`${hex}${stop.opacity<1?` · ${Math.round(stop.opacity*100)}%`:''}`:interfaceText("vfxInspector.gradient");
   return `<div class="vfx-row vfx-field"><span class="vfx-label"${descriptorAttributes(d, "label")}>${esc(d.label)}</span><button type="button" class="ui-field vfx-paint" data-color data-size="sm" data-vfx-paint="${key}" aria-label="${esc(label)}" ${messageAttributes("vfxInspector.effectParameterLabel", {effect: {messageKey: effectMessages[effect.type].nameKey}, parameter: d.labelKey ? {messageKey:d.labelKey} : d.label}, "aria-label")}${disabled}><span class="ui-swatch" data-size="sm" style="${solid?'--swatch':'--swatch-paint'}:${esc(paintCSS(paint))}"></span><span class="ui-field-hex">${caption}</span></button></div>`;
  }
  if(d.toggle)return `<div class="vfx-row vfx-field"><label class="vfx-label" for="vfx-field-${key}"${descriptorAttributes(d, "label")}>${esc(d.label)}</label><input type="checkbox" role="switch" class="ui-switch" id="vfx-field-${key}" data-vfx-toggle="${key}" aria-label="${esc(label)}" ${messageAttributes("vfxInspector.effectParameterLabel", {effect: {messageKey: effectMessages[effect.type].nameKey}, parameter: d.labelKey ? {messageKey:d.labelKey} : d.label}, "aria-label")} ${value?'checked':''}${disabled}></div>`;
  if(d.options)return `<div class="vfx-row vfx-field"><label class="vfx-label" for="vfx-field-${key}"${descriptorAttributes(d, "label")}>${esc(d.label)}</label><select class="vfx-select" id="vfx-field-${key}" data-vfx-choice="${key}" aria-label="${esc(label)}" ${messageAttributes("vfxInspector.effectParameterLabel", {effect: {messageKey: effectMessages[effect.type].nameKey}, parameter: d.labelKey ? {messageKey:d.labelKey} : d.label}, "aria-label")}${disabled}>${d.options.map((name,i)=>`<option value="${i}" ${i===value?'selected':''} ${d.optionKeys ? messageAttributes(d.optionKeys[i]) : ''}>${esc(name)}</option>`).join('')}</select></div>`;
  const actual=value*factor,min=d.min*factor,max=d.max*factor,step=d.step*factor,slider=!d.discrete&&max-min<=10000;
  const unit=d.unit?`<span class="ui-field-suffix"${['%','°'].includes(d.unit)?' data-glue':''} aria-hidden="true">${esc(d.unit)}</span>`:'';
  // The typed value comes first in the row, so the scrub label drives it; the grid draws the slider before it.
  return `<div class="vfx-row vfx-parameter${slider?'':' is-number'}" data-property-row="${key}"><label class="vfx-label" data-property-scrub="${key}" for="vfx-field-${key}"${descriptorAttributes(d, "label")}>${esc(d.label)}</label><span class="ui-field vfx-number" data-size="sm"><input class="ui-field-input" type="number" id="vfx-field-${key}" data-property="${key}" data-property-scrub="${key}" data-property-value="${actual}" data-property-step="${step}" data-property-precision="${d.discrete?0:2}" value="${+actual.toFixed(2)}" min="${min}" max="${max}" step="${step}" aria-label="${esc(label)}" ${messageAttributes("vfxInspector.effectParameterLabel", {effect: {messageKey: effectMessages[effect.type].nameKey}, parameter: d.labelKey ? {messageKey:d.labelKey} : d.label}, "aria-label")}${disabled}>${unit}</span>${slider?`<input class="ui-slider vfx-slider" type="range" data-property="${key}" data-property-value="${actual}" data-property-step="${step}" data-property-precision="2" value="${actual}" min="${min}" max="${max}" step="${step}" style="--_p:${sliderFill(actual,min,max)}" aria-label="${esc(label+' slider')}" ${messageAttributes("vfxInspector.effectParameterSlider", {effect: {messageKey: effectMessages[effect.type].nameKey}, parameter: d.labelKey ? {messageKey:d.labelKey} : d.label}, "aria-label")}${disabled}>`:''}</div>`;
 }
 sync(){if(this.syncing){this.syncAgain=true;return;}this.syncing=true;try{this.renderSync();}finally{this.syncing=false;if(this.syncAgain){this.syncAgain=false;queueMicrotask(()=>this.sync());}}}
 renderSync(){
  if(!this.visible||this.active)return;const targets=this.targets(),e=this.editor;this.bindings.clear();
  const scene=targets[0]?.kind==='scene';if(e._vfxTimelineScene!==scene){e._vfxTimelineScene=scene;e._emit('vfx-target');}
  const stacks=targets.map(target=>({target,effects:e.vfxEffects(target).map(resolvedVfx),locked:this.lockedTarget(target)}));
  const warnings=stacks.map(({target})=>{if(target.kind!=='figure')return '';const enabled=Boolean(e.animationValue(target,'vfxScope'))||e.getVfxClips(target).some(c=>c.includeAttached),conflict=enabled&&connectedVfxConflict(e.evaluatedFrame,target.uid);return conflict?`<p class="vfx-note" data-tone="warning" role="status" ${messageAttributes("vfxInspector.effectsCurrentlyApplyToThisPartOnly", {conflict: conflict})}>${esc(conflict)} Effects currently apply to this part only.</p>`:'';}).join('');
  const view=this.clipView??'playhead',query=(this.clipQuery??'').toLowerCase();
  const legacy=stacks.map(s=>({...s,shown:s.effects.filter(effect=>view==='selected'?this.isSelected(s.target,effect.id):view==='all'?!query||VFX_REGISTRY[effect.type].name.toLowerCase().includes(query):(effect.params.effectStrength??1)>0)}));
  const clips=targets.length?clipRowsHTML(this,targets):{html:'',total:0,shown:0};
  const poses=legacy.map(({target,shown,locked},ownerIndex)=>shown.length?`${targets.length>1?`<div class="ui-group-label vfx-owner-name">${this.ownerNameHTML(target)}</div>`:''}${shown.map(effect=>this.poseEntry(target,effect,locked,ownerIndex)).join('')}`:'').join('');
  const total=clips.total+stacks.reduce((n,s)=>n+s.effects.length,0),shown=clips.shown+legacy.reduce((n,s)=>n+s.shown.length,0);
  const locked=stacks.some(s=>s.locked),disabled=!targets.length||locked?' disabled':'';
  const list=clips.html+(poses&&clips.html?`<div class="ui-group-label">${messageHTML("vfxInspector.poseEffects", {})}</div>`:'')+poses;
  // Whenever the Show choice hides effects, one row says so, so they never seem to vanish.
  const more=view==='playhead'&&total>shown?`<button type="button" class="vfx-show-all" data-vfx-action="show-all"><span ${messageAttributes("vfxInspector.moreOnOtherFrames", {value: total-shown})}>${total-shown} more on other frames</span><span class="vfx-show-all-link" data-i18n="vfxInspector.showAll">${messageHTML("vfxInspector.showAll", {})}</span></button>`:'';
  const body=!targets.length?this.noTargetHTML():list?`<div class="vfx-list" role="list" aria-label="Effects" data-i18n-aria-label="vfxInspector.effects">${list}</div>${more}`:this.emptyHTML(total,view,locked);
  const scope=this.scope==='selection'?(scene?'scene':targets[0]?.kind==='segment'?'selection':stacks.some(s=>s.effects.length)&&!stacks.some(s=>e.animationValue(s.target,'vfxScope'))?'figure':'connected'):this.scope;
  const name=!targets.length?messageHTML("vfxInspector.effects"):targets.length>1?messageHTML('counts.figures',{count:targets.length}):this.ownerNameHTML(targets[0]);
  // The head says what receives effects: the target and Apply to. The list's own header says what it shows and adds.
  const head=`<div class="vfx-head"><div class="ui-target-line"><span class="ui-target-kind">${targets.length?this.targetIcon(targets[0]):vfxIcon('effects')}</span><h2 class="ui-target-name">${name}</h2></div></div>`;
  const options=[...(e.selectedJoint>=0?[messageTuple(['selection',interfaceText("vfxInspector.selectedNode")], {1: {key: "vfxInspector.selectedNode", params: {}}})]:[]),messageTuple(['figure',interfaceText("vfxInspector.thisPart")], {1: {key: "vfxInspector.thisPart", params: {}}}),messageTuple(['connected',interfaceText("vfxInspector.wholeFigure")], {1: {key: "vfxInspector.wholeFigure", params: {}}}),messageTuple(['scene',interfaceText("vfxInspector.scene")], {1: {key: "vfxInspector.scene", params: {}}})];
  const paste=(this.clipboard?`<button type="button" class="ui-icon-button" data-size="sm" data-vfx-action="paste" aria-label="Paste effect" data-tooltip="Paste effect"${disabled} data-i18n-aria-label="vfxInspector.pasteEffect" data-i18n-tooltip="vfxInspector.pasteEffect">${icon('clipboard')}</button>`:'')+(e._vfxClipClipboard?`<button type="button" class="ui-icon-button" data-size="sm" data-clip-action="paste" aria-label="Paste animation" data-tooltip="Paste effect animation"${disabled} data-i18n-aria-label="vfxInspector.pasteAnimation" data-i18n-tooltip="vfxInspector.pasteEffectAnimation">${icon('clipboard')}</button>`:'');
  const views=[messageTuple(['playhead',interfaceText("vfxInspector.atThisFrame")], {1: {key: "vfxInspector.atThisFrame", params: {}}}),messageTuple(['selected',interfaceText("vfxInspector.onlySelected")], {1: {key: "vfxInspector.onlySelected", params: {}}}),messageTuple(['all',interfaceText('vfxInspector.showAll2',{total})],{1:{key:'vfxInspector.showAll2',params:{total}}})];
  // With nothing to apply effects to, the empty state's own action is the only control.
  const controls=!targets.length?'':`<div class="vfx-controls"><label class="ui-field vfx-scope" data-select data-size="sm"><span class="ui-field-label" data-i18n="vfxInspector.applyTo">${messageHTML("vfxInspector.applyTo", {})}</span><select class="ui-field-input" id="vfx-scope" aria-label="Effect target" data-i18n-aria-label="vfxInspector.effectTarget">${options.map((_tuple) => {const [value,text] = _tuple; const _messages = tupleMessages(_tuple); return `<option value="${value}" ${scope===value?'selected':''}${_messages[1] ? ' ' + messageAttributes(_messages[1].key, _messages[1].params) : ''}>${text}</option>`;}).join('')}</select>${icon('chevron-down','ui-icon ui-field-chev')}</label></div>`
   +`<div class="vfx-list-head"><h3 class="vfx-list-title" data-i18n="vfxInspector.effects">${messageHTML("vfxInspector.effects", {})}</h3><select class="vfx-view" data-clip-view aria-label="Show effects" data-i18n-aria-label="vfxInspector.showEffects">${views.map((_tuple) => {const [value,text] = _tuple; const _messages = tupleMessages(_tuple); return `<option value="${value}" ${view===value?'selected':''}${_messages[1] ? ' ' + messageAttributes(_messages[1].key, _messages[1].params) : ''}>${text}</option>`;}).join('')}</select><span class="vfx-list-actions">${paste}<button type="button" class="ui-button" data-size="sm" data-variant="outline" data-vfx-action="add" aria-label="Add effect" data-tooltip="Effects and ready-made presets"${disabled} data-i18n-aria-label="vfxInspector.addEffect" data-i18n-tooltip="vfxInspector.effectsAndReadyMadePresets">${icon('plus')}<span class="ui-label" data-i18n="vfxInspector.add">${messageHTML("vfxInspector.add", {})}</span></button></span></div>`;
  const search=view==='all'&&targets.length?`<label class="ui-field vfx-search" data-size="sm">${icon('search','ui-icon')}<input class="ui-field-input" type="search" data-clip-search placeholder="Search effects" aria-label="Search effect clips" value="${esc(this.clipQuery??'')}" data-i18n-placeholder="vfxInspector.searchEffects" data-i18n-aria-label="vfxInspector.searchEffectClips"></label>`:'';
  updateInspectorDOM(this.root,`${head}${controls}<div class="vfx-stack">${search}${warnings}${body}</div><div class="vfx-key-dock">${clipKeyControls(this)}</div>`,{preserveDisclosure:true});
 }
 /** A pose effect from an older project: the same entry as an effect clip, with a grip to reorder. */
 poseEntry(target,effect,locked,ownerIndex){
  const d=VFX_REGISTRY[effect.type],selected=this.isSelected(target,effect.id),dis=locked?' disabled':'';
  const row=`<div class="vfx-effect vfx-item${effect.enabled?'':' is-disabled'}${selected?' is-selected':''}" data-section="vfx-${ownerIndex}-${effect.id}" data-vfx-id="${effect.id}" data-vfx-target="${esc(JSON.stringify(target))}"><button type="button" class="vfx-grip" draggable="${!locked}" data-vfx-drag aria-label="Reorder ${esc(d.name)}" data-tooltip="Drag to reorder · Alt+↑/↓"${dis} ${messageAttributes("vfxInspector.reorder", {name: {messageKey:effectMessages[effect.type].nameKey}}, "aria-label")} data-i18n-tooltip="vfxInspector.dragToReorderAlt">${vfxIcon('grip')}</button><button type="button" class="vfx-item-select vfx-effect-title" data-vfx-action="select" aria-expanded="${selected}">${vfxTile(d.icon,d.category)}<span class="vfx-row-name" ${messageAttributes(effectMessages[effect.type].nameKey)}>${esc(d.name)}</span></button><button type="button" class="ui-icon-button vfx-row-eye" data-size="xs" data-vfx-action="enable" aria-label="${effect.enabled?interfaceText("vfxInspector.disable"):interfaceText("vfxInspector.enable")} ${esc(d.name)}"${effect.enabled?'':' data-on="true"'}${dis} ${messageAttributes('vfxChannels.toggleEffect',{action:{messageKey:effect.enabled?'vfxInspector.disable':'vfxInspector.enable'},name:{messageKey:effectMessages[effect.type].nameKey}},'aria-label')}>${icon(effect.enabled?'eye':'eye-off')}</button><button type="button" class="ui-icon-button vfx-row-more" data-size="xs" data-vfx-action="menu" aria-label="${esc(d.name)} actions" aria-haspopup="menu" ${messageAttributes("vfxInspector.actions", {name: {messageKey:effectMessages[effect.type].nameKey}}, "aria-label")}>${icon('more')}</button>${icon('chevron-right','vfx-chevron')}</div>`;
  return `<div class="vfx-entry${selected?' is-open':''}" role="listitem" data-section="vfx-entry-${ownerIndex}-${effect.id}">${row}${selected?this.poseDetail(target,effect,locked,ownerIndex):''}</div>`;
 }
 /** The selected pose effect's settings, under its row. */
 poseDetail(target,effect,locked,ownerIndex){
  const d=VFX_REGISTRY[effect.type],fields=Object.entries(d.params).filter(([,p])=>!p.when||Object.entries(p.when).every(([key,values])=>values.includes(effect.params[key])));
  const render=entries=>entries.map(([param,p])=>this.field(target,effect,param,p,ownerIndex,locked)).join('');
  const normal=render(fields.filter(([,p])=>!p.advanced)),advanced=render(fields.filter(([,p])=>p.advanced));
  const shadow=effect.type==='shadow'?['angle','distance'].map(param=>this.field(target,effect,param,{label:param==='angle'?interfaceText("vfxInspector.angle"):interfaceText("vfxInspector.distance"), labelKey: (param==='angle' ? "vfxInspector.angle" : "vfxInspector.distance"), labelParams: (param==='angle' ? {} : {}),type:'number',min:param==='angle'?-180:0,max:param==='angle'?180:256,step:1,unit:param==='angle'?'°':'px'},ownerIndex,locked,true)).join(''):'';
  return `<section class="vfx-detail${effect.enabled?'':' is-disabled'}" data-section="vfx-detail-${ownerIndex}-${effect.id}" data-vfx-id="${effect.id}" data-vfx-target="${esc(JSON.stringify(target))}" aria-label="${esc(d.name)} settings" ${messageAttributes("vfxInspector.settings", {name: {messageKey:effectMessages[effect.type].nameKey}}, "aria-label")}><div class="vfx-fields">${normal}${shadow}</div>${advanced?`<details class="vfx-advanced"><summary>${icon('chevron-right')}${messageHTML("vfxInspector.more", {})}</summary><div class="vfx-fields">${advanced}</div></details>`:''}</section>`;
 }
 click(event){
  // Numeric focus selects through PropertyControls.begin. Other controls select
  // on activation, so revealing key navigation cannot move a button mid-click.
  if(!event.target.closest('[data-clip-key],[data-clip-key-property]'))focusClipBinding(this,this.bindings.get(event.target.closest('[data-vfx-binding]')?.dataset.vfxBinding));
  if(clipClick(this,event))return;
  const button=event.target.closest('button');if(!button||button.disabled)return;
  if(button.dataset.vfxPaint){const b=this.bindings.get(button.dataset.vfxPaint),effect=resolvedVfx(this.bindingEffects(b).find(e=>e.id===b.id));this.commit();this.beforeEdit();if(b.clip)focusClipBinding(this,b);else this.select(b.target,b.id);this.closeColor?.();this.closeColor=openColorPicker({anchor:button,paint:vfxPaint(effect.params[b.param]),gradients:true,alpha:true,onChange:paint=>{this.setBinding(b,paint);this.sync();this.onChange();}});return;}
  const action=button.dataset.vfxAction,row=button.closest('[data-vfx-id]');if(!action)return;
  const target=row?JSON.parse(row.dataset.vfxTarget):null,id=row?.dataset.vfxId;
  if(action==='select'){if(!this.isSelected(target,id)){this.select(target,id);return;}this.selected=null;this.editor._emit('vfx-selection');this.sync();this.onChange();return;}
  if(action==='menu'){this.commit();this.openEffectMenu(target,id,{currentTarget:button});return;}
  if(action==='add'){this.addToGroup=null;this.commit();this.openPopup(button,action);return;}
  if(action==='quick'){this.commit();const [mode,key]=button.dataset.vfxQuick.split(':');this.addChoice(mode,key);return;}
  if(action==='show-all'){this.clipView='all';this.sync();return;}
  if(action==='scene'){this.commit();this.scope='scene';this.selected=null;this.sync();this.onChange();return;}
  this.effectAction(action,target,id);
 }
 /** One pose-effect action (its row, its menu or paste) as one undo step. */
 effectAction(action,target,id){
  if(action==='copy'){this.clipboard=structuredClone([this.editor.vfxEffects(target).find(e=>e.id===id)]);this.clipboardScope=target.kind==='figure'?Boolean(this.editor.animationValue(target,'vfxScope')):undefined;this.sync();return;}
  this.commit();this.beforeEdit();
  if(action==='paste')this.editor.pasteVfx(this.targets(),this.clipboard,{includeAttached:this.clipboardScope});
  if(action==='enable'){const effect=this.editor.vfxEffects(target).find(e=>e.id===id);this.editor.setVfxParameter(target,id,'enabled',Number(!effect.enabled));}
  if(action==='remove'){this.editor.removeVfx(target,id);if(this.selected?.id===id)this.selected=null;}
  if(action==='duplicate')this.select(target,this.editor.duplicateVfx(target,id));
  if(action==='reset')this.editor.resetVfx(target,id);
  if(action==='up'||action==='down')this.editor.moveVfx(target,id,action==='up'?-1:1);
  this.sync();this.onChange();
 }
 /** A pose effect's menu (its ⋯, a right-click or Shift+F10): the kit's menu. */
 openEffectMenu(target,id,event){
  const effects=this.editor.vfxEffects(target),index=effects.findIndex(e=>e.id===id),locked=this.lockedTarget(target),run=action=>()=>this.effectAction(action,target,id);
  let menu=this.effectMenu;
  if(!menu){menu=this.effectMenu={editor:this.editor,_run:fn=>this.run(fn)};this.abort.signal.addEventListener('abort',()=>{menu.menuEvents?.abort();menu.menu?.remove();},{once:true});}
  showTimelineMenu(menu,event,[
   [{label:interfaceText("vfxInspector.moveUp"), labelKey: "vfxInspector.moveUp",symbol:'chevron-up',disabled:locked||index<=0,action:run('up')},{label:interfaceText("vfxInspector.moveDown"), labelKey: "vfxInspector.moveDown",symbol:'chevron-down',disabled:locked||index>=effects.length-1,action:run('down')}],
   [{label:interfaceText("vfxInspector.copyEffect"), labelKey: "vfxInspector.copyEffect",symbol:'duplicate',action:run('copy')},{label:interfaceText("common.duplicate"), labelKey: "common.duplicate",symbol:'duplicate',disabled:locked||effects.length>=VFX_LIMIT,action:run('duplicate')}],
   [{label:interfaceText("common.reset"), labelKey: "common.reset",symbol:'reset',disabled:locked,action:run('reset')},{label:interfaceText("common.remove"), labelKey: "common.remove",symbol:'trash',danger:true,disabled:locked,action:run('remove')}],
  ]);
 }
 contextmenu(event){
  const clip=event.target.closest('.vfx-clip[data-clip-id]'),pose=event.target.closest('.vfx-effect[data-vfx-id]'),row=clip??pose;if(!row)return;
  event.preventDefault();this.commit();const at=event.clientX||event.clientY?event:{currentTarget:row};
  if(clip)openClipMenu(this,clip.dataset.clipId,at);else this.openEffectMenu(JSON.parse(pose.dataset.vfxTarget),pose.dataset.vfxId,at);
 }
 setBinding(b,value){return b.clip?this.editor.setVfxClipParameter(b.clip,b.id,b.param,value):this.editor.setVfxParameter(b.target,b.id,b.param,value);}
 change(event){if(clipChange(this,event))return;const input=event.target;if(input.id==='vfx-scope'){
  const scope=input.value;this.commit();this.beforeEdit();const clip=this.root.querySelector('.vfx-clip.is-selected')&&this.editor.getVfxClips().find(c=>c.id===this.selectedClip);
  if(['figure','connected'].includes(scope)){
   if(clip?.target.kind==='figure'&&this.editor.selectedUids.has(clip.target.uid))this.editor.setVfxClip(clip.id,{includeAttached:scope==='connected'});
   else if(!clip)this.editor.movieclipBatch('Change effect target',()=>{for(const object of this.editor.selectedObjects){const target={kind:'figure',uid:object.unique_id};if(this.editor.vfxEffects(target).length)this.editor.setVfxScope(target,scope==='connected');}});
  }
  this.scope=scope;this.selected=null;this.closePopup();this.sync();this.onChange();
 }else if(input.dataset.vfxToggle){const b=this.bindings.get(input.dataset.vfxToggle);this.commit();this.beforeEdit();this.setBinding(b,Number(input.checked));this.sync();this.onChange();
 }else if(input.dataset.vfxChoice){
  // A style choice brings its own suggested colours and settings in the same undo step.
  const b=this.bindings.get(input.dataset.vfxChoice),value=Number(input.value),applies=b.clip&&vfxDescriptor(b.property)?.applies?.[value];this.commit();this.beforeEdit();
  if(applies)this.editor.setVfxClipParameters(b.clip,b.id,{[b.param]:value,...applies});else this.setBinding(b,value);this.sync();this.onChange();}}
 keydown(event){if(groupKeydown(this,event))return;if(event.key==='Escape'){this.closePopup();this.selected=null;this.sync();this.onChange();}if(event.altKey&&["ArrowUp","ArrowDown"].includes(event.key)&&event.target.closest('[data-vfx-drag]')){event.preventDefault();const row=event.target.closest('[data-vfx-id]');this.commit();this.beforeEdit();this.editor.moveVfx(JSON.parse(row.dataset.vfxTarget),row.dataset.vfxId,event.key==='ArrowUp'?-1:1);this.sync();this.onChange();}}
 dragstart(event){if(groupDragStart(this,event))return;const grip=event.target.closest('[data-vfx-drag]');if(!grip){event.preventDefault();return;}const row=grip.closest('[data-vfx-id]');this.dragged={target:row.dataset.vfxTarget,id:row.dataset.vfxId};event.dataTransfer.setData('application/x-styk-vfx',JSON.stringify(this.dragged));event.dataTransfer.effectAllowed='move';row.classList.add('is-dragging');}
 dragover(event){if(groupDragOver(this,event))return;const row=event.target.closest('.vfx-effect[data-vfx-id]');if(!this.dragged||row?.dataset.vfxTarget!==this.dragged.target)return;event.preventDefault();event.dataTransfer.dropEffect='move';for(const item of this.root.querySelectorAll('.is-drop-target'))item.classList.remove('is-drop-target');row.classList.add('is-drop-target');}
 drop(event){if(groupDrop(this,event))return;const row=event.target.closest('.vfx-effect[data-vfx-id]');if(!this.dragged||row?.dataset.vfxTarget!==this.dragged.target)return;event.preventDefault();const target=JSON.parse(this.dragged.target),index=this.editor.vfxEffects(target).findIndex(e=>e.id===row.dataset.vfxId);this.commit();this.beforeEdit();this.editor.reorderVfx(target,this.dragged.id,index);this.dragend();this.sync();this.onChange();}
 dragend(){groupDragEnd(this);this.dragged=null;for(const row of this.root.querySelectorAll('.is-dragging,.is-drop-target'))row.classList.remove('is-dragging','is-drop-target');}
 closePopup(){this.popup?.remove();this.popup=null;}
 /** Add one effect or preset to every current target (or the open group) as one undo step. */
 addChoice(mode,key){
  this.beforeEdit();const targets=this.targets(),options={includeAttached:this.root.querySelector('#vfx-scope')?.value==='connected'};
  const mine=key.startsWith(MINE)&&vfxPresetStore.find(key.slice(MINE.length));if(key.startsWith(MINE)&&!mine)throw messageError(new Error(''), "errors.vfxInspector.thatPresetWasDeleted", {});
  this.editor.movieclipBatch(interfaceText("vfxInspector.addEffects"),()=>{if(this.addToGroup){this.editor.addVfxGroupEffect(this.addToGroup,key);}else for(const target of targets){const id=mine?this.editor.addVfxUserPreset(target,mine,options):mode==='presets'?this.editor.addVfxGroup(target,key,options):this.editor.addVfxClip(target,key,options);selectClip(this,id);}});
  this.addToGroup=null;this.closePopup();this.sync();this.onChange();
 }
 /** Nothing selected: effects need a figure, or the whole scene. */
 noTargetHTML(){return `<div class="ui-empty vfx-empty"><h3 class="ui-empty-title" data-i18n="vfxInspector.selectAFigureToAddEffects">${messageHTML("vfxInspector.selectAFigureToAddEffects", {})}</h3><p class="ui-empty-text" data-i18n="vfxInspector.orGiveTheWholePictureALook">${messageHTML("vfxInspector.orGiveTheWholePictureALook", {})}</p><div class="ui-empty-actions"><button type="button" class="ui-button" data-size="sm" data-variant="outline" data-vfx-action="scene">${vfxIcon('camera')}<span class="ui-label" data-i18n="vfxInspector.sceneEffects">${messageHTML("vfxInspector.sceneEffects", {})}</span></button></div></div>`;}
 /** No effects here: one-click starting points, each drawn as what it is. */
 emptyHTML(total,view,locked){
  const targets=this.targets(),scene=targets[0]?.kind==='scene';
  const effects=(scene?['grade','vignette','bloom','crt']:['glow','outline','shadow','blur']).filter(type=>effectAvailable(type,scene));
  const presets=(scene?['Golden hour','Retro screen']:['Power up','Neon','Hit flash']).filter(name=>VFX_PRESETS[name]&&presetAvailable(VFX_PRESETS[name],scene,effectAvailable));
  const generated=['particles','aura','beam','explosion','smoke'].filter(type=>effectAvailable(type,scene));
  const tile=(mode,key,label,art,category,meta,nameKey=mode==='add'?effectMessages[key]?.nameKey:mode==='presets'?presetMessages[key]?.nameKey:null)=>`<button type="button" class="vfx-suggestion" data-vfx-action="quick" data-vfx-quick="${mode}:${esc(key)}" aria-label="Add ${esc(label)}" ${locked?'disabled':''} ${messageAttributes("vfxInspector.add2", {label: nameKey ? {messageKey:nameKey} : label}, "aria-label")}>${vfxTile(art,category)}<span class="vfx-suggestion-name" ${nameKey ? messageAttributes(nameKey) : ''}>${esc(label)}</span><span class="vfx-suggestion-meta">${typeof meta==='string'?esc(meta):messageHTML(meta.messageKey,meta.messageParams)}</span></button>`;
  const effect=type=>{const d=VFX_REGISTRY[type];return tile('add',type,d.name,d.icon,d.category,{messageKey:d.category==='Generate'?'vfxInspector.generated':categoryMessages[d.category]});};
  const mine=usablePresets(scene).slice(0,3).map(p=>tile('presets',MINE+p.id,p.name,p.effects.length===1?VFX_REGISTRY[p.effects[0].type]?.icon??'effects':'effects',p.effects.length===1?VFX_REGISTRY[p.effects[0].type]?.category??'Looks':'Looks',{messageKey:'vfxInspector.myPresetSummary',messageParams:{summary:presetSummaryMessage(p)}}));
  const elsewhere=view==='playhead'&&total;
  const titleKey=elsewhere?"vfxInspector.noEffectsAtThisFrame":scene?"vfxInspector.noEffectsOnTheScene":targets.length===1?"vfxInspector.noEffectsOnFigure":"vfxInspector.noEffectsYet",titleParams=titleKey==='vfxInspector.noEffectsOnFigure'?{name:this.ownerNameMessage(targets[0])}:{};
  return `<div class="ui-empty vfx-empty"><h3 class="ui-empty-title">${messageHTML(titleKey,titleParams)}</h3>${elsewhere?'':`<p class="ui-empty-text" data-i18n="vfxInspector.startWithOneOfTheseOrChooseAdd">${messageHTML("vfxInspector.startWithOneOfTheseOrChooseAdd", {})}</p>`}${elsewhere?`<div class="ui-empty-actions"><button type="button" class="ui-button" data-size="sm" data-variant="ghost" data-vfx-action="show-all" ${messageAttributes("vfxInspector.showAll2", {total: total})}>Show all ${total}</button></div>`:''}<div class="vfx-suggestions" role="group" aria-label="Suggested effects" data-i18n-aria-label="vfxInspector.suggestedEffects">${[...mine,...effects.map(effect),...generated.map(effect),...presets.map(name=>tile('presets',name,name,VFX_PRESETS[name].icon,'Looks',{messageKey:'vfxInspector.lookSummary',messageParams:{summary:{messageKey:'counts.effects',messageParams:{count:VFX_PRESETS[name].effects.length}}}}))].join('')}</div></div>`;
 }
 openPopup(anchor,mode){
  this.closePopup();const scene=this.targets()[0]?.kind==='scene',popup=this.popup=document.createElement('div');popup.className='vfx-catalog';popup.setAttribute('popover','auto');popup.setAttribute('role','dialog');localizedAttribute(popup, 'aria-label', (mode==='presets' ? "vfxInspector.vfxPresets" : "vfxInspector.addEffect"), (mode==='presets' ? {} : {}));
  const tabs=this.addToGroup?'':`<div class="ui-segmented vfx-catalog-tabs" data-size="sm" data-fill role="tablist" aria-label="Catalogue" data-i18n-aria-label="vfxInspector.catalogue">${[messageTuple(['add',interfaceText("vfxInspector.effects")], {1: {key: "vfxInspector.effects", params: {}}}),messageTuple(['presets',interfaceText("vfxInspector.presets")], {1: {key: "vfxInspector.presets", params: {}}})].map((_tuple) => {const [id,label] = _tuple; const _messages = tupleMessages(_tuple); return `<button type="button" class="ui-segmented-item" role="tab" data-catalog-mode="${id}" aria-selected="${mode===id}"${_messages[1] ? ' ' + messageAttributes(_messages[1].key, _messages[1].params) : ''}>${label}</button>`;}).join('')}</div>`;
  const searchKey=mode==='presets'?'vfxInspector.searchPresets':'vfxInspector.searchEffects';
  localizedMarkup(popup, `<div class="vfx-catalog-top">${tabs}<label class="ui-field vfx-catalog-search" data-size="sm">${icon('search','ui-icon')}<input class="ui-field-input" type="search" ${messageAttributes(searchKey, {}, 'aria-label')} ${messageAttributes(searchKey, {}, 'placeholder')}></label></div><div class="vfx-catalog-results"></div>`);appendLocalized(document.body, popup);popup.showPopover();
  const available=mode==='presets'?Object.entries(VFX_PRESETS).filter(([,p])=>presetAvailable(p,scene,effectAvailable)).map(([name,p])=>({key:name,name,nameKey:presetMessages[name].nameKey,categoryKey:presetMessages[name].categoryKey,icon:p.icon,category:p.category??interfaceText("vfxInspector.presets"),count:p.effects.length,preview:hasEffectPreview(mode,name)})):Object.entries(VFX_REGISTRY).filter(([type])=>effectAvailable(type,scene)).map(([key,d])=>({key,...d,...effectMessages[key],count:1,preview:hasEffectPreview(mode,key)}));
  // Generated effects show a rendered still, filled in as previews finish; the others their glyph in their category's tint.
  const art=item=>{if(!item.preview)return vfxTile(item.icon,item.category,'vfx-catalog-art');const url=cachedEffectPreview(mode,item.key);return `<span class="vfx-catalog-art vfx-catalog-still${url?' has-preview':''}" data-preview="${esc(item.key)}">${url?`<img alt="" src="${url}">`:vfxIcon(item.icon)}</span>`;};
  const draw=()=>{const query=popup.querySelector('input').value.toLowerCase(),items=available.filter(item=>(interfaceText(item.nameKey)+' '+interfaceText(item.categoryKey)).toLowerCase().includes(query));localizedMarkup(popup.querySelector('.vfx-catalog-results'), (mode==='presets'?myPresetsSection(scene,query):'')+[...new Set(items.map(i=>i.category))].sort((a,b)=>categoryRank(a)-categoryRank(b)).map(category=>{const list=items.filter(i=>i.category===category);return `<section><h3 ${messageAttributes(categoryMessages[category])}>${esc(category)}</h3><div class="vfx-catalog-grid${list.every(i=>i.preview)?' is-previews':''}">${list.map(item=>`<button type="button" class="vfx-catalog-card" data-choice="${esc(item.key)}" ${this.addToGroup&&this.editor.getVfxClips().find(c=>c.id===this.addToGroup)?.effects.length+item.count>VFX_LIMIT?'disabled':''}>${art(item)}<span ${messageAttributes(item.nameKey)}>${esc(item.name)}</span>${item.count>1?`<small>${item.count}</small>`:''}</button>`).join('')}</div></section>`;}).join('')||(mode==='presets'&&popup.querySelector('.vfx-my-presets-section')?'':`<div class="vfx-catalog-empty">${messageHTML("common.noResults", {})}</div>`));
   for(const node of popup.querySelectorAll('[data-preview]:not(.has-preview)'))requestEffectPreview(mode,node.dataset.preview,url=>{if(!node.isConnected)return;node.classList.add('has-preview');localizedMarkup(node, `<img alt="" src="${url}">`);});};
  popup.querySelector('input').addEventListener('input',draw);this.redrawCatalog=()=>{if(this.popup===popup)draw();};
  const presetMenu=(event,node)=>{event.preventDefault();event.stopPropagation();openPresetMenu(this,node.dataset.presetMenu??node.querySelector('[data-preset-menu]').dataset.presetMenu,event.clientX||event.clientY?event:{currentTarget:node});};
  popup.addEventListener('contextmenu',event=>{const card=event.target.closest('.vfx-my-preset');if(card)presetMenu(event,card);});
  popup.addEventListener('click',event=>{const more=event.target.closest('[data-preset-menu]');if(more){presetMenu(event,more);return;}const tab=event.target.closest('[data-catalog-mode]');if(tab){if(tab.dataset.catalogMode!==mode)this.openPopup(anchor,tab.dataset.catalogMode);return;}const button=event.target.closest('[data-choice]');if(!button||button.disabled)return;this.run(()=>this.addChoice(mode,button.dataset.choice));});
  popup.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Escape'){this.closePopup();anchor.focus();}if(event.key==='ArrowDown'&&event.target.tagName==='INPUT'){event.preventDefault();popup.querySelector('.vfx-catalog-card:not(:disabled)')?.focus();}});draw();
  // Measure the populated catalogue once so searching keeps the input stationary.
  const panel=this.root.getBoundingClientRect(),from=anchor.getBoundingClientRect();popup.style.width=Math.max(260,panel.width-16)+'px';const size=popup.getBoundingClientRect();
  popup.style.left=Math.max(8,Math.min(panel.left+8,innerWidth-size.width-8))+'px';
  popup.style.top=Math.max(8,Math.min(from.bottom+6,innerHeight-size.height-8))+'px';
  popup.querySelector('input').focus();
 }
 destroy(){this.closeColor?.();this.closePopup();this.controls.destroy();this.abort.abort();}
}
