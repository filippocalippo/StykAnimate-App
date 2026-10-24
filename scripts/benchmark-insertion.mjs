/** Real-scene command CPU/paint profile. Never writes the input project. */
import {chromium} from '../tests/support/playwright.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
const source = path.resolve(process.argv[2]);
const output = path.resolve('artifacts/insertion', process.argv[3] ?? 'current');
await mkdir(output, {recursive:true});
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1600,height:1000}});
page.setDefaultTimeout(180000);
const errors=[], phases=[];
const sourceHashes={},sourceReads=[];
page.on('response',response=>{
  const pathname=new URL(response.url()).pathname;
  if(pathname.startsWith('/src/')&&pathname.endsWith('.mjs'))sourceReads.push(response.body().then(bytes=>{sourceHashes[pathname]=createHash('sha256').update(bytes).digest('hex');}));
});
page.on('pageerror', error=>errors.push(error.message));
const client=await page.context().newCDPSession(page);
await client.send('Profiler.enable');
try {
  await page.goto(process.env.STYK_URL ?? 'http://127.0.0.1:47832');
  await page.waitForFunction(()=>window.styk?.ready);
  await page.screenshot({path:path.join(output,'startup.png')});
  console.log('Startup',await page.locator('#viewport').isVisible(),await page.locator('#play-button').isVisible(),errors);
  await page.evaluate(()=>styk.editor.markSaved());
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name=>styk.editor.name===name&&!styk.state.importing,path.basename(source,'.piv'));
  const scene=await page.evaluate(()=>{
    const e=styk.editor,counts=new Map(e.report.figure_types.map(f=>[f.figure_type_id,f.segments.length]));
    const rows=e.report.keyframes.map((f,i)=>({i,objects:f.objects.length,segments:f.objects.reduce((n,o)=>n+counts.get(o.figure_type_id),0)}));
    const dense=rows.reduce((a,b)=>a.segments>b.segments?a:b);e.selectFrame(dense.i);
    const object=e.selectionFrame.objects.filter(o=>!o.join).sort((a,b)=>counts.get(b.figure_type_id)-counts.get(a.figure_type_id))[0];
    e.select(object.unique_id);styk.fit();
    window.__insert={uid:object.unique_id,tick:e.tick,longTasks:[]};
    new PerformanceObserver(list=>__insert.longTasks.push(...list.getEntries().map(e=>({start:e.startTime,ms:e.duration})))).observe({entryTypes:['longtask']});
    return {frames:rows.length,ticks:e.totalTicks,types:e.report.figure_types.length,dense,uid:object.unique_id,layerSheet:!!e.report._styk.layerSheet};
  });
  console.log('Scene',scene);
  async function phase(name,operation){
    await page.waitForTimeout(500);await client.send('Profiler.start');
    const result=await page.evaluate(async operation=>{
      const start=performance.now(),bytes=styk.editor.historySize;
      const result=await (0,eval)(operation);
      const commandMs=performance.now()-start;
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return {commandMs,paintMs:performance.now()-start,historyBytes:styk.editor.historySize-bytes,result,start,
        longTasks:__insert.longTasks.filter(task=>task.start>=start)};
    },operation);
    const {profile}=await client.send('Profiler.stop');
    await writeFile(path.join(output,name+'.cpuprofile'),JSON.stringify(profile));
    const nodes=new Map(profile.nodes.map(n=>[n.id,n.callFrame])),times=new Map();
    profile.samples.forEach((id,i)=>times.set(id,(times.get(id)??0)+(profile.timeDeltas[i]??0)/1000));
    result.top=[...times].sort((a,b)=>b[1]-a[1]).slice(0,12).map(([id,ms])=>({...nodes.get(id),ms}));
    phases.push({name,...result});console.log(name,JSON.stringify(result));
  }
  await phase('figure-copy','styk.editor.copySelection()');
  await phase('figure-paste','styk.editor.pasteSelection().length');
  await page.evaluate(()=>{styk.editor.undo();styk.editor.select(__insert.uid);});
  await phase('figure-move',`(()=>{const e=styk.editor;e.beginTranslationDrag();e.moveSelection(20,10,{fromStart:true});return e.commitDrag();})()`);
  await page.evaluate(async()=>{
    const {librarySnapshot}=await import('/src/library-files.mjs');__insert.figureAsset=librarySnapshot(styk.editor);
  });
  await phase('figure-drop','styk.editor.importFigure(__insert.figureAsset,{position:{x:300,y:200}}).unique_id');
  await page.evaluate(()=>{styk.editor.undo();styk.editor.select(__insert.uid);});
  await page.evaluate(async()=>{
    const {buildGeometry}=await import('/src/pivot/geometry.mjs'),{sampleSheet}=await import('/tests/helpers/sheet-samples.mjs');
    const e=styk.editor,start=e.tick,end=Math.min(e.totalTicks,start+16);
    __insert.captureTicks=[...new Set([Math.max(0,start-1),start,(start+end-1)/2,end-1,Math.min(e.totalTicks-1,end)])];
    __insert.shape=t=>buildGeometry(e.report,sampleSheet(e.report,t)).drawables.map(d=>({type:d.type,rgb:d.rgb,alpha:d.alpha,points:d.points?.map(p=>[p.x,p.y])??[]}));
    __insert.beforeCapture=__insert.captureTicks.map(__insert.shape);
  });
  await phase('clip-create',`(()=>{const e=styk.editor;return e.createMovieclip({start:e.tick,end:Math.min(e.totalTicks,e.tick+16)}).figure_type_id;})()`);
  const clipCheck=await page.evaluate(()=>{
    const mismatches=[];
    __insert.captureTicks.forEach((tick,i)=>{
      const actual=__insert.shape(tick),expected=__insert.beforeCapture[i];
      if(actual.length!==expected.length||actual.some((a,j)=>{
        const b=expected[j];return a.type!==b.type||JSON.stringify(a.rgb)!==JSON.stringify(b.rgb)||a.alpha!==b.alpha||a.points.length!==b.points.length||a.points.some((p,k)=>p.some((n,l)=>Math.abs(n-b.points[k][l])>.0001));
      }))mismatches.push(tick);
    });
    const command=styk.editor._undo.at(-1),sources=command.commands.flatMap(c=>c.frameSourceChanges??[]);
    return {ticks:__insert.captureTicks,mismatches,historyBytes:command.bytes,sourceFrames:sources.length,sourceObjects:sources.reduce((n,s)=>n+s.after.value.objects.length,0)};
  });
  assert.deepEqual(clipCheck.mismatches,[],'Movieclip conversion preserves the dense scene before, inside and after its range.');
  await phase('clip-copy','styk.editor.copySelection()');
  await phase('clip-paste','styk.editor.pasteSelection({newIdentities:true}).length');
  await phase('clip-move',`(()=>{const e=styk.editor;e.beginTranslationDrag();e.moveSelection(20,10,{fromStart:true});return e.commitDrag();})()`);
  await page.evaluate(async()=>{const {librarySnapshot}=await import('/src/library-files.mjs');__insert.clipAsset=librarySnapshot(styk.editor);});
  await phase('clip-drop','styk.editor.importFigure(__insert.clipAsset,{position:{x:500,y:350}}).unique_id');
  const target=await page.evaluate(async()=>{
    const {worldToScreen}=await import('/src/renderer-geometry.mjs');
    const e=styk.editor,s=styk.state,r=document.querySelector('#viewport').getBoundingClientRect(),root=e.geometry.objects.get(e.selectedSlot).root;
    const point=worldToScreen(root,{report:e.report,frame:e.frame,view:s.view,cameraEnabled:false});
    s.view.x+=r.width/2-point.x;s.view.y+=r.height/2-point.y;s.dirtyRender=true;window.dispatchEvent(new Event('resize'));
    const p=worldToScreen(root,{report:e.report,frame:e.frame,view:s.view,cameraEnabled:false});
    return {x:r.left+p.x,y:r.top+p.y,uid:e.selectedUid,root:{x:e.object.root_x,y:e.object.root_y},scale:s.view.scale};
  });
  await page.waitForTimeout(300);
  await page.mouse.move(target.x,target.y);await page.mouse.down();
  assert.equal(await page.evaluate(()=>styk.state.drag?.kind),'move');
  assert.equal(await page.evaluate(()=>styk.editor.selectedUid),target.uid);
  await page.mouse.move(target.x+32,target.y+16,{steps:12});await page.mouse.up();
  const moved=await page.evaluate(()=>({x:styk.editor.object.root_x,y:styk.editor.object.root_y,dragging:styk.editor.dragging}));
  assert.ok(Math.abs(moved.x-target.root.x-32/target.scale)<1);
  assert.ok(Math.abs(moved.y-target.root.y-16/target.scale)<1);
  assert.equal(moved.dragging,false);
  const pointerCheck={target,moved};
  await page.screenshot({path:path.join(output,'result.png')});
  await Promise.all(sourceReads);
  await writeFile(path.join(output,'report.json'),JSON.stringify({source,sourceHashes,scene,phases,clipCheck,pointerCheck,errors,limitations:['Headless Chrome; commands include synchronous application listeners; paint is two requestAnimationFrame callbacks, not display scanout.','Library drop measures decoded asset insertion; file reading/decoding and desktop clipboard transfer are excluded.']},null,2));
  if(errors.length)throw new Error(errors.join('\n'));
} finally {await browser.close();}
