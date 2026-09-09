import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-unsafe-webgpu']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
 await page.evaluate(async()=>{const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');const report=emptyDocument(),fig=report.figure_types[0];report.keyframes=[createFrame([createObject(fig,1,300,280)])];window.styk.editor.load(report);window.styk.editor.select(1,0);});
 await page.waitForTimeout(800);
 if(await page.locator('[data-property-scope="joint"]').count())await page.locator('[data-property-scope="joint"]').click();
 await page.locator('#segment-color').click();
 await page.locator('[data-mode="gradient"]').click();
 await page.getByRole('combobox',{name:'Gradient type'}).selectOption('radial');
 await page.getByRole('button',{name:'Add gradient stop',exact:true}).click();
 await page.getByRole('textbox',{name:'Hex color'}).fill('F0408080');await page.getByRole('textbox',{name:'Hex color'}).press('Tab');
 assert.equal(await page.evaluate(()=>window.styk.editor.figure.segments[0].paint.stops.length),3);
 assert.ok(Math.abs(await page.evaluate(()=>window.styk.editor.figure.segments[0].paint.stops[1].opacity)-128/255)<.01);
 await page.getByRole('button',{name:'Reverse gradient',exact:true}).click();
 await page.getByRole('combobox',{name:'Gradient type'}).selectOption('angular');
 await mkdir('artifacts/color-picker',{recursive:true});await page.screenshot({path:'artifacts/color-picker/gradient.png'});
 await page.getByRole('button',{name:'Close color picker',exact:true}).click();
 await page.locator('#segment-color').click();assert.equal(await page.getByRole('combobox',{name:'Gradient type'}).inputValue(),'angular');
 await page.keyboard.press('Escape');assert.equal(await page.locator('.paint-picker').count(),0);
 const pixels=await page.evaluate(async()=>{
  const {canvasPaint}=await import('/src/paint.mjs');const c=document.createElement('canvas');c.width=c.height=100;const ctx=c.getContext('2d'),result={};
  for(const type of ['linear','radial','angular','diamond']){ctx.clearRect(0,0,100,100);ctx.fillStyle=canvasPaint(ctx,{type,angle:0,stops:[{offset:0,color:[255,0,0],opacity:0},{offset:1,color:[0,0,255],opacity:1}]},{x:0,y:50},{x:100,y:50});ctx.fillRect(0,0,100,100);result[type]=[...ctx.getImageData(50,50,1,1).data];}return result;
 });assert.ok(pixels.linear[3]>110&&pixels.linear[3]<145);assert.ok(pixels.radial[3]<10);assert.ok(pixels.diamond[3]<12);

 await page.evaluate(async()=>{
  const {BackgroundDialog}=await import('/src/background-dialog.mjs');const dialog=document.querySelector('#dialog'),content=document.querySelector('#dialog-content');
  window.paintBackgroundDialog=new BackgroundDialog({dialog,content});window.paintBackgroundDialog.open({report:window.styk.editor.report,frame:window.styk.editor.frame,onUse:()=>{},onCreate:bg=>{window.testBackground=bg;dialog.close();}});
 });
 await page.locator('#background-paint').click();await page.locator('[data-mode="gradient"]').click();await page.getByRole('combobox',{name:'Gradient type'}).selectOption('diamond');await page.getByRole('button',{name:'Add gradient stop',exact:true}).click();await page.keyboard.press('Escape');await page.locator('#create-background').click();
 assert.equal(await page.evaluate(()=>window.testBackground.paint.type),'diamond');
 await page.evaluate(()=>window.styk.editor.importSceneBackground(window.testBackground));
 await page.waitForTimeout(200);await page.screenshot({path:'artifacts/color-picker/background.png'});
 await page.evaluate(async()=>{
  const {TextDialog}=await import('/src/text-dialog.mjs');window.paintTextDialog=new TextDialog({dialog:document.querySelector('#dialog'),content:document.querySelector('#dialog-content')});
  await window.paintTextDialog.open({initialOptions:{text:'Gradient'},onApply:()=>{}});
 });
 await page.locator('#text-color').click();await page.locator('[data-mode="gradient"]').click();await page.getByRole('combobox',{name:'Gradient type'}).selectOption('radial');await page.getByRole('button',{name:'Add gradient stop',exact:true}).click();await page.keyboard.press('Escape');
 await page.waitForFunction(()=>window.paintTextDialog.result?.segments?.[0]?.paint?.type==='radial');
 assert.equal(await page.evaluate(()=>window.paintTextDialog.result.segments[0].paint.stops.length),3);
 await page.screenshot({path:'artifacts/color-picker/text.png'});await page.evaluate(()=>window.paintTextDialog.close());

 const exportChecks=await page.evaluate(async()=>{
  const {DocumentExporter}=await import('/src/document-export.mjs');const ex=new DocumentExporter(),report=window.styk.editor.serialize();
  const saved=JSON.parse(await(await ex.export(report,{format:'styk'})).text());
  let rejected=false;try{await ex.export(report,{format:'piv'});}catch(e){rejected=e.message.includes('cannot represent');}
  const {canvasPaint,svgPaintDefinition}=await import('/src/paint.mjs'),differences={};
  for(const type of ['linear','radial','angular','diamond']){
    const paint={type,angle:25,stops:[{offset:0,color:[240,30,20],opacity:.2},{offset:.35,color:[50,240,80],opacity:.65},{offset:1,color:[10,40,250],opacity:1}]};
    const a=document.createElement('canvas'),b=document.createElement('canvas');a.width=a.height=b.width=b.height=128;const ac=a.getContext('2d'),bc=b.getContext('2d');
    ac.fillStyle=canvasPaint(ac,paint,{x:0,y:64},{x:128,y:64});ac.fillRect(0,0,128,128);
    const xml=`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs>${await svgPaintDefinition(paint,{x:0,y:64},{x:128,y:64},'paint')}</defs><rect width="128" height="128" fill="url(#paint)"/></svg>`;
    const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(xml);await img.decode();bc.drawImage(img,0,0);
    const ap=ac.getImageData(0,0,128,128).data,bp=bc.getImageData(0,0,128,128).data;let error=0;for(let i=0;i<ap.length;i++)error+=Math.abs(ap[i]-bp[i]);differences[type]=error/ap.length;
  }
  return {savedPaint:saved.figure_types[0].segments[0].paint.type,rejected,differences};
 });
 assert.equal(exportChecks.savedPaint,'angular');assert.equal(exportChecks.rejected,true);console.log('Export checks',exportChecks);
 for(const difference of Object.values(exportChecks.differences))assert.ok(difference<8,'SVG and Canvas paint should match');
 assert.deepEqual(errors,[]);console.log('Picker interactions, alpha rendering, reopen and Escape passed',pixels);
}finally{await browser.close();}

