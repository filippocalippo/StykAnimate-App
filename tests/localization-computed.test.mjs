import test from 'node:test';
import assert from 'node:assert/strict';
import english from '../src/locales/en.mjs';
import {interfaceLocalization, loadLocales} from '../src/localization.mjs';
await loadLocales();
import {engineEditor, ownedEditorFor} from './support/owned-editor.mjs';
import {construction} from '../src/rig-examples-3d.mjs';
import {createObject,createFrame,emptyDocument,createDemo} from '../src/demo.mjs';
import {spatialSections} from '../src/spatial-controls.mjs';
import {cameraMotionView} from '../src/camera-motion-ui.mjs';
import {motionRows} from '../src/camera-motion-timeline.mjs';
import {motionTypeMessages,motionParameterMessages,motionDescriptionMessages} from '../src/camera-motion-localization.mjs';
import {CAMERA_MOTION_TYPES,MOTION_PARAMETERS,motionParameterKeys,validateCameraMotion} from '../src/camera-motion.mjs';
import {createCameraMotion} from './support/camera-motion.mjs';
import {presetSummary,presetTile} from '../src/vfx-preset-ui.mjs';
import {VFX_REGISTRY,vfxProperty,validateVfxValue} from '../src/vfx.mjs';
import {errorMessageData,restoreMessageError,messageError} from '../src/localized-error.mjs';
import {errorText} from '../src/error-presentation.mjs';
import {validateOriginSupport,validateOriginObject} from '../src/animation-origin-validation.mjs';
import {createClipboardWireDecoder} from '../src/clipboard-wire.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {rigConstraintPlan} from '../src/rig-constraints.mjs';
import {textOptionsWithDefaults} from '../src/text-authoring.mjs';
import {validateSticknodesObject} from '../src/sticknodes/validation.mjs';
import fontService from '../desktop/font-service.cjs';
import videoService from '../desktop/video-export-service.cjs';
import {validateAudioAssetSteps} from '../src/audio-model.mjs';
import {inspectorDescriptor} from '../src/inspector-view.mjs';
import {rigSections} from '../src/rig-controls.mjs';
import {renderInspector} from '../src/inspector-kit.mjs';
import {VfxInspector} from '../src/vfx-inspector.mjs';
import {DrawingController} from '../src/drawing-controller.mjs';
import {exportCodecChoices,exportFormatStates,exportEncodingSummary} from '../src/export-request.mjs';

const fixture=()=>ownedEditorFor({demo:false,layerTimeline:true},emptyDocument());
const populatedFixture=()=>engineEditor({demo:false,layerTimeline:true},createDemo());

test('rig descriptors retain numeric captions, descriptions, anchor actions and raw authored joint names',()=>{
 const editor=populatedFixture();editor.select(1,2);editor.enableSmartStretch(true);editor.setAngleLock('parent');
 const walk=rows=>(rows??[]).flatMap(row=>row?[row,...walk(row.rows)]:[]);
 const rows=walk(rigSections(editor).flatMap(section=>section.rows??[]));
 for(const id of ['rig-rest','rig-min','rig-max','rig-lock-angle','rig-lock-multiplier','rig-lock-space']){
  const row=rows.find(row=>row.id===id);assert.ok(row?.labelKey,id);
 }
 assert.equal(rows.find(row=>row.id==='rig-lock-angle').descriptionKey,'rigControls.lockedAngle');
 const weighted=editor.addWeightedJoint(0,[{joint:editor.figure.segments[0].segment_id,weight:.5}]);
 editor.select(1,editor.figure.segments.findIndex(segment=>segment.segment_id===weighted.segment_id));
 const anchors=walk(rigSections(editor).flatMap(section=>section.rows??[]));
 const first=anchors.find(row=>row.id==='rig-weighted-joint-0');
 assert.equal(first.labelKey,'rigControls.anchor');assert.deepEqual(first.labelParams,{value:1});
 const weight=anchors.find(row=>row.id==='rig-weighted-weight-0');
 assert.equal(weight.descriptionKey,'rigControls.anchorWeight');assert.deepEqual(weight.descriptionParams,{value:1});
 const bytes=JSON.stringify(editor.serialize()),undo=editor._undo.length;
 interfaceLocalization.setPseudo('long');
 try{
  const html=renderInspector({kind:'joint',sections:rigSections(editor)});
  assert.match(html,/data-i18n="rigControls.anchor"/);
  assert.match(html,/data-i18n-aria-label="rigControls.anchorWeight"/);
  assert.equal(JSON.stringify(editor.serialize()),bytes);assert.equal(editor._undo.length,undo);
 }finally{interfaceLocalization.setPseudo(null);}
 const vfx=Object.create(VfxInspector.prototype);vfx.editor=editor;
 editor.figure.name='My authored figure';
 const target={kind:'segment',uid:1,handleId:weighted.segment_id};
 const name=vfx.ownerNameMessage(target);
 assert.equal(name.messageParams.name,'My authored figure');
 assert.equal(name.messageParams.joint.messageKey,'builderSurfaceUi.jointNumber');
 assert.match(vfx.ownerNameHTML(target),/data-i18n="vfxInspector.segmentOwner"/);
 assert.equal(vfx.ownerName({kind:'figure',uid:1}),'My authored figure');
});

