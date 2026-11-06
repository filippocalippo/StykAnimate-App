import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const out='artifacts/spatial-controls';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.STYK_URL??'http://127.0.0.1:47851');await page.waitForFunction(()=>window.styk?.ready);
 const doc=process.argv[2]?JSON.parse(await readFile(process.argv[2],'utf8')):null;
 await page.evaluate(async document=>{
  const s=window.styk;for(const d of window.document.querySelectorAll('dialog[open]'))d.close();
  if(!document){
   const{construction}=await import('/src/rig-examples-3d.mjs'),{createObject,createFrame,emptyDocument}=await import('/src/demo.mjs');
   const q=construction();q.add(0,0,0,'Figure rotation');
   const bone=(parent,origin,tip,name)=>{const turn=q.add(0,0,0,'Turn'),pitch=q.add(0,0,0,'Tilt'),v=tip.map((n,i)=>n-origin[i]);return q.add(parent,Math.hypot(...v),Math.atan2(v[1],v[0]),name,{control:true,width:18,rig:{spatial:{parent,origin,tip,turn,pitch}}});};
   const a=bone(0,[0,0,0],[0,100,0],'Upper arm'),b=bone(a,[0,100,0],[0,180,0],'Forearm'),f={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]};
   document={...emptyDocument(),figure_types:[f],keyframes:[createFrame([createObject(f,1,400,200)])]};
  }
  s.editor.load(document);s.editor.select(1,-1);s.state.onion=false;s.state.settings.autosaveSeconds=0;s.fit();
 },doc);
 const eyes=page.getByRole('combobox',{name:'Eyes',exact:true});
 if(await eyes.count()){
  const original=await page.evaluate(()=>styk.editor.serialize()),count=await page.evaluate(()=>styk.editor._undo.length);
  for(const label of ['Neutral','Focused','Closed']){
   await eyes.selectOption({label});
   assert.equal(await page.evaluate(async()=>{const{poseChoiceGroups}=await import('/src/rig-pose-choices.mjs');const e=styk.editor,g=poseChoiceGroups(e.figure,e.object)[0];return g.choices.find(c=>c.id===g.value)?.label;}),label);
  }
  await eyes.selectOption('0');assert.equal(await page.evaluate(()=>styk.editor._undo.length),count+4);
  await page.evaluate(()=>{for(let i=0;i<4;i++)styk.editor.undo();});assert.deepEqual(await page.evaluate(()=>styk.editor.serialize()),original);
 }
 await page.getByRole('button',{name:'Rotate',exact:true}).click();
 assert.ok(await page.evaluate(()=>Boolean(styk.editor.getSpatialPose())),'Rotate selects the first articulation');
 await page.getByText('Exact angles',{exact:true}).click();
 const range=page.getByRole('slider',{name:'Turn',exact:true});await range.scrollIntoViewIfNeeded();const box=await range.boundingBox();
 const before=await page.evaluate(()=>({angles:[...styk.editor.object.angles],undo:styk.editor._undo.length}));
 await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.7,box.y+box.height*.5,{steps:12});await page.mouse.up();
 let after=await page.evaluate(()=>({angles:[...styk.editor.object.angles],undo:styk.editor._undo.length,drag:styk.editor.dragging}));
 assert.notDeepEqual(after.angles,before.angles);assert.equal(after.undo,before.undo+1);assert.equal(after.drag,false);
 await page.evaluate(()=>styk.editor.undo());assert.deepEqual(await page.evaluate(()=>styk.editor.object.angles),before.angles);
 await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.65,box.y+box.height*.5,{steps:5});await page.keyboard.press('Escape');await page.mouse.up();
 assert.deepEqual(await page.evaluate(()=>styk.editor.object.angles),before.angles,'Escape restores the complete slider gesture');
 for(const label of ['Turn','Tilt','Bend']){const field=page.getByRole('spinbutton',{name:label+' degrees',exact:true});await field.fill('23');await field.press('Tab');}
 const pose=await page.evaluate(()=>styk.editor.getSpatialPose());for(const n of Object.values(pose))assert.ok(Math.abs(n-23*Math.PI/180)<1e-7);
 await page.getByRole('button',{name:'Reset pose',exact:true}).click();
 const pad=page.getByRole('button',{name:'Turn and tilt',exact:true});await pad.scrollIntoViewIfNeeded();const pb=await pad.boundingBox(),padBefore=await page.evaluate(()=>({doc:styk.editor.serialize(),undo:styk.editor._undo.length}));
 await page.mouse.move(pb.x+pb.width/2,pb.y+pb.height/2);await page.mouse.down();await page.mouse.move(pb.x+pb.width/2+20,pb.y+pb.height/2+12,{steps:8});await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual(await page.evaluate(()=>styk.editor.serialize()),padBefore.doc);
 await page.mouse.move(pb.x+pb.width/2,pb.y+pb.height/2);await page.mouse.down();await page.mouse.move(pb.x+pb.width/2+20,pb.y+pb.height/2+12,{steps:8});await page.mouse.up();
 const padAfter=await page.evaluate(()=>({pose:styk.editor.getSpatialPose(),undo:styk.editor._undo.length}));assert.ok(Math.abs(padAfter.pose.turn-20*Math.PI/180)<1e-7);assert.ok(Math.abs(padAfter.pose.pitch-12*Math.PI/180)<1e-7);assert.equal(padAfter.undo,padBefore.undo+1);await page.evaluate(()=>styk.editor.undo());
 await pad.focus();await pad.press('ArrowRight');assert.ok(Math.abs(await page.evaluate(()=>styk.editor.getSpatialPose().turn)-5*Math.PI/180)<1e-7);await page.evaluate(()=>styk.editor.undo());
 const point=await page.evaluate(()=>{const{editor:e,state}=styk,g=e.geometry.objects.get(0),p=g.segments[e.selectedJoint].start,r=document.getElementById('viewport').getBoundingClientRect();return{x:r.x+state.view.x+p.x*state.view.scale,y:r.y+state.view.y+p.y*state.view.scale};});
 const initial=await page.evaluate(()=>styk.editor.object.angles.slice());
 await page.mouse.move(point.x+3,point.y+3);await page.mouse.down();await page.mouse.move(point.x+35,point.y-15,{steps:10});
 assert.equal(await page.evaluate(()=>styk.state.drag?.kind),'spatial');assert.notDeepEqual(await page.evaluate(()=>styk.editor.object.angles),initial,'Free trackball changes the pose before cancellation');
 await page.keyboard.press('Escape');await page.mouse.up();
 assert.deepEqual(await page.evaluate(()=>styk.editor.object.angles),initial,'Escape restores the canvas rotation gesture');
 const undoCount=await page.evaluate(()=>styk.editor._undo.length);
 await page.mouse.move(point.x+3,point.y+3);await page.mouse.down();await page.mouse.move(point.x-21,point.y+17,{steps:10});await page.mouse.up();
 assert.equal(await page.evaluate(()=>styk.editor._undo.length),undoCount+1);assert.notDeepEqual(await page.evaluate(()=>styk.editor.object.angles),initial);await page.evaluate(()=>styk.editor.undo());assert.deepEqual(await page.evaluate(()=>styk.editor.object.angles),initial);
 await page.getByRole('button',{name:'Pose',exact:true}).click();await range.waitFor({state:'detached'});
 const ik=await page.evaluate(()=>{const e=styk.editor,i=e.figure.segments.findIndex(s=>e.object._stykIK?.[s.segment_id]?.enabled);if(i>=0)e.select(1,i);else{e.select(1,e.figure.segments.length-1);e.setNodeIK({enabled:true,chainLength:2,pinned:false});}const p=e.geometry.objects.get(0).segments[e.selectedJoint].end,r=document.getElementById('viewport').getBoundingClientRect(),v=styk.state.view;return{x:r.x+v.x+p.x*v.scale,y:r.y+v.y+p.y*v.scale,world:{...p},scale:v.scale};});
 await page.mouse.move(ik.x,ik.y);await page.mouse.down();await page.mouse.move(ik.x+12,ik.y-15,{steps:12});await page.mouse.up();
 const end=await page.evaluate(()=>{const e=styk.editor;return e.geometry.objects.get(0).segments[e.selectedJoint].end;});
 assert.ok(Math.hypot(end.x-ik.world.x-12/ik.scale,end.y-ik.world.y+15/ik.scale)<.5,'Pointer drag reaches the IK target');
 // Bursty pointer devices must evaluate only the newest pose in a frame.
 const burstPoint=await page.evaluate(()=>{const e=styk.editor,g=e.geometry.objects.get(0),p=g.segments[e.selectedJoint].end,r=document.getElementById('viewport').getBoundingClientRect(),v=styk.state.view;return{x:r.x+v.x+p.x*v.scale,y:r.y+v.y+p.y*v.scale};});
 await page.mouse.move(burstPoint.x,burstPoint.y);await page.mouse.down();
 const burst=await page.evaluate(({x,y})=>{
  const e=styk.editor,overlay=document.getElementById('overlay'),original=e.poseJoint.bind(e);let calls=0;e.poseJoint=(...args)=>{calls++;return original(...args);};
  for(let i=1;i<=24;i++)overlay.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:x+i/2,clientY:y-i/3,buttons:1,isPrimary:true}));
  const before=calls;overlay.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,clientX:x+12,clientY:y-8,isPrimary:true}));
  e.poseJoint=original;return{before,after:calls,dragging:e.dragging};
 },burstPoint);
 await page.mouse.up();// The first move poses at once (it starts the gesture); the other 23 coalesce into the one pose the release flushes.
 assert.equal(burst.before,1);assert.equal(burst.after,2);assert.equal(burst.dragging,false);await page.evaluate(()=>styk.editor.undo());
 await page.getByRole('button',{name:'Rotate figure',exact:true}).click();
 const figureBefore=await page.evaluate(()=>styk.editor.serialize());
 await page.getByRole('button',{name:'Turn and tilt',exact:true}).press('ArrowRight');
 assert.notDeepEqual(await page.evaluate(()=>styk.editor.serialize()),figureBefore);
 await page.evaluate(()=>styk.editor.undo());assert.deepEqual(await page.evaluate(()=>styk.editor.serialize()),figureBefore);
 await page.getByRole('button',{name:'Pose',exact:true}).click();
 const plant=page.getByRole('button',{name:'Plant both feet',exact:true});
 if(await plant.count()){
  const beforePlant=await page.evaluate(()=>({doc:styk.editor.serialize(),undo:styk.editor._undo.length}));
  await plant.click();assert.equal(await page.evaluate(()=>styk.editor._undo.length),beforePlant.undo+1);
  await page.getByRole('button',{name:'Release feet',exact:true}).waitFor();
  await page.getByRole('button',{name:'Left foot',exact:true}).click();
  await page.getByText('More limb options',{exact:true}).click();
  const swivel=page.getByRole('slider',{name:'Bend direction',exact:true});await swivel.scrollIntoViewIfNeeded();const rect=await swivel.boundingBox();
  const plantedBefore=await page.evaluate(()=>{const e=styk.editor,g=e.geometry.objects.get(0);return{end:g.segments[e.selectedJoint].end,undo:e._undo.length,angles:e.object.angles.slice()};});
  await page.mouse.move(rect.x+rect.width*.5,rect.y+rect.height*.5);await page.mouse.down();await page.mouse.move(rect.x+rect.width*.7,rect.y+rect.height*.5,{steps:8});await page.mouse.up();
  const plantedAfter=await page.evaluate(()=>{const e=styk.editor;return{end:e.geometry.objects.get(0).segments[e.selectedJoint].end,undo:e._undo.length,swivel:e.getIKSettings().spatialTarget.swivel};});
  assert.ok(plantedAfter.swivel>.3);assert.equal(plantedAfter.undo,plantedBefore.undo+1);assert.ok(Math.hypot(plantedAfter.end.x-plantedBefore.end.x,plantedAfter.end.y-plantedBefore.end.y)<.01);
  await page.evaluate(()=>styk.editor.undo());assert.deepEqual(await page.evaluate(()=>styk.editor.object.angles),plantedBefore.angles);
  // Pose uses native joints only; no IK target, depth or pole overlays.
  assert.equal(await page.evaluate(async()=>{const{spatialGizmoDrag}=await import('/src/spatial-controls.mjs');return spatialGizmoDrag(styk.editor,{x:0,y:0},p=>p);}),null);
  await page.getByRole('button',{name:'Release feet',exact:true}).click();await plant.waitFor();
  const depth=page.getByRole('spinbutton',{name:'Target depth',exact:true}),beforeDepth=await page.evaluate(()=>({doc:styk.editor.serialize(),undo:styk.editor._undo.length}));
  await depth.fill('12');await depth.press('Tab');assert.equal(await page.evaluate(()=>styk.editor._undo.length),beforeDepth.undo+1);await page.evaluate(()=>styk.editor.undo());assert.deepEqual(await page.evaluate(()=>styk.editor.serialize()),beforeDepth.doc);
  // Limb controls stay attached to their IK target while Rotate selects the
  // foot itself, and the slider remains one gesture despite that mapping.
  await page.getByRole('button',{name:'Rotate',exact:true}).click();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const freeSwivel=page.getByRole('slider',{name:'Bend direction',exact:true});await freeSwivel.scrollIntoViewIfNeeded();const fs=await freeSwivel.boundingBox(),saved=await page.evaluate(()=>({doc:styk.editor.serialize(),undo:styk.editor._undo.length,index:styk.editor.selectedJoint}));
  await page.mouse.move(fs.x+fs.width*.5,fs.y+fs.height*.5);await page.mouse.down();await page.mouse.move(fs.x+fs.width*.6,fs.y+fs.height*.5,{steps:8});await page.mouse.up();assert.equal(await page.evaluate(()=>styk.editor._undo.length),saved.undo+1);assert.equal(await page.evaluate(()=>styk.editor.selectedJoint),saved.index);await page.evaluate(()=>styk.editor.undo());assert.deepEqual(await page.evaluate(()=>styk.editor.serialize()),saved.doc);
  await page.getByRole('button',{name:'Pose',exact:true}).click();
 }
 if(doc){
  await page.getByRole('button',{name:'Left foot',exact:true}).click();
  for(const [label,name] of [['Thigh rotation','Left thigh'],['Shin rotation','Left lower leg'],['Ankle rotation','Left foot ankle'],['Toe bend','Left foot toe']]){
   await page.getByRole('button',{name:label,exact:true}).click();assert.equal(await page.evaluate(()=>styk.editor.figure.segments[styk.editor.selectedJoint].name),name);
  }
  await page.getByRole('button',{name:'Pose',exact:true}).click();
 }
 const form=page.locator('[data-drawing-group]');if(await form.count()){
  const old=await page.evaluate(()=>styk.editor.selectionFrame.objects[1]._stykMovieclip.offset);await form.selectOption('1');await page.waitForTimeout(200);
  assert.notEqual(await page.evaluate(()=>styk.editor.selectionFrame.objects[1]._stykMovieclip.offset),old);assert.equal(await page.evaluate(()=>styk.editor.selectedUid),1);
  await page.evaluate(()=>styk.editor.undo());assert.equal(await page.evaluate(()=>styk.editor.selectionFrame.objects[1]._stykMovieclip.offset),old);
 }
 await page.screenshot({path:out+'/pose.png'});await page.getByRole('button',{name:'Rotate',exact:true}).click();await page.screenshot({path:out+'/rotate.png'});
 assert.deepEqual(errors,[]);await writeFile(out+'/report.json',JSON.stringify({passed:true,errors},null,2));console.log('Spatial controls: slider, numeric axes, one-step undo, slider/canvas cancellation, IK mouse drag and drawing selection passed.');
}finally{await browser.close();}
