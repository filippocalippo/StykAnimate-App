import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
const out='artifacts/builder-context';await mkdir(out,{recursive:true});
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const action=name=>page.locator(`[role="menu"] [data-action="${name}"]:visible`);
// The families are submenus (revision 5): Branch ▸, Arrange ▸, Rig ▸ and View ▸ open beside their row.
const submenu=name=>page.getByRole('menuitem',{name,exact:true});
page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto(process.env.STYK_URL||'http://127.0.0.1:47841');await page.waitForFunction(()=>window.styk?.ready);
 await page.locator('[data-workspace-mode="rig"]').click();
 await page.locator('.ui-quick [data-action="zoom-selection"]').click();await settle();
 const jointPoint=async index=>page.evaluate(async index=>{
  const {worldToScreen}=await import('/src/renderer-geometry.mjs'),{editor,state}=styk;
  const p=worldToScreen(editor.geometry.objects.get(editor.selectedSlot).segments[index].end,{report:editor.report,frame:editor.frame,view:state.view});
  const r=document.querySelector('#viewport').getBoundingClientRect();return {x:r.x+p.x,y:r.y+p.y};
 },index);
 const clickJoint=async index=>{const p=await jointPoint(index);await page.mouse.click(p.x,p.y,{button:'right'});await settle();};
 await clickJoint(0);
 assert.equal(await page.evaluate(()=>styk.editor.selectedJoint),0);
 assert.equal(await action('split-segment').isVisible(),true);
 assert.equal(await action('paste').count(),0);assert.equal(await action('delete').count(),0);
 await page.screenshot({path:`${out}/joint.png`});
 const baseline=await page.evaluate(()=>JSON.stringify(styk.editor.serialize()));
 await submenu('Branch').click();await settle();
 assert.equal(await action('mirror-branch-vertical').isVisible(),true);
 await page.screenshot({path:`${out}/branch.png`});
 const before=await page.evaluate(()=>styk.editor.figure.segments.length);
 await action('builder-context-split-branch').click();await settle();
 assert.ok(await page.evaluate(()=>styk.editor.figure.segments.length)>before);
 await page.keyboard.press('Control+z');await settle();assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),baseline);
 await page.evaluate(()=>styk.workspace.dock('structure','left'));await settle();await page.locator('.builder-tree-row').first().click({button:'right'});await settle();
 await submenu('Arrange').click();await settle();assert.equal(await action('segment-order-front').isVisible(),true);
 await page.keyboard.press('ArrowLeft');await settle();assert.equal(await action('unsplit-segment').isVisible(),true);
 await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('builder-tree')),true);
 // Fill actions preserve all joints and use normal undo.
 await page.evaluate(()=>{const e=styk.editor;e.addPolygon([0,e.figure.segments[0].segment_id,e.figure.segments[1].segment_id]);});await settle();
 const polygonRow=page.getByRole('treeitem',{name:'Fill 1',exact:true});
 await polygonRow.scrollIntoViewIfNeeded();await polygonRow.click({button:'right'});await settle();
 assert.equal(await action('builder-context-delete-fill').isVisible(),true);
 const filled=await page.evaluate(()=>JSON.stringify(styk.editor.serialize()));
 await action('builder-context-fill-front').click();await settle();
 await page.keyboard.press('Control+z');await settle();assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),filled);
 await polygonRow.click({button:'right'});await action('builder-context-delete-fill').click();await settle();
 assert.equal(await page.evaluate(()=>styk.editor.figure.polyfills.length),0);
 assert.equal(await page.evaluate(()=>styk.editor.figure.segments.length),before);
 await page.keyboard.press('Control+z');await settle();assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),filled);
 const rect=await page.locator('#overlay').boundingBox();await page.mouse.click(rect.x+70,rect.y+40,{button:'right'});await settle();
 assert.equal(await action('builder-context-tool-line').isVisible(),true);
 assert.equal(await action('split-segment').count(),0);
 await page.screenshot({path:`${out}/canvas.png`});
 await action('builder-context-timeline').click();await settle();assert.equal(await page.locator('.timeline-panel').isVisible(),true);
 const canvas=await page.locator('#overlay').boundingBox();await page.mouse.click(canvas.x+70,canvas.y+40,{button:'right'});
 await action('builder-context-tool-circle').click();await settle();assert.equal(await page.evaluate(()=>styk.state.tool),'circle');
 assert.deepEqual(errors,[]);
 console.log('PASS: canvas joint targeting, safe builder-only menus, branch split/undo, submenus and Escape focus, fill ordering/deletion/undo, empty canvas tools and timeline toggle; no page errors.');
} finally {await browser.close();}

