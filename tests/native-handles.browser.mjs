/** Real pointer acceptance for native handle colors, routing and modifiers. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve('artifacts/native-handle-pointer'); await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1000}}), errors=[],checks=[],routes=[];
page.on('pageerror',error=>errors.push(error.message));
const check=(name,result)=>{assert.ok(result,name);checks.push(name);console.log('PASS',name);};
const near=(a,b,tolerance=.003)=>Math.abs(a-b)<tolerance;
const settle=()=>page.waitForTimeout(80);
async function setup() {
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const report=emptyDocument(),figure=report.figure_types[0],base=figure.segments[0];
    figure.segments=[{...base,segment_id:1,parent_id:0,length:120,angle_rad:0},
      {...base,segment_id:2,parent_id:1,length:80,angle_rad:Math.PI/2},
      {...base,segment_id:3,parent_id:0,length:90,angle_rad:Math.PI},
      {...base,segment_id:4,parent_id:1,length:55,angle_rad:0}]; figure.segment_count=4;
    report.keyframes=[createFrame([createObject(figure,1,300,220),
      createObject(figure,2,420,220,{scale:.5,join:{target_object_slot:0,target_handle_id:1}}),
      createObject(figure,3,640,420,{scale:.6})]),createFrame([createObject(figure,1,300,220)])];
    styk.editor.load(report,'Native handle pointer test'); styk.editor.select(2,0); styk.state.handles=true;
    styk.state.settings.showUnselectedHandles=true;styk.state.settings.handleSize=5;styk.fit();
    const {worldToScreen}=await import('/src/renderer.mjs');
    window.__screen=point=>{const r=document.querySelector('#viewport').getBoundingClientRect();
      const p=worldToScreen(point,{report:styk.editor.report,frame:styk.editor.evaluatedFrame,view:styk.state.view});return{x:r.x+p.x,y:r.y+p.y};};
    window.__points=()=>[...styk.editor.geometry.objects].flatMap(([slot,g])=>[...g.joints].map(([id,p])=>({slot,uid:g.obj.unique_id,id,...p})));
    window.__before=__points(); window.__frameBefore=JSON.stringify(styk.editor.frame);
  });
  await page.keyboard.press('v'); await settle();
}
const worldPoint=async(uid,id)=>page.evaluate(({uid,id})=>{const e=styk.editor,g=[...e.geometry.objects.values()].find(g=>g.obj.unique_id===uid);return g.joints.get(id);},{uid,id});
const screenPoint=point=>page.evaluate(point=>__screen(point),point);
async function drag(uid,id,target,{keys=[],button='left',cancel=false,name='drag'}={}) {
  const point=await worldPoint(uid,id),start=await screenPoint(point),end=await screenPoint(target);
  await page.mouse.move(start.x,start.y); for(const key of keys)await page.keyboard.down(key);
  await page.mouse.down({button}); const route=await page.evaluate(()=>({kind:styk.state.drag?.kind,uid:styk.editor.selectedUid,joint:styk.editor.selectedJoint,held:styk.state.handleEditHeld}));
  routes.push({name,...route}); await page.mouse.move(end.x,end.y,{steps:12});
  if(cancel)await page.keyboard.press('Escape'); await page.mouse.up({button});
  for(const key of [...keys].reverse())await page.keyboard.up(key); await settle(); return route;
}
try {
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>styk?.ready);
  await setup();
  const route=await drag(1,1,{x:420,y:260},{name:'joined-parent'});
  check('Joined child selection routes shared node to parent pose',route.kind==='pose'&&route.uid===1&&route.joint===0);
  check('Parent origin and unrelated free origin stay fixed',await page.evaluate(()=>__points().filter(p=>p.id===0&&p.uid!==2).every(p=>{const b=__before.find(v=>v.uid===p.uid&&v.id===p.id);return p.x===b.x&&p.y===b.y;})));
  await page.keyboard.press('Control+z');check('Joined pointer gesture undo is exact',await page.evaluate(()=>JSON.stringify(styk.editor.frame)===__frameBefore));
  await setup(); await page.evaluate(()=>styk.editor.select(1,0));await settle();
  const colors=await page.evaluate(()=>{
    const ctx=document.querySelector('#overlay').getContext('2d'),r=document.querySelector('#viewport').getBoundingClientRect(),d=devicePixelRatio;
    return [['selectedOrigin',1,0],['joined',1,1],['selectedSegment',1,2],['unselectedSegment',2,1],['unselectedOrigin',3,0]].map(([role,uid,id])=>{
      const p=__screen(__points().find(point=>point.uid===uid&&point.id===id));const rgb=[...ctx.getImageData(Math.round((p.x-r.x)*d),Math.round((p.y-r.y)*d),1,1).data];return{role,rgb};});
  });
  check('Canvas uses exact native orange/red/white/blue/light-blue fills',JSON.stringify(colors.map(c=>c.rgb))===JSON.stringify([[255,136,0,255],[255,255,255,255],[255,0,0,255],[0,0,255,255],[0,128,255,255]]));
  await page.screenshot({path:path.join(out,'small-native-colors.png')});
  await page.evaluate(()=>styk.editor.select(2,0));await settle();
  const gray=await page.evaluate(()=>{const ctx=document.querySelector('#overlay').getContext('2d'),r=document.querySelector('#viewport').getBoundingClientRect(),p=__screen(__points().find(p=>p.uid===1&&p.id===1));return [...ctx.getImageData(Math.round((p.x-r.x)*devicePixelRatio),Math.round((p.y-r.y)*devicePixelRatio),1,1).data];});
  check('Unselected joined parent marker is light gray',JSON.stringify(gray)==='[211,211,211,255]');
  await setup();
  const edited=await drag(1,1,{x:438,y:207},{keys:['r'],name:'held-R'});
  check('Held R enters pose-local Handle Edit',edited.kind==='handle-edit'&&edited.uid===1&&edited.held);
  const locality=await page.evaluate(()=>{let max=0;for(const p of __points()){if(p.uid===1&&p.id===1||p.uid===2&&p.id===0)continue;const old=__before.find(v=>v.uid===p.uid&&v.id===p.id);max=Math.max(max,Math.hypot(p.x-old.x,p.y-old.y));}return{max,held:styk.state.handleEditHeld,history:styk.editor._undo.length};});
  check('Held R leaves every other endpoint fixed and creates one undo',locality.max<.001&&!locality.held&&locality.history===1);
  await setup();const cancelled=await drag(1,1,{x:448,y:191},{keys:['r'],cancel:true,name:'R-Escape'});
  check('Escape cancels a real Handle Edit pointer gesture exactly',cancelled.kind==='handle-edit'&&await page.evaluate(()=>JSON.stringify(styk.editor.frame)===__frameBefore&&!styk.state.drag&&!styk.editor.dirty));
  await setup();await page.keyboard.press('Control+r');
  check('Ctrl R toggles the persistent Handle Edit tool',await page.evaluate(()=>styk.state.tool==='handle-edit'));
  await page.keyboard.press('Control+r');check('Ctrl R toggles back to selection',await page.evaluate(()=>styk.state.tool==='select'));
  for(const [name,keys,rotates,scales] of [['Alt',['Alt'],true,true],['Alt-Control',['Alt','Control'],true,false],['Alt-Shift',['Alt','Shift'],false,true]]) {
    await setup();const origin=await worldPoint(2,0),start=await worldPoint(2,1);
    const before=await page.evaluate(()=>({angles:styk.editor.object.angles.slice(),scale:styk.editor.object.scale,parent:JSON.stringify(styk.editor.frame.objects[0])}));
    const transformed=await drag(2,1,{x:origin.x,y:origin.y+2*(start.x-origin.x)},{keys,name});
    const after=await page.evaluate(()=>({angles:styk.editor.object.angles.slice(),scale:styk.editor.object.scale,parent:JSON.stringify(styk.editor.frame.objects[0]),size:styk.editor.selectedUids.size}));
    check(`${name} routes whole-figure gesture and honors rotation/scale locks`,transformed.kind==='figure-transform'&&transformed.uid===2&&near(after.scale,before.scale*(scales?2:1),.03)&&near(after.angles[0]-before.angles[0],rotates?Math.PI/2:0,.03)&&after.parent===before.parent&&after.size===1);
  }
  await setup();await drag(2,1,{x:500,y:270},{keys:['Alt'],cancel:true,name:'Alt-Escape'});
  check('Escape cancels a real Alt transform exactly',await page.evaluate(()=>JSON.stringify(styk.editor.frame)===__frameBefore&&!styk.state.drag&&!styk.editor.dirty));
  await setup();
  const right=await drag(1,1,{x:420,y:250},{button:'right',name:'right-bend'});
  check('Right drag bends a dynamic handle without opening the context menu',right.kind==='bend'&&await page.evaluate(()=>styk.editor.frame.objects[0].bend_flag===1&&document.querySelector('#menu').hidden));
  await setup();
  const rightR=await drag(1,1,{x:432,y:236},{keys:['r'],button:'right',name:'R-right-bend'});
  check('R plus right drag repositions with tangent-preserving bend mode',rightR.kind==='handle-edit'&&await page.evaluate(()=>styk.editor.frame.objects[0].bend_flag===1));
  await page.screenshot({path:path.join(out,'small-handle-edit.png')});
  if(process.env.STYK_SKIP_AKANE!=='1') {
    await page.evaluate(()=>styk.editor.markSaved());
    await page.locator('#file-input').setInputFiles('C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv');
    await page.waitForFunction(()=>styk.editor.report.keyframes.length===1479&&!styk.state.importing,null,{timeout:180000});
    await page.evaluate(()=>{styk.editor.selectFrame(1478);styk.editor.select(460611,0);styk.fit();window.__before=__points();});await settle();
    const point=await worldPoint(460616,1),raw=await page.evaluate(()=>({angles:styk.editor.frame.objects.map(o=>({uid:o.unique_id,angles:o.angles.slice(),x:o.root_x,y:o.root_y,joined:!!o.join}))}));
    const akane=await drag(460616,1,{x:point.x+7,y:point.y+7},{name:'Akane-joined-parent'});
    check('Actual Akane attached node picks parent460616/native handle1',akane.kind==='pose'&&akane.uid===460616&&akane.joint===0);
    const motion=await page.evaluate(before=>{const e=styk.editor;return {freeMoved:e.frame.objects.filter(o=>!o.join).filter(o=>{const old=before.angles.find(v=>v.uid===o.unique_id);return old.x!==o.root_x||old.y!==o.root_y;}).map(o=>o.unique_id),changed:e.frame.objects.filter(o=>{const old=before.angles.find(v=>v.uid===o.unique_id);return o.angles.some((a,i)=>a!==old.angles[i]);}).map(o=>o.unique_id)};},raw);
    check('Actual Akane pointer posing changes only the nine-figure branch, with no free-origin translation',motion.freeMoved.length===0&&motion.changed.length===9);
    await page.screenshot({path:path.join(out,'akane-joined-parent.png')});
    await page.keyboard.press('Control+z');
    const editStart=await worldPoint(460616,1);const akaneEdit=await drag(460616,1,{x:editStart.x+11,y:editStart.y-7},{keys:['r'],cancel:true,name:'Akane-R-Escape'});
    check('Actual Akane held R and Escape leave every endpoint unchanged',akaneEdit.kind==='handle-edit'&&await page.evaluate(()=>__points().every(p=>{const old=__before.find(v=>v.uid===p.uid&&v.id===p.id);return p.x===old.x&&p.y===old.y;})));
  }
  check('No browser runtime errors',errors.length===0);
  await writeFile(path.join(out,'report.json'),JSON.stringify({checks,routes,colors,errors},null,2));
} catch(error) {
  await page.screenshot({path:path.join(out,'failure.png')});
  await writeFile(path.join(out,'report.json'),JSON.stringify({checks,routes,errors,failure:error.stack},null,2));throw error;
} finally {await browser.close();}
