/** Real browser workers and codec cancellation: cross-origin isolated (a shared flag stops the running request
 * and the codec worker keeps its imported sources) and not isolated (the busy worker is stopped and replaced).
 * Run: node tests/codec-cancellation.browser.mjs */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import host from '../desktop/web-host.cjs';

const ISOLATION=['cross-origin-opener-policy','cross-origin-embedder-policy','cross-origin-resource-policy'];
let browser;
const rows=[];
const service=await host.startDesktopHost({appRoot:process.cwd()});
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  for(const isolated of [true,false]){
    const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    // Without the isolation headers the page has no SharedArrayBuffer: the codec cannot be flagged.
    if(!isolated)await page.route('**/*',async route=>{
      const response=await route.fetch(),headers=Object.fromEntries(Object.entries(response.headers()).filter(([name])=>!ISOLATION.includes(name)));
      await route.fulfill({response,headers});
    });
    try{
      await page.goto(service.origin+'/tests/fixtures/blank.html');
      assert.equal(await page.evaluate(()=>crossOriginIsolated),isolated);
      await page.evaluate(async()=>{
        // Watch the codec worker the page creates: when it starts and finishes work, and whether it is stopped.
        const NativeWorker=window.Worker;window.codecWorkers=[];
        window.Worker=class extends NativeWorker{constructor(url,options){super(url,options);if(!String(url).includes('codec-web-worker'))return;
          const record={events:[],terminated:false};codecWorkers.push(record);
          this.addEventListener('message',({data})=>{if(data?.type==='busy'||data?.type==='idle')record.events.push(data.type);});
          const terminate=this.terminate.bind(this);this.terminate=()=>{record.terminated=true;terminate();};}};
        const {DocumentExporter}=await import('/src/document-export.mjs');
        const {ImportClient}=await import('/src/import-client.mjs');
        const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
        window.exporter=new DocumentExporter();window.importer=new ImportClient();
        window.small=emptyDocument();small.keyframes=[createFrame([createObject(small.figure_types[0],1,200,200)])];
        window.original=JSON.stringify(small);
        // An import whose original stays leased in the codec while the next export is cancelled.
        const blob=await exporter.export(small,{format:'piv'});
        window.leased=await importer.importFile(new File([blob],'leased.piv'),{project:true});
        window.leasedBytes=new Uint8Array(await blob.arrayBuffer());
        window.dense={...small,keyframes:Array(50000).fill(small.keyframes[0])};
        window.controller=new AbortController();
        window.result=exporter.export(dense,{format:'piv',signal:controller.signal}).then(()=>({unexpected:true}),error=>({error:error.name}));
      });
      await page.waitForFunction(()=>codecWorkers[0]?.events.at(-1)==='busy'&&codecWorkers[0].events.length>=5,undefined,{timeout:120000,polling:5})
        .catch(async error=>{console.error(JSON.stringify(await page.evaluate(()=>({workers:codecWorkers,result:String(window.result)}))));throw error;});
      const started=Date.now();
      await page.evaluate(()=>controller.abort());
      assert.deepEqual(await page.evaluate(()=>result),{error:'AbortError'});
      if(isolated)await page.waitForFunction(()=>codecWorkers[0].events.at(-1)==='idle',undefined,{timeout:10000,polling:5});
      else await page.waitForFunction(()=>codecWorkers[0].terminated,undefined,{timeout:10000,polling:5});
      const idleMs=Date.now()-started;
      const next=await page.evaluate(async()=>{
        if(JSON.stringify(small)!==original||dense.keyframes.length!==50000)throw new Error('Cancelled export mutated its input');
        // The leased original: still in the codec when only the request was stopped, gone with a stopped worker.
        let leasedExport;
        try{leasedExport=new Uint8Array(await (await exporter.export(leased.document,{sourceId:leased.sourceId,format:'piv'})).arrayBuffer());}
        catch(error){leasedExport=error.code;}
        const blob=await exporter.export(small,{format:'piv'});
        const imported=await importer.importFile(new File([blob],'after-cancel.piv'));
        const exact=await exporter.export(imported.document,{sourceId:imported.sourceId,format:'piv'});
        const bytes=new Uint8Array(await blob.arrayBuffer()),again=new Uint8Array(await exact.arrayBuffer());
        if(bytes.length!==again.length||bytes.some((value,index)=>value!==again[index]))throw new Error('Following import/export changed native bytes');
        const native=await exporter.export(imported.document,{sourceId:imported.sourceId,format:'styk'});
        const reopened=await importer.importFile(new File([native],'after-cancel.styk'));
        exporter.dispose();importer.dispose();
        return {leasedOriginal:leasedExport instanceof Uint8Array?(leasedExport.length===leasedBytes.length&&leasedExport.every((value,index)=>value===leasedBytes[index])?'kept':'changed'):leasedExport,
          codecWorkers:codecWorkers.map(record=>({terminated:record.terminated,requests:record.events.filter(event=>event==='busy').length})),
          pivBytes:blob.size,nativeBytes:native.size,frames:reopened.document.keyframes.length,objects:reopened.document.keyframes[0].objects.length};
      });
      assert.equal(next.frames,1);assert.equal(next.objects,1);assert.deepEqual(errors,[]);
      if(isolated){
        assert.equal(next.leasedOriginal,'kept','the cancelled request left the codec and its imported sources intact');
        assert.equal(next.codecWorkers.length,1);assert.equal(next.codecWorkers[0].terminated,false);
      }else{
        assert.equal(next.leasedOriginal,'source_expired','a stopped worker loses its imported sources, as a restarted codec did');
        assert.equal(next.codecWorkers.length,2);assert.equal(next.codecWorkers[0].terminated,true);
      }
      rows.push({isolated,cancelToStopMs:idleMs,next,errors});
    }finally{await page.close();}
  }
  await mkdir('artifacts',{recursive:true});
  await writeFile('artifacts/codec-cancellation-browser.json',JSON.stringify({rows,limitations:['Correctness probe with an attached browser debugger; not a performance comparison.','Synthetic 50,000-frame export cancelled while the codec worker ran it.']},null,2));
  console.log(JSON.stringify(rows,null,2));
}finally{await browser?.close();await service.stop();}
