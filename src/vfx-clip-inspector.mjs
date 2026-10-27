import {effectMessages,effectNameMessage,easingMessageKeys} from './vfx-localization.mjs';

import {t as interfaceText} from './localization.mjs';
import {messageAttributes, messageHTML, localizedAttribute, appendLocalized} from './localization-bindings.mjs';
import {clipTime} from './vfx-clips.mjs';
import {VFX_REGISTRY,VFX_LIMIT,vfxDescriptor} from './vfx.mjs';
import {icon} from './icons.mjs';
import {vfxIcon,vfxTile} from './vfx-icons.mjs';
import {vfxVisibleKeys,vfxSelectedChannels,vfxChannelLabel,setVfxVisibleChannels,vfxGroupEffectName,vfxChannelMessage} from './vfx-key-channels.mjs';
import {openVfxChannelMenu} from './vfx-key-channel-menu.mjs';
import {clipNumber,clipStrength,editGroupEffect,openGroupMenu} from './vfx-clip-controls.mjs';
import {showTimelineMenu} from './timeline-menu.mjs';
import {clipsPlaying} from './vfx-clip-views.mjs';
import {isGeneratorType} from './vfx-registry.mjs';
import {savePresetFromClip} from './vfx-preset-ui.mjs';

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clipNameMessage=c=>c.name||{messageKey:effectMessages[c.effects[0]?.type]?.nameKey||'vfxClipInspector.effects'};
export const clipName=c=>{const caption=clipNameMessage(c);return typeof caption==='string'?caption:interfaceText(caption.messageKey);};
/** A clip's tile: its one effect's glyph in its category's tint, or the group glyph. */
const clipTile=c=>{const d=c.effects.length===1&&VFX_REGISTRY[c.effects[0].type];return d?vfxTile(d.icon,d.category):vfxTile('effects','Looks');};
const iconButton=(name,label,glyph,{disabled=false,on=false,className='',menu=false}={}, _messages = {})=>`<button type="button" class="ui-icon-button${className?` ${className}`:''}" data-size="xs" data-clip-action="${name}" aria-label="${esc(label)}"${on?' data-on="true"':''}${menu?' aria-haspopup="menu"':''} ${disabled?'disabled':''} ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params, 'aria-label') : ''}>${icon(glyph)}</button>`;
const keyIndex=(clip,keys,tick)=>{let low=0,high=keys.length-1,time=clipTime(clip,tick);while(low<high){const mid=(low+high+1)>>>1;if(keys[mid].tick<=time)low=mid;else high=mid-1;}return low;};
const currentKey=(clip,keys,tick)=>keys[keyIndex(clip,keys,tick)];
const lockedClip=(e,c)=>e.getLayer(c.target.kind==='scene'?'scene':e.layerForUid(c.target.uid))?.locked;
// Generated clips stay listed while their particles are still visible. A clip switched off with its eye stays
// listed where it would play, so switching it off never hides the switch that brings it back.
export function filterVfxClips(editor,clips,{view='playhead',tick=0,selected=null,query=''}={}){
 const plays=view==='playhead'?clipsPlaying(editor,clips,tick):null;
 return clips.filter((c,i)=>(view==='all'||(view==='selected'?c.id===selected:plays[i]))&&(!query||view!=='all'||clipName(c).toLowerCase().includes(query.toLowerCase())));
}

