import {tupleMessages, messageTuple} from './localization-bindings.mjs';

import {messageError} from './localized-error.mjs';

import {t as interfaceText} from './localization.mjs';
/**
 * A part's rig in Build's Properties, as inspector sections (src/inspector-kit.mjs
 * descriptors), and the change handler for its controls. Every control keeps its
 * id or data-action; rigControlChange() applies a change by id.
 *
 * Rig reads top to bottom, one block per behaviour, and a behaviour's settings
 * show only while it is on:
 *   Link           Connect joints and Weighted joint (a connector: its anchors A and B, each picked on the canvas)
 *   Smart Stretch  its switch; while on: what drives it (a connector), rest length, limits, width, new parts
 *   Response       how this part answers a stretch that reaches it
 *   Angle lock     its choice; while on: the locked angle, when it applies and, for a movable parent, its
 *                  rotation and a second rotation
 * Attachment (the stretch driver and orientation) folds behind its own title. A
 * weighted joint and an angle-driven path show their own controls instead.
 */
import {rigConstraintPlan} from './rig-constraints.mjs';
import {canvasFont} from './ui/font-loading.mjs';

const degrees = radians => Math.round(radians * 180 / Math.PI * 100) / 100;
const num = (id, label, value, options = {}) => ({kind: 'number', id, label, value, unit: '', ...options});
const choice = (id, labelKey, value, options, extra = {}) => ({kind: 'select', id, label:interfaceText(labelKey),labelKey,value, span: 2, options: options.map((_tuple) => {const [key, text] = _tuple; const _messages = tupleMessages(_tuple); return {value: key, label: text, ...(_messages[1] ? {labelKey: _messages[1].key, labelParams: _messages[1].params} : {})};}), ...extra});
/** One behaviour's block; the section's CSS separates blocks with a hairline. */
const block = (name, rows, extra = {}) => ({kind: 'group', label: name, role: 'group', data: {'rig-block': name.toLowerCase().replace(/\s+/g, '-')}, rows,labelKey:extra.titleKey,labelParams:extra.titleParams, ...extra});
/** A block's head: the switch or choice that turns its behaviour on, as one full-width field. */
const head = row => ({kind: 'grid', rows: [{span: 2, ...row}]});
/** What a behaviour's head turns on: its settings, under a guide that ties them to the head. */
const settings = (rows, extra = {}) => ({kind: 'grid', rows, ...extra, data: {'rig-settings': true, ...extra.data}});

/** The Rig section's title: what the part's rig is (a weighted joint and an angle-driven path have their own controls). */
function rigSectionTitle(segment) {
  const r = segment?._stykRig ?? {};
  return r.weighted ? interfaceText("rigControls.weightedJoint") : r.anglePath ? interfaceText("rigControls.angleDrivenPath") : interfaceText("rigControls.rig");
}

/** A weighted joint's origin, anchor count and anchors (each a joint and its weight), under `prefix`. */
const anchorRows = (w, prefix) => [{kind: 'grid', rows: [
  num(`${prefix}origin`, interfaceText("rigControls.originJoint"), w.origin, {labelKey: "rigControls.originJoint", min: 0, max: 65535}),
  num(`${prefix}count`, interfaceText("rigControls.anchors"), w.anchors.length, {labelKey: "rigControls.anchors", min: 1, max: 16, description: interfaceText("rigControls.numberOfAnchors"), descriptionKey: "rigControls.numberOfAnchors"}),
  ...w.anchors.flatMap((anchor, i) => [
    num(`${prefix}joint-${i}`, interfaceText("rigControls.anchor", {value:i+1}), anchor.joint, {labelKey:"rigControls.anchor",labelParams:{value:i+1},min: 0, max: 65535}),
    num(`${prefix}weight-${i}`, interfaceText("rigControls.weight"), anchor.weight, {labelKey: "rigControls.weight", unit: '×', min: -100, max: 100, description: interfaceText("rigControls.anchorWeight", {value: i + 1}), descriptionKey: "rigControls.anchorWeight", descriptionParams: {value: i + 1}}),
  ]),
]}];

/**
 * The part's rig sections, always three in this order (so the inspector's
 * positions stay put): Rig (titled, open while the part has a rig), Attachment
 * and an angle-driven path's Reference positions; each is hidden where it does
 * not apply, and all three while `hidden` (a connector's Slider part).
 */
