import {_electron as electron} from '../tests/support/playwright.mjs';
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
const check=(name,value=true)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
let app;
const launch=async()=>{
  app=await electron.launch({args:[root],cwd:root,timeout:45000,env:{...process.env,STYK_USER_DATA_DIR:profile,STYK_LIBRARY_DIR:path.join(profile,'library')}});
  app.process().stderr.on('data',data=>process.stderr.write(data));
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showMessageBox=async()=>({response:1});},file);
  const page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>window.styk?.ready,undefined,{timeout:30000});
  const welcome=page.getByRole('button',{name:'Close welcome screen'});if(await welcome.isVisible())await welcome.click();
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
  await page.locator('[data-draw-preset="blender"]').click();await stroke([{x:cx-100,y:cy-27},{x:cx-100,y:cy+40}]);
  check('the smudge brush drags paint',await alphaAt(cx-100,cy+25)>0);
  await page.keyboard.press('u');await page.evaluate(()=>Object.assign(styk.drawing.settings,{shapeKind:'ellipse',shapeFill:true,color:'#d04020',opacity:1}));
  await stroke([{x:cx+120,y:cy+60},{x:cx+240,y:cy+140}]);await page.waitForFunction(()=>styk.editor.undoLabel==='Fill shape');
  check('a filled ellipse applies',await alphaAt(cx+180,cy+100)===255);
  await page.keyboard.press('l');await page.locator('.drawing-quickbar [data-draw-choice="selectShape"][data-value="rect"]').click();
  await stroke([{x:cx-320,y:cy-30},{x:cx-140,y:cy+30}]);
  await page.locator('details[data-section="Filters"] summary').click();await page.locator('[data-draw-action="filter-blur"]').click();
  await page.waitForFunction(()=>styk.editor.undoLabel==='Blur drawing');
  check('a filter applies to the selection',true);
  await page.keyboard.press('Control+Shift+A');
  // The engine's stage draws every step from live cels and never refuses a frame.
  const refusals=[],shots=process.env.STYK_SMOKE_SHOTS;let shotIndex=0;
  const onStage=async name=>{await page.waitForTimeout(250);const stage=await page.evaluate(()=>{const r=styk.state.renderer,side=r.engineSide;return {refusal:r.engineStats?.refusal??null,float:Boolean(side&&[...side.live.cels.values()].some(cel=>cel.floatShown)),cels:side?JSON.parse(side.stage.live_cel_stats()).cels:0};});if(stage.refusal)refusals.push({name,...stage});if(shots)await page.screenshot({path:path.join(shots,`${String(++shotIndex).padStart(2,'0')}-${name.replace(/[^a-z0-9]+/gi,'-')}.png`)});return stage;};
  const idle=()=>page.waitForFunction(()=>!styk.drawing.gesture&&!styk.drawing.loading&&!styk.drawing.operation);
  await onStage('painting');
  // Erasing, undone and redone.
  const ink=await alphaAt(cx,cy-40);
  await page.keyboard.press('e');await stroke([{x:cx-30,y:cy-70},{x:cx+30,y:cy-10}]);await onStage('erasing');
  check('the eraser clears ink',ink>0&&await alphaAt(cx,cy-40)<ink);
  await page.evaluate(()=>styk.editor.undo());await idle();check('undo restores the erased ink',await alphaAt(cx,cy-40)===ink);
  await page.evaluate(()=>styk.editor.redo());await idle();check('redo erases it again',await alphaAt(cx,cy-40)<ink);
  // A fill that samples all layers stops at the artwork of the other layers; one that does not goes under it.
  const blue=()=>page.evaluate(()=>{const d=styk.drawing,t=styk.editor.drawingTarget(),store=d.owner.entry(t.figure).store,b=d.fillBounds(t,store),px=store.readRect(b.x,b.y,b.width,b.height);let n=0;for(let i=0;i<px.length;i+=4)if(px[i]===32&&px[i+1]===96&&px[i+2]===208&&px[i+3]===255)n++;return n;});
  await page.keyboard.press('g');
  const fillAt=async sampleAll=>{await page.evaluate(sampleAll=>Object.assign(styk.drawing.settings,{sampleAll,color:'#2060d0',opacity:1,tolerance:.1,expansion:0,gap:0}),sampleAll);await page.mouse.click(cx-250,cy+110);await page.waitForFunction(()=>styk.editor.undoLabel==='Fill drawing');await idle();await onStage(sampleAll?'fill sampling all layers':'fill');const area=await blue();await page.evaluate(()=>styk.editor.undo());await idle();return area;};
  const own=await fillAt(false),all=await fillAt(true);
  check('a fill that samples all layers stops at the artwork of other layers',own>100000&&all>0&&all<own-1000);
  // The wand selects the ellipse; moving the selection shows it on the stage and applying it puts the pixels there.
  await page.keyboard.press('l');await page.evaluate(()=>Object.assign(styk.drawing.settings,{selectShape:'wand',sampleAll:false,tolerance:.1,gap:0}));
  await page.mouse.click(cx+180,cy+100);
  check('the wand floats the filled ellipse',await page.waitForFunction(()=>styk.drawing.selection&&!styk.drawing.operation,undefined,{timeout:20000}).then(()=>true,()=>false));
  await page.mouse.move(cx+180,cy+100);await page.mouse.down();await page.mouse.move(cx+60,cy+130,{steps:8});
  check('the stage draws the floating selection',(await onStage('moving the selection')).float);
  await page.mouse.up();await idle();
  await page.keyboard.press('Enter');await page.waitForFunction(()=>styk.editor.undoLabel==='Transform selected pixels');await idle();await onStage('applying the selection');
  check('the moved selection lands where it was dropped',await alphaAt(cx+60,cy+130)===255&&await alphaAt(cx+180,cy+100)===0);
  await page.evaluate(()=>styk.editor.undo());await idle();check('undo puts the selection back',await alphaAt(cx+180,cy+100)===255&&await alphaAt(cx+60,cy+130)===0);
  await page.evaluate(()=>styk.editor.redo());await idle();check('redo moves it again',await alphaAt(cx+60,cy+130)===255);
  await onStage('redo');
  // Second frame with its own drawing.
  await page.locator('[data-tool="drawing-brush"]').click();await page.locator('[data-draw-preset="ink"]').click();await page.evaluate(()=>styk.drawing.action('next-blank'));await page.waitForTimeout(200);
  await stroke([{x:cx-200,y:cy-150},{x:cx+200,y:cy+150}]);
  await onStage('the first stroke of a new frame');
  // A turned and mirrored view: strokes, an erase and its undo are drawn by the stage in the right place.
  await page.evaluate(()=>{styk.drawing.propertySet('draw-viewAngle',35);styk.drawing.action('flip-view');});await page.waitForTimeout(300);
  check('the Draw view is turned and mirrored',await page.evaluate(()=>Math.abs(styk.state.view.rotation-35*Math.PI/180)<1e-6&&styk.state.view.flip===true));
  // What the cel holds under a point of the turned view (the stage's picture of each step is kept with STYK_SMOKE_SHOTS).
  const quiet=await alphaAt(cx-300,cy+200);
  await page.locator('[data-tool="drawing-brush"]').click();await page.locator('[data-draw-preset="ink"]').click();
  // The V's arms (the previous frame's stroke crosses its vertex in this view).
  const arms=()=>Promise.all([alphaAt(cx-30,cy+75),alphaAt(cx+30,cy+75)]),inkBefore=await arms();
  await stroke([{x:cx-60,y:cy+60},{x:cx,y:cy+90},{x:cx+60,y:cy+60}]);await onStage('painting on a turned view');
  check('a stroke on a turned and mirrored view lands where it was drawn',inkBefore.every(a=>a===0)&&(await arms()).every(a=>a>0));
  check('and nowhere else',(await alphaAt(cx-300,cy+200))===quiet);
  await page.keyboard.press('e');await stroke([{x:cx-30,y:cy+60},{x:cx+30,y:cy+100}]);await onStage('erasing on a turned view');
  check('the eraser clears ink on a turned view',(await alphaAt(cx,cy+80))===0);
  await page.evaluate(()=>styk.editor.undo());await idle();await onStage('undo on a turned view');
  check('undo on a turned view restores the ink',(await alphaAt(cx,cy+80))>0);
  await page.evaluate(()=>styk.editor.redo());await idle();await onStage('redo on a turned view');
  check('redo on a turned view erases it again',(await alphaAt(cx,cy+80))===0);
  await page.evaluate(()=>{styk.drawing.action('reset-rotation');styk.drawing.action('flip-view');});await page.waitForTimeout(300);
  check('the engine stage drew every step without refusing a frame',refusals.length===0);
  const before=await snapshot(page);
  check('two cels hold artwork',before.length>=2&&before.every(c=>c.bounds));
  await page.keyboard.press('Control+s');
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
