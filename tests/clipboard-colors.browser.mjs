import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';
await mkdir('artifacts/clipboard-colors',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const a=await browser.newPage({viewport:{width:1440,height:1000}}),b=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
for(const page of [a,b])page.on('pageerror',error=>errors.push(error.message));
const settle=async page=>{
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await page.waitForFunction(()=>styk.state.renderer.engineSide?.frameReport===styk.editor.report);
};
try{
  for(const page of [a,b]){await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);}
  for(const [from,to] of [[4,5],[5,4],[5,5]]){
    const packet=await a.evaluate(async version=>{
      const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
      const {clipboardSnapshot}=await import('/src/shared-clipboard.mjs');
      const {clipboardWireChunks}=await import('/src/clipboard-wire.mjs');
      const report=emptyDocument();report.version=version;report.frame_delay_ms=40;
      report.figure_types[0].segments.forEach((s,i)=>{s.color_rgb=[20+i*10,90,180];});
      report.keyframes=[createFrame([0xffffffff,0x0033cc,0,0x80112233].map((raw,i)=>createObject(report.figure_types[0],i+1,100+i*210,300,{color_override_raw:raw})))];
      styk.editor.load(report);styk.editor.selectMany([1,2,3,4]);styk.editor.copySelection();styk.fit();
      const chunks=[];for await(const bytes of clipboardWireChunks(clipboardSnapshot(styk.editor,'figures')))chunks.push(Array.from(new Uint8Array(bytes)));return chunks;
    },from);
    await b.evaluate(async({to,packet})=>{
      const {emptyDocument}=await import('/src/demo.mjs');
      const {restoreClipboard}=await import('/src/shared-clipboard.mjs');
      const {createClipboardWireDecoder}=await import('/src/clipboard-wire.mjs');
      const report=emptyDocument();report.version=to;report.frame_delay_ms=40;styk.editor.load(report);
      const decoder=createClipboardWireDecoder();for(const bytes of packet)await decoder.push(Uint8Array.from(bytes).buffer);
      await restoreClipboard(styk.editor,decoder.finish());decoder.dispose();styk.editor.pasteSelection();styk.fit();
    },{to,packet});
    await settle(a);await settle(b);
    const colors=page=>page.evaluate(()=>styk.editor.geometry.drawables.map(s=>[s.rgb,s.alpha]));
    assert.deepEqual(await colors(b),await colors(a));
    await b.screenshot({path:`artifacts/clipboard-colors/${from}-to-${to}.png`});
    console.log(`PASS ${from} to ${to}: wire transfer and rendered colors`);
  }
  assert.deepEqual(errors,[]);
}finally{await browser.close();}
