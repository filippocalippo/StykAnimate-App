import {presentError} from './error-presentation.mjs';
import {messageError} from './localized-error.mjs';
import {localizedText, messageHTML, messageAttributes} from './localization-bindings.mjs';
import {t as interfaceText} from './localization.mjs';

import {Editor} from './editor.mjs';
import {installEngineOwner} from './engine/engine-owner.mjs';
import {RIG_EXAMPLES, rigExampleDocument} from './rig-examples.mjs';
import {icon} from './icons.mjs';
import {engineDocumentPicture, placement} from './engine/engine-pictures.mjs';
const exampleNameKeys = Object.freeze({
  "counter-rotating-gears": "rigTestUi.examples.counterRotatingGears",
  "folding-fan": "rigTestUi.examples.foldingFan",
  "accordion-screen-3d": "rigTestUi.examples.accordionScreen3d",
  "expanding-crate-3d": "rigTestUi.examples.expandingCrate3d",
  "perspective-conveyor-3d": "rigTestUi.examples.perspectiveConveyor3d",
  "solid-box-3d": "rigTestUi.examples.solidBox3d",
  "solid-cylinder-3d": "rigTestUi.examples.solidCylinder3d",
  "solid-wedge-3d": "rigTestUi.examples.solidWedge3d",
  "solid-pyramid-3d": "rigTestUi.examples.solidPyramid3d",
  "solid-gem-3d": "rigTestUi.examples.solidGem3d",
  "glass-cube-3d": "rigTestUi.examples.glassCube3d",
  "wire-globe-3d": "rigTestUi.examples.wireGlobe3d",
  "double-helix-3d": "rigTestUi.examples.doubleHelix3d",
  "perspective-tunnel-3d": "rigTestUi.examples.perspectiveTunnel3d",
  "orbital-gyroscope-3d": "rigTestUi.examples.orbitalGyroscope3d",
  "turbine-3d": "rigTestUi.examples.turbine3d"
});
let disposeTest;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** A bounded, detached editor exercises the real commands: its own engine session (not the project's: the stage keeps drawing
 * the open document) evaluates and edits it. Neither construction definitions, authored sources nor undo in the live editor
 * change. Its pictures are drawn by the engine (engine-pictures.mjs) from the test editor's pose. */
