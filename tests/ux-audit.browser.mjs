/** Exploratory current-UI evidence. Findings are observations, not parity sign-off. */
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const out=path.resolve('artifacts/ux-audit');await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1366,height:900}});
page.setDefaultTimeout(15000);
const observations=[],errors=[],sources={},pending=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{const name=new URL(r.url()).pathname;if(!['/src/app.mjs','/src/inspector-view.mjs','/src/timeline.mjs','/src/layer-panel.mjs'].includes(name))return;
  pending.push(r.body().then(async b=>{sources[name]=createHash('sha256').update(b).digest('hex');await writeFile(path.join(out,'loaded-'+path.basename(name)),b);}));});
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function record(name,detail){observations.push({name,detail});console.log(JSON.stringify({name,detail}));}
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),d=emptyDocument();d.canvas_width=800;d.canvas_height=450;
    d.keyframes=[0,1,2].map(i=>createFrame([createObject(d.figure_types[0],1,200+i*100,300,{scale:.65}),createObject(d.figure_types[0],2,600,300,{scale:.65})],1));
    styk.editor.load(d);styk.editor.name='Independent UX audit';styk.editor.select(1);styk.editor.markSaved();styk.fit();
  });await settle();
  await page.screenshot({path:path.join(out,'initial.png')});
  const x=page.locator('[data-field="root_x"]');
  await x.fill('230');await x.press('Tab');await settle();
  await record('numeric-entry',await page.evaluate(()=>({x:styk.editor.object.root_x,history:styk.editor.undoLabel,tick:styk.editor.tick})));
  const label=page.locator('[data-field="root_x"]').locator('..').locator('span').first(),lb=await label.boundingBox();
  const before=await page.evaluate(()=>styk.editor.object.root_x);await page.mouse.move(lb.x+lb.width/2,lb.y+lb.height/2);await page.mouse.down();await page.mouse.move(lb.x+55,lb.y+lb.height/2,{steps:10});await page.mouse.up();await settle();
  await record('numeric-label-drag',await page.evaluate(before=>({before,after:styk.editor.object.root_x,selectionText:getSelection()?.toString()}),before));
  await page.locator('[data-uid="1"]').first().click();await page.locator('[data-uid="2"]').first().click({modifiers:['Shift']});await settle();
  await record('layer-shift-selection',await page.evaluate(()=>({uids:[...styk.editor.selectedUids],fields:[...document.querySelectorAll('#inspector [data-field]')].map(e=>e.dataset.field)})));
  await page.locator('[data-action="rotate"]').click();await settle();
  await record('group-rotate',await page.evaluate(()=>({objects:styk.editor.frame.objects.map(o=>({uid:o.unique_id,x:o.root_x,y:o.root_y,angle:o.angles[0]})),history:styk.editor.undoLabel})));
  await page.keyboard.press('Control+z');await page.evaluate(()=>styk.editor.select(1));await settle();
  const viewport=await page.locator('#viewport').boundingBox(),vbefore=await page.evaluate(()=>({...styk.state.view}));
  await page.keyboard.down('Space');await page.mouse.move(viewport.x+50,viewport.y+50);await page.mouse.down();await page.mouse.move(viewport.x+110,viewport.y+80,{steps:10});await page.mouse.up();await page.keyboard.up('Space');await settle();
  await record('space-pan',await page.evaluate(before=>({before,after:styk.state.view,playing:styk.state.playing}),vbefore));await page.evaluate(()=>styk.fit());await settle();
  const origin=await page.evaluate(()=>{const r=document.querySelector('#viewport').getBoundingClientRect(),v=styk.state.view,o=styk.editor.object;return{x:r.left+v.x+o.root_x*v.scale,y:r.top+v.y+o.root_y*v.scale};});
  await page.mouse.click(origin.x,origin.y,{button:'right'});await record('canvas-context-menu',await page.locator('#menu').innerText());await page.keyboard.press('Escape');
  await page.locator('[data-action="scene-settings"]').click();await page.locator('[data-action="background-style"]').click();
  await page.locator('#background-kind').selectOption('3');await page.locator('#background-angle').fill('30');await page.locator('#create-background').click();await settle();
  const gradient=await page.evaluate(()=>{const e=styk.editor;return e.report.backgrounds.find(b=>b.background_id===e.frame.background_id);});
  await page.locator('[data-action="background-style"]').click();
  await record('gradient-angle-reopen',{stored:gradient,reopenedAngle:await page.locator('#background-angle').inputValue()});
  await page.screenshot({path:path.join(out,'gradient-reopen.png')});await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.evaluate(()=>{styk.editor.select(1);styk.editor.selectFrame(0);});await page.locator('[data-inspector="design"]').click();await settle();
  const timeline=await page.locator('.styk-timeline-scroll').boundingBox();await page.mouse.click(timeline.x+20,timeline.y+14);await page.keyboard.down('Shift');await page.mouse.click(timeline.x+56,timeline.y+14);await page.keyboard.up('Shift');await settle();
  const range=await page.evaluate(()=>({indices:styk.state.rangeIndices,roots:styk.editor.report.keyframes.map(f=>f.objects.find(o=>o.unique_id===1)?.root_x)}));
  if(await page.locator('#apply-range-movement').count()){
    await page.locator('#apply-range-movement').check();await page.locator('[data-field="root_x"]').fill('450');await page.locator('[data-field="root_x"]').press('Tab');await settle();
    await record('numeric-range-position',{before:range,after:await page.evaluate(()=>styk.editor.report.keyframes.map(f=>f.objects.find(o=>o.unique_id===1)?.root_x))});
    await page.screenshot({path:path.join(out,'numeric-range.png')});
  }else await record('numeric-range-position',{before:range,note:'Range movement control unavailable in this loaded UI.'});
  await page.locator('[data-action="menu"]').click();await record('main-menu',await page.locator('#menu').innerText());await page.keyboard.press('Escape');
  await page.locator('.tool[data-action="add-text"]').click();await record('text-dialog',{font:await page.locator('.text-font').textContent(),canvasPreviewCount:await page.locator('#dialog canvas').count(),text:await page.locator('#dialog').innerText()});await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.setViewportSize({width:900,height:700});await settle();await page.screenshot({path:path.join(out,'compact.png')});
  await record('compact-layout',await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,viewport:document.querySelector('#viewport').getBoundingClientRect().toJSON(),inspector:document.querySelector('#inspector')?.getBoundingClientRect().toJSON()})));
  await Promise.all(pending);await writeFile(path.join(out,'report.json'),JSON.stringify({measuredAt:new Date().toISOString(),observations,errors,sources},null,2));
}catch(error){await writeFile(path.join(out,'failure.json'),JSON.stringify({error:error.stack,observations,errors,sources},null,2));throw error;}
finally{await browser.close();}