test('model, rig, editor, range, text, SVG and font failures localize human labels without changing diagnostics or failed-edit state',async()=>{
 const editor=populatedFixture(),before=JSON.stringify(editor.serialize()),history=editor._undo.length,failures=[];
 const capture=(message,labelKey,field)=>error=>{
  assert.equal(error.message,message);assert.equal(error.messageParams.label.messageKey,labelKey);
  if(field)assert.equal(error.messageParams.label.messageParams.field,field);
  failures.push(error);return true;
 };
 const badTiming=emptyDocument();badTiming.frame_delay_ms=0;
 assert.throws(()=>validateScene(badTiming),capture('Frame delay must be an integer from 1 to 65535.','errors.validationLabels.frameDelay'));
 const badPose=structuredClone(editor.report);badPose.keyframes[0].objects[0].root_x=NaN;
 assert.throws(()=>validateScene(badPose),capture('Object root_x must be a finite number.','errors.validationLabels.objectField','root_x'));
 const rig=structuredClone(editor.figure);rig.segments[0]._stykRig={connector:{start:999,end:0,restLength:1}};
 assert.throws(()=>rigConstraintPlan(rig),capture('Connector start refers to a missing joint. Remove or reconnect the rig relationship first.','errors.validationLabels.connectorStart'));
 assert.throws(()=>editor.seek(NaN),capture('Timeline tick must be finite.','errors.validationLabels.timelineTick'));
 assert.throws(()=>textOptionsWithDefaults({text:'Hello',fontSize:NaN}),capture('Font size must be between 1 and 2048.','errors.validationLabels.fontSize'));
 assert.throws(()=>validateSticknodesObject({_sticknodesSprite:{ratio:NaN,pivotX:0,pivotY:0}},editor.figure),capture('Invalid Stick Nodes sprite ratio.','errors.validationLabels.spriteField','ratio'));
 assert.throws(()=>new fontService.FontService({maxFonts:0}),capture('Invalid font limit.','desktop.fontService.labels.limit'));
 assert.throws(()=>[...validateAudioAssetSteps({id:'audio',name:'Recording',size:NaN})],error=>{
  assert.equal(error.message,'Audio file size must be between 1 and 33554432.');
  assert.equal(error.messageParams.name.messageKey,'errors.validationLabels.audioFileSize');failures.push(error);return true;
 });
 assert.throws(()=>videoService.validateConfig({format:'mp4',width:0,height:480,fps:24,totalFrames:1}),error=>{
  assert.equal(error.message,'Video width must be an integer between 1 and 16384.');
  assert.equal(error.messageParams.name.messageKey,'errors.validationLabels.videoWidth');failures.push(error);return true;
 });
 interfaceLocalization.setPseudo('long');
 try{
  for(const failure of failures){
   const restored=restoreMessageError(new Error(),structuredClone(errorMessageData(failure)));
   assert.equal(restored.message,failure.message);assert.equal(errorText(restored),interfaceLocalization.t(restored.messageKey,restored.messageParams));
   const parameter=restored.messageParams.label??restored.messageParams.name;
   assert.ok(errorText(restored).includes(interfaceLocalization.t(parameter.messageKey,parameter.messageParams)));
  }
 }finally{interfaceLocalization.setPseudo(null);}
 assert.equal(JSON.stringify(editor.serialize()),before);assert.equal(editor._undo.length,history);
});

