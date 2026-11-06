/** Actual Electron export, source hashes, decoded frame counts and process memory.
 * Run before/after with unchanged source and identical STYK_BENCH_CASES/TICKS. */
import {_electron as electron} from '../tests/support/playwright.mjs';
import {mkdir, readFile, writeFile, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {corpusPath} from '../tests/support/corpus.mjs';
const source = process.env.STYK_BENCH_SOURCE || corpusPath('Desktop/Folder/16 Akane vs Akato Segundo round (3).piv');
const label = process.argv[2] || 'after';
assert.match(label, /^[a-z0-9-]+$/);
const output = path.resolve('artifacts/export-akane', label);
await mkdir(output, {recursive:true});
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const sourceHash = await digest(source);
const ticks = (process.env.STYK_BENCH_TICKS || '0,1,535,536,1824,1825,1826,1827,1828,1829,1836,1871').split(',').map(Number);
const cases = (process.env.STYK_BENCH_CASES || '1080-edges,2160-edges,2160-sprites').split(',');
const ffmpeg = path.resolve('build/video-encoder/ffmpeg.exe');
const sourceHashes = {};
for (const file of ['src/engine/engine-export.mjs','src/engine/engine-export-worker.mjs','src/native-video-export.mjs','desktop/video-export-service.cjs','src/export-memory.mjs','src/app.mjs']) sourceHashes[file] = await digest(file);
const app = await electron.launch({args:[process.cwd()],cwd:process.cwd(),timeout:60000,
  env:{...process.env, STYK_USER_DATA_DIR:path.join(output,`profile-${Date.now()}`)}});
const result = {label,date:new Date().toISOString(),source,sourceHash,sourceHashes,cpu:os.cpus()[0].model,ramBytes:os.totalmem(),node:process.version,ticks,runs:[],errors:[]};
let timer, phase='prepare';
try {
  const page = await app.firstWindow();
  page.on('pageerror', error => result.errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready, null, {timeout:60000});
  await page.evaluate(() => {
    const dismiss = () => document.querySelectorAll('dialog.release-splash[open],dialog.styk-privacy[open]').forEach(d=>d.close());
    dismiss();new MutationObserver(dismiss).observe(document.body,{subtree:true,attributes:true,childList:true,attributeFilter:['open']});
    styk.editor.markSaved();
  });
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name => !styk.state.importing && styk.editor.name === name,path.basename(source,'.piv'),{timeout:240000});
  result.scene = await page.evaluate(async () => {
    const {timeline} = await import('/src/pivot/read-view.mjs');
    const report=styk.editor.report, rows=timeline(report);
    styk.state.playback?.clear?.();
    return {width:report.canvas_width,height:report.canvas_height,keyframes:report.keyframes.length,ticks:rows.at(-1).start+rows.at(-1).count};
  });
  console.log(JSON.stringify({scene:result.scene,sourceHash}));
  await page.exposeFunction('saveBenchmarkReference',async (name,base64) => {
    assert.equal(path.basename(name),name);await writeFile(path.join(output,name),Buffer.from(base64,'base64'));
  });
  await page.exposeFunction('benchmarkStage',async next=>{phase=next;});
  await page.exposeFunction('benchmarkProgress',async completed=>console.log(JSON.stringify({completed,total:ticks.length})));
  for (const name of cases) {
    const [heightText,smoothing] = name.split('-'),height=Number(heightText),width=Math.round(height*result.scene.width/result.scene.height);
    const destination=path.join(output,`${name}.mp4`);
    await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},destination);
    const memory=[];let sampling=false;
    timer=setInterval(async()=>{if(sampling)return;sampling=true;try{memory.push({ms:Date.now(),phase,processes:await app.evaluate(({app})=>app.getAppMetrics().map(p=>({pid:p.pid,type:p.type,...p.memory}))) });}catch{}finally{sampling=false;}},500);
    const run=await page.evaluate(async({name,width,height,smoothing,ticks,sampleReferences})=>{
      const {createExportFrameRenderer}=await import('/src/engine/engine-export.mjs');
      const {encodeNativeVideo}=await import('/src/native-video-export.mjs');
      const report=styk.editor.report,revision=styk.editor.revision;
      const renderer=createExportFrameRenderer({width,height,smoothing,getRevision:()=>styk.editor.revision},{stage:styk.state.renderer,playback:styk.playback,revision,range:[Math.min(...ticks),Math.max(...ticks)]});
      const samples=[],started=performance.now();let loadMs;
      try{
        await benchmarkStage('prepare');
        await renderer.load(report);loadMs=performance.now()-started;
        await benchmarkStage('encode');
        const encodeStart=performance.now();
        const options={format:'mp4',width,height,fps:16,totalFrames:ticks.length,quality:.8,save:{defaultPath:name+'.mp4'},
          onProgress:value=>{if(value.phase==='rendering' && value.completed%128===0)void benchmarkProgress(value.completed);},
          renderFrame:async i=>{const t=performance.now(),canvas=await renderer.renderTick(ticks[i]);samples.push({tick:ticks[i],wallMs:performance.now()-t,...renderer.stats});return canvas;}};
        if(renderer.renderNativeTick) options.renderNativeFrame=async i=>{const t=performance.now(),frame=await renderer.renderNativeTick(ticks[i],{preserveAlpha:false});samples.push({tick:ticks[i],wallMs:performance.now()-t,...renderer.stats});return frame;};
        const saved=await encodeNativeVideo(options),encodeMs=performance.now()-encodeStart;
        if(!saved.saved)throw new Error('Export was not saved');
        await benchmarkStage('references');
        for(const tick of sampleReferences ? [ticks[0],ticks[Math.floor(ticks.length/2)],ticks.at(-1)] : ticks){
          const canvas=await renderer.renderTick(tick);
          await saveBenchmarkReference(`${name}-${tick}.png`,canvas.toDataURL('image/png').split(',')[1]);
        }
        if(styk.editor.report!==report||styk.editor.revision!==revision)throw new Error('Document changed');
        return {name,width,height,smoothing,loadMs,encodeMs,samples,documentPreserved:true};
      }finally{renderer.dispose();}
    },{name,width,height,smoothing,ticks,sampleReferences:process.env.STYK_BENCH_REFERENCES==='sample'});
    clearInterval(timer);timer=null;
    run.memory=memory;run.bytes=(await stat(destination)).size;
    const decoded=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-threads','1','-i',destination,'-map','0:v:0','-fps_mode','passthrough','-f','framehash','-'],{windowsHide:true,maxBuffer:4*1024*1024});
    assert.equal(decoded.status,0,decoded.stderr?.toString());
    const hashes=decoded.stdout.toString();run.decodedFrames=hashes.split('\n').filter(l=>/^0,/.test(l)).length;assert.equal(run.decodedFrames,ticks.length);
    await writeFile(path.join(output,`${name}.framehash`),hashes);
    result.runs.push(run);await writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({name,encodeMs:run.encodeMs,bytes:run.bytes,frames:run.decodedFrames}));
  }
  assert.equal(await digest(source),sourceHash);assert.deepEqual(result.errors,[]);
}finally{clearInterval(timer);await writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
