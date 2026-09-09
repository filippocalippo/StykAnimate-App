import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
try {
  await page.goto('http://127.0.0.1:47831/'); await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(importVersion=>{
    styk.settingsUI.commit({timelineMode:'advanced'});
    const e=styk.editor; e.newDocument(); e.select(e.frame.objects[0].unique_id); window.rootUid=e.selectedUid;
    e.duplicateFigure(); window.childUid=e.selectedUid; e.joinTo(rootUid,4);
    e.duplicateFrame(); e.select(rootUid); e.moveSelection(40,0); e.commitDrag();
    if (importVersion) {
      const report=e.serialize(); report.version=importVersion;
      for(const frame of report.keyframes)for(const object of frame.objects)object.color_override_raw=object.unique_id===rootUid?0x2244dd:0x44aa22;
      e.load(report);e.selectFrame(1);
    }
    e.select(rootUid,-1); styk.timeline.setZoom(26); styk.timeline._scrollToX(0);
  },Number(process.env.STYK_TEST_IMPORT_VERSION)||null); await settle();
  const group=await page.evaluate(()=>styk.timeline.tracks.filter(t=>t.kind==='assembly').map(t=>({id:t.id,name:t.name})));
  assert.equal(group.length,1); const id=group[0].id;
  assert.equal(await page.evaluate(()=>styk.timeline.tracks.length),1,'collapsed group hides individual parts');
  const point=async tick=>page.evaluate(({id,tick})=>{
    const t=styk.timeline,r=t.scroll.getBoundingClientRect(),row=t.tracks.findIndex(t=>t.id===id);
    return{x:r.left+12+(tick+.5)*t.pxPerTick-t._offsetX(),y:r.top+31+row*30+15-t._offsetY()};
  },{id,tick});
  const start=await page.evaluate(()=>styk.timeline.tracks[0].keys.at(-1).tick),a=await point(start),b=await point(start+5);
  await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:12});await page.mouse.up();await settle();
  assert.deepEqual(await page.evaluate(()=>styk.editor.animationChannels.filter(c=>c.property==='pose'&&c.target.kind==='figure').map(c=>c.keys.at(-1).tick)),[start+5,start+5]);
  await page.evaluate(()=>styk.editor.undo());await settle();
  await page.evaluate(()=>{
    const t=styk.timeline;t._setAnimationSelection(t.tracks[0].keys.flatMap(k=>k.refs));
  });
  await page.mouse.click(a.x,a.y,{button:'right'});await settle();
  await page.getByRole('menuitem',{name:'Scale timing…'}).click();
  await page.getByLabel('Duration (%)',{exact:true}).fill('200');
  await page.getByRole('button',{name:'Apply timing',exact:true}).click();await settle();
  assert.deepEqual(await page.evaluate(()=>styk.editor.animationChannels.filter(c=>c.property==='pose'&&c.target.kind==='figure').map(c=>c.keys.at(-1).tick)),[start*2,start*2]);
  await page.evaluate(()=>styk.editor.undo());await settle();
  await page.getByRole('button',{name:`Expand ${group[0].name}`,exact:true}).click();await settle();
  assert.equal(await page.evaluate(()=>styk.timeline.tracks.filter(t=>t.kind==='figure').length),2);
  await page.screenshot({path:'artifacts/connected-timeline-expanded.png'});
  await page.getByRole('button',{name:`Collapse ${group[0].name}`,exact:true}).click();await settle();
  // Use the real figure selection path so the inspector displays origin tools.
  await page.evaluate(()=>{styk.editor.select(childUid,-1);});await settle();
  const merge=page.getByRole('button',{name:'Merge into one figure',exact:true});
  if(!await merge.isVisible()) {
    // Timeline key editing switches to Animation; Design exposes the origin actions.
    await page.getByRole('button',{name:'Design',exact:true}).click();await settle();
  }
  await merge.click();await settle();
  await page.screenshot({path:'artifacts/connected-timeline-merge-check.png'});
  assert.equal(await page.evaluate(()=>styk.editor.evaluatedFrame.objects.length),1);
  await page.evaluate(()=>styk.editor.undo());await settle();
  assert.equal(await page.evaluate(()=>styk.editor.evaluatedFrame.objects.length),2);
  await page.screenshot({path:'artifacts/connected-timeline-origin.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: full app group drag, expand/collapse, origin merge, undo and no browser errors.');
} finally {await browser.close();}
