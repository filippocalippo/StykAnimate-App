/** Actual root export dialog and downloads: native defaults, option wiring, progress. */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import backend from '../desktop/web-host.cjs';
import {chooseExport} from './helpers/export-dialog.mjs';
const output=path.resolve('artifacts/gif-dithering-app');
await mkdir(output,{recursive:true});
const service=await backend.startDesktopHost({appRoot:process.cwd()});
let browser;const checks=[],errors=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1360,height:900},acceptDownloads:true});
 page.on('pageerror',e=>errors.push(e.message));
 // Headless Chrome aborts showSaveFilePicker; without it the export saves through a download.
 await page.addInitScript(()=>{delete window.showSaveFilePicker;});
 await page.goto(service.origin);await page.waitForFunction(()=>window.styk?.ready);
 const open=async()=>{await page.locator('.titlebar [data-action="export"]').click();await chooseExport(page,'export-gif');};
 await open();check('simple drawings default Dither off',!await page.locator('#export-gif-dither').isChecked());
 await page.keyboard.press('Escape');
 await page.evaluate(async()=>{
  const {samplingFixture}=await import('/tests/export-sampling-fixture.mjs');
  const {createObject}=await import('/src/demo.mjs');
  const {gifFixture}=await import('/tests/gif-fixtures.mjs');
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=128;
  canvas.getContext('2d').putImageData(new ImageData(gifFixture('sprite',256,128),256,128),0,0);
  const report=samplingFixture({kind:'image',spriteURL:canvas.toDataURL()});
  report.canvas_width=320;report.canvas_height=200;
  const type=report.figure_types[0];Object.assign(type.image_assets[0],{width:256,height:128,anchor_length:256});
  Object.assign(type.segments[0],{length:240,angle_rad:0});
  for(const frame of report.keyframes)frame.objects[0]=createObject(type,1,30,30);
  styk.editor.load(report,'GIF dither UI');styk.fit();
  window.gifProgress=[];
  new MutationObserver(()=>{const p=document.querySelector('#export-progress');if(p)window.gifProgress.push({max:p.max,value:p.value});}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['value','max']});
 });
 const hashes=[];
 for(const dither of [false,true]){
  await open();check(`sprite default Dither on before ${dither?'on':'off'} export`,await page.locator('#export-gif-dither').isChecked());
  await page.locator('#export-gif-dither').setChecked(dither);
  if(dither)await page.screenshot({path:path.join(output,'dialog.png')});
  const waiting=page.waitForEvent('download');await page.locator('#export-submit').click();
  const file=await waiting,target=path.join(output,`sprite-${dither?'on':'off'}.gif`);await file.saveAs(target);
  const bytes=await readFile(target);check(`actual ${dither?'on':'off'} GIF download`,bytes.subarray(0,6).toString()==='GIF89a');
  hashes.push(await page.evaluate(async data=>{
   const decoder=new ImageDecoder({data:Uint8Array.from(data),type:'image/gif'});await decoder.tracks.ready;
   const {image}=await decoder.decode({frameIndex:0});const canvas=new OffscreenCanvas(image.displayWidth,image.displayHeight);canvas.getContext('2d').drawImage(image,0,0);image.close();decoder.close();
   const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
   return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))).join(',');
  },[...bytes]));
 }
 check('actual Dither checkbox changes decoded output',hashes[0]!==hashes[1]);
 // The bar shows percent (the model's frames × passes units are covered by tests/export-progress.test.mjs): across a
 // two-pass GIF it climbs from under half to the end of the second pass before the dialog closes.
 const progress=await page.evaluate(()=>window.gifProgress);
 check('root progress climbs through both passes of a two-pass GIF',progress.every(v=>v.max===100)&&progress.some(v=>v.value<50)&&progress.some(v=>v.value>=95));
 check('no browser errors',errors.length===0);
 await writeFile(path.join(output,'report.json'),JSON.stringify({checks,progress,errors},null,2));
 console.log(JSON.stringify({checks:checks.length,errors}));
}finally{await browser?.close();await service.stop();}
