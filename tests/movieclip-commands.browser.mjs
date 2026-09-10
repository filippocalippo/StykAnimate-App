import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const out=path.resolve('artifacts/movieclips');await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1560,height:1000}}),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
async function select(tick){await page.evaluate(t=>{styk.editor.seek(t);styk.editor.select(window.clipUid);},tick);await page.getByLabel('Movieclip playback',{exact:true}).waitFor();}
try{
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {Editor}=await import('/src/editor.mjs');styk.settingsUI.commit({timelineMode:'advanced'});styk.editor.load(new Editor().report);styk.editor.select(1);
    const {buildGeometry,evaluatedFrame,timeline}=await import('/src/pivot/geometry.mjs');
    window.snapshot=t=>{const e=styk.editor,rows=timeline(e.report);let i=0;while(i+1<rows.length&&rows[i+1].start<=t)i++;return buildGeometry(e.report,evaluatedFrame(e.report,i,(t-rows[i].start)/rows[i].count,t)).drawables.map(s=>[s.type,s.rgb,s.points.map(p=>[Math.round(p.x*1e5),Math.round(p.y*1e5)])]);};
    window.before=Array.from({length:30},(_,t)=>snapshot(t));styk.movieclips.open('range');
  });
  await page.locator('.movieclip-dialog input[name=name]').fill('Five frames');
  await page.locator('.movieclip-dialog input[name=end]').fill('5');await page.locator('.movieclip-dialog button[type=submit]').click();
  await page.waitForFunction(()=>styk.editor.figure?.name==='Five frames');await page.evaluate(()=>window.clipUid=styk.editor.selectedUid);
  check('End is set before any timeline drag',await page.getByLabel('Movieclip end',{exact:true}).inputValue()==='5');
  await select(0);await page.locator('[data-action=movieclip-break]').click();
  await page.waitForFunction(()=>!styk.editor.figure?._styk?.movieclip);
  const first=await page.evaluate(()=>styk.editor.selectedUid);
  await select(1);await page.locator('[data-action=movieclip-break]').click();
  check('Adjacent breaks reuse one ordinary figure track',await page.evaluate(id=>styk.editor.selectedUid===id,first));
  check('Frame breaks use layer poses without figure channels',await page.evaluate(()=>styk.editor.animationChannels.length===0));
  check('Every frame retains the original scene geometry',await page.evaluate(()=>before.every((frame,t)=>JSON.stringify(frame)===JSON.stringify(snapshot(t)))));
  await page.screenshot({path:path.join(out,'break-apart-poses.png')});
  await select(2);
  check('Clip returns after the two broken frames',await page.evaluate(()=>styk.editor.evaluatedFrame.objects.some(o=>o.unique_id===clipUid)));
  await page.screenshot({path:path.join(out,'frame-gaps.png')});
  await select(3);await page.locator('[data-action=movieclip-restart]').click();
  check('Restart button keeps the placement and resets the current sample',await page.evaluate(()=>styk.editor.object._stykMovieclip.start===0&&styk.editor.object._stykMovieclip.end===5&&styk.editor.object._movieclipSample===0));
  await page.evaluate(()=>window.restarted=Array.from({length:30},(_,t)=>snapshot(t)));
  await select(4);await page.locator('[data-action=movieclip-split]').click();
  check('Split button produces a different instance with the original end',await page.evaluate(()=>styk.editor.selectedUid!==clipUid&&styk.editor.object._stykMovieclip.start===4&&styk.editor.object._stykMovieclip.end===5));
  check('Split changes no rendered frame',await page.evaluate(()=>restarted.every((frame,t)=>JSON.stringify(frame)===JSON.stringify(snapshot(t)))));
  await page.keyboard.press('Control+z');await select(2);await page.locator('[data-action=movieclip-bake]').click();
  await page.waitForFunction(()=>styk.editor._undo.at(-1)?.label==='Bake animation');
  check('Bake button preserves previous breaks and every scene frame',await page.evaluate(()=>restarted.every((frame,t)=>JSON.stringify(frame)===JSON.stringify(snapshot(t)))));
  await page.evaluate(()=>styk.settingsUI.commit({timelineMode:'simple'}));
  check('Simple uses exactly the same baked poses',await page.evaluate(()=>restarted.every((frame,t)=>JSON.stringify(frame)===JSON.stringify(snapshot(t)))));
  await page.screenshot({path:path.join(out,'baked-simple.png')});
  await page.evaluate(()=>styk.settingsUI.commit({timelineMode:'advanced'}));
  check('Switching back retains timing and geometry',await page.evaluate(()=>restarted.every((frame,t)=>JSON.stringify(frame)===JSON.stringify(snapshot(t)))));
  await page.evaluate(async()=>{
    const {Editor}=await import('/src/editor.mjs');styk.editor.load(new Editor().report);styk.settingsUI.commit({timelineMode:'simple'});
    styk.editor.select(1);styk.movieclips.open('selection');
  });
  await page.locator('.movieclip-dialog input[name=name]').fill('Simple clip');await page.locator('.movieclip-dialog button[type=submit]').click();
  await page.waitForFunction(()=>styk.editor.figure?.name==='Simple clip');
  await page.getByRole('button',{name:'Add frame',exact:true}).click();
  check('Simple Add button places the clip at its new frame',await page.evaluate(()=>{
    const e=styk.editor,o=e.evaluatedFrame.objects.find(o=>o._stykMovieclip);return o&&o._stykMovieclip.start===e.tick&&e.totalTicks>=o._stykMovieclip.end;
  }));
  await page.evaluate(()=>styk.settingsUI.commit({timelineMode:'advanced'}));
  check('The added Simple clip remains visible in Advanced',await page.evaluate(()=>styk.editor.evaluatedFrame.objects.some(o=>o._stykMovieclip)&&styk.editor.geometry.drawables.length===12));
  check('No browser errors',errors.length===0);
}catch(error){await page.screenshot({path:path.join(out,'commands-failure.png')});throw error;}
finally{await writeFile(path.join(out,'commands-results.json'),JSON.stringify({checks,errors},null,2));await browser.close();}
