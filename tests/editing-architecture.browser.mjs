import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(120000);
try {
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  const dom=await page.evaluate(async()=>{
    const {updateInspectorDOM}=await import('/src/inspector-dom.mjs');
    const root=document.createElement('div');document.body.append(root);
    const html=n=>`<details data-section="test"><summary>Figure</summary><input data-property="x" value="${n}"><select><option value="a" ${n===1?'selected':''}>A</option><option value="b" ${n===2?'selected':''}>B</option></select><span>${n}</span></details>`;
    updateInspectorDOM(root,html(1));const details=root.firstChild,input=root.querySelector('input'),select=root.querySelector('select');
    details.open=true;input.focus();input.value='typing';updateInspectorDOM(root,html(2),{preserveDisclosure:true});
    const focused=document.activeElement===input&&input.value==='typing',retained=root.firstChild===details&&root.querySelector('select')===select;
    input.blur();updateInspectorDOM(root,html(2),{preserveDisclosure:true});
    const value=input.value==='2'&&select.value==='b'&&details.open;
    updateInspectorDOM(root,html(1));const reset=!details.open;root.remove();return {focused,retained,value,reset};
  });
  assert.ok(Object.values(dom).every(Boolean),JSON.stringify(dom));console.log('PASS inspector node identity, focus, values and disclosure');
  const roundtrip=await page.evaluate(async()=>{
    const {Editor}=await import('/src/editor.mjs'),{emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
    const {DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs');
    const {buildGeometry}=await import('/src/pivot/geometry.mjs');
    const report=emptyDocument(),figure=report.figure_types[0];
    report.keyframes=Array.from({length:80},(_,frame)=>createFrame(Array.from({length:30},(_,slot)=>createObject(figure,slot+1,200+frame,250,
      {join:slot?{target_object_slot:slot-1,target_handle_id:1}:null})),3));
    const editor=new Editor({demo:false,propertyChannels:true}).load(report);editor.select(1);
    editor.beginTranslationDrag();editor.moveSelection(5,3);editor.commitDrag();
    editor.moveAnimationKeys(editor.animationChannels.map(c=>({channelId:c.id,keyIds:[c.keys[1].id]})),1);
    const exporter=new DocumentExporter(),importer=new ImportClient();
    try {
      const blob=await exporter.export(editor.report,{format:'styk',name:'architecture-roundtrip'});
      const imported=await importer.importFile(new File([blob],'architecture-roundtrip.styk'));
      const reopened=new Editor({demo:false,propertyChannels:true}).load(imported.document);
      const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
      const same=canonical(reopened.report._styk.animation)===canonical(editor.report._styk.animation);
      let exact=true;
      for(const tick of [0,1,3,4,8,239]){
        editor.seek(tick);reopened.seek(tick);
        const points=e=>JSON.stringify([...buildGeometry(e.report,e.evaluatedFrame).objects].map(([slot,g])=>[slot,[...g.joints]]));
        exact&&=points(editor)===points(reopened);
      }
      window.architectureReport=editor.serialize();
      return {same,exact,sequences:new Set(reopened.animationChannels.map(c=>c.keys)).size,bytes:blob.size};
    }finally{exporter.dispose();importer.dispose();}
  });
  assert.equal(roundtrip.same,true,JSON.stringify(roundtrip));assert.equal(roundtrip.exact,true,JSON.stringify(roundtrip));assert.equal(roundtrip.sequences,1);
  console.log('PASS native binary save/reopen, shared sequences, retiming and exact evaluated joins',roundtrip);
  await page.evaluate(()=>{styk.settingsUI.commit({timelineMode:'advanced'});styk.editor.load(architectureReport);styk.editor.markSaved();styk.fit();});
  await page.waitForFunction(()=>!styk.state.editablePreparing&&styk.state.renderer.last?.report===styk.editor.report);
  await page.evaluate(()=>{styk.editor.selectFrame(20);styk.editor.selectFrame(50);styk.editor.selectFrame(2);});
  await page.waitForFunction(()=>!styk.state.editablePreparing&&styk.performance().editingPresentation?.tick===styk.editor.tick);
  const seek=await page.evaluate(async()=>{
    const {buildGeometry}=await import('/src/pivot/geometry.mjs'),e=styk.editor,r=styk.state.renderer;
    const before=r.lastGeometry.drawables.map(({obj,fig,...item})=>({...item,obj:obj.unique_id,fig:fig.figure_type_id}));
    const expected=buildGeometry(e.report,e.evaluatedFrame).drawables.map(({obj,fig,...item})=>({...item,obj:obj.unique_id,fig:fig.figure_type_id}));
    return {frame:e.frameIndex,exact:JSON.stringify(before)===JSON.stringify(expected),leases:r.rasterCache.leasedBytes??0};
  });
  assert.equal(seek.frame,2);assert.equal(seek.exact,true);console.log('PASS superseded frame requests publish the latest exact geometry');
  await page.evaluate(()=>document.querySelector('#play-button').click());
  await page.waitForFunction(()=>styk.state.playing&&styk.state.playbackPacket);
  await page.evaluate(()=>document.querySelector('#play-button').click());
  await page.waitForFunction(()=>!styk.state.editablePreparing&&!styk.state.playing);
  await page.evaluate(()=>{
    const e=styk.editor;e.select(1);e.beginTranslationDrag();e.moveSelection(2,1);e.commitDrag();
  });
  await page.waitForFunction(()=>styk.performance().playback.loadKind==='patch',null,{timeout:10000}).catch(async error=>{throw Error(`${error.message} ${JSON.stringify(await page.evaluate(()=>styk.performance().playback))}`);});
  await page.evaluate(()=>styk.editor.undo());
  await page.waitForFunction(()=>styk.performance().playback.loadKind==='patch');
  await page.evaluate(()=>styk.editor.markSaved());
  await page.evaluate(()=>styk.settingsUI.commit({timelineMode:'simple'}));
  await page.evaluate(()=>{styk.editor.selectFrame(15);styk.editor.selectFrame(3);});
  await page.waitForFunction(()=>!styk.state.editablePreparing&&styk.performance().editingPresentation?.tick===styk.editor.tick);
  const simple=await page.evaluate(()=>({frame:styk.editor.frameIndex,preparation:styk.performance().editablePreparation}));
  assert.equal(simple.frame,3);assert.equal(simple.preparation.completed,true);assert.notEqual(simple.preparation.cancelled,true);
  console.log('PASS Simple working-frame notifications retain cooperative preparation');
  assert.deepEqual(errors,[]);console.log('PASS edit and animation undo use incremental worker updates');
} finally {await browser.close();}
