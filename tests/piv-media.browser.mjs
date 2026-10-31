/** Verify real file input, worker decoding, editor publication and visible media.
 * node tests/piv-media.browser.mjs path/to/animation.piv [...]
 */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from './support/playwright.mjs';
import backendTools from '../desktop/web-host.cjs';

assert.ok(process.argv.length>2,'Supply one or more local PIV fixtures');
const out=path.resolve('artifacts/piv-media');await mkdir(out,{recursive:true});
const backend=await backendTools.startDesktopHost({appRoot:process.cwd()});let browser;
try {
  browser=await chromium.launch({channel:'chrome',headless:true});
  const results=[];
  for(const source of process.argv.slice(2)) {
    const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(backend.origin);await page.waitForFunction(()=>window.styk?.ready);
    const name=path.basename(source,'.piv'),start=Date.now();
    console.log('IMPORT',name);
    await page.locator('#file-input').setInputFiles(path.resolve(source));
    await page.waitForFunction(name=>(!styk.state.importing&&styk.editor.name===name)||
      document.querySelector('#dialog-content')?.innerText.includes('Could not open'),name,{timeout:240000});
    assert.equal(await page.evaluate(()=>styk.editor.name),name,await page.locator('#dialog-content').innerText());
    const summary=await page.evaluate(async()=>{
      const {editor,state}=styk;
      if(state.renderer.stats.backend!=='WebGPU')throw new Error('Expected WebGPU');
      const frames=editor.report.keyframes,counts=frames.map(f=>f.objects.length),samples=[];
      for(const index of [...new Set([0,Math.floor(frames.length/2),frames.length-1])]) {
        editor.selectFrame(index);styk.fit();
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        if(editor.geometry.objects.size!==counts[index])throw new Error('Import dropped figures');
        samples.push({index,objects:counts[index],gpuBytes:state.renderer.stats.gpuBytes});
      }
      return {keys:frames.length,types:editor.report.figure_types.length,objects:counts.reduce((a,b)=>a+b,0),
        warnings:state.lastImportWarnings,missing:editor.report.piv_missing_images,
        samples,rendererWarnings:state.renderer.stats.warnings};
    });
    await page.locator('[data-action="close-dialog"]').click({timeout:1000}).catch(()=>{});
    await page.screenshot({path:path.join(out,`${name}.png`)});
    if(process.env.STYK_VERIFY_NATIVE_SAVE==='1') {
      console.log('NATIVE SAVE',name);
      summary.nativeSave=await page.evaluate(async()=>{
        const {DocumentExporter}=await import('/src/document-export.mjs');
        const exporter=new DocumentExporter({timeoutMs:240000});
        try {
          const blob=await exporter.export(styk.editor.report,{sourceId:styk.state.sourceId,format:'styk',name:styk.editor.name});
          window.savedTestBlob=blob;
          return {bytes:blob.size,timings:exporter.lastTimings};
        } finally {exporter.dispose();}
      });
      console.log('SAVED',name,summary.nativeSave.bytes);
      const downloading=page.waitForEvent('download');
      await page.evaluate(name=>{
        const link=document.createElement('a');link.href=URL.createObjectURL(savedTestBlob);
        link.download=`${name}.styk`;link.click();
      },name);
      const download=await downloading,nativePath=path.join(out,`${name}.styk`);
      await download.saveAs(nativePath);
      await page.close();
      const reopened=await browser.newPage({viewport:{width:1440,height:960}});
      reopened.on('pageerror',e=>errors.push(e.message));
      await reopened.goto(backend.origin);await reopened.waitForFunction(()=>window.styk?.ready);
      console.log('REOPEN',name);
      await reopened.locator('#file-input').setInputFiles(nativePath);
      await reopened.waitForFunction(name=>!styk.state.importing&&styk.editor.name===name,name,{timeout:240000});
      const restored=await reopened.evaluate(()=>({keys:styk.editor.report.keyframes.length,
        objects:styk.editor.report.keyframes.reduce((sum,f)=>sum+f.objects.length,0),
        sourceHash:styk.editor.report._stykSource?.sha256}));
      assert.equal(restored.keys,summary.keys);assert.equal(restored.objects,summary.objects);
      assert.match(restored.sourceHash,/^[0-9a-f]{64}$/);
      summary.nativeSave.reopened=restored;await reopened.close();
      console.log('REOPENED',name);
    }
    results.push({name,elapsedMs:Date.now()-start,...summary,errors});
    await writeFile(path.join(out,'report.json'),JSON.stringify(results,null,2));
    assert.deepEqual(errors,[]);assert.deepEqual(summary.rendererWarnings,[]);
    console.log('IMPORTED',name,summary.keys,summary.objects,Date.now()-start);
    if(!page.isClosed())await page.close();
  }
} finally {await browser?.close();backend.stop();}
