import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';

await mkdir('artifacts/figure-paste',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(30000);
const settle=async()=>{
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await page.waitForFunction(()=>!styk.state.editablePreparing&&styk.state.renderer.last?.report===styk.editor.report);
  await page.evaluate(()=>styk.state.renderer.device?.queue.onSubmittedWorkDone());
};
try {
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  for(const mode of ['simple','advanced']){
    await page.evaluate(async mode=>{
      const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
      const report=emptyDocument(),figure=report.figure_types[0];
      report.keyframes=Array.from({length:40},(_,i)=>createFrame([
        createObject(figure,1,200+i,250),createObject(figure,2,200+i,250,{join:{target_object_slot:0,target_unique_id:1,target_handle_id:1}}),
        createObject(figure,3,500,270)],5));
      styk.settingsUI.commit({timelineMode:mode});styk.editor.load(report);styk.editor.selectConnected(1);styk.fit();
      document.activeElement?.blur();
    },mode);await settle();
    await page.keyboard.press('Control+c');
    assert.equal(await page.evaluate(()=>styk.editor._selectionClipboard.objects.length),2);
    await page.evaluate(()=>{styk.editor.seek(7);document.activeElement?.blur();});await settle();
    const before=await page.evaluate(()=>({report:JSON.stringify(styk.editor.serialize()),history:styk.editor._undo.length}));
    await page.keyboard.press('Control+v');await settle();
    const result=await page.evaluate(async()=>{
      const {buildGeometry}=await import('/src/pivot/geometry.mjs'),e=styk.editor;
      const signature=g=>g.drawables.map(({obj,fig,...shape})=>({...shape,obj:obj.unique_id,fig:fig.figure_type_id}));
      return {count:e.selectedObjects.length,total:e.evaluatedFrame.objects.length,history:e._undo.length,undoLabel:e.undoLabel,
        geometry:JSON.stringify(signature(styk.state.renderer.lastGeometry))===JSON.stringify(signature(buildGeometry(e.report,e.evaluatedFrame))),
        report:JSON.stringify(e.serialize())};
    });
    assert.equal(result.count,2);assert.equal(result.total,5);assert.equal(result.history,before.history+1);
    assert.equal(result.undoLabel,'Paste figures');assert.ok(result.geometry);
    await page.keyboard.press('Control+z');await settle();assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),before.report);
    await page.keyboard.press('Control+y');await settle();assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),result.report);
    await page.screenshot({path:`artifacts/figure-paste/${mode}-keyboard.png`});
    console.log(`PASS ${mode}: keyboard copy/paste between frames, exact rendered geometry and one undo/redo`);
  }
  const saved=await page.evaluate(async()=>{
    const {DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs'),{Editor}=await import('/src/editor.mjs');
    const exporter=new DocumentExporter(),importer=new ImportClient(),e=styk.editor;
    try{
      const blob=await exporter.export(e.report,{format:'styk',name:'figure-paste'});
      const imported=await importer.importFile(new File([blob],'figure-paste.styk'));
      const reopened=new Editor({demo:false,layerTimeline:true}).load(imported.document);reopened.seek(e.tick);
      const clean=editor=>editor.evaluatedFrame.objects.map(o=>({uid:o.unique_id,figure:o.figure_type_id,join:o.join,angles:o.angles,x:o.root_x,y:o.root_y}));
      return JSON.stringify(clean(reopened))===JSON.stringify(clean(e));
    }finally{exporter.dispose();importer.dispose();}
  });
  assert.ok(saved);assert.deepEqual(errors,[]);console.log('PASS binary save/reopen retains pasted poses, IDs and attachments');
  await page.evaluate(()=>styk.editor.markSaved());
}finally{await browser.close();}
