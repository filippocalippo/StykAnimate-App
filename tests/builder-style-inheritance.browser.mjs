import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
try {
 await page.goto(process.env.STYK_URL||'http://127.0.0.1:47841');await page.waitForFunction(()=>window.styk?.ready);
 await page.locator('[data-workspace-mode="rig"]').click();await settle();
 const target=await page.evaluate(async()=>{
   const {worldToScreen}=await import('/src/renderer-geometry.mjs');const {editor:e,state}=styk;
   e.select(e.selectedUid,2);e.updateSegmentStyle({color:'#e54283',thickness:19});
   const q=worldToScreen(e.geometry.objects.get(e.selectedSlot).segments[2].end,{report:e.report,frame:e.frame,view:state.view});
   const r=document.querySelector('#viewport').getBoundingClientRect();return {x:r.x+q.x,y:r.y+q.y};
 });
 await page.locator('[data-tool="line"]').click();
 await page.mouse.move(target.x,target.y);await page.mouse.down();await page.mouse.move(target.x+100,target.y-55,{steps:5});await page.mouse.up();await settle();
 const line=await page.evaluate(()=>{const s=styk.editor.figure.segments.at(-1);return {width:s.thickness,color:s.color_rgb};});
 assert.deepEqual(line,{width:19,color:[229,66,131]});
 const tip=await page.evaluate(async()=>{const {worldToScreen}=await import('/src/renderer-geometry.mjs');const {editor:e,state}=styk;const q=worldToScreen(e.geometry.objects.get(e.selectedSlot).segments.at(-1).end,{report:e.report,frame:e.frame,view:state.view});const r=document.querySelector('#viewport').getBoundingClientRect();return {x:r.x+q.x,y:r.y+q.y};});
 await page.locator('[data-tool="chain"]').click();
 await page.mouse.click(tip.x,tip.y);await page.mouse.click(tip.x+70,tip.y+40);await page.mouse.click(tip.x+120,tip.y+100);await page.keyboard.press('Enter');await settle();
 const chain=await page.evaluate(()=>styk.editor.figure.segments.slice(-2).map(s=>({width:s.thickness,color:s.color_rgb})));
 assert.deepEqual(chain,[line,line]);assert.deepEqual(errors,[]);
 await mkdir('artifacts/builder-inheritance',{recursive:true});await page.screenshot({path:'artifacts/builder-inheritance/result.png'});
 console.log('PASS: Line and Chain pen mouse gestures inherit pink colour and width 19; no page errors.');
}finally{await browser.close();}
