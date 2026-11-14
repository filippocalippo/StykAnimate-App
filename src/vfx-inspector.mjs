import {effectMessages, presetMessages} from './vfx-localization.mjs';
import {tupleMessages, messageTuple, localizedAttribute, messageAttributes, messageHTML, localizedMarkup, appendLocalized} from './localization-bindings.mjs';

import {messageError} from './localized-error.mjs';

import {t as interfaceText} from './localization.mjs';

import {clipRowsHTML,clipKeyControls,clipClick,clipChange,selectClip,openClipMenu,pasteEffects,resetEffect,shuffleEffect,clipDerivedOffsets} from './vfx-clip-inspector.mjs';
import {focusClipBinding,groupDragStart,groupDragOver,groupDrop,groupDragEnd,groupKeydown} from './vfx-clip-controls.mjs';
import {clipActive} from './vfx-clip-views.mjs';
import {connectedVfxConflict} from './vfx-connected.mjs';
import {VFX_REGISTRY, VFX_LIMIT, resolvedVfx, vfxDescriptor} from './vfx.mjs';
import {effectAvailable} from './vfx-registry.mjs';
import {VFX_PRESETS,presetAvailable} from './vfx-presets.mjs';
import {vfxPresetStore} from './vfx-user-presets.mjs';
import {MINE,myPresetsSection,openPresetMenu,presetSummaryMessage,usablePresets} from './vfx-preset-ui.mjs';
import {hasEffectPreview,cachedEffectPreview,requestEffectPreview} from './vfx-preset-preview.mjs';
import {effectSettingsHTML,derivedValue,derivedOffsets,rememberSection,keyAt} from './vfx-effect-view.mjs';
import {catalogueSections,catalogueKey,presetTiming,isMoment,seeded} from './vfx-presentation.mjs';
import {vfxPaint} from './vfx-paint.mjs';