test('generated inspector headings carry localized references while authored names remain literal',()=>{
 const editor=populatedFixture();editor.select(editor.frame.objects[0].unique_id,0);
 const joint=inspectorDescriptor({editor}).target;
 assert.equal(joint.nameKey,'builderSurfaceUi.jointNumber');assert.equal(joint.name,'Joint '+editor.figure.segments[0].segment_id);
 const camera=inspectorDescriptor({editor,context:'camera'}).target;
 assert.equal(camera.nameKey,'inspectorView.camera');
 editor.figure.segments[0].name='Artist named Joint';
 const authored=inspectorDescriptor({editor}).target;
 assert.equal(authored.name,'Artist named Joint');assert.equal(authored.nameKey,undefined);
 const buffering=english['appDialogs.bufferingSummary'];
 assert.match(interfaceLocalization.t('appDialogs.bufferingSummary',{milliseconds:1,count:1}),/1 wait$/);
 assert.match(interfaceLocalization.t('appDialogs.bufferingSummary',{milliseconds:1,count:2}),/2 waits$/);
 assert.ok(buffering.one&&buffering.other);
});

test('origin and clipboard failures translate complete diagnostics while preserving original text and unpublished state',async()=>{
 const editor=fixture(),bytes=JSON.stringify(editor.serialize()),history=editor._undo.length,failures=[];
 const capture=(key,message)=>error=>{
  assert.equal(error.messageKey,key);assert.equal(error.message,message);failures.push(error);return true;
 };
 const originKey='errors.animationOriginValidation.details.';
 assert.throws(()=>validateOriginSupport({segments:[{segment_id:0}],_styk:{animationOrigin:{}}}),capture(originKey+'mustBeAnIntegerFromTo','Animation origin native handle must be an integer from 1 to 65535.'));
 const orphan=ghosts=>({_stykAnimationOrigin:{x:0,y:0,ghosts}});
 assert.throws(()=>validateOriginObject(orphan({'0':{angle_rad:NaN,bend_rad:0,length:1}}),{segments:[]}),capture(originKey+'mustBeFinite','Animation origin ghost angle must be finite.'));
 assert.throws(()=>validateOriginObject(orphan({'0':null}),{segments:[]}),capture(originKey+'mustBeAPoseRecord','Animation origin ghost must be a pose record.'));
 assert.throws(()=>validateOriginObject({_stykAnimationOrigin:{x:1e39,y:0}},{segments:[]}),capture(originKey+'exceedsNativeFloat32Range','Animation origin x exceeds the native float32 range.'));
 assert.throws(()=>validateOriginObject({_stykAnimationOrigin:null},{segments:[]}),capture(originKey+'poseMustBeARecord','Animation origin pose must be a record.'));
 const decoder=createClipboardWireDecoder();
 await assert.rejects(decoder.push(Uint8Array.of(83,84,89,75,67,66,87,49,99).buffer),capture('errors.clipboardWire.details.unknownToken','Invalid clipboard wire: unknown token.'));
 assert.throws(()=>createClipboardWireDecoder().finish(),capture('errors.clipboardWire.details.truncatedStream','Invalid clipboard wire: truncated stream.'));
 interfaceLocalization.setPseudo('long');
 try{
  for(const error of failures){
   const restored=restoreMessageError(new Error(),structuredClone(errorMessageData(error)));
   assert.equal(restored.message,error.message);assert.equal(errorText(restored),interfaceLocalization.t(error.messageKey,error.messageParams));
   assert.ok(errorText(restored).includes('［'));
   const label=restored.messageParams.label;
   if(label?.messageKey)assert.ok(errorText(restored).includes(interfaceLocalization.t(label.messageKey)));
   assert.equal(Object.hasOwn(restored.messageParams,'message'),false,'Owned details are not opaque English parameters');
  }
 }finally{interfaceLocalization.setPseudo(null);}
 assert.equal(JSON.stringify(editor.serialize()),bytes);assert.equal(editor._undo.length,history);
});

test('camera fields retain scalar diagnostics while their display references survive transport',()=>{
 const editor=fixture(),before=JSON.stringify(editor.serialize()),history=editor._undo.length,failures=[];
 assert.throws(()=>editor.setCameraValues({x:NaN}),error=>{failures.push(error);return error.message==='Camera x must be finite.';});
 assert.throws(()=>editor.alignCameraToView({x:0,y:0,scale:1,width:NaN,height:540}),error=>{failures.push(error);return error.message==='Canvas width must be finite.';});
 interfaceLocalization.setPseudo('long');
 try{
  for(const error of failures){
   const restored=restoreMessageError(new Error(),structuredClone(errorMessageData(error)));
   assert.equal(restored.message,error.message);
   const value=restored.messageParams.label??restored.messageParams.value;
   assert.ok(errorText(restored).includes(interfaceLocalization.t(value.messageKey,value.messageParams)));
   if(value.messageParams)assert.ok(errorText(restored).includes(value.messageParams.field));
  }
 }finally{interfaceLocalization.setPseudo(null);}
 assert.equal(JSON.stringify(editor.serialize()),before);assert.equal(editor._undo.length,history);
});

