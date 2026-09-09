import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1560,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(()=>window.styk?.ready);
 await page.evaluate(()=>{
  const {editor,state}=styk;editor.selectMany([1,2]);state.onion=true;
  state.view={x:300,y:160,scale:0.55};
  window.scrubView={...state.view};
  window.renders=[];const render=state.renderer.render.bind(state.renderer);
  state.renderer.render=options=>{if(state.scrubbing)renders.push({tick:editor.tick,clipToCanvas:options.clipToCanvas,cameraEnabled:options.cameraEnabled,view:{...options.view},onions:options.onionFrames.length,handles:options.canvasHandles?.length,selected:[...editor.selectedUids]});return render(options)};
 });
 const box=await page.locator('.styk-timeline-scroll').boundingBox();
 await page.mouse.move(box.x+40,box.y+15);await page.mouse.down();
 await page.mouse.move(box.x+300,box.y+15,{steps:12});
 await page.waitForFunction(()=>renders.some(r=>r.onions>0));
 assert.equal(await page.evaluate(()=>styk.state.scrubbing),true);
 assert.ok(await page.evaluate(()=>renders.length>1 && renders.every(r=>r.onions>0 && r.handles>0)), 'Selection handles and onion skins stay rendered throughout scrubbing');
 assert.deepEqual(await page.evaluate(()=>[...styk.editor.selectedUids]),[1,2]);
 assert.ok(await page.evaluate(()=>renders.every(r=>r.clipToCanvas===false && r.cameraEnabled===false && JSON.stringify(r.view)===JSON.stringify(scrubView))), 'Scrubbing keeps the expanded viewport without canvas clipping or camera transforms');
 assert.deepEqual(await page.evaluate(()=>styk.state.view),await page.evaluate(()=>scrubView));
 await page.screenshot({path:'artifacts/scrub-selection-onion.png'});
 await page.mouse.up();
 assert.deepEqual(await page.evaluate(()=>[...styk.editor.selectedUids]),[1,2]);
 assert.ok(await page.evaluate(()=>renders.every(r=>r.clipToCanvas===false && r.cameraEnabled===false && JSON.stringify(r.view)===JSON.stringify(scrubView))), 'Scrubbing keeps the expanded viewport without canvas clipping or camera transforms');
 assert.deepEqual(await page.evaluate(()=>styk.state.view),await page.evaluate(()=>scrubView));
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify(await page.evaluate(()=>renders)));
} finally {await browser.close()}
