import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {builderFixture} from '../scripts/builder-benchmark-fixture.mjs';
const b=await chromium.launch({channel:'chrome',headless:true});const p=await b.newPage({viewport:{width:1440,height:1000}}),errors=[];
p.on('pageerror',e=>errors.push(e.message));const settle=()=>p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
try {
 await p.goto(process.env.STYK_URL||'http://127.0.0.1:47841');await p.waitForFunction(()=>window.styk?.ready);
 await p.locator('[data-workspace-mode="rig"]').click();await settle();
 await p.locator('[data-tool="chain"]').click();
 let rect=await p.locator('#overlay').boundingBox();
 const initial=await p.evaluate(()=>styk.editor.figure.segments.length);
 await p.mouse.click(rect.x+120,rect.y+100);await p.mouse.click(rect.x+200,rect.y+180);await p.mouse.click(rect.x+290,rect.y+240);
 assert.equal(await p.evaluate(()=>styk.editor.figure.segments.length),initial);
 assert.equal(await p.locator('#chain-count').textContent(),'2 links');
 await p.keyboard.press('Backspace');assert.equal(await p.locator('#chain-count').textContent(),'1 links');
 await p.mouse.click(rect.x+290,rect.y+240);await p.mouse.move(rect.x+330,rect.y+320);await settle();
 await mkdir('artifacts/builder-construction',{recursive:true});await p.screenshot({path:'artifacts/builder-construction/chain.png'});
 await p.keyboard.press('Enter');await settle();assert.equal(await p.evaluate(()=>styk.editor.figure.segments.length),initial+2);
 await p.keyboard.press('Control+z');await settle();assert.equal(await p.evaluate(()=>styk.editor.figure.segments.length),initial);
 await p.keyboard.press('Control+Shift+z');await settle();assert.equal(await p.evaluate(()=>styk.editor.figure.segments.length),initial+2);
 await p.mouse.click(rect.x+150,rect.y+140);await p.keyboard.press('Escape');assert.equal(await p.locator('#chain-controls').isVisible(),false);
 await p.evaluate(()=>styk.workspace.dock('structure','left'));await settle();rect=await p.locator('#overlay').boundingBox();await p.locator('#builder-snap').click();assert.equal(await p.locator('#builder-snap').getAttribute('aria-pressed'),'false');await p.locator('#builder-snap').click();
 await p.locator('.builder-tree-row').first().click();await p.keyboard.down('Shift');await p.locator('.ui-quick [data-action=duplicate-segment]').click();await p.keyboard.up('Shift');
 await p.mouse.move(rect.x+380,rect.y+290);await settle();assert.equal(await p.locator('#overlay').evaluate(el=>el.style.cursor),'copy');
 await p.screenshot({path:'artifacts/builder-construction/duplicate.png'});
 const ghost=await p.evaluate(()=>{const v=styk.state.duplicatePlacement.preview;return {count:v.count,width:v.canvas.width,height:v.canvas.height};});assert.ok(ghost.count>1&&ghost.width<=2048&&ghost.height<=2048);
 const target=await p.evaluate(async()=>{const {worldToScreen}=await import('/src/renderer-geometry.mjs'),{editor,state}=styk;const q=worldToScreen(editor.geometry.objects.get(editor.selectedSlot).root,{report:editor.report,frame:editor.frame,view:state.view});const r=document.querySelector('#viewport').getBoundingClientRect();return {x:r.x+q.x,y:r.y+q.y};});
 const prior=await p.evaluate(()=>styk.editor.figure.segments.length);await p.mouse.click(target.x,target.y);await settle();assert.equal(await p.evaluate(()=>styk.editor.figure.segments.length),prior+ghost.count);await p.keyboard.press('Control+z');await settle();assert.equal(await p.evaluate(()=>styk.editor.figure.segments.length),prior);
 await p.locator('[data-tool=chain]').click();await p.mouse.click(rect.x+150,rect.y+140);await p.mouse.click(rect.x+250,rect.y+140);await p.mouse.click(rect.x+280,rect.y+170,{button:'right'});await p.locator('#menu [data-action=chain-cancel]').click();assert.equal(await p.locator('#chain-controls').isVisible(),false);
 const countBeforeDouble=await p.evaluate(()=>styk.editor.figure.segments.length);
 await p.mouse.click(rect.x+180,rect.y+190);await p.mouse.dblclick(rect.x+280,rect.y+270);await settle();
 assert.equal(await p.locator('#chain-controls').isVisible(),false);assert.equal(await p.evaluate(()=>styk.editor.figure.segments.length),countBeforeDouble+1);await p.keyboard.press('Control+z');await settle();
 const snapTarget=await p.evaluate(async()=>{const {worldToScreen}=await import('/src/renderer-geometry.mjs'),{editor,state}=styk;const world=editor.geometry.objects.get(editor.selectedSlot).segments[0].end;const q=worldToScreen(world,{report:editor.report,frame:editor.frame,view:state.view});const r=document.querySelector('#viewport').getBoundingClientRect();return {world,x:r.x+q.x,y:r.y+q.y};});
 await p.mouse.click(target.x,target.y);await p.mouse.click(snapTarget.x+2,snapTarget.y+2);await p.keyboard.press('Enter');await settle();
 const snapped=await p.evaluate(()=>styk.editor.geometry.objects.get(styk.editor.selectedSlot).segments.at(-1).end);
 assert.ok(Math.hypot(snapped.x-snapTarget.world.x,snapped.y-snapTarget.world.y)<.01);await p.keyboard.press('Control+z');await settle();
 assert.deepEqual(errors,[]);console.log('PASS chain preview, finish, Backspace, cancel, one-step undo/redo, snap toggle, visible duplication cursor.');
 const results=[];
 for(const [segments,instances] of [[1000,1],[5000,1],[15000,1],[100,500]]){
  await p.evaluate(f=>{styk.builder.leave();styk.editor.load(f);styk.editor.select(1,0);styk.builder.enter();},builderFixture(segments,instances));await settle();
  const data=await p.evaluate(async()=>{const e=styk.editor,paint=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))),records={add:[],style:[],drag:[],commit:[]};
   for(let i=0;i<5;i++){
    for(const action of ['add','style','drag']){e.select(1,0);if(action==='drag')e.beginRigDrag();const g=action==='drag'?e.geometry.objects.get(0).segments[0]:null;const t=performance.now();
     if(action==='add')e.addSegment({length:20,angle:.7});else if(action==='style')e.updateSegmentStyle({thickness:4+i});else e.editRigJoint(g.end.x+1,g.end.y+1);
     const commandMs=performance.now()-t;await paint();records[action].push({commandMs,paintMs:performance.now()-t});if(action==='drag'){const start=performance.now();e.commitRigDrag();const commandMs=performance.now()-start;await paint();records.commit.push({commandMs,paintMs:performance.now()-start});e.undo();}else e.undo();await paint();
    }
   }return records;
  });results.push({segments,instances,data});console.log(JSON.stringify(results.at(-1)));
 }
 await mkdir('artifacts/builder-performance',{recursive:true});await writeFile('artifacts/builder-performance/browser.json',JSON.stringify({browser:await b.version(),renderer:await p.evaluate(()=>styk.state.renderer.stats.backend),results},null,2));
}finally{await b.close();}
