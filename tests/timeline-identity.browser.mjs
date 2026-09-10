import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';

const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
try {
  await mkdir('artifacts/timeline-identity',{recursive:true});
  await page.goto('http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  for(const connected of [false,true]){
    await page.evaluate(async connected=>{
      styk.settingsUI.commit({timelineMode:'advanced'});
      const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
      const report=emptyDocument(),figure=report.figure_types[0];figure.name='Fig 107';
      report.keyframes=[0,10,20].map(x=>createFrame([createObject(figure,1,300+x*10,260),
        ...(connected?[createObject(figure,2,300+x*10,260,{join:{target_object_slot:0,target_unique_id:1,target_handle_id:1}})]:[])],10));
      const e=styk.editor;e.load(report);e.select(1);styk.timeline.setZoom(24);styk.timeline._scrollToX(0);
    },connected);await settle();
    const point=async tick=>page.evaluate(tick=>{
      const t=styk.timeline,r=t.scroll.getBoundingClientRect(),index=t.tracks.findIndex(row=>row.depth===0);
      return {x:r.left+12+(tick+.5)*t.pxPerTick-t._offsetX(),y:r.top+31+index*30+15-t._offsetY()};
    },tick);
    const a=await point(10),b=await point(15);
    await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:12});await page.mouse.up();await settle();
    const moved=await page.evaluate(()=>{
      const e=styk.editor,poses=e.animationChannels.filter(c=>c.property==='pose');e.seek(5);
      return {times:poses.map(c=>c.keys.map(k=>k.tick)),uids:e.evaluatedFrame.objects.map(o=>o.unique_id),x:e.evaluatedFrame.objects[0].root_x};
    });
    assert.deepEqual(moved.times,Array.from({length:connected?2:1},()=>[0,15,20]));
    assert.deepEqual(moved.uids,connected?[1,2]:[1]);assert.ok(Math.abs(moved.x-(300+100/3))<1e-6);
    await page.evaluate(()=>{
      const e=styk.editor,t=styk.timeline;e.seek(7);t.selectedTrackId=t.tracks.find(row=>row.depth===0).id;t.addTrackKey();
      window.keyPose=e.evaluatedFrame.objects.map(o=>({uid:o.unique_id,x:o.root_x,join:o.join}));
    });await settle();
    await page.evaluate(()=>styk.settingsUI.commit({timelineMode:'simple'}));await settle();
    const key=page.getByRole('button',{name:'Animation key at frame 8',exact:true});
    await key.click();await settle();
    assert.equal(await page.evaluate(()=>styk.editor.tick),7);
    assert.deepEqual(await page.evaluate(()=>styk.editor.evaluatedFrame.objects.map(o=>({uid:o.unique_id,x:o.root_x,join:o.join}))),await page.evaluate(()=>window.keyPose));
    await key.press('Delete');assert.equal(await page.evaluate(()=>styk.editor.report.keyframes.length),3);
    await page.screenshot({path:`artifacts/timeline-identity/${connected?'connected':'single'}-simple.png`});
    await page.evaluate(()=>styk.editor.undo());await settle();assert.equal(await key.count(),0);
    await page.evaluate(()=>styk.editor.redo());await settle();assert.equal(await key.count(),1);
    await page.evaluate(()=>styk.settingsUI.commit({timelineMode:'advanced'}));await settle();
    assert.equal(await page.evaluate(()=>styk.timeline.tracks.filter(row=>row.depth===0).length),1);
    assert.deepEqual(await page.evaluate(()=>{
      const e=styk.editor,expected=e.frame.objects.map(o=>o.unique_id).sort((a,b)=>a-b),bad=[];
      for(let i=0;i<=20;i++){e.seek(i);const ids=e.evaluatedFrame.objects.map(o=>o.unique_id).sort((a,b)=>a-b);if(JSON.stringify(ids)!==JSON.stringify(expected))bad.push({i,ids});}
      const saved=e.serialize();e.load(saved);e.select(1);e.seek(7);return bad;
    }),[]);
    await page.screenshot({path:`artifacts/timeline-identity/${connected?'connected':'single'}-advanced.png`});
    console.log(`PASS ${connected?'connected':'single'}: actual five-frame drag, interpolation, unchanged IDs, Simple key navigation, undo/redo, mode switch and reopen`);
  }
  assert.deepEqual(errors,[]);
}finally{await browser.close();}
