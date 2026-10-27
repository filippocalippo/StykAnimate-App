/** Verify real pointer gestures after decoding the delivered native files. */
import {chromium} from './support/playwright.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {decodeDocument} from './support/native-files.mjs';
const directory='artifacts/skateboard-360',browser=await chromium.launch({channel:'chrome',headless:true});
const errors=[],checks=[];
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.STYK_URL??'http://127.0.0.1:47861');await page.waitForFunction(()=>window.styk?.ready);
 const snapshot=()=>page.evaluate(()=>{
  const e=styk.editor,g=e.geometry.objects.get(0);return {doc:e.serialize(),undo:e._undo.length,root:{...g.root},vertices:[...g.joints.values()].map(p=>({...p}))};
 });
 const point=index=>page.evaluate(index=>{
  const g=styk.editor.geometry.objects.get(0),p=index<0?g.root:g.segments[index].end;
  const r=document.getElementById('viewport').getBoundingClientRect(),v=styk.state.view;
  return {x:r.x+v.x+p.x*v.scale,y:r.y+v.y+p.y*v.scale,scale:v.scale};
 },index);
 const drag=async(p,dx,dy,cancel=false)=>{
  await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+dx,p.y+dy,{steps:8});
  if(cancel)await page.keyboard.press('Escape');await page.mouse.up();
 };
 for(const kind of ['styk','stkz']){
  const {document}=await decodeDocument(await readFile(`${directory}/Skateboard-360.${kind}`),kind);
  await page.evaluate(d=>{
   for(const dialog of window.document.querySelectorAll('dialog[open]'))dialog.close();
   styk.editor.load(d);styk.editor.select(1,-1);styk.state.onion=false;styk.state.settings.autosaveSeconds=0;styk.fit();
  },document);
  await page.getByRole('button',{name:'Pose',exact:true}).click();
  const before=await snapshot(),origin=await point(-1);await drag(origin,26,-19);const moved=await snapshot();
  assert.ok(Math.abs(moved.root.x-before.root.x-26/origin.scale)<.01);assert.ok(Math.abs(moved.root.y-before.root.y+19/origin.scale)<.01);
  assert.equal(moved.undo,before.undo+1);await page.evaluate(()=>styk.editor.undo());assert.deepEqual((await snapshot()).doc,before.doc);
  await page.getByRole('combobox',{name:'Articulation',exact:true}).selectOption('5');
  const rest=await snapshot();await drag(await point(5),45,28);const posed=await snapshot();
  assert.equal(posed.undo,rest.undo+1);assert.ok(posed.vertices.some((p,i)=>Math.hypot(p.x-rest.vertices[i].x,p.y-rest.vertices[i].y)>5));
  assert.deepEqual(posed.root,rest.root,'Posing must not move the center origin');
  await page.screenshot({path:`${directory}/Review/pose-${kind}.png`});
  await page.evaluate(()=>styk.editor.undo());assert.deepEqual((await snapshot()).doc,rest.doc);
  await drag(await point(5),-30,19,true);assert.deepEqual((await snapshot()).doc,rest.doc);
  await page.evaluate(d=>styk.editor.load(d),posed.doc);assert.deepEqual((await snapshot()).vertices,posed.vertices);
  checks.push(`${kind}: origin translation, nose mouse pose, fixed origin, undo, Escape, posed reload`);
 }
 assert.deepEqual(errors,[]);await writeFile(directory+'/Review/mouse-controls.json',JSON.stringify({passed:true,checks,errors},null,2));console.log(JSON.stringify({passed:true,checks,errors},null,2));
}finally{await browser.close();}
