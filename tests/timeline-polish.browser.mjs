import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1440,height:960}}), errors=[];
page.on('pageerror', error=>errors.push(error.message));
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const snapshot=()=>page.evaluate(()=>JSON.stringify(styk.editor.serialize()));
try {
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');
  await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs'),r=emptyDocument();
    r.auto_easing=false;r.keyframes=[0,120,240].map(x=>createFrame([createObject(r.figure_types[0],1,200+x,250)],12));
    styk.settingsUI.commit({timelineMode:'simple'});styk.editor.load(r);styk.fit();
  });
  await settle();
  const strip=page.getByRole('listbox',{name:'Animation frames'});
  const preview=index=>strip.getByRole('option',{name:`Frame ${index}`,exact:true});
  const baseline=await snapshot();
  const slider=page.getByRole('slider',{name:'Frame 1 inbetweens',exact:true});
  assert.equal(await slider.inputValue(),'11');
  // Actual keyboard interaction on the restored range control, one undoable edit.
  await slider.press('Home');await settle();
  assert.equal(await slider.inputValue(),'0');
  assert.deepEqual(await page.evaluate(()=>styk.timeline.times),[0,1,13]);
  await strip.press('Control+z');await settle();assert.equal(await snapshot(),baseline);
  await preview(2).click();await slider.press('Home');await settle();
  assert.deepEqual(await page.evaluate(()=>[styk.timeline.selectedIndex,styk.editor.tick]),[1,1]);
  await strip.press('Control+z');await preview(1).click();await settle();assert.equal(await snapshot(),baseline);
  // Drag previews stay cheap: slider input previews do not commit until change.
  const burst=await page.evaluate(()=>{
    const input=document.querySelector('.sheet-inbetweens input'),before=JSON.stringify(styk.editor.serialize());
    for(let i=0;i<240;i++){input.value=String(i%20);input.dispatchEvent(new Event('input',{bubbles:true}));}
    return before===JSON.stringify(styk.editor.serialize());
  });assert.equal(burst,true);
  await page.getByLabel('Frame inbetweens',{exact:true}).fill('5');
  await page.getByLabel('Frame inbetweens',{exact:true}).press('Enter');await strip.click();await settle();
  assert.deepEqual(await page.evaluate(()=>styk.timeline.times),[0,6,18]);
  await strip.press('Control+z');await settle();assert.equal(await snapshot(),baseline);
  await preview(1).dblclick();
  await page.getByRole('radio',{name:'Ease in',exact:true}).click();await settle();
  const eased=await page.evaluate(()=>{const e=styk.editor;e.seek(6);return e.evaluatedFrame.objects[0].root_x;});
  assert.ok(eased>200&&eased<260,`Expected eased inbetween, got ${eased}`);
  await page.evaluate(()=>styk.settingsUI.commit({timelineMode:'advanced'}));await settle();
  assert.equal(await page.getByLabel('Frame interpolation',{exact:true}).inputValue(),'ease-in');
  await page.getByRole('grid',{name:'Layer frames'}).press('Control+z');await settle();assert.equal(await snapshot(),baseline);
  await page.evaluate(()=>{styk.settingsUI.commit({timelineMode:'simple'});styk.editor.seek(0);});await settle();
  // Custom curves use the existing curve editor and retain a single history entry.
  await page.getByRole('button',{name:'Frame easing',exact:true}).click();
  await page.getByRole('radio',{name:'Bezier',exact:true}).click();
  await page.getByLabel('Control 1 · X',{exact:true}).fill('0.2');
  await page.getByRole('button',{name:'Apply',exact:true}).click();await settle();
  assert.deepEqual(await page.evaluate(()=>styk.editor.layerFrameKeys('layer-1')[0].bezier),[.2,0,.58,1]);
  await strip.press('Control+z');await settle();assert.equal(await snapshot(),baseline);
  // Right-clicking a selected frame preserves the range and shows only real actions.
  await preview(1).click();await preview(2).click({modifiers:['Shift']});await preview(1).click({button:'right'});
  assert.deepEqual(await page.evaluate(()=>styk.timeline.selectedFrameIndices),[0,1]);
  const menu=page.getByRole('menu');
  assert.deepEqual((await menu.getByRole('menuitem').allTextContents()).map(text=>text.trim()),['Frame easing…','Insert frame','Copy framesCtrl+C','Cut framesCtrl+X','Delete framesDelete']);
  assert.equal(await menu.locator('button .icon').count(),5);
  const box=await menu.boundingBox();assert.ok(box.height<220&&box.y>=0&&box.y+box.height<=960);
  await page.screenshot({path:'artifacts/timeline-simple-menu.png'});
  await menu.press('Escape');assert.equal(await menu.count(),0);
  await page.getByLabel('Frame inbetweens',{exact:true}).fill('3');
  await page.getByLabel('Frame inbetweens',{exact:true}).press('Tab');await settle();
  assert.deepEqual(await page.evaluate(()=>styk.timeline.times),[0,4,8]);
  await strip.press('Control+z');await settle();assert.equal(await snapshot(),baseline);
  await preview(1).click();await page.getByRole('button',{name:'Insert frame',exact:true}).click();await settle();
  assert.deepEqual(await page.evaluate(()=>styk.timeline.times),[0,1,13,25]);
  assert.equal(await page.evaluate(()=>styk.editor.evaluatedFrame.objects.length),1);
  await strip.press('Control+z');await settle();assert.equal(await snapshot(),baseline);
  await preview(1).click({button:'right'});await page.getByRole('menuitem',{name:'Cut frames',exact:false}).click();await settle();
  assert.deepEqual(await page.evaluate(()=>styk.timeline.times),[0,12]);
  assert.equal(await page.evaluate(()=>styk.editor.evaluatedFrame.objects[0].root_x),320);
  await strip.press('Control+z');await settle();assert.equal(await snapshot(),baseline);
  await page.setViewportSize({width:900,height:700});await settle();
  assert.equal(await page.getByRole('button',{name:'Frame easing',exact:true}).isVisible(),true);
  await page.screenshot({path:'artifacts/timeline-simple-compact.png'});
  await page.setViewportSize({width:1440,height:960});
  await page.evaluate(()=>{styk.settingsUI.commit({timelineMode:'advanced'});styk.editor.seek(0);});await settle();
  const grid=page.getByRole('grid',{name:'Layer frames'});
  assert.equal(await page.getByRole('button',{name:/blank/i}).count(),0);
  const cell=await page.evaluate(async()=>{const {HEADER,ROW}=await import('/src/layer-timeline.mjs'),t=styk.timeline,b=t.scroll.getBoundingClientRect();return {x:b.x+6.5*t.pxPerTick,y:b.y+HEADER+ROW/2};});
  await page.mouse.click(cell.x,cell.y,{button:'right'});
  assert.equal(await page.getByRole('menuitem',{name:/blank|Create tween|layer|Hold|Select span/i}).count(),0);
  assert.ok(await page.getByRole('menuitem',{name:'Insert keyframe',exact:false}).count());
  await page.screenshot({path:'artifacts/timeline-advanced-menu.png'});
  await page.getByRole('menu').press('Escape');
  await page.locator('.sheet-layer-name').first().click({button:'right'});
  assert.equal(await page.getByRole('menuitem',{name:/frame|tween/i}).count(),0);
  await page.getByRole('menuitem',{name:'Rename layer',exact:true}).click();
  await page.locator('.sheet-layer-rename').fill('Characters');await page.locator('.sheet-layer-rename').press('Enter');
  await page.getByRole('button',{name:'Timeline options',exact:true}).click();
  assert.equal(await page.getByRole('menuitemcheckbox',{name:'Camera and Scene',exact:true}).count(),1);
  assert.equal(await page.getByRole('menu').locator('button').count(),1);
  await page.getByRole('menu').press('Escape');
  assert.deepEqual(errors,[]);
  console.log('PASS simple sliders, inbetweens, preset/custom easing, mode sync, undo, frame insert/cut, contextual menus, icons, and compact layout');
} catch(error) { await page.screenshot({path:'artifacts/timeline-polish-failure.png'});throw error; }
finally { await browser.close(); }
