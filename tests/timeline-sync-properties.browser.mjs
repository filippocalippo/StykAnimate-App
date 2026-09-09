import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
const check=(label,result)=>{assert.ok(result,label);checks.push(label);console.log('PASS',label);};
const mode=async mode=>{
  await page.evaluate(()=>styk.settingsUI.open('interface'));
  await page.locator(`[data-setting="timelineMode"][value="${mode}"]`).check();await page.keyboard.press('Escape');
  await page.waitForFunction(mode=>styk.state.settings.timelineMode===mode,mode);
};
const numeric=async(key,value)=>{const input=page.locator(`input[data-property="${key}"]`);await input.fill(String(value));await input.press('Enter');};
try {
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>styk.ready);
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');const report=emptyDocument();
    report.keyframes=[100,200,300].map(x=>createFrame([createObject(report.figure_types[0],1,x,240)],5));
    styk.editor.load(report);styk.editor.selectFrame(1);styk.editor.select(1);styk.fit();
  });
  await mode('advanced');
  for(const [key,value] of [['root_x',420],['root_y',300],['rotation',45],['scale',125]])await numeric(key,value);
  check('Advanced inspector stores position and rotation in Pose with only scale independent',await page.evaluate(()=>{
    const e=styk.editor;return e.evaluatedFrame.objects[0].root_x===420&&e.evaluatedFrame.objects[0].root_y===300
      &&e.animationChannels.some(c=>c.property==='pose')&&e.animationChannels.some(c=>c.property==='scale')
      &&!e.animationChannels.some(c=>c.target.kind==='figure'&&['x','y','rotation'].includes(c.property));
  }));
  check('Figure timeline and inspector omit separate position and rotation key controls',await page.evaluate(()=>
    !styk.timeline.tracks.some(row=>row.target?.kind==='figure'&&['x','y','rotation'].includes(row.property))
    &&!document.querySelector('[data-property-key="root_x"],[data-property-key="root_y"],[data-property-key="rotation"]')));
  await mode('simple');await numeric('root_x',460);await page.locator('.styk-simple-update').click();await mode('advanced');
  // Simple Update advances to the next frame. Inspect the frame just stored.
  await page.evaluate(()=>styk.editor.seek(5));
  check('Simple Update and Advanced agree on the edited Pose and scale',await page.evaluate(()=>styk.editor.evaluatedFrame.objects[0].root_x===460&&styk.editor.evaluatedFrame.objects[0].scale===1.25));
  const snapshot=await page.evaluate(()=>JSON.stringify(styk.editor.animationChannels));
  for(let i=0;i<3;i++){await mode('simple');await mode('advanced');}
  check('Repeated switches retain key identities and values',snapshot===await page.evaluate(()=>JSON.stringify(styk.editor.animationChannels)));
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');const report=emptyDocument();
    report.keyframes=[createFrame([createObject(report.figure_types[0],1,100,240)],5)];
    styk.editor.load(report);styk.editor.setSceneColor(0xffff0000);styk.editor.select(null);styk.fit();
  });
  await mode('simple');await page.evaluate(()=>{const e=styk.editor;e.beginFrameDraft({mode:'add'});e.setSceneColor(0xff0000ff);});
  await page.locator('.styk-simple-update').click();await mode('advanced');
  await page.evaluate(()=>{styk.editor.seek(2);styk.editor.select(null);});
  check('Simple Add produces an interpolated scene color visible in Advanced',await page.evaluate(()=>styk.editor.evaluatedFrame._stykBackgroundColor===0xff990066));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await mkdir('artifacts/timeline-sync-properties',{recursive:true});
  const screenshot=await page.screenshot({path:'artifacts/timeline-sync-properties/interpolated-scene.png'});
  const pixel=await page.evaluate(async bytes=>{
    const image=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));
    const canvas=new OffscreenCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);
    return [...context.getImageData(700,400,1,1).data];
  },[...screenshot]);
  check('Rendered scene pixels show the interpolated purple rather than a held endpoint',Math.abs(pixel[0]-153)<=1&&pixel[1]===0&&Math.abs(pixel[2]-102)<=1);
  await mode('simple');await mode('advanced');
  check('Scene color interpolation survives another mode round trip',await page.evaluate(()=>{styk.editor.seek(2);return styk.editor.evaluatedFrame._stykBackgroundColor===0xff990066;}));
  assert.deepEqual(errors,[]);await writeFile('artifacts/timeline-sync-properties/report.json',JSON.stringify({checks,pixel,errors},null,2));
} finally {await browser.close();}
