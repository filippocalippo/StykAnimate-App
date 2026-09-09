import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const browser = await chromium.launch({channel:'chrome', headless:true});
const page = await browser.newPage({viewport:{width:1440,height:940}});
const errors = [], checks = [];
page.on('pageerror', error => {errors.push(error.message);console.error(error.stack);});
const check = (label, value) => { assert.ok(value, label); checks.push(label); console.log('PASS', label); };
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const idle = async () => {
  await page.waitForFunction(() => { const t = styk.timeline; return t.stats.cachedPreviews > 0 && !t.busy && !t.queue.length && t.idle == null; });
  await settle();
};
const mode = async value => {
  await page.evaluate(() => styk.settingsUI.open('interface'));
  await page.locator(`.styk-settings[open] [data-setting=timelineMode][value=${value}]`).check();
  await page.getByRole('button', {name:'Close settings',exact:true}).click();
  await settle();
};
try {
  await page.goto('http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  await mode('simple'); await idle();
  const baseline = await page.evaluate(() => ({renders:styk.timeline.stats.previewRenders, snapshots:styk.thumbnails.stats.snapshots, version:styk.thumbnails.version}));
  for (const index of [0,1,2,1,0,2,0]) await page.locator(`#timeline [data-frame="${index}"] .styk-simple-preview`).click();
  await idle();
  check('Repeated frame navigation renders zero additional thumbnails', await page.evaluate(renders => styk.timeline.stats.previewRenders === renders, baseline.renders));
  check('Clean seeks do not invalidate the thumbnail worker document', await page.evaluate(version => styk.thumbnails.version === version, baseline.version));

  const ids = await page.evaluate(() => styk.editor.report.keyframes.map(frame => frame._styk.frameId));
  const slider = page.locator('#timeline [data-frame="0"] input[type=range]');
  const box = await slider.boundingBox();
  await page.mouse.move(box.x + 5, box.y + box.height/2); await page.mouse.down();
  await page.mouse.move(box.x + box.width*.65, box.y + box.height/2, {steps:20}); await page.mouse.up();
  await idle();
  check('Dragging the green slider changes duration without moving any frame', await page.evaluate(ids => JSON.stringify(styk.editor.report.keyframes.map(frame => frame._styk.frameId)) === JSON.stringify(ids) && styk.editor.report.keyframes[0].duration_raw > 2, ids));
  check('Timing-only changes reuse all visible previews', await page.evaluate(renders => styk.timeline.stats.previewRenders === renders, baseline.renders));
  await slider.press('ArrowLeft'); await idle();
  check('Slider keyboard edits remain inside the control', await page.evaluate(() => styk.editor.frameIndex === 0));
  const beforePatch = await page.evaluate(() => ({...styk.thumbnails.stats}));
  await page.evaluate(() => { const t = styk.timeline; t.previews.delete(t.previewKey(styk.editor.frame)); t.render(); });
  await idle();
  check('A duration change reaches the worker as a patch, without resending the document', await page.evaluate(before => styk.thumbnails.stats.snapshots === before.snapshots && styk.thumbnails.stats.patches > before.patches, beforePatch));

  const local = await page.evaluate(() => {
    const before = styk.timeline.stats.previewRenders;
    styk.editor.select(styk.editor.frame.objects[0].unique_id); styk.editor.moveSelection(12,0); styk.editor.commitDrag();
    return before;
  });
  await idle();
  check('Editing a pose refreshes just its own thumbnail', await page.evaluate(before => styk.timeline.stats.previewRenders === before + 1, local));
  await page.locator('#timeline [data-simple-action=update]').click(); await idle();
  const addRenders = await page.evaluate(() => styk.timeline.stats.previewRenders);
  await page.evaluate(() => { styk.editor.select(styk.editor.frame.objects[0].unique_id); styk.editor.moveSelection(8,0); styk.editor.commitDrag(); });
  await idle();
  check('An uncommitted Add pose preserves stored-frame previews', await page.evaluate(before => styk.timeline.stats.previewRenders === before, addRenders));
  await page.evaluate(() => styk.editor.discardFrameDraft()); await idle();
  await page.getByLabel('Go to keyframe', {exact:true}).fill('4');
  await page.getByLabel('Go to keyframe', {exact:true}).press('Tab');
  check('Direct filmstrip navigation selects the requested keyframe', await page.evaluate(() => styk.editor.frameIndex === 3));
  await idle(); await page.screenshot({path:'artifacts/timeline-simple-redesign.png'});

  await mode('advanced');
  const grid = page.locator('#timeline .styk-timeline-scroll');
  await grid.focus();
  await page.keyboard.press('Home'); await page.keyboard.press('.');
  check('Period advances exactly one output frame', await page.evaluate(() => styk.editor.tick === 1));
  await page.keyboard.press(',');
  check('Comma moves back exactly one output frame', await page.evaluate(() => styk.editor.tick === 0));
  await page.getByLabel('Go to frame', {exact:true}).fill('17');
  await page.getByLabel('Go to frame', {exact:true}).press('Enter'); await settle();
  check('Go to frame uses one-based frame numbers', await page.evaluate(() => styk.editor.tick === 16));
  await page.evaluate(() => { const t = styk.timeline; styk.editor.select(styk.editor.frame.objects[0].unique_id); t.update(); t._setAnimationSelection(t.tracks[0].keys[0].refs); });
  const selected = await page.evaluate(() => JSON.stringify(styk.timeline.selectedAnimationKeys));
  const ruler = await grid.boundingBox();
  await page.mouse.move(ruler.x+80, ruler.y+14); await page.mouse.down();
  await page.mouse.move(ruler.x+200, ruler.y+14,{steps:15}); await page.mouse.up(); await settle();
  check('Scrubbing the ruler preserves the selected layer keys', await page.evaluate(selected => JSON.stringify(styk.timeline.selectedAnimationKeys) === selected, selected));
  await page.getByRole('button', {name:'Fit entire animation',exact:true}).click(); await settle();
  check('Fit places the complete animation within the viewport', await page.evaluate(() => 12 + styk.editor.totalTicks * styk.timeline.pxPerTick <= styk.timeline.width + 1));
  check('Advanced timeline has one selection-focused view', await page.evaluate(() => styk.timeline.actionMode && !styk.timeline.tracks.some(t=>['scene','camera','layer'].includes(t.kind))));
  check('The view switch is removed', await page.locator('#timeline button[aria-label="Frames"]').count() === 0);
  await page.evaluate(()=>{styk.editor.select(2);styk.editor.select(3,-1,{add:true});styk.timeline.update();});
  check('Action channels follow a multi-object selection',await page.evaluate(()=>JSON.stringify(styk.timeline.tracks.filter(t=>t.kind==='figure').map(t=>t.uid).sort())==='[2,3]'));
  await page.evaluate(()=>{styk.editor.select(null);styk.timeline.update();});
  check('Clearing object selection removes unrelated scene tracks',await page.evaluate(()=>styk.timeline.tracks.length===0));
  await page.evaluate(()=>{styk.editor.select(1);styk.timeline.update();styk.timeline._setAnimationSelection(styk.timeline.tracks[0].keys[0].refs);});
  await grid.focus();
  const count = await page.evaluate(() => styk.editor.animationChannels.length);
  await page.keyboard.press('g'); await page.keyboard.press('1'); await page.keyboard.press('Escape');
  check('G then Escape cancels without changing animation',await page.evaluate(count=>styk.editor.animationChannels.length===count,count));
  await page.keyboard.press('g'); await page.keyboard.press('1'); await page.keyboard.press('Enter');
  check('G then a frame offset moves only the selected figure',await page.evaluate(()=>styk.editor.animationChannels.some(c=>c.property==='pose'&&c.target.kind==='figure')));
  await page.evaluate(()=>styk.editor.undo());
  await page.locator('#onion-button').click();
  await page.locator('#onion-settings-button').click();
  const onion=page.getByRole('dialog',{name:'Onion skin settings',exact:true});
  await onion.locator('[data-onion=onionBefore]').fill('3');
  await onion.locator('[data-onion=onionAfter]').fill('2');
  await settle();
  check('Onion controls live in the timeline toolbar',await page.locator('.timeline-toolbar #onion-button').count()===1);
  check('Onion directions have independent counts',await page.evaluate(()=>styk.state.settings.onionBefore===3&&styk.state.settings.onionAfter===2));
  await page.evaluate(()=>styk.editor.seek(24));await settle();
  const onionBuilds=await page.evaluate(()=>styk.onionCache.stats.builds);
  await onion.locator('[data-onion=onionOpacity]').fill('48');await settle();
  check('Changing onion opacity reuses sampled geometry',await page.evaluate(builds=>styk.onionCache.stats.builds===builds,onionBuilds));
  check('Enabled onion skins contain tinted geometry',await page.evaluate(()=>styk.onionCache.last.frames.length===5&&styk.onionCache.last.frames.some(s=>s.geometry.drawables.some(d=>d.rgb[0]>d.rgb[2]))));
  await onion.getByLabel('Show on top',{exact:true}).check();await settle();
  check('Show on top updates onion composition without rebuilding geometry',await page.evaluate(builds=>styk.state.settings.onionShowOnTop&&styk.onionCache.last.frames.every(s=>s.showOnTop)&&styk.onionCache.stats.builds===builds,onionBuilds));
  await page.screenshot({path:'artifacts/onion-show-on-top.png'});
  await onion.getByLabel('Show on top',{exact:true}).uncheck();await settle();
  check('Disabling Show on top restores behind-scene composition',await page.evaluate(()=>styk.onionCache.last.frames.every(s=>!s.showOnTop)));
  await onion.getByLabel('Show on top',{exact:true}).check();await settle();
  await onion.locator('summary').click();await settle();
  await onion.locator('[data-onion=onionScope]').selectOption('selected');await settle();
  check('Onion scope applies immediately',await page.evaluate(()=>styk.state.settings.onionScope==='selected'));
  await page.screenshot({path:'artifacts/onion-skin-redesign.png'});
  await page.keyboard.press('Escape');await settle();
  check('Escape closes onion options without toggling playback',await onion.count()===0);
  await page.evaluate(()=>styk.settingsUI.open('animation'));
  check('Onion controls are removed from Settings',await page.locator('.styk-settings [data-setting^=onion]').count()===0);
  await page.getByRole('button',{name:'Close settings',exact:true}).click();
  await page.locator('#onion-button').click();
  await grid.focus();await page.keyboard.press('Shift+d');await page.keyboard.press('1');await page.keyboard.press('Enter');
  check('Shift+D duplicates and moves selected keys',await page.evaluate(()=>styk.editor.animationChannels.some(c=>c.target.kind==='figure'&&c.keys.some(k=>k.tick===1))));
  await page.evaluate(()=>styk.editor.undo());
  const heads = await page.evaluate(async () => {
    const t = styk.timeline;
    for (const tick of [1,4,8,12,2]) { styk.editor.seek(tick); t.resize(); await new Promise(requestAnimationFrame); }
    const data = t.headContext.getImageData(0,0,t.headCanvas.width,20).data;
    let groups = 0, previous = false;
    for (let x=0;x<t.headCanvas.width;x++) {
      let filled=false; for (let y=0;y<20;y++) if(data[(y*t.headCanvas.width+x)*4+3]) {filled=true;break;}
      if(filled&&!previous) groups++; previous=filled;
    }
    return groups;
  });
  check('Repeated layout changes leave exactly one playhead marker', heads === 1);
  await page.screenshot({path:'artifacts/timeline-advanced-redesign.png'});
  for (const width of [1100,900]) {
    await page.setViewportSize({width,height:800}); await settle();
    check(`Timeline controls fit at ${width}px window width`, await page.evaluate(() => {
      const t=styk.timeline, outer=t.root.getBoundingClientRect();
      return [...t.root.querySelectorAll('.styk-timeline-nav button,.styk-timeline-editbar button')].filter(n=>n.getClientRects().length).every(n=>{ const r=n.getBoundingClientRect(); return r.left>=outer.left-1 && r.right<=outer.right+1 && r.bottom<=outer.bottom+1; });
    }));
    await page.screenshot({path:`artifacts/timeline-advanced-${width}.png`});
  }
  await page.evaluate(()=>styk.settingsUI.flush());await page.reload();await page.waitForFunction(()=>window.styk?.ready);
  check('Onion customization persists after reloading',await page.evaluate(()=>styk.state.settings.onionBefore===3&&styk.state.settings.onionAfter===2&&styk.state.settings.onionOpacity===.48&&styk.state.settings.onionScope==='selected'));
  check('Show on top persists after reloading',await page.evaluate(()=>styk.state.settings.onionShowOnTop===true));
  check('No browser errors', errors.length === 0);
  await writeFile('artifacts/timeline-usability-verification.json',JSON.stringify({checks,errors,baseline},null,2));
} finally { await browser.close(); }
