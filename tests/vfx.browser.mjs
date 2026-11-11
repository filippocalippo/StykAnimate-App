import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(process.env.STYK_TEST_URL||'http://127.0.0.1:47832');
 await page.waitForFunction(()=>window.styk?.ready,{timeout:60000});
 const saved=await page.evaluate(async()=>{
  const { pageEditor }=await import('/tests/support/page-editor.mjs'),{emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),{DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs');
  const doc=emptyDocument();doc.keyframes=[createFrame([createObject(doc.figure_types[0],1,200,200)],20)];const e=styk.editor.load(doc);
  e.select(1);const figure={kind:'figure',uid:1},node={kind:'segment',uid:1,figureTypeId:e.object.figure_type_id,handleId:e.figure.segments[0].segment_id},scene={kind:'scene'};
  e.addVfx(figure,'glow');e.addVfx(node,'outline');e.addVfx(scene,'noise');e.sheetInsertKey([e.layerForUid(1)],10);e.seek(10);const id=e.vfxEffects(figure)[0].id;e.setVfxParameter(figure,id,'radius',30);
  e.setVfxParameter(figure,id,'color',{type:'radial',angle:30,stops:[{offset:0,color:[255,80,40],opacity:.4},{offset:1,color:[40,100,255],opacity:1}]});
  const exporter=new DocumentExporter(),importer=new ImportClient();const sample=editor=>[0,5,10,19].map(t=>{editor.seek(t);return [editor.vfxEffects(figure),editor.vfxEffects(node),editor.vfxEffects(scene)];});
  try{const expected=JSON.stringify(sample(e)),blob=await exporter.export(e.report,{format:'styk',name:'VFX roundtrip',revision:e.revision}),imported=await importer.importFile(new File([blob],'vfx.styk')),reopened=pageEditor({demo:false}).load(imported.document);let blocked=false;try{await exporter.export(e.report,{format:'piv',revision:e.revision});}catch(error){blocked=/cannot preserve VFX/.test(error.message);}
   return {bytes:blob.size,identical:expected===JSON.stringify(sample(reopened)),blocked};
  }finally{exporter.dispose();importer.dispose();}
 });
 assert.ok(saved.identical,'binary project roundtrip must preserve all sampled VFX');assert.ok(saved.blocked,'lossy Pivot export must fail explicitly');console.log('Native roundtrip',saved);
 await page.locator('[data-vfx-tab="vfx"]').click();
 await page.selectOption('#vfx-scope','scene');
 
 await page.locator('[data-vfx-action="add"]').click();
 await page.locator('.vfx-catalog [data-choice="noise"]').click();
 await page.getByRole('spinbutton',{name:'Noise Amount'}).fill('25');
 await page.getByRole('spinbutton',{name:'Noise Amount'}).press('Enter');
 assert.equal(await page.evaluate(()=>window.styk.editor.sampleVfxClip(styk.vfx.selectedClip)[0]?.params.amount),.25);
 const beforeDrag=await page.evaluate(()=>({history:styk.editor._undo.length,keys:styk.editor.report._styk.layerSheet.tracks.scene.keys.length}));
 // The drag's value rounds with the slider's width (its 8px thumb): one splitter step widens the
 // inspector past the wide tier's 288px so the slider maps the middle half of its track steadily.
 await page.getByRole('separator',{name:'Resize properties panel'}).focus();await page.keyboard.press('ArrowLeft');
 const slider=page.getByRole('slider',{name:'Noise Amount slider'}),box=await slider.boundingBox();
 await page.mouse.move(box.x+box.width*.25,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width*.75,box.y+box.height/2,{steps:12});await page.mouse.up();
 const dragged=await page.evaluate(()=>({amount:styk.editor.sampleVfxClip(styk.vfx.selectedClip)[0].params.amount,history:styk.editor._undo.length,keys:styk.editor.report._styk.layerSheet.tracks.scene.keys.length}));
 assert.ok(dragged.amount>.7&&dragged.amount<.8);assert.equal(dragged.history,beforeDrag.history+1);assert.equal(dragged.keys,beforeDrag.keys);
 await page.evaluate(()=>styk.editor.undo());
 const label=page.locator('#vfx-panel [data-property-scrub]').filter({hasText:/^Amount$/}),labelBox=await label.boundingBox();
 await page.mouse.move(labelBox.x+10,labelBox.y+labelBox.height/2);await page.mouse.down();await page.mouse.move(labelBox.x+35,labelBox.y+labelBox.height/2,{steps:8});await page.mouse.up();
 assert.equal(await page.evaluate(()=>styk.editor.sampleVfxClip(styk.vfx.selectedClip)[0].params.amount),.5);
 assert.equal(await page.locator('#vfx-panel [data-property-key]').count(),0);
 await page.getByRole('tab',{name:'Library',exact:true}).click();assert.equal(await page.locator('#vfx-panel').isVisible(),false);
 await page.getByRole('tab',{name:'VFX',exact:true}).click();assert.equal(await page.locator('#inspector').isVisible(),false);
 await fs.mkdir('artifacts/vfx',{recursive:true});await page.screenshot({path:'artifacts/vfx/inspector.png'});
 await page.evaluate(()=>{const e=styk.editor;e.select(e.evaluatedFrame.objects[0].unique_id,1);});
 await page.waitForFunction(()=>styk.vfx.targets()[0]?.kind==='segment');
 await page.locator('[data-vfx-action="add"]').click();await page.locator('.vfx-catalog [data-choice="glow"]').click();
 assert.equal(await page.evaluate(()=>styk.editor.sampleVfxClip(styk.vfx.selectedClip)[0].type),'glow');
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await page.screenshot({path:'artifacts/vfx/inspector-dark.png'});
 assert.deepEqual(errors,[]);console.log('VFX browser checks passed');
}finally{await browser.close();}
