import {tupleMessages, messageTuple, messageAttributes, messageHTML, localizedText} from './localization-bindings.mjs';

import {messageError} from './localized-error.mjs';
import {t as interfaceText} from './localization.mjs';

import {CAMERA_MOTION_TYPES,MOTION_PARAMETERS,isWholeMotionParameter,validateCameraMotion} from './camera-motion.mjs';
import {followFramingOffset} from './camera-follow.mjs';
import {motionTypeMessages,motionParameterMessages,motionDescriptionMessages} from './camera-motion-localization.mjs';
import {CameraMotionGraph,motionGraphView} from './camera-motion-graph.mjs';
import {cameraMonitorVisible} from './camera-monitor.mjs';
import {placement} from './engine/engine-pictures.mjs';
import {validateParallax} from './layer-parallax.mjs';
import {icon} from './icons.mjs';
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const symbols={follow:'person',shake:'activity',handheld:'camera',wobble:'rotate',impact:'center',pulse:'zoom-in'};
/** What each preset does, in the words the gallery and the card use. */
const action=(name,symbol,label,extra='', _messages = {})=>`<button class="ui-icon-button" data-size="sm" data-motion-action="${name}" title="${label}" aria-label="${label}" ${extra} ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params, 'title') : ''} ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params, 'aria-label') : ''}>${icon(symbol)}</button>`;
const scrubLabel=(label,enabled=true,disabled=false,message)=>`<span ${enabled?`class="property-scrub" data-property-scrub tabindex="${disabled?-1:0}" role="button" ${disabled?'aria-disabled="true"':''} aria-label="${esc(interfaceText('inspectorLegacy.scrub',{description:message?{messageKey:message.key,messageParams:message.params}:label}))}" ${messageAttributes('inspectorLegacy.scrub',{description:message?{messageKey:message.key,messageParams:message.params}:label},'aria-label')} title="${esc(interfaceText('inspectorLegacy.dragToAdjustShiftFineAltExtraFine'))}" data-i18n-title="inspectorLegacy.dragToAdjustShiftFineAltExtraFine"`:''}>${message?messageHTML(message.key,message.params):esc(label)}</span>`;
const field=(label,key,value,unit='',extra='',step=1,precision=0,disabled=false, _messages = {})=>`<div class="property-row" data-property-row="motion_${key}"><label class="field motion-field">${scrubLabel(label,key!=='seed',disabled,_messages.label)}<input type="number" data-motion-field="${key}" data-property="motion_${key}" data-property-value="${value}" data-property-step="${step}" data-property-precision="${precision}" value="${Number(value.toFixed(4))}" aria-label="${esc(label)}" ${extra} ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params, 'aria-label') : ''}><small>${unit}</small></label></div>`;
const factorOf=key=>MOTION_PARAMETERS[key][4]==='%'?100:1;
function parameter(clip,key,disabled,label=interfaceText(motionParameterMessages[key])){const [,min,max,step,unit]=MOTION_PARAMETERS[key],factor=factorOf(key),whole=isWholeMotionParameter(key);return field(label,key,clip.params[key]*factor,unit==='frames'?'f':unit,`min="${min*factor}" max="${max*factor}" step="${whole?1:'any'}"`,step*factor,whole?0:3,disabled,{label:{key:motionParameterMessages[key]}});}
/**
 * A slider with its typed value. The slider covers the useful range (`soft`); typing reaches the full saved range.
 * `key` may be a pseudo field: `move` sets Move X and Y together.
 */
