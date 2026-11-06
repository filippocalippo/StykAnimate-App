import {chromium} from './support/playwright.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
 await page.evaluate(async()=>{const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');const {initializeLayerSheet}=await import('/src/editor-layer-sheet.mjs');const e=styk.editor,doc=emptyDocument();doc.keyframes=[0,1,2].map(()=>createFrame([createObject(doc.figure_types[0],1,320,320)],20));e.load(doc);initializeLayerSheet(e.report);e._invalidate({timing:true});e.select(1);window.vfxFailures=[];const onError=styk.vfx.onError;styk.vfx.onError=error=>{vfxFailures.push(error.message);onError(error);};styk.vfx.setVisible(true);styk.vfx.scope='figure';styk.vfx.sync();});
 await page.getByRole('tab',{name:'VFX',exact:true}).click();await page.getByRole('button',{name:'Add effect',exact:true}).click();await page.getByRole('button',{name:'Glow',exact:true}).click();
 assert.equal(await page.evaluate(()=>styk.editor.getVfxClips().length),1);
 await page.getByLabel('Show effects',{exact:true}).selectOption('selected');
 await page.getByLabel('Effect target',{exact:true}).selectOption('connected');assert.equal(await page.evaluate(()=>styk.editor.getVfxClips()[0].includeAttached),true);
 await page.getByLabel('Effect target',{exact:true}).selectOption('figure');assert.equal(await page.evaluate(()=>styk.editor.getVfxClips()[0].includeAttached),false);
 assert.equal(await page.getByText('Include attached parts',{exact:true}).count(),0);
 await page.getByLabel('Effect duration',{exact:true}).selectOption('timed');await page.getByLabel('Start',{exact:true}).fill('10');await page.getByLabel('Start',{exact:true}).press('Tab');
 await page.getByLabel('Duration',{exact:true}).fill('25');await page.getByLabel('Duration',{exact:true}).press('Tab');
 await page.evaluate(()=>{styk.editor.seek(9);styk.vfx.sync();});
 // Frame shortcuts on the focused timeline retain the clip and its controls.
 const selectedClip=await page.evaluate(()=>styk.editor._selectedVfxClip);
 assert.ok(selectedClip);
 await page.getByRole('grid',{name:'Layer frames'}).focus();
 for(const [key,tick] of [['.',10],[',',9],[',',8],['.',9]]){
  await page.keyboard.press(key);
  assert.deepEqual(await page.evaluate(()=>[styk.editor.tick,styk.editor._selectedVfxClip,styk.vfx.selectedClip]),[tick,selectedClip,selectedClip]);
 }
 await page.getByLabel('Glow Radius',{exact:true}).waitFor({state:'visible'});
 await fs.mkdir('artifacts/vfx',{recursive:true});
 await page.screenshot({path:'artifacts/vfx/clip-frame-navigation.png'});
 await page.getByRole('button',{name:'Add Radius key',exact:true}).click();
 await page.evaluate(()=>{styk.editor.seek(29);styk.vfx.sync();});
 await page.getByLabel('Glow Radius',{exact:true}).fill('36');await page.getByLabel('Glow Radius',{exact:true}).press('Enter');
 await page.evaluate(()=>{styk.editor.seek(19);styk.vfx.sync();});
 assert.equal(await page.getByLabel('Glow Radius',{exact:true}).inputValue(),'24');
 await page.evaluate(()=>{const e=styk.editor;for(let i=0;i<20;i++)e.addVfxClip({kind:'figure',uid:1},'tint',{start:40+i*10,duration:8});styk.vfx.sync();});
 await page.getByLabel('Show effects',{exact:true}).selectOption('playhead');
 assert.equal(await page.locator('.vfx-clip').count(),1);await page.getByLabel('Show effects',{exact:true}).selectOption('all');assert.equal(await page.locator('.vfx-clip').count(),21);
 await page.getByLabel('Search effect clips',{exact:true}).fill('glow');assert.equal(await page.locator('.vfx-clip').count(),1);
 await page.getByLabel('Show effects',{exact:true}).selectOption('playhead');
 await page.evaluate(()=>styk.editor.seek(35));await page.waitForFunction(()=>document.querySelectorAll('.vfx-clip').length===0);
 await page.evaluate(()=>styk.editor.seek(40));await page.waitForFunction(()=>document.querySelectorAll('.vfx-clip').length===1);
 assert.equal(await page.locator('.vfx-clip [data-clip-action=select]').innerText(),'Tint');
 await page.evaluate(()=>styk.editor.seek(19));await page.waitForFunction(()=>document.querySelector('.vfx-clip [data-clip-action=select]')?.textContent==='Glow');
 const drag=async(tick,delta,y=13)=>{const point=await page.evaluate(({tick,y})=>{const t=styk.timeline,row=t.tracks.findIndex(r=>r.kind==='vfx'),rect=t.scroll.getBoundingClientRect();return {x:rect.left+tick*t.pxPerTick-t._offsetX(),y:rect.top+t.rowY(row)+y,step:t.pxPerTick};},{tick,y});await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+delta*point.step,point.y,{steps:8});await page.mouse.up();};
 const before=await page.evaluate(()=>JSON.stringify(styk.editor.report._styk.vfxClips));
 await drag(9-.15,-4,19);assert.deepEqual(await page.evaluate(()=>{const c=styk.editor.getVfxClips()[0];return [c.start,c.duration,c.offset,Object.values(c.keys)[0].map(k=>k.tick)];}),[5,29,0,[4,24]]);
 assert.equal(await page.evaluate(()=>styk.timeline.scroll.style.cursor),'ew-resize');
 await page.evaluate(()=>styk.editor.undo());assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.report._styk.vfxClips)),before);
 await drag(34+.15,4,19);assert.equal(await page.evaluate(()=>styk.editor.getVfxClips()[0].duration),29);await page.evaluate(()=>styk.editor.undo());
 await drag(17,5);assert.equal(await page.evaluate(()=>styk.editor.getVfxClips()[0].start),14);
 await drag(14+.15,3,19);assert.deepEqual(await page.evaluate(()=>{const c=styk.editor.getVfxClips()[0];return [c.start,c.duration,c.offset];}),[17,22,3]);
 assert.equal(await page.evaluate(()=>styk.timeline.tracks.filter(r=>r.kind==='vfx-key').length),0);
 await drag(34.5,2,23);assert.equal(await page.evaluate(()=>Object.values(styk.editor.getVfxClips()[0].keys)[0][1].tick),22);
 await page.keyboard.press('Delete');assert.equal(await page.evaluate(()=>Object.values(styk.editor.getVfxClips()[0].keys)[0].length),1);await page.evaluate(()=>styk.editor.undo());
 await page.evaluate(()=>{styk.editor.undo();styk.editor.undo();styk.editor.undo();styk.vfx.sync();});assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.report._styk.vfxClips)),before);
 const fadeDrag=async(label,delta)=>{const slider=page.getByRole('slider',{name:label,exact:true});await slider.waitFor({state:'visible'});const b=await slider.boundingBox(),step=await page.evaluate(()=>styk.timeline.pxPerTick);await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+delta*step,b.y+b.height/2,{steps:8});await page.mouse.up();};
 const history=await page.evaluate(()=>styk.editor._undo.length);await fadeDrag('Fade in',4);await fadeDrag('Fade out',-6);
 assert.deepEqual(await page.evaluate(()=>{const c=styk.editor.getVfxClips()[0];return [c.fadeIn,c.fadeOut,styk.editor._undo.length];}),[4,6,history+2]);
 await page.getByRole('slider',{name:'Fade in',exact:true}).press('ArrowRight');assert.equal(await page.evaluate(()=>styk.editor.getVfxClips()[0].fadeIn),5);
 await page.evaluate(()=>{styk.editor.undo();styk.editor.undo();styk.editor.undo();});assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.report._styk.vfxClips)),before);
 // Cancelling a fade never publishes a partial edit, even after many moves.
 const fade=page.getByRole('slider',{name:'Fade in',exact:true}),box=await fade.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+90,box.y+box.height/2,{steps:8});await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.report._styk.vfxClips)),before);
 // Persistent keys, not just a timed range, control the playhead filter.
 const inactive=await page.evaluate(()=>{const e=styk.editor,id=e.addVfxClip({kind:'figure',uid:1},'blur'),fx=e.getVfxClips().at(-1).effects[0];e.setVfxClipParameter(id,fx.id,'effectStrength',0,{key:true,tick:0});e.setVfxClipParameter(id,fx.id,'effectStrength',1,{key:true,tick:30});e.setVfxClipEasing(id,Object.keys(e.getVfxClips().at(-1).keys)[0],0,'constant');return id;});
 await page.waitForFunction(()=>document.querySelectorAll('.vfx-clip').length===1);await page.evaluate(()=>styk.editor.seek(30));await page.waitForFunction(()=>document.querySelectorAll('.vfx-clip').length===2);
 await page.evaluate(id=>{styk.editor.deleteVfxClip(id);styk.editor.seek(19);},inactive);
 const roundtrip=await page.evaluate(async()=>{
 const {DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs'),{ pageEditor }=await import('/tests/support/page-editor.mjs');
 const saver=new DocumentExporter(),importer=new ImportClient();try{const original=styk.editor.report._styk.vfxClips,blob=await saver.export(styk.editor.report,{format:'styk',name:'Effect clips'}),imported=await importer.importFile(new File([blob],'clips.styk')),reopened=pageEditor({demo:false}).load(imported.document);return JSON.stringify(original)===JSON.stringify(reopened.report._styk.vfxClips);}finally{saver.dispose();importer.dispose();}
 });assert.equal(roundtrip,true);
 await page.mouse.move(500,100);await page.waitForTimeout(500);await fs.mkdir('artifacts/vfx',{recursive:true});await page.screenshot({path:'artifacts/vfx/clips-inspector.png'});
 await page.getByRole('button',{name:'Add effect',exact:true}).click();await page.locator('.vfx-catalog [data-catalog-mode="presets"]').click();await page.locator('.vfx-catalog [data-choice="Power up"]').click();
 await page.getByRole('spinbutton',{name:'Strength',exact:true}).fill('65');await page.getByRole('spinbutton',{name:'Strength',exact:true}).press('Tab');
 const group=await page.evaluate(()=>styk.editor.getVfxClips().at(-1));assert.equal(group.effects.length,2);assert.equal(group.strength,.65);
 await page.getByRole('button',{name:'Add to group',exact:true}).click();await page.locator('.vfx-catalog [data-choice="blur"]').click();assert.equal(await page.evaluate(()=>styk.editor.getVfxClips().at(-1).effects.length),3);
 await page.locator('.vfx-detail .vfx-clip-effect>summary').last().click();await page.locator('.vfx-detail .vfx-clip-effect').last().getByRole('button',{name:'Effect actions',exact:true}).click();await page.getByRole('menuitem',{name:'Remove',exact:true}).click();assert.equal(await page.evaluate(()=>styk.editor.getVfxClips().at(-1).effects.length),2);
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark';window.dispatchEvent(new Event('styk-theme-change'));});await page.mouse.move(500,100);await page.waitForTimeout(300);await page.screenshot({path:'artifacts/vfx/clips-groups-dark.png'});
 // Figure focus is independent of layer membership, including scene effects.
 await page.evaluate(async()=>{const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),{initializeLayerSheet}=await import('/src/editor-layer-sheet.mjs');const e=styk.editor,doc=emptyDocument();doc.keyframes=[createFrame([createObject(doc.figure_types[0],1,300,300),createObject(doc.figure_types[0],2,650,300)],60)];e.load(doc);initializeLayerSheet(e.report);e._invalidate({timing:true});e.addVfxClip({kind:'figure',uid:1},'glow',{start:5,duration:20});e.addVfxClip({kind:'figure',uid:2},'tint');e.addVfxClip({kind:'scene'},'blur');e.select(1);e.seek(10);});
 await page.waitForFunction(()=>styk.timeline.tracks.filter(r=>r.kind==='vfx').flatMap(r=>r.clips).every(c=>c.target.uid===1));
 const shown=()=>page.evaluate(()=>styk.timeline.tracks.filter(r=>r.kind==='vfx').flatMap(r=>r.clips.map(c=>c.target.kind==='scene'?'scene':c.target.uid)));
 assert.deepEqual(await shown(),[1]);await page.evaluate(()=>styk.editor.select(2));await page.waitForFunction(()=>styk.timeline.tracks.some(r=>r.kind==='vfx'&&r.clips[0].target.uid===2));assert.deepEqual(await shown(),[2]);
 await page.evaluate(()=>styk.editor.select(null));assert.deepEqual(await shown(),[]);
 await page.getByRole('button',{name:'Scene effects',exact:true}).click();assert.deepEqual(await shown(),['scene']);
 await page.evaluate(()=>styk.editor.select(1));assert.deepEqual(await shown(),[1]);
 await page.getByRole('button',{name:'Glow',exact:true}).click();await page.getByLabel('Effect target',{exact:true}).selectOption('connected');
 await page.evaluate(()=>{const e=styk.editor,c=e.getVfxClips()[0];e.setVfxClip(c.id,{fadeIn:4,fadeOut:6});e.setVfxClipParameter(c.id,c.effects[0].id,'radius',4,{key:true,tick:5});e.setVfxClipParameter(c.id,c.effects[0].id,'radius',28,{key:true,tick:20});});
 await page.getByRole('slider',{name:'Fade in',exact:true}).waitFor({state:'visible'});
 await page.setViewportSize({width:1200,height:800});await page.mouse.move(500,100);await page.waitForTimeout(200);await page.screenshot({path:'artifacts/vfx/clips-focused-dark.png'});
 assert.equal(await page.locator('.vfx-timeline-overlay [role=slider]').count(),2);
 // The same filter covers pose effects from existing projects.
 await page.evaluate(()=>{const e=styk.editor,target={kind:'figure',uid:1},[id]=e.addVfx(target,'tint');window.legacyVfxId=id;e.setVfxParameter(target,id,'enabled',0);});
 await page.waitForFunction(()=>document.querySelectorAll('.vfx-effect').length===1);
 await page.getByLabel('Show effects',{exact:true}).selectOption('all');await page.getByLabel('Search effect clips',{exact:true}).fill('');assert.equal(await page.locator('.vfx-effect').count(),1);
 await page.evaluate(()=>{const e=styk.editor,target={kind:'figure',uid:1};e.setVfxParameter(target,legacyVfxId,'enabled',1);e.setVfxParameter(target,legacyVfxId,'effectStrength',0);});
 await page.getByLabel('Show effects',{exact:true}).selectOption('playhead');assert.equal(await page.locator('.vfx-effect').count(),0);
 await page.evaluate(()=>styk.editor.setVfxParameter({kind:'figure',uid:1},legacyVfxId,'effectStrength',.5));await page.waitForFunction(()=>document.querySelectorAll('.vfx-effect').length===1);
 errors.push(...await page.evaluate(()=>vfxFailures));console.log(JSON.stringify({errors,selectedFigureOnly:true,inlineKeys:true,fadeControls:true,playheadFilter:true}));assert.deepEqual(errors,[]);
}finally{await browser.close();}