export function openRigTest(host,document,{back,galleryPreview=false}={}) {
  disposeTest?.();host.finish?.();
  const source=document??host.editor._shown.figureDocument({figureUid:host.editor.selectedUid,tick:host.editor.tick});
  const initial=structuredClone(source),test=new Editor({demo:false,layerTimeline:true}),owner=installEngineOwner(test,{detached:true});test.load(initial);
  const figure=test.report.figure_types[0],object=test.evaluatedFrame.objects[0],
    selected=host.editor.figure?.segments[host.editor.selectedJoint]?.segment_id,
    control=(galleryPreview?figure._styk?.rigExample?.control:figure.segments.find(s=>s.segment_id===selected)?.segment_id)??figure.segments.find(s=>s.aux_code!==1)?.segment_id??figure.segments[0].segment_id;
  const example=galleryPreview&&RIG_EXAMPLES.some(r=>r.id===figure._styk?.rigExample?.id);
  test.select(object.unique_id,figure.segments.findIndex(s=>s.segment_id===control));
  host.showDialog(example ? interfaceText(exampleNameKeys[figure._styk.rigExample.id]) : figure.name,`<canvas id="rig-test-canvas" class="rig-test-canvas" aria-label="Interactive rig test canvas" title="Drag to rotate. Ctrl-drag a control to stretch." data-i18n-aria-label="rigTestUi.interactiveRigTestCanvas" data-i18n-title="rigTestUi.dragToRotateCtrlDragAControlTo"></canvas>
    <div class="rig-test-toolbar"><label class="rig-select rig-test-joints">${messageHTML("rigTestUi.joint", {})}<select id="rig-test-joint" class="inline-select" aria-label="Test joint" data-i18n-aria-label="rigTestUi.testJoint">${figure.segments.filter(s=>s.aux_code!==1||s.segment_id===control).map(s=>`<option value="${s.segment_id}" ${s.name?'':messageAttributes('builderSurfaceUi.jointNumber',{id:s.segment_id})}>${esc(s.name||interfaceText('builderSurfaceUi.jointNumber',{id:s.segment_id}))}</option>`).join('')}</select></label>
    <label class="field"><span id="rig-test-value-label" data-i18n="rigTestUi.length">${messageHTML("rigTestUi.length", {})}</span><input id="rig-test-value" type="number" step="any" aria-label="Test control value" data-i18n-aria-label="rigTestUi.testControlValue"></label>
    <label class="field"><span data-i18n="rigTestUi.angle">${messageHTML("rigTestUi.angle", {})}</span><input id="rig-test-angle" type="number" step="1" aria-label="Test control angle" data-i18n-aria-label="rigTestUi.testControlAngle"><small>°</small></label>
    </div><div class="rig-test-utilities"><button class="button" id="rig-test-fit">${icon('fit')}${messageHTML("rigTestUi.fit", {})}</button><button class="button" id="rig-test-reset">${icon('reset')}${messageHTML("common.reset", {})}</button></div>
    <p id="rig-test-status" class="property-note" role="status" hidden></p>
    <div class="dialog-actions">${back?`<button class="button" id="rig-test-back" data-i18n="rigTestUi.back">${messageHTML("rigTestUi.back", {})}</button>`:`<button class="button" data-action="close-dialog" ${messageAttributes((host.builderActive?.() ? "rigTestUi.returnToBuilder" : "rigTestUi.close"), (host.builderActive?.() ? {} : {}))}>${host.builderActive?.()?interfaceText("rigTestUi.returnToBuilder"):interfaceText("rigTestUi.close")}</button>`}${example?`<button class="button primary" id="rig-test-add" data-i18n="rigTestUi.addToAnimate">${messageHTML("rigTestUi.addToAnimate", {})}</button>`:''}</div>`, {titleKey: example ? exampleNameKeys[figure._styk.rigExample.id] : undefined});
  const canvas=window.document.getElementById('rig-test-canvas'),dialog=canvas.closest('dialog'),ctx=canvas.getContext('2d'),events=new AbortController(),on={signal:events.signal};
  const jointInput=window.document.getElementById('rig-test-joint'),valueInput=window.document.getElementById('rig-test-value'),angleInput=window.document.getElementById('rig-test-angle'),label=window.document.getElementById('rig-test-value-label'),status=window.document.getElementById('rig-test-status');
  let drag=false,view={scale:1,x:0,y:0}, scheduled=0,disposed=false,drawing=false,redraw=false;
  const error=e=>{status.hidden=false;presentError(status, e);};
  window.document.getElementById('rig-test-back')?.addEventListener('click',back,on);
  const guarded=fn=>e=>{try{status.hidden=true;status.textContent='';fn(e);}catch(err){error(err);}};
  function fit(){const g=test.geometry.objects.get(0),p=[...g.joints.values()],xs=p.map(p=>p.x),ys=p.map(p=>p.y),minX=Math.min(...xs)-45,maxX=Math.max(...xs)+45,minY=Math.min(...ys)-45,maxY=Math.max(...ys)+45;
    const scale=Math.min(canvas.clientWidth/Math.max(120,maxX-minX),canvas.clientHeight/Math.max(120,maxY-minY),2);
    view={scale,x:canvas.clientWidth/2-(minX+maxX)/2*scale,y:canvas.clientHeight/2-(minY+maxY)/2*scale};}
  /** The readouts follow the test pose at once; its picture follows when the engine has drawn it (one at a time, the latest pose last). */
  function render(){scheduled=0;if(disposed)return;
    const g=test.geometry,selected=test.figure.segments[test.selectedJoint];
    jointInput.value=selected.segment_id;const o=test.object,v=o.len_flag?o.lengths[test.selectedJoint]:selected.length,c=selected._stykRig?.connector;
    valueInput.value=Math.round(v*(c?100:1)*1000)/1000;valueInput.min=0;valueInput.max=c?100:1e6;localizedText(label, (c ? "rigTestUi.slide" : "rigTestUi.length"), (c ? {} : {}));
    angleInput.disabled=Boolean(c||selected._stykRig?.angleLock);angleInput.value=Math.round((angleInput.disabled?g.objects.get(0).segments[test.selectedJoint].angle:o.angles[test.selectedJoint])*180/Math.PI*100)/100;
    void paint();
  }
  async function paint(){
    if(drawing){redraw=true;return;}
    drawing=true;
    try{
      do{
        redraw=false;
        const d=window.devicePixelRatio||1,w=Math.round(canvas.clientWidth*d),h=Math.round(canvas.clientHeight*d),at=view;
        if(w<1||h<1)break;
        const picture=await engineDocumentPicture({...test.report,keyframes:[test.evaluatedFrame]},{width:w,height:h,placement:placement.matrix([at.scale*d,0,0,at.scale*d,at.x*d,at.y*d]),background:0});
        if(disposed){picture?.bitmap.close();break;}
        if(canvas.width!==w)canvas.width=w;if(canvas.height!==h)canvas.height=h;
        ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,w,h);
        if(picture){ctx.drawImage(picture.bitmap,0,0);picture.bitmap.close();}
        ctx.setTransform(d,0,0,d,0,0);ctx.translate(at.x,at.y);ctx.scale(at.scale,at.scale);
        const selected=test.figure.segments[test.selectedJoint];
        for(const s of test.geometry.objects.get(0).segments){if(s.seg.aux_code===1&&s.seg.segment_id!==selected.segment_id)continue;const p=s.handle??s.end;ctx.fillStyle=s.seg.segment_id===selected.segment_id?'#0d99ff':'#666';ctx.beginPath();ctx.arc(p.x,p.y,(s.seg.segment_id===selected.segment_id?6:4)/at.scale,0,Math.PI*2);ctx.fill();}
      }while(redraw&&!disposed);
    }catch(error){if(!disposed)status.hidden=false,presentError(status,error);}
    finally{drawing=false;}
  }
  const schedule=()=>{if(!scheduled)scheduled=requestAnimationFrame(render);};
  const point=e=>{const b=canvas.getBoundingClientRect();return {x:(e.clientX-b.left-view.x)/view.scale,y:(e.clientY-b.top-view.y)/view.scale};};
  canvas.addEventListener('pointerdown',guarded(e=>{if(e.button!==0)return;const p=point(e),g=test.geometry.objects.get(0);let best=14/view.scale,id;
    for(const s of g.segments){if(s.seg.aux_code===1)continue;const q=s.handle??s.end,dist=Math.hypot(p.x-q.x,p.y-q.y);if(dist<best){best=dist;id=s.seg.segment_id;}}
    if(id===undefined)return;test.select(object.unique_id,figure.segments.findIndex(s=>s.segment_id===id));test.beginDrag('Test pose');drag=true;canvas.setPointerCapture(e.pointerId);schedule();}),on);
  canvas.addEventListener('pointermove',guarded(e=>{if(!drag)return;const p=point(e);test.poseJoint(p.x,p.y,{stretch:e.ctrlKey||e.metaKey,snap:false});schedule();}),on);
  canvas.addEventListener('pointerup',guarded(()=>{if(drag){test.commitDrag();drag=false;schedule();}}),on);
  canvas.addEventListener('pointercancel',()=>{if(drag){test.cancelDrag();drag=false;schedule();}},on);
  jointInput?.addEventListener('change',guarded(()=>{const index=figure.segments.findIndex(s=>s.segment_id===Number(jointInput.value));if(index<0)throw messageError(new Error(''), "errors.rigTestUi.chooseAnExistingJoint", {});test.select(object.unique_id,index);schedule();}),on);
  valueInput?.addEventListener('change',guarded(()=>{const s=test.figure.segments[test.selectedJoint];if(s._stykRig?.connector)test.setConnectorPosition(valueInput.valueAsNumber/100);else test.updateSegment({length:valueInput.valueAsNumber});fit();schedule();}),on);
  angleInput?.addEventListener('change',guarded(()=>{test.updateSegment({angle_rad:angleInput.valueAsNumber*Math.PI/180});fit();schedule();}),on);
  window.document.getElementById('rig-test-fit').addEventListener('click',()=>{fit();schedule();},on);
  window.document.getElementById('rig-test-reset').addEventListener('click',()=>{test.load(structuredClone(source));test.select(object.unique_id,figure.segments.findIndex(s=>s.segment_id===control));drag=false;fit();schedule();},on);
  window.document.getElementById('rig-test-add')?.addEventListener('click',guarded(()=>{
    test.commitDrag();
    host.addToAnimate(test._shown.figureDocument({figureUid:object.unique_id,tick:test.tick}));
    host.closeDialog();
  }),on);
  const resize=new ResizeObserver(()=>{fit();schedule();});resize.observe(canvas);
  const observer=new MutationObserver(()=>{if(!canvas.isConnected)dispose();});observer.observe(dialog,{childList:true,subtree:true});
  function dispose(){if(disposed)return;disposed=true;events.abort();resize.disconnect();observer.disconnect();cancelAnimationFrame(scheduled);owner.release();if(disposeTest===dispose)disposeTest=null;}
  disposeTest=dispose;dialog.addEventListener('close',dispose,on);fit();render();
  return {editor:test,dispose};
}
export function openRigExamples(host) {
  disposeTest?.();host.finish?.();host.showDialog(interfaceText("rigTestUi.rigExamples"),`<p id="rig-example-status" class="property-note" role="status" hidden></p><div class="rig-example-list">${RIG_EXAMPLES.map(r=>`<article class="rig-example-item"><button class="rig-example-preview" data-rig-preview="${r.id}" aria-label="Try ${esc(r.name)}" ${messageAttributes("rigTestUi.try", {name: {messageKey: exampleNameKeys[r.id]}}, "aria-label")}><canvas width="400" height="280" data-rig-thumbnail="${r.id}"></canvas></button><div class="rig-example-actions"><strong>${messageHTML(exampleNameKeys[r.id])}</strong><button class="button" data-rig-insert="${r.id}" aria-label="Add ${esc(r.name)} to Animate" ${messageAttributes("rigTestUi.addToAnimate2", {name: {messageKey: exampleNameKeys[r.id]}}, "aria-label")}>${icon('plus')}${messageHTML("rigTestUi.add", {})}</button></div></article>`).join('')}</div>`, {titleKey: 'rigTestUi.rigExamples'});
  const root=window.document.getElementById('dialog-content'),dialog=root.closest('dialog'),events=new AbortController(),on={signal:events.signal},queue=[];
  let scheduled=0,disposed=false;
  async function paint(){scheduled=0;if(disposed)return;const canvas=queue.shift();if(!canvas)return;
    try{
      const picture=await engineDocumentPicture(rigExampleDocument(canvas.dataset.rigThumbnail),{width:canvas.width,height:canvas.height,placement:placement.fit(28),background:0});
      if(disposed||!canvas.isConnected){picture?.bitmap.close();return;}
      if(picture){canvas.getContext('2d').drawImage(picture.bitmap,0,0);picture.bitmap.close();}
      canvas.dataset.ready='true';
    }catch(error){if(error?.name!=='AbortError'&&!disposed){const status=root.querySelector('#rig-example-status');status.hidden=false;presentError(status,error);}}
    if(queue.length&&!disposed)scheduled=requestAnimationFrame(paint);
  }
  const visible=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){visible.unobserve(e.target);queue.push(e.target);}if(queue.length&&!scheduled)scheduled=requestAnimationFrame(paint);});
  root.querySelectorAll('[data-rig-thumbnail]').forEach(canvas=>visible.observe(canvas));
  root.addEventListener('click',e=>{
    const preview=e.target.closest('[data-rig-preview]'),insert=e.target.closest('[data-rig-insert]');
    if(preview)openRigTest(host,rigExampleDocument(preview.dataset.rigPreview),{back:()=>openRigExamples(host),galleryPreview:true});
    if(insert){try{host.addToAnimate(rigExampleDocument(insert.dataset.rigInsert));host.closeDialog();}catch(error){const status=root.querySelector('#rig-example-status');status.hidden=false;presentError(status, error);}}
  },on);
  const observer=new MutationObserver(()=>{if(!root.querySelector('.rig-example-list'))dispose();});observer.observe(root,{childList:true});
  function dispose(){if(disposed)return;disposed=true;events.abort();visible.disconnect();observer.disconnect();cancelAnimationFrame(scheduled);queue.length=0;if(disposeTest===dispose)disposeTest=null;}
  disposeTest=dispose;dialog.addEventListener('close',dispose,on);
}
