import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

const out='artifacts/onion-rebuild';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const value=()=>page.evaluate(()=>({before:styk.onionController.snapshot().before.span,after:styk.onionController.snapshot().after.span,tick:styk.editor.tick,stored:styk.state.settings.onionRangeBefore,revision:styk.editor.revision,poses:styk.onionSkins()?.ghosts.length}));
async function drag(locator,dx,{release=true,shift=false}={}){
  if(shift)await page.keyboard.down('Shift');
  const box=await locator.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(box.x+box.width/2+dx,box.y+box.height/2,{steps:5});await settle();
  if(release)await page.mouse.up();if(shift)await page.keyboard.up('Shift');await settle();
}
try{
  await page.goto('http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');const report=emptyDocument();
    report.keyframes=Array.from({length:120},(_,i)=>createFrame([createObject(report.figure_types[0],1,200+i*2,250)],10));
    styk.editor.load(report);styk.editor.seek(600);
    styk.settingsUI.commit({onionMode:'keyframes',onionStep:1,onionRangeBefore:20,onionRangeAfter:20});
  });
  assert.equal(await page.evaluate(()=>styk.state.onion),true,'onion skin starts enabled');
  assert.equal(await page.getByRole('button',{name:'Onion skin',exact:true}).getAttribute('aria-pressed'),'true');await settle();
  assert.equal(await page.locator('.onion-timeline-range').count(),0,'no extra onion toolbar');
  await page.getByRole('button',{name:'Onion skin settings',exact:true}).click();await settle();
  const rail=page.getByRole('dialog',{name:'Onion skin settings',exact:true}),before=rail.getByRole('spinbutton',{name:'Frames Before',exact:true}),after=rail.getByRole('spinbutton',{name:'Frames After',exact:true});
  const scrub=rail.getByRole('button',{name:'Drag frames Before',exact:true});
  assert.ok(await before.isVisible());assert.ok(await after.isVisible());
  const initial=await value();assert.equal(initial.poses,4);
  await before.fill('300');await before.press('Escape');assert.equal((await value()).stored,20);assert.equal(await before.inputValue(),'20','Escape cancels typed text without writing preferences');
  for(const zoom of [1,4,14,36]){
    await page.evaluate(zoom=>{styk.timeline.setZoom(zoom);styk.timeline._scrollToX(0);styk.settingsUI.commit({onionRangeBefore:20});},zoom);await settle();
    await drag(scrub,3);assert.equal((await value()).before,20,'three-pixel jitter does not edit');
    await drag(scrub,8,{release:false});const preview=await value();assert.equal(preview.before,21,'eight pixels changes one output frame even with keys ten frames apart');assert.equal(preview.stored,20,'preview does not persist');assert.equal(preview.poses,4,'key sampling stays inside the temporal range');
    await page.mouse.up();await settle();assert.equal((await value()).stored,21);
    assert.equal((await value()).tick,600);assert.equal((await value()).revision,initial.revision);
  }
  await page.evaluate(()=>styk.settingsUI.commit({onionRangeBefore:20}));await settle();await drag(scrub,24,{shift:true});assert.equal((await value()).before,20,'precision has a full 32-pixel step');
  await drag(scrub,32,{shift:true});assert.equal((await value()).before,21);
  await drag(scrub,80,{release:false});await page.keyboard.press('Escape');await page.mouse.up();await settle();assert.equal((await value()).before,21);
  await drag(scrub,80,{release:false});await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.mouse.up();await settle();assert.equal((await value()).before,21);
  await rail.getByRole('button',{name:'Increase frames Before',exact:true}).click();assert.equal((await value()).before,22);
  await before.fill('350');await before.press('Enter');assert.equal((await value()).before,350,'large ranges have no ten-frame cap');await settle();assert.equal((await value()).poses,37);
  // Panning only moves the projection, never the editing controls or range.
  const controlBox=await before.boundingBox();await page.evaluate(()=>styk.timeline._scrollToX(10000));await settle();assert.deepEqual(await before.boundingBox(),controlBox);assert.equal((await value()).before,350);
  await page.evaluate(()=>styk.editor.seek(0));await settle();assert.ok(await before.isVisible());assert.ok(await after.isVisible());assert.equal(await before.inputValue(),'350','seeking to start preserves the preference');assert.equal(await rail.getByRole('button',{name:'Increase frames Before',exact:true}).isDisabled(),false);await before.fill('0');await before.press('Enter');assert.equal((await value()).stored,0,'explicit zero clears a previously stored span at the first frame');
  await page.evaluate(()=>styk.editor.seek(1190));await settle();assert.equal(await after.inputValue(),'20','seeking to end preserves the preference');assert.ok(await after.isVisible());
  await page.evaluate(()=>{styk.editor.seek(600);styk.timeline.setZoom(4);styk.timeline._scrollToX(2000);styk.settingsUI.commit({onionRangeBefore:20,onionRangeAfter:20});});await settle();
  await drag(scrub,40,{release:false});await page.evaluate(()=>styk.editor.seek(610));await page.mouse.up();await settle();assert.equal((await value()).stored,20,'seeking invalidates an active drag');
  const panel=rail;
  await panel.getByRole('spinbutton',{name:'Frames Before',exact:true}).fill('25');await panel.getByRole('spinbutton',{name:'Frames Before',exact:true}).press('Enter');assert.equal(await before.inputValue(),'25');
  const panelScrub=panel.getByRole('button',{name:'Drag frames Before',exact:true});await drag(panelScrub,3);assert.equal((await value()).before,25);await drag(panelScrub,8);assert.equal((await value()).before,26);
  await page.locator('#onion-popover .onion-more>summary').click();await panel.getByLabel('Onion sampling',{exact:true}).selectOption('frames');await settle();assert.equal((await value()).before,26,'sampling changes preserve temporal spans');assert.equal((await value()).poses,46);
  const opacity=panel.getByRole('slider',{name:'Onion opacity slider',exact:true});await opacity.fill('45');await settle();assert.equal(await page.evaluate(()=>styk.state.settings.onionOpacity),.45);
  const opacityBox=await opacity.boundingBox();await page.mouse.move(opacityBox.x+opacityBox.width*.45,opacityBox.y+opacityBox.height/2);await page.mouse.down();await page.mouse.move(opacityBox.x+opacityBox.width*.8,opacityBox.y+opacityBox.height/2);await settle();assert.equal(await page.evaluate(()=>styk.state.settings.onionOpacity),.45);await page.keyboard.press('Escape');await page.mouse.move(opacityBox.x+opacityBox.width*.9,opacityBox.y+opacityBox.height/2);await page.mouse.up();await settle();assert.equal(await page.evaluate(()=>styk.state.settings.onionOpacity),.45,'release after Escape cannot re-commit a native slider');
  await panel.getByLabel('Show on top',{exact:true}).check();await settle();assert.ok(await page.evaluate(()=>styk.onionSkins().ghosts.every(ghost=>ghost.showOnTop)));
  await page.screenshot({path:out+'/light.png'});
  await panel.getByRole('button',{name:'Close onion settings'}).click();
  await page.setViewportSize({width:900,height:740});await page.evaluate(()=>styk.settingsUI.commit({theme:'dark'}));await settle();
  await page.getByRole('button',{name:'Onion skin settings',exact:true}).click();await settle();assert.ok(await before.isVisible());assert.ok(await after.isVisible());
  const box=await panel.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=900&&box.y+box.height<=740);
  await page.screenshot({path:out+'/dark.png'});await panel.getByRole('button',{name:'Close onion settings'}).click();
  await page.getByRole('button',{name:'Simple',exact:true}).click();await settle();assert.equal(await page.locator('.onion-range-overlay').count(),0);
  await page.getByRole('button',{name:'Onion skin settings',exact:true}).click();await settle();assert.equal(await panel.getByRole('spinbutton',{name:'Frames Before',exact:true}).inputValue(),'26');
  await panel.getByRole('button',{name:'Close onion settings'}).click();await page.getByRole('button',{name:'Advanced',exact:true}).click();await settle();assert.equal(await page.locator('.onion-timeline-range').count(),0);assert.equal(await page.locator('.onion-range-overlay').count(),1);
  // Fixed preferences are projected around the live playhead, including pending
  // scrubs and positions beyond the document, with no layout row added.
  await page.evaluate(()=>{styk.settingsUI.commit({onionRangeBefore:20,onionRangeAfter:30});styk.timeline.setZoom(4);styk.timeline._scrollToX(2000);});await settle();
  const projection=()=>page.evaluate(()=>{
    const host=styk.timeline,range=styk.onionController.snapshot(host.pendingScrub??undefined),overlay=document.querySelector('.onion-range-overlay');
    const edge=tick=>host.labelWidth+tick*host.pxPerTick-host._offsetX();
    return {before:Number.parseFloat(overlay.querySelector('.before.onion-range-end').style.left),after:Number.parseFloat(overlay.querySelector('.after.onion-range-end').style.left),expectedBefore:edge(range.tick-20),expectedAfter:edge(range.tick+31),spanBefore:range.before.span,spanAfter:range.after.span};
  });
  for(const tick of [600,601,609,0,1199]){
    await page.evaluate(tick=>styk.editor.seek(tick),tick);await settle();
    const p=await projection();assert.equal(p.before,p.expectedBefore);assert.equal(p.after,p.expectedAfter);assert.equal(p.spanBefore,20);assert.equal(p.spanAfter,30);
  }
  await page.evaluate(()=>{styk.timeline.pendingScrub=607;styk.timeline._syncPlayhead();});
  const pending=await projection();assert.equal(pending.before,pending.expectedBefore);assert.equal(pending.after,pending.expectedAfter);
  await page.evaluate(()=>{styk.timeline.pendingScrub=null;styk.editor.seek(600);});await settle();
  for(const zoom of [1,4,14,36]){
    for(const direction of ['before','after']){
      await page.evaluate(({zoom,direction})=>{
        styk.settingsUI.commit({onionRangeBefore:20,onionRangeAfter:20});styk.timeline.setZoom(zoom);
        const endpoint=600+(direction==='before'?-20:20);styk.timeline._scrollToX((endpoint+.5)*zoom-300);
      },{zoom,direction});await settle();
      const handle=page.getByRole('slider',{name:`Onion frames ${direction==='before'?'Before':'After'}`,exact:true}),sign=direction==='before'?-1:1;
      // A press on a marker never seeks, and less than half a frame of travel changes nothing.
      await drag(handle,sign*Math.min(3,zoom*.4));assert.equal((await value())[direction],20);
      assert.equal((await value()).tick,600,'pressing an onion marker never seeks');
      // The marker follows the pointer one frame per timeline frame at every zoom.
      await drag(handle,sign*zoom*3,{release:false});assert.equal((await value())[direction],23);assert.equal(await page.evaluate(direction=>styk.state.settings[direction==='before'?'onionRangeBefore':'onionRangeAfter'],direction),20);
      await page.mouse.up();await settle();assert.equal((await value())[direction],23);assert.equal((await value()).tick,600,'marker editing never seeks');
      await drag(handle,-sign*zoom*2);assert.equal((await value())[direction],21,'dragging back toward the playhead shortens the range');
      await drag(handle,sign*zoom*10,{release:false});await page.keyboard.press('Escape');await page.mouse.up();await settle();assert.equal((await value())[direction],21);
    }
  }
  await page.evaluate(()=>{styk.settingsUI.commit({onionRangeBefore:20,onionRangeAfter:20});styk.timeline.setZoom(4);styk.timeline._scrollToX(2050);});await settle();
  const handle=page.getByRole('slider',{name:'Onion frames Before',exact:true});
  await handle.focus();await page.keyboard.press('ArrowLeft');assert.equal((await value()).before,21);await page.keyboard.press('ArrowRight');assert.equal((await value()).before,20);
  await drag(handle,-40,{release:false});await page.evaluate(()=>styk.editor.seek(610));await page.mouse.up();await settle();assert.equal((await value()).stored,20,'seek cancels ruler preview');
  await page.evaluate(()=>styk.settingsUI.commit({theme:'light'}));await settle();await page.screenshot({path:out+'/ruler-light.png'});
  await page.evaluate(()=>styk.settingsUI.commit({theme:'dark'}));await settle();await page.screenshot({path:out+'/ruler-dark.png'});
  await page.evaluate(()=>{styk.settingsUI.commit({onionRangeBefore:0,onionRangeAfter:0});styk.timeline.setZoom(1);styk.timeline._scrollToX(530);});await settle();
  // At zero frames the markers flank the playhead's tab without covering it, so the tab still scrubs.
  const tab=await page.locator('.layer-timeline .sheet-playhead > span').boundingBox();
  for(const direction of ['before','after']){
    const box=await page.getByRole('slider',{name:`Onion frames ${direction==='before'?'Before':'After'}`,exact:true}).boundingBox();
    assert.ok(direction==='before'?box.x+box.width<=tab.x:box.x>=tab.x+tab.width,`${direction} marker stays beside the playhead tab`);
  }
  assert.equal(await page.evaluate(({x,y})=>Boolean(document.elementFromPoint(x,y)?.closest('.onion-range-end')),{x:tab.x+tab.width/2,y:tab.y+tab.height/2}),false,'the playhead tab is not covered by a marker');
  for(const direction of ['before','after']){
    const zeroHandle=page.getByRole('slider',{name:`Onion frames ${direction==='before'?'Before':'After'}`,exact:true});
    await drag(zeroHandle,direction==='before'?-2:2);assert.equal((await value())[direction],2,'zero-distance markers remain separately reachable');
  }
  // Onion settings can hide the markers while onion skin stays on.
  await page.evaluate(()=>styk.settingsUI.commit({onionTimelineMarkers:false}));await settle();
  assert.equal(await page.locator('.onion-range-overlay').isHidden(),true);assert.equal(await page.evaluate(()=>styk.state.onion),true);
  await page.getByRole('button',{name:'Onion skin settings',exact:true}).click();await settle();
  await panel.getByLabel('Timeline markers',{exact:true}).check();await settle();
  assert.equal(await page.evaluate(()=>styk.state.settings.onionTimelineMarkers),true);assert.equal(await page.locator('.onion-range-overlay').isVisible(),true);
  await panel.getByRole('button',{name:'Close onion settings'}).click();
  assert.deepEqual(errors,[]);console.log('PASS onion rebuild: tiny/precise drags at four zoom levels, atomic preview, range sampling, boundaries, panning, lifecycle, both themes');
}finally{await browser.close();}
