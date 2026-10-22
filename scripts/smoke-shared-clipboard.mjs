import {_electron as electron, closeStartupPrompts} from '../tests/support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
// Mod is Command on macOS.
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

const root = process.cwd(), run = path.join(root, 'artifacts', `shared-clipboard-${Date.now()}`), profile = path.join(run, 'profile');
await mkdir(profile, {recursive:true});
await writeFile(path.join(profile, 'editor-settings.json'), JSON.stringify({timelineMode:'simple'}));
await writeFile(path.join(profile, 'telemetry-state.json'), JSON.stringify({decided:true,consent:{analytics:false,diagnostics:false,policyVersion:'2026-09-10',updatedAt:Date.now()}}));
const apps = [], errors = [], checks = [];
async function launch() {
  const app = await electron.launch({args:[root],cwd:root,timeout:45000,env:{...process.env,STYK_USER_DATA_DIR:profile,STYK_LIBRARY_DIR:path.join(run,'library'),STYK_DEBUG:'1'}});
  apps.push(app); const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => window.styk?.ready, undefined, {timeout:45000});
  await closeStartupPrompts(page);
  return {app,page};
}
async function flush(page) { await page.evaluate(() => window.styk.clipboard.pending); }
async function selectCanvas(page) { await page.bringToFront(); await page.evaluate(() => document.activeElement?.blur()); }
async function empty(page) { await page.evaluate(async () => { const {emptyDocument}=await import('./src/editor.mjs'); window.styk.editor.load(emptyDocument()); }); }
try {
  const a = await launch(), b = await launch();
  assert.notEqual(new URL(a.page.url()).origin, new URL(b.page.url()).origin);
  checks.push('Two simultaneous processes with the same profile own separate projects and backend origins');
  // New documents start with one figure; these checks copy between figures of the three-figure demo scene.
  await a.page.evaluate(async () => { const {createDemo}=await import('/src/demo.mjs'); window.styk.editor.load(createDemo()); });
  await a.page.evaluate(() => { const e=window.styk.editor; e.select(1); e.select(3,{add:true}); });
  await selectCanvas(a.page); await a.page.keyboard.press(`${mod}+c`); await flush(a.page);
  await empty(b.page); await selectCanvas(b.page); await b.page.keyboard.press(`${mod}+v`); await flush(b.page);
  assert.equal(await b.page.evaluate(() => window.styk.editor.selectedObjects.length), 2);
  await b.page.keyboard.press(`${mod}+z`); assert.equal(await b.page.evaluate(() => window.styk.editor.selectionFrame.objects.length), 0);
  await b.page.keyboard.press(`${mod}+Shift+z`); assert.equal(await b.page.evaluate(() => window.styk.editor.selectionFrame.objects.length), 2);
  checks.push('Real Ctrl+C/Ctrl+V exchange selected figures across desktop instances with undo/redo');
  await b.page.evaluate(() => window.styk.editor.select(window.styk.editor.selectedObjects[0].unique_id));
  await selectCanvas(b.page); await b.page.keyboard.press(`${mod}+x`); await flush(b.page);
  await selectCanvas(a.page); await a.page.keyboard.press(`${mod}+v`); await flush(a.page);
  assert.equal(await a.page.evaluate(() => window.styk.editor.selectedObjects.length), 1);
  checks.push('Cut in the destination replaces the previous clipboard and pastes back in the source');

  await a.page.evaluate(() => {const e=window.styk.editor; e.select(1); e.createMovieclip({start:0,end:12,name:'Shared walk'});});
  await selectCanvas(a.page); await a.page.keyboard.press(`${mod}+c`); await flush(a.page);
  await selectCanvas(b.page); await b.page.keyboard.press(`${mod}+v`); await flush(b.page);
  assert.equal(await b.page.evaluate(() => window.styk.editor.figure._styk.movieclip.duration), 12);
  checks.push('Movieclip animation survives the native OS clipboard');

  await a.page.evaluate(() => {const e=window.styk.editor; const l=e.createLayer('Extra layer'); e.assignFiguresToLayer([3],l.id);});
  await a.page.bringToFront(); await a.page.getByRole('button',{name:'Copy frames',exact:true}).click(); await flush(a.page);
  await empty(b.page); await b.page.bringToFront();
  await b.page.getByRole('button',{name:'Paste frames',exact:true}).click(); await flush(b.page);
  assert.equal(await b.page.evaluate(() => window.styk.editor.report._styk.layers.order.length), 2);
  assert.ok(await b.page.evaluate(() => window.styk.editor.selectionFrame.objects.length > 0));
  checks.push('Filmstrip Copy/Paste buttons work immediately across projects and add missing destination layers');

  await a.page.bringToFront(); await a.page.evaluate(() => { const e=window.styk.editor; e.select(e.selectionFrame.objects.find(o => !e.report.figure_types.find(f => f.figure_type_id === o.figure_type_id)?._styk?.movieclip).unique_id); });
  await a.page.getByRole('tab',{name:'Library',exact:true}).click();
  await a.page.locator('#user-library [data-library-action="save"]').click();
  await a.page.waitForFunction(() => !window.styk.library.busy && window.styk.library.entries.length);
  await a.page.locator('.library-thumbnail img').first().waitFor();
  const count = await a.page.evaluate(() => window.styk.editor.selectionFrame.objects.length);
  const card = a.page.locator('.library-card:not(.folder)').first();
  // The card is dragged with the pointer, never as an HTML drag.
  assert.equal(await card.evaluate(element => element.draggable), false);
  await card.dragTo(a.page.locator('#viewport'), {targetPosition:{x:260,y:220}});
  await a.page.waitForFunction(n => !window.styk.library.busy && window.styk.editor.selectionFrame.objects.length === n+1, count);
  const drop = await a.page.evaluate(() => {
    const {editor:e,state:s}=window.styk, object=e.object;
    return {x:object.root_x,y:object.root_y,expectedX:(260-s.view.x)/s.view.scale,expectedY:(220-s.view.y)/s.view.scale};
  });
  assert.ok(Math.abs(drop.x-drop.expectedX)<1e-4); assert.ok(Math.abs(drop.y-drop.expectedY)<1e-4);
  await a.page.screenshot({path:path.join(run,'library-drop.png')});
  await a.page.evaluate(() => window.styk.editor.undo());
  assert.equal(await a.page.evaluate(() => window.styk.editor.selectionFrame.objects.length),count);
  checks.push('Real mouse drag from library inserts at the pointer and one undo removes the insertion');
  await b.page.screenshot({path:path.join(run,'pasted-frames.png')});

  await a.page.evaluate(() => { window.styk.settingsUI.commit({timelineMode:'advanced'}); const t=window.styk.timeline; t.selectedLayers=new Set([window.styk.editor.report._styk.layers.order.at(-1)]); t.start=t.end=0; });
  await a.page.locator('.sheet-scroll').focus(); await a.page.keyboard.press(`${mod}+c`); await flush(a.page);
  await empty(b.page); await b.page.evaluate(() => window.styk.settingsUI.commit({timelineMode:'advanced'}));
  await b.page.locator('.sheet-scroll').focus(); await b.page.keyboard.press(`${mod}+v`); await flush(b.page);
  assert.ok(await b.page.evaluate(() => window.styk.editor.selectionFrame.objects.length > 0));
  checks.push('Advanced layer timeline Ctrl+C/Ctrl+V exchanges selected frame cells');

  for(const [sourceVersion,targetVersion] of [[4,5],[5,4],[5,5]]) {
    await a.page.evaluate(async version=>{
      const {emptyDocument,createFrame,createObject}=await import('./src/demo.mjs');
      const report=emptyDocument();report.version=version;report.frame_delay_ms=40;
      report.figure_types[0].segments.forEach((segment,i)=>{segment.color_rgb=[20+i*10,90,180];});
      report.keyframes=[createFrame([0xffffffff,0x0033cc,0,0x80112233].map((raw,i)=>createObject(report.figure_types[0],i+1,100+i*200,300,{color_override_raw:raw})))];
      styk.editor.load(report);styk.editor.selectMany([1,2,3,4]);styk.fit();
    },sourceVersion);
    const colors=page=>page.evaluate(async()=>{
      const {buildGeometry}=await import('./src/pivot/geometry.mjs');
      return buildGeometry(styk.editor.report,styk.editor.selectionFrame).drawables.map(s=>[s.rgb,s.alpha]);
    });
    const expected=await colors(a.page);
    await selectCanvas(a.page);await a.page.keyboard.press(`${mod}+c`);await flush(a.page);
    await empty(b.page);await b.page.evaluate(version=>{const report=styk.editor.serialize();report.version=version;report.frame_delay_ms=40;styk.editor.load(report);},targetVersion);
    await selectCanvas(b.page);await b.page.keyboard.press(`${mod}+v`);await flush(b.page);
    assert.deepEqual(await colors(b.page),expected);
    await b.page.evaluate(()=>styk.fit());
    await b.page.waitForFunction(()=>!styk.state.editablePreparing&&styk.state.renderer.last?.report===styk.editor.report);
    await b.page.screenshot({path:path.join(run,`colors-${sourceVersion}-to-${targetVersion}.png`)});
    checks.push(`Rendered figure colors preserved through real OS clipboard (${sourceVersion} to ${targetVersion})`);
  }

  await a.page.evaluate(async () => {
    const {imageFileToFigure}=await import('./src/media-authoring.mjs');
    const c=document.createElement('canvas'); c.width=80;c.height=60;
    const x=c.getContext('2d');x.fillStyle='#e43a51';x.fillRect(0,0,80,60);
    const blob=await new Promise(resolve=>c.toBlob(resolve));
    window.styk.editor.importFigure(await imageFileToFigure(new File([blob],'Shared red sprite.png',{type:'image/png'}),{preserveOpaqueBackground:true}));
  });
  await selectCanvas(a.page); await a.page.keyboard.press(`${mod}+c`); await flush(a.page);
  await a.app.evaluate(({app}) => app.exit(0));
  await selectCanvas(b.page); await b.page.keyboard.press(`${mod}+v`); await flush(b.page);
  assert.ok(await b.page.evaluate(() => window.styk.editor.figure.image_assets.some(asset => /^data:image\//.test(asset.data_url ?? asset.data_uri ?? ''))));
  await b.page.screenshot({path:path.join(run,'sprite-after-source-close.png')});
  checks.push('Embedded sprite pastes and renders after its source process and backend have closed');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(run,'evidence.json'),JSON.stringify({run,checks,errors},null,2));
  console.log(JSON.stringify({run,checks,errors},null,2));
} catch (error) {
  for (const [i,app] of apps.entries()) { const page=app.windows()[0]; await page?.screenshot({path:path.join(run,`failure-${i}.png`)}).catch(()=>{}); if(page)console.error(await page.evaluate(() => ({dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.innerText),library:document.querySelector('.library-message')?.textContent})).catch(()=>{})); }
  throw error;
} finally { for (const app of apps.reverse()) await app.evaluate(({app}) => app.exit(0)).catch(()=>{}); }
