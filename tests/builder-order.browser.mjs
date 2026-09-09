import {chromium} from 'playwright';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import backendService from '../desktop/backend.cjs';
const root=path.resolve(import.meta.dirname,'..'),output=path.join(root,'artifacts','builder-order');
await mkdir(output,{recursive:true});
const backend=await backendService.startBackend({appRoot:root});let browser;
const checks=[],check=(value,label)=>{assert.ok(value,label);checks.push(label);};
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1100,height:850},acceptDownloads:true}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(backend.origin);await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {emptyDocument,defaultFigure}=await import('/src/demo.mjs');
    const {builderDrawables}=await import('/src/editor-builder-style.mjs');
    const e=window.styk.editor;e.load(emptyDocument());const f=defaultFigure(201);f.name='Order fixture';
    f.segments=f.segments.slice(0,4).map((s,i)=>({...s,segment_id:[11,22,33,44][i],parent_id:[0,11,22,0][i],z_order:[1,3,5,6][i]}));f.segment_count=4;
    f.polyfills=[{polyfill_id:1,segment_ids:[0,11,22],segment_ids_raw:[0,11,22],color_rgb:[20,80,200],alpha_raw:0,color_alpha:1,z_order:2},
      {polyfill_id:2,segment_ids:[0,22,44],segment_ids_raw:[0,22,44],color_rgb:[220,80,20],alpha_raw:0,color_alpha:1,z_order:4}];
    e.importFigure(f);e.select(e.selectedUid,1);e.markSaved();
    window.__builderOrder=()=>builderDrawables(e.figure).map(x=>`${x.kind==='segment'?'s':'p'}${x.index}`);
    window.__builderFrame=e.frame;window.__builderObjects=e.frame.objects;window.__builderBeforeHistory=e._undo.length;
  });
  await page.locator('[data-tool="rig"]').click();
  await page.locator('input[data-property="segment_z_order"]').waitFor();
  check(await page.locator('[data-action="add-sprite-segment"]').isVisible(),'Rig inspector exposes Add sprite part');
  const set=async(key,value)=>{const input=page.locator(`input[data-property="${key}"]`);await input.fill(String(value));await input.press('Enter');};
  await page.locator('#builder-branch').check();await set('segment_z_order',4);
  await page.waitForFunction(()=>window.__builderOrder().join(',')==='s0,p0,p1,s1,s3,s2');
  check(true,'Numeric branch order preserves native relative offsets');
  check(await page.locator('#builder-branch').isChecked(),'Branch preference survives inspector refresh');
  await page.locator('#viewport').click({position:{x:20,y:20}});await page.keyboard.press('Control+z');
  await page.waitForFunction(()=>window.__builderOrder().join(',')==='s0,p0,s1,p1,s2,s3');
  check(true,'One undo restores the complete mixed order');
  await page.evaluate(()=>window.styk.editor.select(window.styk.editor.frame.objects[0].unique_id,1));
  await page.locator('#builder-branch').uncheck();
  await page.locator('[data-action="builder-order"][data-kind="segment"][data-direction="front"]').click();
  await page.waitForFunction(()=>window.__builderOrder().at(-1)==='s1');check(true,'Visible segment front button changes internal order');
  const detail=page.locator('.polygon-style-details[data-polygon-index="0"]');
  await detail.locator('summary').click();await set('polygon_0_opacity',40);
  await page.waitForFunction(()=>window.styk.editor.figure.polyfills[0].alpha_raw===153);
  check(await detail.evaluate(el=>el.open),'Polygon section remains open after committing opacity');
  const alphaHistory=await page.evaluate(()=>window.styk.editor._undo.length);
  const scrub=detail.locator('[data-property-row="polygon_0_opacity"] [data-property-scrub]');
  const box=await scrub.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+18,box.y+box.height/2);await page.keyboard.press('Escape');await page.mouse.up();
  check(await page.evaluate(n=>window.styk.editor.figure.polyfills[0].alpha_raw===153&&window.styk.editor._undo.length===n,alphaHistory),'Escape cancels the live polygon opacity scrub without history');
  await detail.locator('[data-action="builder-order"][data-direction="front"]').click();
  await page.waitForFunction(()=>window.__builderOrder().at(-1)==='p0');check(true,'Visible polygon front button changes internal order');
  check(await page.evaluate(()=>window.styk.editor.frame===window.__builderFrame&&window.styk.editor.frame.objects===window.__builderObjects),'Definition styles retain source frame and pose array references');
  check(await page.evaluate(()=>window.styk.editor._undo.slice(window.__builderBeforeHistory).every(c=>c.kind==='native-properties'&&c.definition)),'Every completed style action uses one sparse definition history command');
  await page.screenshot({path:path.join(output,'inspector.png')});
  for(const format of ['piv','stk']){
    await page.locator('[data-action="export"]').click();
    const event=page.waitForEvent('download');await page.locator(`[data-action="export-${format}"]`).click();
    const download=await event,filename=path.join(output,`builder-order.${format}`);await download.saveAs(filename);
    const bytes=[...await readFile(filename)];
    const result=await page.evaluate(async({bytes,format})=>{
      const response=await fetch(`/api/import?filename=builder-order.${format}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:new Uint8Array(bytes)});
      if(!response.ok)throw new Error(await response.text());const report=(await response.json()).document;
      const figure=report.figure_types.find(f=>f.polyfills?.length===2),{builderDrawables}=await import('/src/editor-builder-style.mjs');
      return {order:builderDrawables(figure).map(x=>`${x.kind==='segment'?'s':'p'}${x.index}`),alpha:figure.polyfills[0].alpha_raw};
    },{bytes,format});
    check(result.order.join(',')===(await page.evaluate(()=>window.__builderOrder().join(',')))&&result.alpha===153,`Actual ${format.toUpperCase()} Export/reopen retains order and opacity`);
    if(await page.locator('dialog[open]').count())await page.locator('[data-action="close-dialog"]').click();
  }
  check(errors.length===0,'No application exceptions');
  await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks:checks.length,errors}));
}finally{await browser?.close();await backend.stop();}
