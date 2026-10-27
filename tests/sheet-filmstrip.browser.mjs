/** Card lifetime, hidden mounting and stale asynchronous thumbnail completion. */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1400,height:1000}}),checks=[],errors=[];
page.on('pageerror',error=>errors.push(error.message));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
try {
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  check('Hidden mount defers selection reveal and thumbnail work',await page.evaluate(async()=>{
    const {pageEditor}=await import('/tests/support/page-editor.mjs'),{createDemo}=await import('/src/demo.mjs'),{SheetFilmstrip}=await import('/src/sheet-filmstrip.mjs');
    const report=createDemo();report.keyframes=Array.from({length:240},(_,i)=>structuredClone(report.keyframes[i%24]));
    const editor=pageEditor().load(report);editor.selectFrame(200);
    const host=document.createElement('div');host.style.cssText='position:fixed;left:20px;top:100px;width:640px;height:260px;z-index:10000';
    host.style.setProperty('display','none','important');document.body.append(host);
    window.filmstripTest={editor,host,painted:0,release:null,hold:false};const state=filmstripTest;
    state.ui=new SheetFilmstrip(host,editor,{renderThumbnail:async(index,canvas)=>{
      if(state.hold){state.hold=false;await new Promise(resolve=>state.release=resolve);}
      const ctx=canvas.getContext('2d');ctx.fillStyle='rgb(25,80,160)';ctx.fillRect(0,0,canvas.width,canvas.height);state.painted++;return true;
    }});
    return state.ui.revealPending&&state.ui.selected.has(200)&&state.painted===0&&state.ui.cards.size===0;
  }));
  await page.evaluate(()=>filmstripTest.host.style.removeProperty('display'));
  await page.waitForFunction(()=>!filmstripTest.ui.revealPending&&filmstripTest.ui.previews.has(200));
  check('First visible layout reveals the selected late frame',await page.evaluate(()=>{const {ui}=filmstripTest,a=ui.strip.getBoundingClientRect(),b=ui.cards.get(200).getBoundingClientRect();return b.left>=a.left&&b.right<=a.right;}));
  await page.evaluate(()=>{const {ui}=filmstripTest;ui.strip.scrollLeft=0;ui.render();});
  await page.waitForFunction(()=>filmstripTest.ui.previews.has(0));
  check('Rendering preserves deliberate scrolling away from the playhead',await page.evaluate(()=>filmstripTest.ui.strip.scrollLeft===0));
  await page.evaluate(()=>{const s=filmstripTest;s.old=s.ui.cards.get(0);s.hold=true;s.ui.selectFrame(30);});
  await page.waitForFunction(()=>filmstripTest.release);
  check('Evicting a card aborts its event handlers',await page.evaluate(()=>filmstripTest.old._events.signal.aborted));
  await page.evaluate(()=>{const s=filmstripTest;s.ui.selectFrame(60);s.ui.render();s.release();s.release=null;});
  await page.waitForFunction(()=>filmstripTest.ui.previews.has(60)&&!filmstripTest.ui.busy);
  check('Late thumbnail results cannot mark discarded cards as painted',await page.evaluate(()=>{const {ui}=filmstripTest;return [...ui.previews.keys()].every(i=>ui.cards.has(i));}));
  const beforeAudio=await page.evaluate(()=>{const s=filmstripTest;s.ui.audio.setOpen(true);s.ui.selectFrame(150);s.ui.render();return s.painted;});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  check('Audio tab retains time navigation without rendering hidden thumbnails',await page.evaluate(before=>{const s=filmstripTest;return s.painted===before&&s.ui.strip.scrollLeft>0&&s.ui.audio.open;},beforeAudio));
  await page.evaluate(()=>filmstripTest.ui.audio.setOpen(false));
  await page.waitForFunction(()=>filmstripTest.ui.previews.has(150)&&!filmstripTest.ui.busy);
  check('Closing Audio resumes filmstrip thumbnails',await page.evaluate(()=>filmstripTest.painted>0&&filmstripTest.ui.cards.has(150)));
  for(const index of [0,239,30,0,100,200,0]){
    await page.evaluate(i=>filmstripTest.ui.selectFrame(i),index);
    await page.waitForFunction(i=>filmstripTest.ui.previews.has(i)&&!filmstripTest.ui.busy,index);
    check(`Frame ${index+1} repaints on return with bounded resources`,await page.evaluate(i=>{const {ui}=filmstripTest,p=ui.cards.get(i)._canvas.getContext('2d').getImageData(50,30,1,1).data;return p[0]===25&&p[1]===80&&p[2]===160&&p[3]===255&&ui.previews.size<=ui.cards.size&&ui.cards.size<=10&&ui.queue.length<=ui.cards.size;},index));
  }
  await page.evaluate(()=>{const {ui}=filmstripTest;ui.selectFrame(0);});
  await page.waitForFunction(()=>filmstripTest.ui.previews.has(0)&&!filmstripTest.ui.busy);
  await page.evaluate(()=>{const {ui}=filmstripTest,render=ui.renderThumbnail;let fail=true;ui.renderThumbnail=async(...args)=>{if(fail){fail=false;return false;}return render(...args);};ui.previews.delete(0);ui.bitmapCache.delete(0);ui.update();});
  await page.waitForFunction(()=>filmstripTest.ui.thumbnailStats.retries>0&&filmstripTest.ui.previews.has(0)&&!filmstripTest.ui.busy);
  check('Cancelled preview retries without another user interaction',true);
  check('Preview bitmap cache stays below 8 MiB',await page.evaluate(()=>filmstripTest.ui.bitmapCache.size<=32));
  const invalidations=await page.evaluate(()=>filmstripTest.ui.thumbnailStats.invalidations);
  await page.evaluate(()=>filmstripTest.editor.renameLayer('layer-1','Renamed'));
  check('Renaming a layer preserves thumbnails',await page.evaluate(n=>filmstripTest.ui.thumbnailStats.invalidations===n,invalidations));
  await mkdir('artifacts/sheet-filmstrip',{recursive:true});await page.screenshot({path:'artifacts/sheet-filmstrip/lifetimes.png'});
  check('Disposal releases cards, queues, preview markers and listeners',await page.evaluate(()=>{const {ui,host}=filmstripTest,cards=[...ui.cards.values()];ui.destroy();host.remove();return !ui.cards.size&&!ui.previews.size&&!ui.queue.length&&cards.every(c=>c._events.signal.aborted);}));
  check('No uncaught browser errors',errors.length===0);
  await writeFile('artifacts/sheet-filmstrip/report.json',JSON.stringify({checks,errors},null,2));
}finally{await browser.close();}
