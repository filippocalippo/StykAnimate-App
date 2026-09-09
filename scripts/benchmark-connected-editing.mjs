/** Exact-file cold selection/pose/seek profile. Input files are only read. */
import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const source=process.argv[2] ?? 'C:/Users/aleri/Downloads/tdd2 uriel nemesis 2.piv';
const label=process.argv[3] ?? 'local';
const mode=process.argv[4] ?? 'advanced';
const output=`artifacts/connected-editing/${label}`;
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.setDefaultTimeout(180000);
try {
  await page.goto(process.env.STYK_URL ?? 'http://127.0.0.1:47831');
  await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(mode=>{styk.settingsUI.commit({timelineMode:mode});styk.editor.markSaved();},mode);
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name=>!styk.state.importing&&styk.editor.name===name,path.basename(source,'.piv'));
  console.log('Imported',source);
  const scene=await page.evaluate(()=>{
    const e=styk.editor,counts=new Map(e.report.figure_types.map(f=>[f.figure_type_id,f.segments.length]));
    const frames=e.report.keyframes.map((f,i)=>({i,objects:f.objects.length,segments:f.objects.reduce((n,o)=>n+counts.get(o.figure_type_id),0)}));
    const heaviest=frames.reduce((a,b)=>a.segments>b.segments?a:b);e.selectFrame(heaviest.i);
    if(e._frameDraftEnabled)e.beginFrameDraft({mode:'update'});
    e.select(null);styk.fit();
    const groups=e.frame.objects.filter(o=>!o.join).map(o=>({uid:o.unique_id,...e.resolveTranslationSelection(new Set([o.unique_id]))}));
    const group=groups.sort((a,b)=>b.affectedSlots.length-a.affectedSlots.length)[0];
    window.connectedBench={group,heaviest};
    return {frames:frames.length,heaviest,groupSize:group.affectedSlots.length,rootUid:group.uid,renderer:styk.performance().renderer};
  });
  await page.waitForTimeout(500);
  const client=await page.context().newCDPSession(page);
  await client.send('Profiler.enable');await client.send('Profiler.start');
  const measured=await page.evaluate(async()=>{
    const e=styk.editor,b=connectedBench,raf=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const timings={},calls=[],tasks=[],intervals=[],commits=[];let done=false,last;
    const recordCommit=()=>commits.push({channels:e.animationChannels.map(c=>({id:c.id,keys:c.keys.length,nativeProperties:c.nativeProperties})),historyBytes:e.historySize});
    const wrap=(object,name)=>{const fn=object[name];if(typeof fn!=='function')return;object[name]=function(...args){const start=performance.now();try{return fn.apply(this,args);}finally{const ms=performance.now()-start;if(ms>1)calls.push({name,ms});}};};
    for(const name of ['_emit','nativePoseChannel','nativePropertyChannel','beginDrag','poseJoint','commitDrag','commitAuthoredPoseDrag','addAnimationKeys','_record','_beginAuthoredPoseDrag','select','selectFrame'])wrap(e,name);
    for(const name of ['_reindex','_filterActionTracks','_drawChannelGrid','_drawLabels'])wrap(styk.timeline,name);
    const observer=new PerformanceObserver(list=>tasks.push(...list.getEntries().map(x=>({start:x.startTime,ms:x.duration}))));observer.observe({type:'longtask'});
    const heartbeat=now=>{if(last!==undefined)intervals.push(now-last);last=now;if(!done)requestAnimationFrame(heartbeat);};requestAnimationFrame(heartbeat);
    const measure=(name,fn)=>{const start=performance.now(),value=fn();(timings[name]??=[]).push(performance.now()-start);return value;};
    measure('coldSelection',()=>e.select(b.group.uid));await raf();
    const geometry=e.geometry,g=geometry.objects.get(e.selectedSlot),joint=g.segments.find(s=>!s.static);
    const capture=()=>{const geo=e.geometry;return b.group.affectedUids.map(uid=>{const object=e.evaluatedFrame.objects.find(o=>o.unique_id===uid),g=geo.objects.get(object.object_slot);return {uid,root:{...g.root},angles:[...object.angles],join:object.join?{...object.join}:null};});};
    const before=capture();
    if(joint) {
      e.select(b.group.uid,joint.index);await raf();
      measure('coldBeginPose',()=>e.beginDrag());
      for(let step=1;step<=12;step++){measure('pose',()=>e.poseJoint(joint.end.x+step,joint.end.y-step*.7,{snap:false}));await raf();}
      measure('coldCommitPose',()=>e.commitDrag());recordCommit();await raf();
      const changed=capture();measure('undoPose',()=>e.undo());await raf();
      const restored=capture();b.poseChanged=JSON.stringify(before)!==JSON.stringify(changed);b.poseUndo=JSON.stringify(before)===JSON.stringify(restored);
    }
    for(let iteration=0;iteration<2;iteration++){
      e.select(b.group.uid);measure(iteration?'warmBeginMove':'coldBeginMove',()=>e.beginTranslationDrag());
      for(let step=0;step<12;step++){measure('move',()=>e.moveSelection(1,.5));await raf();}
      measure(iteration?'warmCommitMove':'coldCommitMove',()=>e.commitDrag());recordCommit();await raf();
      if(!iteration){
        for(let i=0;i<8;i++){measure('authoredSeek',()=>e.selectFrame(Math.max(0,b.heaviest.i-(i%3))));await raf();}
        e.selectFrame(b.heaviest.i);await raf();
      }
      measure('undoMove',()=>e.undo());await raf();
    }
    for(let i=0;i<8;i++){measure('seek',()=>e.selectFrame(Math.max(0,b.heaviest.i-(i%3))));await raf();}
    e.selectFrame(b.heaviest.i);await raf();
    done=true;observer.disconnect();e.markSaved();
    const summary=a=>{const sorted=a.slice().sort((a,b)=>a-b);return {n:a.length,p50:sorted[Math.floor(a.length*.5)],p95:sorted[Math.floor(a.length*.95)],max:sorted.at(-1)};};
    return {timings:Object.fromEntries(Object.entries(timings).map(([k,v])=>[k,summary(v)])),calls,commits,longTasks:tasks,frameIntervals:summary(intervals),poseChanged:b.poseChanged,poseUndo:b.poseUndo,rows:(styk.timeline.tracks??[]).map(t=>({id:t.id,kind:t.kind,name:t.name})),channels:e.animationChannels.length};
  });
  const {profile}=await client.send('Profiler.stop');
  await writeFile(`${output}/cpu.cpuprofile`,JSON.stringify(profile));
  const target=await page.evaluate(async()=>{
    const {getPivotHandles,pickCanvasHandle}=await import('/src/canvas-interactions.mjs');
    const {worldToScreen}=await import('/src/renderer-geometry.mjs');
    const e=styk.editor,s=styk.state,g=e.geometry,group=new Set(connectedBench.group.affectedUids);
    e.select(null);s.view.scale=Math.max(1,s.view.scale);
    const options={frame:e.evaluatedFrame,selectedUid:e.selectedUid,selectedUids:e.selectedUids,
      showUnselected:s.settings.showUnselectedHandles,viewScale:s.view.scale};
    const handles=getPivotHandles(g,options);
    const project=point=>worldToScreen(point,{report:e.report,frame:e.evaluatedFrame,view:s.view,cameraEnabled:false});
    const chosen=handles.find(h=>{
      if(!group.has(h.uid)||h.action!=='pose'||h.static)return false;
      const hit=pickCanvasHandle(g,h.point,{...options,handles,project,nearest:true,minRadius:8});
      return hit?.uid===h.uid&&hit?.joint===h.joint;
    });
    if(!chosen)throw new Error('No exposed connected joint for pointer verification.');
    const rect=document.querySelector('#viewport').getBoundingClientRect();
    const relative=worldToScreen(chosen.point,{report:e.report,frame:e.evaluatedFrame,view:{x:0,y:0,scale:s.view.scale},cameraEnabled:false});
    s.view.x=rect.width*.5-relative.x;s.view.y=rect.height*.4-relative.y;s.dirtyRender=true;window.dispatchEvent(new Event('resize'));
    connectedBench.pointerBefore=JSON.stringify(e.evaluatedFrame.objects.map(({runtime_segments,...o})=>o));
    return {x:rect.left+rect.width*.5,y:rect.top+rect.height*.4,uid:chosen.uid,joint:chosen.joint,history:e._undo.length};
  });
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await page.mouse.move(target.x,target.y);await page.mouse.down();
  const picked=await page.evaluate(()=>({kind:styk.state.drag?.kind,uid:styk.editor.selectedUid,joint:styk.editor.selectedJoint}));
  await page.mouse.move(target.x+35,target.y-25,{steps:16});await page.mouse.up();
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const pointer=await page.evaluate(({target,picked})=>{
    const e=styk.editor,read=()=>JSON.stringify(e.evaluatedFrame.objects.map(({runtime_segments,...o})=>o));
    const changed=read()!==connectedBench.pointerBefore,commands=e._undo.length-target.history;
    e.undo();const restored=read()===connectedBench.pointerBefore;e.markSaved();e.select(connectedBench.group.uid);styk.fit();
    const group=styk.timeline.assemblyByUid?.get(target.uid);
    if(group){styk.timeline.expandedTracks.add(group.id);styk.timeline._filterActionTracks();styk.timeline.resize();styk.timeline.update();}
    return {picked,changed,commands,restored,rows:(styk.timeline.tracks??[]).map(row=>({kind:row.kind,name:row.name}))};
  },{target,picked});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await page.screenshot({path:`${output}/scene.png`});
  await writeFile(`${output}/report.json`,JSON.stringify({source,mode,scene,...measured,pointer,errors},null,2));
  console.log(JSON.stringify({scene,timings:measured.timings,frameIntervals:measured.frameIntervals,longTasks:measured.longTasks,poseUndo:measured.poseUndo,errors}));
  if(errors.length||!measured.poseChanged||!measured.poseUndo)throw new Error('Connected pose/undo verification failed.');
  if(picked.kind!=='pose'||!pointer.changed||pointer.commands!==1||!pointer.restored)throw new Error(`Pointer verification failed: ${JSON.stringify(pointer)}`);
} finally {await browser.close();}
