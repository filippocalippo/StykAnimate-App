import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {builderFixture} from '../scripts/builder-benchmark-fixture.mjs';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const screen=point=>page.evaluate(async point=>{const {worldToScreen}=await import('/src/renderer-geometry.mjs'),{editor,state}=styk;const p=worldToScreen(point,{report:editor.report,frame:editor.frame,view:state.view}),r=document.querySelector('#viewport').getBoundingClientRect();return {x:r.x+p.x,y:r.y+p.y};},point);
const fixture=builderFixture(6);
fixture.figure_types[0].segments.forEach((s,i)=>{s.parent_id=i<4?i:0;s.angle_rad=i<4?i*Math.PI/2:4.2+(i-4)*.7;s.length=i<4?80:45;s.thickness=4;});
fixture.keyframes[0].objects[0].angles=fixture.figure_types[0].segments.map(s=>s.angle_rad);
try {
 await page.goto(process.env.STYK_URL||'http://127.0.0.1:47841');await page.waitForFunction(()=>window.styk?.ready);
 await page.evaluate(f=>{styk.editor.load(f);styk.editor.select(1,-1);styk.builder.enter();styk.workspace.dock('structure','left');},fixture);
 await page.locator('.ui-quick [data-action=zoom-selection]').click();await page.locator('[data-tool=select]').click();await settle();
 const joints=await page.evaluate(()=>styk.editor.geometry.objects.get(styk.editor.selectedSlot).segments.map(s=>s.end));
 const a=await screen(joints[0]),b=await screen(joints[2]);
 await page.mouse.click(a.x,a.y);await page.keyboard.down('Shift');await page.mouse.click(b.x,b.y);await page.keyboard.up('Shift');await settle();
 assert.deepEqual(await page.evaluate(()=>[...styk.editor.selectedSegmentIds]),[1,3]);assert.equal(await page.locator('.builder-tree-row[aria-selected=true]').count(),2);
 assert.ok(await page.locator('#properties-panel').innerText().then(s=>s.includes('2 parts')));
 // Repeated Shift-click removes one node, then restore it.
 await page.keyboard.down('Shift');await page.mouse.click(b.x,b.y);await page.keyboard.up('Shift');assert.equal(await page.evaluate(()=>styk.editor.selectedSegmentIds.size),1);
 await page.keyboard.down('Shift');await page.locator('#builder-joint-3').click();await page.keyboard.up('Shift');await settle();assert.equal(await page.evaluate(()=>styk.editor.selectedSegmentIds.size),2);
 const input=page.locator('#inspector input[data-field=thickness]');
 await input.fill('18');await input.press('Enter');await settle();
 const widths=await page.evaluate(()=>styk.editor.geometry.objects.get(styk.editor.selectedSlot).segments.map(s=>s.thickness));assert.deepEqual(widths,[18,4,18,4,4,4]);
 await page.locator('#segment-color').evaluate(el=>{el.value='#ff3300';el.dispatchEvent(new Event('change',{bubbles:true}));});await settle();
 const colors=await page.evaluate(()=>styk.editor.geometry.objects.get(styk.editor.selectedSlot).segments.map(s=>s.rgb));assert.deepEqual(colors[0],[255,51,0]);assert.deepEqual(colors[2],[255,51,0]);assert.notDeepEqual(colors[1],[255,51,0]);
 await mkdir('artifacts/builder-selection-fill',{recursive:true});await page.screenshot({path:'artifacts/builder-selection-fill/selection.png'});
 await page.locator('#viewport').focus();const beforeDelete=await page.evaluate(()=>JSON.stringify(styk.editor.serialize()));await page.keyboard.press('Delete');await settle();assert.equal(await page.evaluate(()=>styk.editor.figure.segments.length),4);await page.keyboard.press('Control+z');await settle();assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),beforeDelete);
 await page.locator('[data-tool=polygon]').click();const root=await page.evaluate(()=>styk.editor.geometry.objects.get(styk.editor.selectedSlot).root),center=await screen({x:root.x+40,y:root.y+40});
 await page.keyboard.down('Shift');await page.mouse.move(center.x,center.y);await settle();assert.ok(await page.evaluate(()=>styk.state.bucketPreview));await page.screenshot({path:'artifacts/builder-selection-fill/bucket-preview.png'});
 const beforeFill=await page.evaluate(()=>JSON.stringify(styk.editor.serialize()));await page.mouse.click(center.x,center.y);await page.keyboard.up('Shift');await settle();assert.equal(await page.evaluate(()=>styk.editor.figure.polyfills.length),1);assert.equal(await page.evaluate(()=>styk.editor.selectedPolygonIndex),0);
 await page.keyboard.press('Control+z');await settle();assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),beforeFill);await page.keyboard.press('Control+Shift+z');await settle();
 for(const tool of ['select','rig','polygon']){await page.locator(`[data-tool=${tool}]`).click();await page.evaluate(()=>styk.editor.select(1,-1));await page.mouse.click(center.x,center.y);await settle();assert.equal(await page.evaluate(()=>styk.editor.selectedPolygonIndex),0);assert.equal(await page.getByLabel('Fill color',{exact:true}).count(),1);}
 await page.screenshot({path:'artifacts/builder-selection-fill/fill-selected.png'});
 await page.locator('#viewport').focus();await page.keyboard.press('Delete');await settle();assert.equal(await page.evaluate(()=>styk.editor.figure.polyfills.length),0);assert.equal(await page.evaluate(()=>styk.editor.figure.segments.length),6);await page.keyboard.press('Control+z');await settle();assert.equal(await page.evaluate(()=>styk.editor.selectedPolygonIndex),0);
 const unchanged=await page.evaluate(()=>JSON.stringify(styk.editor.serialize()));await page.keyboard.down('Shift');await page.mouse.click(center.x-300,center.y-180);await page.keyboard.up('Shift');await settle();assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),unchanged);
 assert.deepEqual(errors,[]);console.log('PASS: canvas/tree Shift selection, toggle off, selection width/color, multi-delete undo, bucket preview/fill/undo, direct fill selection in three tools, fill-only delete, open-region no-op.');
}finally{await browser.close();}