test('camera and effect validation translate every parameter while keeping diagnostic identity through transport',()=>{
 const failures=[];
 for(const type of Object.keys(CAMERA_MOTION_TYPES))for(const parameter of motionParameterKeys(type)){
  const clip=createCameraMotion(type,'test',0,24,{targets:[{uid:1,weight:1}]});clip.params[parameter]=NaN;
  assert.throws(()=>validateCameraMotion({version:1,clips:[clip]}),error=>{failures.push(error);return error.message===`${MOTION_PARAMETERS[parameter][0]} must be between ${MOTION_PARAMETERS[parameter][1]} and ${MOTION_PARAMETERS[parameter][2]}.`;});
 }
 for(const [type,definition]of Object.entries(VFX_REGISTRY))for(const parameter of [...Object.keys(definition.params),'enabled'])
  assert.throws(()=>validateVfxValue(vfxProperty(type,'test',parameter),NaN),error=>{failures.push(error);return true;});
 assert.throws(()=>validateVfxValue('vfxScope',NaN),error=>{failures.push(error);return error.message==='Include attached parts must be between 0 and 1.';});
 interfaceLocalization.setPseudo('long');
 try{
  for(const error of failures){
   const label=error.messageParams.label;
   assert.ok(Object.hasOwn(english,label.messageKey),label.messageKey);
   assert.ok(error.message.startsWith(label.diagnosticValue));
   const restored=restoreMessageError(new RangeError(error.message),structuredClone(errorMessageData(error)));
   assert.ok(restored instanceof RangeError);assert.equal(restored.message,error.message);
   assert.equal(errorText(restored),interfaceLocalization.t(error.messageKey,error.messageParams));
   assert.ok(errorText(restored).includes(interfaceLocalization.t(label.messageKey)));
  }
 }finally{interfaceLocalization.setPseudo(null);}
 const ordinary=messageError(new Error(),'errors.cameraMotion.mustBeBetweenAnd',{label:{messageKey:'common.save'},min:0,max:1});
 assert.equal(ordinary.message,'[object Object] must be between 0 and 1.','ordinary non-scalar diagnostics retain their existing normalization');
});

test('computed camera copy is complete and resolves after language changes without changing saved motion',()=>{
 assert.deepEqual(Object.keys(motionTypeMessages),Object.keys(CAMERA_MOTION_TYPES));
 assert.deepEqual(Object.keys(motionParameterMessages),Object.keys(MOTION_PARAMETERS));
 for(const key of [...Object.values(motionTypeMessages),...Object.values(motionParameterMessages),...Object.values(motionDescriptionMessages)])assert.ok(Object.hasOwn(english,key),key);
 const editor=fixture(),id=editor.addCameraMotion('shake');editor._selectedCameraMotion=id;
 const bytes=JSON.stringify(editor.serialize()),history=editor._undo.length;
 interfaceLocalization.setPseudo('long');
 try{
  const view=cameraMotionView(editor);
  assert.ok(view.includes(interfaceLocalization.t('cameraMotionUi.presetShake')));
  assert.match(view,/data-i18n="cameraMotionUi.roughness"/);
  assert.match(view,/data-i18n-aria-label="cameraMotionUi.disableMove"/);
  assert.equal(motionRows(editor)[0].name,interfaceLocalization.t('inspectorView.motion'));
  assert.equal(JSON.stringify(editor.serialize()),bytes);assert.equal(editor._undo.length,history);
 }finally{interfaceLocalization.setPseudo(null);}
 assert.equal(motionRows(editor)[0].name,'Motion');
});

