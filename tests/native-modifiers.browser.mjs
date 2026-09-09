/** Mid-gesture native modifier locks, exercised through actual pointer events. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve('artifacts/native-modifier-pointer');await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1600,height:1000}}),checks=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
async function setup() {
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const {worldToScreen}=await import('/src/renderer.mjs');
    const report=emptyDocument(),figure=report.figure_types[0];report.keyframes=[createFrame([createObject(figure,1,400,300)])];
    styk.editor.load(report,'Native modifiers');styk.editor.select(1,0);styk.fit();
    window.__screen=point=>{const r=document.querySelector('#viewport').getBoundingClientRect(),p=worldToScreen(point,{report:styk.editor.report,frame:styk.editor.evaluatedFrame,view:styk.state.view});return{x:r.x+p.x,y:r.y+p.y};};
  });await page.keyboard.press('v');await page.waitForTimeout(80);
}
const screen=p=>page.evaluate(p=>__screen(p),p);
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>styk?.ready);
  for(const key of ['Control','Shift']) {
    await setup();const origin={x:400,y:300},start=await screen({x:400,y:222}),middle=await screen({x:460,y:240}),end=await screen({x:556,y:300});
    await page.mouse.move(start.x,start.y);await page.keyboard.down('Alt');await page.keyboard.down(key);await page.mouse.down();
    await page.mouse.move(middle.x,middle.y,{steps:4});
    const locked=await page.evaluate(()=>({scale:styk.editor.object.scale,angle:styk.editor.object.angles[0]}));
    check(`${key} initially locks the corresponding Alt transform`,key==='Control'?Math.abs(locked.scale-1)<.01:Math.abs(locked.angle+Math.PI/2)<.01);
    await page.keyboard.up(key);await page.mouse.move(end.x,end.y,{steps:4});await page.mouse.up();await page.keyboard.up('Alt');
    const resumed=await page.evaluate(()=>({scale:styk.editor.object.scale,angle:styk.editor.object.angles[0]}));
    check(`Releasing ${key} during Alt drag resumes its transform`,Math.abs(resumed.scale-2)<.04&&Math.abs(resumed.angle)<.03);
  }
  await setup();const start=await screen({x:400,y:300}),first=await screen({x:440,y:312}),last=await screen({x:480,y:390});
  await page.mouse.move(start.x,start.y);await page.keyboard.down('Control');await page.mouse.down();
  await page.mouse.move(first.x,first.y,{steps:4});await page.keyboard.up('Control');await page.mouse.move(last.x,last.y,{steps:4});await page.mouse.up();
  const moved=await page.evaluate(()=>({x:styk.editor.object.root_x,y:styk.editor.object.root_y}));
  check('Ctrl origin drag retains its initial horizontal axis even after direction/modifier changes',Math.abs(moved.x-480)<1&&moved.y===300);
  await setup();const lateStart=await screen({x:400,y:300}),lateEnd=await screen({x:435,y:329});
  await page.mouse.move(lateStart.x,lateStart.y);await page.mouse.down();await page.keyboard.down('Control');
  await page.mouse.move(lateEnd.x,lateEnd.y,{steps:4});await page.mouse.up();await page.keyboard.up('Control');
  const late=await page.evaluate(()=>({x:styk.editor.object.root_x,y:styk.editor.object.root_y}));
  check('Ctrl pressed after origin pointerdown does not introduce an axis lock',Math.abs(late.x-435)<1&&Math.abs(late.y-329)<1);
  check('No browser runtime errors',errors.length===0);
  await writeFile(path.join(out,'report.json'),JSON.stringify({checks,errors},null,2));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'report.json'),JSON.stringify({checks,errors,failure:error.stack},null,2));throw error;}
finally{await browser.close();}
