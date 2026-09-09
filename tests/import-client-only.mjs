/** Isolated file transport timings; deliberately excludes editor/renderer work. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import backend from '../desktop/backend.cjs';
const app=path.dirname(path.dirname(fileURLToPath(import.meta.url))), output=path.join(app,'artifacts/import-client-only');
await mkdir(output,{recursive:true});
const server=await backend.startBackend({appRoot:app});let browser;
try {
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(server.origin+'/api/health');
  await page.evaluate(async()=>{
    const {ImportClient}=await import('/src/import-client.mjs');window.importer=new ImportClient();window.runs=[];window.longTasks=[];
    new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>({at:e.startTime,ms:e.duration})))).observe({type:'longtask'});
    const input=document.createElement('input');input.type='file';input.id='source';document.body.append(input);
    input.onchange=async()=>{
      const start=performance.now();
      try {
        const result=await importer.importFile(input.files[0]);window.retained=result;
        const end=performance.now();runs.push({elapsed:end-start,timings:result.timings,frames:result.document.keyframes.length,
          objects:result.document.keyframes.reduce((n,f)=>n+f.objects.length,0),longTasks:longTasks.filter(t=>t.at>=start&&t.at<=end)});
      } catch(error) {runs.push({error:error.message});}
    };
  });
  for(let i=0;i<2;i++) {
    await page.locator('#source').setInputFiles('C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv');
    await page.waitForFunction(count=>runs.length===count,i+1,{timeout:60000});
    await page.evaluate(()=>document.querySelector('#source').value='');
  }
  const result=await page.evaluate(()=>({runs,health:JSON.parse(document.querySelector('body').firstChild.textContent)})).catch(async()=>({runs:await page.evaluate(()=>runs)}));
  result.health=await page.evaluate(async()=>await(await fetch('/api/health')).json());result.errors=errors;
  for(const run of result.runs) {assert.equal(run.error,undefined);assert.equal(run.frames,1479);assert.equal(run.objects,208373);}
  assert.equal(result.runs[0].timings.cache_hit,false);assert.equal(result.runs[1].timings.cache_hit,true);assert.deepEqual(errors,[]);
  result.method='Fresh local codec and blank Chrome health page, file-input upload through actual ImportClient; no editor, preview worker or GPU renderer. One cold and one warm diagnostic.';
  await writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {await browser?.close();await server.stop();}
