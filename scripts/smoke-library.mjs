import {_electron as electron, closeStartupPrompts} from '../tests/support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile, copyFile} from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd(), packaged=process.argv.includes('--packaged'), run=path.join(root,'artifacts',`library-${packaged?'packaged-':''}${Date.now()}`);
await mkdir(run,{recursive:true});
const library=path.join(run,'Documents','StykAnimate','library'), errors=[], checks=[];
async function launch() {
  const profile=path.join(run,`profile-${Date.now()}`); await mkdir(profile,{recursive:true});
  // Isolated automated profiles keep optional collection off and skip onboarding.
  await writeFile(path.join(profile,'telemetry-state.json'),JSON.stringify({decided:true,consent:{analytics:false,diagnostics:false,policyVersion:'2026-09-10',updatedAt:Date.now()}}));
  const app=await electron.launch({executablePath:packaged?process.env.STYK_PACKAGED_EXECUTABLE||path.join(root,'release','win-unpacked','StykAnimate.exe'):undefined,args:packaged?[]:[root],cwd:root,timeout:45000,env:{...process.env,STYK_LIBRARY_DIR:library,STYK_USER_DATA_DIR:profile,STYK_DEBUG:'1'}});
  const page=await app.firstWindow(); page.on('pageerror',e=>errors.push(e.message)); await page.waitForFunction(()=>window.styk?.ready,{timeout:30000}); await closeStartupPrompts(page);
  return {app,page};
}
let current;
async function close() { if (!current) return; await current.app.evaluate(({app})=>{app.exit(0);}).catch(()=>{}); current=null; }
async function settled(page) { await page.waitForFunction(()=>!window.styk.library.busy); const error=await page.locator('.library-message').getAttribute('data-error'); if(error==='true')throw new Error(await page.locator('.library-message').innerText()); }
try {
  current=await launch(); let {page}=current;
  // New documents start with one figure; the checks below need the three-figure demo scene.
  const demoScene=async page=>page.evaluate(async()=>{const {createDemo}=await import('/src/demo.mjs');window.styk.editor.load(createDemo());});
  await demoScene(page);
  await page.getByRole('tab',{name:'Library',exact:true}).click(); await page.waitForFunction(()=>window.styk.library.root);
  await page.getByRole('button',{name:'New library folder',exact:true}).click(); await page.getByRole('textbox',{name:'Folder name',exact:true}).fill('Characters'); await page.getByRole('button',{name:'Create folder',exact:true}).click();
  await page.locator('[data-library-path="Characters"]').dblclick(); await page.waitForFunction(()=>window.styk.library.folder==='Characters');
  await page.evaluate(()=>window.styk.editor.select(1)); await page.locator('#user-library [data-library-action="save"]').click(); await settled(page);
  await page.waitForSelector('.library-thumbnail img');
  let items=await page.evaluate(()=>window.styk.library.entries); assert.equal(items.length,1); const original=items[0].path;
  assert.ok((await readFile(path.join(library,original))).length>50); assert.ok((await readFile(path.join(library,original+'.png'))).length>100);
  checks.push('native figure and PNG saved to current Documents subfolder');
  await page.locator('.library-card').click(); await page.keyboard.press('F2'); await page.getByRole('textbox',{name:'Asset name',exact:true}).fill('Blue hero'); await page.getByRole('textbox',{name:'Asset name',exact:true}).press('Enter');
  await page.waitForSelector('[data-library-path="Characters/Blue hero.stkz"]');
  await page.locator('[data-library-path="Characters/Blue hero.stkz"]').dblclick(); await settled(page);
  let count=await page.evaluate(()=>window.styk.editor.selectionFrame.objects.length); assert.equal(count,4); await page.evaluate(()=>window.styk.editor.undo()); assert.equal(await page.evaluate(()=>window.styk.editor.selectionFrame.objects.length),3);
  checks.push('inline rename carries thumbnail; double-click inserts; one undo restores scene');
  await page.evaluate(()=>{const e=window.styk.editor;e.select(1);e.select(3,{add:true});}); await page.locator('#user-library [data-library-action="save"]').click(); await settled(page);
  await page.locator('[data-library-path="Characters/Figure set.stkz"]').dblclick(); await settled(page); assert.equal(await page.evaluate(()=>window.styk.editor.selectedObjects.length),2); assert.equal(await page.evaluate(()=>window.styk.editor.selectionFrame.objects.length),5); await page.evaluate(()=>window.styk.editor.undo());
  checks.push('multi-figure file round trip restores every selected figure');
  await page.evaluate(()=>{const e=window.styk.editor;e.select(1);e.createMovieclip({start:0,end:12,name:'Walk cycle'});}); await page.locator('#user-library [data-library-action="save"]').click(); await settled(page);
  await page.locator('[data-library-path="Characters/Walk cycle.stykmov"]').dblclick(); await settled(page); assert.equal(await page.evaluate(()=>window.styk.editor.figure._styk.movieclip.duration),12);
  checks.push('movieclip file round trip retains animation');
  await page.getByRole('searchbox',{name:'Search library',exact:true}).fill('blue'); assert.equal(await page.locator('.library-card').count(),1); await page.getByRole('searchbox',{name:'Search library',exact:true}).fill('');
  await page.locator('[data-library-path="Characters/Blue hero.stkz"]').click({button:'right'}); await page.getByRole('menuitem',{name:'Move to…',exact:true}).click(); await page.getByRole('button',{name:'Move here',exact:true}).click();
  await page.waitForFunction(()=>!window.styk.library.entries.some(i=>i.name==='Blue hero'));
  await page.locator('.library-breadcrumbs button').first().click(); await page.waitForSelector('[data-library-path="Blue hero.stkz"]');
  await page.getByRole('tab',{name:'Properties',exact:true}).click(); assert.equal(await page.locator('#inspector').isVisible(),true); await page.getByRole('tab',{name:'Library',exact:true}).click();
  checks.push('folder move, search, and Properties/Library switching');
  await page.screenshot({path:path.join(run,'library-root.png')});
  await page.locator('[data-library-path="Characters"]').dblclick(); await page.waitForSelector('[data-library-path="Characters/Walk cycle.stykmov"]'); await page.waitForFunction(()=>[...document.querySelectorAll('.library-thumbnail img')].every(i=>i.complete));
  await page.screenshot({path:path.join(run,'library-assets.png')});
  await close(); current=await launch(); page=current.page; await demoScene(page);
  await page.getByRole('tab',{name:'Library',exact:true}).click(); await page.waitForSelector('[data-library-path="Blue hero.stkz"]'); await page.waitForSelector('.library-thumbnail img');
  await page.locator('[data-library-path="Blue hero.stkz"]').dblclick(); await settled(page); assert.equal(await page.evaluate(()=>window.styk.editor.selectionFrame.objects.length),4);
  checks.push('library and thumbnails persist through a full desktop restart'); assert.deepEqual(errors,[]);
  await copyFile(path.join(library,'Blue hero.stkz'),path.join(library,'External asset.stkz'));
  await page.getByRole('button',{name:'Library options',exact:true}).click(); await page.getByRole('menuitem',{name:'Refresh',exact:true}).click(); await page.waitForSelector('[data-library-path="External asset.stkz"] img');
  assert.ok((await readFile(path.join(library,'External asset.stkz.png'))).length>100);
  checks.push('files copied into the library get persistent previews automatically');
  await page.evaluate(async()=>{
    const {imageFileToFigure}=await import('./src/media-authoring.mjs');
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=40;const context=canvas.getContext('2d');context.fillStyle='#ed4455';context.fillRect(0,0,64,40);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve));const report=await imageFileToFigure(new File([blob],'Red sprite.png',{type:'image/png'}),{preserveOpaqueBackground:true});window.styk.editor.importFigure(report);
  });
  await page.locator('#user-library [data-library-action="save"]').click(); await settled(page);
  const sprite=await page.evaluate(()=>window.styk.library.selected); await page.locator(`[data-library-path="${sprite}"] img`).waitFor();
  const red=await page.locator(`[data-library-path="${sprite}"] img`).evaluate(image=>{const c=document.createElement('canvas');c.width=c.height=320;const x=c.getContext('2d');x.drawImage(image,0,0,320,320);return [...x.getImageData(160,160,1,1).data];}); assert.ok(red[0]>200&&red[1]<100&&red[3]>200);
  checks.push('embedded image asset renders with correct color in its saved thumbnail');
  const rootListing=await page.evaluate(()=>window.stykDesktop.listLibrary()); assert.ok(rootListing.entries.some(i=>i.name==='Blue hero'));
  // Exercise the real UI and constrained trash IPC with a reversible test substitute.
  await current.app.evaluate(({shell})=>{global.libraryTrashed=[];shell.trashItem=async p=>{global.libraryTrashed.push(p);};});
  await page.locator('[data-library-path="External asset.stkz"]').click(); await page.keyboard.press('Delete'); await page.getByRole('button',{name:'Move to Recycle Bin',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.library-dialog').open); const trashed=await current.app.evaluate(()=>global.libraryTrashed);assert.equal(trashed.length,2);assert.ok(trashed.every(p=>p.startsWith(library)));
  checks.push('Recycle Bin action targets only the chosen library asset and preview');
  const evidence={packaged,run,library,checks,errors}; await writeFile(path.join(run,'evidence.json'),JSON.stringify(evidence,null,2)); console.log(JSON.stringify(evidence,null,2));
} catch(error) { if(current) { await current.page.screenshot({path:path.join(run,'failure.png')}).catch(()=>{}); console.error(await current.page.locator('.library-message').innerText().catch(()=>'')); } throw error; }
finally {await close();}
