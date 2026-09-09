import {chromium} from 'playwright';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),output=path.join(root,'artifacts','export-bitrate');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1360,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const{emptyDocument,createFrame}=await import('/src/demo.mjs');const report=emptyDocument();report.canvas_width=160;report.canvas_height=90;report.fps=16;report.keyframes=[createFrame([],4),createFrame([],1)];
    window.styk.editor.load(report);window.styk.editor.addAnimationKeys([{target:{kind:'scene'},property:'color',tick:0,value:0xffff0000,interpolation:'hold'},{target:{kind:'scene'},property:'color',tick:4,value:0xff0000ff,interpolation:'hold'}]);window.styk.editor.markSaved();
    window.__encoderConfigs=[];const configure=VideoEncoder.prototype.configure;VideoEncoder.prototype.configure=function(config){window.__encoderConfigs.push({...config});return configure.call(this,config);};
  });
  await page.locator('[data-action="export"]').first().click();await page.locator('.export-settings summary').click();
  await page.locator('#export-webm-bitrate').fill('0.25');
  assert.ok(await page.locator('#dialog').evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth+1));
  const pending=page.waitForEvent('download');await page.locator('[data-action="export-video"]').click();const download=await pending;
  const filename=path.join(output,'quarter-megabit.webm');await download.saveAs(filename);
  const configs=await page.evaluate(()=>window.__encoderConfigs);assert.equal(configs.length,1);assert.equal(configs[0].bitrate,250000);assert.equal(configs[0].width,160);assert.equal(configs[0].height,90);
  const bytes=await readFile(filename);
  const decoded=await page.evaluate(async bytes=>{
    const video=document.createElement('video'),url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'video/webm'}));video.muted=true;video.preload='auto';
    const event=name=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Video ${name} timed out`)),5000);video.addEventListener(name,()=>{clearTimeout(timer);resolve();},{once:true});video.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Encoded WebM did not decode'));},{once:true});});
    try{
      const loaded=event('loadeddata');video.src=url;document.body.append(video);await loaded;
      const canvas=new OffscreenCanvas(160,90),ctx=canvas.getContext('2d'),samples=[];
      for(const time of [.01,.27]){const sought=event('seeked');video.currentTime=time;await sought;ctx.drawImage(video,0,0);samples.push([...ctx.getImageData(20,20,1,1).data]);}
      return{width:video.videoWidth,height:video.videoHeight,duration:video.duration,samples};
    }finally{video.removeAttribute('src');video.load();video.remove();URL.revokeObjectURL(url);}
  },[...bytes]);
  assert.equal(decoded.width,160);assert.equal(decoded.height,90);assert.ok(Math.abs(decoded.duration-5/16)<.002);assert.ok(decoded.samples[0][0]>220&&decoded.samples[0][2]<20&&decoded.samples[1][2]>220&&decoded.samples[1][0]<20,JSON.stringify(decoded));assert.deepEqual(errors,[]);
  const report={bitrate:configs[0].bitrate,codec:configs[0].codec,bytes:bytes.length,decoded,errors,checks:['Actual WebM bitrate field reaches VideoEncoder.configure as250000bits/s','Independent HTML video decodes160×90 and exact5/16second duration','First and last authored Scene colors decode red and blue','Expanded dialog has no horizontal overflow'],checkedAt:new Date().toISOString()};
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
