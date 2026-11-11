import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
 await page.evaluate(async()=>{
 const {emptyDocument,createFrame,createObject,defaultFigure}=await import('/src/demo.mjs');
 const {movieclipFigure}=await import('/src/movieclips.mjs');const {presencePlayback}=await import('/tests/support/movieclip-playback.mjs');
 const f=defaultFigure(),child=emptyDocument();child.keyframes=[createFrame([createObject(f,1,50,60)],20)];
 const clip=movieclipFigure(2,'Walking clip',child,{duration:20,pivot:{x:50,y:60}}),report=emptyDocument();report.figure_types=[f,clip];
 report.keyframes=[0,1,2,3].map(n=>createFrame([createObject(f,1,200+n*20,300),...(n===0?[createObject(clip,7,420,300,{_stykMovieclip:presencePlayback()})]:[])],3));
 styk.editor.load(report);styk.editor.select(7);
 });
 await page.waitForFunction(()=>document.querySelector('[data-movieclip-current-frame]')?.textContent==='1 / 20');
 assert.match(await page.locator('[data-movieclip-duration]').textContent(),/20 frames · 0\.833 s · 24 fps/);
 // Extend is a titled section: one click opens it, and it stays open for the next movieclip.
 await page.locator('[data-section-toggle="extend"]').click();
 const input=page.getByRole('spinbutton',{name:'Next keyframes',exact:true});await input.fill('2');
 await page.getByRole('button',{name:'Add to next keyframes',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-movieclip-feedback]')?.textContent==='Added to 2 keyframes.');
 assert.equal(await input.inputValue(),'2');
 await input.focus();
 await page.evaluate(()=>{
  window.clipFeedback=document.querySelector('[data-movieclip-feedback]');window.clipDraft=document.querySelector('[data-movieclip-next-keys]');
  window.clipBytes=JSON.stringify(styk.editor.report);window.clipHistory=styk.editor._undo.length;
  styk.localization.localization.setPseudo('rtl');
 });
 assert.ok(await page.evaluate(()=>clipFeedback===document.querySelector('[data-movieclip-feedback]')&&clipFeedback.textContent===styk.localization.t('movieclipUi.addedToKeyframes',{count:2})
  &&document.activeElement===clipDraft&&clipDraft.value==='2'&&JSON.stringify(styk.editor.report)===clipBytes&&styk.editor._undo.length===clipHistory));
 await page.evaluate(()=>styk.localization.localization.setPseudo(null));
 await page.getByRole('button',{name:'Add to next keyframes',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-movieclip-feedback]')?.textContent==='Already present in these keyframes.');
 assert.deepEqual(await page.evaluate(()=>{const e=styk.editor;return [3,6,9].map(t=>{e.seek(t);return e.evaluatedFrame.objects.some(o=>o.unique_id===7);});}),[true,true,false]);
 await page.evaluate(()=>{styk.editor.seek(0);styk.editor.select(7);});
 await input.waitFor({state:'visible'});await input.fill('99');await page.getByRole('button',{name:'Add to next keyframes',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-movieclip-feedback]')?.textContent==='Added to 1 keyframe. Already present: 2.');
 await mkdir('artifacts/movieclip-extend',{recursive:true});await page.screenshot({path:'artifacts/movieclip-extend/inspector.png'});
 await page.getByRole('spinbutton',{name:'Movieclip start frame',exact:true}).fill('4');await page.keyboard.press('Tab');
 await page.getByRole('spinbutton',{name:'Movieclip speed',exact:true}).fill('2');await page.keyboard.press('Tab');
 await page.evaluate(()=>{styk.editor.seek(6);styk.editor.select(7);});
 await page.waitForFunction(()=>document.querySelector('[data-movieclip-current-frame]')?.textContent==='16 / 20');
 assert.equal(await page.locator('.movieclip-scene-frame').innerText(),'Scene 7');
 await page.getByLabel('Movieclip playback',{exact:true}).selectOption('single');
 await page.waitForFunction(()=>document.querySelector('[data-movieclip-current-frame]')?.textContent==='4 / 20');
 assert.ok(await page.getByRole('spinbutton',{name:'Movieclip speed',exact:true}).isDisabled());
 await page.getByLabel('Movieclip playback',{exact:true}).selectOption('hold');
 await page.evaluate(()=>{styk.editor.seek(9);styk.editor.select(7);});
 await page.waitForFunction(()=>document.querySelector('[data-movieclip-current-frame]')?.textContent==='20 / 20');
 assert.ok(await page.getByRole('button',{name:'Add to next keyframes',exact:true}).isDisabled());
 // A different source FPS still reports source frames, not scene ticks.
 await page.evaluate(()=>{const e=styk.editor;const report=structuredClone(e.report);report.figure_types.find(f=>f.figure_type_id===2)._styk.movieclip.document.fps=12;e.load(report);e.seek(6);e.select(7);});
 await page.waitForFunction(()=>document.querySelector('[data-movieclip-current-frame]')?.textContent==='10 / 20');
 // Scoped styles fit the narrow inspector in both themes; all controls remain reachable.
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>styk.settingsUI.commit({theme}),theme);
  await page.setViewportSize({width:1100,height:900});
  await page.locator('[data-section-toggle="bake"]').click();
  await page.getByRole('button',{name:'Export movieclip',exact:true}).scrollIntoViewIfNeeded();
  assert.ok(await page.getByRole('button',{name:'Bake animation',exact:true}).isVisible());
  assert.ok(await page.locator('#inspector').evaluate(el=>el.scrollWidth<=el.clientWidth));
  await page.locator('[data-section-toggle="bake"]').click();
  await page.locator('#inspector').evaluate(el=>el.scrollTo(0,0));
  await page.screenshot({path:`artifacts/movieclip-extend/${theme}-compact.png`});
 }
 assert.deepEqual(errors,[]);await page.evaluate(()=>styk.editor.markSaved());
 console.log('PASS extension feedback, no-op and limits; source frame, FPS, speed and hold; compact light/dark inspector and secondary actions; no browser errors');
}finally{await browser.close();}
