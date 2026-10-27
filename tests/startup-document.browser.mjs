import {chromium} from './support/playwright.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const out=path.resolve('artifacts/blue-startup');await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try {
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');
  await page.waitForFunction(()=>window.styk?.ready);
  const snapshot=()=>page.evaluate(()=>({name:styk.editor.figure.name,spatial:Boolean(styk.editor.figure._styk?.spatialMesh||styk.editor.figure.segments.some(s=>s._stykRig?.spatial)),frames:styk.editor.report.keyframes.length,objects:styk.editor.frame.objects.length,ticks:styk.editor.totalTicks,dirty:styk.editor.dirty,
    tracks:Object.fromEntries(Object.entries(styk.editor.report._styk.layerSheet.tracks).map(([id,t])=>[id,{end:t.end,keys:t.keys.map(k=>k.tick)}]))}));
  const expected={name:'Blue',spatial:false,frames:1,objects:1,ticks:10,dirty:false,tracks:{scene:{end:10,keys:[0]},camera:{end:10,keys:[0]},'layer-1':{end:10,keys:[0]}}};
  assert.deepEqual(await snapshot(),expected);
  const render=async name=>{
    const png=await page.evaluate(async()=>{
      const {pageExporter}=await import('/tests/support/page-export.mjs');
      const r=pageExporter({width:960,height:540});
      try{await r.load(styk.editor.report);return (await r.renderTick(0)).toDataURL().split(',')[1];}finally{r.dispose();}
    });await writeFile(path.join(out,`${name}.png`),Buffer.from(png,'base64'));
  };
  await render('default');await page.screenshot({path:path.join(out,'editor.png')});
  for(const mode of ['simple','advanced']){
    await page.evaluate(mode=>styk.settingsUI.commit({timelineMode:mode}),mode);
    await page.waitForFunction(mode=>styk.state.settings.timelineMode===mode,mode);
    assert.deepEqual(await snapshot(),expected);
    assert.equal(await page.evaluate(()=>{styk.editor.seek(9);return styk.editor.evaluatedFrame.objects.length;}),1);
    await page.screenshot({path:path.join(out,`${mode}-frame-10.png`)});
    await page.evaluate(()=>styk.editor.seek(0));
  }
  // Exercise the actual canvas hit testing and pointer posing path at the wrist.
  const pointer=await page.evaluate(()=>{
    const e=styk.editor,id=e.figure.segments.find(s=>s.name==='Left forearm').segment_id,
      p=e.geometry.objects.get(0).joints.get(id),r=document.querySelector('#viewport').getBoundingClientRect(),v=styk.state.view;
    return {x:r.x+v.x+p.x*v.scale,y:r.y+v.y+p.y*v.scale,angles:[...e.object.angles]};
  });
  await page.mouse.move(pointer.x,pointer.y);await page.mouse.down();
  await page.mouse.move(pointer.x+45,pointer.y-45,{steps:8});await page.mouse.up();
  assert.notDeepEqual(await page.evaluate(()=>[...styk.editor.object.angles]),pointer.angles);
  await render('posed');
  await page.evaluate(()=>{styk.editor.undo();styk.editor.markSaved();styk.actions.new();});
  assert.deepEqual(await snapshot(),expected);
  const bytes=await page.evaluate(async()=>{
    const {DocumentExporter}=await import('/src/document-export.mjs');const x=new DocumentExporter();
    try{return Array.from(new Uint8Array(await(await x.export(styk.editor.report,{name:'Blue'})).arrayBuffer()));}finally{x.dispose();}
  });const saved=path.join(out,'Blue.styk');await writeFile(saved,Buffer.from(bytes));
  await page.locator('#file-input').setInputFiles(saved);await page.waitForFunction(()=>styk.editor.name==='Blue');
  assert.deepEqual(await snapshot(),expected);await render('reopened');
  assert.deepEqual(errors,[]);await writeFile(path.join(out,'verification.json'),JSON.stringify({startup:true,new:true,tenFrameHolds:true,timelineModes:['simple','advanced'],pointerPosing:true,saveReopen:true,errors},null,2));
}catch(error){
  await page.screenshot({path:path.join(out,'failure.png')});
  console.error('Browser errors:',errors);throw error;
}finally{await browser.close();}
