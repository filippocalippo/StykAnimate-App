/** Real pointer, preference and timeline acceptance for figure selection controls. */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const out='artifacts/selection-workflow'; await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1000}});
page.setDefaultTimeout(15000);
const errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.stack||e.message));
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
const selected=()=>page.evaluate(()=>[...styk.editor.selectedUids].sort((a,b)=>a-b));
async function setup({joined=false}={}) {
  await page.evaluate(async joined=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const {worldToScreen}=await import('/src/renderer-geometry.mjs');
    const report=emptyDocument(),f=report.figure_types[0],base=f.segments[0];
    f.segments=[{...base,segment_id:1,parent_id:0,length:260,angle_rad:Math.PI/4}];f.segment_count=1;
    report.keyframes=[0,1,2,3].map(i=>createFrame([
      createObject(f,1,180+i*12,200),
      createObject(f,2,300+i*12,280,{...(joined?{join:{target_object_slot:0,target_handle_id:1}}:{})}),
      createObject(f,3,700,180,{scale:.3})
    ],10));
    styk.editor.load(report,'Selection acceptance');styk.editor.select(null);
    styk.state.handles=true;styk.state.hidden.clear();styk.state.locked.clear();
    styk.state.settings.showUnselectedHandles=true;styk.fit();
    globalThis.__screen=point=>{const p=worldToScreen(point,{report:styk.editor.report,frame:styk.editor.evaluatedFrame,view:styk.state.view}),r=document.querySelector('#viewport').getBoundingClientRect();return{x:r.left+p.x,y:r.top+p.y};};
    globalThis.__before=JSON.stringify(styk.editor.serialize());
    globalThis.__history=styk.editor._undo.length;
  },joined);
  await page.keyboard.press('v');await settle();
}
const point=(uid,id=0)=>page.evaluate(({uid,id})=>__screen([...styk.editor.geometry.objects.values()].find(g=>g.obj.unique_id===uid).joints.get(id)),{uid,id});
const world=p=>page.evaluate(p=>__screen(p),p);
async function click(uid,{key='Control',id=0}={}) {
  const p=await point(uid,id);await page.mouse.move(p.x,p.y);
  if(key)await page.keyboard.down(key);
  await page.mouse.click(p.x,p.y);
  if(key)await page.keyboard.up(key);await settle();
}
async function marquee(a,b,key) {
  const p=await world(a),q=await world(b);
  if(key)await page.keyboard.down(key);
  await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(q.x,q.y,{steps:8});await page.mouse.up();
  if(key)await page.keyboard.up(key);await settle();
}
async function frames() {
  return page.evaluate(async()=>{
    // The engine's frame at each tick, read on a copy of the document: seeking the page's own editor would collapse the timeline's range.
    const {pageEditor}=await import('/tests/support/page-editor.mjs'),copy=pageEditor({demo:false}).load(styk.editor.serialize());
    return [0,10,20,30].map(t=>{copy.seek(t);return copy.evaluatedFrame.objects.map(o=>({uid:o.unique_id,x:o.root_x,y:o.root_y,angles:o.angles,join:o.join}));});
  });
}
async function selectRange(mode) {
  await page.locator('[data-timeline-mode="'+mode+'"]').click();await setup();
  if(mode==='simple') {
    await page.evaluate(()=>{styk.timeline.selectFrame(0);styk.timeline.selectFrame(2,{extend:true});});
  } else {
    const cell=async tick=>page.evaluate(tick=>{const t=styk.timeline,r=t.scroll.getBoundingClientRect(),row=t.tracks.findIndex(x=>x.id==='layer-1');return{x:r.left+(tick+.5)*t.pxPerTick-t._offsetX(),y:r.top+t.rowY(row)+t.rowSize(row)/2};},tick);
    const a=await cell(0),b=await cell(20);
    await page.mouse.click(a.x,a.y);await page.keyboard.down('Shift');await page.mouse.click(b.x,b.y);await page.keyboard.up('Shift');
  }
  await page.evaluate(()=>styk.editor.select(1));await settle();
}
try {
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await setup();
  await click(1);await click(2);check('Ctrl-click adds without losing selected figures',JSON.stringify(await selected())==='[1,2]');
  await click(1);check('Ctrl-click removes only the clicked figure',JSON.stringify(await selected())==='[2]');
  await click(2,{key:'Shift'});check('Shift-click retains independent toggling',(await selected()).length===0);
  await click(3,{key:'Meta'});check('Cmd-click also toggles figures',JSON.stringify(await selected())==='[3]');
  check('Selection clicks preserve poses, dirty state and undo history',await page.evaluate(()=>JSON.stringify(styk.editor.serialize())===__before&&styk.editor._undo.length===__history&&!styk.editor.dirty));
  let p=await point(1);
  await page.keyboard.down('Control');await page.mouse.dblclick(p.x,p.y);await page.keyboard.up('Control');await settle();
  check('Ctrl double-click toggles twice without selecting a connected group',JSON.stringify(await selected())==='[3]');
  await page.keyboard.down('Control');await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+1,p.y+1);
  await page.keyboard.press('Escape');await page.mouse.up();await page.keyboard.up('Control');
  check('Escape cancels a pending Ctrl-click',JSON.stringify(await selected())==='[3]');
  await page.keyboard.down('Control');await page.mouse.move(p.x,p.y);await page.mouse.down();
  await page.evaluate(()=>styk.editor.seek(10));await page.mouse.up();await page.keyboard.up('Control');
  check('Seeking cancels pending selection without toggling a stale target',JSON.stringify(await selected())==='[3]');
  await setup();await click(1,{key:null});p=await point(1);
  const original=await frames();
  await page.keyboard.down('Control');await page.mouse.move(p.x,p.y);await page.mouse.down();
  await page.mouse.move(p.x+40,p.y+8,{steps:8});await page.mouse.up();await page.keyboard.up('Control');await settle();
  let after=await frames();
  check('Ctrl-drag keeps axis-constrained translation',after[0][0].x>original[0][0].x&&after[0][0].y===original[0][0].y);
  await page.keyboard.press('Control+z');check('Ctrl-drag commits one undo command',JSON.stringify(await frames())===JSON.stringify(original));
  p=await point(1,1);await page.keyboard.down('Control');await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+25,p.y+25,{steps:8});
  check('Ctrl-drag on a joint still poses and stretches',await page.evaluate(()=>styk.state.drag?.kind==='pose'&&Boolean(styk.editor._drag)));
  await page.keyboard.press('Escape');await page.mouse.up();await page.keyboard.up('Control');
  check('Cancelling Ctrl joint drag restores the pose',JSON.stringify(await frames())===JSON.stringify(original));
  await setup();
  check('New profiles default to origin selection',await page.evaluate(()=>styk.state.settings.marqueeSelection==='origins'));
  check('Selection preference does not occupy the canvas toolbar',await page.locator('#selection-origins').count()===0);
  await page.keyboard.press('Control+,');await page.locator('[data-tab="canvas"]').click();
  await page.locator('[data-setting="marqueeSelection"]').selectOption('bounds');await page.keyboard.press('Escape');await settle();
  await marquee({x:280,y:260},{x:325,y:305});check('Bounds mode retains overlapping figure selection',JSON.stringify(await selected())==='[1,2]');
  await page.keyboard.press('Control+,');
  await page.locator('[data-setting="marqueeSelection"]').selectOption('origins');
  await page.screenshot({path:out+'/selection-settings.png'});await page.keyboard.press('Escape');await settle();
  await marquee({x:280,y:260},{x:325,y:305});check('Origins mode excludes crossing artwork',JSON.stringify(await selected())==='[2]');
  await marquee({x:160,y:180},{x:205,y:225},'Shift');check('Shift marquee toggles origin membership',JSON.stringify(await selected())==='[1,2]');
  await page.evaluate(()=>{styk.state.locked.add(1);styk.state.hidden.add(2);});
  await marquee({x:150,y:150},{x:600,y:450});check('Origins ignore hidden and locked figures',(await selected()).length===0);
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('stykanimate.editor.settings.v1'))?.marqueeSelection==='origins');
  await page.reload();await page.waitForFunction(()=>window.styk?.ready);
  check('Origin preference survives reopening',await page.evaluate(()=>styk.state.settings.marqueeSelection==='origins'));
  await page.evaluate(()=>{const key='stykanimate.editor.settings.v1',settings=JSON.parse(localStorage.getItem(key));settings.hotkeys={...settings.hotkeys,'toggle-selection-origins':['Mod+Shift+KeyB'],'toggle-range-edit':['Mod+Shift+KeyR']};localStorage.setItem(key,JSON.stringify(settings));});
  await page.reload();await page.waitForFunction(()=>window.styk?.ready);
  await page.locator('#viewport').focus();await page.keyboard.press('Control+Shift+b');await settle();
  check('Remapped origin shortcut changes the saved selection setting',await page.evaluate(()=>styk.state.settings.marqueeSelection==='bounds'));
  await page.keyboard.press('Control+Shift+b');await settle();
  await setup({joined:true});
  const root=await page.evaluate(()=>{const g=styk.editor.geometry.objects.get(1);return g.root;});
  // The drag starts off the first figure's line, which runs through the corner at (-15, -15): a press on it would select that figure.
  await marquee({x:root.x+15,y:root.y-15},{x:root.x-15,y:root.y+15});
  check('Joined origin selection follows the evaluated attachment',JSON.stringify(await selected())==='[2]');
  await page.screenshot({path:out+'/origins-joined.png'});
  // Put a frontmost sibling exactly over the selected attachment's handle.
  await page.evaluate(()=>{const e=styk.editor,root=e.geometry.objects.get(1).root;e.select(3);e.updateObject({root_x:root.x,root_y:root.y,scale:1});});
  await page.evaluate(()=>{
    const e=styk.editor;e.select(2,0);
    globalThis.__joinedBefore=JSON.stringify(e.serialize());globalThis.__parentBefore=JSON.stringify(e.selectionFrame.objects[0]);
  });await settle();
  // The attached figure's end lies below the artboard, which the fitted view leaves out of the stage: pan up to it before aiming.
  await page.keyboard.down('Alt');await settle();await page.evaluate(()=>{styk.state.view.y-=120;});await settle();p=await point(2,1);await page.mouse.move(p.x,p.y);await page.mouse.down();
  await page.mouse.move(p.x-45,p.y+30,{steps:8});
  check('Attached Alt-drag uses its join as the fixed pivot',await page.evaluate(()=>styk.state.drag?.kind==='figure-transform'&&styk.editor.selectedUid===2&&JSON.stringify(styk.editor.selectionFrame.objects[0])===__parentBefore));
  await page.screenshot({path:out+'/joined-pivot.png'});
  await page.keyboard.press('Escape');await page.mouse.up();await page.keyboard.up('Alt');
  check('Cancelling joined transform restores document exactly',await page.evaluate(()=>JSON.stringify(styk.editor.serialize())===__joinedBefore));
  await page.evaluate(()=>styk.fit());await settle();
  for(const mode of ['simple','advanced']) {
    await selectRange(mode);
    check(mode+' shows the selected-frame edit count',await page.locator('#range-edit .range-edit-count').textContent()==='3');
    check(mode+' range edit starts disabled until explicitly enabled',await page.locator('#range-edit').getAttribute('aria-pressed')==='false');
    if(mode==='simple'){await page.locator('#viewport').focus();await page.keyboard.press('Control+Shift+r');}
    else await page.locator('#range-edit').click();await settle();
    check(mode+' toolbar and inspector share range state',await page.locator('#apply-range-movement').isChecked());
    const before=await frames();p=await point(1);const scale=await page.evaluate(()=>styk.state.view.scale);
    await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+25*scale,p.y+10*scale,{steps:8});await page.mouse.up();await settle();
    after=await frames();
    check(mode+' applies equal offsets and preserves unselected frames',after.slice(0,3).every((f,i)=>Math.abs(f[0].x-before[i][0].x-25)<.1&&Math.abs(f[0].y-before[i][0].y-10)<.1&&JSON.stringify(f[0].angles)===JSON.stringify(before[i][0].angles))&&JSON.stringify(after[3])===JSON.stringify(before[3]));
    await page.keyboard.press('Control+z');await settle();check(mode+' range movement undoes atomically',JSON.stringify(await frames())===JSON.stringify(before));
    await page.locator('#apply-range-movement').uncheck();await settle();check(mode+' inspector updates the toolbar',await page.locator('#range-edit').getAttribute('aria-pressed')==='false');
    await page.screenshot({path:out+'/'+mode+'-range.png'});
    // Simple's Edit together is the frame bar's switch; Advanced's is the header's button (one state).
    if(mode==='simple')await page.getByRole('switch',{name:'Edit together',exact:true}).click();else await page.locator('#range-edit').click();
    if(mode==='simple')await page.evaluate(()=>styk.timeline.selectFrame(1));
    else await page.evaluate(()=>styk.editor.seek(10));
    await settle();
    check(mode+' clears range editing after selection collapses',await page.locator('#range-edit').isDisabled()&&await page.locator('#range-edit').getAttribute('aria-pressed')==='false');
  }
  await page.setViewportSize({width:1100,height:800});await settle();await page.screenshot({path:out+'/compact.png'});
  // Edit together shows once two frames are selected (it is collapsed while disabled), at this width too.
  await selectRange('advanced');
  check('Compact toolbar retains accessible range control',await page.locator('#range-edit').isVisible());
  check('No browser errors',errors.length===0);
  await writeFile(out+'/report.json',JSON.stringify({checks,errors},null,2));
} catch(error) {
  await page.screenshot({path:out+'/failure.png'});await writeFile(out+'/report.json',JSON.stringify({checks,errors,failure:error.stack},null,2));throw error;
} finally {await browser.close();}
