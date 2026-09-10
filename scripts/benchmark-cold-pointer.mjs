/** A fresh import followed by the first physical gesture on its heaviest frame.
 * No editor selection, pose, or translation command is run before pointerdown. */
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const source=process.argv[2],label=process.argv[3]??'cold-pointer',output=`artifacts/connected-editing/${label}`;
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
page.setDefaultTimeout(180000);page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(()=>{styk.settingsUI.commit({timelineMode:'advanced'});styk.editor.markSaved();});
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name=>!styk.state.importing&&styk.editor.name===name,path.basename(source,'.piv'));
  await page.evaluate(()=>{
    const e=styk.editor,counts=new Map(e.report.figure_types.map(f=>[f.figure_type_id,f.segments.length]));
    const frames=e.report.keyframes.map((f,i)=>({i,size:f.objects.reduce((n,o)=>n+counts.get(o.figure_type_id),0)}));
    e.selectFrame(frames.reduce((a,b)=>a.size>b.size?a:b).i);styk.fit();
  });
  await page.waitForFunction(()=>!styk.state.editablePreparing&&styk.performance().editingPresentation?.tick===styk.editor.tick);
  const target=await page.evaluate(async()=>{
    const {getPivotHandles,pickCanvasHandle}=await import('/src/canvas-interactions.mjs'),{worldToScreen}=await import('/src/renderer-geometry.mjs');
    const e=styk.editor,s=styk.state,g=s.renderer.lastGeometry,frame=e.evaluatedFrame;
    const children=new Map();for(const o of frame.objects)if(o.join){const slot=o.join.target_object_slot;if(!children.has(slot))children.set(slot,[]);children.get(slot).push(o.object_slot);}
    const subtree=slot=>{const slots=new Set([slot]),queue=[slot];for(let i=0;i<queue.length;i++)for(const child of children.get(queue[i])??[])if(!slots.has(child)){slots.add(child);queue.push(child);}return slots;};
    const group=frame.objects.filter(o=>!o.join).map(o=>subtree(o.object_slot)).sort((a,b)=>b.size-a.size)[0];
    s.view.scale=Math.max(1,s.view.scale);
    const options={frame,selectedUid:null,selectedUids:new Set(),showUnselected:s.settings.showUnselectedHandles,viewScale:s.view.scale};
    const handles=getPivotHandles(g,options),project=p=>worldToScreen(p,{report:e.report,frame,view:s.view,cameraEnabled:false});
    const chosen=handles.find(h=>{
      if(!group.has(frame.objects.findIndex(o=>o.unique_id===h.uid))||h.action!=='pose'||h.static)return false;
      const hit=pickCanvasHandle(g,h.point,{...options,handles,project,nearest:true,minRadius:8});return hit?.uid===h.uid&&hit?.joint===h.joint;
    });if(!chosen)throw Error('No exposed connected joint.');
    const rect=document.querySelector('#viewport').getBoundingClientRect(),p=worldToScreen(chosen.point,{report:e.report,frame,view:{x:0,y:0,scale:s.view.scale},cameraEnabled:false});
    s.view.x=rect.width*.5-p.x;s.view.y=rect.height*.4-p.y;s.dirtyRender=true;window.dispatchEvent(new Event('resize'));
    window.pointerBench={before:JSON.stringify(frame.objects,(_k,v)=>_k==='runtime_segments'?undefined:v),history:e._undo.length,events:[],tasks:[],active:false};
    return {x:rect.left+rect.width*.5,y:rect.top+rect.height*.4,uid:chosen.uid,joint:chosen.joint,parts:group.size};
  });
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await page.evaluate(()=>{
    const b=pointerBench;b.active=true;
    b.observer=new PerformanceObserver(list=>b.tasks.push(...list.getEntries().map(e=>e.duration)));b.observer.observe({type:'longtask'});
    for(const type of ['pointerdown','pointermove','pointerup'])document.addEventListener(type,event=>{
      if(b.active&&event.target.closest('#viewport'))b.events.push({type,start:performance.now()});
    },true);
    const r=styk.state.renderer,render=r.render;
    r.render=function(...args){const pending=b.events.filter(e=>e.submitted===undefined);const value=render.apply(this,args);
      const now=performance.now();for(const event of pending)event.submitted=now-event.start;
      this.device.queue.onSubmittedWorkDone().then(()=>{for(const event of pending)event.gpuComplete=performance.now()-event.start;});return value;};
  });
  await page.mouse.move(target.x,target.y);await page.mouse.down();
  const picked=await page.evaluate(()=>({kind:styk.state.drag?.kind,uid:styk.editor.selectedUid,joint:styk.editor.selectedJoint}));
  for(let step=1;step<=24;step++){
    await page.mouse.move(target.x+step*1.5,target.y-step);
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(r)));
  }
  await page.mouse.up();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const result=await page.evaluate(async()=>{
    const b=pointerBench,e=styk.editor;await styk.state.renderer.device.queue.onSubmittedWorkDone();b.active=false;b.observer.disconnect();
    const read=()=>JSON.stringify(e.evaluatedFrame.objects,(_k,v)=>_k==='runtime_segments'?undefined:v),changed=read()!==b.before,commands=e._undo.length-b.history;
    e.undo();const restored=read()===b.before;e.markSaved();
    return {events:b.events,longTasks:b.tasks,changed,commands,restored};
  });
  const report={source,target,picked,...result,errors};await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  if(errors.length||picked.kind!=='pose'||!result.changed||result.commands!==1||!result.restored)throw Error('Cold pointer correctness failed.');
}finally{await browser.close();}