import {openColorPicker} from './color-picker.mjs';
import {PropertyControls} from './property-controls.mjs';
import {updateInspectorDOM} from './inspector-dom.mjs';
import {icon} from './icons.mjs';
import {vfxIcon,vfxTile} from './vfx-icons.mjs';
import {showTimelineMenu} from './timeline-menu.mjs';
import {findFigureType} from './figure-types.mjs';
import {openStylePicker} from './vfx-style-picker.mjs';
import {attachCatalogPeek} from './vfx-catalog-peek.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const identity=(target,id)=>JSON.stringify(target)+'/'+id;
/** Connected groups nest at most this deep (vfx-connected.mjs, the engine's depth rule). */
const CONNECTED_DEPTH=16;
/** Notices the engine may raise on an effect (setEffectNotice); each has its words in vfxPanel.notice.*. */
const NOTICE_KINDS=Object.freeze({reduced:{key:'vfxPanel.notice.reduced',tone:'info'}});
/** UI-only selection, popup and disclosure state; every edit uses the existing exposure transaction. */
export class VfxInspector {
 /** `requestVisible(visible)` asks the shell to show or leave the VFX panel; the shell's dock host shows
  #vfx-panel and calls panelVisible(), and derives the timeline's VFX rows from the panel's visibility. */
 constructor({editor,root,beforeEdit,onChange,onError,requestVisible,context=()=>''}){
  Object.assign(this,{editor,root,beforeEdit,onChange,onError,requestVisible,context});
  this.scope='selection';this.visible=false;this.bindings=new Map();this.abort=new AbortController();this.selected=null;this.effectNotices=new Map();
  this.controls=new PropertyControls(root,{
   canHandle:key=>this.bindings.has(key),
   getValue:key=>this.readBinding(this.bindings.get(key)),
   begin:({key})=>{this.beforeEdit();const b=this.bindings.get(key);if(b.clip){focusClipBinding(this,b);editor.beginVfxClipEdit();return b;}b.stack=structuredClone(editor.vfxEffects(b.target));editor.beginAnimationEdit(b.target,b.derived?'vfxStack':b.property,{exactTarget:true});return b;},
   // A preview edits the effect and nothing else: PropertyControls draws the value, its fill and its dial, so the panel is not rebuilt while a value moves.
   preview:({value,token:b})=>{
    if(b.clipField)editor.setVfxClip(b.clip,{[b.clipField]:value/b.factor-b.offset});
    else if(b.clip&&b.derived)editor.setVfxClipParameters(b.clip,b.id,clipDerivedOffsets(this,b,value));
    else if(b.clip)editor.setVfxClipParameter(b.clip,b.id,b.param,value/b.factor);
    else if(b.derived){const next=structuredClone(b.stack),effect=next.find(e=>e.id===b.id);Object.assign(effect.params,derivedOffsets(b.derived,value,resolvedVfx(effect).params));editor.previewAnimationEdit(next);}
    else editor.previewAnimationEdit(value/b.factor);
    this.onChange();
   },
   commit:()=>{editor.commitVfxClipEdit();editor.commitAnimationEdit();this.sync();this.onChange();},cancel:()=>{editor.cancelVfxClipEdit();editor.cancelAnimationEdit();this.sync();this.onChange();},onError:error=>this.onError(error),
  });
  const listen=(name,fn,options={})=>root.addEventListener(name,e=>this.run(()=>fn.call(this,e)),{signal:this.abort.signal,...options});
  listen('input',function(event){if(event.target.hasAttribute('data-clip-search'))clipChange(this,event);});listen('click',this.click);listen('change',this.change);listen('keydown',this.keydown);listen('dragstart',this.dragstart);listen('dragover',this.dragover);listen('drop',this.drop);listen('dragend',this.dragend);
  listen('property-edit-end',this.sync);listen('contextmenu',this.contextmenu);
  // A titled section remembers that a person opened it, for this kind of effect (`toggle` does not bubble).
  listen('toggle',event=>{const section=event.target;if(section.matches?.('details[data-vfx-section]'))rememberSection(section.dataset.vfxType,section.dataset.vfxSection,section.open);if(section.matches?.('details[data-vfx-section]')&&section.open)this.sync();},{capture:true});
  editor.addEventListener('change',({detail})=>{
   if(detail?.kind==='vfx-channels')this.sync();
   if(detail?.kind==='vfx-selection'){this.selectedClip=editor._selectedVfxClip;const clip=editor.getVfxClips().find(c=>c.id===this.selectedClip);if(clip){this.scope=clip.target.kind==='scene'?'scene':clip.target.kind==='figure'?(clip.includeAttached?'connected':'figure'):'selection';if(detail.source==='timeline'&&(this.clipView??'playhead')==='playhead'&&!clipActive(editor,clip))this.clipView='selected';}this.sync();this.onChange();}
   if(detail?.kind==='history'){this.finishForHistory();this.sync();}
   if(['document','selection'].includes(detail?.kind)){this.scope='selection';this.selected=null;this.selectedClip=null;editor._selectedVfxClip=null;editor._selectedVfxKey=null;if(detail.kind==='document'){this.clipQuery='';this.effectNotices.clear();}this.closePopup();this.sync();this.onChange();}
  },{signal:this.abort.signal});
  // The person's own presets load once and redraw the panel and an open catalogue when they change.
  const unsubscribe=vfxPresetStore.subscribe(()=>{if(this.visible)this.sync();this.redrawCatalog?.();});this.abort.signal.addEventListener('abort',unsubscribe,{once:true});
  void vfxPresetStore.load();
 }
 /**
  * A short notice on an effect clip, or none: what the engine says about how it drew it. `notice` is
  * {kind: 'reduced'} (drawn at reduced quality to fit the graphics memory), optionally with `effect` (one effect of a
  * group), or null to clear. The engine's signal is wired by a later task (docs/VFX-DESIGN.md, "Notices").
  */
 setEffectNotice(clipId,notice){
  const kind=notice&&NOTICE_KINDS[notice.kind];
  if(notice&&!kind)throw messageError(new TypeError(''), "errors.vfxInspector.unknownEffectNotice", {value:String(notice.kind)});
  const before=JSON.stringify(this.effectNotices.get(clipId)??null);
  if(kind)this.effectNotices.set(clipId,[{...kind,effect:notice.effect??null}]);else this.effectNotices.delete(clipId);
  if(JSON.stringify(this.effectNotices.get(clipId)??null)!==before&&this.visible)this.sync();
 }
 bindingEffects(b){return b.clip?this.editor.sampleVfxClip(b.clip):this.editor.vfxEffects(b.target);}
 readBinding(b){if(b.clipField)return (this.editor.getVfxClips().find(c=>c.id===b.clip)[b.clipField]+b.offset)*b.factor;const p=resolvedVfx(this.bindingEffects(b).find(e=>e.id===b.id)).params;return b.derived?derivedValue(b.derived,p):p[b.param]*b.factor;}
 setVisible(visible){if(this.requestVisible)this.requestVisible(visible);else this.panelVisible(visible);}
 /** The shell showed or hid the VFX panel (panel registry onVisibility). */
 panelVisible(visible){this.commit();this.visible=visible;if(!visible)this.closePopup();this.sync();this.onChange();}
 get active(){return this.controls.active;}
 commit(){this.controls.commit();}
 cancel(){this.controls.cancel();}
 ownsHistoryTarget(target){return Boolean(this.root.contains(target)&&target.matches('input[data-property],select[data-vfx-choice],select[data-clip-easing],input[data-vfx-toggle]'));}
 finishForHistory(){this.commit();const input=this.root.ownerDocument.activeElement;if(this.ownsHistoryTarget(input))input.blur();}
 run(fn){try{fn();}catch(error){this.onError(error);}}
 resetEffect(clip,id){resetEffect(this,clip,id);}
 shuffleEffect(clip,id){shuffleEffect(this,clip,id);}
 targets(){const e=this.editor;if(this.scope==='scene'||this.scope==='selection'&&this.context()==='scene')return [{kind:'scene'}];const objects=e.selectedObjects??[];if(!objects.length)return [];if(this.scope==='selection'&&objects.length===1&&e.selectedJoint>=0&&!e.figure?._styk?.movieclip){const segment=e.figure?.segments?.[e.selectedJoint];if(segment)return [{kind:'segment',uid:e.object.unique_id,handleId:segment.segment_id,figureTypeId:e.object.figure_type_id}];}return objects.map(o=>({kind:'figure',uid:o.unique_id}));}
 targetIcon(target){if(target?.kind==='scene')return vfxIcon('camera');if(target?.kind==='segment')return icon('nodes');const object=this.editor.evaluatedFrame?.objects.find(o=>o.unique_id===target?.uid),figure=findFigureType(this.editor.report.figure_types, object?.figure_type_id);return figure?._styk?.movieclip?vfxIcon('movieclip'):icon('person');}
 ownerNameMessage(target){if(target.kind==='scene')return {messageKey:'vfxInspector.scene'};const object=this.editor.evaluatedFrame.objects.find(o=>o.unique_id===target.uid),figure=findFigureType(this.editor.report.figure_types, object?.figure_type_id),name=figure?.name||{messageKey:'vfxInspector.figure'};return target.kind==='segment'?{messageKey:'vfxInspector.segmentOwner',messageParams:{name,joint:{messageKey:'builderSurfaceUi.jointNumber',messageParams:{id:target.handleId}}}}:name;}
 ownerName(target){const name=this.ownerNameMessage(target);return typeof name==='string'?name:interfaceText(name.messageKey,name.messageParams);}
 ownerNameHTML(target){const name=this.ownerNameMessage(target);return typeof name==='string'?esc(name):messageHTML(name.messageKey,name.messageParams);}
 selectedEffect(){if(!this.visible)return null;if(this.selectedClip){const clip=this.editor.getVfxClips().find(c=>c.id===this.selectedClip);if(!clip||!clipActive(this.editor,clip))return null;const effects=this.editor.sampleVfxClip(clip.id),effect=effects.find(e=>e.id===this.selectedClipEffect)??effects[0];return effect?{target:clip.target,effect,clip:clip.id,includeAttached:clip.includeAttached}:null;}if(!this.selected)return null;const {target,id}=this.selected;if(!this.targets().some(t=>JSON.stringify(t)===JSON.stringify(target)))return null;const effect=this.editor.vfxEffects(target).find(e=>e.id===id);return effect?{target,effect:resolvedVfx(effect)}:null;}
 select(target,id){this.selected={target,id};this.selectedClip=null;this.editor._selectedVfxClip=null;this.editor._selectedVfxKey=null;if(target.kind==='figure')this.scope=this.editor.animationValue(target,'vfxScope')?'connected':'figure';this.editor._emit('vfx-selection');this.sync();this.onChange();}
 isSelected(target,id){return Boolean(this.selected)&&identity(target,id)===identity(this.selected.target,this.selected.id);}
 lockedTarget(target){return this.editor.getLayer(target.kind==='scene'?'scene':this.editor.layerForUid(target.uid))?.locked;}
 /** The picture of a look or style in its picker's field: a rendered still once it is ready, the effect's glyph until then. */
 pickerArt(type,param,value){const key=`${type}:${param}:${value}`,url=cachedEffectPreview('style',key);if(url)return `<img alt="" src="${url}">`;requestEffectPreview('style',key,()=>{if(this.visible)this.sync();});return vfxIcon(VFX_REGISTRY[type]?.icon??'effects');}
 sync(){if(this.syncing){this.syncAgain=true;return;}this.syncing=true;try{this.renderSync();}finally{this.syncing=false;if(this.syncAgain){this.syncAgain=false;queueMicrotask(()=>this.sync());}}}
 /** Connected effects that cannot apply to the whole figure say why, under the head, in the interface's language. */
 connectedNotice(target){
  const e=this.editor;if(target.kind!=='figure')return '';
  const enabled=Boolean(e.animationValue(target,'vfxScope'))||e.getVfxClips(target).some(c=>c.includeAttached),conflict=enabled&&connectedVfxConflict(e.evaluatedFrame,target.uid);if(!conflict)return '';
  // connectedVfxConflict names the problem in English for diagnostics; the panel says it in the person's language.
  const ownerMissing=!e.evaluatedFrame.objects.some(o=>o.unique_id===target.uid),message=ownerMissing?{key:'vfxPanel.notice.ownerMissing',params:{}}:{key:'vfxPanel.notice.connectedDepth',params:{count:CONNECTED_DEPTH}};
  return `<p class="vfx-notice" data-tone="warning" role="status">${icon('warning','ui-icon')}<span ${messageAttributes(message.key,message.params)}>${esc(interfaceText(message.key,message.params))}</span></p>`;
 }
 renderSync(){
  if(!this.visible||this.active)return;const targets=this.targets(),e=this.editor;this.bindings.clear();
  const scene=targets[0]?.kind==='scene';if(e._vfxTimelineScene!==scene){e._vfxTimelineScene=scene;e._emit('vfx-target');}
  const stacks=targets.map(target=>({target,effects:e.vfxEffects(target).map(resolvedVfx),locked:this.lockedTarget(target)}));
  const warnings=stacks.map(({target})=>this.connectedNotice(target)).join('');
  const view=this.clipView??'playhead',query=(this.clipQuery??'').toLowerCase();
  const legacy=stacks.map(s=>({...s,shown:s.effects.filter(effect=>view==='selected'?this.isSelected(s.target,effect.id):view==='all'?!query||interfaceText(effectMessages[effect.type].nameKey).toLowerCase().includes(query):(effect.params.effectStrength??1)>0)}));
  const clips=targets.length?clipRowsHTML(this,targets):{html:'',total:0,shown:0};
  const poses=legacy.map(({target,shown,locked},ownerIndex)=>shown.length?`${targets.length>1?`<div class="ui-group-label vfx-owner-name">${this.ownerNameHTML(target)}</div>`:''}${shown.map(effect=>this.poseEntry(target,effect,locked,ownerIndex)).join('')}`:'').join('');
  const total=clips.total+stacks.reduce((n,s)=>n+s.effects.length,0),shown=clips.shown+legacy.reduce((n,s)=>n+s.shown.length,0);
  const locked=stacks.some(s=>s.locked),disabled=!targets.length||locked?' disabled':'';
  // Effects saved on poses by an older version: the same rows, under a quiet label that says where they come from.
  const older=poses?`<div class="ui-group-label vfx-older" data-tooltip="${esc(interfaceText('vfxPanel.olderEffectsTip'))}" ${messageAttributes('vfxPanel.olderEffectsTip',{},'data-tooltip')}><span ${messageAttributes('vfxPanel.olderEffects')}>${esc(interfaceText('vfxPanel.olderEffects'))}</span></div>`:'';
  const list=clips.html+older+poses;
  // Whenever the Show choice hides effects, one row says so, so they never seem to vanish.
  const more=view==='playhead'&&total>shown?`<button type="button" class="vfx-show-all" data-vfx-action="show-all"><span ${messageAttributes("vfxInspector.moreOnOtherFrames", {value: total-shown})}>${total-shown} more on other frames</span><span class="vfx-show-all-link" data-i18n="vfxInspector.showAll">${messageHTML("vfxInspector.showAll", {})}</span></button>`:'';
  const body=!targets.length?this.noTargetHTML():list?`<div class="vfx-list" role="list" aria-label="Effects" data-i18n-aria-label="vfxInspector.effects">${list}</div>${more}`:this.emptyHTML(total,view,locked);
  const scope=this.scope==='selection'?(scene?'scene':targets[0]?.kind==='segment'?'selection':stacks.some(s=>s.effects.length)&&!stacks.some(s=>e.animationValue(s.target,'vfxScope'))?'figure':'connected'):this.scope;
  const name=!targets.length?messageHTML("vfxInspector.effects"):targets.length>1?messageHTML('counts.figures',{count:targets.length}):this.ownerNameHTML(targets[0]);
  const options=[...(e.selectedJoint>=0?[messageTuple(['selection',interfaceText("vfxInspector.selectedNode")], {1: {key: "vfxInspector.selectedNode", params: {}}})]:[]),messageTuple(['figure',interfaceText("vfxInspector.thisPart")], {1: {key: "vfxInspector.thisPart", params: {}}}),messageTuple(['connected',interfaceText("vfxInspector.wholeFigure")], {1: {key: "vfxInspector.wholeFigure", params: {}}}),messageTuple(['scene',interfaceText("vfxInspector.scene")], {1: {key: "vfxInspector.scene", params: {}}})];
  // The head says what receives effects in one line: the target, and Apply to as a quiet choice whose value is its state.
  const applyTo=!targets.length?'':`<label class="ui-field vfx-scope" data-select data-bare data-size="sm" data-tooltip="${esc(interfaceText('vfxInspector.applyTo'))}" ${messageAttributes('vfxInspector.applyTo',{},'data-tooltip')}><span class="ui-field-label" data-i18n="vfxInspector.applyTo">${messageHTML("vfxInspector.applyTo", {})}</span><select class="ui-field-input" id="vfx-scope" aria-label="Effect target" data-i18n-aria-label="vfxInspector.effectTarget">${options.map((_tuple) => {const [value,text] = _tuple; const _messages = tupleMessages(_tuple); return `<option value="${value}" ${scope===value?'selected':''}${_messages[1] ? ' ' + messageAttributes(_messages[1].key, _messages[1].params) : ''}>${text}</option>`;}).join('')}</select>${icon('chevron-down','ui-icon ui-field-chev')}</label>`;
  const head=`<div class="vfx-head"><div class="ui-target-line"><span class="ui-target-kind">${targets.length?this.targetIcon(targets[0]):vfxIcon('effects')}</span><h2 class="ui-target-name">${name}</h2></div>${applyTo}</div>`;
  const copied=this.lastCopy==='member'?Boolean(this.effectClipboard):this.lastCopy==='clip'?Boolean(e._vfxClipClipboard):this.lastCopy==='pose'?Boolean(this.clipboard):Boolean(e._vfxClipClipboard||this.clipboard);
  const paste=copied?(this.lastCopy==='pose'||!this.lastCopy&&this.clipboard&&!e._vfxClipClipboard?`<button type="button" class="ui-icon-button" data-size="sm" data-vfx-action="paste" aria-label="Paste effect" data-tooltip="Paste effect"${disabled} data-i18n-aria-label="vfxInspector.pasteEffect" data-i18n-tooltip="vfxInspector.pasteEffect">${icon('clipboard')}</button>`:`<button type="button" class="ui-icon-button" data-size="sm" data-clip-action="paste" aria-label="Paste effect" data-tooltip="Paste effect"${disabled} data-i18n-aria-label="vfxInspector.pasteEffect" data-i18n-tooltip="vfxInspector.pasteEffect">${icon('clipboard')}</button>`):'';
  const views=[messageTuple(['playhead',interfaceText("vfxInspector.atThisFrame")], {1: {key: "vfxInspector.atThisFrame", params: {}}}),messageTuple(['selected',interfaceText("vfxInspector.onlySelected")], {1: {key: "vfxInspector.onlySelected", params: {}}}),messageTuple(['all',interfaceText('vfxInspector.showAll2',{total})],{1:{key:'vfxInspector.showAll2',params:{total}}})];
  // The list's own header says what is listed and adds to it. With nothing to apply effects to, only the empty state shows.
  const controls=!targets.length?'':`<div class="vfx-list-head"><h3 class="vfx-list-title" data-i18n="vfxInspector.effects">${messageHTML("vfxInspector.effects", {})}</h3><select class="vfx-view" data-clip-view aria-label="Show effects" data-i18n-aria-label="vfxInspector.showEffects">${views.map((_tuple) => {const [value,text] = _tuple; const _messages = tupleMessages(_tuple); return `<option value="${value}" ${view===value?'selected':''}${_messages[1] ? ' ' + messageAttributes(_messages[1].key, _messages[1].params) : ''}>${text}</option>`;}).join('')}</select><span class="vfx-list-actions">${paste}<button type="button" class="ui-button" data-size="sm" data-variant="outline" data-vfx-action="add" aria-label="Add effect" data-tooltip="Effects and ready-made presets"${disabled} data-i18n-aria-label="vfxInspector.addEffect" data-i18n-tooltip="vfxInspector.effectsAndReadyMadePresets">${icon('plus')}<span class="ui-label" data-i18n="vfxInspector.add">${messageHTML("vfxInspector.add", {})}</span></button></span></div>`;
  const search=view==='all'&&targets.length?`<label class="ui-field vfx-search" data-size="sm">${icon('search','ui-icon')}<input class="ui-field-input" type="search" data-clip-search placeholder="Search effects" aria-label="Search effect clips" value="${esc(this.clipQuery??'')}" data-i18n-placeholder="vfxInspector.searchEffects" data-i18n-aria-label="vfxInspector.searchEffectClips"></label>`:'';
  updateInspectorDOM(this.root,`${head}${controls}<div class="vfx-stack">${search}${warnings}${body}</div><div class="vfx-key-dock">${clipKeyControls(this)}</div>`,{preserveDisclosure:true});
 }
 /** A pose effect from an older project: the same entry as an effect clip, with a grip to reorder. */
 poseEntry(target,effect,locked,ownerIndex){
  const d=VFX_REGISTRY[effect.type],selected=this.isSelected(target,effect.id),dis=locked?' disabled':'';
  const row=`<div class="vfx-effect vfx-item vfx-older-item${effect.enabled?'':' is-disabled'}${selected?' is-selected':''}" data-section="vfx-${ownerIndex}-${effect.id}" data-vfx-id="${effect.id}" data-vfx-target="${esc(JSON.stringify(target))}"><button type="button" class="vfx-grip" draggable="${!locked}" data-vfx-drag aria-label="Reorder ${esc(d.name)}" data-tooltip="Drag to reorder · Alt+↑/↓"${dis} ${messageAttributes("vfxInspector.reorder", {name: {messageKey:effectMessages[effect.type].nameKey}}, "aria-label")} data-i18n-tooltip="vfxInspector.dragToReorderAlt">${vfxIcon('grip')}</button><button type="button" class="vfx-item-select vfx-effect-title" data-vfx-action="select" aria-expanded="${selected}">${vfxTile(d.icon,d.category)}<span class="vfx-row-name" ${messageAttributes(effectMessages[effect.type].nameKey)}>${esc(d.name)}</span></button><button type="button" class="ui-icon-button vfx-row-eye" data-size="xs" data-vfx-action="enable" aria-label="${effect.enabled?interfaceText("vfxInspector.disable"):interfaceText("vfxInspector.enable")} ${esc(d.name)}"${effect.enabled?'':' data-on="true"'}${dis} ${messageAttributes('vfxChannels.toggleEffect',{action:{messageKey:effect.enabled?'vfxInspector.disable':'vfxInspector.enable'},name:{messageKey:effectMessages[effect.type].nameKey}},'aria-label')}>${icon(effect.enabled?'eye':'eye-off')}</button><button type="button" class="ui-icon-button vfx-row-more" data-size="xs" data-vfx-action="menu" aria-label="${esc(d.name)} actions" aria-haspopup="menu" ${messageAttributes("vfxInspector.actions", {name: {messageKey:effectMessages[effect.type].nameKey}}, "aria-label")}>${icon('more')}</button>${icon('chevron-right','vfx-chevron')}</div>`;
  return `<div class="vfx-entry${selected?' is-open':''}" role="listitem" data-section="vfx-entry-${ownerIndex}-${effect.id}">${row}${selected?this.poseDetail(target,effect,locked,ownerIndex):''}</div>`;
 }
 /** The selected pose effect's settings, under its row: the same values and sections as an effect clip's, keyed through the poses. */
 poseDetail(target,effect,locked,ownerIndex){
  const d=VFX_REGISTRY[effect.type],settings=effectSettingsHTML(this,{target,effect,clip:null,ownerIndex,locked,group:false});
  const foot=`<div class="vfx-detail-foot"><span></span><span class="vfx-foot-actions">${seeded(effect.type)?`<button type="button" class="ui-icon-button vfx-foot-action" data-size="sm" data-vfx-action="shuffle" aria-label="${esc(interfaceText('vfxPanel.shuffleTip'))}" ${messageAttributes('vfxPanel.shuffleTip',{},'aria-label')}${locked?' disabled':''}>${vfxIcon('dice')}</button>`:''}<button type="button" class="ui-icon-button vfx-foot-action" data-size="sm" data-vfx-action="reset" aria-label="${esc(interfaceText('vfxPanel.resetEffect'))}" ${messageAttributes('vfxPanel.resetEffect',{},'aria-label')}${locked?' disabled':''}>${icon('reset')}</button></span></div>`;
  return `<section class="vfx-detail${effect.enabled?'':' is-disabled'}" data-section="vfx-detail-${ownerIndex}-${effect.id}" data-vfx-id="${effect.id}" data-vfx-target="${esc(JSON.stringify(target))}" aria-label="${esc(d.name)} settings" ${messageAttributes("vfxInspector.settings", {name: {messageKey:effectMessages[effect.type].nameKey}}, "aria-label")}>${settings}${foot}</section>`;
 }
 click(event){
  // Numeric focus selects through PropertyControls.begin. Other controls select
  // on activation, so revealing key navigation cannot move a button mid-click.
  if(!event.target.closest('[data-clip-key],[data-clip-key-property]'))focusClipBinding(this,this.bindings.get(event.target.closest('[data-vfx-binding]')?.dataset.vfxBinding));
  if(this.valueClick(event))return;
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
 /**
  * The value controls that are buttons: a choice's segment, a visual picker, a pair's link and a seed's shuffle.
  * Each is one edit (one undo step), on a clip or on a pose effect alike.
  */
 valueClick(event){
  const button=event.target.closest('button');if(!button||button.disabled||!this.root.contains(button))return false;
  const segments=button.closest('[data-vfx-segments]');
  if(segments&&button.dataset.vfxOption!==undefined){const b=this.bindings.get(segments.dataset.vfxSegments);if(!b)return false;this.choose(b,Number(button.dataset.vfxOption));return true;}
  if(button.dataset.vfxPicker){const b=this.bindings.get(button.dataset.vfxPicker);if(!b)return false;this.commit();openStylePicker(this,b,button);return true;}
  if(button.dataset.vfxMenuFor){const select=this.root.querySelector(`#${CSS.escape(button.dataset.vfxMenuFor)}`);if(!select)return false;this.commit();this.openChoiceMenu(select,button);return true;}
  if(button.dataset.vfxLink){const b=this.bindings.get(button.dataset.vfxLink);if(!b)return false;const value=resolvedVfx(this.bindingEffects(b).find(e=>e.id===b.id)).params[b.param];this.commit();this.beforeEdit();this.setBinding(b,Number(!value));this.sync();this.onChange();return true;}
  if(button.dataset.vfxShuffle){const b=this.bindings.get(button.dataset.vfxShuffle);if(!b)return false;if(b.clip)shuffleEffect(this,{id:b.clip},b.id);else{const seed=resolvedVfx(this.bindingEffects(b).find(e=>e.id===b.id)).params.seed??1;this.commit();this.beforeEdit();this.setBinding(b,1+(seed+Math.floor(Math.random()*65533))%65535);this.sync();this.onChange();}return true;}
  return false;
 }
 /** A long choice's menu (vfx-effect-view.mjs choiceHTML): its options, the current one checked; choosing one sets its hidden select as a person would. */
 openChoiceMenu(select,button){
  let menu=this.choiceMenu;
  if(!menu){menu=this.choiceMenu={editor:this.editor,_run:fn=>this.run(fn)};this.abort.signal.addEventListener('abort',()=>{menu.menuEvents?.abort();menu.menu?.remove();},{once:true});}
  showTimelineMenu(menu,{currentTarget:button},[[...select.options].map(option=>({label:option.textContent.trim(),checked:option.selected,disabled:option.disabled,action:()=>{if(select.value===option.value)return;select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));}}))]);
 }
 /** A choice (a segment, a menu, a picker's tile) as one undo step; a style brings its own suggested colours and settings with it. */
 choose(b,value){
  const applies=b.clip&&vfxDescriptor(b.property)?.applies?.[value];this.commit();this.beforeEdit();
  if(applies)this.editor.setVfxClipParameters(b.clip,b.id,{[b.param]:value,...applies});else this.setBinding(b,value);this.sync();this.onChange();
 }
 /** One pose-effect action (its row, its menu or paste) as one undo step. */
 effectAction(action,target,id){
  if(action==='copy'){this.clipboard=structuredClone([this.editor.vfxEffects(target).find(e=>e.id===id)]);this.clipboardScope=target.kind==='figure'?Boolean(this.editor.animationValue(target,'vfxScope')):undefined;this.lastCopy='pose';this.sync();return;}
  this.commit();this.beforeEdit();
  if(action==='paste')this.editor.pasteVfx(this.targets(),this.clipboard,{includeAttached:this.clipboardScope});
  if(action==='enable'){const effect=this.editor.vfxEffects(target).find(e=>e.id===id);this.editor.setVfxParameter(target,id,'enabled',Number(!effect.enabled));}
  if(action==='remove'){this.editor.removeVfx(target,id);if(this.selected?.id===id)this.selected=null;}
  if(action==='duplicate')this.select(target,this.editor.duplicateVfx(target,id));
  if(action==='reset')this.editor.resetVfx(target,id);
  if(action==='shuffle'){const effect=resolvedVfx(this.editor.vfxEffects(target).find(e=>e.id===id)),seed=effect.params.seed??1;this.editor.setVfxParameter(target,id,'seed',1+(seed+Math.floor(Math.random()*65533))%65535);}
  if(action==='up'||action==='down')this.editor.moveVfx(target,id,action==='up'?-1:1);
  this.sync();this.onChange();
 }
 /** A pose effect's menu (its ⋯, a right-click or Shift+F10): the kit's menu. */
 openEffectMenu(target,id,event){
  const effects=this.editor.vfxEffects(target),index=effects.findIndex(e=>e.id===id),locked=this.lockedTarget(target),run=action=>()=>this.effectAction(action,target,id);
  let menu=this.effectMenu;
  if(!menu){menu=this.effectMenu={editor:this.editor,_run:fn=>this.run(fn)};this.abort.signal.addEventListener('abort',()=>{menu.menuEvents?.abort();menu.menu?.remove();},{once:true});}
  showTimelineMenu(menu,event,[
   [{label:interfaceText("vfxInspector.copyEffect"), labelKey: "vfxInspector.copyEffect",symbol:'duplicate',action:run('copy')},{label:interfaceText("common.duplicate"), labelKey: "common.duplicate",symbol:'duplicate',disabled:locked||effects.length>=VFX_LIMIT,action:run('duplicate')}],
   [{label:interfaceText("vfxInspector.moveUp"), labelKey: "vfxInspector.moveUp",symbol:'chevron-up',disabled:locked||index<=0,action:run('up')},{label:interfaceText("vfxInspector.moveDown"), labelKey: "vfxInspector.moveDown",symbol:'chevron-down',disabled:locked||index>=effects.length-1,action:run('down')}],
   [{label:interfaceText("common.reset"), labelKey: "common.reset",symbol:'reset',disabled:locked,action:run('reset')},{label:interfaceText("common.remove"), labelKey: "common.remove",symbol:'trash',danger:true,disabled:locked,action:run('remove')}],
  ]);
 }
 /** A value's menu (a right-click on it, or Shift+F10): reset it, and for a clip's value its keys. */
 openValueMenu(key,event){
  const b=this.bindings.get(key),input=this.root.querySelector(`[data-vfx-binding="${CSS.escape(key)}"] input[data-property]`);if(!b)return;
  const e=this.editor,clip=b.clip&&e.getVfxClips().find(c=>c.id===b.clip),properties=b.properties??[b.property],frame=Math.floor(e.tick)+1,on=clip&&properties.some(property=>keyAt(clip,property,e.tick));
  const d=b.clipField?null:vfxDescriptor(b.property),locked=b.clip?e.getLayer(clip.target.kind==='scene'?'scene':e.layerForUid(clip.target.uid))?.locked:this.lockedTarget(b.target);
  let menu=this.valueMenu;
  if(!menu){menu=this.valueMenu={editor:e,_run:fn=>this.run(fn)};this.abort.signal.addEventListener('abort',()=>{menu.menuEvents?.abort();menu.menu?.remove();},{once:true});}
  const reset=()=>{if(input&&this.controls.reset(input))return;if(d&&!b.derived){this.commit();this.beforeEdit();this.setBinding(b,d.default);this.sync();this.onChange();}};
  const keys=clip?[{label:interfaceText(on?'vfxPanel.removeKeyAtFrame':'vfxPanel.addKeyAtFrame',{frame}),labelKey:on?'vfxPanel.removeKeyAtFrame':'vfxPanel.addKeyAtFrame',labelParams:{frame},symbol:'diamond',disabled:locked,action:()=>{this.commit();const button=this.root.querySelector(`[data-vfx-binding="${CSS.escape(key)}"] [data-clip-key]`);button?.click();}},
   ...['previous','next'].map(way=>{const tick=this.neighbourKey(clip,properties,way);return {label:interfaceText(way==='previous'?'vfxPanel.previousKey':'vfxPanel.nextKey'),labelKey:way==='previous'?'vfxPanel.previousKey':'vfxPanel.nextKey',symbol:way==='previous'?'chevron-left':'chevron-right',disabled:tick===null,action:()=>{e.seek(tick,{allowBeyondEnd:true});this.sync();}};})]:[];
  showTimelineMenu(menu,event,[[{label:interfaceText('vfxPanel.resetValue'),labelKey:'vfxPanel.resetValue',symbol:'reset',disabled:locked||(!input?.dataset.propertyDefault&&!d),action:reset}],keys]);
 }
 /** The frame of the key before or after the playhead among `properties` of `clip`, or null. */
 neighbourKey(clip,properties,way){
  const time=Math.floor(this.editor.tick-clip.start+clip.offset);let best=null;
  for(const property of properties)for(const key of clip.keys[property]??[]){if(way==='previous'?key.tick<time&&(best===null||key.tick>best):key.tick>time&&(best===null||key.tick<best))best=key.tick;}
  return best===null?null:Math.max(0,best+clip.start-clip.offset);
 }
 contextmenu(event){
  const value=event.target.closest('[data-vfx-binding]');
  if(value&&this.bindings.has(value.dataset.vfxBinding)){event.preventDefault();this.commit();this.openValueMenu(value.dataset.vfxBinding,event.clientX||event.clientY?event:{currentTarget:value});return;}
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
 }else if(input.dataset.vfxChoice){this.choose(this.bindings.get(input.dataset.vfxChoice),Number(input.value));}}
 keydown(event){
  if(groupKeydown(this,event))return;
  if(event.key==='Escape'){this.closePopup();this.selected=null;this.sync();this.onChange();}
  // Shift+F10 on a value opens its menu, as a right-click does.
  if(event.key==='F10'&&event.shiftKey){const value=event.target.closest('[data-vfx-binding]');if(value){event.preventDefault();this.commit();this.openValueMenu(value.dataset.vfxBinding,{currentTarget:value});return;}}
  if(event.altKey&&["ArrowUp","ArrowDown"].includes(event.key)&&event.target.closest('[data-vfx-clip-drag]')){event.preventDefault();const row=event.target.closest('[data-clip-id]');this.commit();this.beforeEdit();this.editor.moveVfxClipOrder(row.dataset.clipId,event.key==='ArrowUp'?-1:1);this.sync();this.root.querySelector(`.vfx-clip[data-clip-id="${CSS.escape(row.dataset.clipId)}"] [data-vfx-clip-drag]`)?.focus();this.onChange();return;}
  if(event.altKey&&["ArrowUp","ArrowDown"].includes(event.key)&&event.target.closest('[data-vfx-drag]')){event.preventDefault();const row=event.target.closest('[data-vfx-id]');this.commit();this.beforeEdit();this.editor.moveVfx(JSON.parse(row.dataset.vfxTarget),row.dataset.vfxId,event.key==='ArrowUp'?-1:1);this.sync();this.onChange();}
 }
 dragstart(event){
  if(groupDragStart(this,event))return;
  const clipGrip=event.target.closest('[data-vfx-clip-drag]');
  if(clipGrip){const row=clipGrip.closest('[data-clip-id]');this.clipDragged=row.dataset.clipId;event.dataTransfer.setData('application/x-styk-vfx-clip',row.dataset.clipId);event.dataTransfer.effectAllowed='move';row.classList.add('is-dragging');return;}
  const grip=event.target.closest('[data-vfx-drag]');if(!grip){event.preventDefault();return;}const row=grip.closest('[data-vfx-id]');this.dragged={target:row.dataset.vfxTarget,id:row.dataset.vfxId};event.dataTransfer.setData('application/x-styk-vfx',JSON.stringify(this.dragged));event.dataTransfer.effectAllowed='move';row.classList.add('is-dragging');
 }
 /** The effect clips a dragged clip can move among: the same target's, in render order. */
 clipSiblings(id){const clips=this.editor.getVfxClips(),clip=clips.find(c=>c.id===id);return clip?clips.filter(c=>JSON.stringify(c.target)===JSON.stringify(clip.target)):[];}
 dragover(event){
  if(groupDragOver(this,event))return;
  if(this.clipDragged){const row=event.target.closest('.vfx-clip[data-clip-id]');if(!row||!this.clipSiblings(this.clipDragged).some(c=>c.id===row.dataset.clipId))return;event.preventDefault();event.dataTransfer.dropEffect='move';for(const item of this.root.querySelectorAll('.is-drop-target'))item.classList.remove('is-drop-target');row.classList.add('is-drop-target');return;}
  const row=event.target.closest('.vfx-effect[data-vfx-id]');if(!this.dragged||row?.dataset.vfxTarget!==this.dragged.target)return;event.preventDefault();event.dataTransfer.dropEffect='move';for(const item of this.root.querySelectorAll('.is-drop-target'))item.classList.remove('is-drop-target');row.classList.add('is-drop-target');
 }
 drop(event){
  if(groupDrop(this,event))return;
  if(this.clipDragged){
   // A clip dropped on another moves to its place in the render order, as one undo step.
   const row=event.target.closest('.vfx-clip[data-clip-id]'),siblings=this.clipSiblings(this.clipDragged),from=siblings.findIndex(c=>c.id===this.clipDragged),to=siblings.findIndex(c=>c.id===row?.dataset.clipId),id=this.clipDragged;
   if(row&&from>=0&&to>=0&&from!==to){event.preventDefault();this.commit();this.beforeEdit();this.editor.movieclipBatch(interfaceText('vfxClipInspector.moveDown'),()=>{for(let i=0;i<Math.abs(to-from);i++)this.editor.moveVfxClipOrder(id,to>from?1:-1);});}
   this.dragend();this.sync();this.onChange();return;
  }
  const row=event.target.closest('.vfx-effect[data-vfx-id]');if(!this.dragged||row?.dataset.vfxTarget!==this.dragged.target)return;event.preventDefault();const target=JSON.parse(this.dragged.target),index=this.editor.vfxEffects(target).findIndex(e=>e.id===row.dataset.vfxId);this.commit();this.beforeEdit();this.editor.reorderVfx(target,this.dragged.id,index);this.dragend();this.sync();this.onChange();
 }
 dragend(){groupDragEnd(this);this.dragged=null;this.clipDragged=null;for(const row of this.root.querySelectorAll('.is-dragging,.is-drop-target'))row.classList.remove('is-dragging','is-drop-target');}
 closePopup(){this.popup?.remove();this.popup=null;this.closePeek?.();this.closePeek=null;}
 /** Add one effect or preset to every current target (or the open group) as one undo step. The engine places a moment
  preset at the playhead for its length, with its fades and keys (addVfxGroup). */
 addChoice(mode,key){
  this.beforeEdit();const targets=this.targets(),options={includeAttached:this.root.querySelector('#vfx-scope')?.value==='connected'};
  const mine=key.startsWith(MINE)&&vfxPresetStore.find(key.slice(MINE.length));if(key.startsWith(MINE)&&!mine)throw messageError(new Error(''), "errors.vfxInspector.thatPresetWasDeleted", {});
  const e=this.editor;
  e.movieclipBatch(interfaceText("vfxInspector.addEffects"),()=>{if(this.addToGroup){e.addVfxGroupEffect(this.addToGroup,key);}else for(const target of targets){const id=mine?e.addVfxUserPreset(target,mine,options):mode==='presets'?e.addVfxGroup(target,key,options):e.addVfxClip(target,key,options);
   selectClip(this,id);}});
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
  const tile=(mode,key,label,art,category,meta,nameKey=mode==='add'?effectMessages[key]?.nameKey:mode==='presets'?presetMessages[key]?.nameKey:null)=>`<button type="button" class="vfx-suggestion" data-vfx-action="quick" data-vfx-quick="${mode}:${esc(key)}" aria-label="Add ${esc(label)}" ${locked?'disabled':''} ${messageAttributes("vfxInspector.add2", {label: nameKey ? {messageKey:nameKey} : label}, "aria-label")}>${vfxTile(art,category)}<span class="vfx-suggestion-name" ${nameKey ? messageAttributes(nameKey) : ''}>${esc(label)}</span>${meta?`<span class="vfx-suggestion-meta">${typeof meta==='string'?esc(meta):messageHTML(meta.messageKey,meta.messageParams)}</span>`:''}</button>`;
  const effect=type=>{const d=VFX_REGISTRY[type];return tile('add',type,d.name,d.icon,d.category,null);};
  const mine=usablePresets(scene).slice(0,3).map(p=>tile('presets',MINE+p.id,p.name,p.effects.length===1?VFX_REGISTRY[p.effects[0].type]?.icon??'effects':'effects',p.effects.length===1?VFX_REGISTRY[p.effects[0].type]?.category??'Looks':'Looks',{messageKey:'vfxInspector.myPresetSummary',messageParams:{summary:presetSummaryMessage(p)}}));
  // A suggestion's caption is short ("Look · 2", "Moment · 4 f"): the catalogue and its preview card say the rest.
  const presetMeta=name=>{const timing=presetTiming(name,VFX_PRESETS[name]);return isMoment(name,VFX_PRESETS[name])?(timing?{messageKey:'vfxPanel.catalog.momentShort',messageParams:{count:timing.duration}}:{messageKey:'vfxPanel.catalog.moment'}):{messageKey:'vfxPanel.catalog.lookShort',messageParams:{count:VFX_PRESETS[name].effects.length}};};
  const elsewhere=view==='playhead'&&total;
  const titleKey=elsewhere?"vfxInspector.noEffectsAtThisFrame":scene?"vfxInspector.noEffectsOnTheScene":targets.length===1?"vfxInspector.noEffectsOnFigure":"vfxInspector.noEffectsYet",titleParams=titleKey==='vfxInspector.noEffectsOnFigure'?{name:this.ownerNameMessage(targets[0])}:{};
  return `<div class="ui-empty vfx-empty"><h3 class="ui-empty-title">${messageHTML(titleKey,titleParams)}</h3>${elsewhere?'':`<p class="ui-empty-text" data-i18n="vfxInspector.startWithOneOfTheseOrChooseAdd">${messageHTML("vfxInspector.startWithOneOfTheseOrChooseAdd", {})}</p>`}${elsewhere?`<div class="ui-empty-actions"><button type="button" class="ui-button" data-size="sm" data-variant="ghost" data-vfx-action="show-all" ${messageAttributes("vfxInspector.showAll2", {total: total})}>Show all ${total}</button></div>`:''}<div class="vfx-suggestions" role="group" aria-label="Suggested effects" data-i18n-aria-label="vfxInspector.suggestedEffects">${[...mine,...effects.map(effect),...generated.map(effect),...presets.map(name=>tile('presets',name,name,VFX_PRESETS[name].icon,'Looks',presetMeta(name)))].join('')}</div></div>`;
 }
 openPopup(anchor,mode){
  this.closePopup();const scene=this.targets()[0]?.kind==='scene',popup=this.popup=document.createElement('div');popup.className='vfx-catalog';popup.setAttribute('popover','auto');popup.setAttribute('role','dialog');localizedAttribute(popup, 'aria-label', (mode==='presets' ? "vfxInspector.vfxPresets" : "vfxInspector.addEffect"), (mode==='presets' ? {} : {}));
  const tabs=this.addToGroup?'':`<div class="ui-segmented vfx-catalog-tabs" data-size="sm" data-fill role="tablist" aria-label="Catalogue" data-i18n-aria-label="vfxInspector.catalogue">${[messageTuple(['add',interfaceText("vfxInspector.effects")], {1: {key: "vfxInspector.effects", params: {}}}),messageTuple(['presets',interfaceText("vfxInspector.presets")], {1: {key: "vfxInspector.presets", params: {}}})].map((_tuple) => {const [id,label] = _tuple; const _messages = tupleMessages(_tuple); return `<button type="button" class="ui-segmented-item" role="tab" data-catalog-mode="${id}" aria-selected="${mode===id}"${_messages[1] ? ' ' + messageAttributes(_messages[1].key, _messages[1].params) : ''}>${label}</button>`;}).join('')}</div>`;
  const searchKey=mode==='presets'?'vfxInspector.searchPresets':'vfxInspector.searchEffects';
  localizedMarkup(popup, `<div class="vfx-catalog-top">${tabs}<label class="ui-field vfx-catalog-search" data-size="sm">${icon('search','ui-icon')}<input class="ui-field-input" type="search" ${messageAttributes(searchKey, {}, 'aria-label')} ${messageAttributes(searchKey, {}, 'placeholder')}></label></div><div class="vfx-catalog-results"></div>`);appendLocalized(document.body, popup);popup.showPopover();
  // Effects in the groups a person reaches for (vfx-presentation.mjs, CATALOGUE); presets split into moments and lasting looks.
  const groups=mode==='presets'
   ?[{id:'moments',items:Object.keys(VFX_PRESETS).filter(name=>isMoment(name,VFX_PRESETS[name]))},{id:'looks',items:Object.keys(VFX_PRESETS).filter(name=>!isMoment(name,VFX_PRESETS[name]))}]
     .map(group=>({...group,items:group.items.filter(name=>presetAvailable(VFX_PRESETS[name],scene,effectAvailable)).map(name=>{const p=VFX_PRESETS[name],timing=presetTiming(name,p);return {key:name,name,nameKey:presetMessages[name].nameKey,searchKeys:[presetMessages[name].nameKey,catalogueKey(group.id)],icon:p.icon,category:'Looks',count:p.effects.length,preview:hasEffectPreview(mode,name),
      meta:group.id==='moments'?(timing?{messageKey:'vfxPanel.catalog.momentFrames',messageParams:{count:timing.duration}}:{messageKey:'vfxPanel.catalog.moment'}):{messageKey:'vfxPanel.catalog.lookEffects',messageParams:{count:p.effects.length}}};})}))
   :catalogueSections(type=>effectAvailable(type,scene)).map(section=>({id:section.id,stills:section.stills,items:section.types.map(key=>({key,...VFX_REGISTRY[key],...effectMessages[key],searchKeys:[effectMessages[key].nameKey,catalogueKey(section.id)],aboutKey:`vfxPanel.about.${key}`,count:1,preview:hasEffectPreview(mode,key)}))}));
  // Generated effects show a rendered still, filled in as previews finish; the others their glyph in their category's tint.
  const art=item=>{if(!item.preview)return vfxTile(item.icon,item.category,'vfx-catalog-art');const url=cachedEffectPreview(mode,item.key);return `<span class="vfx-catalog-art vfx-catalog-still${url?' has-preview':''}" data-preview="${esc(item.key)}">${url?`<img alt="" src="${url}">`:vfxIcon(item.icon)}</span>`;};
  const full=item=>this.addToGroup&&this.editor.getVfxClips().find(c=>c.id===this.addToGroup)?.effects.length+item.count>VFX_LIMIT;
  const draw=()=>{const query=popup.querySelector('input').value.toLowerCase();localizedMarkup(popup.querySelector('.vfx-catalog-results'), (mode==='presets'?myPresetsSection(scene,query):'')+groups.map(group=>{// A search finds a name or a group anywhere, and what an effect does from the start of a word ("smo" finds Smoke, not "Washes").
   const list=group.items.filter(item=>!query||item.searchKeys.some(key=>interfaceText(key).toLowerCase().includes(query))||item.aboutKey&&interfaceText(item.aboutKey).toLowerCase().split(/[^\p{L}\p{N}]+/u).some(word=>word.startsWith(query)));if(!list.length)return '';const titleKey=catalogueKey(group.id);return `<section data-catalog-group="${group.id}"><h3 ${messageAttributes(titleKey)}>${esc(interfaceText(titleKey))}</h3><div class="vfx-catalog-grid${group.stills?' is-previews':''}">${list.map(item=>`<button type="button" class="vfx-catalog-card" data-choice="${esc(item.key)}" ${full(item)?'disabled':''}>${art(item)}<span ${messageAttributes(item.nameKey)}>${esc(interfaceText(item.nameKey))}</span>${item.meta?`<small ${messageAttributes(item.meta.messageKey,item.meta.messageParams)}>${esc(interfaceText(item.meta.messageKey,item.meta.messageParams))}</small>`:''}</button>`).join('')}</div></section>`;}).join('')||(mode==='presets'&&popup.querySelector('.vfx-my-presets-section')?'':`<div class="vfx-catalog-empty">${messageHTML("common.noResults", {})}</div>`));
   for(const node of popup.querySelectorAll('[data-preview]:not(.has-preview)'))requestEffectPreview(mode,node.dataset.preview,url=>{if(!node.isConnected)return;node.classList.add('has-preview');localizedMarkup(node, `<img alt="" src="${url}">`);});};
  popup.querySelector('input').addEventListener('input',draw);this.redrawCatalog=()=>{if(this.popup===popup)draw();};
  const presetMenu=(event,node)=>{event.preventDefault();event.stopPropagation();openPresetMenu(this,node.dataset.presetMenu??node.querySelector('[data-preset-menu]').dataset.presetMenu,event.clientX||event.clientY?event:{currentTarget:node});};
  popup.addEventListener('contextmenu',event=>{const card=event.target.closest('.vfx-my-preset');if(card)presetMenu(event,card);});
  popup.addEventListener('click',event=>{const more=event.target.closest('[data-preset-menu]');if(more){presetMenu(event,more);return;}const tab=event.target.closest('[data-catalog-mode]');if(tab){if(tab.dataset.catalogMode!==mode)this.openPopup(anchor,tab.dataset.catalogMode);return;}const button=event.target.closest('[data-choice]');if(!button||button.disabled)return;this.run(()=>this.addChoice(mode,button.dataset.choice));});
  popup.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Escape'){this.closePopup();anchor.focus();}if(event.key==='ArrowDown'&&event.target.tagName==='INPUT'){event.preventDefault();popup.querySelector('.vfx-catalog-card:not(:disabled)')?.focus();}});draw();
  // What an effect or a preset does, beside the catalogue, before it is added.
  this.closePeek=attachCatalogPeek(popup,mode);
  // Measure the populated catalogue once so searching keeps the input stationary.
  const panel=this.root.getBoundingClientRect(),from=anchor.getBoundingClientRect();popup.style.width=Math.max(260,panel.width-16)+'px';const size=popup.getBoundingClientRect();
  popup.style.left=Math.max(8,Math.min(panel.left+8,innerWidth-size.width-8))+'px';
  popup.style.top=Math.max(8,Math.min(from.bottom+6,innerHeight-size.height-8))+'px';
  popup.querySelector('input').focus();
 }
 destroy(){this.closeColor?.();this.closePopup();this.controls.destroy();this.abort.abort();}
}
