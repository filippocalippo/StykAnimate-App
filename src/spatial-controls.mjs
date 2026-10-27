import {tupleMessages, messageTuple, messageHTML, descriptorAttributes, messageAttributes} from './localization-bindings.mjs';

import {t as interfaceText} from './localization.mjs';

import {spatialPerspectiveAvailable} from './spatial-projection.mjs';
import {drawingSelection} from './movieclip-drawings.mjs';
/** Animator controls are a view of native pose channels, not a second rig state. */
import {spatialBone,spatialPoint} from './rig-spatial.mjs';
import {ikChain} from './ik.mjs';
import {icon} from './icons.mjs';
import {poseChoiceGroups} from './rig-pose-choices.mjs';
import {rigControlIsDetail,rigDetailsShown,setRigDetailsShown} from './rig-control-details.mjs';
import {propertyToggle} from './property-toggle.mjs';
import {createSpatialGizmo,drawRotationGizmo,startRotationGizmo,rotateGizmo} from './spatial-gizmo.mjs';
const DEG=180/Math.PI,esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
const modes=new WeakMap();
const applyPose=(editor,patch)=>editor.setSpatialPose(patch,{wholeFigure:spatialControlMode(editor)==='figure'});
export const spatialControlMode=editor=>modes.get(editor)??'pose';
function limbControl(editor){
 const f=editor.figure,index=editor.selectedJoint,s=f?.segments[index];if(!s)return null;
 const ancestors=new Set();let parent=s;while(parent?._stykRig?.spatial?.parent){ancestors.add(parent._stykRig.spatial.parent);parent=f.segments.find(n=>n.segment_id===parent._stykRig.spatial.parent);}
 for(const[id,c]of Object.entries(editor.object?._stykIK??{}))if(c.spatialTarget&&(ancestors.has(Number(id))||ikChain(f,Number(id),c.chainLength).includes(index)))
  return{index:f.segments.findIndex(s=>s.segment_id===Number(id)),controller:c};
 return null;
}
/**
 * The 3D rig's sections (experience.md §5.1): Pose (Pose │ Rotate, the turn
 * and tilt pad; Reset pose as its action), Body (the body, torso and limb
 * shortcuts, Plant feet, the articulation), the selected Limb (IK, pin,
 * stretch, bend, depth, reach) and a Mechanism's position are open; Exact
 * angles, Perspective, Shape and Choices are titled. The controls keep their
 * data-spatial-* hooks, which installSpatialControls() handles. [] for a
 * figure without 3D bones.
 */
