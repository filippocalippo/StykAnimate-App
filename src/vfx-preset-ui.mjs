
import {t as interfaceText} from './localization.mjs';
import {messageAttributes, messageHTML} from './localization-bindings.mjs';
/**
 * The VFX panel's side of the person's own presets (vfx-user-presets.mjs):
 * saving the selected effect under a name, the My presets cards in the
 * catalogue and the suggestions, and renaming or deleting a preset. Presets
 * live outside the project, so none of this is part of undo.
 */
import {vfxPresetStore,presetName,USER_PRESET_NAME_LENGTH} from './vfx-user-presets.mjs';
import {VFX_REGISTRY} from './vfx.mjs';
import {effectAvailable} from './vfx-registry.mjs';
import {effectMessages} from './vfx-localization.mjs';
import {vfxTile} from './vfx-icons.mjs';
import {icon} from './icons.mjs';
import {prompt,confirm} from './ui/ui-dialog.mjs';
import {showTimelineMenu} from './timeline-menu.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/** The prefix of a My presets choice in the catalogue (`mine:<id>`). */
export const MINE='mine:';

/** A preset's glyph: its one effect's, or the group glyph. */
export const presetTile=(preset,className)=>{const d=preset.effects.length===1&&VFX_REGISTRY[preset.effects[0].type];return d?vfxTile(d.icon,d.category,className):vfxTile('effects','Looks',className);};
/** What a preset holds, in a few words: "Glow", "3 effects", with "animated" when it has keys. */
export const presetSummaryMessage=preset=>{const count=preset.effects.length,animated=Object.keys(preset.keys).length>0;const summary=count===1?{messageKey:effectMessages[preset.effects[0].type]?.nameKey??'vfxPresetUi.effect'}:{messageKey:'counts.effects',messageParams:{count}};return animated?{messageKey:'vfxPresetUi.animatedSummary',messageParams:{summary,count}}:summary;};
export const presetSummary=preset=>{const summary=presetSummaryMessage(preset);return interfaceText(summary.messageKey,summary.messageParams);};
/** The presets that can go on this kind of target (scene-only effects need the scene). */
export const usablePresets=scene=>vfxPresetStore.presets.filter(preset=>preset.effects.every(effect=>effectAvailable(effect.type,scene)));

/** The catalogue's My presets section: a card per preset with its ⋯, or a note on how to make one. */
export function myPresetsSection(scene,query,{disabled=false}={}){
 const presets=usablePresets(scene).filter(p=>(p.name+' '+presetSummary(p)).toLowerCase().includes(query));
 if(query&&!presets.length)return '';
 const body=presets.length
  ?`<div class="vfx-catalog-grid vfx-my-presets">${presets.map(p=>{const summary=presetSummaryMessage(p);return `<div class="vfx-my-preset"><button type="button" class="vfx-catalog-card" data-choice="${MINE}${esc(p.id)}" ${disabled?'disabled':''}>${presetTile(p,'vfx-catalog-art')}<span class="vfx-my-preset-text"><span>${esc(p.name)}</span><small>${messageHTML(summary.messageKey,summary.messageParams)}</small></span></button><button type="button" class="ui-icon-button vfx-my-preset-more" data-size="xs" data-preset-menu="${esc(p.id)}" aria-label="${esc(p.name)} preset actions" aria-haspopup="menu" ${messageAttributes("vfxPresetUi.presetActions", {name: p.name}, "aria-label")}>${icon('more')}</button></div>`;}).join('')}</div>`
  :`<p class="vfx-my-presets-empty">${icon('library')}<span>${messageHTML("vfxPresetUi.saveAnEffectYouLikeWith", {})} <b data-i18n="vfxPresetUi.saveAsPreset">${messageHTML("vfxPresetUi.saveAsPreset", {})}</b> ${messageHTML("vfxPresetUi.underItsSettingsAndItWaitsHereFor", {})}</span></p>`;
 return `<section class="vfx-my-presets-section"><h3 data-i18n="vfxPresetUi.myPresets">${messageHTML("vfxPresetUi.myPresets", {})}</h3>${body}</section>`;
}

/**
 * Asks for a name and saves the clip `id` as a preset. A name already in use asks before replacing that
 * preset. `button` (optional) confirms in place with "Saved to My presets".
 */
