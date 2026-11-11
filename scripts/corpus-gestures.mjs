import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';

/** Real pointer gestures on the measured scene. Screenshots and exact pose
 * restoration stay outside timed movement samples. */
export async function probeCorpusGestures(page,{tick,dir}){
  const ready=()=>page.waitForFunction(()=>!styk.state.dirtyRender,null,{timeout:120000});
  await page.evaluate(tick=>{styk.editor.seek(tick);styk.fit();},tick);await ready();
  await page.evaluate(()=>{
    const p=window.gestureProbe={samples:[],phase:'setup',input:0};
    document.querySelector('#overlay').addEventListener('pointermove',e=>{if(e.buttons)p.input=performance.now();},true);
    const r=styk.state.renderer,render=r.render.bind(r);
    r.render=options=>{const at=performance.now(),result=render(options),end=performance.now();if(styk.state.drag&&p.input){const input=p.input,s={kind:styk.state.drag.kind,cpu:end-at,submit:end-input};p.samples.push(s);r.device?.queue.onSubmittedWorkDone().then(()=>s.complete=performance.now()-input);}return result;};
  });
  const pose=()=>page.evaluate(()=>JSON.stringify([...styk.editor.geometry.objects.values()].map(g=>({uid:g.obj.unique_id,root:g.root,joints:[...g.joints].sort((a,b)=>a[0]-b[0])})).sort((a,b)=>a.uid-b.uid)));
  const results={tick};
  for(const kind of ['pan','pose']){
    const target=await page.evaluate(async kind=>{
      const e=styk.editor,s=styk.state,r=document.querySelector('#overlay').getBoundingClientRect();
      gestureProbe.phase=kind;gestureProbe.input=0;
      if(kind==='pan')return{x:r.x+r.width*.4,y:r.y+r.height*.4};
      const g=[...e.geometry.objects.values()].find(g=>g.segments.some(d=>!d.static&&d.length>3&&d.opacity>0));
      if(!g)return null;
      e.select(g.obj.unique_id,0);const point=g.segments.find(d=>!d.static&&d.length>3&&d.opacity>0).end;
      const {worldToScreen}=await import('/src/renderer-geometry.mjs'),p=worldToScreen(point,{report:e.report,frame:e.frame,view:s.view,cameraEnabled:false});
      s.view.x+=r.width/2-p.x;s.view.y+=r.height/2-p.y;window.dispatchEvent(new Event('resize'));
      return{x:r.x+r.width/2,y:r.y+r.height/2};
    },kind);
    if(!target){results.pose={applicable:false,reason:'No visible poseable joint at inspected tick'};continue;}
    await ready();const before=kind==='pose'?await pose():null;
    await page.mouse.move(target.x,target.y);await page.mouse.down({button:kind==='pan'?'middle':'left'});
    const actual=await page.evaluate(()=>styk.state.drag?.kind);
    if(actual!==kind){await page.mouse.up({button:kind==='pan'?'middle':'left'});results[kind]={applicable:true,error:`Expected ${kind}, received ${actual}`};continue;}
    for(let n=1;n<=24;n++)await page.mouse.move(target.x+n*.8,target.y+n*.4);
    await page.mouse.up({button:kind==='pan'?'middle':'left'});await ready();
    if(kind==='pose'){
      const after=await pose();assert.notEqual(after,before,'Node gesture must change geometry');
      await page.evaluate(()=>styk.editor.undo());await ready();const undone=await pose();
      if(undone!==before)await writeFile(path.join(dir,'undo-mismatch.json'),JSON.stringify({before:JSON.parse(before),after:JSON.parse(after),undone:JSON.parse(undone)}));
      assert.ok(undone===before,'Undo must restore exact joints; see undo-mismatch.json');
      await page.evaluate(()=>styk.editor.redo());await ready();assert.equal(await pose(),after,'Redo must restore exact joints');
      results.pose={applicable:true,undoRedo:true};
    }else results.pan={applicable:true};
  }
  const sheet=await page.locator('.sheet-scroll').boundingBox();
  if(sheet&&await page.evaluate(()=>styk.editor.totalTicks>1)){
    await page.mouse.move(sheet.x+24,sheet.y+14);await page.mouse.down();
    for(let n=1;n<=24;n++)await page.mouse.move(sheet.x+24+n*8,sheet.y+14);
    results.scrub=await page.evaluate(()=>({active:styk.state.scrubbing}));
    const at=Date.now();await page.mouse.up();await ready();results.scrub.releaseMs=Date.now()-at;
  }
  const samples=await page.evaluate(()=>gestureProbe.samples);
  const q=values=>{values.sort((a,b)=>a-b);return{n:values.length,p50:values[Math.floor(values.length*.5)],p95:values[Math.floor(values.length*.95)],max:values.at(-1)};};
  for(const kind of ['pan','pose']){results[kind]??={};results[kind].submit=q(samples.filter(s=>s.kind===kind).map(s=>s.submit));results[kind].cpu=q(samples.filter(s=>s.kind===kind).map(s=>s.cpu));}
  await writeFile(path.join(dir,'gestures.json'),JSON.stringify({results,samples},null,2));return results;
}
