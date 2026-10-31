import assert from 'node:assert/strict';
import {chromium} from './support/playwright.mjs';
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
    const { pageEditor }=await import('/tests/support/page-editor.mjs'),{emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
    const {DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs');
    const report=emptyDocument(),figure=report.figure_types[0];
    report.keyframes=Array.from({length:80},(_,frame)=>createFrame(Array.from({length:30},(_,slot)=>createObject(figure,slot+1,200+frame,250,
      {join:slot?{target_object_slot:slot-1,target_handle_id:1}:null})),3));
    const editor=pageEditor({demo:false,propertyChannels:true}).load(report);editor.select(1);
    editor.beginTranslationDrag();editor.moveSelection(5,3);editor.commitDrag();
    const exporter=new DocumentExporter(),importer=new ImportClient();
    try {
      const blob=await exporter.export(editor.report,{format:'styk',name:'architecture-roundtrip',revision:editor.revision});
      const imported=await importer.importFile(new File([blob],'architecture-roundtrip.styk'));
      const reopened=pageEditor({demo:false,propertyChannels:true}).load(imported.document);
      const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
      const same=canonical(reopened.report._styk.animation)===canonical(editor.report._styk.animation);
      let exact=true;
      for(const tick of [0,1,3,4,8,239]){
        editor.seek(tick);reopened.seek(tick);
        const points=e=>JSON.stringify([...e.geometry.objects].map(([slot,g])=>[slot,[...g.joints]]));
        exact&&=points(editor)===points(reopened);
      }
      return {same,exact,bytes:blob.size};
    }finally{exporter.dispose();importer.dispose();}
  });
  assert.equal(roundtrip.same,true,JSON.stringify(roundtrip));assert.equal(roundtrip.exact,true,JSON.stringify(roundtrip));
  console.log('PASS native binary save/reopen and exact evaluated joins',roundtrip);
  assert.deepEqual(errors,[]);console.log('PASS no browser errors');
} finally {await browser.close();}
