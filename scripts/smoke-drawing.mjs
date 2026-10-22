import {_electron as electron, closeStartupPrompts} from '../tests/support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
// Desktop drawing smoke: paint with real input in the Electron app (brush,
// smudge, shapes, gradient, selection + filter), save natively, restart the
// process, reopen the file and compare every cel pixel-for-pixel.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'artifacts','drawing-desktop'),profile=path.join(output,`profile-${Date.now()}`),file=path.join(output,`drawing-${Date.now()}.styk`);
await mkdir(profile,{recursive:true});
await writeFile(path.join(profile,'telemetry-state.json'),JSON.stringify({decided:true,consent:{analytics:false,diagnostics:false,policyVersion:'2026-09-10',updatedAt:Date.now()}}));
const checks=[],errors=[];
// Mod is Command on macOS.
const mod=process.platform==='darwin'?'Meta':'Control';
const check=(name,value=true)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
let app;
const launch=async()=>{
  app=await electron.launch({args:[root],cwd:root,timeout:45000,env:{...process.env,STYK_USER_DATA_DIR:profile,STYK_LIBRARY_DIR:path.join(profile,'library')}});
  app.process().stderr.on('data',data=>process.stderr.write(data));
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showMessageBox=async()=>({response:1});},file);
  const page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>window.styk?.ready,undefined,{timeout:30000});
  await closeStartupPrompts(page);
  return page;
};
const snapshot=page=>page.evaluate(async()=>{
  const e=styk.editor,d=styk.drawing,out=[];await d.barrier();
  for(const figure of e.report.figure_types){const meta=figure._styk?.drawing;if(!meta)continue;const entry=await d.owner.surface(figure),b=entry.store.bounds;
    let hash=0;if(b){const px=entry.store.readRect(b.x,b.y,b.width,b.height);for(let i=0;i<px.length;i++)hash=(Math.imul(hash,31)+px[i])|0;}
    out.push({cel:meta.celId,bounds:b,hash});}
  return out.sort((a,b)=>a.cel<b.cel?-1:1);
});
try{
  let page=await launch();
  await page.evaluate(()=>{styk.state.settings.autosaveSeconds=0;});
  await page.locator('[data-workspace-mode="draw"]').click();await page.locator('[data-draw-action="new"]').first().click();
  const box=await page.locator('#viewport').boundingBox(),cx=box.x+box.width/2,cy=box.y+box.height/2;
  const stroke=async points=>{await page.mouse.move(points[0].x,points[0].y);await page.mouse.down();for(const p of points.slice(1))await page.mouse.move(p.x,p.y,{steps:5});await page.mouse.up();await page.waitForFunction(()=>!styk.drawing.gesture&&!styk.drawing.loading);};
  const alphaAt=(x,y)=>page.evaluate(({x,y})=>{const d=styk.drawing,t=styk.editor.drawingTarget();if(!t.figure)return 0;const p=d.pixel({clientX:x,clientY:y},t);return d.owner.entry(t.figure).store.pixel(Math.floor(p.x),Math.floor(p.y))[3];},{x,y});
  // Brush strokes through real pointer input.
  await page.locator('[data-tool="drawing-brush"]').click();await page.locator('[data-draw-preset="ink"]').click();
  await stroke([{x:cx-300,y:cy},{x:cx,y:cy-40},{x:cx+300,y:cy}]);
  check('a brush stroke paints in the desktop app',await alphaAt(cx,cy-40)===255||await alphaAt(cx,cy-38)===255);
  // Smudge from the stroke's edge into blank canvas found by reading pixels: the stroke's width on
  // screen follows the canvas zoom, which follows the window size.
  const lineY=cy-40*200/300;let edge=lineY;while(await alphaAt(cx-100,edge)>0&&edge<lineY+120)edge++;
  check('the smudge starts at the edge of the paint',await alphaAt(cx-100,edge-2)>0&&await alphaAt(cx-100,edge+3)===0);
  await page.locator('[data-draw-preset="blender"]').click();await stroke([{x:cx-100,y:edge-2},{x:cx-100,y:edge+40}]);
  check('the smudge brush drags paint',await alphaAt(cx-100,edge+3)>0);
  await page.keyboard.press('u');await page.evaluate(()=>Object.assign(styk.drawing.settings,{shapeKind:'ellipse',shapeFill:true,color:'#d04020',opacity:1}));
  await stroke([{x:cx+120,y:cy+60},{x:cx+240,y:cy+140}]);await page.waitForFunction(()=>styk.editor.undoLabel==='Fill shape');
  check('a filled ellipse applies',await alphaAt(cx+180,cy+100)===255);
  await page.keyboard.press('l');await page.locator('.drawing-quickbar [data-draw-choice="selectShape"][data-value="rect"]').click();
  await stroke([{x:cx-320,y:cy-30},{x:cx-140,y:cy+30}]);
  await page.locator('details[data-section="Filters"] summary').click();await page.locator('[data-draw-action="filter-blur"]').click();
  await page.waitForFunction(()=>styk.editor.undoLabel==='Blur drawing');
  check('a filter applies to the selection',true);
  await page.keyboard.press(`${mod}+Shift+A`);
  // Second frame with its own drawing.
  await page.locator('[data-tool="drawing-brush"]').click();await page.locator('[data-draw-preset="ink"]').click();await page.evaluate(()=>styk.drawing.action('next-blank'));await page.waitForTimeout(200);
  await stroke([{x:cx-200,y:cy-150},{x:cx+200,y:cy+150}]);
  const before=await snapshot(page);
  check('two cels hold artwork',before.length>=2&&before.every(c=>c.bounds));
  await page.keyboard.press(`${mod}+s`);
  await page.waitForFunction(()=>!styk.editor.dirty,undefined,{timeout:30000});
  check('the drawing saves natively');
  await page.evaluate(async()=>{styk.editor.markSaved();await stykDesktop.setDocumentState({name:styk.editor.name,dirty:false});}).catch(()=>{});
  await app.close();
  page=await launch();
  await page.evaluate(()=>styk.actions.open());
  await page.waitForFunction(()=>styk.editor.report.figure_types.some(f=>f._styk?.drawing),undefined,{timeout:30000});
  const after=await snapshot(page);
  check('every cel reopens pixel-identical after a process restart',JSON.stringify(after)===JSON.stringify(before));
  check('no uncaught renderer errors',errors.length===0);
  await writeFile(path.join(output,'drawing-desktop.json'),JSON.stringify({checks,errors,cels:after.length},null,2));
}catch(error){await writeFile(path.join(output,'failure.json'),JSON.stringify({message:error.message,checks,errors},null,2)).catch(()=>{});throw error;}
finally{
  // A stalled close must not hang the run.
  if(app){const proc=app.process();await Promise.race([app.close().catch(()=>{}),new Promise(r=>setTimeout(r,10000))]);if(proc.exitCode===null)proc.kill();}
}
