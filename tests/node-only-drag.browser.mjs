/** Real pointer acceptance for native handle colors, routing and modifiers. */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve('artifacts/native-handle-pointer'); await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1000}}), errors=[],checks=[],routes=[];
page.on('pageerror',error=>errors.push(error.message));
const check=(name,result)=>{assert.ok(result,name);checks.push(name);console.log('PASS',name);};
const near=(a,b,tolerance=.003)=>Math.abs(a-b)<tolerance;
const settle=()=>page.waitForTimeout(80);
async function setup() {
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const report=emptyDocument(),figure=report.figure_types[0],base=figure.segments[0];
    figure.segments=[{...base,segment_id:1,parent_id:0,length:120,angle_rad:0},
      {...base,segment_id:2,parent_id:1,length:80,angle_rad:Math.PI/2},
      {...base,segment_id:3,parent_id:0,length:90,angle_rad:Math.PI},
      {...base,segment_id:4,parent_id:1,length:55,angle_rad:0}]; figure.segment_count=4;
    report.keyframes=[createFrame([createObject(figure,1,300,220),
      createObject(figure,2,420,220,{scale:.5,join:{target_object_slot:0,target_handle_id:1}}),
      createObject(figure,3,640,420,{scale:.6})]),createFrame([createObject(figure,1,300,220)])];
    styk.editor.load(report,'Native handle pointer test'); styk.editor.select(2,0); styk.state.handles=true;
    styk.state.settings.showUnselectedHandles=true;styk.state.settings.handleSize=5;styk.fit();
    const {worldToScreen}=await import('/src/renderer-geometry.mjs');
    window.__screen=point=>{const r=document.querySelector('#viewport').getBoundingClientRect();
      const p=worldToScreen(point,{report:styk.editor.report,frame:styk.editor.evaluatedFrame,view:styk.state.view});return{x:r.x+p.x,y:r.y+p.y};};
    window.__points=()=>[...styk.editor.geometry.objects].flatMap(([slot,g])=>[...g.joints].map(([id,p])=>({slot,uid:g.obj.unique_id,id,...p})));
    window.__before=__points();
  });
  await page.keyboard.press('v'); await settle();
}
const worldPoint=async(uid,id)=>page.evaluate(({uid,id})=>{const e=styk.editor,g=[...e.geometry.objects.values()].find(g=>g.obj.unique_id===uid);return g.joints.get(id);},{uid,id});
const screenPoint=point=>page.evaluate(point=>__screen(point),point);
async function drag(uid,id,target,{keys=[],button='left',cancel=false,name='drag'}={}) {
  const point=await worldPoint(uid,id),start=await screenPoint(point),end=await screenPoint(target);
  await page.mouse.move(start.x,start.y); for(const key of keys)await page.keyboard.down(key);
  await page.mouse.down({button}); const route=await page.evaluate(()=>({kind:styk.state.drag?.kind,uid:styk.editor.selectedUid,joint:styk.editor.selectedJoint,held:styk.state.handleEditHeld}));
  routes.push({name,...route}); await page.mouse.move(end.x,end.y,{steps:12});
  if(cancel)await page.keyboard.press('Escape'); await page.mouse.up({button});
  for(const key of [...keys].reverse())await page.keyboard.up(key); await settle(); return route;
}
try {
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  // A press on a segment's line grabs that segment to pose it; on empty space it starts a selection. Neither translates a figure.
  for (const [point,kind] of [[{x:360,y:220},'pose'],[{x:350,y:255},'marquee']]) {
    await setup();
    const start=await screenPoint(point),roots=()=>page.evaluate(()=>JSON.stringify(styk.editor.evaluatedFrame.objects.filter(o=>!o.join).map(o=>[o.unique_id,o.root_x,o.root_y])));
    const rootsBefore=await roots();
    await page.mouse.move(start.x,start.y); await page.mouse.down();
    check('A segment line grabs the segment and empty space starts a selection, never a figure translation',await page.evaluate(kind=>styk.state.drag?.kind===kind,kind));
    await page.mouse.move(start.x+25,start.y+20,{steps:4}); await page.mouse.up();
    check('Dragging from artwork or empty space leaves every unattached figure where it was',await roots()===rootsBefore);
  }
  await setup();
  const padded=await screenPoint(await worldPoint(1,1));
  await page.mouse.move(padded.x+6,padded.y); await page.mouse.down();
  check('A near-node click picks the joint with padded tolerance',await page.evaluate(()=>styk.state.drag?.kind==='pose'&&styk.editor.selectedUid===1));
  await page.keyboard.press('Escape'); await page.mouse.up();
  await setup();
  const origin=await drag(1,0,{x:325,y:240},{name:'origin'});
  check('Dragging the origin node still moves the figure',origin.kind==='move'&&await page.evaluate(()=>styk.editor.evaluatedFrame.objects.find(o=>o.unique_id===1).root_x!==300));
  const bendStart=await worldPoint(1,1),bendScreen=await screenPoint(bendStart),clickBefore=await page.evaluate(()=>JSON.stringify(styk.editor.evaluatedFrame));
  await page.mouse.move(bendScreen.x,bendScreen.y); await page.mouse.down({button:'right'}); await page.mouse.up({button:'right'});
  await page.waitForFunction(()=>!document.getElementById('menu').hidden,{timeout:3000});
  check('A stationary right-click opens the context menu instead of bending',await page.evaluate(before=>JSON.stringify(styk.editor.evaluatedFrame)===before,clickBefore));
  await page.keyboard.press('Escape'); await settle();
  const bendBefore=await page.evaluate(()=>JSON.stringify(styk.editor.evaluatedFrame));
  await drag(1,1,{x:bendStart.x+50,y:bendStart.y-40},{button:'right',name:'right-bend'});
  check('A right-button drag bends the joint and keeps the menu closed',await page.evaluate(before=>JSON.stringify(styk.editor.evaluatedFrame)!==before,bendBefore)&&await page.evaluate(()=>document.getElementById('menu').hidden));
  check('The bend commits as a pose edit',await page.evaluate(()=>styk.editor._undo.at(-1)?.label==='Pose joint'));
  await page.keyboard.press('Control+z'); await settle();
  const shiftBefore=await page.evaluate(()=>JSON.stringify(styk.editor.evaluatedFrame));
  await drag(1,1,{x:bendStart.x+40,y:bendStart.y-30},{button:'right',keys:['Shift'],name:'shift-bend'});
  check('Shift-right-drag keeps the immediate bend gesture',await page.evaluate(before=>JSON.stringify(styk.editor.evaluatedFrame)!==before,shiftBefore)&&await page.evaluate(()=>document.getElementById('menu').hidden));
  await page.screenshot({path:path.join(out,'node-only-drag.png')});
  check('No browser runtime errors',errors.length===0);
} finally {await browser.close();}