test('preset summaries translate effect names, counts and animation while glyph categories stay canonical',()=>{
 const preset={effects:[{type:'glow'}],keys:{}};
 interfaceLocalization.setPseudo('long');
 try{
  assert.equal(presetSummary(preset),interfaceLocalization.t('vfxCatalog.effect.glow'));
  const group={effects:[{type:'glow'},{type:'blur'}],keys:{radius:[]}};
  assert.equal(presetSummary(group),interfaceLocalization.t('vfxPresetUi.animatedSummary',{count:2,summary:{messageKey:'counts.effects',messageParams:{count:2}}}));
  assert.match(presetTile(group),/vfx-tile/);
  assert.equal(JSON.stringify(preset),'\{"effects":[\{"type":"glow"\}],"keys":\{\}\}');
 }finally{interfaceLocalization.setPseudo(null);}
});

test('canonical skeleton names keep secondary part controls and localized depth notes in every language',()=>{
 const q=construction();q.add(0,0,0,'Figure rotation');
 const bone=(parent,origin,tip,name)=>{
  const turn=q.add(0,0,0,name+' turn'),pitch=q.add(0,0,0,name+' tilt'),v=tip.map((n,i)=>n-origin[i]);
  return q.add(parent,Math.hypot(...v),Math.atan2(v[1],v[0]),name,{control:true,rig:{spatial:{parent,origin,tip,turn,pitch}}});
 };
 const chest=bone(0,[0,0,0],[0,40,0],'Chest');bone(chest,[0,40,0],[10,60,0],'My hair');
 const unnamed=bone(chest,[0,40,0],[-10,60,0],'');
 const figure={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]};
 const editor=engineEditor({demo:false}, {...emptyDocument(),figure_types:[figure],keyframes:[createFrame([createObject(figure,1,200,100)])]});
 editor.select(1,-1);const bytes=JSON.stringify(editor.serialize());
 interfaceLocalization.setPseudo('long');
 try{
  const sections=spatialSections(editor,{hotkeyLabel:()=> 'D / F'});
  assert.ok(sections.find(section=>section.id==='rig-body').rows[0].html.includes('My hair'));
  const choices=sections.find(section=>section.id==='rig-body').rows.find(row=>row.kind==='grid').rows[0].options;
  const fallback=choices.find(option=>option.value===q.segments.findIndex(segment=>segment.segment_id===unnamed));
  assert.equal(fallback.labelKey,'builderSurfaceUi.jointNumber');
  assert.deepEqual(fallback.labelParams,{id:unnamed});
  assert.equal(fallback.label,interfaceLocalization.t(fallback.labelKey,fallback.labelParams));
  assert.equal(choices.find(option=>option.label==='My hair').labelKey,undefined);
  const meta=sections.find(section=>section.id==='rig-pose').rows.find(row=>row.kind==='meta');
  assert.equal(meta.textParams.value.messageKey,'spatialControls.depthHint');
  assert.equal(meta.textParams.value.messageParams.key,'D');
  assert.ok(meta.text.includes(interfaceLocalization.t('spatialControls.depthHint',{key:'D'})));
  assert.equal(JSON.stringify(editor.serialize()),bytes);
 }finally{interfaceLocalization.setPseudo(null);}
});

