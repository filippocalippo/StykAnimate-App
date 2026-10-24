/** Real pointer acceptance for native handle colors, routing and modifiers. */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve('artifacts/multi-figure-transform'); await mkdir(out,{recursive:true});
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
    const {worldToScreen}=await import('/src/renderer-geometry.mjs');
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
  if(cancel) { for(const key of [...keys].reverse())await page.keyboard.up(key); await page.keyboard.press('Escape'); }
  await page.mouse.up({button});
  for(const key of [...keys].reverse())await page.keyboard.up(key); await settle(); return route;
}
try {
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>styk?.ready);
  for(const [name,keys,rotates,scales] of [['Alt',['Alt'],true,true],['Alt-Control',['Alt','Control'],true,false],['Alt-Shift',['Alt','Shift'],false,true]]) {
    await setup();const origin=await worldPoint(2,0),start=await worldPoint(2,1);
    const before=await page.evaluate(()=>({angles:styk.editor.object.angles.slice(),scale:styk.editor.object.scale,parent:JSON.stringify(styk.editor.frame.objects[0])}));
    const transformed=await drag(2,1,{x:origin.x,y:origin.y+2*(start.x-origin.x)},{keys,name});
    const after=await page.evaluate(()=>({angles:styk.editor.object.angles.slice(),scale:styk.editor.object.scale,parent:JSON.stringify(styk.editor.frame.objects[0]),size:styk.editor.selectedUids.size}));
    check(`${name} routes whole-figure gesture and honors rotation/scale locks`,transformed.kind==='figure-transform'&&transformed.uid===2&&near(after.scale,before.scale*(scales?2:1),.03)&&near(after.angles[0]-before.angles[0],rotates?Math.PI/2:0,.03)&&after.parent===before.parent&&after.size===1);
  }
  for(const [name,keys,rotates,scales] of [['multi-Alt',['Alt'],true,true],['multi-Alt-Control',['Alt','Control'],true,false],['multi-Alt-Shift',['Alt','Shift'],false,true]]) {
    await setup();await page.evaluate(()=>styk.editor.selectMany([1,2,3]));await settle();
    const origin=await worldPoint(2,0),start=await worldPoint(2,1);
    const transformed=await drag(2,1,{x:origin.x,y:origin.y+2*(start.x-origin.x)},{keys,name});
    check(`${name} preserves selection and transforms all figures once`,transformed.kind==='figure-transform'&&await page.evaluate(({rotates,scales,origin})=>{
      const e=styk.editor,before=JSON.parse(__frameBefore);
      const radians=rotates?Math.PI/2:0, factor=scales?2:1;
      const position=(o,i)=>{const b=before.objects[i],dx=b.root_x-origin.x,dy=b.root_y-origin.y;
        return Math.abs(o.root_x-(origin.x+(dx*Math.cos(radians)-dy*Math.sin(radians))*factor))<.1&&
          Math.abs(o.root_y-(origin.y+(dx*Math.sin(radians)+dy*Math.cos(radians))*factor))<.1;};
      return e.selectedUids.size===3&&e._undo.length===1&&e.selectionFrame.objects.every((o,i)=>
        Math.abs(o.scale-before.objects[i].scale*(scales?2:1))<.03&&
        Math.abs(o.angles[0]-before.objects[i].angles[0]-(rotates?Math.PI/2:0))<.03&&
        (o.join||position(o,i)));
    },{rotates,scales,origin}));
    await page.screenshot({path:path.join(out,`${name}.png`)});
    await page.keyboard.press('Control+z');
    check(`${name} undoes in one step`,await page.evaluate(()=>JSON.stringify(styk.editor.selectionFrame.objects)===JSON.stringify(JSON.parse(__frameBefore).objects)));
  }
  await setup();await page.evaluate(()=>styk.editor.selectMany([1,2,3]));await settle();
  await drag(2,1,{x:500,y:270},{keys:['Alt'],cancel:true,name:'multi-Alt-Escape'});
  check('Escape cancels the multi-selection transform',await page.evaluate(()=>JSON.stringify(styk.editor.selectionFrame.objects)===JSON.stringify(JSON.parse(__frameBefore).objects)&&styk.editor.selectedUids.size===3&&!styk.editor.dirty));
  check('No browser runtime errors',errors.length===0);
  await writeFile(path.join(out,'report.json'),JSON.stringify({checks,routes,errors},null,2));
} catch(error) {
  await page.screenshot({path:path.join(out,'failure.png')});throw error;
} finally {await browser.close();}
