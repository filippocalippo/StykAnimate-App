import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {chooseExport} from './helpers/export-dialog.mjs';
const root=process.cwd(),out=path.join(root,'artifacts','audio-desktop'); await mkdir(out,{recursive:true});
const ffmpeg=path.join(root,'build','video-encoder',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');
const encoded=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:duration=3:sample_rate=48000','-c:a','libmp3lame',path.join(out,'Voice.mp3')],{windowsHide:true});
assert.equal(encoded.status,0,encoded.stderr?.toString());
const app=await electron.launch({args:[root],cwd:root,timeout:45000,env:{...process.env,STYK_USER_DATA_DIR:path.join(out,`profile-${Date.now()}`)}});
app.process().stderr.on('data',bytes=>process.stderr.write(bytes));
app.process().stdout.on('data',bytes=>process.stdout.write(bytes));
try {
  const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>window.styk?.ready&&window.stykDesktop?.beginAudioImport,null,{timeout:45000});
  await page.evaluate(()=>{
    const dismiss=()=>document.querySelectorAll('dialog.release-splash[open],dialog.styk-privacy[open]').forEach(dialog=>dialog.close());dismiss();new MutationObserver(dismiss).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
    styk.editor.setFPS(8);styk.editor.sheetInsertFrames(['scene','camera',...styk.editor.report._styk.layers.order],1,31);
  });
  await page.getByLabel('Choose audio recording').setInputFiles(path.join(out,'Voice.mp3'));
  await page.waitForFunction(()=>styk.editor.report._styk.audio?.tracks[0]?.clips.length===1,null,{timeout:30000});
  const results=await page.evaluate(async()=>{
    const {encodeNativeVideo}=await import('/src/native-video-export.mjs'),{audioState}=await import('/src/audio-model.mjs');
    const state=audioState(styk.editor.report),clip=state.tracks[0].clips[0];styk.editor.setAudioClip(clip.id,{start:.25,offset:.5,duration:1.5,fadeIn:.05,fadeOut:.1,gain:.8});
    const canvas=new OffscreenCanvas(128,96),ctx=canvas.getContext('2d'),files=[],chunks=[];
    const desktop={...stykDesktop,writeVideoAudioChunk:async(token,bytes)=>{chunks.push(bytes.byteLength);return stykDesktop.writeVideoAudioChunk(token,bytes);}};
    for(const format of ['mp4','webm','avi','wmv']){
      const blob=await encodeNativeVideo({format,width:128,height:96,fps:8,totalFrames:16,desktop,
        audioChunks:styk.audioEngine.exportChunks(styk.editor.report,{start:0,duration:2}),
        renderFrame:index=>{ctx.fillStyle=index<8?'#f00':'#00f';ctx.fillRect(0,0,128,96);return canvas;}});
      files.push({format,bytes:[...new Uint8Array(await blob.arrayBuffer())]});
    }
    const range=await encodeNativeVideo({format:'mp4',width:128,height:96,fps:8,totalFrames:8,desktop,audioChunks:styk.audioEngine.exportChunks(styk.editor.report,{start:.5,duration:1}),renderFrame:()=>canvas});
    files.push({format:'range.mp4',bytes:[...new Uint8Array(await range.arrayBuffer())]});
    const controller=new AbortController();let cancelled;
    async function* cancelMix(){for await(const pcm of styk.audioEngine.exportChunks(styk.editor.report,{start:0,duration:2,signal:controller.signal})){yield pcm;controller.abort();}}
    try{await encodeNativeVideo({format:'mp4',width:128,height:96,fps:8,totalFrames:16,signal:controller.signal,audioChunks:cancelMix(),renderFrame:()=>canvas});}catch(error){cancelled=error.name;}
    const retry=await encodeNativeVideo({format:'mp4',width:128,height:96,fps:8,totalFrames:1,renderFrame:()=>canvas});
    return {files,chunks,cancelled,retryBytes:retry.size,duration:state.assets[clip.assetId].duration,isolated:typeof window.require==='undefined'};
  });
  // Exercise the actual Export panel and app orchestration, not just its encoder API.
  const uiTarget=path.join(out,'ui.mp4');
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},uiTarget);
  await page.locator('[data-action="export"]').first().click();
  await chooseExport(page,'export-mp4');
  await page.locator('#export-resolution').selectOption('custom');
  await page.locator('#export-width').fill('128');await page.locator('#export-width').press('Tab');
  await page.locator('#export-start').fill('1');await page.locator('#export-end').fill('16');await page.locator('#export-end').press('Tab');
  assert.equal(await page.locator('#export-audio').isChecked(),true);
  await page.locator('#export-submit').click();await page.waitForFunction(()=>/exported/i.test(document.querySelector('#status-text')?.textContent??'')||/exported/i.test(document.querySelector('#status')?.textContent??''),null,{timeout:45000});
  results.files.push({format:'ui.mp4',bytes:[...await readFile(uiTarget)]});
  assert.equal(results.isolated,true);assert.equal(results.cancelled,'AbortError');assert.ok(results.retryBytes>100);assert.ok(Math.max(...results.chunks)<=262144);
  const measured=[];
  for(const file of results.files){
    const name=file.format.includes('.')?file.format:`mixed.${file.format}`,target=path.join(out,name);await writeFile(target,Uint8Array.from(file.bytes));
    const decoded=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-i',target,'-map','0:a:0','-f','f32le','-ar','48000','-ac','2','pipe:1'],{windowsHide:true,maxBuffer:8*1024*1024});
    assert.equal(decoded.status,0,decoded.stderr?.toString());const bytes=decoded.stdout;
    const rms=(start,end)=>{let sum=0,n=0;for(let at=Math.round(start*48000)*8;at<Math.min(bytes.length,Math.round(end*48000)*8);at+=8){const value=bytes.readFloatLE(at);sum+=value*value;n++;}return Math.sqrt(sum/n);};
    const range=name.startsWith('range'),duration=bytes.length/8/48000;assert.ok(Math.abs(duration-(range?1:2))<.08,`${name}: duration ${duration}`);
    if(!range)assert.ok(rms(0,.18)<.003,`${name}: leading silence`);assert.ok(rms(.4,.8)>.035,`${name}: audible mix`);
    if(!range)assert.ok(rms(1.85,1.95)<.003,`${name}: trailing silence`);
    measured.push({name,bytes:file.bytes.length,duration,leadingRms:rms(0,.18),bodyRms:rms(.4,.8)});
  }
  await page.evaluate(()=>{styk.editor.seek(0);styk.actions.play();});await page.waitForFunction(()=>styk.audioEngine.running&&styk.editor.tick>=8);
  const sync=await page.evaluate(()=>({tick:styk.editor.tick,seconds:styk.audioEngine.position}));assert.ok(Math.abs(sync.tick/8-sync.seconds)<.2,JSON.stringify(sync));await page.evaluate(()=>styk.actions.play());
  await page.screenshot({path:path.join(out,'desktop.png')});assert.deepEqual(errors,[]);
  await writeFile(path.join(out,'report.json'),JSON.stringify({measured,sync,cancelled:results.cancelled,maxChunk:Math.max(...results.chunks),errors},null,2));
  console.log('PASS real Electron MP3 decoding, bounded IPC, four audio/video codecs, ranged export, cancellation, recovery and sync',measured,sync);
}finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