test('fill ordering captions and fixed image shapes retain display keys while command identities and document bytes stay raw',async()=>{
 const editor=populatedFixture();editor.figure.polyfills=[{polyfill_id:1,segment_ids:[0,1,2],color_rgb:[30,60,90],z_order:1}];
 const walk=rows=>(rows??[]).flatMap(row=>row?[row,...walk(row.rows)]:[]);
 const bytes=JSON.stringify(editor.serialize());
 for(const builder of [false,true]){
  if(builder)editor.selectPolygon(1,0);else editor.select(1);
  const descriptor=inspectorDescriptor({editor,builder});
  const actions=walk(descriptor.sections.flatMap(section=>section.rows??[])).find(row=>row.kind==='actions'&&row.items?.some(item=>item.action==='builder-order'));
  assert.equal(actions.labelKey,'inspectorView.fillOrder');
  assert.deepEqual(actions.items.map(item=>item.data),['back','down','up','front'].map(direction=>({kind:'polygon',index:0,direction})));
  assert.deepEqual(actions.items.map(item=>item.labelKey),['inspectorView.sendToBack','inspectorView.sendBackward','inspectorView.bringForward','inspectorView.bringToFront']);
  interfaceLocalization.setPseudo('rtl');
  try{const html=renderInspector(descriptor);assert.match(html,/data-i18n-aria-label="inspectorView.sendToBack"/);assert.doesNotMatch(html,/aria-label="[^"]* · polygon/);}finally{interfaceLocalization.setPseudo(null);}
 }
 assert.equal(JSON.stringify(editor.serialize()),bytes);
 const {createImageFigure}=await import('../src/media-authoring.mjs');
 const image=ownedEditorFor({demo:false,layerTimeline:true});image.importFigure(createImageFigure({dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHk8AAAAASUVORK5CYII=',width:1,height:1,name:'Artist image'}));image.select(image.selectedUid,0);
 const fields=walk(inspectorDescriptor({editor:image}).sections.flatMap(section=>section.rows??[]));
 const fixed=fields.flatMap(row=>row.options??[]).find(option=>option.value==='image');
 assert.equal(fixed.labelKey,'builderOutliner.image');assert.equal(image.figure.name,'Artist image');
});

test('owned codec display notes translate without rewriting capability diagnostics or duplicating lossless labels',async()=>{
 const service=new videoService.VideoExportService({encoderPath:'/missing-styk-localization-test-encoder'});
 const originalLocale=interfaceLocalization.locale;
 try{
  const capabilities=await service.capabilities({width:31,height:23}),bytes=JSON.stringify(capabilities);
  const avi=capabilities.formats.find(format=>format.id==='avi'),webm=capabilities.formats.find(format=>format.id==='webm');
  const ffv1=avi.codecs.find(codec=>codec.id==='ffv1'),vp9=webm.codecs.find(codec=>codec.id==='vp9');
  assert.equal(ffv1.label,'FFV1 (lossless)');assert.equal(vp9.label,'VP9 with transparency');
  for(const locale of ['ar','he','fr']){
   interfaceLocalization.setLocale(locale);
   const lossless='FFV1'+interfaceLocalization.t('exportRequest.lossless');
   const choices=exportCodecChoices(avi).options;
   assert.equal(choices.find(option=>option.id==='ffv1').label,lossless);
   assert.equal(choices.find(option=>option.id==='rawvideo').label,interfaceLocalization.t('desktop.videoExportService.uncompressedRgb'));
   assert.equal(exportCodecChoices(webm).options[0].label,'VP9 · '+interfaceLocalization.t('exportSheet.transparent'));
   const available={...capabilities,width:31,height:23,formats:[avi,webm].map(format=>({...format,supported:true,codecs:format.codecs.map(codec=>({...codec,supported:true}))}))};
   const states=exportFormatStates({capabilities:available,totalFrames:10,codecs:{avi:'ffv1'}});
   assert.equal(states.get('avi').codecLabel,lossless);
   assert.equal(states.get('webm').codecLabel,'VP9 · '+interfaceLocalization.t('exportSheet.transparent'));
   assert.equal(states.get('webm').codec,undefined);
   assert.equal(exportEncodingSummary({format:'webm',bitrateMode:'auto'},states),'VP9 · '+interfaceLocalization.t('exportSheet.transparent')+' · '+interfaceLocalization.t('exportRequest.automaticBitrate'));
  }
  assert.equal(JSON.stringify(capabilities),bytes);
 }finally{interfaceLocalization.setLocale(originalLocale);await service.dispose();}
});

test('new saved brushes use current captions while existing artist names and saved preset data stay literal',async()=>{
 const originalLocale=interfaceLocalization.locale,artist={id:'custom-artist',name:'Artist ink العربية',description:'Artist note',size:17};
 const bytes=JSON.stringify(artist),controller=Object.create(DrawingController.prototype);let saves=0;
 Object.assign(controller,{editor:{activeLayerId:'drawing'},library:{presets:[artist]},settings:{preset:'ink',size:23},settle:()=>null,applySelection:async()=>null,saveLibrary:()=>saves++,onUI:()=>{},onStatus:()=>{}});
 try{
  interfaceLocalization.setLocale('fr');await controller.action('save-preset');
  assert.equal(controller.library.presets[1].name,interfaceLocalization.t('drawingPresets.ink')+' 2');
  assert.equal(controller.library.presets[1].description,interfaceLocalization.t('drawingController.savedBrush'));
  const saved=JSON.stringify(controller.library.presets[1]);
  interfaceLocalization.setLocale('ar');controller.settings.preset=null;await controller.action('save-preset');
  assert.equal(controller.library.presets[2].name,interfaceLocalization.t('drawingView.custom')+' 3');
  assert.equal(JSON.stringify(controller.library.presets[1]),saved);assert.equal(JSON.stringify(artist),bytes);assert.equal(saves,2);
 }finally{interfaceLocalization.setLocale(originalLocale);}
});
