import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';

const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
const check=(label,value)=>{assert.ok(value,label);checks.push(label);console.log('PASS',label);};
const mode=async value=>{
  await page.evaluate(()=>styk.settingsUI.open('interface'));
  await page.locator(`[data-setting="timelineMode"][value="${value}"]`).check();
  await page.keyboard.press('Escape');
  await page.waitForFunction(value=>styk.state.settings.timelineMode===value,value);
};
try {
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');
  await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const report=emptyDocument();report.keyframes=[100,200,300].map(x=>createFrame([createObject(report.figure_types[0],1,x,240)],5));
    styk.editor.load(report);styk.editor.selectFrame(2);styk.editor.select(1);
    styk.editor.addAnimationKeys([{target:{kind:'figure',uid:1},property:'x',tick:0,value:100},
      {target:{kind:'figure',uid:1},property:'x',tick:10,value:300}]);
    styk.fit();
  });
  await mode('simple');
  check('Settings mounts Simple using the current Advanced pose',await page.evaluate(()=>styk.editor.evaluatedFrame.objects[0].root_x===300&&Boolean(document.querySelector('.styk-simple-timeline'))));
  await page.evaluate(async()=>{
    const {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit}=await import('/src/native-property-edit.mjs');
    const token=beginNativePropertyEdit(styk.editor,'root_x');previewNativePropertyEdit(token,420);commitNativePropertyEdit(token);
  });
  check('Simple marks a pose edit on an Advanced track as a working change',await page.evaluate(()=>styk.editor.frameDraft.dirty&&styk.editor.evaluatedFrame.objects[0].root_x===420));
  await page.locator('.styk-simple-update').click();
  await mode('advanced');
  check('Update carries the Simple pose into Advanced',await page.evaluate(()=>styk.editor.evaluatedFrame.objects[0].root_x===420&&!styk.editor.frameDraft));
  await page.evaluate(()=>styk.editor.undo());
  check('Advanced undo restores the pose from before the Simple edit',await page.evaluate(()=>styk.editor.evaluatedFrame.objects[0].root_x===300));
  await page.evaluate(()=>styk.editor.redo());
  await mode('simple');
  await page.evaluate(async()=>{
    styk.editor.beginFrameDraft({mode:'add'});
    const {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit}=await import('/src/native-property-edit.mjs');
    const token=beginNativePropertyEdit(styk.editor,'root_x');previewNativePropertyEdit(token,500);commitNativePropertyEdit(token);
  });
  await mkdir('artifacts/animation-mode-sync',{recursive:true});
  await page.waitForFunction(()=>document.querySelectorAll('.styk-simple-preview canvas').length===3);
  await page.screenshot({path:'artifacts/animation-mode-sync/simple.png'});
  await mode('advanced');
  check('Switching from a dirty Add stores a distinct frame and retains its source',await page.evaluate(async()=>{
    const e=styk.editor,{evaluatedFrame,timeline}=await import('/src/pivot/geometry.mjs');
    return e.report.keyframes.length===4&&e.evaluatedFrame.objects[0].root_x===500&&evaluatedFrame(e.report,2,0,timeline(e.report)[2].start).objects[0].root_x===420;
  }));
  await page.evaluate(()=>styk.editor.seek(styk.editor.totalTicks-1));
  check('The final playback tick holds the added pose',await page.evaluate(()=>styk.editor.evaluatedFrame.objects[0].root_x===500));
  for(let i=0;i<3;i++){await mode('simple');await mode('advanced');}
  check('Repeated mode switches retain frame count, clear obsolete ranges, and mount one timeline',await page.evaluate(()=>styk.editor.report.keyframes.length===4&&styk.state.rangeIndices.length===0&&styk.state.loopRange===null&&!document.querySelector('.styk-simple-timeline')));
  await page.screenshot({path:'artifacts/animation-mode-sync/advanced.png'});
  await mode('simple');
  await page.evaluate(async()=>{
    const e=styk.editor;e.report.auto_easing=true;e.setFramesDuration([1],20000);e.selectFrame(e.report.keyframes.length-1);e.select(1);
    e.beginFrameDraft({mode:'add'});
    const {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit}=await import('/src/native-property-edit.mjs');
    const token=beginNativePropertyEdit(e,'root_x');previewNativePropertyEdit(token,550);commitNativePropertyEdit(token);
    window.modeBefore={timeline:styk.timeline,identity:e._nextFrameIdentity,count:e.report.keyframes.length};
    styk.settingsUI.open('interface');
  });
  await page.locator('[data-setting="timelineMode"][value="advanced"]').click();
  await page.waitForSelector('.styk-settings-error');
  check('A rejected switch keeps the previous timeline, preferences, and working pose',await page.evaluate(()=>{
    const e=styk.editor;
    return styk.state.settings.timelineMode==='simple'&&styk.settingsUI.value.timelineMode==='simple'&&styk.timeline===modeBefore.timeline&&
      !styk.timeline.disposed&&e.report.keyframes.length===modeBefore.count&&e._nextFrameIdentity===modeBefore.identity&&e.frameDraft.dirty;
  }));
  assert.deepEqual(errors,[]);
  await writeFile('artifacts/animation-mode-sync/report.json',JSON.stringify({checks,errors},null,2));
} finally {await browser.close();}
