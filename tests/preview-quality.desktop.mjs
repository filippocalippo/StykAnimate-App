import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
const root=path.resolve('.'), output=path.join(root,'artifacts/preview-quality');
await mkdir(output,{recursive:true});
const env={...process.env,STYK_USER_DATA_DIR:path.join(output,`profile-${Date.now()}`)};
await mkdir(env.STYK_USER_DATA_DIR,{recursive:true});
await writeFile(path.join(env.STYK_USER_DATA_DIR,'telemetry-state.json'),JSON.stringify({decided:true,consent:{analytics:false,diagnostics:false,policyVersion:'2026-09-10',updatedAt:Date.now()}}));
delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[root],cwd:root,timeout:45000,env});
try {
  const page=await app.firstWindow(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>window.styk?.ready,undefined,{timeout:30000});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
  await page.evaluate(async()=>{
    for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const report=emptyDocument(),figure=report.figure_types[0];
    report.keyframes=Array.from({length:1200},(_,i)=>createFrame([createObject(figure,1,300+i%50,230)]));
    styk.editor.load(report,'Quality governor test');styk.editor.setFPS(60);styk.editor.markSaved();
    styk.fit();styk.state.loop=true;styk.state.settings.playbackQuality='auto';
    const r=styk.state.renderer,render=r.renderPrepared.bind(r),live=r.render.bind(r);
    window.qualityProbe={delay:40,ticks:[],levels:[],lastLevel:null};
    const presented=()=>{
      if(styk.state.playing){
        if(qualityProbe.ticks.at(-1)!==styk.editor.tick)qualityProbe.ticks.push(styk.editor.tick);
        const index=styk.state.previewGovernor.index;
        if(index!==qualityProbe.lastLevel){qualityProbe.levels.push({index,at:performance.now()});qualityProbe.lastLevel=index;}
      }
    };
    r.render=(...args)=>{const value=live(...args);presented();return value;};
    r.renderPrepared=(...args)=>{
      const end=performance.now()+qualityProbe.delay;
      while(performance.now()<end) { /* Deterministic presentation pressure. */ }
      const ok=render(...args);
      if(ok)presented();
      return ok;
    };
    styk.actions.play();
  });
  await page.waitForFunction(()=>styk.state.previewGovernor.index===2&&!styk.state.renderer.stats.multisampled,undefined,{timeout:20000});
  await page.screenshot({path:path.join(output,'reduced.png')});
  await page.evaluate(()=>qualityProbe.delay=0);
  await page.waitForFunction(()=>styk.state.previewGovernor.index===0&&styk.state.renderer.stats.multisampled,undefined,{timeout:25000});
  await page.evaluate(()=>styk.actions.play());
  await page.waitForFunction(()=>!styk.state.playing&&!styk.state.dirtyRender);
  const result=await page.evaluate(()=>({levels:qualityProbe.levels,ticks:qualityProbe.ticks,msaa:styk.state.renderer.stats.multisampled?4:1,
    warnings:styk.state.renderer.stats.warnings,renderer:styk.state.renderer.stats.backend,history:styk.editor._undo.length}));
  await writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));
  assert.deepEqual(result.levels.map(row=>row.index),[0,1,2,1,0]);
  assert.ok(result.ticks.length>100);
  for(let i=1;i<result.ticks.length;i++)assert.equal(result.ticks[i],(result.ticks[i-1]+1)%1200,'Every animation tick is presented');
  assert.equal(result.msaa,4);assert.deepEqual(result.warnings,[]);assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,'restored.png')});
  await writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,ticks:result.ticks.length},null,2));
} finally {await app.close();}
