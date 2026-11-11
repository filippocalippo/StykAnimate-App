import assert from 'node:assert/strict';
import {chromium} from './support/playwright.mjs';
import {writeFile} from 'node:fs/promises';

const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[],checks={};
const output=process.argv[2]?'artifacts/layer-ownership-supplied':'artifacts/layer-ownership-browser';
page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(30000);
try{
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs'),{movieclipFigure}=await import('/src/movieclips.mjs'),{presencePlayback}=await import('/tests/support/movieclip-playback.mjs');
    const source=emptyDocument(),report=emptyDocument(),clip=movieclipFigure(2,'Motion',source,{duration:1});report.figure_types.push(clip);
    report.keyframes=[0,10,20].map(x=>createFrame([createObject(report.figure_types[0],1,200+x,200),createObject(report.figure_types[0],2,400+x,200),createObject(clip,7,600+x,200,{_stykMovieclip:presencePlayback()})],10));
    styk.settingsUI.commit({timelineMode:'advanced'});const e=styk.editor;e.load(report);
    e.createLayer('Destination');e.assignFiguresToLayer([2],'layer-2');e.sheetInsertKey(['layer-1','layer-2'],0);e.sheetInsertFrames(['layer-2'],5,3);
    window.sampleOwnership=editor=>{const tick=editor.tick,frames=[];for(let t=0;t<editor.totalTicks;t++){editor.seek(t);frames.push(editor.evaluatedFrame.objects.map(o=>[o.unique_id,o.root_x,o.root_y,o._movieclipSample??null]).sort((a,b)=>a[0]-b[0]));}editor.seek(tick);return frames;};
    window.expectedMotion=sampleOwnership(e);e.seek(0);e.select(7);styk.fit();
  });
  await page.getByLabel('Figure layer',{exact:true}).waitFor();
  await page.evaluate(()=>{window.beforeMove=JSON.stringify(styk.editor.serialize());});
  await page.getByLabel('Figure layer',{exact:true}).selectOption('layer-2');
  await page.waitForFunction(()=>styk.editor.layerForUid(7)==='layer-2');
  assert.equal(await page.evaluate(()=>JSON.stringify(sampleOwnership(styk.editor))===JSON.stringify(expectedMotion)),true);
  await page.keyboard.press('Control+z');await page.waitForFunction(()=>styk.editor.layerForUid(7)==='layer-1');
  assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())===beforeMove),true);
  await page.keyboard.press('Control+y');await page.waitForFunction(()=>styk.editor.layerForUid(7)==='layer-2');checks.inspectorMoveAndHistory=true;
  await page.getByRole('button',{name:'New layer',exact:true}).click();
  await page.evaluate(()=>{const e=styk.editor;e.seek(5);e.selectSheetLayer('layer-3');styk.actions['add-figure']();});
  assert.equal(await page.evaluate(()=>styk.editor.layerForUid(styk.editor.selectedUid)),'layer-3');checks.newLayerInsertion=true;
  await page.evaluate(()=>styk.timeline.deleteLayer());
  await page.waitForFunction(()=>!styk.editor.getLayer('layer-3'));checks.timelineDeletion=true;

  if(process.argv[2]){
    await page.evaluate(()=>styk.editor.markSaved());
    await page.locator('#file-input').setInputFiles(process.argv[2]);
    await page.waitForFunction(()=>styk.editor.report.figure_types.some(f=>f._styk?.movieclip)&&styk.editor.report._styk.layers.order.length>=3,null,{timeout:120000});
    checks.suppliedFile=await page.evaluate(async()=>{
      const e=styk.editor,layer=e.layers.find(l=>l.kind==='layer'&&!e.getLayerFigureUids(l.id).length),figure=e.report.figure_types.find(f=>f._styk?.movieclip);
      if(!layer||!figure)throw new Error('The supplied regression needs an empty layer and movieclip.');
      e.seek(5);e.selectSheetLayer(layer.id);const before=e.serialize();e.addFigure(figure.figure_type_id);const uid=e.selectedUid;
      e.seek(5);if(e.layerForUid(uid)!==layer.id||!e.evaluatedFrame.objects.some(o=>o.unique_id===uid))throw new Error('Insertion was lost');
      e.undo();if(JSON.stringify(e.serialize())!==JSON.stringify(before))throw new Error('Undo changed the source');e.redo();
      return {layer:layer.id,uid,tick:5};
    });
  }
  checks.binary=await page.evaluate(async()=>{
    const {DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs'),{ pageEditor }=await import('/tests/support/page-editor.mjs');
    const e=styk.editor,expected=sampleOwnership(e),owners=e.report._styk.layers.assignments,exporter=new DocumentExporter(),importer=new ImportClient();
    try{
      const blob=await exporter.export(e.report,{format:'styk',name:'ownership-regression'}),result=await importer.importFile(new File([blob],'ownership-regression.styk'));
      const reopened=pageEditor({demo:false,layerTimeline:true}).load(result.document);
      if(JSON.stringify(sampleOwnership(reopened))!==JSON.stringify(expected))throw new Error('Binary reload changed the animation');
      if(JSON.stringify(reopened.report._styk.layers.assignments)!==JSON.stringify(owners))throw new Error('Binary reload changed ownership');
      e.seek(5);styk.fit();return {bytes:blob.size,ticks:expected.length};
    }finally{exporter.dispose();importer.dispose();}
  });
  assert.deepEqual(errors,[]);await page.screenshot({path:output+'.png'});
  await writeFile(output+'.json',JSON.stringify({checks,errors},null,2));console.log('PASS',JSON.stringify(checks));
}finally{await browser.close();}