export async function savePresetFromClip(host,id,button){
 const clip=host.editor.getVfxClips().find(c=>c.id===id);if(!clip)return;
 await vfxPresetStore.load();
 const name=await prompt({title:interfaceText("vfxPresetUi.saveAsPreset"), titleKey: "vfxPresetUi.saveAsPreset",label:interfaceText("common.name"), labelKey: "common.name",value:clip.name||interfaceText(effectMessages[clip.effects[0]?.type]?.nameKey??'vfxPresetUi.effects'),maxLength:USER_PRESET_NAME_LENGTH,confirmLabel:interfaceText("vfxPresetUi.save"), confirmLabelKey: "vfxPresetUi.save", confirmLabelParams: {},
  description:interfaceText("vfxPresetUi.keepsItsEffectsSettingsTimingAndKeysReady"), descriptionKey: "vfxPresetUi.keepsItsEffectsSettingsTimingAndKeysReady",validate:text=>presetName(text)?null:interfaceText("vfxPresetUi.nameThePreset")});
 if(name==null)return;
 const existing=vfxPresetStore.named(name);
 if(existing&&!await confirm({title:interfaceText("vfxPresetUi.replace", {name: existing.name}), titleKey: "vfxPresetUi.replace", titleParams: {name: existing.name},description:interfaceText("vfxPresetUi.thatPresetTakesThisEffectSSettingsFigures"), descriptionKey: "vfxPresetUi.thatPresetTakesThisEffectSSettingsFigures",confirmLabel:interfaceText("vfxPresetUi.replace2"), confirmLabelKey: "vfxPresetUi.replace2", confirmLabelParams: {}}))return;
 try{await vfxPresetStore.save(clip,name);}catch(error){host.onError(error);return;}
 if(button?.isConnected)flash(button,interfaceText("vfxPresetUi.savedToMyPresets"));
}
/** Says "Saved to My presets" on the button for a moment: in its word, or, on an icon button, in its name and
 * tooltip with a check in place of its glyph. */
function flash(button,text){
 clearTimeout(button._flash);button.dataset.saved='';
 const label=button.querySelector('.ui-label');
 if(label){const was=label.textContent;label.textContent=text;button._flash=setTimeout(()=>{delete button.dataset.saved;label.textContent=button.dataset.label??was;},2200);return;}
 const name=button.getAttribute('aria-label'),tip=button.getAttribute('data-tooltip'),glyph=button.innerHTML;
 button.setAttribute('aria-label',text);button.setAttribute('data-tooltip',text);button.innerHTML=icon('check');
 button._flash=setTimeout(()=>{delete button.dataset.saved;if(name!==null)button.setAttribute('aria-label',name);if(tip!==null)button.setAttribute('data-tooltip',tip);button.innerHTML=glyph;},2200);
}

/** A My presets card's menu (its ⋯ or a right-click): Rename… and Delete…. */
export function openPresetMenu(host,id,event,{onDone=()=>{}}={}){
 const preset=vfxPresetStore.find(id);if(!preset)return;
 let menu=host.presetMenu;
 if(!menu){menu=host.presetMenu={editor:host.editor,_run:fn=>host.run(fn)};host.abort.signal.addEventListener('abort',()=>{menu.menuEvents?.abort();menu.menu?.remove();},{once:true});}
 const run=fn=>()=>{host.closePopup();void fn().catch(error=>host.onError(error)).finally(onDone);};
 showTimelineMenu(menu,event,[
  [{label:interfaceText("vfxPresetUi.rename"), labelKey: "vfxPresetUi.rename",symbol:'text',action:run(async()=>{const name=await prompt({title:interfaceText("vfxPresetUi.renamePreset"), titleKey: "vfxPresetUi.renamePreset",label:interfaceText("common.name"), labelKey: "common.name",value:preset.name,maxLength:USER_PRESET_NAME_LENGTH,confirmLabel:interfaceText("vfxPresetUi.rename2"), confirmLabelKey: "vfxPresetUi.rename2", confirmLabelParams: {},validate:text=>{const title=presetName(text),other=title&&vfxPresetStore.named(title);return !title?interfaceText("vfxPresetUi.nameThePreset"):other&&other.id!==id?interfaceText('errors.vfxUserPresets.aPresetNamedAlreadyExists',{name:other.name}):null;}});if(name!=null)await vfxPresetStore.rename(id,name);})}],
  [{label:interfaceText("vfxPresetUi.delete"), labelKey: "vfxPresetUi.delete",symbol:'trash',danger:true,action:run(async()=>{if(await confirm({title:interfaceText("vfxPresetUi.delete2", {name: preset.name}), titleKey: "vfxPresetUi.delete2", titleParams: {name: preset.name},description:interfaceText("vfxPresetUi.effectsAlreadyAddedFromItStayAsThey"), descriptionKey: "vfxPresetUi.effectsAlreadyAddedFromItStayAsThey",confirmLabel:interfaceText('vfxPresetUi.delete3'), confirmLabelKey: 'vfxPresetUi.delete3', confirmLabelParams: {},danger:true}))await vfxPresetStore.remove(id);})}],
 ]);
}
