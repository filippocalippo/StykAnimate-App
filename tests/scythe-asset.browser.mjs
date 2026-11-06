/** Exercise actual canvas gestures on both delivered native formats. */
import {chromium} from './support/playwright.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {decodeDocument} from './support/native-files.mjs';

const dir=process.argv[2]??'artifacts/scythe-360';
const manifest=JSON.parse(await readFile(dir+'/manifest.json'));
assert.equal(manifest.chain.controls.length,4);
const browser=await chromium.launch({channel:'chrome',headless:true});
const errors=[],checks=[];
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.STYK_URL??'http://127.0.0.1:47861');
 await page.waitForFunction(()=>window.styk?.ready);
 const point=async index=>page.evaluate(index=>{
  const e=styk.editor,g=e.geometry.objects.get(0),p=index<0?g.root:g.segments[index].end;
  const r=document.getElementById('viewport').getBoundingClientRect(),v=styk.state.view;
  return {x:r.x+v.x+p.x*v.scale,y:r.y+v.y+p.y*v.scale,scale:v.scale};
 },index);
 const snapshot=async()=>page.evaluate(()=>{
  const e=styk.editor,g=e.geometry.objects.get(0);
  return {doc:e.serialize(),undo:e._undo.length,root:{...g.root},vertices:e.figure.segments.filter(s=>s._stykRig?.spatial?.point).map(s=>({
   id:s.segment_id,binding:s._stykRig.spatial.bindings[0].joint,...g.joints.get(s.segment_id)}))};
 });
 const drag=async(p,dx,dy,cancel=false)=>{
  await page.mouse.move(p.x,p.y);await page.mouse.down();
  await page.mouse.move(p.x+dx,p.y+dy,{steps:8});
  if(cancel)await page.keyboard.press('Escape');
  await page.mouse.up();
 };
 for(const kind of ['styk','stkz']){
  const {document}=await decodeDocument(await readFile(`${dir}/Scythe-360.${kind}`),kind);
  await page.evaluate(d=>{
   for(const dialog of window.document.querySelectorAll('dialog[open]'))dialog.close();
   styk.editor.load(d);styk.editor.select(1,-1);styk.state.onion=false;
   styk.state.settings.autosaveSeconds=0;styk.fit();
  },document);
  await page.getByRole('button',{name:'Pose',exact:true}).click();
  const beforeMove=await snapshot(),origin=await point(-1);
  await drag(origin,24,-18);
  const moved=await snapshot();
  assert.ok(Math.abs(moved.root.x-beforeMove.root.x-24/origin.scale)<.01,`${kind}: origin drag moves the figure`);
  assert.ok(Math.abs(moved.root.y-beforeMove.root.y+18/origin.scale)<.01);
  assert.equal(moved.undo,beforeMove.undo+1);
  await page.evaluate(()=>styk.editor.undo());assert.deepEqual((await snapshot()).doc,beforeMove.doc);
  checks.push(`${kind}: origin mouse drag and undo`);
  for(const [name,bone]of Object.entries(manifest.controls)){
   // Use the real articulation dropdown; a pointer on its endpoint must pose
   // the artwork, with no calls to setSpatialPose in this regression check.
   await page.getByRole('combobox',{name:'Articulation',exact:true}).selectOption(String(bone.id-1));
   await page.getByRole('button',{name:'Pose',exact:true}).click();
   const before=await snapshot(),p=await point(bone.id-1);
   await drag(p,34,-23);
   const after=await snapshot();
   assert.equal(after.undo,before.undo+1,`${kind} ${name}: one pose undo step`);
   assert.ok(after.vertices.some((v,i)=>v.binding===bone.id&&Math.hypot(v.x-before.vertices[i].x,v.y-before.vertices[i].y)>1),`${kind} ${name}: artwork moves`);
   if(name.startsWith('Chain ')){
    const controls=Object.values(manifest.controls),index=controls.indexOf(bone),upstream=new Set(controls.slice(0,index).map(b=>b.id));
    for(let i=0;i<after.vertices.length;i++)if(upstream.has(after.vertices[i].binding))
     assert.deepEqual(after.vertices[i],before.vertices[i],'Chain mouse posing leaves earlier links, the blade and shaft fixed');
    for(const next of controls.slice(index+1))assert.ok(after.vertices.some((v,i)=>v.binding===next.id&&Math.hypot(v.x-before.vertices[i].x,v.y-before.vertices[i].y)>1),'Later links must follow the dragged control');
    await page.screenshot({path:`${dir}/Review/chain-${index}-pose-${kind}.png`});
   }
   await page.evaluate(()=>styk.editor.undo());assert.deepEqual((await snapshot()).doc,before.doc);
   await drag(await point(bone.id-1),-23,16,true);
   assert.deepEqual((await snapshot()).doc,before.doc,`${kind} ${name}: Escape cancels mouse pose`);
   checks.push(`${kind}: ${name} mouse pose, artwork movement, undo and Escape`);
  }
  await page.evaluate(()=>styk.editor.select(1,-1));
  await page.screenshot({path:`${dir}/Review/controls-${kind}.png`});
  // Pose the four controls consecutively, without undoing the earlier bends.
  for(const [i,name]of manifest.chain.controls.entries()){
   const bone=manifest.controls[name];
   await page.getByRole('combobox',{name:'Articulation',exact:true}).selectOption(String(bone.id-1));
   await drag(await point(bone.id-1),-12,-24+i*3);
  }
  await page.screenshot({path:`${dir}/Review/chain-compound-${kind}.png`});
  const posed=await snapshot();
  await page.evaluate(d=>styk.editor.load(d),posed.doc);
  assert.deepEqual((await snapshot()).vertices,posed.vertices,`${kind}: combined chain pose survives reloading`);
  checks.push(`${kind}: four consecutive mouse bends and pose reload`);
 }
 assert.deepEqual(errors,[]);
 await writeFile(dir+'/Review/mouse-controls.json',JSON.stringify({passed:true,checks,errors},null,2));
 console.log(JSON.stringify({passed:true,checks,errors},null,2));
}finally{await browser.close();}
