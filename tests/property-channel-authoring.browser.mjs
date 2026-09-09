import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
const check=(label,value)=>{assert.ok(value,label);checks.push(label);console.log('PASS',label);};
const mode=async value=>{
  await page.evaluate(()=>styk.settingsUI.open('interface'));
  await page.locator(`[data-setting="timelineMode"][value="${value}"]`).check();await page.keyboard.press('Escape');
  await page.waitForFunction(value=>styk.state.settings.timelineMode===value,value);
};
try {
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await mode('advanced');
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');const report=emptyDocument();
    report.keyframes=[100,200,300].map(x=>createFrame([createObject(report.figure_types[0],1,x,200)],5));
    styk.editor.load(report);styk.editor.select(null);styk.fit();
  });
  await page.waitForFunction(()=>styk.timeline.tracks.some(row=>row.kind==='camera')&&styk.timeline.tracks.some(row=>row.kind==='scene'));
  check('No selection displays Scene and Camera property rows without Pose rows',await page.evaluate(()=>{
    const rows=styk.timeline.tracks;return rows.some(row=>row.target?.kind==='camera'&&row.property==='x')&&rows.some(row=>row.target?.kind==='scene'&&row.property==='color')&&!rows.some(row=>row.property==='pose');
  }));
  await mkdir('artifacts/property-channels',{recursive:true});
  await page.screenshot({path:'artifacts/property-channels/scene-camera.png'});
  await page.evaluate(()=>styk.editor.select(1));
  const opacity=page.locator('input[data-property="figure_opacity"]');await opacity.waitFor();
  await opacity.fill('40');await opacity.press('Enter');
  check('Inspector opacity creates a property curve without a Pose key',await page.evaluate(()=>{
    const e=styk.editor;return e.animationChannels.some(c=>c.property==='opacity')&&!e.animationChannels.some(c=>c.property==='pose')&&e.evaluatedFrame.objects[0].field28===153;
  }));
  await page.locator('input[data-property="outline_width"]').fill('8');await page.locator('input[data-property="outline_width"]').press('Enter');
  await page.evaluate(()=>styk.editor.updateFigureStyle({outlineColor:'#db4455'}));
  await page.waitForFunction(()=>document.querySelector('#outline-color')?.value==='#db4455');
  check('Appearance controls display evaluated outline color and width',await page.evaluate(()=>styk.editor.animationChannels.some(c=>c.property==='outlineWidth')));
  await page.screenshot({path:'artifacts/property-channels/figure.png'});
  await page.evaluate(()=>{
    const e=styk.editor;e.select(1,0);e.updateSegmentStyle({paint:{type:'linear',angle:20,stops:[{offset:0,color:[240,60,80],opacity:.8},{offset:1,color:[40,100,240],opacity:.3}]}});
  });
  await page.locator('input[data-property="segment_gradient_opacity"]').waitFor();
  await page.locator('input[data-property="segment_gradient_opacity"]').fill('60');await page.locator('input[data-property="segment_gradient_opacity"]').press('Enter');
  check('Gradient endpoint editing keeps separate color, opacity and layout channels',await page.evaluate(()=>{
    const e=styk.editor;return e.animationChannels.some(c=>c.property==='paint')&&e.animationChannels.some(c=>c.property==='gradientOpacity'&&c.keys.some(k=>k.value===.6))&&!e.animationChannels.some(c=>c.property==='pose');
  }));
  await page.screenshot({path:'artifacts/property-channels/gradient.png'});
  check('Gradient opacity labels describe colors rather than animation time',await page.evaluate(()=>{
    const text=document.querySelector('#inspector').textContent;return text.includes('Primary opacity')&&text.includes('Secondary opacity')&&!text.includes('Start opacity');
  }));
  check('Native STYK save and reopen retain property channels and evaluated appearance',await page.evaluate(async()=>{
    const {Editor}=await import('/src/editor.mjs');
    const {DocumentExporter}=await import('/src/document-export.mjs');
    const {ImportClient}=await import('/src/import-client.mjs');
    const {resolveInstanceFigure}=await import('/src/animation-style.mjs');
    const e=new Editor({demo:false,propertyChannels:true}).load(styk.editor.serialize());e.select(1);
    e.addPolygon([0,1,2]);e.updatePolygon(0,{color:'#00ff88',opacity:.4});
    e.setCameraValues({x:45,scale:1.5});e.setSceneColor(0xff224466);
    const exporter=new DocumentExporter(),importer=new ImportClient();
    try {
      const blob=await exporter.export(e.report,{format:'styk'});
      const imported=await importer.importFile(new File([blob],'property-roundtrip.styk'));
      const reopened=new Editor({demo:false,propertyChannels:true}).load(imported.document);reopened.select(1);
      const figure=resolveInstanceFigure(reopened.figure,reopened.object);
      return JSON.stringify(reopened.animationChannels)===JSON.stringify(e.animationChannels)
        && figure.segments[0].secondary.a===102 && figure.segments[0].secondary.rgb.join(',')==='40,100,240'
        && figure.polyfills[0].color_rgb.join(',')==='0,255,136'
        && reopened.evaluatedFrame.camera.x===45 && reopened.evaluatedFrame.camera.scale===1.5
        && reopened.evaluatedFrame._stykBackgroundColor===0xff224466;
    } finally {exporter.dispose();importer.dispose();}
  }));
  await mode('simple');
  await page.evaluate(()=>{
    const e=styk.editor;e.selectFrame(1);e.select(1,0);
    e.updateSegmentStyle({paint:{type:'linear',angle:20,stops:[{offset:0,color:[240,60,80],opacity:.8},{offset:1,color:[40,100,240],opacity:.3}]}});
  });
  for(const [key,value] of [['segment_opacity','35'],['segment_gradient_opacity','65']]) {
    const input=page.locator(`input[data-property="${key}"]`);await input.fill(value);await input.press('Enter');
  }
  await page.locator('.styk-simple-update').click();await mode('advanced');
  check('Simple gradient controls save independent primary and secondary opacity keys',await page.evaluate(()=>{
    const e=styk.editor,channels=e.animationChannels.filter(c=>c.target.kind==='segment');
    return channels.some(c=>c.property==='opacity'&&c.keys.some(k=>k.tick===5&&k.value===.35))
      && channels.some(c=>c.property==='gradientOpacity'&&c.keys.some(k=>k.tick===5&&k.value===.65))&&!e.animationChannels.some(c=>c.property==='pose');
  }));
  await mode('simple');
  await page.evaluate(()=>{const e=styk.editor;e.selectFrame(2);e.select(1);e.beginFrameDraft({mode:'add'});});
  await page.locator('input[data-property="figure_opacity"]').fill('20');await page.locator('input[data-property="figure_opacity"]').press('Enter');
  await page.locator('.styk-simple-update').click();await mode('advanced');
  check('Simple Add preserves explicit opacity keys in Advanced',await page.evaluate(()=>{
    const e=styk.editor,c=e.animationChannel({kind:'figure',uid:1},'opacity');return e.evaluatedFrame.objects[0].field28===204&&c.keys.some(k=>k.tick===e.tick&&!k.passthrough);
  }));
  await page.evaluate(()=>styk.editor.select(null));
  await page.waitForFunction(()=>styk.timeline.tracks.filter(row=>row.depth===0).map(row=>row.kind).join(',')==='scene,camera');
  check('Clearing selection restores Scene and Camera after switching timelines',true);
  check('Inspector contents fit within the panel',await page.evaluate(()=>{const panel=document.querySelector('#inspector');return panel.scrollWidth<=panel.clientWidth+1;}));
  assert.deepEqual(errors,[]);await writeFile('artifacts/property-channels/report.json',JSON.stringify({checks,errors},null,2));
} finally {await browser.close();}
