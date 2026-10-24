/** Timeline redraw regression with actual editor commands and DOM mutation checks. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';
import backend from '../desktop/web-host.cjs';

const service=await backend.startDesktopHost({appRoot:process.cwd()});
let browser;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(service.origin);await page.waitForFunction(()=>window.styk?.ready);
  const result=await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const {Editor}=await import('/src/editor.mjs');
    const check=(value,message)=>{if(!value)throw new Error(message);};
    const equal=(a,b,message)=>check(JSON.stringify(a)===JSON.stringify(b),message);
    const settle=async()=>{for(let i=0;i<3;i++)await new Promise(resolve=>requestAnimationFrame(resolve));};
    styk.settingsUI.commit({timelineMode:'advanced'});
    const e=styk.editor,t=styk.timeline,doc=emptyDocument();
    doc.keyframes=[0,80].map(x=>createFrame([createObject(doc.figure_types[0],1,200+x,250)],10));
    e.load(doc);e.sheetSetEasing(['layer-1'],0,10,{interpolation:'linear'});e.seek(5);e.select(1);styk.fit();await settle();
    let paints=0;const paint=t._paint;t._paint=function(...args){paints++;return paint.apply(this,args);};
    const checks=[],keys=()=>e.layerFrameKeys('layer-1').map(k=>k.tick),snapshot=()=>JSON.stringify(e.serialize());
    try{
      const before=snapshot(),history=e.historySize,initialKeys=keys(),grid=t.canvas.toDataURL(),root=e.object.root_x;
      paints=0;e.beginTranslationDrag();
      for(let i=1;i<=8;i++){e.moveSelection(i*3,i,{fromStart:true});await settle();}
      check(e.object.root_x===root+24,'Live pose did not move');
      equal(keys(),initialKeys,'Live pose created an exposure key');
      check(e.historySize===history&&snapshot()===before,'Live pose changed authored document or history');
      check(t.canvas.toDataURL()===grid,'Live pose changed exposure grid pixels');
      check(paints===0,`Live pose repainted an unchanged grid ${paints} times`);
      checks.push('live pose changes canvas geometry without repainting unchanged exposure cells');
      e.commitDrag();await settle();check(paints>0,'Committed pose did not repaint');
      equal(keys(),[0,5,10],'Committed tween edit did not create its key');
      check(t.canvas.toDataURL()!==grid,'Committed key is missing from grid pixels');
      const committed=snapshot();paints=0;e.undo();await settle();
      check(paints>0&&snapshot()===before,'Undo failed to restore authored state and timeline');
      paints=0;e.redo();await settle();check(paints>0&&snapshot()===committed,'Redo failed to restore authored state and timeline');
      checks.push('commit, undo and redo redraw the exact authored keys');

      paints=0;e.beginTranslationDrag();e.moveSelection(11,9,{fromStart:true});await settle();
      check(paints===0,'Second live pose repainted');e.cancelDrag();await settle();
      check(paints>0&&snapshot()===committed,'Cancelled pose changed authored state');
      paints=0;e.beginAnimationEdit({kind:'figure',uid:1},'x');e.previewAnimationEdit(e.object.root_x+30);await settle();
      check(paints===0&&snapshot()===committed,'Sheet property preview changed exposure state');
      e.cancelAnimationEdit();await settle();check(paints>0&&snapshot()===committed,'Property cancellation did not restore state');
      checks.push('pose and sheet property cancellation preserve document and history');

      // Legacy property previews really author keys before commit: retain redraw.
      const legacyDoc=structuredClone(doc);delete legacyDoc._styk.layerSheet;
      const legacy=new Editor({demo:false,propertyChannels:true}).load(legacyDoc);legacy.seek(5);legacy.select(1);
      const events=[];legacy.addEventListener('change',event=>events.push(event.detail));
      legacy.beginAnimationEdit({kind:'figure',uid:1},'x');legacy.previewAnimationEdit(350);
      const event=events.findLast(detail=>detail.live);
      check(event?.animation&&t._changeNeedsPaint(event),'Legacy preview keys lost their redraw');legacy.cancelAnimationEdit();
      for(const flag of ['structural','timing','layers','layerSheet','definition','audio','drawing','vfxClips','camera','motionPath'])
        check(t._changeNeedsPaint({kind:'edit',live:true,[flag]:true}),`${flag} change lost its redraw`);
      checks.push('legacy keys and all timeline-bearing live changes retain redraw');

      // Add frame and Next copy are the shared header's (timeline-header.mjs); the grid tells it what they show.
      const add=document.querySelector('.timeline-toolbar .sheet-add-button'),cel=document.querySelector('.timeline-toolbar .tl-cel'),celMain=cel.querySelector('.tl-cel-main');
      const drawing=e.createDrawingLayer('Ink');await settle();
      check(add.querySelector('.ui-label').textContent==='Blank frame'&&!cel.hidden,'Drawing toolbar did not update');
      e.setLayerLocked(drawing.id,true);await settle();
      check(add.disabled&&celMain.disabled,'Locked drawing toolbar remained enabled');
      e.setLayerLocked(drawing.id,false);e.seek(2);await settle();paints=0;e.addDrawingFrame();await settle();
      check(paints>0&&e.layerFrameKeys(drawing.id).some(key=>key.tick===2),'Drawing exposure did not repaint');
      e.selectSheetLayer('layer-1');e.select(1);await settle();
      check(add.querySelector('.ui-label').textContent==='Add frame'&&add.getAttribute('aria-label')==='Add Frame'&&cel.hidden,'Figure toolbar did not return');
      checks.push('drawing selection, lock and frame insertion update grid and toolbar');

      const clip=e.addVfxClip({kind:'figure',uid:1},'glow',{start:0,duration:12});
      styk.vfx.setVisible(true);e._selectedVfxClip=clip;e._emit('vfx-selection');await settle();
      const vfxBefore=JSON.stringify(e.report._styk.vfxClips),vfxGrid=t.canvas.toDataURL();paints=0;
      e.beginVfxClipEdit();e.setVfxClip(clip,{start:3});await settle();
      check(paints>0&&t.canvas.toDataURL()!==vfxGrid,'Live VFX range did not repaint');
      paints=0;e.cancelVfxClipEdit();await settle();
      check(paints>0&&JSON.stringify(e.report._styk.vfxClips)===vfxBefore,'VFX cancel did not restore its range');
      checks.push('VFX preview and cancellation redraw the visible range');

      const unchanged=new MutationObserver(()=>{});
      for(const node of [add,cel,t.layerSearch,t.clearSearch,t.focusLayersButton,t.newLayerButton,t.labelHead,t.emptyLayers])
        unchanged.observe(node,{attributes:true,childList:true,characterData:true,subtree:true});
      for(let i=0;i<5;i++)t._paint();
      const mutations=unchanged.takeRecords();unchanged.disconnect();
      check(mutations.length===0,`Unchanged toolbar/organization rewrote DOM ${mutations.length} times`);
      t.setLayerFilter('missing');await settle();
      check(!t.emptyLayers.hidden&&!t.clearSearch.hidden&&t.layerSearch.title.startsWith('0 of '),'Filter controls did not update');
      t.setLayerFilter('');await settle();check(t.emptyLayers.hidden&&t.clearSearch.hidden,'Cleared filter controls did not update');
      checks.push('stable paints do not rewrite toolbar DOM; changed filters still update');
      return {checks,errors:[]};
    }finally{t._paint=paint;}
  });
  assert.deepEqual(errors,[]);await mkdir('artifacts/timeline-invalidation',{recursive:true});
  await page.screenshot({path:'artifacts/timeline-invalidation/verified.png'});
  await writeFile('artifacts/timeline-invalidation/report.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}finally{await browser?.close();await service.stop();}
