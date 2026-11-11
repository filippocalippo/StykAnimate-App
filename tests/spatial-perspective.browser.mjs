import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const out='artifacts/spatial-perspective';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.STYK_URL??'http://127.0.0.1:47851');await page.waitForFunction(()=>window.styk?.ready);
 const source=process.argv[2]?JSON.parse(await readFile(process.argv[2],'utf8')):null;
 await page.evaluate(async doc=>{
  for(const d of document.querySelectorAll('dialog[open]'))d.close();
  if(!doc){const {construction}=await import('/src/rig-examples-3d.mjs'),{createObject,createFrame,emptyDocument}=await import('/src/demo.mjs');const q=construction();q.add(0,0,0,'Figure');
   const bone=(parent,origin,tip,name)=>{const turn=q.add(0,0,0,'Turn'),pitch=q.add(0,0,0,'Tilt'),v=tip.map((n,i)=>n-origin[i]);return q.add(parent,Math.hypot(...v),Math.atan2(v[1],v[0]),name,{control:true,width:18,rig:{spatial:{parent,origin,tip,turn,pitch}}});};
   const a=bone(0,[0,0,0],[0,100,0],'Upper arm'),b=bone(a,[0,100,0],[0,180,0],'Forearm');bone(b,[0,180,0],[20,180,0],'Hand');const f={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]};doc={...emptyDocument(),figure_types:[f],keyframes:[createFrame([createObject(f,1,400,200)])]};
  }
  styk.editor.load(doc);styk.editor.select(1,-1);styk.state.onion=false;styk.state.settings.autosaveSeconds=0;styk.fit();
 },source);
 await page.locator('[data-section-toggle=spatial-perspective]').click();
 const camera=page.getByRole('slider',{name:'Perspective',exact:true});await camera.scrollIntoViewIfNeeded();const r=await camera.boundingBox(),before=await page.evaluate(()=>({doc:styk.editor.serialize(),undo:styk.editor._undo.length}));
 await page.mouse.move(r.x+3,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width*.8,r.y+r.height/2,{steps:8});await page.mouse.up();
 assert.equal(await page.evaluate(()=>styk.editor._undo.length),before.undo+1);assert.ok(await page.evaluate(()=>styk.editor.getSpatialCamera().strength)>.5);
 await page.evaluate(()=>styk.editor.undo());assert.deepEqual(await page.evaluate(()=>styk.editor.serialize()),before.doc);
 await camera.focus();await camera.press('End');assert.equal(await page.evaluate(()=>styk.editor.getSpatialCamera().strength),1);
 await page.evaluate(()=>{const e=styk.editor,i=e.figure.segments.findIndex(s=>s.name==='Right lower leg'||s.name==='Forearm');e.select(1,i);if(!e.getIKSettings().enabled)e.setNodeIK({enabled:true,chainLength:2,pinned:false});else e.setNodeIK({pinned:false});const p=e.geometry.objects.get(e.selectedSlot).segments[i].end;e.poseJoint(p.x+15,p.y-30);});
 const depth=page.getByRole('spinbutton',{name:'Toward camera value',exact:true});const oldDepth=Number(await depth.inputValue());await depth.fill(String(oldDepth+12));await depth.press('Tab');
 const reach=await page.evaluate(()=>{const e=styk.editor,s=e.geometry.objects.get(e.selectedSlot).segments[e.selectedJoint];return s.end.rawPoint[2];});assert.ok(Math.abs(reach-oldDepth-12)<.1);
 await page.getByRole('button',{name:source?'Ankle rotation':'Hand rotation',exact:true}).click();
 const shape=page.locator('[data-section-toggle="spatial-proportions"]');await shape.click();
 const width=page.getByRole('slider',{name:'Width',exact:true});await width.scrollIntoViewIfNeeded();const w=await width.boundingBox(),shapeBefore=await page.evaluate(()=>({doc:styk.editor.serialize(),undo:styk.editor._undo.length}));
 await page.mouse.move(w.x+w.width*.3,w.y+w.height/2);await page.mouse.down();await page.mouse.move(w.x+w.width*.55,w.y+w.height/2,{steps:7});await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual(await page.evaluate(()=>styk.editor.serialize()),shapeBefore.doc);
 const size=page.getByRole('spinbutton',{name:'Part size value',exact:true});await size.fill('140');await size.press('Tab');assert.ok(Math.abs(await page.evaluate(()=>styk.editor.getSpatialProportions().length)-1.4)<1e-5);
 await page.getByRole('spinbutton',{name:'Taper value',exact:true}).fill('20');await page.getByRole('spinbutton',{name:'Taper value',exact:true}).press('Tab');
 await page.screenshot({path:out+'/controls.png'});
 if(!source){
  await page.getByRole('button',{name:'Move figure',exact:true}).click();
  const root=await page.evaluate(()=>{const e=styk.editor,g=e.geometry.objects.get(0),r=document.getElementById('viewport').getBoundingClientRect(),v=styk.state.view;return{x:r.x+v.x+g.root.x*v.scale,y:r.y+v.y+g.root.y*v.scale};});
  await page.mouse.move(root.x,root.y);await page.mouse.down();await page.mouse.move(root.x+30,root.y+12,{steps:6});
  const live=await page.evaluate(()=>({live:styk.state.drag?.ikLive,points:[...styk.editor.geometry.objects.get(0).joints].map(([id,p])=>[id,p.x,p.y])}));assert.equal(live.live,true,'Perspective root movement evaluates projection during the gesture');
  await page.mouse.up();assert.deepEqual(await page.evaluate(()=>[...styk.editor.geometry.objects.get(0).joints].map(([id,p])=>[id,p.x,p.y])),live.points,'Committing root movement must not jump');
 }

 await page.evaluate(()=>{const r=document.getElementById('inspector');if(r.scrollWidth>r.clientWidth+1)throw new Error('Rig panel overflows');});
 assert.deepEqual(errors,[]);await writeFile(out+'/browser.json',JSON.stringify({passed:true,errors,document:source?'full-character':'fixture'},null,2));console.log('Perspective UI: pointer gesture/undo, keyboard slider, numeric depth, shape cancellation, size/taper, layout and console checks passed.');
}finally{await browser.close();}
