import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const out='artifacts/camera-app';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1560,height:1050}}),checks=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));
const check=(label,value)=>{assert.ok(value,label);checks.push(label);console.log('PASS',label);};
const near=(a,b)=>Math.abs(a-b)<1e-4;
const pose=()=>page.evaluate(()=>({...styk.editor.evaluatedFrame.camera,undo:styk.editor._undo.length,view:{...styk.state.view}}));
async function setup(){
 await page.evaluate(async()=>{
  const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
  const report=emptyDocument(); report.keyframes=[createFrame([createObject(report.figure_types[0],10,400,250)]),createFrame([createObject(report.figure_types[0],10,420,260)])];
  report.keyframes[0].camera={is_default:false,x:-45,y:25,scale:.65,angle_rad:.25};
  report.keyframes[1].camera={is_default:false,x:-15,y:30,scale:.9,angle_rad:-.2};
  styk.editor.load(report,'Camera interaction'); styk.editor.select(10,0);styk.fit(); styk.settingsUI.commit({showCamera:false,onionCount:0});
  styk.state.onion=false;
  window.__project=p=>{const r=document.querySelector('#viewport').getBoundingClientRect(),v=styk.state.view;return{x:r.x+v.x+p.x*v.scale,y:r.y+v.y+p.y*v.scale};};
  window.__cam=async()=>{const {cameraViewport}=await import('/src/camera-overlay.mjs');return cameraViewport(styk.editor.report,styk.editor.evaluatedFrame,styk.state.view);};
 });
 await page.waitForTimeout(60);await page.locator('#viewport').focus();
}
async function handle(kind,index){return page.evaluate(async({kind,index})=>__project((await __cam()).handles.find(h=>h.kind===kind&&(index==null||h.index===index)).point),{kind,index});}
async function drag(a,b){await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:4});await page.mouse.up();await page.waitForTimeout(45);}
try{
 await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
 await setup();check('Editing renders world space despite a saved camera',await page.evaluate(()=>styk.state.renderer.last.cameraEnabled===false));
 const point=await page.evaluate(()=>__project(styk.editor.geometry.objects.get(0).root)),before=await page.evaluate(()=>({x:styk.editor.object.root_x,y:styk.editor.object.root_y,scale:styk.state.view.scale}));
 await drag(point,{x:point.x+40,y:point.y+20});let moved=await page.evaluate(()=>({x:styk.editor.object.root_x,y:styk.editor.object.root_y}));
 check('Figure origin drag ignores camera rotation and magnification',near(moved.x-before.x,40/before.scale)&&near(moved.y-before.y,20/before.scale));
 await setup();await page.keyboard.press('Control+k');check('Ctrl K enables persisted camera handles',await page.evaluate(()=>styk.state.settings.showCamera));
 let p=await handle('position'),base=await pose();await drag(p,{x:p.x+33,y:p.y+17});let after=await pose();
 check('Center grip translates camera without moving figures',near(after.x-base.x,33/base.view.scale)&&near(after.y-base.y,17/base.view.scale)&&await page.evaluate(()=>styk.editor.object.root_x===400));
 check('Camera drag commits one undo',after.undo===base.undo+1);await page.keyboard.press('Control+z');check('One undo restores complete camera pose',near((await pose()).x,base.x)&&near((await pose()).y,base.y));
 p=await handle('rotation');base=await pose();const target=await page.evaluate(async()=>{const c=await __cam(),angle=.65-Math.PI/2,r=100;return{...__project({x:c.center.x+r*Math.cos(angle),y:c.center.y+r*Math.sin(angle)}),expected:.65};});
 await drag(p,target);after=await pose();check('Top grip rotates relative to its starting angle',near(after.angle_rad,target.expected)&&near(after.x,base.x)&&near(after.scale,base.scale));
 await page.keyboard.press('Control+z');p=await handle('scale',1);base=await pose();const scaled=await page.evaluate(async()=>{const c=await __cam(),scale=1.05,r=scale*Math.hypot(c.width,c.height)/2,angle=-.6;return {...__project({x:c.center.x+r*Math.cos(angle),y:c.center.y+r*Math.sin(angle)}),expected:scale};});
 await drag(p,scaled);after=await pose();check('Corner scales radially around fixed center',near(after.scale,scaled.expected)&&near(after.x,base.x)&&near(after.y,base.y)&&near(after.angle_rad,base.angle_rad));
 await page.keyboard.press('Control+z');p=await handle('position');base=await pose();await page.mouse.move(p.x,p.y);await page.mouse.down();await page.keyboard.down('Control');await page.mouse.move(p.x+20,p.y+5);await page.keyboard.up('Control');await page.mouse.move(p.x+45,p.y+50);await page.mouse.up();after=await pose();
 check('Ctrl at first motion locks the dominant axis after Ctrl release',near(after.x-base.x,45/base.view.scale)&&near(after.y,base.y));
 await page.keyboard.press('Control+z');p=await handle('position');base=await pose();await page.mouse.move(p.x,p.y);await page.locator('#viewport').focus();
 for(let i=0;i<5;i++)await page.keyboard.down('ArrowRight');await page.keyboard.up('ArrowRight');after=await pose();
 check('Held camera arrows move one CSS pixel per repeat in one undo',near(after.x-base.x,5/base.view.scale)&&near(after.y,base.y)&&after.undo===base.undo+1);
 await page.keyboard.press('Control+z');p=await handle('position');await page.mouse.move(p.x,p.y);base=await pose();await page.keyboard.down('ArrowDown');await page.keyboard.press('Escape');await page.keyboard.up('ArrowDown');after=await pose();
 check('Escape restores an active camera keyboard gesture',near(after.y,base.y)&&after.undo===base.undo);
 await page.locator('#play-button').click({modifiers:['Control']});const tick=await page.evaluate(()=>styk.editor.tick);await page.waitForTimeout(120);
 check('Ctrl Play previews the current camera without advancing time',await page.evaluate(tick=>styk.state.previewing&&!styk.state.playing&&styk.editor.tick===tick&&styk.state.renderer.last.cameraEnabled===true,tick));
 await page.locator('#viewport').click({position:{x:10,y:10}});await page.waitForTimeout(45);check('Canvas click exits preview without an edit',await page.evaluate(()=>!styk.state.previewing&&styk.state.renderer.last.cameraEnabled===false));
 await page.locator('#viewport').focus();await page.keyboard.press('Control+k');check('Ctrl K disables camera interaction',await page.evaluate(()=>!styk.state.settings.showCamera));
 await page.screenshot({path:`${out}/camera-editor.png`});check('No page errors',errors.length===0);
 await writeFile(`${out}/report.json`,JSON.stringify({passed:true,checks,errors},null,2));
}catch(e){await writeFile(`${out}/report.json`,JSON.stringify({passed:false,error:e.stack,checks,errors},null,2));throw e;}finally{await browser.close();}
