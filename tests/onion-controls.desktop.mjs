import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'artifacts/onion-rebuild');await mkdir(out,{recursive:true});
const app=await electron.launch({args:[root],cwd:root,timeout:60000,env:{...process.env,STYK_USER_DATA_DIR:path.join(out,`profile-${Date.now()}`)}});
app.process().stderr.on('data',data=>process.stderr.write(data));
try{
  const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>window.styk?.ready,undefined,{timeout:60000});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));
  await page.evaluate(async()=>{
    document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');const report=emptyDocument();report.keyframes=Array.from({length:60},(_,i)=>createFrame([createObject(report.figure_types[0],1,200+i,250)],10));
    styk.editor.load(report);styk.editor.seek(200);styk.settingsUI.commit({onionRangeBefore:20,onionRangeAfter:20});styk.onionController.toggle();
  });
  const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.evaluate(()=>{window.onionPointerTrace=[];for(const type of ['pointerdown','pointermove','pointerup'])document.addEventListener(type,event=>{window.onionPointerTrace.push({type,x:event.clientX,target:event.target.className});window.onionPointerTrace=window.onionPointerTrace.slice(-8);},{capture:true});});
  const baseDpr=await page.evaluate(()=>devicePixelRatio),rail=page.getByRole('dialog',{name:'Onion skin settings',exact:true}),scrub=rail.getByRole('button',{name:'Drag frames before',exact:true});
  for(const scale of [75,100,150,200]){
    await page.evaluate(scale=>{styk.settingsUI.commit({uiScale:scale,onionRangeBefore:20});styk.timeline.setZoom(1);},scale);
    await page.waitForFunction(({scale,baseDpr})=>Math.abs(devicePixelRatio-baseDpr*scale/100)<.01,{scale,baseDpr});await settle();await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close()));await settle();
    if(!await rail.isVisible())await page.getByRole('button',{name:'Onion skin settings',exact:true}).click();await settle();
    assert.equal(await page.locator('.onion-timeline-range').count(),0);
    assert.ok(await rail.getByRole('spinbutton',{name:'Frames before',exact:true}).isVisible());assert.ok(await rail.getByRole('spinbutton',{name:'Frames after',exact:true}).isVisible());
    const box=await scrub.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+3,box.y+box.height/2);await settle();assert.equal(await page.evaluate(()=>styk.onionController.snapshot().before.span),20);
    await page.mouse.move(box.x+box.width/2+8,box.y+box.height/2);await settle();assert.equal(await page.evaluate(()=>styk.onionController.snapshot().before.span),21,JSON.stringify({scale,box,trace:await page.evaluate(()=>window.onionPointerTrace)}));await page.mouse.up();await settle();assert.equal(await page.evaluate(()=>styk.state.settings.onionRangeBefore),21);
    await rail.getByRole('button',{name:'Close onion settings'}).click();
    await page.evaluate(()=>{styk.settingsUI.commit({onionRangeBefore:20});styk.timeline._scrollToX(styk.editor.tick-20+.5-80);});await settle();
    const handle=page.getByRole('slider',{name:'Onion frames before',exact:true}),handleBox=await handle.boundingBox();
    await page.mouse.move(handleBox.x+handleBox.width/2,handleBox.y+handleBox.height/2);await page.mouse.down();
    await page.mouse.move(handleBox.x+handleBox.width/2-3,handleBox.y+handleBox.height/2);await settle();assert.equal(await page.evaluate(()=>styk.onionController.snapshot().before.span),20);
    await page.mouse.move(handleBox.x+handleBox.width/2-8,handleBox.y+handleBox.height/2);await settle();assert.equal(await page.evaluate(()=>styk.onionController.snapshot().before.span),21);
    await page.mouse.up();await settle();assert.equal(await page.evaluate(()=>styk.state.settings.onionRangeBefore),21);
    console.log(`PASS native ${scale}% scale: fields and ruler handles ignore three-pixel jitter, eight-pixel drag changes one frame`);
  }
  await page.getByRole('button',{name:'Onion skin settings',exact:true}).click();await settle();
  assert.ok(await page.locator('.onion-popover').evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}));
  await writeFile(path.join(out,'desktop-200.png'),Buffer.from(await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')),'base64'));
  await page.evaluate(()=>styk.settingsUI.flush());assert.equal(await page.evaluate(async()=>(await stykDesktop.getEditorSettings()).onionRangeBefore),21);
  assert.deepEqual(errors,[]);console.log('PASS desktop panel bounds and persisted output-frame range');
}finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
