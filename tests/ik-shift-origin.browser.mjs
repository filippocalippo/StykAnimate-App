import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';

const out = 'artifacts/ik-shift'; await mkdir(out, {recursive:true});
const browser = await chromium.launch({channel:'chrome', headless:true});
const page = await browser.newPage({viewport:{width:1500,height:1000}}), errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const check = (name, value) => {assert.ok(value, name); checks.push(name); console.log('PASS', name);};
async function setup(paths = false) {
  await page.evaluate(async paths => {
    const { pageEditor } = await import('/tests/support/page-editor.mjs');
    const {emptyDocument,createObject,createFrame} = await import('/src/demo.mjs');
    const {worldToScreen} = await import('/src/renderer-geometry.mjs');
    const report=emptyDocument(), f=report.figure_types[0], base=f.segments[0];
    f.segments=[{...base,segment_id:11,parent_id:0,length:90,angle_rad:.8,is_static:false,aux_code:0},
      {...base,segment_id:22,parent_id:11,length:90,angle_rad:2,is_static:false,aux_code:0},
      {...base,segment_id:33,parent_id:22,length:35,angle_rad:0,is_static:false,aux_code:0}];f.segment_count=3;
    report.keyframes=[createFrame([createObject(f,1,240,150)],8)];
    const e=pageEditor({demo:false}).load(structuredClone(report));e.select(1,1);e.setNodeIK({enabled:true});e.poseJoint(350,220);
    const r=structuredClone(report), pose=structuredClone(e.evaluatedFrame.objects[0]);
    r.keyframes=[0,1,2].map(i=>{const o=structuredClone(pose);o.root_x+=i*140;o._stykIK[22].target.x+=i*140;return createFrame([o],8);});
    styk.editor.load(r);styk.editor.seek(paths?16:0);styk.editor.select(1);styk.state.tool='select';
    styk.settingsUI.commit({motionPaths:paths,motionPathRange:0,motionPathJoints:'selected',showHandles:!paths});styk.fit();
    globalThis.__ikScreen=p=>{const s=worldToScreen(p,{report:styk.editor.report,frame:styk.editor.evaluatedFrame,view:styk.state.view}),r=document.querySelector('#viewport').getBoundingClientRect();return{x:r.left+s.x,y:r.top+s.y};};
    // The pose on show: during a motion-path drag the stage draws the gesture's display geometry.
    globalThis.__ikPose=()=>{const e=styk.editor,g=((e._drag?.motionPath&&e._drag.display?.geometry)||e.geometry).objects.get(0);return {joints:Object.fromEntries(g.joints),pin:g.obj._stykIK[22],history:e._undo.length,drag:styk.state.drag?.kind,tick:e.tick};};
  }, paths);
  await settle();
  if (paths) await page.waitForTimeout(250);
}
const snap=()=>page.evaluate(()=>__ikPose());
const screen=p=>page.evaluate(p=>__ikScreen(p),p);
function shifted(before,after,dx,dy) {
  for(const [id,p] of Object.entries(before.joints)) {
    assert.ok(Math.abs(after.joints[id].x-p.x-dx)<.05, `joint ${id} x`);
    assert.ok(Math.abs(after.joints[id].y-p.y-dy)<.05, `joint ${id} y`);
  }
  assert.equal(after.pin.pinned,true);
}
async function start(from,to,keys=['Shift']) {
  for(const key of keys)await page.keyboard.down(key);
  const a=await screen(from),b=await screen(to);
  await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:6});await settle();
}
try {
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await setup();let before=await snap(),root=before.joints[0];
  const p=await screen(root);await page.keyboard.down('Shift');await page.mouse.click(p.x,p.y);await page.keyboard.up('Shift');
  check('Shift-click toggles selection without history',await page.evaluate(n=>!styk.editor.selectedUids.size&&styk.editor._undo.length===n,before.history));
  await page.evaluate(()=>styk.editor.select(1));
  await start(root,{x:root.x+30,y:root.y-18});shifted(before,await snap(),30,-18);
  check('Shift held before press moves the whole pinned figure freely',true);
  await page.keyboard.up('Shift');await settle();let live=await snap();
  check('Releasing Shift without moving replants the original pin',Math.abs(live.joints[22].x-before.joints[22].x)<.05&&Math.abs(live.joints[22].y-before.joints[22].y)<.05);
  await page.keyboard.down('Shift');await settle();shifted(before,await snap(),30,-18);
  await page.screenshot({path:out+'/origin-drag.png'});
  await page.mouse.up();await page.keyboard.up('Shift');await settle();shifted(before,await snap(),30,-18);
  check('One undo step records the translated pin', (await snap()).history===before.history+1);
  await page.evaluate(()=>styk.editor.undo());shifted(before,await snap(),0,0);
  await page.evaluate(()=>styk.editor.redo());shifted(before,await snap(),30,-18);
  await setup();before=await snap();root=before.joints[0];
  await start(root,{x:root.x+30,y:root.y+10},['Control','Shift']);shifted(before,await snap(),30,0);
  check('Ctrl+Shift constrains the origin while carrying pins',true);
  await page.keyboard.press('Escape');await page.mouse.up();await page.keyboard.up('Control');await page.keyboard.up('Shift');await settle();shifted(before,await snap(),0,0);
  check('Escape works with both modifiers and preserves history',(await snap()).history===before.history);
  await setup(true);
  // The playhead stands on the dragged point's frame: the gesture shows its pose there (the frame it changes is not drawn elsewhere).
  await page.evaluate(()=>styk.editor.seek(8));await settle();
  const remote={x:380,y:150},a=await screen(remote);
  await page.mouse.move(a.x,a.y);await page.mouse.down();before=await snap();
  check('An origin path point starts a path edit',before.drag==='motion-path'&&before.tick===8);
  await page.evaluate(()=>{const r=styk.state.renderer,render=r.render.bind(r);globalThis.__motionSources=[];r.render=options=>{__motionSources.push(options.source?.motion);return render(options);};});
  await page.keyboard.down('Shift');const b=await screen({x:410,y:132});await page.mouse.move(b.x,b.y,{steps:5});await settle();shifted(before,await snap(),30,-18);
  check('The stage draws the pose the path edit shows',await page.evaluate(()=>__motionSources.length>0&&__motionSources.at(-1)===true));
  await page.keyboard.up('Shift');await settle();live=await snap();
  check('Path modifier release restores the pin without seeking',Math.abs(live.joints[22].x-before.joints[22].x)<.05&&live.tick===8);
  await page.keyboard.down('Shift');await settle();shifted(before,await snap(),30,-18);
  // Falloff is the right-button path drag now: there is no held key to combine with Shift.
  await page.screenshot({path:out+'/path-drag.png'});
  await page.mouse.up();await page.keyboard.up('Shift');await settle();
  check('Path edit commits once and preserves the playhead',(await snap()).history===before.history+1&&(await snap()).tick===8);
  await page.evaluate(()=>styk.editor.seek(8));shifted(before,await snap(),30,-18);
  await page.evaluate(()=>{styk.editor.undo();styk.editor.seek(8);});shifted(before,await snap(),0,0);
  check('Undo restores the remote pose and pin',true);
  check('No browser errors',errors.length===0);
  await writeFile(out+'/browser.json',JSON.stringify({checks,errors},null,2));
} finally {await browser.close();}