function slider(clip,key,label,soft,disabled,hint='', _messages = {}){
  const param=key==='move'?'moveX':key,[,min,max,step,unit]=MOTION_PARAMETERS[param],factor=factorOf(param),value=clip.params[param]*factor;
  const top=Math.max(soft,value),lower=min*factor,percent=top>lower?Math.round((value-lower)/(top-lower)*1000)/10:0,whole=isWholeMotionParameter(param);
  const shown=unit==='frames'?'f':unit==='%'?'%':unit;
  return `<div class="ui-slider-row motion-slider-row" data-motion-row="${key}" data-property-row="motion_${key}"${_messages.hint?' '+messageAttributes(_messages.hint.key,_messages.hint.params,'title'):hint?` title="${esc(hint)}"`:''}><span class="ui-slider-label" ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params) : ''}>${label}</span>`+
    `<input class="ui-slider" type="range" data-motion-field="${key}" min="${lower}" max="${top}" step="${whole?1:step*factor}" value="${value}" style="--_p:${percent}%" aria-label="${label}" ${disabled?'disabled':''} ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params, 'aria-label') : ''}>`+
    `<label class="motion-slider-value"><input type="number" data-motion-field="${key}" min="${lower}" max="${max*factor}" step="${whole?1:'any'}" value="${Number(value.toFixed(whole?0:2))}" aria-label="${label} value" ${disabled?'disabled':''} ${messageAttributes("cameraMotionUi.value", {label: _messages.label?{messageKey:_messages.label.key,messageParams:_messages.label.params}:label}, "aria-label")}><small>${shown}</small></label></div>`;
}
function figureName(editor,uid){
  const object=editor.selectionFrame.objects.find(o=>o.unique_id===uid)??editor.evaluatedFrame.objects.find(o=>o.unique_id===uid);
  return object?editor.report.figure_types.find(f=>f.figure_type_id===object.figure_type_id)?.name||`Figure ${uid}`:null;
}
const followSummary=(editor,clip)=>clip.targets.map(t=>figureName(editor,t.uid)??interfaceText("cameraMotionUi.missingFigure")).join(', ');
function gallery(locked,compact){
  return `<div class="motion-gallery${compact?' is-compact':''}" role="group" aria-label="Add a camera move" data-i18n-aria-label="cameraMotionUi.addACameraMove">${Object.keys(CAMERA_MOTION_TYPES).map(type=>`<button type="button" class="motion-tile" data-motion-add="${type}" data-kind="${type}" ${locked?'disabled':''}><span class="motion-tile-icon">${icon(symbols[type])}</span><span class="motion-tile-text"><strong>${messageHTML(motionTypeMessages[type])}</strong><small>${messageHTML(motionDescriptionMessages[type])}</small></span></button>`).join('')}</div>`;
}
function followCard(editor,clip,locked){
  const p=clip.params,axes=p.followX&&p.followY?'both':p.followX?'x':p.followY?'y':'both',selected=[...editor.selectedUids].filter(uid=>!clip.targets.some(t=>t.uid===uid));
  const rows=clip.targets.map(t=>{const name=figureName(editor,t.uid);return `<div class="motion-target${name?'':' is-missing'}" data-follow-uid="${t.uid}"><span class="motion-target-name" title="${esc(name??interfaceText("cameraMotionUi.thisFigureIsNotInTheAnimationAny"))}">${icon('person')}${esc(name??interfaceText("cameraMotionUi.missingFigure"))}</span>`+
    // With one figure there is nothing to weigh; a follow always keeps at least one figure.
    (clip.targets.length<2?'':`<input class="ui-slider" type="range" min="0" max="100" step="1" value="${Math.round(t.weight*100)}" style="--_p:${Math.round(t.weight*100)}%" data-follow-weight="${t.uid}" aria-label="Weight of ${esc(name??{messageKey:'cameraMotionUi.missingFigure'})}" title="How much this figure pulls the shot" ${locked?'disabled':''} ${messageAttributes("cameraMotionUi.weightOf", {value: name??{messageKey:'cameraMotionUi.missingFigure'}}, "aria-label")} data-i18n-title="cameraMotionUi.howMuchThisFigurePullsTheShot">`+
    `<button type="button" class="ui-icon-button" data-size="sm" data-follow-remove="${t.uid}" aria-label="Stop following ${esc(name??{messageKey:'cameraMotionUi.missingFigure'})}" title="Stop following" ${locked?'disabled':''} ${messageAttributes("cameraMotionUi.stopFollowing", {value: name??{messageKey:'cameraMotionUi.missingFigure'}}, "aria-label")} data-i18n-title="cameraMotionUi.stopFollowing2">${icon('close')}</button>`)+'</div>';}).join('');
  return `<div class="motion-group"><div class="motion-group-head"><span data-i18n="cameraMotionUi.following">Following</span></div><div class="motion-targets">${rows}</div>`+
    `<button type="button" class="ui-button motion-follow-add" data-size="sm" data-variant="ghost" data-motion-action="follow-selected" ${locked||!selected.length?'disabled':''} title="${selected.length?interfaceText("cameraMotionUi.addTheSelectedFigures"):interfaceText("cameraMotionUi.selectFiguresOnTheCanvasToAddThem")}" ${messageAttributes((selected.length ? "cameraMotionUi.addTheSelectedFigures" : "cameraMotionUi.selectFiguresOnTheCanvasToAddThem"), (selected.length ? {} : {}), "title")}>${icon('plus')}${messageHTML("cameraMotionUi.followSelectedFigures", {})}</button></div>`+
    `<div class="motion-group"><div class="motion-group-head"><span data-i18n="cameraMotionUi.camera">Camera</span></div>`+
    slider(clip,'strength',interfaceText("cameraMotionUi.amount"),100,locked,interfaceText("cameraMotionUi.howStronglyTheCameraFollows"), {label: {key: "cameraMotionUi.amount", params: {}}, hint: {key: "cameraMotionUi.howStronglyTheCameraFollows", params: {}}})+
    slider(clip,'lag',interfaceText("cameraMotionUi.smoothness"),30,locked,interfaceText("cameraMotionUi.howLongTheCameraTakesToCatchUp"), {label: {key: "cameraMotionUi.smoothness", params: {}}, hint: {key: "cameraMotionUi.howLongTheCameraTakesToCatchUp", params: {}}})+
    slider(clip,'deadZone',interfaceText("cameraMotionUi.deadZone"),60,locked,interfaceText("cameraMotionUi.roomTheFigureCanMoveBeforeTheCamera"), {label: {key: "cameraMotionUi.deadZone", params: {}}, hint: {key: "cameraMotionUi.roomTheFigureCanMoveBeforeTheCamera", params: {}}})+
    slider(clip,'lookAhead',interfaceText("cameraMotionUi.lookAhead"),24,locked,interfaceText("cameraMotionUi.leadsTheShotTowardWhereTheFigureIs"), {label: {key: "cameraMotionUi.lookAhead", params: {}}, hint: {key: "cameraMotionUi.leadsTheShotTowardWhereTheFigureIs", params: {}}})+
    `<div class="ui-slider-row motion-slider-row"><span class="ui-slider-label" data-i18n="cameraMotionUi.direction">Direction</span><div class="ui-segmented motion-axes" data-size="sm" data-fill role="group" aria-label="Follow direction" data-i18n-aria-label="cameraMotionUi.followDirection">${[messageTuple(['both',interfaceText("cameraMotionUi.both")], {1: {key: "cameraMotionUi.both", params: {}}}),messageTuple(['x',interfaceText("cameraMotionUi.across")], {1: {key: "cameraMotionUi.across", params: {}}}),messageTuple(['y',interfaceText("cameraMotionUi.upDown")], {1: {key: "cameraMotionUi.upDown", params: {}}})].map((_tuple) => {const [value,label] = _tuple; const _messages = tupleMessages(_tuple); return `<button type="button" class="ui-segmented-item" data-motion-axes="${value}" aria-pressed="${axes===value}" ${locked?'disabled':''}${_messages[1] ? ' ' + messageAttributes(_messages[1].key, _messages[1].params) : ''}>${label}</button>`;}).join('')}</div></div></div>`+
    `<div class="motion-group"><div class="motion-group-head"><span data-i18n="cameraMotionUi.framing">Framing</span></div>`+
    slider(clip,'zoomFit',interfaceText("cameraMotionUi.autoZoom"),100,locked,interfaceText("cameraMotionUi.zoomsToKeepEveryFollowedFigureInView"), {label: {key: "cameraMotionUi.autoZoom", params: {}}, hint: {key: "cameraMotionUi.zoomsToKeepEveryFollowedFigureInView", params: {}}})+
    (p.zoomFit>0?slider(clip,'padding',interfaceText("cameraMotionUi.margin"),40,locked,interfaceText('cameraMotionUi.spaceAroundFigures'), {label: {key: "cameraMotionUi.margin", params: {}},hint:{key:'cameraMotionUi.spaceAroundFigures'}})+slider(clip,'maxZoom',interfaceText("cameraMotionUi.zoomLimit"),6,locked,interfaceText("cameraMotionUi.howFarAutoZoomMayGoInOr"), {label: {key: "cameraMotionUi.zoomLimit", params: {}}, hint: {key: "cameraMotionUi.howFarAutoZoomMayGoInOr", params: {}}}):'')+
    `<div class="field-grid motion-offset">${parameter(clip,'offsetX',locked,interfaceText("cameraMotionUi.offsetX"))}${parameter(clip,'offsetY',locked,interfaceText("cameraMotionUi.offsetY"))}</div>`+
    `<button type="button" class="ui-button motion-keep-framing" data-size="sm" data-variant="ghost" data-motion-action="keep-framing" ${locked?'disabled':''} title="Keep the figure where it is in the shot now" data-i18n-title="cameraMotionUi.keepTheFigureWhereItIsInThe">${icon('center')}${messageHTML("cameraMotionUi.keepCurrentFraming", {})}</button></div>`;
}
function presetCard(clip,locked){
  const type=clip.type,noise=['shake','handheld'].includes(type);
  const main=type==='pulse'?[messageTuple(['zoom',interfaceText("cameraMotionUi.zoom"),30], {1: {key: "cameraMotionUi.zoom", params: {}}})]:[messageTuple(['move',interfaceText("cameraMotionUi.intensity"),type==='impact'?60:40], {1: {key: "cameraMotionUi.intensity", params: {}}}),messageTuple(['roll',interfaceText("cameraMotionUi.rotation"),10], {1: {key: "cameraMotionUi.rotation", params: {}}}),...(type==='impact'?[messageTuple(['zoom',interfaceText("cameraMotionUi.zoom"),30], {1: {key: "cameraMotionUi.zoom", params: {}}}),messageTuple(['recovery',interfaceText("cameraMotionUi.settle"),20], {1: {key: "cameraMotionUi.settle", params: {}}})]:[messageTuple(['frequency',interfaceText("cameraMotionUi.speed"),type==='shake'?20:4], {1: {key: "cameraMotionUi.speed", params: {}}})])];
  const advanced=[...(type!=='pulse'?['moveX','moveY']:[]),...(type==='impact'?['direction','frequency']:[]),...(noise?['roughness','seed']:[]),...(type==='wobble'?['phase']:[])];
  return `<div class="motion-group">${slider(clip,'strength',interfaceText("cameraMotionUi.amount"),100,locked,interfaceText("cameraMotionUi.overallStrengthOfThisMove"), {label: {key: "cameraMotionUi.amount", params: {}}, hint: {key: "cameraMotionUi.overallStrengthOfThisMove", params: {}}})}${main.map(([key,label,soft])=>slider(clip,key,label,soft,locked)).join('')}</div>`+
    (advanced.length?`<details class="motion-advanced" data-section="motion-advanced-${esc(clip.id)}"><summary>${icon('chevron-right')}${messageHTML("cameraMotionUi.fineTune", {})}</summary><div class="field-grid">${advanced.map(key=>parameter(clip,key,locked)).join('')}</div>${noise?`<button class="ui-button motion-randomize" data-size="sm" data-motion-action="randomize">${icon('rotate')}${messageHTML("cameraMotionUi.newVariation", {})}</button>`:''}</details>`:'');
}
export function cameraMotionView(editor){
  const clips=editor.getCameraMotions(),locked=editor.getLayer('camera')?.locked,clip=clips.find(c=>c.id===editor._selectedCameraMotion)??clips[0];
  if(!clips.length)return `<section class="camera-motion-panel is-empty" aria-label="Camera motion" data-i18n-aria-label="cameraMotionUi.cameraMotion"><p class="motion-intro" data-i18n="cameraMotionUi.addAMoveToTheCameraItPlays">Add a move to the camera. It plays on top of your camera keys and stays editable.</p>${gallery(locked,false)}</section>`;
  const adding=Boolean(editor._cameraMotionAdding);
  return `<section class="camera-motion-panel" aria-label="Camera motion" data-i18n-aria-label="cameraMotionUi.cameraMotion">`+
    `<div class="motion-list-head"><span data-i18n="cameraMotionUi.cameraMoves">Camera moves</span><button type="button" class="ui-button" data-size="sm" data-variant="ghost" data-motion-action="toggle-add" aria-expanded="${adding}" ${locked?'disabled':''}>${icon(adding?'close':'plus')}${adding?interfaceText("cameraMotionUi.close"):interfaceText("cameraMotionUi.add")}</button></div>`+
    (adding?gallery(locked,true):'')+
    `<div class="motion-list" role="list" aria-label="Motion clips" data-i18n-aria-label="cameraMotionUi.motionClips">${clips.map(c=>`<div class="motion-list-row ${c.id===clip?.id?'selected':''}" role="listitem" data-kind="${c.type}">`+
      `<button class="motion-select" data-motion-select="${esc(c.id)}" aria-pressed="${c.id===clip?.id}">${icon(symbols[c.type])}<span class="motion-select-name">${messageHTML(motionTypeMessages[c.type])}${c.type==='follow'?`<small>${esc(followSummary(editor,c))}</small>`:''}</span><small class="motion-select-range">${c.start+1}–${c.start+c.duration}</small></button>`+
      `<button class="icon-button motion-enable" data-motion-toggle="${esc(c.id)}" ${messageAttributes(c.enabled?'cameraMotionUi.disableMove':'cameraMotionUi.enableMove',{name:{messageKey:motionTypeMessages[c.type]}},'aria-label')} aria-pressed="${c.enabled}" ${locked?'disabled':''}>${icon(c.enabled?'eye':'eye-off')}</button></div>`).join('')}</div>`+
    `<section class="motion-card" data-section="${esc(clip.id)}" data-motion-id="${esc(clip.id)}" data-kind="${clip.type}"><div class="motion-card-heading"><span class="motion-card-title">${icon(symbols[clip.type])}<strong>${messageHTML(motionTypeMessages[clip.type])}</strong></span><div class="motion-actions">${action('preview','play',interfaceText("cameraMotionUi.previewThisMove"), undefined, {label: {key: "cameraMotionUi.previewThisMove", params: {}}})}${action('duplicate','duplicate',interfaceText("cameraMotionUi.duplicate"),locked?'disabled':'', {label: {key: "cameraMotionUi.duplicate", params: {}}})}${action('delete','trash',interfaceText('common.delete'),locked?'disabled':'',{label:{key:'common.delete'}})}</div></div>`+
    `<p class="motion-description">${messageHTML(motionDescriptionMessages[clip.type])}</p>`+
    `<fieldset ${locked?'disabled':''}>`+
    `<div class="motion-group"><div class="motion-group-head"><span data-i18n="cameraMotionUi.timing">Timing</span></div><div class="field-grid motion-timing">${field(interfaceText("cameraMotionUi.start"),'start',clip.start+1,'',`min="1" max="${10000001-clip.duration}" step="1"`,1,0,locked, {label: {key: "cameraMotionUi.start", params: {}}})}${field(interfaceText("cameraMotionUi.length"),'duration',clip.duration,'f',`min="1" max="${10000000-clip.start}" step="1"`,1,0,locked, {label: {key: "cameraMotionUi.length", params: {}}})}${parameter(clip,'fadeIn',locked,interfaceText("cameraMotionUi.easeIn"))}${parameter(clip,'fadeOut',locked,interfaceText("cameraMotionUi.easeOut"))}</div></div>`+
    (clip.type==='follow'?followCard(editor,clip,locked):presetCard(clip,locked))+
    `</fieldset>${motionGraphView()}</section>`+
    `<div class="motion-bake-row"><select class="inline-select" data-motion-bake-range aria-label="Bake range" data-i18n-aria-label="cameraMotionUi.bakeRange"><option value="all" data-i18n="cameraMotionUi.allFrames">All frames</option><option value="clip" data-i18n="cameraMotionUi.thisMoveSFrames">This move's frames</option></select><button class="ui-button motion-bake" data-motion-action="bake" ${!clips.some(c=>c.enabled)||locked?'disabled':''} title="Turn every move into ordinary camera keys" data-i18n-title="cameraMotionUi.turnEveryMoveIntoOrdinaryCameraKeys">${icon('diamond')}${messageHTML("cameraMotionUi.bakeToKeys", {})}</button></div></section>`;
}
const parallaxAxis=(axis,value,disabled)=>`<div class="property-row" data-property-row="parallax_${axis}"><label class="field">${scrubLabel(axis.toUpperCase(),true,disabled)}<input data-parallax-field="${axis}" data-property="parallax_${axis}" data-property-value="${value*100}" data-property-step="1" data-property-precision="3" type="number" min="0" max="400" step="any" value="${Number((value*100).toFixed(4))}" aria-label="Parallax ${axis.toUpperCase()}" ${messageAttributes("cameraMotionUi.parallax", {value: axis.toUpperCase()}, "aria-label")}><small>%</small></label></div>`;
export function parallaxView(editor,id){
  const layer=editor.getLayer(id);if(layer?.kind!=='layer')return '';
  const p=layer.parallax??{enabled:false,linked:true,x:1,y:1},presets=[messageTuple([.15,interfaceText("cameraMotionUi.distant")], {1: {key: "cameraMotionUi.distant", params: {}}}),messageTuple([.45,interfaceText("cameraMotionUi.background")], {1: {key: "cameraMotionUi.background", params: {}}}),messageTuple([1,interfaceText("cameraMotionUi.normal")], {1: {key: "cameraMotionUi.normal", params: {}}}),messageTuple([1.4,interfaceText("cameraMotionUi.foreground")], {1: {key: "cameraMotionUi.foreground", params: {}}})],custom=!p.linked||!presets.some(([v])=>v===p.x);
  return `<details class="parallax-panel inspector-section" data-section="parallax" data-parallax-layer="${esc(id)}" ${p.enabled?'open':''}><summary class="parallax-heading">${icon('chevron-right')}<strong data-i18n="cameraMotionUi.parallax2">Parallax</strong><label class="motion-switch" title="Enable parallax" data-i18n-title="cameraMotionUi.enableParallax"><input data-parallax-field="enabled" type="checkbox" aria-label="Enable parallax" ${p.enabled?'checked':''} ${layer.locked?'disabled':''} data-i18n-aria-label="cameraMotionUi.enableParallax"><span></span></label></summary><fieldset ${layer.locked?'disabled':''}><div class="parallax-preset"><select class="inline-select" data-parallax-field="preset" aria-label="Parallax preset" data-i18n-aria-label="cameraMotionUi.parallaxPreset">${custom?`<option value="custom" data-i18n="cameraMotionUi.custom">Custom</option>`:''}${presets.map((_tuple) => {const [v,label] = _tuple; const _messages = tupleMessages(_tuple); return `<option value="${v}" ${!custom&&p.x===v?'selected':''}${_messages[1] ? ' ' + messageAttributes(_messages[1].key, _messages[1].params) : ''}>${label}</option>`;}).join('')}</select><button class="icon-button" data-parallax-reference title="Set reference from current frame" aria-label="Set reference from current frame" data-i18n-title="cameraMotionUi.setReferenceFromCurrentFrame" data-i18n-aria-label="cameraMotionUi.setReferenceFromCurrentFrame">${icon('center')}</button></div><input data-parallax-field="movement" class="motion-slider" type="range" min="0" max="400" value="${p.x*100}" aria-label="Parallax movement" data-i18n-aria-label="cameraMotionUi.parallaxMovement"><div class="parallax-axes">${['x','y'].map((axis,i)=>`${i?`<label class="parallax-link ${p.linked?'linked':''}" title="Link axes" data-i18n-title="cameraMotionUi.linkAxes"><input data-parallax-field="linked" type="checkbox" ${p.linked?'checked':''} aria-label="Link axes" data-i18n-aria-label="cameraMotionUi.linkAxes">${icon('link')}</label>`:''}${parallaxAxis(axis,p[axis],layer.locked)}`).join('')}</div></fieldset><details class="parallax-preview" data-section="parallax-preview"><summary>${icon('chevron-right')}${messageHTML("cameraMotionUi.preview", {})}</summary><canvas class="parallax-monitor" data-parallax-monitor aria-label="Parallax camera preview" data-i18n-aria-label="cameraMotionUi.parallaxCameraPreview"></canvas><div class="parallax-pan"><span data-i18n="cameraMotionUi.pan">Pan</span><input data-parallax-preview class="motion-slider" type="range" min="-100" max="100" value="0" aria-label="Preview camera pan" data-i18n-aria-label="cameraMotionUi.previewCameraPan"></div></details></details>`;
}
export class CameraMotionControls {
  /** `posePicture(pose, {width, height, placement, signal})` draws a pose of the open document (EnginePoses, engine-pictures.mjs). */
  constructor(root,editor,{onError,onRender,onPreview,posePicture,beforeEdit}={}){
    this.root=root;this.editor=editor;this.beforeEdit=beforeEdit;this.onRender=onRender;this.onError=onError;this.onPreview=onPreview;this.posePicture=posePicture;
    this.graph=new CameraMotionGraph(root,editor);
    root.addEventListener('click',event=>{const button=event.target.closest('[data-motion-action],[data-motion-select],[data-motion-toggle],[data-motion-add],[data-motion-axes],[data-follow-remove],[data-parallax-reference],[data-camera-tab]');if(!button)return;event.stopPropagation();this.run(()=>{
      if(button.dataset.motionAdd){this.beforeEdit?.();editor._cameraInspectorTab='motion';editor._cameraMotionAdding=false;editor._selectedCameraMotion=editor.addCameraMotion(button.dataset.motionAdd);this.onRender?.();return;}
      if(button.dataset.motionAxes||button.dataset.followRemove){
        this.beforeEdit?.();const id=button.closest('[data-motion-id]').dataset.motionId,clip=editor.getCameraMotions().find(c=>c.id===id),axes=button.dataset.motionAxes;
        if(axes)editor.setCameraMotion(id,{params:{followX:axes==='y'?0:1,followY:axes==='x'?0:1}});
        else editor.setCameraMotion(id,{targets:clip.targets.filter(t=>t.uid!==Number(button.dataset.followRemove))});
        this.onRender?.();return;
      }
      if(button.dataset.motionSelect){editor._selectedCameraMotion=button.dataset.motionSelect;this.onRender?.();return;}
      if(button.dataset.motionToggle){this.beforeEdit?.();const c=editor.getCameraMotions().find(c=>c.id===button.dataset.motionToggle);editor.setCameraMotion(c.id,{enabled:!c.enabled});this.onRender?.();return;}
      if(button.dataset.cameraTab){editor._cameraInspectorTab=button.dataset.cameraTab;this.onRender?.();return;}
      const id=button.closest('[data-motion-id]')?.dataset.motionId,action=button.dataset.motionAction;
      if(action!=='preview')this.beforeEdit?.();
      if(button.hasAttribute('data-parallax-reference')){const c=editor.evaluatedFrame.camera??{};editor.setLayerParallax(button.closest('[data-parallax-layer]').dataset.parallaxLayer,{reference:{x:c.x??0,y:c.y??0}});}
      else if(action==='toggle-add')editor._cameraMotionAdding=!editor._cameraMotionAdding;
      else if(action==='follow-selected'){const clip=editor.getCameraMotions().find(c=>c.id===id),known=new Set(clip.targets.map(t=>t.uid));editor.setCameraMotion(id,{targets:[...clip.targets,...[...editor.selectedUids].filter(uid=>!known.has(uid)).map(uid=>({uid,weight:1}))]});}
      else if(action==='keep-framing'){const clip=editor.getCameraMotions().find(c=>c.id===id),offset=followFramingOffset(editor.report,editor.evaluatedFrame,clip.targets);if(!offset)throw messageError(new Error(''), "errors.cameraMotionUi.theFollowedFiguresAreNotInThisFrame", {});editor.setCameraMotion(id,{params:{offsetX:Math.round(offset.x),offsetY:Math.round(offset.y)}});}
      else if(action==='delete')editor.deleteCameraMotion(id);
      else if(action==='duplicate')editor._selectedCameraMotion=editor.duplicateCameraMotion(id);
      else if(action==='randomize')editor.randomizeCameraMotion(id);
      else if(action==='bake'){button.disabled=true;localizedText(button, "cameraMotionUi.baking", {});const selected=editor.getCameraMotions().find(c=>c.id===editor._selectedCameraMotion)??editor.getCameraMotions()[0],range=root.querySelector('[data-motion-bake-range]')?.value==='clip'?{start:selected.start,end:Math.min(editor.totalTicks,selected.start+selected.duration)}:{};return editor.bakeCameraMotion(range).finally(()=>this.onRender?.());}
      else if(action==='preview')this.onPreview?.(editor.getCameraMotions().find(c=>c.id===id));
      this.onRender?.();
    });});
    root.addEventListener('change',event=>{const input=event.target;if(input.matches('[data-follow-weight]')){event.stopPropagation();this.commitWeight(input);return;}if(!input.matches('[data-motion-field],[data-parallax-field]'))return;event.stopPropagation();this.commit(input);});
    root.addEventListener('input',event=>{const input=event.target;if(input.matches('[data-parallax-preview]')){this.sync(Number(input.value));return;}if(input.matches('[data-follow-weight]')){this.previewWeight(input);return;}if(input.matches('[data-motion-field]')&&['number','range'].includes(input.type))this.preview(input);else if(input.matches('[data-parallax-field]')&&['number','range'].includes(input.type))this.previewParallax(input);});
    root.addEventListener('keydown',event=>{const input=event.target;if(!input.matches('[data-motion-field],[data-parallax-field],[data-parallax-preview]'))return;event.stopPropagation();if(event.key==='Escape'){event.preventDefault();const original=this.active?.initial;this.cancel();if(original!==undefined)input.value=original;input.blur();this.onRender?.();}else if(event.key==='Enter'){event.preventDefault();this.commit(input);input.blur();}});
    root.addEventListener('toggle',event=>{if(event.target.matches('[data-section="parallax-preview"]'))this.sync();},true);
    editor.addEventListener('change',event=>{if(['document','history'].includes(event.detail?.kind)){this.active=null;this.pan=0;}});
  }
  run(fn){try{const result=fn();return result?.then?result.catch(error=>{this.onError?.(error);this.onRender?.();}):result;}catch(error){this.onError?.(error);this.onRender?.();}}
  handlesProperty(input){return Boolean(input?.matches('input[type="number"]:is([data-motion-field],[data-parallax-field]):not(:disabled)'));}
  propertyValue(input){
    const key=input.dataset.motionField;
    if(key){const clip=this.editor.getCameraMotions().find(c=>c.id===input.closest('[data-motion-id]').dataset.motionId),param=key==='move'?'moveX':key;return key==='start'?clip.start+1:key==='duration'?clip.duration:clip.params[param]*factorOf(param);}
    const layer=this.editor.getLayer(input.closest('[data-parallax-layer]').dataset.parallaxLayer);return (layer.parallax?.[input.dataset.parallaxField]??1)*100;
  }
  /** The app's shared PropertyControls owns pointer capture and keyboard input;
   * this owner retains only the small motion/layer transaction. */
  beginProperty(input){
    const parallax=input.hasAttribute('data-parallax-field'),id=input.closest(parallax?'[data-parallax-layer]':'[data-motion-id]').dataset[parallax?'parallaxLayer':'motionId'];
    return this.active={input,id,kind:parallax?'parallax':'motion',before:parallax?this.editor.report._styk.layers.byId[id]:this.editor.report._styk.cameraMotion,token:this.editor._documentToken,initial:String(this.propertyValue(input))};
  }
  previewProperty(edit,value){if(this.active!==edit||edit.token!==this.editor._documentToken)return;edit.input.value=String(value);if(edit.kind==='parallax')this.previewParallax(edit.input);else this.preview(edit.input);}
  commitProperty(edit,value){if(this.active!==edit||edit.token!==this.editor._documentToken)return;edit.input.value=String(value);this.commit(edit.input);}
  cancelProperty(edit){if(this.active===edit){this.cancel();this.sync();}}
  previewTimeline(clip){
    this.graph.preview(clip);
    const card=this.root.querySelector('[data-motion-id]');if(!card)return;
    const current=clip??this.editor.getCameraMotions().find(c=>c.id===card.dataset.motionId);
    if(!current||current.id!==card.dataset.motionId)return;
    for(const [key,value] of [['start',current.start+1],['duration',current.duration]]){
      const input=card.querySelector(`[data-motion-field="${key}"]`);input.value=String(value);input.dataset.propertyValue=String(value);
    }
  }
  patch(input){const key=input.dataset.motionField,value=input.type==='checkbox'?input.checked:Number(input.value);if(input.value===''||!input.validity.valid)throw messageError(new Error(''), "errors.cameraMotionUi.enterAValueWithinTheAllowedRange", {});
    // Intensity moves both axes together; Fine tune keeps them separately editable.
    return key==='enabled'?{enabled:value}:key==='start'?{start:value-1}:key==='duration'?{duration:value}:key==='move'?{params:{moveX:value,moveY:value}}:{params:{[key]:value/factorOf(key)}};}
  /** The slider and the typed value of one control show the same number while either moves. */
  mirror(input){
    const card=input.closest('[data-motion-id]');if(!card)return;
    for(const other of card.querySelectorAll(`[data-motion-field="${input.dataset.motionField}"]`)){
      if(other===input)continue;other.value=input.value;
      if(other.type==='range'){if(Number(input.value)>Number(other.max))other.max=input.value;other.style.setProperty('--_p',`${(Number(other.value)-Number(other.min))/Math.max(1e-9,Number(other.max)-Number(other.min))*100}%`);}
    }
    if(input.type==='range')input.style.setProperty('--_p',`${(Number(input.value)-Number(input.min))/Math.max(1e-9,Number(input.max)-Number(input.min))*100}%`);
  }
  weights(input){const card=input.closest('[data-motion-id]'),clip=this.editor.getCameraMotions().find(c=>c.id===card.dataset.motionId),uid=Number(input.dataset.followWeight),weight=Number(input.value)/100;input.style.setProperty('--_p',`${input.value}%`);return {id:clip.id,targets:clip.targets.map(t=>t.uid===uid?{...t,weight}:t)};}
  previewWeight(input){this.run(()=>{
    const editor=this.editor,{id,targets}=this.weights(input);if(!this.active)this.beforeEdit?.();
    this.active??={input,id,before:editor.report._styk.cameraMotion,token:editor._documentToken,initial:input.defaultValue};
    const clips=this.active.before.clips.map(c=>c.id===id?{...c,targets}:c);validateCameraMotion({version:1,clips});editor.report._styk.cameraMotion={version:1,clips};editor._invalidate({retainGeometry:true});editor._emit('edit',{live:true,camera:true,cameraMotion:true});
  });}
  commitWeight(input){this.run(()=>{if(!this.active)this.beforeEdit?.();const {id,targets}=this.weights(input);this.cancel();this.editor.setCameraMotion(id,{targets});this.onRender?.();});}
  preview(input){this.run(()=>{
    const id=input.closest('[data-motion-id]').dataset.motionId,patch=this.patch(input),editor=this.editor;
    this.mirror(input);
    if(!this.active)this.beforeEdit?.();
    this.active??={input,id,before:editor.report._styk.cameraMotion,token:editor._documentToken,initial:input.defaultValue};
    const clips=this.active.before.clips.map(c=>c.id===id?{...c,...patch,params:{...c.params,...patch.params}}:c);
    validateCameraMotion({version:1,clips});editor.report._styk.cameraMotion={version:1,clips};editor._invalidate({retainGeometry:true});editor._emit('edit',{live:true,camera:true,cameraMotion:true});
  });}
  previewParallax(input){this.run(()=>{
    if(!input.value||!input.validity.valid)return;
    const id=input.closest('[data-parallax-layer]').dataset.parallaxLayer,editor=this.editor,layer=editor.report._styk.layers.byId[id],key=input.dataset.parallaxField,value=Number(input.value)/100;
    if(layer.locked)return;
    if(!this.active)this.beforeEdit?.();
    this.active??={kind:'parallax',input,id,before:layer,token:editor._documentToken,initial:input.defaultValue};
    const c=editor.evaluatedFrame.camera??{},p={enabled:false,linked:true,x:1,y:1,reference:{x:c.x??0,y:c.y??0},...this.active.before.parallax};
    if(key==='movement'||p.linked){p.x=p.y=value;}else p[key]=value;
    validateParallax(p);editor.report._styk.layers.byId[id]={...layer,parallax:p};editor._layerChanged();editor._invalidate({retainGeometry:true});editor._emit('edit',{live:true,parallax:true,layers:true});this.sync();
  });}
  cancel(){const edit=this.active;if(!edit)return;this.active=null;if(edit.token!==this.editor._documentToken)return;if(edit.kind==='parallax'){this.editor.report._styk.layers.byId[edit.id]=edit.before;this.editor._layerChanged();}else this.editor.report._styk.cameraMotion=edit.before;this.editor._invalidate({timing:true,retainGeometry:true});this.editor._emit('edit',{live:true,camera:true});}
  commit(input){this.run(()=>{if(!this.active)this.beforeEdit?.();const id=input.closest('[data-motion-id]')?.dataset.motionId;this.cancel();if(id)this.editor.setCameraMotion(id,this.patch(input));else{
    const key=input.dataset.parallaxField;if(!key||input.value==='custom')return;if(input.type==='number'&&(!input.value||!input.validity.valid))throw messageError(new Error(''), "errors.cameraMotionUi.enterAValidParallaxResponse", {});const value=input.type==='checkbox'?input.checked:key==='preset'?Number(input.value):Number(input.value)/100;
    this.editor.setLayerParallax(input.closest('[data-parallax-layer]').dataset.parallaxLayer,key==='preset'?{x:value,y:value,linked:true,enabled:true}:key==='movement'?{x:value,y:value}:{[key]:value});
  }this.onRender?.();});}
  sync(pan=this.pan??0){this.graph.update();if(this.graph.previewClip)this.previewTimeline(this.graph.previewClip);this.pan=pan;const panel=this.root.querySelector('[data-parallax-layer]'),p=panel&&this.editor.getLayer(panel.dataset.parallaxLayer)?.parallax;
    if(p)for(const input of panel.querySelectorAll('input:is([type="number"],[type="range"])[data-parallax-field]'))if(input!==this.active?.input){const value=p[input.dataset.parallaxField==='movement'?'x':input.dataset.parallaxField]*100;input.value=String(value);input.dataset.propertyValue=String(value);}
    const canvas=this.root.querySelector('[data-parallax-monitor]');if(!cameraMonitorVisible(canvas))return;
    const editor=this.editor,frame=editor.evaluatedFrame,c=frame.camera??{};
    void this.drawParallax(canvas,{...frame,camera:{...c,is_default:false,x:(c.x??0)+pan*editor.report.canvas_width/200}});
  }
  /** The parallax monitor: the pose seen through a camera moved sideways, drawn by the engine; the latest request wins and the last picture stays until the next arrives. */
  async drawParallax(canvas,pose){
    const report=this.editor.report,width=canvas.clientWidth,height=canvas.clientHeight,dpr=Math.min(globalThis.devicePixelRatio||1,2),
      scale=Math.min(width/report.canvas_width,height/report.canvas_height),
      x=(width-report.canvas_width*scale)/2,y=(height-report.canvas_height*scale)/2;
    this.parallaxRequest?.abort();
    const request=this.parallaxRequest=new AbortController();
    try{
      const bitmap=await this.posePicture?.(pose,{width:Math.round(width*dpr),height:Math.round(height*dpr),placement:placement.camera(scale*dpr,x*dpr,y*dpr),signal:request.signal});
      if(request.signal.aborted||!canvas.isConnected){bitmap?.close();return;}
      if(!bitmap)return;
      canvas.width=bitmap.width;canvas.height=bitmap.height;
      canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
    }catch(error){if(error?.name!=='AbortError')this.onError?.(error);}
  }
}
