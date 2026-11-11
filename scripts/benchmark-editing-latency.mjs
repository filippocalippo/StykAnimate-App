/** Real Electron input, cold/warm seeks and GPU completion. Input files are read-only. */
import {_electron as electron} from '../tests/support/playwright.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const source=process.argv[2];if(!source)throw new Error('Provide a PIV animation.');
const output=path.resolve('artifacts/editing-latency',process.env.STYK_PROBE_LABEL||'current');await mkdir(output,{recursive:true});
const app=await electron.launch({args:[process.cwd()],env:{...process.env,STYK_USER_DATA_DIR:path.join(output,'profile')}});
try {
  const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);w.setIgnoreMouseEvents(true);w.setFocusable(false);w.showInactive();});
  await page.waitForFunction(()=>window.styk?.ready);
  if(process.env.STYK_BASELINE_REF){
    // Extract the ref's sources once; one git process per request can exceed
    // the reload timeout on a busy machine.
    const ref=execFileSync('git',['rev-parse','--short',process.env.STYK_BASELINE_REF]).toString().trim(),tree=path.resolve('artifacts/editing-latency',`.source-${ref}`);
    if(!existsSync(path.join(tree,'complete'))){
      const names=execFileSync('git',['ls-tree','-r','--name-only',ref,'src'],{maxBuffer:64*1024*1024}).toString().split('\n').filter(Boolean);
      const batch=execFileSync('git',['cat-file','--batch'],{input:names.map(name=>`${ref}:${name}`).join('\n')+'\n',maxBuffer:1024*1024*1024});
      let at=0;
      for(const name of names){
        const header=batch.indexOf(10,at),size=Number(batch.subarray(at,header).toString().split(' ')[2]);
        await mkdir(path.dirname(path.join(tree,name)),{recursive:true});await writeFile(path.join(tree,name),batch.subarray(header+1,header+1+size));at=header+1+size+1;
      }
      await writeFile(path.join(tree,'complete'),ref);
    }
    await page.context().route('**/src/**',async route=>{
      const file=new URL(route.request().url()).pathname.slice(1),body=await readFile(path.join(tree,file)).catch(()=>null);
      // A worker started before the reload can still request a file that the
      // baseline does not contain; the baseline code never imports it.
      if(body===null)return route.fulfill({status:404,body:''});
      await route.fulfill({body,contentType:file.endsWith('.css')?'text/css':'text/javascript'});
    });
    await page.reload();await page.waitForFunction(()=>window.styk?.ready);
  }
  if(process.env.STYK_BASELINE_DIRECTORY){
    const directory=path.resolve(process.env.STYK_BASELINE_DIRECTORY);
    for(const name of ['playback-worker.mjs','renderer.mjs','renderer-geometry.mjs','playback.mjs'])await page.route(`**/src/${name}`,async route=>route.fulfill({contentType:'text/javascript',body:await readFile(path.join(directory,name))}));
    await page.reload();await page.waitForFunction(()=>window.styk?.ready);
  }
  await page.evaluate(()=>{for(const d of document.querySelectorAll('dialog[open]'))d.close();styk.editor.markSaved();});
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name=>!styk.state.importing&&styk.editor.name===name,path.basename(source,'.piv'),{timeout:180000});
  await page.waitForFunction(()=>!styk.state.dirtyRender);
  await page.evaluate(()=>{
    for(const d of document.querySelectorAll('dialog[open]'))d.close();
    const e=styk.editor,s=styk.state,r=s.renderer;
    window.inputProbe={inputs:[],draws:[],seeks:[],longTasks:[],phase:'setup',lastInput:null};
    const p=inputProbe;
    document.querySelector('#overlay').addEventListener('pointermove',event=>{if(!event.buttons)return;p.lastInput={at:performance.now(),phase:p.phase,kind:s.drag?.kind};p.inputs.push(p.lastInput);},true);
    const render=r.render.bind(r);r.render=options=>{const start=performance.now(),result=render(options),submitted=performance.now();
      const d={tick:e.tick,phase:p.phase,cpu:submitted-start,at:submitted,input:p.lastInput?.at,kind:s.drag?.kind};p.draws.push(d);
      r.device.queue.onSubmittedWorkDone().then(()=>{d.completed=performance.now();});return result;};
    new PerformanceObserver(list=>{for(const entry of list.getEntries())p.longTasks.push({at:entry.startTime,ms:entry.duration,phase:p.phase});}).observe({entryTypes:['longtask']});
  });
  const client=await page.context().newCDPSession(page);await client.send('Profiler.enable');await client.send('Profiler.start');
  // A picked joint can belong to an attached figure. Validate the complete
  // visible pose rather than one selected object's local angle array.
  const poseSnapshot=()=>page.evaluate(()=>JSON.stringify([...styk.editor.geometry.objects.values()].map(g=>({uid:g.obj.unique_id,root:g.root,joints:[...g.joints].sort((a,b)=>a[0]-b[0])})).sort((a,b)=>a.uid-b.uid)));
  const ticks=process.argv.length>3?process.argv.slice(3).map(Number):await page.evaluate(()=>[1,.96,.92,.93,.99,.55,.7,.91,1].map(n=>Math.round((styk.editor.totalTicks-1)*n)));
  for(const phase of['cold-seek','warm-seek'])for(const tick of ticks){
    const request=await page.evaluate(({tick,phase})=>{const p=inputProbe;p.phase=phase;const at=performance.now();styk.editor.seek(tick);
      const s={tick,phase,at,commandMs:performance.now()-at};p.seeks.push(s);return s;},{tick,phase});
    await page.waitForFunction(q=>inputProbe.draws.some(d=>d.tick===q.tick&&d.at>=q.at&&d.completed),request);
    await page.evaluate(()=>{const p=inputProbe,q=p.seeks.at(-1),d=p.draws.find(d=>d.tick===q.tick&&d.at>=q.at&&d.completed);q.submitMs=d.at-q.at;q.completeMs=d.completed-q.at;q.preparation=styk.performance().editablePreparation;});
  }
  for(const kind of['pan','pose']){
    const target=await page.evaluate(async kind=>{
      const e=styk.editor,s=styk.state;inputProbe.phase=kind;inputProbe.lastInput=null;
      const r=document.querySelector('#overlay').getBoundingClientRect();
      if(kind==='pan')return{x:r.x+r.width*.4,y:r.y+r.height*.4};
      const editable=[...e.geometry.objects.values()].find(g=>g.segments.some(s=>!s.static&&s.length>3));
      if(!editable)throw new Error('The benchmark requires a poseable joint.');
      e.select(editable.obj.unique_id,0);const g=e.geometry.objects.get(e.selectedSlot),point=g.segments.find(s=>!s.static&&s.length>3).end;
      const {worldToScreen}=await import('/src/renderer-geometry.mjs'),screen=worldToScreen(point,{report:e.report,frame:e.evaluatedFrame,view:s.view,cameraEnabled:false});
      s.view.x+=r.width/2-screen.x;s.view.y+=r.height/2-screen.y;window.dispatchEvent(new Event('resize'));
      return{x:r.x+r.width/2,y:r.y+r.height/2};
    },kind);
    await page.waitForFunction(()=>!styk.state.dirtyRender);
    const beforePose=kind==='pose'?await poseSnapshot():null;
    await page.mouse.move(target.x,target.y);await page.mouse.down({button:kind==='pan'?'middle':'left'});
    assert.equal(await page.evaluate(()=>styk.state.drag?.kind),kind);
    for(let i=1;i<=60;i++)await page.mouse.move(target.x+i*.8,target.y+i*.4);
    await page.mouse.up({button:kind==='pan'?'middle':'left'});
    await page.waitForFunction(()=>!styk.state.dirtyRender);
    if(kind==='pose'){
      const final=await poseSnapshot();assert.notEqual(final,beforePose,'The gesture must change the visible pose');
      await page.evaluate(()=>styk.editor.undo());await page.waitForFunction(()=>!styk.state.dirtyRender);
      const undone=await poseSnapshot();
      if(undone!==beforePose)await writeFile(path.join(output,'pose-undo-mismatch.json'),JSON.stringify({before:JSON.parse(beforePose),after:JSON.parse(final),undone:JSON.parse(undone)}));
      assert.ok(undone===beforePose,'Undo must restore every joint and figure root; see pose-undo-mismatch.json');
      await page.evaluate(()=>styk.editor.redo());await page.waitForFunction(()=>!styk.state.dirtyRender);
      assert.ok(await poseSnapshot()===final,'Redo must restore the complete posed scene');
    }
  }
  const sheet=await page.locator('.sheet-scroll').boundingBox();
  await page.evaluate(()=>{inputProbe.phase='timeline-scrub';inputProbe.lastInput=null;});
  await page.mouse.move(sheet.x+24,sheet.y+14);await page.mouse.down();
  for(let i=1;i<=45;i++)await page.mouse.move(sheet.x+24+i*9,sheet.y+14);
  assert.ok(await page.evaluate(()=>styk.state.scrubbing));await page.mouse.up();
  await page.waitForFunction(()=>!styk.state.dirtyRender);
  const {profile}=await client.send('Profiler.stop');await writeFile(path.join(output,'main.cpuprofile'),JSON.stringify(profile));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const result=await page.evaluate(()=>({...inputProbe,performance:styk.performance()}));
  const q=values=>{values.sort((a,b)=>a-b);return{n:values.length,p50:values[Math.floor(values.length*.5)],p95:values[Math.floor(values.length*.95)],max:values.at(-1)};};
  const summary={};
  for(const phase of['cold-seek','warm-seek'])summary[phase]={submit:q(result.seeks.filter(s=>s.phase===phase).map(s=>s.submitMs)),complete:q(result.seeks.filter(s=>s.phase===phase).map(s=>s.completeMs))};
  for(const kind of['pan','pose']){const draws=result.draws.filter(d=>d.kind===kind&&d.input&&d.completed);summary[kind]={submit:q(draws.map(d=>d.at-d.input)),complete:q(draws.map(d=>d.completed-d.input))};}
  summary.longTasks=result.longTasks;await writeFile(path.join(output,'report.json'),JSON.stringify({source,summary,...result,errors},null,2));console.log(JSON.stringify({summary,errors},null,2));assert.deepEqual(errors,[]);
} finally {await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
