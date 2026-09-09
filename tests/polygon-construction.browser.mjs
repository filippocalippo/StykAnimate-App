/** Actual polygon draft construction, curved overlay and native file round trips. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import backend from '../desktop/backend.cjs';
const output=path.resolve('artifacts/polygon-construction');await mkdir(output,{recursive:true});
const service=await backend.startBackend({appRoot:process.cwd()});let browser,page;
const checks=[],errors=[],check=(name,ok)=>{assert.ok(ok,name);checks.push(name);console.log('PASS',name);};
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.setDefaultTimeout(10000);
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(service.origin);await page.waitForFunction(()=>window.styk?.ready);
 await page.evaluate(async()=>{const {polygonConstructionFixture}=await import('/tests/polygon-construction-fixture.mjs');const report=polygonConstructionFixture();report.keyframes.push(structuredClone(report.keyframes[0]));styk.editor.load(report,'Bent polygon');styk.editor.select(1);styk.fit();});
 const exportFile=async(format,name)=>{
  await page.locator('.titlebar [data-action="export"]').click();const pending=page.waitForEvent('download');
  await page.locator(`#dialog [data-action="export-${format}"]`).click();const file=await pending,target=path.join(output,name);await file.saveAs(target);await page.waitForFunction(()=>!document.querySelector('#dialog').open);return target;
 };
 const source=await exportFile('piv','before.piv');
 await page.locator('#file-input').setInputFiles(source);await page.waitForFunction(()=>styk.editor.report.source?.endsWith?.('before.piv')||styk.editor.name==='before');
 await page.evaluate(async()=>{styk.editor.select(styk.editor.frame.objects[0].unique_id);styk.fit();styk.editor.updateFigureStyle({name:'Existing native edit'});styk.editor.markSaved();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  window.polygonBaseline={undo:styk.editor._undo.length,redo:styk.editor._redo.length,report:JSON.stringify(styk.editor.report),revision:styk.editor.revision};
  const ctx=document.querySelector('#overlay').getContext('2d'),original={};let path=[];window.polygonPaths=[];window.openArcFills=0;window.openArcCloses=0;
  for(const key of ['beginPath','moveTo','lineTo','stroke','fill','closePath'])original[key]=ctx[key].bind(ctx);
  ctx.beginPath=function(){path=[];return original.beginPath();};
  ctx.moveTo=function(x,y){path.push({x,y});return original.moveTo(x,y);};
  ctx.lineTo=function(x,y){path.push({x,y});return original.lineTo(x,y);};
  ctx.fill=function(...args){if(styk.state.polygon?.handles.length===2&&path.length>2)window.openArcFills++;return original.fill(...args);};
  ctx.closePath=function(){if(styk.state.polygon?.handles.length===2&&path.length>2)window.openArcCloses++;return original.closePath();};
  ctx.stroke=function(){if(this.strokeStyle==='#0d99ff'&&this.lineWidth===2&&path.length>3)window.polygonPaths.push(path.slice());return original.stroke();};
 });
 const stable=()=>page.evaluate(()=>{const e=styk.editor,b=window.polygonBaseline;return e._undo.length===b.undo&&e._redo.length===b.redo&&JSON.stringify(e.report)===b.report&&e.revision===b.revision;});
 const handles=()=>page.evaluate(()=>styk.state.polygon?.handles??null);
 const click=async(id,ctrl=false)=>{
  const p=await page.evaluate(async id=>{const {worldToScreen}=await import('/src/renderer.mjs');const e=styk.editor,g=e.geometry.objects.get(e.selectedSlot),r=document.querySelector('#viewport').getBoundingClientRect(),p=worldToScreen(g.joints.get(id),{report:e.report,frame:e.frame,view:styk.state.view});return{x:r.x+p.x,y:r.y+p.y};},id);
  if(ctrl)await page.keyboard.down('Control');try{await page.mouse.click(p.x,p.y);}finally{if(ctrl)await page.keyboard.up('Control');}
 };
 const start=()=>page.locator('[data-tool="polygon"]').click();
 await start();await click(0);await click(1);await page.waitForFunction(()=>window.polygonPaths.some(p=>p.length>10));
 check('a two-joint bent draft stays open and unfilled',await page.evaluate(()=>window.openArcFills===0&&window.openArcCloses===0));await page.keyboard.press('Control+z');await click(3,true);
 check('Ctrl click follows the shortest native segment chain',JSON.stringify(await handles())==='[0,1,2,3]');
 check('draft connections leave native document and history untouched',await stable());
 for(const key of ['Delete','Backspace','Control+d','F6','Space']){await page.keyboard.press(key);check(key+' cannot mutate the document during polygon construction',JSON.stringify(await handles())==='[0,1,2,3]'&&await stable());}
 for(const action of ['delete','play']){const button=page.locator(`[data-action="${action}"]:visible`).first();if(await button.isEnabled())await button.click();check(action+' toolbar action cannot mutate an active polygon draft',JSON.stringify(await handles())==='[0,1,2,3]'&&await stable());}
 await page.keyboard.press('Control+z');check('one draft Undo removes the complete Ctrl connection group',JSON.stringify(await handles())==='[0]');
 await page.keyboard.press('Enter');check('Enter cannot commit fewer than three joints',JSON.stringify(await handles())==='[0]'&&await stable());
 await page.keyboard.press('Control+z');await page.keyboard.press('Control+z');
 check('empty draft Undo never falls through to existing document history',JSON.stringify(await handles())==='[]'&&await stable());
 await page.keyboard.press('Control+y');await page.keyboard.press('Control+Shift+z');
 check('both redo shortcuts restore the grouped draft',JSON.stringify(await handles())==='[0,1,2,3]'&&await stable());
 await page.waitForFunction(()=>window.polygonPaths.some(p=>p.length>10));
 const preview=await page.evaluate(async()=>{const {polygonPreviewPoints}=await import('/src/polygon-preview.mjs'),{worldToScreen}=await import('/src/renderer.mjs');const e=styk.editor,g=e.geometry.objects.get(e.selectedSlot);const expected=polygonPreviewPoints(g,styk.state.polygon.handles).map(p=>worldToScreen(p,{report:e.report,frame:e.frame,view:styk.state.view}));const exact=window.polygonPaths.find(p=>JSON.stringify(p)===JSON.stringify(expected));window.curvedDraftPath=polygonPreviewPoints(g,styk.state.polygon.handles);return{exact:Boolean(exact),count:expected.length};});
 check('actual overlay follows every evaluated bent edge sample',preview.exact&&preview.count>10);
 const markerPixels=await page.evaluate(async()=>{const {worldToScreen}=await import('/src/renderer.mjs');const e=styk.editor,g=e.geometry.objects.get(e.selectedSlot),canvas=document.querySelector('#overlay'),ctx=canvas.getContext('2d'),ratio=canvas.width/canvas.clientWidth;return[0,1].map(id=>{const p=worldToScreen(g.joints.get(id),{report:e.report,frame:e.frame,view:styk.state.view});return [...ctx.getImageData(Math.round(p.x*ratio),Math.round(p.y*ratio),1,1).data];});});
 check('construction uses a black start dot and Pivot-red selected joints',markerPixels[0].slice(0,3).every(n=>n===0)&&markerPixels[1][0]===255&&markerPixels[1][1]===0&&markerPixels[1][2]===0&&markerPixels.every(p=>p[3]===255));
 await page.screenshot({path:path.join(output,'curved-draft.png')});
 await click(0);
 check('clicking the first joint closes and commits exactly one polygon history item',await page.evaluate(()=>!styk.state.polygon&&styk.editor.figure.polyfills.length===1&&styk.editor._undo.length===window.polygonBaseline.undo+1));
 check('final polygon is exactly the previewed curved boundary',await page.evaluate(()=>JSON.stringify(styk.editor.geometry.objects.get(styk.editor.selectedSlot).polys[0].points)===JSON.stringify(window.curvedDraftPath)));
 await page.screenshot({path:path.join(output,'curved-committed.png')});
 await page.keyboard.press('Control+z');check('one document Undo removes the whole committed polygon',await page.evaluate(()=>styk.editor.figure.polyfills.length===0&&styk.editor._undo.length===window.polygonBaseline.undo));
 await page.keyboard.press('Control+y');check('document Redo restores the committed polygon',await page.evaluate(()=>styk.editor.figure.polyfills.length===1));
 const duplicateBefore=await page.evaluate(()=>({report:JSON.stringify(styk.editor.report),history:styk.editor._undo.length}));
 await start();await click(3);await click(0,true);await click(3);
 check('a reversed duplicate connection set is rejected without a history item',await page.evaluate(b=>styk.editor.figure.polyfills.length===1&&JSON.stringify(styk.editor.report)===b.report&&styk.editor._undo.length===b.history,duplicateBefore));
 await page.keyboard.press('Escape');await page.locator('[data-tool="select"]').click();
 await start();for(const id of [0,2,1,3])await click(id);await page.keyboard.press('Enter');
 check('the same vertices in a different edge cycle are allowed',await page.evaluate(()=>styk.editor.figure.polyfills.length===2&&styk.editor.figure.polyfills[1].segment_ids.join(',')==='0,2,1,3'));
 await page.keyboard.press('Control+z');check('undo of the different cycle preserves the original polygon',await page.evaluate(()=>styk.editor.figure.polyfills.length===1&&styk.editor._undo.length===window.polygonBaseline.undo+1));
 const exported={};for(const format of ['piv','stk'])exported[format]=await exportFile(format,`curved.${format}`);
 for(const format of ['piv','stk']){
  const bytes=[...await readFile(exported[format])];
  const decoded=await page.evaluate(async({bytes,format})=>{const response=await fetch(`/api/import?filename=curved.${format}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Uint8Array.from(bytes)});if(!response.ok)throw new Error(await response.text());const report=(await response.json()).document;const f=report.figure_types.find(f=>f.polyfills?.length);return{handles:f.polyfills[0].segment_ids,bend:f.segments.find(s=>s.segment_id===1).bend_rad,polyCount:f.polyfills.length};},{bytes,format});
  check(`actual ${format.toUpperCase()} save/reopen retains connections and curved segment`,JSON.stringify(decoded.handles)==='[0,1,2,3]'&&decoded.polyCount===1&&Math.abs(decoded.bend-Math.PI/2)<1e-6);
 }
 await page.keyboard.press('Control+z');
 await start();await click(0);await click(2);await click(5);await page.keyboard.press('Enter');
 check('Enter commits a direct three-joint polygon as one command',await page.evaluate(()=>!styk.state.polygon&&styk.editor.figure.polyfills[0].segment_ids.join(',')==='0,2,5'&&styk.editor._undo.length===window.polygonBaseline.undo+1));
 await page.keyboard.press('Control+z');
 await start();await click(0);await click(3,true);await start();
 check('clicking the active Polygon tool finishes the valid draft',await page.evaluate(()=>!styk.state.polygon&&styk.editor.figure.polyfills[0].segment_ids.join(',')==='0,1,2,3'&&styk.editor._undo.length===window.polygonBaseline.undo+1));
 await page.keyboard.press('Control+z');
 await page.evaluate(()=>window.cancelBaseline={report:JSON.stringify(styk.editor.report),undo:styk.editor._undo.length,redo:styk.editor._redo.length});
 const cancelled=()=>page.evaluate(()=>!styk.state.polygon&&JSON.stringify(styk.editor.report)===window.cancelBaseline.report&&styk.editor._undo.length===window.cancelBaseline.undo&&styk.editor._redo.length===window.cancelBaseline.redo);
 await start();await click(0);await click(3,true);await page.keyboard.press('Escape');check('Escape discards draft and preserves existing document Redo',await cancelled());
 await start();await click(0);await click(3,true);await page.locator('[data-tool="hand"]').click();check('changing tool discards draft without a document command',await cancelled());
 await start();await click(0);await click(3,true);await page.locator('[data-action="cancel-polygon"]').click();check('Cancel button discards only the draft',await cancelled());
 await start();await click(0);await click(3,true);const fps=page.locator('#fps');if(await fps.isEnabled())await fps.focus();
 check('timing input is disabled or leaves construction before editing',await fps.isDisabled()?JSON.stringify(await handles())==='[0,1,2,3]':await cancelled());await page.keyboard.press('Escape');
 await start();await click(0);await click(3,true);await page.locator('[data-action="first-frame"]:visible').click();check('seeking a stored frame cancels the draft without changing document history',await cancelled());
 await start();await click(0);await click(3,true);
 await page.evaluate(()=>styk.editor.markSaved());
 await page.locator('#file-input').setInputFiles(exported.piv);await page.waitForFunction(()=>styk.editor.name==='curved');
 check('opening a PIV replaces the document and clears the pending construction',await page.evaluate(()=>!styk.state.polygon&&styk.editor._undo.length===0&&styk.editor.report.figure_types.some(f=>f.polyfills?.length===1)));
 await page.locator('#file-input').setInputFiles(exported.stk);await page.waitForFunction(()=>styk.editor.frame.objects.length===2);
 check('actual STK file-picker import reopens the saved polygon figure',await page.evaluate(()=>styk.editor.figure.polyfills.length===1&&styk.editor.figure.polyfills[0].segment_ids.join(',')==='0,1,2,3'));
 check('no uncaught application errors',errors.length===0);
 await writeFile(path.join(output,'report.json'),JSON.stringify({checks,preview,markerPixels,errors},null,2));console.log(JSON.stringify({checks:checks.length,errors}));
}catch(error){await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});await writeFile(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser?.close();await service.stop();}