export function spatialSections(editor,{hotkeyLabel}={}){
 const bones=editor.figure?.segments.flatMap((s,i)=>spatialBone(s)&&!s._stykPoseChoice?[{s,i}]:[])??[];if(!bones.length)return[];
 const mode=spatialControlMode(editor),pose=editor.getSpatialPose(),selected=editor.selectedJoint,limb=limbControl(editor),ik=limb?.controller;
 // Limbs keep their shortcuts and IK switch while IK is off.
 const targets=bones.filter(({s})=>editor.object?._stykIK?.[s.segment_id]?.spatialTarget),childOf=id=>bones.find(b=>b.s._stykRig.spatial.parent===id);
 const feet=targets.filter(({s})=>/foot|ankle/i.test(childOf(s.segment_id)?.s.name??'')),planted=feet.length&&feet.every(({s})=>editor.object._stykIK[s.segment_id].enabled&&editor.object._stykIK[s.segment_id].pinned);
 const choose=(index,name,focus=false,labelKey)=>`<button type="button" data-spatial-${focus?'focus':'select'}="${index}" aria-pressed="${selected===index}" ${labelKey?messageAttributes(labelKey):''}>${esc(name)}</button>`;
 const groups=poseChoiceGroups(editor.figure,editor.object);
 const choices=groups.map(g=>`<label class="spatial-choice"><span>${esc(g.name)}</span><select class="inline-select" data-spatial-choice="${esc(g.name)}" aria-label="${esc(g.name)}">${g.hidden!==false?`<option value="0" ${g.value===0?'selected':''} data-i18n="spatialControls.hidden">${messageHTML("spatialControls.hidden", {})}</option>`:''}${g.value===-1?`<option value="-1" selected disabled data-i18n="spatialControls.customPose">${messageHTML("spatialControls.customPose", {})}</option>`:''}${g.choices.map(c=>`<option value="${c.id}" ${g.value===c.id?'selected':''}${descriptorAttributes(c, "label")}>${esc(c.label)}</option>`).join('')}</select></label>`).join('');
 const shortcuts=`<div class="spatial-targets" role="group" aria-label="Body controls" data-i18n-aria-label="spatialControls.bodyControls">${choose(-1,interfaceText("spatialControls.moveFigure"),false,'spatialControls.moveFigure')}<button type="button" data-spatial-whole aria-pressed="${mode==='figure'}" data-i18n="spatialControls.rotateFigure">${messageHTML("spatialControls.rotateFigure", {})}</button>${targets.map(({s,i})=>{const child=childOf(s.segment_id);return choose(mode!=='pose'&&child?child.i:i,(child?.s.name??s.name).replace(/ ankle$/,''));}).join('')}</div>`;
 const trunk=[['Pelvis','spatialControls.hips'],['Lower torso','spatialControls.torso'],['Waist','spatialControls.waist'],['Chest','spatialControls.chest'],[bones.some(b=>b.s.name==='Head')?'Head':'Neck','spatialControls.head']].flatMap(([name,key])=>{const b=bones.find(b=>b.s.name===name);return b?[choose(b.i,interfaceText(key),false,key)]:[];}).join('');
 const rows=pose?['pitch','turn','bend'].map((key,i)=>{const value=pose[key]*DEG,labelKey=['spatialControls.tilt','spatialControls.turn','spatialControls.bend'][i],label=interfaceText(labelKey);return`<div class="spatial-axis spatial-${key}"><label for="spatial-${key}-number" ${messageAttributes(labelKey)}>${label}</label><input id="spatial-${key}-range" type="range" min="-180" max="180" step="0.1" value="${wrap(pose[key])*DEG}" data-spatial-axis="${key}" aria-label="${label}" ${messageAttributes(labelKey,{},'aria-label')}><label class="field"><input id="spatial-${key}-number" type="number" step="1" value="${Math.round(value*10)/10}" data-spatial-axis="${key}" aria-label="${label} degrees" ${messageAttributes("spatialControls.degrees", {label:{messageKey:labelKey}}, "aria-label")}><small>°</small></label></div>`;}).join(''):'';
 const endpoint=limb?childOf(editor.figure.segments[limb.index].segment_id):null,toe=endpoint?childOf(endpoint.s.segment_id):null;
 const isFoot=/foot|ankle/i.test(endpoint?.s.name??''),chain=limb?ikChain(editor.figure,editor.figure.segments[limb.index].segment_id,ik.chainLength):[];
 const rotations=chain.map((index,i)=>{const key=isFoot?(i===0?'spatialControls.thighRotation':'spatialControls.shinRotation'):(i===0?'spatialControls.upperArmRotation':'spatialControls.forearmRotation');return choose(index,interfaceText(key),true,key);}).join('')+(endpoint?choose(endpoint.i,interfaceText(isFoot?'spatialControls.ankleRotation':'spatialControls.handRotation'),true,isFoot?'spatialControls.ankleRotation':'spatialControls.handRotation'):'')+(toe?choose(toe.i,interfaceText("spatialControls.toeBend"),true,'spatialControls.toeBend'):'');
 const camera=editor.getSpatialCamera(),proportions=editor.getSpatialProportions();
 const parameter=(kind,key,label,value,min,max,step=1,unit='', _messages = {})=>`<div class="spatial-axis spatial-proportion"><label for="spatial-${kind}-${key}" ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params) : ''}>${label}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-spatial-${kind}="${key}" aria-label="${label}" ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params, 'aria-label') : ''}><label class="field"><input id="spatial-${kind}-${key}" type="number" min="${min}" max="${max}" step="${step}" value="${Math.round(value*100)/100}" data-spatial-${kind}="${key}" aria-label="${label} value" ${messageAttributes("spatialControls.value", {label:_messages.label?{messageKey:_messages.label.key,messageParams:_messages.label.params}:label}, "aria-label")}><small>${unit}</small></label></div>`;
 const note=(text, _messages = {})=>`<div class="inspector-meta" ${_messages.text ? messageAttributes(_messages.text.key, _messages.text.params) : ''}>${text}</div>`;
 const perspectiveAvailable=spatialPerspectiveAvailable(editor.selectionFrame.objects,editor.object,editor.report.figure_types);
 const perspective=perspectiveAvailable?`${parameter('camera','strength',interfaceText("spatialControls.perspective"),camera.strength*100,0,100,1,'%', {label: {key: "spatialControls.perspective", params: {}}})}${parameter('camera','distance',interfaceText("spatialControls.distance"),camera.distance,100,2000,10, undefined, {label: {key: "spatialControls.distance", params: {}}})}${note(interfaceText("spatialControls.moveAHandOrFootTowardTheCamera"), {text: {key: "spatialControls.moveAHandOrFootTowardTheCamera", params: {}}})}<div class="spatial-part-actions"><button type="button" class="spatial-reset" data-spatial-center-camera data-i18n="spatialControls.centerOnFigure">${messageHTML("spatialControls.centerOnFigure", {})}</button><button type="button" class="spatial-reset" data-spatial-reset-camera data-i18n="spatialControls.resetPerspective">${messageHTML("spatialControls.resetPerspective", {})}</button></div>`:note(interfaceText("spatialControls.perspectiveNeedsASingle3dFigureJoinedDrawings"), {text: {key: "spatialControls.perspectiveNeedsASingle3dFigureJoinedDrawings", params: {}}});
 const shape=proportions?`${proportions.canResizeLength?parameter('shape','size',interfaceText("spatialControls.partSize"),proportions.length*100,10,300,1,'%', {label: {key: "spatialControls.partSize", params: {}}})+parameter('shape','length',interfaceText("spatialControls.length"),proportions.length*100,10,300,1,'%', {label: {key: "spatialControls.length", params: {}}}):''}${parameter('shape','width',interfaceText("spatialControls.width"),proportions.width*100,10,300,1,'%', {label: {key: "spatialControls.width", params: {}}})}${parameter('shape','taper',interfaceText("spatialControls.taper"),proportions.taper*100,-90,200,1,'%', {label: {key: "spatialControls.taper", params: {}}})}${note(interfaceText("spatialControls.partSizeIncludesTheChildJointsAPositive"), {text: {key: "spatialControls.partSizeIncludesTheChildJointsAPositive", params: {}}})}<button type="button" class="spatial-reset" data-spatial-reset-shape data-i18n="spatialControls.resetThisBoneSShape">${messageHTML("spatialControls.resetThisBoneSShape", {})}</button>`:'';
 const motion=editor.getSpatialMotion(),mechanism=motion?`${parameter('motion','position',motion.type==='slide'?interfaceText("spatialControls.slide"):interfaceText("spatialControls.hinge"),motion.fraction*100,0,100,1,'%',{label:{key:motion.type==='slide'?'spatialControls.slide':'spatialControls.hinge'}})}${note(interfaceText("spatialControls.dragTheHandleAlongItsTrackOrSet"), {text: {key: "spatialControls.dragTheHandleAlongItsTrackOrSet", params: {}}})}`:'';
 const targetShape=limb?editor.geometry.objects.get(editor.selectedSlot)?.segments[limb.index]:null;
 const depth=targetShape?.spatialFrame?spatialPoint(targetShape.spatialFrame,targetShape.seg._stykRig.spatial.tip)[2]*editor.object.scale:ik?.spatialTarget?.depth??0;
 const limbGeometry=limb?editor.geometry.objects.get(editor.selectedSlot):null,base=limbGeometry?.segments[chain[0]],baseDepth=base?.spatialFrame?spatialPoint(base.spatialFrame,base.seg._stykRig.spatial.origin)[2]*editor.object.scale:0;
 const reach=limb?Math.max(1,chain.reduce((sum,i)=>sum+(limbGeometry.solvedLengths?.[i]??(editor.object.len_flag?editor.object.lengths[i]:editor.figure.segments[i].length)),0)*editor.object.scale):1;
 const towards=ik?.enabled?`<div class="spatial-depth">${parameter('reach','depth',interfaceText("spatialControls.towardCamera"),depth,baseDepth-reach,baseDepth+reach,1, undefined, {label: {key: "spatialControls.towardCamera", params: {}}})}${note(interfaceText("spatialControls.leftAwayRightTowardYouTheLegOr"), {text: {key: "spatialControls.leftAwayRightTowardYouTheLegOr", params: {}}})}</div>`:'';
 const limbTools=!ik?'':!ik.enabled?`<div class="spatial-limb" data-section="spatial-limb"><div class="property-toggle-grid">${propertyToggle('spatial-ik','IK',false,'link',{title:interfaceText("spatialControls.dragTheHandOrFootToMoveThe"), titleKey: "spatialControls.dragTheHandOrFootToMoveThe"})}</div>${note(interfaceText(isFoot?'spatialControls.ikDisabledFoot':'spatialControls.ikDisabledHand'), {text: {key: isFoot?'spatialControls.ikDisabledFoot':'spatialControls.ikDisabledHand', params: {}}})}</div>`
  :`<div class="spatial-limb" data-section="spatial-limb"><div class="property-toggle-grid">${propertyToggle('spatial-ik','IK',true,'link',{title:interfaceText("spatialControls.dragTheHandOrFootToMoveThe"), titleKey: "spatialControls.dragTheHandOrFootToMoveThe", titleParams: {}})}${propertyToggle('spatial-pin',isFoot?interfaceText("spatialControls.plantFoot"):interfaceText("spatialControls.pinHand"),ik.pinned,'pin',{labelKey:isFoot?"spatialControls.plantFoot":"spatialControls.pinHand",title:interfaceText("spatialControls.keepTargetPositionAndOrientationWhenTheBody"), titleKey: "spatialControls.keepTargetPositionAndOrientationWhenTheBody", titleParams: {}})}${propertyToggle('spatial-stretch',interfaceText("spatialControls.stretch"),ik.allowStretch,'stretch-horizontal',{labelKey:"spatialControls.stretch",title:interfaceText("spatialControls.allowTheLimbToReachBeyondItsRest"), titleKey: "spatialControls.allowTheLimbToReachBeyondItsRest", titleParams: {}})}</div><label class="spatial-parameter"><span data-i18n="spatialControls.bendDirection">${messageHTML("spatialControls.bendDirection", {})}</span><input type="range" min="-180" max="180" step="1" value="${wrap(ik.spatialTarget.swivel)*DEG}" data-spatial-swivel aria-label="Bend direction" data-i18n-aria-label="spatialControls.bendDirection"></label><label class="field"><span data-i18n="spatialControls.depth">${messageHTML("spatialControls.depth", {})}</span><input type="number" step="1" value="${Math.round(ik.spatialTarget.depth*10)/10}" data-spatial-depth aria-label="Target depth" data-i18n-aria-label="spatialControls.targetDepth"><small>px</small></label>${note(interfaceText(ik.pinned?"spatialControls.plantedPositionAndOrientationStayFixed":isFoot?"spatialControls.freeTheFootFollowsTheShin":"spatialControls.freeTheHandFollowsTheForearm"),{text:{key:ik.pinned?"spatialControls.plantedPositionAndOrientationStayFixed":isFoot?"spatialControls.freeTheFootFollowsTheShin":"spatialControls.freeTheHandFollowsTheForearm"}})}</div>`;
 const padShown=Boolean(pose&&!motion&&mode!=='pose');
 const pad=padShown?`<div class="spatial-orientation" data-section="spatial-orientation"><button type="button" class="spatial-pad" data-spatial-pad aria-label="Turn and tilt" data-tooltip="Drag to turn and tilt · Arrow keys adjust · Shift for precision" data-i18n-aria-label="spatialControls.turnAndTilt" data-i18n-tooltip="spatialControls.dragToTurnAndTiltArrowKeysAdjust"><svg viewBox="0 0 90 72" aria-hidden="true"><path d="M8 36H82M45 7V65"/><circle cx="${45+Math.sin(pose.turn)*31}" cy="${36+Math.sin(pose.pitch)*23}" r="5"/></svg></button><div><strong data-i18n="spatialControls.turnTilt">${messageHTML("spatialControls.turnTilt", {})}</strong>${note(interfaceText("spatialControls.dragInTwoDirectionsShiftForPrecision"), {text: {key: "spatialControls.dragInTwoDirectionsShiftForPrecision", params: {}}})}<button type="button" class="spatial-reset" data-spatial-reset="joint" ${messageAttributes((mode==='figure' ? "spatialControls.resetOrientation" : "spatialControls.resetJoint"), (mode==='figure' ? {} : {}))}>${mode==='figure'?interfaceText("spatialControls.resetOrientation"):interfaceText("spatialControls.resetJoint")}</button></div></div>`:'';
 const modes=[messageTuple(['pose',interfaceText("spatialControls.pose"),'move'], {1: {key: "spatialControls.pose", params: {}}}),messageTuple(['rotate',interfaceText("spatialControls.rotate"),'rotate'], {1: {key: "spatialControls.rotate", params: {}}})].map((_tuple) => {const [value,label,symbol] = _tuple; const _messages = tupleMessages(_tuple); return `<button type="button" data-spatial-mode="${value}" aria-label="${label}" aria-pressed="${value===(mode==='figure'?'rotate':mode)}"${_messages[1] ? ' ' + messageAttributes(_messages[1].key, _messages[1].params, 'aria-label') : ''}>${icon(symbol)}${_messages[1]?messageHTML(_messages[1].key,_messages[1].params):esc(label)}</button>`;}).join('');
 // Secondary parts hang off the trunk outside the IK limbs: belt ties, hair
 // locks, coat panels. Each gets a shortcut; a tie is named by its upper bone.
 const trunkNames=new Set(['Pelvis','Lower torso','Waist','Chest','Neck','Head']);
 const limbBones=new Set(targets.flatMap(({s})=>ikChain(editor.figure,s.segment_id,editor.object._stykIK[s.segment_id].chainLength)));
 const parts=bones.filter(({s,i})=>{const parent=bones.find(b=>b.s.segment_id===s._stykRig.spatial.parent);return parent&&trunkNames.has(parent.s.name)&&!trunkNames.has(s.name)&&!limbBones.has(i)&&!rigControlIsDetail(s);});
 const detailToggle=bones.some(({s})=>rigControlIsDetail(s))?propertyToggle('spatial-details',interfaceText('spatialControls.detailedControls'),rigDetailsShown(editor),'sliders',{labelKey:'spatialControls.detailedControls'}):'';
 const rig=html=>({kind:'markup',html:`<div class="spatial-rig">${html}</div>`});
 const articulation={kind:'select',id:'spatial-joint',label:interfaceText("spatialControls.articulation"), labelKey: "spatialControls.articulation",span:2,value:pose?selected:-1,
  options:[{value:-1,label:interfaceText("spatialControls.moveWholeCharacter"), labelKey: "spatialControls.moveWholeCharacter"},...bones.map(({s,i})=>({value:i,label:s.name||interfaceText('builderSurfaceUi.jointNumber',{id:s.segment_id}),...(s.name?{}:{labelKey:'builderSurfaceUi.jointNumber',labelParams:{id:s.segment_id}})}))]};
 const selectedName=editor.figure.segments[selected]?.name||{messageKey:"spatialControls.joint"};
 return[
  {id:'rig-pose',title:interfaceText("spatialControls.pose"), titleKey: "spatialControls.pose",actions:[{icon:'reset',label:interfaceText("spatialControls.resetPose"), labelKey: "spatialControls.resetPose",data:{'spatial-reset':'all'}}],rows:[
   rig(`<div class="spatial-modes" role="group" aria-label="Rig tools" data-i18n-aria-label="spatialControls.rigTools">${modes}</div>${pad}`),
   {kind:'meta',text:mode==='pose'?interfaceText('spatialControls.dragJointsToPoseThemFlatOnScreenValue', {value: depthHintMessage(hotkeyLabel?.('depth-hold'))}):interfaceText("spatialControls.rotateALimbToReleaseItsPinIts"), textKey: (mode==='pose' ? 'spatialControls.dragJointsToPoseThemFlatOnScreenValue' : "spatialControls.rotateALimbToReleaseItsPinIts"), textParams: (mode==='pose' ? {value: depthHintMessage(hotkeyLabel?.('depth-hold'))} : {})},
  ]},
  {id:'rig-body',title:interfaceText("spatialControls.body"), titleKey: "spatialControls.body",rows:[
   rig(`${shortcuts}${trunk?`<div class="spatial-trunk" role="group" aria-label="Torso controls" data-i18n-aria-label="spatialControls.torsoControls">${trunk}</div>`:''}${parts.length?`<div class="spatial-parts" role="group" aria-label="Parts" data-i18n-aria-label="spatialControls.parts">${parts.map(b=>choose(b.i,b.s.name.replace(/ sash upper$/,' tie'))).join('')}</div>`:''}${feet.length?`<button type="button" class="spatial-plant" data-spatial-feet="${planted?'release':'plant'}" ${messageAttributes(planted?"spatialControls.releaseFeet":"spatialControls.plantBothFeet")}>${icon('pin')}${planted?interfaceText("spatialControls.releaseFeet"):interfaceText("spatialControls.plantBothFeet")}</button>`:''}`),
   detailToggle&&rig(detailToggle),
   {kind:'grid',rows:[articulation]},
   ik&&rig(`<div class="spatial-targets" role="group" aria-label="Limb rotations" data-i18n-aria-label="spatialControls.limbRotations">${rotations}</div>`),
  ]},
  {id:'rig-limb',title:interfaceText("spatialControls.limb"), titleKey: "spatialControls.limb",hidden:!ik,rows:[ik&&rig(`${towards}${limbTools}`)]},
  {id:'rig-mechanism',title:interfaceText("spatialControls.mechanism"), titleKey: "spatialControls.mechanism",hidden:!motion,rows:[motion&&rig(`<div class="spatial-depth" data-section="spatial-motion">${mechanism}</div>`)]},
  {id:'spatial-exact',title:interfaceText("spatialControls.exactAngles"), titleKey: "spatialControls.exactAngles",place:'titled',hidden:!padShown,rows:[padShown&&rig(rows)]},
  {id:'spatial-perspective',title:interfaceText("spatialControls.perspective"), titleKey: "spatialControls.perspective",place:'titled',rows:[rig(perspective)]},
  {id:'spatial-proportions',title:proportions?interfaceText('spatialControls.shapeValue', {value: selectedName}):interfaceText("spatialControls.shape"), titleKey: (proportions ? 'spatialControls.shapeValue' : "spatialControls.shape"), titleParams: (proportions ? {value: selectedName} : {}),place:'titled',hidden:!proportions||Boolean(motion),rows:[proportions&&!motion&&rig(shape)]},
  {id:'spatial-choices',title:interfaceText("spatialControls.choices"), titleKey: "spatialControls.choices",place:'titled',open:true,hidden:!groups.length,rows:[groups.length&&rig(choices)]},
 ];
}
const depthHintMessage=key=>key?{messageKey:'spatialControls.depthHint',messageParams:{key:key.split(' / ')[0]}}:{messageKey:'spatialControls.assignHoldToPose3dPartsInDepth'};
function spatialGizmo(editor,project){return spatialControlMode(editor)!=='pose'?createSpatialGizmo(editor,project):null;}
export function drawSpatialGizmo(ctx,editor,project){
 drawRotationGizmo(ctx,spatialGizmo(editor,project));
}
export function spatialGizmoDrag(editor,point,project){
 const gizmo=spatialGizmo(editor,project);if(!gizmo)return null;
 // A visible neighboring pivot wins over an overlapping rotation sphere.
 const g=editor.geometry.objects.get(editor.selectedSlot);
 if(Math.hypot(point.x-gizmo.center.x,point.y-gizmo.center.y)>12&&g.segments.some((s,i)=>{if(i===editor.selectedJoint||!s.spatialFrame||s.static||rigControlIsDetail(s.seg)&&!rigDetailsShown(editor))return false;const p=project(s.start);return Math.hypot(p.x-point.x,p.y-point.y)<7;}))return null;
 return startRotationGizmo(gizmo,point);
}
export function updateSpatialGizmo(editor,drag,point,precision=false){
 applyPose(editor,rotateGizmo(drag,point,precision));
}

