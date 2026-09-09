import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1280,height:720}});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
try {
  await page.route('**/__timeline-direct',route=>route.fulfill({contentType:'text/html',body:`
    <style>body{margin:20px;font:13px sans-serif}#timeline{height:430px}</style><div id="timeline"></div>
    <script type="module">
    import {Editor} from '/src/editor.mjs'; import {Timeline} from '/src/timeline.mjs';
    window.editor=new Editor(); editor.select(1);
    editor.addAnimationKey({kind:'figure',uid:1},'x',2,100);
    editor.addAnimationKey({kind:'figure',uid:1},'x',5,200);
    window.timeline=new Timeline(document.querySelector('#timeline'),editor);
    timeline.setZoom(24); window.ready=true;
    </script>`}));
  await page.goto('http://127.0.0.1:47831/__timeline-direct');
  await page.waitForFunction(()=>window.ready); await settle();
  const point=async(tick,property='x')=>page.evaluate(({tick,property})=>{
    const t=timeline,r=t.scroll.getBoundingClientRect(),row=t.tracks.findIndex(x=>x.property===property);
    if(row<0)throw new Error('Missing '+property+' row: '+t.tracks.map(x=>x.id));
    return {x:r.left+12+(tick+.5)*t.pxPerTick-t._offsetX(),y:r.top+31+row*30+15-t._offsetY()};
  },{tick,property});
  const drag=async(a,b)=>{await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:12});await page.mouse.up();await settle();};
  const a=await point(2),b=await point(5);
  await page.mouse.click(a.x,a.y); await settle();
  assert.equal(await page.evaluate(()=>editor.tick),2,'click seeks the selected frame');
  assert.equal(await page.evaluate(()=>timeline.selectedAnimationKeys.flatMap(s=>s.keyIds).length),1,'click selects one key');
  await drag(a,b);
  assert.deepEqual(await page.evaluate(()=>editor.animationChannel({kind:'figure',uid:1},'x').keys.map(k=>[k.tick,k.value])),[[5,100]],'direct drag replaces destination');
  await page.evaluate(()=>editor.undo());await settle();
  assert.equal(await page.evaluate(()=>editor.animationChannel({kind:'figure',uid:1},'x').keys.length),2,'undo restores overwritten destination');
  await page.keyboard.down('Alt'); await drag(await point(2),await point(5)); await page.keyboard.up('Alt');
  assert.deepEqual(await page.evaluate(()=>editor.animationChannel({kind:'figure',uid:1},'x').keys.map(k=>[k.tick,k.value])),[[2,100],[5,100]],'Alt drag copies and replaces');
  await drag(await point(1),await point(6));
  assert.equal(await page.evaluate(()=>timeline.selectedAnimationKeys.flatMap(s=>s.keyIds).length),2,'empty-space marquee selects keys');
  await drag(await point(2),await point(3));
  assert.deepEqual(await page.evaluate(()=>editor.animationChannel({kind:'figure',uid:1},'x').keys.map(k=>k.tick)),[3,6],'selected group moves together');
  const cancelStart=await point(3),cancelEnd=await point(8);
  await page.mouse.move(cancelStart.x,cancelStart.y);await page.mouse.down();await page.mouse.move(cancelEnd.x,cancelEnd.y,{steps:8});await page.keyboard.press('Escape');await page.mouse.up();await settle();
  assert.deepEqual(await page.evaluate(()=>editor.animationChannel({kind:'figure',uid:1},'x').keys.map(k=>k.tick)),[3,6],'Escape cancels the drag');
  const edgeStart=await point(3),edgeBox=await page.locator('.styk-timeline-scroll').boundingBox();
  await page.mouse.move(edgeStart.x,edgeStart.y);await page.mouse.down();await page.mouse.move(edgeBox.x+edgeBox.width+25,edgeStart.y,{steps:10});
  await page.waitForFunction(()=>timeline._offsetX()>30);
  await page.mouse.up();await settle();
  assert.ok(await page.evaluate(()=>editor.animationChannel({kind:'figure',uid:1},'x').keys.some(key=>key.tick>30)),'dragging past viewport edge scrolls and places distant keys');
  await page.evaluate(()=>{editor.undo();timeline._scrollToX(0);});await settle();
  const empty=await point(30);await page.mouse.click(empty.x,empty.y);await settle();
  assert.equal(await page.evaluate(()=>editor.tick),30,'empty cell click seeks exact frame');
  await page.getByLabel('Go to frame',{exact:true}).fill('5001');await page.getByLabel('Go to frame',{exact:true}).press('Enter');await settle();
  assert.equal(await page.evaluate(()=>editor.tick),5000,'direct navigation beyond end');
  assert.ok(await page.evaluate(()=>timeline._offsetX()>0),'distant frame is revealed');
  const old=await page.evaluate(()=>({offset:timeline._offsetX(),end:editor.totalTicks}));
  const box=await page.locator('.styk-timeline-scroll').boundingBox();await page.mouse.move(box.x+200,box.y+50);
  await page.keyboard.down('Shift');await page.mouse.wheel(0,5000);await page.keyboard.up('Shift');await settle();
  assert.ok(await page.evaluate(x=>timeline._offsetX()>x,old.offset),'wheel navigates farther beyond end');
  assert.equal(await page.evaluate(()=>editor.totalTicks),old.end,'navigation does not extend exported duration');
  await page.getByLabel('Go to frame',{exact:true}).fill('1');await page.getByLabel('Go to frame',{exact:true}).press('Enter');await settle();
  await page.screenshot({path:'artifacts/timeline-direct-edit.png'});
  await page.goto('http://127.0.0.1:47831/');await page.waitForFunction(()=>window.styk?.ready);await settle();
  const appKeys=await page.evaluate(()=>{
    const t=styk.timeline;t.setZoom(24);t._scrollToX(0);
    const track=t.tracks.find(row=>row.keys?.length>=2),rect=t.scroll.getBoundingClientRect();
    const row=t.tracks.indexOf(track),keys=track.keys.slice(0,2);
    return {trackId:track.id,keys:keys.map(k=>({tick:k.tick,x:rect.left+12+(k.tick+.5)*t.pxPerTick,y:rect.top+31+row*30+15}))};
  });
  await drag(appKeys.keys[0],appKeys.keys[1]);
  assert.ok(await page.evaluate(({trackId,keys})=>!styk.timeline.trackById.get(trackId).keys.some(k=>k.tick===keys[0].tick),appKeys),'full app direct drag replaces a native pose key');
  await page.evaluate(()=>styk.editor.undo());await settle();
  assert.ok(await page.evaluate(({trackId,keys})=>styk.timeline.trackById.get(trackId).keys.some(k=>k.tick===keys[0].tick),appKeys),'full app undo restores native pose');
  await page.getByLabel('Go to frame',{exact:true}).fill('5001');await page.getByLabel('Go to frame',{exact:true}).press('Enter');await settle();
  assert.equal(await page.evaluate(()=>styk.editor.tick),5000,'full app supports navigating beyond animation end');
  await page.getByLabel('Go to frame',{exact:true}).fill('1');await page.getByLabel('Go to frame',{exact:true}).press('Enter');await settle();
  await page.screenshot({path:'artifacts/timeline-direct-edit-app.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: direct selection, move replacement, undo, Alt-copy replacement, empty-frame selection, distant navigation, growing horizontal scroll, no console errors.');
} finally {await browser.close();}
