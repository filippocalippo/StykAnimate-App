import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import backendService from '../desktop/backend.cjs';
const root=path.resolve(import.meta.dirname,'..'),output=path.join(root,'artifacts','sprite-placement');await mkdir(output,{recursive:true});
const backend=await backendService.startBackend({appRoot:root});let browser;
const checks=[],errors=[],check=name=>{checks.push(name);console.log(`PASS ${name}`);};
try {
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1100,height:780}});page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${backend.origin}/api/health`);
  await page.setContent(`<link rel="stylesheet" href="${backend.origin}/src/style.css"><dialog id="dialog"><div id="content"></div></dialog>`);
  await page.evaluate(async()=>{
    const {imageFileToFigure}=await import('/src/media-authoring.mjs'),{SpritePlacementDialog}=await import('/src/sprite-placement-dialog.mjs');
    const canvas=new OffscreenCanvas(120,180),ctx=canvas.getContext('2d');ctx.fillStyle='#385a74';ctx.beginPath();ctx.roundRect(38,15,44,150,20);ctx.fill();ctx.fillStyle='#c6d6e2';ctx.fillRect(41,58,38,13);ctx.fillRect(41,121,38,13);
    window.sprite=await imageFileToFigure(new File([await canvas.convertToBlob({type:'image/png'})],'Upper arm.png',{type:'image/png'}));window.sourceJSON=JSON.stringify(sprite);
    window.placement=new SpritePlacementDialog({dialog:document.getElementById('dialog'),content:document.getElementById('content')});window.placementResult=undefined;window.openCount=0;window.openSprite=()=>{const current=++window.openCount;window.placementResult=undefined;window.pendingPlacement=placement.open(sprite).then(result=>{if(current===window.openCount)window.placementResult=result;return result;});};openSprite();
  });
  await page.waitForFunction(()=>placement.loaded&&!document.querySelector('[data-sprite-apply]').disabled);
  const dataURL=await page.evaluate(()=>sprite.image_assets[0].data_url);await writeFile(path.join(output,'upper-arm.png'),Buffer.from(dataURL.split(',')[1],'base64'));
  const fill=async(key,axis,value)=>page.locator(`[data-sprite-point="${key}"][data-sprite-axis="${axis}"]`).fill(String(value));
  await fill('start','x',60);await fill('start','y',35);await fill('end','x',60);await fill('end','y',155);
  assert.equal(await page.locator('[data-sprite-angle]').innerText(),'Angle 90.00°');assert.equal(await page.locator('[data-sprite-length]').innerText(),'Length 120.00 px');check('Native numeric image coordinates derive exact vertical angle and length.');
  await page.locator('[data-sprite-select="start"]').click();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const colors=await page.evaluate(()=>{
    const canvas=placement.canvas,ctx=canvas.getContext('2d'),data=ctx.getImageData(0,0,canvas.width,canvas.height).data,counts={origin:0,end:0,black:0,image:0};
    for(let i=0;i<data.length;i+=4){if(data[i]===255&&data[i+1]===136&&data[i+2]===0)counts.origin++;if(data[i]===255&&data[i+1]===0&&data[i+2]===0)counts.end++;if(data[i]===0&&data[i+1]===0&&data[i+2]===0&&data[i+3]===255)counts.black++;if(data[i]===56&&data[i+1]===90&&data[i+2]===116)counts.image++;}return counts;
  });
  assert.ok(colors.origin>40&&colors.end>40&&colors.black>4&&colors.image>500);check('Actual canvas pixels show exact Pivot orange/red handles, selected black center and decoded image.');
  const drag=await page.evaluate(()=>{const rect=placement.canvas.getBoundingClientRect(),start=placement.screen(placement.points.end),end=placement.screen({x:70,y:135});return{x1:rect.x+start.x,y1:rect.y+start.y,x2:rect.x+end.x,y2:rect.y+end.y};});
  await page.mouse.move(drag.x1,drag.y1);await page.mouse.down();await page.mouse.move(drag.x2,drag.y2,{steps:5});await page.mouse.up();
  assert.deepEqual(await page.evaluate(()=>placement.points.end),{x:70,y:135});await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowUp');
  assert.deepEqual(await page.evaluate(()=>placement.points.end),{x:71,y:134});check('Actual pointer drag and arrow keys move the selected handle in whole image pixels.');
  await fill('start','x',71);await fill('start','y',134);assert.equal(await page.locator('[data-sprite-apply]').isDisabled(),true);assert.match(await page.locator('[data-sprite-error]').innerText(),/different/);
  await fill('start','x',70.5);assert.equal(await page.locator('[data-sprite-apply]').isDisabled(),true);await fill('start','x',-8);assert.equal(await page.locator('[data-sprite-apply]').isEnabled(),true);check('Coincident and fractional anchors are rejected; valid outside-image integer coordinates remain available.');
  await page.screenshot({path:path.join(output,'desktop-dialog.png')});
  await page.locator('[data-sprite-apply]').click();await page.waitForFunction(()=>window.placementResult!==undefined);
  assert.deepEqual(await page.evaluate(()=>placementResult.image_assets[0].anchor_start),{x:-8,y:134});assert.equal(await page.evaluate(()=>JSON.stringify(sprite)===sourceJSON),true);assert.equal(await page.locator('#dialog').evaluate(dialog=>dialog.open),false);check('Apply returns a private placed sprite and leaves the imported source unchanged.');
  await page.evaluate(()=>{openSprite();placement.cancel();openSprite();});await page.waitForFunction(()=>placement.loaded);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#dialog').evaluate(dialog=>dialog.open),true);assert.equal(await page.evaluate(()=>placementResult===undefined),true);check('Queued close from an earlier canceled session cannot close a newly opened placement dialog.');
  await page.setViewportSize({width:390,height:560});await page.screenshot({path:path.join(output,'narrow-dialog.png')});
  const bounds=await page.locator('#dialog').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=391);check('Dialog fits a narrow desktop window without horizontal overflow.');
  await page.evaluate(()=>document.getElementById('content').replaceChildren(document.createTextNode('Replacement dialog')));await page.waitForFunction(()=>placementResult===null);
  assert.equal(await page.locator('#dialog').evaluate(dialog=>dialog.open),true);assert.equal(await page.locator('#content').innerText(),'Replacement dialog');check('Replacing shared dialog content cancels placement without closing the replacement.');
  await page.evaluate(()=>openSprite());await page.waitForFunction(()=>placement.loaded);await page.keyboard.press('Escape');await page.waitForFunction(()=>placementResult===null);check('Escape resolves cancellation and releases the placement session.');
  assert.deepEqual(errors,[]);await writeFile(path.join(output,'report.json'),JSON.stringify({timestamp:new Date().toISOString(),checks,colors,errors},null,2));
} finally {await browser?.close();backend.stop();}