export function installSpatialControls({editor,root,refresh,guard}){
 let gesture,editingLimb=false;
 const withLimb=action=>{const limb=limbControl(editor);if(!limb)return;const selected=editor.selectedJoint;try{editingLimb=true;editor.selectedJoint=limb.index;action();}finally{editor.selectedJoint=selected;editingLimb=false;}};
 const finish=commit=>{if(!gesture)return;gesture=null;commit?editor.commitDrag():editor.cancelDrag();refresh();};
 root.addEventListener('pointerdown',guard(e=>{
  const pad=e.target.closest('[data-spatial-pad]');
  if(pad){if(e.button!==0||!e.isPrimary||!editor.getSpatialPose())return;finish(true);if(!editor.beginDrag('Turn and tilt'))return;gesture={uid:editor.selectedUid,index:editor.selectedJoint,element:pad,pad:true,pose:editor.getSpatialPose(),x:e.clientX,y:e.clientY};pad.setPointerCapture(e.pointerId);e.preventDefault();return;}
  const range=e.target.closest('input[type=range][data-spatial-axis],input[data-spatial-swivel],input[type=range][data-spatial-camera],input[type=range][data-spatial-shape],input[type=range][data-spatial-reach],input[type=range][data-spatial-motion]');if(!range)return;
  if(e.button!==0||!e.isPrimary)return;
  finish(true);if(!editor.beginDrag('Adjust rig control'))return;gesture={uid:editor.selectedUid,index:editor.selectedJoint,element:range};
  gesture.element.setPointerCapture(e.pointerId);
 }));
 root.addEventListener('pointermove',guard(e=>{if(!gesture?.pad)return;const k=(e.shiftKey?.2:1)*Math.PI/180;applyPose(editor,{turn:gesture.pose.turn+(e.clientX-gesture.x)*k,pitch:gesture.pose.pitch+(e.clientY-gesture.y)*k});refresh();}));
 const adjust=t=>{
  if(t.hasAttribute('data-spatial-camera'))editor.setSpatialCamera({[t.dataset.spatialCamera]:t.valueAsNumber/(t.dataset.spatialCamera==='strength'?100:1)});
  else if(t.hasAttribute('data-spatial-shape'))editor.setSpatialProportions({[t.dataset.spatialShape]:t.valueAsNumber/100});
  else if(t.hasAttribute('data-spatial-reach'))withLimb(()=>editor.setSpatialIKTarget({depth:t.valueAsNumber}));
  else if(t.hasAttribute('data-spatial-motion'))editor.setSpatialMotion(t.valueAsNumber/100,{fraction:true});
  else return false;
  refresh();return true;
 };
 root.addEventListener('input',guard(e=>{if(e.target.type==='range'&&adjust(e.target))return;if(e.target.matches('[data-spatial-swivel]')){withLimb(()=>editor.setSpatialIKTarget({swivel:e.target.valueAsNumber/DEG}));refresh();return;}if(!e.target.matches('input[type=range][data-spatial-axis]'))return;const key=e.target.dataset.spatialAxis,pose=editor.getSpatialPose();if(pose)applyPose(editor,{[key]:pose[key]+wrap(e.target.valueAsNumber/DEG-pose[key])});refresh();}));
 root.addEventListener('change',guard(e=>{
  const t=e.target;if(t.type==='number'&&adjust(t))return;if(t.id==='spatial-joint'){finish(true);if(spatialControlMode(editor)==='figure')modes.set(editor,'rotate');editor.select(editor.selectedUid,Number(t.value));refresh();}
  else if(t.matches('input[type=number][data-spatial-axis]')){applyPose(editor,{[t.dataset.spatialAxis]:t.valueAsNumber/DEG});refresh();}
  else if(t.matches('[data-spatial-choice]')){editor.setPoseChoice(t.dataset.spatialChoice,Number(t.value));refresh();}
  else if(t.id==='spatial-details'){finish(true);setRigDetailsShown(editor,t.checked);refresh();}
  else if(t.id==='spatial-ik'){withLimb(()=>editor.setNodeIK(t.checked?{enabled:true,pinned:false}:{enabled:false}));refresh();}
  else if(t.id==='spatial-pin'){withLimb(()=>editor.setNodeIK({pinned:t.checked}));refresh();}
  else if(t.id==='spatial-stretch'){withLimb(()=>editor.setNodeIK({allowStretch:t.checked}));refresh();}
  else if(t.matches('[data-spatial-depth]')){withLimb(()=>editor.setSpatialIKTarget({depth:t.valueAsNumber}));refresh();}
  else if(t.dataset.drawingUid){const uid=Number(t.dataset.drawingUid),object=editor.selectionFrame.objects.find(o=>o.unique_id===uid),asset=editor.report.figure_types.find(f=>f.figure_type_id===object?.figure_type_id)?._styk?.movieclip;
   if(asset?.drawingSets){const prior=drawingSelection(asset,object),group=t.hasAttribute('data-drawing-group')?Number(t.value):prior.group,view=t.hasAttribute('data-drawing-view')?Number(t.value):Math.min(prior.view,asset.drawingSets[group].views.length-1);editor.setMovieclipDrawing(uid,group,view);refresh();}}

 }));
 root.addEventListener('click',guard(e=>{if(e.target.closest('[data-spatial-center-camera]')){finish(true);const p=editor.geometry.objects.get(editor.selectedSlot).root;editor.setSpatialCamera({centerX:p.x,centerY:p.y});refresh();return;}if(e.target.closest('[data-spatial-reset-camera]')){finish(true);editor.setSpatialCamera({strength:0,distance:600});refresh();return;}if(e.target.closest('[data-spatial-reset-shape]')){finish(true);editor.resetSpatialProportions();refresh();return;}const whole=e.target.closest('[data-spatial-whole]');if(whole){finish(true);modes.set(editor,'figure');editor.select(editor.selectedUid,editor.figure.segments.findIndex(s=>spatialBone(s)&&!s._stykRig.spatial.parent));refresh();return;}const focus=e.target.closest('[data-spatial-focus]');if(focus){finish(true);modes.set(editor,'rotate');editor.select(editor.selectedUid,Number(focus.dataset.spatialFocus));refresh();return;}const feet=e.target.closest('[data-spatial-feet]');if(feet){finish(true);editor.setSpatialFeetPinned(feet.dataset.spatialFeet==='plant');refresh();return;}const mode=e.target.closest('[data-spatial-mode]');if(mode){finish(true);modes.set(editor,mode.dataset.spatialMode);const f=editor.figure,s=f?.segments[editor.selectedJoint];
  if(mode.dataset.spatialMode==='rotate'){
   const child=editor.object?._stykIK?.[s?.segment_id]?.enabled?f.segments.findIndex(n=>spatialBone(n)&&n._stykRig.spatial.parent===s.segment_id):-1;
   if(child>=0)editor.select(editor.selectedUid,child);else if(!editor.getSpatialPose())editor.select(editor.selectedUid,f.segments.findIndex(spatialBone));
  }else if(spatialBone(s)&&editor.object?._stykIK?.[s._stykRig.spatial.parent]?.enabled)editor.select(editor.selectedUid,f.segments.findIndex(n=>n.segment_id===s._stykRig.spatial.parent));refresh();return;}const target=e.target.closest('[data-spatial-select]');if(target){finish(true);if(spatialControlMode(editor)==='figure'||Number(target.dataset.spatialSelect)===-1)modes.set(editor,'pose');editor.select(editor.selectedUid,Number(target.dataset.spatialSelect));refresh();return;}const t=e.target.closest('[data-spatial-reset]');if(t){finish(true);if(t.dataset.spatialReset==='joint'&&spatialControlMode(editor)==='figure')applyPose(editor,{bend:0,turn:0,pitch:0});else editor.resetSpatialPose(t.dataset.spatialReset==='all');refresh();}}));
 root.addEventListener('pointerup',()=>finish(true));root.addEventListener('pointercancel',()=>finish(false));root.addEventListener('lostpointercapture',()=>finish(true));
 root.addEventListener('keydown',guard(e=>{
  if(e.key==='Escape'&&gesture){e.preventDefault();e.stopPropagation();finish(false);return;}
  if(e.target.closest('[data-spatial-pad]')&&["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)){e.preventDefault();e.stopPropagation();const p=editor.getSpatialPose(),key=/Left|Right/.test(e.key)?'turn':'pitch',sign=/Left|Up/.test(e.key)?-1:1;if(p)applyPose(editor,{[key]:p[key]+sign*(e.shiftKey?1:5)/DEG});refresh();}
 }));
 editor.addEventListener('change',()=>{if(spatialControlMode(editor)==='figure'&&editor.figure?.segments[editor.selectedJoint]?._stykRig?.spatial?.parent)modes.set(editor,'rotate');if(gesture&&!editingLimb&&(gesture.uid!==editor.selectedUid||gesture.index!==editor.selectedJoint))finish(false);});
 return{finish};
}