/** A beam aims at a stage point or locks onto a node picked on the stage. */
function aimLabel(editor,p){
 const object=editor.evaluatedFrame?.objects.find(o=>o.unique_id===p.aimUid),figure=object&&editor.report.figure_types?.find(f=>f.figure_type_id===object.figure_type_id);
 return {messageKey:'vfxChannels.aimTarget',messageParams:{figure:figure?.name||{messageKey:'vfxChannels.figure',messageParams:{id:p.aimUid}},node:p.aimHandle?{messageKey:'vfxChannels.node',messageParams:{id:p.aimHandle}}:{messageKey:'vfxChannels.origin'}}};
}
function aimRow(host,clip,effect,locked){
 if(effect.type!=='beam')return '';
 const e=host.editor,p=effect.params,picking=e._vfxAimPick?.clip===clip.id&&e._vfxAimPick.effect===effect.id,aim=p.aimUid?aimLabel(e,p):{messageKey:"vfxClipInspector.pointOnStage"},label=interfaceText(aim.messageKey,aim.messageParams);
 const hint=clip.target.kind==='figure'?`<p class="vfx-note" data-i18n="vfxClipInspector.firesFromTheFigureSOriginToFire">${messageHTML("vfxClipInspector.firesFromTheFigureSOriginToFire", {})}</p>`:'';
 return hint+`<div class="vfx-row vfx-aim"><span class="vfx-label" data-i18n="vfxClipInspector.aimAt">${messageHTML("vfxClipInspector.aimAt", {})}</span><span class="vfx-aim-target" data-tooltip="${esc(label)}" ${messageAttributes(aim.messageKey,aim.messageParams)} ${messageAttributes(aim.messageKey,aim.messageParams,"data-tooltip")}>${esc(label)}</span><button type="button" class="ui-button vfx-aim-pick" data-size="sm" data-variant="${picking?'accent':'outline'}" data-clip-action="aim-pick" data-effect-id="${effect.id}" aria-pressed="${picking}" data-tooltip="Click a node, a figure origin or any point on the stage" ${locked?'disabled':''} data-i18n-tooltip="vfxClipInspector.clickANodeAFigureOriginOrAny" ${messageAttributes((picking ? "vfxClipInspector.clickTheStage" : "vfxClipInspector.pick"), (picking ? {} : {}))}>${picking?interfaceText("vfxClipInspector.clickTheStage"):interfaceText("vfxClipInspector.pick")}</button>${p.aimUid?`<button type="button" class="ui-icon-button" data-size="xs" data-clip-action="aim-clear" data-effect-id="${effect.id}" aria-label="Aim at a stage point instead" ${locked?'disabled':''} data-i18n-aria-label="vfxClipInspector.aimAtAStagePointInstead">${icon('close')}</button>`:''}</div>`;
}
function effectFields(host,clip,effect,locked,picked){
 const scene=clip.target.kind==='scene';
 const fields=Object.entries(VFX_REGISTRY[effect.type].params).filter(([,d])=>!d.hidden&&(!d.sceneOnly||scene)&&(!d.when||Object.entries(d.when).every(([key,values])=>values.includes(effect.params[key])))).map(([param,d])=>[param,param==='effectStrength'&&clip.effects.length>1?{...d,advanced:true}:d]).sort(([a],[b])=>(a==='effectStrength')-(b==='effectStrength'));
 const render=entries=>entries.map(([param,d])=>{
  const field=host.field(clip.target,effect,param,d,`clip-${clip.id}`,locked),key=`clip-${clip.id}-${effect.id}-${param}`,b=host.bindings.get(key),keys=clip.keys[b.property]??[];
  const on=currentKey(clip,keys,host.editor.tick)?.tick===Math.floor(clipTime(clip,host.editor.tick));
  return `<div class="vfx-key-field${picked.length===1&&picked[0]===b.property?' is-channel-selected':''}" data-vfx-binding="${esc(key)}">${field}<button class="vfx-key${keys.length?' is-animated':''}${on?' is-keyed':''}" type="button" data-clip-key="${esc(key)}" aria-label="${on?interfaceText("vfxClipInspector.remove"):interfaceText("vfxClipInspector.add")} ${esc(d.label)} key" data-tooltip="${on?interfaceText("vfxClipInspector.removeKey"):interfaceText("vfxClipInspector.addKey")}" ${locked?'disabled':''} ${messageAttributes("vfxClipInspector.key", {value: on?{messageKey: "vfxClipInspector.remove"}:{messageKey: "vfxClipInspector.add"}, label: {messageKey:effectMessages[effect.type]?.params[param]?.labelKey}}, "aria-label")} ${messageAttributes((on ? "vfxClipInspector.removeKey" : "vfxClipInspector.addKey"), (on ? {} : {}), "data-tooltip")}>${icon('diamond')}</button></div>`;
 }).join('');
 // Generated effects can draw a new random pattern with the same settings.
 const shuffle=isGeneratorType(effect.type)?`<div class="vfx-row vfx-variation"><span class="vfx-label" data-i18n="vfxClipInspector.variation">${messageHTML("vfxClipInspector.variation", {})}</span><button type="button" class="ui-button" data-size="sm" data-variant="outline" data-clip-action="shuffle" data-effect-id="${effect.id}" data-tooltip="Same settings, new random pattern" ${locked?'disabled':''} data-i18n-tooltip="vfxClipInspector.sameSettingsNewRandomPattern">${vfxIcon('dice')}<span class="ui-label" data-i18n="vfxClipInspector.shuffle">${messageHTML("vfxClipInspector.shuffle", {})}</span></button></div>`:'';
 const normal=aimRow(host,clip,effect,locked)+render(fields.filter(([,d])=>!d.advanced))+shuffle,advanced=render(fields.filter(([,d])=>d.advanced));
 return normal+(advanced?`<details class="vfx-advanced"><summary>${icon('chevron-right')}${messageHTML("vfxClipInspector.more", {})}</summary><div class="vfx-fields">${advanced}</div></details>`:'');
}
function keyNavigation(host,c,locked){
 const e=host.editor,selected=vfxSelectedChannels(e,c);
 if(!selected.length&&!Object.keys(c.keys).length)return '<div class="vfx-key-navigation" hidden></div>';
 const channels=Object.entries(vfxVisibleKeys(e,c)),time=clipTime(c,e.tick);let previous,next;
 for(const [,keys] of channels){const index=keyIndex(c,keys,e.tick),a=keys[index]?.tick<time?keys[index]:keys[index-1],b=keys[index]?.tick>time?keys[index]:keys[index+1];if(a&&(!previous||a.tick>previous.tick))previous=a;if(b&&(!next||b.tick<next.tick))next=b;}
 const seek=(key,label,iconName, _messages = {})=>`<button type="button" class="ui-icon-button" data-size="xs" ${key?`data-clip-seek="${Math.max(0,key.tick+c.start-c.offset)}"`:'disabled'} aria-label="${label}" ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params, 'aria-label') : ''}>${icon(iconName)}</button>`;
 const property=selected.length===1?selected[0]:null,keys=c.keys[property]??[],current=currentKey(c,keys,e.tick),on=current?.tick===Math.floor(time),d=property&&vfxDescriptor(property);
 return `<div class="vfx-key-navigation"><button type="button" class="vfx-channel-trigger" data-clip-action="channels" aria-label="Visible effect keys" aria-haspopup="dialog" data-tooltip="${esc(vfxChannelLabel(e,c))}" ${messageAttributes(vfxChannelMessage(e,c).messageKey,vfxChannelMessage(e,c).messageParams,"data-tooltip")} data-i18n-aria-label="vfxClipInspector.visibleEffectKeys">${icon('diamond')}<span ${messageAttributes(vfxChannelMessage(e,c).messageKey,vfxChannelMessage(e,c).messageParams)}>${esc(vfxChannelLabel(e,c))}</span>${icon('chevron-down')}</button>${seek(previous,interfaceText("vfxClipInspector.previousEffectKey"),'chevron-left', {label: {key: "vfxClipInspector.previousEffectKey", params: {}}})}${property?`<button class="ui-icon-button vfx-key${keys.length?' is-animated':''}${on?' is-keyed':''}" data-size="xs" type="button" data-clip-key-property="${esc(property)}" aria-label="${on?interfaceText("vfxClipInspector.remove"):interfaceText("vfxClipInspector.add")} selected value key" ${locked?'disabled':''} ${messageAttributes("vfxClipInspector.selectedValueKey", {value: on?{messageKey: "vfxClipInspector.remove"}:{messageKey: "vfxClipInspector.add"}}, "aria-label")}>${icon('diamond')}</button>`:''}${seek(next,interfaceText("vfxClipInspector.nextEffectKey"),'chevron-right', {label: {key: "vfxClipInspector.nextEffectKey", params: {}}})}${property?`<select class="vfx-easing" data-clip-easing="${esc(property)}" aria-label="${esc(d.label)} easing" ${locked||!current?'disabled':''} ${messageAttributes("vfxClipInspector.easing", {label: {messageKey:effectMessages[d.effectType]?.params[d.param]?.labelKey??"vfxChannels.enabled"}}, "aria-label")}>${(d.discrete?['constant']:['linear','auto','ease-in','ease-out','constant']).map(mode=>`<option value="${mode}" ${current?.interpolation===mode?'selected':''} ${messageAttributes(easingMessageKeys[mode])}>${interfaceText(easingMessageKeys[mode])}</option>`).join('')}</select>`:''}</div>`;
}
export function clipKeyControls(host){const clip=host.renderedVfxClip;if(!clip)return '';return keyNavigation(host,clip,lockedClip(host.editor,clip));}
function clipBody(host,c,locked){
 const e=host.editor;
 const number=(key,labelKey,value,min=0,max=10000000)=>clipNumber(host,c,key,labelKey,value,min,max,locked);
 const effects=e.sampleVfxClip(c.id),picked=vfxSelectedChannels(e,c),expanded=new Set([...host.root.querySelectorAll('.vfx-clip-effect[open]')].map(node=>node.dataset.groupEffect));host.renderingClip=c.id;
 // A group shows its selected effect open the first time it is displayed.
 host.shownGroups??=new Set();if(!host.shownGroups.has(c.id)){host.shownGroups.add(c.id);expanded.add(host.selectedClipEffect??effects[0]?.id);}
 let body=c.effects.length>1||c.strength!==1?`<div class="vfx-fields">${clipStrength(host,c,locked)}</div>`:'';
 try{
  // Combining is the everyday way to build an effect, so its button sits in view under the settings, never only in ⋯.
  body+=effects.length===1?`<div class="vfx-clip-effect vfx-fields" data-section="clip-effect-${effects[0].id}">${effectFields(host,c,effects[0],locked,picked)}</div><button type="button" class="vfx-group-add" data-clip-action="group-add" data-tooltip="Layer another effect with this one, as a group" ${locked||c.effects.length>=VFX_LIMIT?'disabled':''} data-i18n-tooltip="vfxClipInspector.layerAnotherEffectWithThisOneAsA">${icon('combine')}<span data-i18n="vfxClipInspector.combineWithAnotherEffect">${messageHTML("vfxClipInspector.combineWithAnotherEffect", {})}</span></button>`:`<h4 class="vfx-subhead" data-i18n="vfxClipInspector.effectsInThisGroup">${messageHTML("vfxClipInspector.effectsInThisGroup", {})}</h4><div class="vfx-members" role="list" aria-label="Effects in ${esc(clipName(c))}" ${messageAttributes("vfxClipInspector.effectsIn", {value: clipNameMessage(c)}, "aria-label")}>${effects.map(effect=>{
   const name=vfxGroupEffectName(c,effect),nameMessage=effectNameMessage(c,effect),d=VFX_REGISTRY[effect.type];
   return `<details class="vfx-clip-effect${host.selectedClipEffect===effect.id?' is-effect-selected':''}${effect.enabled?'':' is-disabled'}" role="listitem" data-section="clip-effect-${effect.id}" data-group-effect="${effect.id}" name="vfx-effects-${c.id}" ${expanded.has(effect.id)?'open':''}><summary><button type="button" class="vfx-grip" data-vfx-group-drag draggable="${!locked}" aria-label="Reorder ${esc(name)}" data-tooltip="Drag to reorder · Alt+↑/↓" ${locked?'disabled':''} ${messageAttributes("vfxClipInspector.reorder", {name: nameMessage}, "aria-label")} data-i18n-tooltip="vfxClipInspector.dragToReorderAlt">${vfxIcon('grip')}</button>${vfxTile(d.icon,d.category)}<span class="vfx-row-name" ${messageAttributes(nameMessage.messageKey,nameMessage.messageParams)}>${esc(name)}</span><span class="vfx-group-actions">${iconButton('effect-enable',`${effect.enabled?interfaceText("vfxClipInspector.disable"):interfaceText("vfxClipInspector.enable")} ${name}`,effect.enabled?'eye':'eye-off',{disabled:locked,on:!effect.enabled,className:'vfx-row-eye'}, {label:{key:'vfxChannels.toggleEffect',params:{action:{messageKey:effect.enabled?'vfxClipInspector.disable':'vfxClipInspector.enable'},name:nameMessage}}})}${iconButton('effect-menu',interfaceText("vfxClipInspector.effectActions"),'more',{disabled:locked,menu:true,className:'vfx-row-more'}, {label: {key: "vfxClipInspector.effectActions", params: {}}})}</span>${icon('chevron-right','vfx-chevron')}</summary><div class="vfx-fields">${effectFields(host,c,effect,locked,picked)}</div></details>`;
  }).join('')}<button type="button" class="vfx-group-add" data-clip-action="group-add" data-tooltip="Layer another effect into this group" ${locked||c.effects.length>=VFX_LIMIT?'disabled':''} data-i18n-tooltip="vfxClipInspector.layerAnotherEffectIntoThisGroup">${icon('plus')}<span data-i18n="vfxClipInspector.addToGroup">${messageHTML("vfxClipInspector.addToGroup", {})}</span></button></div>`;
 }finally{host.renderingClip=null;}
 // Timing: the whole animation, or a frame range with its start and length.
 body+=`<div class="vfx-timing" data-section="clip-timing-${c.id}"><h4 class="vfx-subhead" data-i18n="vfxClipInspector.timing">${messageHTML("vfxClipInspector.timing", {})}</h4><div class="vfx-row"><span class="vfx-label" data-i18n="vfxClipInspector.plays">${messageHTML("vfxClipInspector.plays", {})}</span><select class="vfx-select" data-clip-field="mode" aria-label="Effect duration" ${locked?'disabled':''} data-i18n-aria-label="vfxClipInspector.effectDuration"><option value="always" ${c.duration===null?'selected':''} data-i18n="vfxClipInspector.wholeAnimation">${messageHTML("vfxClipInspector.wholeAnimation", {})}</option><option value="timed" ${c.duration!==null?'selected':''} data-i18n="vfxClipInspector.frameRange">${messageHTML("vfxClipInspector.frameRange", {})}</option></select></div>${c.duration===null?'':`<div class="vfx-clip-timing">${number('start',"vfxClipInspector.start",c.start+1,1,10000001-c.duration)+number('duration',"vfxClipInspector.duration",c.duration,1,10000000-c.start)}</div>`}</div>`;
 // Keep this effect for any figure or project: My presets in the catalogue.
 body+=`<div class="vfx-detail-foot"><button type="button" class="ui-button vfx-save-preset" data-size="sm" data-variant="ghost" data-clip-action="save-preset" data-label="Save as preset">${icon('library')}<span class="ui-label" data-i18n="vfxClipInspector.saveAsPreset">${messageHTML("vfxClipInspector.saveAsPreset", {})}</span></button></div>`;
 return body;
}
/** The effect clips on the current targets, filtered by the Show choice: one entry each, and the selected one
 opens its settings directly under its row, so the settings always read as that effect's. */
