import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),directory=path.join(root,'artifacts',`sprite-builder-${Date.now()}`),imageFile=path.join(root,'artifacts','sprite-placement','upper-arm.png');
await mkdir(directory,{recursive:true});await readFile(imageFile);
const app=await electron.launch({args:[root],cwd:root,timeout:45000,env:{...process.env,STYK_USER_DATA_DIR:path.join(directory,'profile')}});
const checks=[],errors=[],check=name=>{checks.push(name);console.log(`PASS ${name}`);};
try {
  const page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    styk.settingsUI.commit({timelineMode:'advanced',autosaveSeconds:0});await styk.settingsUI.flush();
    const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');const report=emptyDocument(),other=structuredClone(report.figure_types[0]);other.figure_type_id=2;other.name='Other target';report.figure_types.push(other);
    report.keyframes=[createFrame([createObject(report.figure_types[0],1,220,210),createObject(other,2,440,210)],5)];
    styk.editor.load(report,'Sprite attachment fixture');styk.editor.select(1,0);styk.fit();window.beforeSprite=JSON.stringify(styk.editor.serialize());window.beforeSpriteHistory=styk.editor._undo.length;
  });
  const chooseFile=async(action)=>{const chooser=page.waitForEvent('filechooser');await page.evaluate(action=>styk.actions[action](),action);await(await chooser).setFiles(imageFile);};
  const place=async()=>{await chooseFile('add-sprite-segment');await page.waitForFunction(()=>document.querySelector('[data-sprite-apply]')&&!document.querySelector('[data-sprite-apply]').disabled);};
  const use=async()=>{await page.locator('[data-sprite-apply]').click();await page.waitForFunction(()=>Boolean(styk.state.spritePlacement));};
  await place();
  for(const[key,axis,value]of[['start','x',60],['start','y',35],['end','x',60],['end','y',155]])await page.locator(`[data-sprite-point="${key}"][data-sprite-axis="${axis}"]`).fill(String(value));
  assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())===beforeSprite),true);await use();
  assert.equal(await page.locator('#overlay').evaluate(canvas=>getComputedStyle(canvas).cursor),'crosshair');
  const target=await page.evaluate(()=>{
    const g=[...styk.editor.geometry.objects.values()].find(g=>g.obj.unique_id===2),id=g.fig.segments[2].segment_id,point=g.joints.get(id),rect=document.getElementById('overlay').getBoundingClientRect();
    return{id,x:rect.x+styk.state.view.x+point.x*styk.state.view.scale,y:rect.y+styk.state.view.y+point.y*styk.state.view.scale};
  });
  await page.mouse.move(target.x,target.y);await page.screenshot({path:path.join(directory,'attachment-target.png')});await page.mouse.click(target.x,target.y);await page.waitForFunction(()=>!styk.state.spritePlacement&&styk.editor.figure?.image_assets?.length===1);
  const attached=await page.evaluate(()=>({uid:styk.editor.selectedUid,definitionCount:styk.editor.report.figure_types.length,objectCount:styk.editor.frame.objects.length,other:styk.editor.report.figure_types[0].image_assets.length,
    parent:styk.editor.figure.segments.at(-1).parent_id,start:styk.editor.figure.image_assets[0].anchor_start,end:styk.editor.figure.image_assets[0].anchor_end,undo:styk.editor._undo.length-beforeSpriteHistory}));
  assert.deepEqual(attached,{uid:2,definitionCount:2,objectCount:2,other:0,parent:target.id,start:{x:60,y:35},end:{x:60,y:155},undo:1});check('Actual Build file picker and anchor dialog attach one sprite to a different chosen figure, without creating another type.');
  await page.evaluate(()=>styk.editor.undo());assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())===beforeSprite),true);await page.evaluate(()=>styk.editor.redo());assert.equal(await page.evaluate(()=>styk.editor.figure.image_assets.length),1);check('One Undo and Redo restore the complete attachment, shared definition and prior selection.');
  const pivFile=path.join(directory,'Attached sprite.piv'),stkFile=path.join(directory,'Attached sprite.stk');
  await app.evaluate(({dialog},files)=>{globalThis.__spriteSaveFiles=files;dialog.showSaveDialog=async()=>({canceled:false,filePath:globalThis.__spriteSaveFiles.shift()});},[pivFile,stkFile]);
  await page.evaluate(()=>styk.actions['export-piv']());await page.evaluate(()=>styk.actions['export-stk']());assert.ok((await readFile(pivFile)).length>100);assert.ok((await readFile(stkFile)).length>100);
  await page.evaluate(()=>styk.editor.markSaved());await page.locator('#file-input').setInputFiles(pivFile);await page.waitForFunction(()=>styk.editor.name==='Attached sprite');
  assert.deepEqual(await page.evaluate(()=>{const f=styk.editor.report.figure_types.find(f=>f.image_assets?.length);return {start:f.image_assets[0].anchor_start,end:f.image_assets[0].anchor_end,parent:f.segments.at(-1).parent_id,images:f.image_assets.length};}),{start:{x:60,y:35},end:{x:60,y:155},parent:target.id,images:1});
  const beforeSTK=await page.evaluate(()=>styk.editor.frame.objects.length);await page.locator('#file-input').setInputFiles(stkFile);await page.waitForFunction(count=>styk.editor.frame.objects.length===count+1,beforeSTK);
  assert.ok(await page.evaluate(()=>styk.editor.figure.image_assets[0].anchor_start.x===60&&styk.editor.figure.image_assets[0].anchor_end.y===155));check('Actual native PIV and STK Save dialogs and file inputs preserve the attached image and anchor geometry.');
  let before=await page.evaluate(()=>JSON.stringify(styk.editor.serialize()));await place();await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('dialog').open);assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),before);check('Canceling the anchor dialog changes no project data.');
  await place();await use();await page.keyboard.press('Escape');await page.waitForFunction(()=>!styk.state.spritePlacement);assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),before);check('Escape cancels pending attachment without committing a hidden edit.');
  await place();await use();await page.keyboard.press('v');await page.waitForFunction(()=>!styk.state.spritePlacement);assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),before);check('Changing tools cancels pending attachment and leaves the figure unchanged.');
  await place();await use();await page.evaluate(()=>{styk.editor.markSaved();return styk.actions.new();});await page.waitForFunction(()=>!styk.state.spritePlacement&&styk.editor.name==='Untitled animation');assert.equal(await page.evaluate(()=>styk.editor.report.figure_types.some(f=>f.image_assets?.length)),false);check('New document cancels pending sprite ownership and cannot attach the prior image.');
  const initial=await page.evaluate(()=>({types:styk.editor.report.figure_types.length,objects:styk.editor.frame.objects.length}));await chooseFile('import-sprite');await page.waitForFunction(count=>styk.editor.frame.objects.length===count+1,initial.objects);
  assert.equal(await page.evaluate(()=>Boolean(styk.state.spritePlacement)||document.getElementById('dialog').open),false);assert.equal(await page.evaluate(()=>styk.editor.report.figure_types.length),initial.types+1);check('Ordinary Import Sprite still imports immediately as a separate figure.');
  assert.deepEqual(errors,[]);await page.screenshot({path:path.join(directory,'desktop.png')});await writeFile(path.join(root,'artifacts','sprite-builder-smoke.json'),JSON.stringify({timestamp:new Date().toISOString(),checks,errors,directory},null,2));
} finally {await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.removeAllListeners('close');}).catch(()=>{});await app.close().catch(()=>{});}
