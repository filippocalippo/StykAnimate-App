import {chromium} from './support/playwright.mjs';
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
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');const report=emptyDocument();
    report.keyframes=[100,200,300].map(x=>createFrame([createObject(report.figure_types[0],1,x,240)],5));
    styk.editor.load(report);styk.editor.selectFrame(1);styk.editor.select(1);styk.fit();
  });
  await mode('advanced');
  for(const [key,value] of [['root_x',420],['root_y',300],['rotation',45],['scale',125]])await numeric(key,value);
  check('Advanced inspector writes the whole pose into the layer sheet',await page.evaluate(()=>{
    const e=styk.editor,uid=e.selectedUid,id=e.layerForUid(uid),
      keys=e.report._styk.layerSheet.tracks[id].keys;
    return e.evaluatedFrame.objects[0].root_x===420&&e.evaluatedFrame.objects[0].root_y===300
      &&e.evaluatedFrame.objects[0].scale===1.25
      &&keys.some(key=>key.sourceTick===undefined&&key.tick===e.tick)
      &&e.animationChannels.length===0;
  }));
  check('Inspector omits per-property key controls',await page.evaluate(()=>
    !document.querySelector('[data-property-key],[data-property-nav],.property-key-controls')));
  await mode('simple');await numeric('root_x',460);
  check('Filmstrip inspector edits the same layer key',await page.evaluate(()=>{
    const e=styk.editor;return e.evaluatedFrame.objects[0].root_x===460&&e.animationChannels.length===0;
  }));
  const snapshot=await page.evaluate(()=>JSON.stringify(styk.editor.report._styk.layerSheet));
  for(let i=0;i<3;i++){await mode('advanced');await mode('simple');}
  check('Repeated timeline mode switches retain the layer sheet exactly',snapshot===await page.evaluate(()=>JSON.stringify(styk.editor.report._styk.layerSheet)));
  await mode('advanced');
  check('Advanced agrees with the filmstrip edit',await page.evaluate(()=>styk.editor.evaluatedFrame.objects[0].root_x===460&&styk.editor.evaluatedFrame.objects[0].scale===1.25));
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');const report=emptyDocument();
    report.keyframes=[createFrame([createObject(report.figure_types[0],1,100,240)],5)];
    styk.editor.load(report);styk.editor.select(null);styk.fit();
  });
  await page.evaluate(()=>{const e=styk.editor;e.seek(0);e.setSceneColor(0xffff0000);e.sheetAppendFrame({duration:4});});
  await page.evaluate(()=>{const e=styk.editor;e.seek(e.totalTicks-1);e.setSceneColor(0xff0000ff);e.seek(2);});
  check('Scene sheet keys hold their authored color until the next key',await page.evaluate(()=>{
    const e=styk.editor;return e.evaluatedFrame._stykBackgroundColor===0xffff0000
      &&e.report._styk.layerSheet.tracks.scene.keys.some(key=>key.sourceTick===undefined);
  }));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await mkdir('artifacts/timeline-sync-properties',{recursive:true});
  const screenshot=await page.screenshot({path:'artifacts/timeline-sync-properties/interpolated-scene.png'});
  const pixel=await page.evaluate(async bytes=>{
    const image=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));
    const canvas=new OffscreenCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);
    return [...context.getImageData(700,400,1,1).data];
  },[...screenshot]);
  check('Rendered scene pixels show the held red key',pixel[0]>200&&pixel[1]<60&&pixel[2]<60);
  await mode('simple');await mode('advanced');
  check('Scene keys survive another mode round trip',await page.evaluate(()=>{
    const e=styk.editor;e.seek(2);return e.evaluatedFrame._stykBackgroundColor===0xffff0000;
  }));
  assert.deepEqual(errors,[]);await writeFile('artifacts/timeline-sync-properties/report.json',JSON.stringify({checks,pixel,errors},null,2));
} finally {await browser.close();}