export function clipRowsHTML(host,targets){
 const e=host.editor,clips=targets.flatMap(t=>e.getVfxClips(t)),view=host.clipView??'playhead',query=(host.clipQuery??'').toLowerCase();
 const visible=filterVfxClips(e,clips,{view,tick:e.tick,selected:host.selectedClip,query});
 host.renderedVfxClip=visible.find(c=>c.id===host.selectedClip)??null;
 const html=visible.map(c=>{
  const locked=lockedClip(e,c),selected=c.id===host.selectedClip,range=c.duration===null?'':`<span class="vfx-row-meta" data-tooltip="Plays on frames ${c.start+1}–${c.start+c.duration}" ${messageAttributes("vfxClipInspector.playsOnFrames", {value: c.start+1, value2: c.start+c.duration}, "data-tooltip")}>${c.start+1}–${c.start+c.duration}</span>`;
  const row=`<div class="vfx-clip vfx-item${selected?' is-selected':''}${c.enabled?'':' is-disabled'}" data-section="clip-${c.id}" data-clip-id="${c.id}"><button type="button" class="vfx-item-select" data-clip-action="select" aria-expanded="${selected}">${clipTile(c)}<span class="vfx-row-name" ${!c.name?messageAttributes(clipNameMessage(c).messageKey):''}>${esc(clipName(c))}</span></button>${range}${iconButton('enabled',c.enabled?interfaceText("vfxClipInspector.disableClip"):interfaceText("vfxClipInspector.enableClip"),c.enabled?'eye':'eye-off',{disabled:locked,on:!c.enabled,className:'vfx-row-eye'},{label:{key:c.enabled?'vfxClipInspector.disableClip':'vfxClipInspector.enableClip'}})}${iconButton('menu',interfaceText("vfxClipInspector.effectClipActions"),'more',{menu:true,className:'vfx-row-more'}, {label: {key: "vfxClipInspector.effectClipActions", params: {}}})}${icon('chevron-right','vfx-chevron')}</div>`;
  return `<div class="vfx-entry${selected?' is-open':''}" role="listitem" data-section="entry-${c.id}">${row}${selected?clipDetailHTML(host):''}</div>`;
 }).join('');
 return {html,total:clips.length,shown:visible.length};
}
/** The selected clip's settings, under its row: a group's strength and its effects, then Timing. */
function clipDetailHTML(host){
 const c=host.renderedVfxClip;if(!c)return '';
 return `<section class="vfx-detail" data-section="vfx-detail-${c.id}" data-clip-id="${c.id}" aria-label="${esc(clipName(c))} settings" ${messageAttributes("vfxClipInspector.settings", {value: clipNameMessage(c)}, "aria-label")}>${clipBody(host,c,lockedClip(host.editor,c))}</section>`;
}
export function selectClip(host,id){
 host.commit();host.selectedClip=id;host.selected=null;host.selectedClipEffect=host.editor.getVfxClips().find(c=>c.id===id)?.effects[0]?.id??null;host.editor._selectedVfxClip=id;host.editor._selectedVfxKey=null;
 host.editor._emit('vfx-selection');host.sync();host.onChange();
}
function renameClip(host,id){
 const row=host.root.querySelector(`.vfx-clip[data-clip-id="${CSS.escape(id)}"]`),c=host.editor.getVfxClips().find(c=>c.id===id);if(!row||!c)return;
 const input=document.createElement('input');input.className='vfx-clip-rename';input.value=clipName(c);input.maxLength=120;localizedAttribute(input, 'aria-label', "vfxClipInspector.effectName", {});
 appendLocalized(row, input);input.focus();input.select();let done=false;
 const finish=save=>{if(done)return;done=true;if(save)host.run(()=>host.editor.setVfxClip(c.id,{name:input.value.trim()}));input.remove();host.sync();};
 input.addEventListener('blur',()=>finish(true));input.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Enter')finish(true);if(event.key==='Escape')finish(false);});
}
/** A clip row's menu (its ⋯, a right-click or Shift+F10): the kit's menu. */
export function openClipMenu(host,id,event){
 const e=host.editor,clips=e.getVfxClips(),c=clips.find(c=>c.id===id);if(!c)return;
 const locked=lockedClip(e,c),siblings=clips.filter(x=>JSON.stringify(x.target)===JSON.stringify(c.target)),index=siblings.indexOf(c),run=operation=>()=>clipOperation(host,operation,id);
 let menu=host.clipMenu;
 if(!menu){menu=host.clipMenu={editor:e,_run:fn=>host.run(fn)};host.abort.signal.addEventListener('abort',()=>{menu.menuEvents?.abort();menu.menu?.remove();},{once:true});}
 showTimelineMenu(menu,event,[
  [{label:interfaceText("vfxClipInspector.rename"), labelKey: "vfxClipInspector.rename",symbol:'text',disabled:locked,action:()=>renameClip(host,id)},{label:c.effects.length>1?interfaceText("vfxClipInspector.addEffectToGroup"):interfaceText("vfxClipInspector.combineWithAnotherEffect2"), labelKey: (c.effects.length>1 ? "vfxClipInspector.addEffectToGroup" : "vfxClipInspector.combineWithAnotherEffect2"), labelParams: (c.effects.length>1 ? {} : {}),symbol:'combine',disabled:locked||c.effects.length>=VFX_LIMIT,action:()=>{host.commit();host.addToGroup=id;host.openPopup(host.root.querySelector(`.vfx-clip[data-clip-id="${CSS.escape(id)}"]`)??host.root,'add');}}],
  [{label:interfaceText("vfxClipInspector.moveUp"), labelKey: "vfxClipInspector.moveUp",symbol:'chevron-up',disabled:locked||index<=0,action:run('up')},{label:interfaceText("vfxClipInspector.moveDown"), labelKey: "vfxClipInspector.moveDown",symbol:'chevron-down',disabled:locked||index>=siblings.length-1,action:run('down')}],
  [{label:interfaceText("vfxClipInspector.saveAsPreset2"), labelKey: "vfxClipInspector.saveAsPreset2",symbol:'library',action:()=>{host.commit();void savePresetFromClip(host,id);}}],
  [{label:interfaceText("vfxClipInspector.copyAnimation"), labelKey: "vfxClipInspector.copyAnimation",symbol:'duplicate',action:run('copy')},{label:interfaceText("common.duplicate"), labelKey: "common.duplicate",symbol:'duplicate',disabled:locked,action:run('duplicate')}],
  [{label:interfaceText('vfxClipInspector.delete'), labelKey: "common.delete",symbol:'trash',danger:true,disabled:locked,action:run('delete')}],
 ]);
}
/** One clip operation as one undo step. */
function clipOperation(host,operation,id){
 const e=host.editor;host.commit();host.beforeEdit();
 if(operation==='enabled'){const c=e.getVfxClips().find(c=>c.id===id);e.setVfxClip(id,{enabled:!c.enabled});}
 if(operation==='delete'){e.deleteVfxClip(id);if(id===host.selectedClip)selectClip(host,null);}
 if(operation==='copy')e.copyVfxClip(id);
 if(operation==='paste')e.movieclipBatch(interfaceText("vfxClipInspector.pasteEffectAnimation"),()=>{for(const target of host.targets())selectClip(host,e.pasteVfxClip(target));});
 if(operation==='duplicate')selectClip(host,e.duplicateVfxClip(id));
 if(operation==='up'||operation==='down')e.moveVfxClipOrder(id,operation==='up'?-1:1);
 host.sync();host.onChange();
}
export function clipClick(host,event){
 const e=host.editor,button=event.target.closest('button'),row=event.target.closest('[data-clip-id]'),id=row?.dataset.clipId??host.renderedVfxClip?.id;
 if(!button){const summary=event.target.closest('.vfx-clip-effect>summary');if(summary){host.selectedClipEffect=summary.closest('[data-group-effect]').dataset.groupEffect;host.sync();host.onChange();return true;}return false;}
 if(button.disabled)return false;
 if(button.hasAttribute('data-vfx-group-drag')){event.preventDefault();return true;}
 if(button.dataset.clipKeyProperty){host.commit();e.toggleVfxClipKey(id,button.dataset.clipKeyProperty);host.sync();host.onChange();return true;}
 if(button.dataset.clipKey){host.commit();const b=host.bindings.get(button.dataset.clipKey);e.toggleVfxClipKey(b.clip,b.property);const clip=e.getVfxClips().find(c=>c.id===b.clip);if(clip.keys[b.property]?.length)setVfxVisibleChannels(e,clip,[b.property]);host.sync();host.onChange();return true;}
 if(button.dataset.clipSeek!==undefined){e.seek(Number(button.dataset.clipSeek),{allowBeyondEnd:true});host.sync();return true;}
 const operation=button.dataset.clipAction;if(!operation)return false;
 const c=id&&e.getVfxClips().find(c=>c.id===id);
 if(operation==='select'){selectClip(host,host.selectedClip===id?null:id);return true;}
 if(operation==='menu'){host.commit();openClipMenu(host,id,{currentTarget:button});return true;}
 if(operation==='channels'){host.commit();openVfxChannelMenu(e,c,button,{signal:host.abort.signal});return true;}
 if(operation.startsWith('effect-')){
  event.preventDefault();const effectId=button.closest('[data-group-effect]').dataset.groupEffect;
  if(operation==='effect-menu'){host.commit();openGroupMenu(host,c,effectId,button);}else editGroupEffect(host,c,effectId,operation);return true;
 }
 if(operation==='group-add'){host.commit();host.addToGroup=id;host.openPopup(button,'add');return true;}
 if(['enabled','paste'].includes(operation)){clipOperation(host,operation,id);return true;}
 if(operation==='save-preset'){host.commit();void savePresetFromClip(host,id,button);return true;}
 host.commit();host.beforeEdit();
 if(operation==='shuffle'){const effect=c.effects.find(x=>x.id===button.dataset.effectId),seed=effect?.params.seed??1;e.setVfxClipParameters(id,button.dataset.effectId,{seed:1+(seed+Math.floor(Math.random()*65533))%65535});host.sync();host.onChange();return true;}
 if(operation==='aim-pick'){const effect=button.dataset.effectId,active=e._vfxAimPick?.clip===id&&e._vfxAimPick.effect===effect;e._vfxAimPick=active?null:{clip:id,effect};host.sync();host.onChange();return true;}
 if(operation==='aim-clear'){
  // Unlock in place: the stage point starts where the locked node is now.
  e._vfxAimPick=null;const p=c.effects.find(x=>x.id===button.dataset.effectId)?.params??{},g=[...(e.geometry?.objects?.values()??[])].find(g=>g?.obj?.unique_id===p.aimUid),at=g&&(p.aimHandle?g.joints?.get(p.aimHandle):g.root);
  e.setVfxClipParameters(id,button.dataset.effectId,{aimUid:0,aimHandle:0,...(at?{aimX:Math.max(-1,Math.min(2,at.x/e.report.canvas_width)),aimY:Math.max(-1,Math.min(2,at.y/e.report.canvas_height))}:{})});host.sync();host.onChange();return true;
 }
 return false;
}
export function clipChange(host,event){
 const input=event.target,e=host.editor,id=input.closest('[data-clip-id]')?.dataset.clipId??host.renderedVfxClip?.id;
 if(input.hasAttribute('data-clip-view')){host.clipView=input.value;host.sync();return true;}
 if(input.hasAttribute('data-clip-search')){host.clipQuery=input.value;host.sync();return true;}
 if(input.dataset.clipEasing){const c=e.getVfxClips().find(c=>c.id===id),property=input.dataset.clipEasing,selected=currentKey(c,c.keys[property],e.tick);e.setVfxClipEasing(id,property,selected.tick,vfxDescriptor(property).discrete?'constant':input.value);host.sync();return true;}
 const key=input.dataset.clipField;if(!key)return false;host.commit();host.beforeEdit();
 if(key==='mode')e.setVfxClip(id,input.value==='always'?{duration:null,start:0,offset:0}:{start:Math.floor(e.tick),duration:Math.max(1,Math.min(24,e.totalTicks-Math.floor(e.tick))),offset:0});
 else e.setVfxClip(id,{[key]:key==='includeAttached'?input.checked:key==='strength'?Number(input.value)/100:key==='start'?Number(input.value)-1:Number(input.value)});
 host.sync();host.onChange();return true;
}
