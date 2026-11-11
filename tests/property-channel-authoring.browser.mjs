import {chromium} from './support/playwright.mjs';
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
  check('The sheet exposes Camera and Scene rows without per-property rows',await page.evaluate(()=>{
    const rows=styk.timeline.tracks;return rows.some(row=>row.kind==='camera')&&rows.some(row=>row.kind==='scene')&&rows.every(row=>row.property===undefined);
  }));
  await mkdir('artifacts/property-channels',{recursive:true});
  await page.screenshot({path:'artifacts/property-channels/scene-camera.png'});
  await page.evaluate(()=>styk.editor.select(1));
  const opacity=page.locator('input[data-property="figure_opacity"]');await opacity.waitFor();
  await opacity.fill('40');await opacity.press('Enter');
  check('Inspector opacity writes a layer pose key, not a scalar channel',await page.evaluate(()=>{
    const e=styk.editor;return e.animationChannels.length===0&&e.evaluatedFrame.objects[0].field28===153;
  }));
  check('The inspector omits figure outline controls',await page.evaluate(()=>!document.querySelector('input[data-property="outline_width"],input[data-property="outline_opacity"],#outline-color')));
  await page.evaluate(()=>styk.editor.updateFigureStyle({outlineWidth:8,outlineColor:'#db4455'}));
  check('Figure style edits produce evaluated outline color and width',await page.evaluate(async()=>{
    const {resolveInstanceFigure}=await import('/src/animation-style.mjs');
    const style=resolveInstanceFigure(styk.editor.figure,styk.editor.object).segment_decode?.global_style;
    return style?.outline_thickness===8&&style.rgb.join(',')==='219,68,85';
  }));
  await page.screenshot({path:'artifacts/property-channels/figure.png'});
  await page.evaluate(()=>{
    const e=styk.editor;e.select(1,0);e.updateSegmentStyle({paint:{type:'linear',angle:20,stops:[{offset:0,color:[240,60,80],opacity:.8},{offset:1,color:[40,100,240],opacity:.3}]}});
  });
  // The gradient's end stop is edited in the paint control: its opacity is the style command's.
  await page.evaluate(()=>styk.editor.updateSegmentStyle({paint:{type:'linear',angle:20,stops:[{offset:0,color:[240,60,80],opacity:.8},{offset:1,color:[40,100,240],opacity:.6}]}}));
  check('Gradient endpoint editing writes the pose with the authored secondary opacity',await page.evaluate(()=>{
    const e=styk.editor,object=e.evaluatedFrame.objects.find(o=>o.unique_id===1);
    return e.animationChannels.length===0&&Object.values(object._stykStyle?.segments??{}).some(seg=>seg.gradientOpacity===.6);
  }));
  await page.screenshot({path:'artifacts/property-channels/gradient.png'});
  check('Native STYK save and reopen retain the layer sheet and evaluated appearance',await page.evaluate(async()=>{
    const { pageEditor }=await import('/tests/support/page-editor.mjs');
    const {DocumentExporter}=await import('/src/document-export.mjs');
    const {ImportClient}=await import('/src/import-client.mjs');
    const {resolveInstanceFigure}=await import('/src/animation-style.mjs');
    const e=pageEditor({demo:false,propertyChannels:true}).load(styk.editor.serialize());e.select(1);
    e.addPolygon([0,1,2]);e.updatePolygon(0,{color:'#00ff88',opacity:.4});
    e.setCameraValues({x:45,scale:1.5});e.setSceneColor(0xff224466);
    const exporter=new DocumentExporter(),importer=new ImportClient();
    try {
      const blob=await exporter.export(e.report,{format:'styk'});
      const imported=await importer.importFile(new File([blob],'property-roundtrip.styk'));
      const reopened=pageEditor({demo:false,propertyChannels:true}).load(imported.document);reopened.select(1);
      const figure=resolveInstanceFigure(reopened.figure,reopened.object);
      return JSON.stringify(reopened.report._styk.layerSheet)===JSON.stringify(e.report._styk.layerSheet)
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
  const segmentOpacity=page.locator('input[data-property="segment_opacity"]');await segmentOpacity.fill('35');await segmentOpacity.press('Enter');
  await page.evaluate(()=>styk.editor.updateSegmentStyle({paint:{type:'linear',angle:20,stops:[{offset:0,color:[240,60,80],opacity:.35},{offset:1,color:[40,100,240],opacity:.65}]}}));
  await page.locator('.sheet-add-frame').click();await mode('advanced');
  check('Simple appearance edits land in the same layer key at the selected frame',await page.evaluate(()=>{
    const e=styk.editor;e.seek(5);
    const segs=Object.values(e.evaluatedFrame.objects.find(o=>o.unique_id===1)._stykStyle?.segments??{});
    return e.animationChannels.length===0
      && segs.some(seg=>seg.opacity===.35)
      && segs.some(seg=>seg.gradientOpacity===.65);
  }));
  await mode('simple');
  await page.evaluate(()=>{const e=styk.editor;e.selectFrame(2);e.select(1);});
  await page.locator('input[data-property="figure_opacity"]').fill('20');await page.locator('input[data-property="figure_opacity"]').press('Enter');
  await page.locator('.sheet-add-frame').click();await mode('advanced');
  check('Simple Add preserves authored opacity in the shared sheet',await page.evaluate(()=>{
    const e=styk.editor;return e.animationChannels.length===0&&e.evaluatedFrame.objects[0].field28===204;
  }));
  await page.evaluate(()=>styk.editor.select(null));
  await page.waitForFunction(()=>styk.timeline.tracks.filter(row=>row.kind==='camera'||row.kind==='scene').length===2);
  check('Clearing selection keeps the fixed Camera and Scene rows',true);
  check('Inspector contents fit within the panel',await page.evaluate(()=>{const panel=document.querySelector('#inspector');return panel.scrollWidth<=panel.clientWidth+1;}));
  assert.deepEqual(errors,[]);await writeFile('artifacts/property-channels/report.json',JSON.stringify({checks,errors},null,2));
} finally {await browser.close();}