export function rigSections(editor, {hidden = false} = {}) {
  const segment = editor.figure?.segments[editor.selectedJoint];
  const r = segment?._stykRig ?? {};
  const none = id => ({id, hidden: true});
  if (hidden || !segment) return [none('rig-controls'), none('rig-attachment'), none('rig-path-keys')];
  const rigged = Boolean(r.connector || r.stretch || r.follow || r.response || r.angleLock || r.weighted || r.anglePath || r.orientation);
  const rig = {id: 'rig-controls', title: rigSectionTitle(segment),titleKey:r.weighted?'rigControls.weightedJoint':r.anglePath?'rigControls.angleDrivenPath':'rigControls.rig', place: 'titled', open: rigged};
  if (r.weighted) {
    const w = r.weighted;
    return [{...rig, rows: [
      ...anchorRows(w, 'rig-weighted-'),
      {kind: 'switch', id: 'rig-weighted-depth-enabled', label: interfaceText("rigControls.includeSurfaceDepth"), labelKey: "rigControls.includeSurfaceDepth", checked: Boolean(w.depth)},
      w.depth && block(interfaceText("rigControls.depthAnchors"), anchorRows(w.depth, 'rig-weighted-depth-'), {title: interfaceText("rigControls.depthAnchors"), titleKey: "rigControls.depthAnchors"}),
      {kind: 'meta', text: interfaceText("rigControls.offsetsFromTheOriginAreMultipliedByTheir"), textKey: "rigControls.offsetsFromTheOriginAreMultipliedByTheir"},
    ]}, none('rig-attachment'), none('rig-path-keys')];
  }
  if (r.anglePath) {
    const path = r.anglePath, depth = path.source !== undefined;
    return [{...rig, rows: [{kind: 'grid', rows: depth ? [num('rig-path-source', interfaceText("rigControls.depthSourceJoint"), path.source, {labelKey: "rigControls.depthSourceJoint", min: 1, max: 65535, span: 2})] : [
      num('rig-path-driver', interfaceText("rigControls.turnJoint"), path.driver, {labelKey: "rigControls.turnJoint", min: 1, max: 65535}),
      num('rig-path-pitch', interfaceText("rigControls.nodJoint"), path.pitch ?? 0, {labelKey: "rigControls.nodJoint", min: 0, max: 65535, tip: interfaceText("rigControls.message0TurnsNoddingOff"), tipKey: "rigControls.message0TurnsNoddingOff", description: interfaceText("rigControls.nodJoint0Off"), descriptionKey: "rigControls.nodJoint0Off"}),
    ]}]}, none('rig-attachment'), {id: 'rig-path-keys', title: interfaceText("rigControls.referencePositions"), titleKey: "rigControls.referencePositions", place: 'titled', hidden: depth, rows: depth ? [] : path.keys.map((key, i) => {
      const at = `${degrees(key[0])}°`;
      return block(`At ${at}`, [{kind: 'grid', rows: messageTuple(['X', 'Y', interfaceText("rigControls.depth")], {2: {key: "rigControls.depth", params: {}}}).map((axis, j) =>
        num(`rig-path-key-${i}-${j + 1}`, axis, key[j + 1], {unit: 'px', min: -1e6, max: 1e6, description: interfaceText("rigControls.at", {axis: axis, at: at}), descriptionKey: "rigControls.at", descriptionParams: {axis: j===2?{messageKey:"rigControls.depth"}:axis, at: at}, ...(j===2?{labelKey:"rigControls.depth"}:{})}))}], {labelKey:"rigControls.at2",labelParams:{at},title: interfaceText("rigControls.at2", {at: at}), titleKey: "rigControls.at2", titleParams: {at: at}});
    })}];
  }
  const plan = rigConstraintPlan(editor.figure), source = plan.inputs[editor.selectedJoint];
  const c = r.connector, d = r.stretch, f = r.follow, response = r.response ?? {}, lock = r.angleLock;
  const name = id => {const authored=editor.figure.segments[plan.ids.get(id)]?.name;if(id!==0&&authored)return {meta:authored};const metaKey=id===0?'rigControls.origin':'builderSurfaceUi.jointNumber',metaParams=id===0?{}:{id};return {meta:interfaceText(metaKey,metaParams),metaKey,metaParams};};
  const pick = (action, labelKey, labelParams) => ({icon:'origin',label:interfaceText(labelKey,labelParams),labelKey,labelParams,action});
  const link = c
    ? block(interfaceText("rigControls.anchors"), ['start', 'end'].map((key, i) => ({kind: 'list-row', label: interfaceText("rigControls.anchor", {value: i ? 'B' : 'A'}), labelKey: "rigControls.anchor", labelParams: {value: i ? 'B' : 'A'}, ...name(c[key]),
      actions: [pick(`rig-pick-${key}`, 'rigControls.pickAnchorOnCanvas',{anchor:i?'B':'A'})]})),{labelKey:"rigControls.anchors"})
    : {kind: 'actions', label: interfaceText("rigControls.link"), labelKey: "rigControls.link", fill: true, items: [
      {action: 'rig-connect', icon: 'link', label: interfaceText("rigControls.connect"), labelKey: "rigControls.connect", text: true, variant: 'outline', tip: interfaceText("rigControls.connectJointsLinkThisJointToAnotherWith"), tipKey: "rigControls.connectJointsLinkThisJointToAnotherWith"},
      {action: 'rig-weighted', icon: 'nodes', label: interfaceText("rigControls.weighted"), labelKey: "rigControls.weighted", text: true, variant: 'outline', tip: interfaceText("rigControls.weightedJointAddAJointThatFollowsA"), tipKey: "rigControls.weightedJointAddAJointThatFollowsA"},
    ]};
  const slide = c && d?.source && d.source !== 'span';
  const stretch = block(interfaceText("rigControls.smartStretch"), [
    head({kind: 'field-switch', id: 'rig-stretch-enabled', label: interfaceText("rigControls.smartStretch"), labelKey: "rigControls.smartStretch", checked: Boolean(d), tip: interfaceText("rigControls.holdCtrlWhileDraggingToStretchNewAttached"), tipKey: "rigControls.holdCtrlWhileDraggingToStretchNewAttached"}),
    d && settings([
      c && choice('rig-source', "rigControls.drivenBy", d.source ?? 'span', [messageTuple(['span', interfaceText("rigControls.anchorDistance")], {1: {key: "rigControls.anchorDistance", params: {}}}), messageTuple(['slide', interfaceText("rigControls.slidePosition")], {1: {key: "rigControls.slidePosition", params: {}}}), messageTuple(['combined', interfaceText("rigControls.distanceSlide")], {1: {key: "rigControls.distanceSlide", params: {}}})]),
      num('rig-rest', interfaceText("rigControls.restLength"), d.restLength, {labelKey: "rigControls.restLength", unit: 'px', min: 0.0001, max: 1e6, span: slide ? undefined : 2}),
      slide && num('rig-rest-position', interfaceText("rigControls.restSlide"), d.restPosition * 100, {labelKey: "rigControls.restSlide", unit: '%', min: 0.01, max: 100}),
      num('rig-min', interfaceText("rigControls.minimum"), d.min * 100, {labelKey: "rigControls.minimum", unit: '%', min: 0, max: 10000}),
      num('rig-max', interfaceText("rigControls.maximum"), d.max * 100, {labelKey: "rigControls.maximum", unit: '%', min: 1, max: 10000}),
      choice('rig-width', "rigControls.width", d.width, [messageTuple(['keep', interfaceText("rigControls.keepWidth")], {1: {key: "rigControls.keepWidth", params: {}}}), messageTuple(['inverse', interfaceText("rigControls.thickenOnCompression")], {1: {key: "rigControls.thickenOnCompression", params: {}}}), messageTuple(['scale', interfaceText("rigControls.scaleWithLength")], {1: {key: "rigControls.scaleWithLength", params: {}}})], {description: interfaceText("rigControls.widthResponse"), descriptionKey: "rigControls.widthResponse"}),
      !d.branch && {kind: 'field-switch', id: 'rig-auto-branch', label: interfaceText("rigControls.includeNewParts"), labelKey: "rigControls.includeNewParts", checked: false, span: 2, tip: interfaceText("rigControls.newPartsAttachedBelowStretchWithThisOne"), tipKey: "rigControls.newPartsAttachedBelowStretchWithThisOne"},
    ]),
  ],{labelKey:"rigControls.smartStretch"});
  const mode = response.mode ?? f?.mode ?? 'stretch';
  const respond = (source || f || r.response) && block(interfaceText("rigControls.stretchResponse"), [
    head(choice('rig-response', "rigControls.stretchResponse", mode, [messageTuple(['stretch', interfaceText("rigControls.stretch")], {1: {key: "rigControls.stretch", params: {}}}), messageTuple(['rigid', interfaceText("rigControls.keepRigidPassThrough")], {1: {key: "rigControls.keepRigidPassThrough", params: {}}}), messageTuple(['stop', interfaceText("rigControls.stopAtThisJoint")], {1: {key: "rigControls.stopAtThisJoint", params: {}}})],
      {tip: interfaceText("rigControls.howThisPartAnswersAStretchThatReaches"), tipKey: "rigControls.howThisPartAnswersAStretchThatReaches"})),
    mode !== 'stop' && settings([
      mode === 'stretch' && num('rig-multiplier', interfaceText("rigControls.multiplier"), response.multiplier ?? 1, {labelKey: "rigControls.multiplier", unit: '×', min: -10, max: 10, span: 2}),
      {kind: 'field-switch', id: 'rig-reset-impulse', label: interfaceText("rigControls.resetImpulseHere"), labelKey: "rigControls.resetImpulseHere", checked: Boolean(response.reset), span: 2,
        tip: interfaceText("rigControls.restartTheStretchAxisAtThisJointAnd"), tipKey: "rigControls.restartTheStretchAxisAtThisJointAnd"},
    ]),
  ],{labelKey:"rigControls.stretchResponse"});
  const parent = lock?.mode === 'parent', second = parent ? lock.secondary : null;
  const angle = !c && block(interfaceText("rigControls.angleLock"), [
    head(choice('rig-angle-lock', "rigControls.angleLock", lock?.mode ?? 'off', [messageTuple(['off', interfaceText("rigControls.off")], {1: {key: "rigControls.off", params: {}}}), messageTuple(['figure', interfaceText("rigControls.figure")], {1: {key: "rigControls.figure", params: {}}}), messageTuple(['parent', interfaceText("rigControls.movableParent")], {1: {key: "rigControls.movableParent", params: {}}}), messageTuple(['world', interfaceText("rigControls.world")], {1: {key: "rigControls.world", params: {}}})],
      {tip: interfaceText("rigControls.keepThisPartAtOneAngleWhileWhat"), tipKey: "rigControls.keepThisPartAtOneAngleWhileWhat"})),
    lock && settings([
      num('rig-lock-angle', interfaceText("rigControls.angle"), degrees(lock.angle), {labelKey: "rigControls.angle", unit: '°', min: -36000, max: 36000, span: parent ? undefined : 2, description: interfaceText("rigControls.lockedAngle"), descriptionKey: "rigControls.lockedAngle"}),
      parent && num('rig-lock-multiplier', interfaceText("rigControls.rotation"), lock.multiplier, {labelKey: "rigControls.rotation", unit: '×', min: -10, max: 10, description: interfaceText("rigControls.parentRotation"), descriptionKey: "rigControls.parentRotation"}),
      choice('rig-lock-space', "rigControls.applies", lock.space ?? 'rendered', [messageTuple(['rendered', interfaceText("rigControls.afterStretch")], {1: {key: "rigControls.afterStretch", params: {}}}), messageTuple(['authored', interfaceText("rigControls.beforeStretch")], {1: {key: "rigControls.beforeStretch", params: {}}})], {description: interfaceText("rigControls.applyAngleLock"), descriptionKey: "rigControls.applyAngleLock"}),
    ]),
    // A movable parent's lock can add a second joint's rotation: its own settings, named.
    parent && block(interfaceText("rigControls.secondRotation"), [settings([
      num('rig-lock-secondary', interfaceText("rigControls.joint"), second?.reference ?? 0, {labelKey: "rigControls.joint", min: 0, max: 65535, span: 2, tip: interfaceText("rigControls.addTheRotationOfASecondJoint0"), tipKey: "rigControls.addTheRotationOfASecondJoint0", description: interfaceText("rigControls.secondJoint0Off"), descriptionKey: "rigControls.secondJoint0Off"}),
      second && num('rig-lock-secondary-multiplier', interfaceText("rigControls.rotation"), second.multiplier, {labelKey: "rigControls.rotation", unit: '×', min: -10, max: 10, description: interfaceText("rigControls.secondRotation"), descriptionKey: "rigControls.secondRotation"}),
      second && num('rig-lock-secondary-rest', interfaceText("rigControls.restAngle"), second.restAngle * 180 / Math.PI, {labelKey: "rigControls.restAngle", unit: '°', min: -36000, max: 36000, description: interfaceText("rigControls.secondRestAngle"), descriptionKey: "rigControls.secondRestAngle"}),
    ])], {title: interfaceText("rigControls.secondRotation"), titleKey: "rigControls.secondRotation"}),
  ],{labelKey:"rigControls.angleLock"});
  const custom = r.orientation === 'world' || Boolean(f && !f.automatic);
  const attachment = {id: 'rig-attachment', title: interfaceText("rigControls.attachment"), titleKey: "rigControls.attachment", place: 'titled', open: custom, hidden: Boolean(c), rows: c ? [] : [
    {kind: 'list-row', label: interfaceText("rigControls.stretchDriver"), labelKey: "rigControls.stretchDriver", ...(source ? name(editor.figure.segments[source.driver].segment_id) : {meta:interfaceText("rigControls.automatic"),metaKey:"rigControls.automatic"}),
      actions: [pick('rig-pick-driver', 'rigControls.pickStretchDriverOnCanvas')]},
    {kind: 'grid', rows: [
      choice('rig-orientation', "rigControls.orientation", r.orientation ?? 'inherit', [messageTuple(['inherit', interfaceText("rigControls.followConnector")], {1: {key: "rigControls.followConnector", params: {}}}), messageTuple(['world', interfaceText("rigControls.keepAuthoredAngle")], {1: {key: "rigControls.keepAuthoredAngle", params: {}}})], {description: interfaceText("rigControls.attachmentOrientation"), descriptionKey: "rigControls.attachmentOrientation"}),
      f && !f.automatic && response.multiplier === undefined && num('rig-influence', interfaceText("rigControls.legacyInfluence"), f.influence, {labelKey: "rigControls.legacyInfluence", unit: '×', min: -4, max: 4, span: 2}),
    ]},
  ]};
  // Test rig is the band's (beside Done) and the figure's ⋯ menu's, so the section carries no second play button.
  return [{...rig, rows: [link, stretch, respond, angle]}, attachment, none('rig-path-keys')];
}
export function rigControlChange(editor,target) {
  const id=target.id;if(!id.startsWith('rig-')||id==='rig-mode')return false;
  const value=target.valueAsNumber;
  if(id.startsWith('rig-weighted-')){
    const weighted=structuredClone(editor.figure.segments[editor.selectedJoint]._stykRig.weighted);
    if(id==='rig-weighted-depth-enabled'){
      if(target.checked)weighted.depth={origin:weighted.origin,anchors:weighted.anchors.map(a=>({...a,weight:0}))};else weighted.depth=undefined;
    }else{
      const depth=id.startsWith('rig-weighted-depth-'),w=depth?weighted.depth:weighted,prefix=depth?'rig-weighted-depth-':'rig-weighted-',key=id.slice(prefix.length),match=/^(joint|weight)-(\d+)$/.exec(key);
      if(match)w.anchors[Number(match[2])][match[1]]=value;
      else if(key==='origin')w.origin=value;
      else if(key==='count'){
        if(!Number.isInteger(value)||value<1||value>16)throw messageError(new Error(''), "errors.rigControls.choose116Anchors", {});
        const used=new Set([w.origin,editor.figure.segments[editor.selectedJoint].segment_id,...w.anchors.map(a=>a.joint)]);
        const available=[0,...editor.figure.segments.map(s=>s.segment_id)].filter(id=>!used.has(id));
        while(w.anchors.length<value){const joint=available.shift();if(joint===undefined)throw messageError(new Error(''), "errors.rigControls.addAnotherAnchorJointFirst", {});w.anchors.push({joint,weight:0});}
        w.anchors.length=value;
      }else return false;
    }
    editor.setRigBehavior({weighted});
  }
  else if(id.startsWith('rig-path-')){
    const path=structuredClone(editor.figure.segments[editor.selectedJoint]._stykRig.anglePath),match=/^rig-path-key-(\d+)-([123])$/.exec(id);
    if(match)path.keys[Number(match[1])][Number(match[2])]=value;
    else if(id==='rig-path-pitch')path.pitch=value||undefined;
    else if(id==='rig-path-driver')path.driver=value;
    else if(id==='rig-path-source')path.source=value;
    else return false;
    editor.setRigBehavior({anglePath:path});
  }
  else if(id==='rig-position')editor.setConnectorPosition(value/100);
  else if(id==='rig-stretch-enabled')editor.enableSmartStretch(target.checked);
  else if(id==='rig-rest')editor.setRigBehavior({stretch:{restLength:value}});
  else if(id==='rig-min')editor.setRigBehavior({stretch:{min:value/100}});
  else if(id==='rig-max')editor.setRigBehavior({stretch:{max:value/100}});
  else if(id==='rig-width')editor.setRigBehavior({stretch:{width:target.value}});
  else if(id==='rig-auto-branch')editor.enableSmartStretch(true);
  else if(id==='rig-source'){
    const seg=editor.figure.segments[editor.selectedJoint],position=editor.object.len_flag?editor.object.lengths[editor.selectedJoint]:seg.length;
    editor.setRigBehavior({stretch:{source:target.value,restPosition:seg._stykRig.stretch.restPosition??Math.max(.0001,position)}});
  }
  else if(id==='rig-rest-position')editor.setRigBehavior({stretch:{restPosition:value/100}});
  else if(id==='rig-response')editor.setRigBehavior({response:{mode:target.value}});
  else if(id==='rig-multiplier')editor.setRigBehavior({response:{multiplier:value}});
  else if(id==='rig-reset-impulse')editor.setRigBehavior({response:{reset:target.checked}});
  else if(id==='rig-angle-lock')editor.setAngleLock(target.value);
  else if(id==='rig-lock-angle')editor.setRigBehavior({angleLock:{angle:value*Math.PI/180}});
  else if(id==='rig-lock-multiplier')editor.setRigBehavior({angleLock:{multiplier:value}});
  else if(id==='rig-lock-space')editor.setRigBehavior({angleLock:{space:target.value}});
  else if(id==='rig-lock-secondary')editor.setSecondaryAngleReference(value);
  else if(id==='rig-lock-secondary-multiplier')editor.setRigBehavior({angleLock:{secondary:{...editor.figure.segments[editor.selectedJoint]._stykRig.angleLock.secondary,multiplier:value}}});
  else if(id==='rig-lock-secondary-rest')editor.setRigBehavior({angleLock:{secondary:{...editor.figure.segments[editor.selectedJoint]._stykRig.angleLock.secondary,restAngle:value*Math.PI/180}}});
  else if(id==='rig-orientation')editor.setRigBehavior({orientation:target.value});
  else if(id==='rig-follow-driver')editor.bindStretchParts(value);
  else if(id==='rig-follow-mode')editor.setRigBehavior({follow:{mode:target.value}});
  else if(id==='rig-follow-rigid')editor.setRigBehavior({response:{mode:target.checked?'rigid':'stretch'}});
  else if(id==='rig-influence')editor.setRigBehavior({follow:{influence:value}});
  else if(id.startsWith('rig-anchor-'))editor.setRigBehavior({connector:{[id.slice(11)]:value}});
  else return false;
  return true;
}
/** Only the selected slider gets endpoint guides; never document artwork. */
export function drawConnectorGuides(ctx,geometry,editor,project) {
  const s=geometry.objects.get(editor.selectedSlot)?.segments[editor.selectedJoint];
  if(!s?.connector)return;
  const h=project(s.handle),a=project(s.start),b=project(s.end);
  ctx.save();ctx.lineWidth=1;ctx.strokeStyle='#808080';ctx.setLineDash([2,4]);
  ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(h.x,h.y);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.setLineDash([]);
  ctx.font=canvasFont('10px');ctx.fillStyle='#808080';
  ctx.fillText('A',a.x+9,a.y-9);ctx.fillText('B',b.x+9,b.y-9);ctx.restore();
}
export function drawRigGuides(ctx,geometry,editor,project) {
  const g=geometry.objects.get(editor.selectedSlot),s=g?.segments[editor.selectedJoint];if(!s)return;
  const rig=s.seg._stykRig;if(!rig)return;
  ctx.save();ctx.strokeStyle='#0d99ff';ctx.fillStyle='#0d99ff';ctx.lineWidth=1.5;
  const ring=p=>{const q=project(p);ctx.beginPath();ctx.arc(q.x,q.y,9,0,Math.PI*2);ctx.stroke();};
  if(rig.follow){const p=g.joints.get(rig.follow.driver);if(p)ring(p);}
  if(rig.stretch){const plan=rigConstraintPlan(editor.figure);for(const part of g.segments)if(plan.inputs[part.index]?.driver===s.index){ctx.globalAlpha=.5;ctx.lineWidth=3;ctx.beginPath();part.points.forEach((p,i)=>{const q=project(p);i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);});ctx.stroke();}}
  ctx.restore();
}
