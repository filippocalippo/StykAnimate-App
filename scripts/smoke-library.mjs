import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd(), packaged=process.argv.includes('--packaged'), run=path.join(root,'artifacts',`library-${packaged?'packaged-':''}${Date.now()}`);
await mkdir(run,{recursive:true});
const library=path.join(run,'Documents','StykAnimate','library'), errors=[], checks=[];
async function launch() {
  const app=await electron.launch({executablePath:packaged?path.join(root,'release','win-unpacked','StykAnimate.exe'):undefined,args:packaged?[]:[root],cwd:root,timeout:45000,env:{...process.env,STYK_LIBRARY_DIR:library,STYK_USER_DATA_DIR:path.join(run,`profile-${Date.now()}`),STYK_DEBUG:'1'}});
  const page=await app.firstWindow(); page.on('pageerror',e=>errors.push(e.message)); await page.waitForFunction(()=>window.styk?.ready,{timeout:30000});
  return {app,page};
}
let current;
async function close() { if (!current) return; await current.app.evaluate(({app})=>{app.exit(0);}).catch(()=>{}); current=null; }
async function settled(page) { await page.waitForFunction(()=>!window.styk.library.busy); const error=await page.locator('.library-message').getAttribute('data-error'); if(error==='true')throw new Error(await page.locator('.library-message').innerText()); }
try {
  current=await launch(); let {page}=current;
  await page.getByRole('tab',{name:'Library',exact:true}).click(); await page.waitForFunction(()=>window.styk.library.root);
  await page.getByRole('button',{name:'New library folder',exact:true}).click(); await page.getByRole('textbox',{name:'Folder name',exact:true}).fill('Characters'); await page.getByRole('button',{name:'Create folder',exact:true}).click();
  await page.locator('[data-library-path="Characters"]').dblclick(); await page.waitForFunction(()=>window.styk.library.folder==='Characters');
  await page.evaluate(()=>window.styk.editor.select(1)); await page.locator('#user-library [data-library-action="save"]').click(); await settled(page);
  await page.waitForSelector('.library-thumbnail img');
  let items=await page.evaluate(()=>window.styk.library.entries); assert.equal(items.length,1); const original=items[0].path;
  assert.ok((await readFile(path.join(library,original))).length>50); assert.ok((await readFile(path.join(library,original+'.png'))).length>100);
  checks.push('native figure and PNG saved to current Documents subfolder');
  await page.locator('.library-card').click(); await page.getByRole('button',{name:'Rename',exact:true}).click(); await page.getByRole('textbox',{name:'Asset name',exact:true}).fill('Blue hero'); await page.getByRole('textbox',{name:'Asset name',exact:true}).press('Enter');
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
  await page.locator('[data-library-path="Characters/Blue hero.stkz"]').click(); await page.getByRole('button',{name:'Move to…',exact:true}).click(); await page.getByRole('button',{name:'Move here',exact:true}).click();
  await page.waitForFunction(()=>!window.styk.library.entries.some(i=>i.name==='Blue hero'));
  await page.locator('.library-breadcrumbs button').first().click(); await page.waitForSelector('[data-library-path="Blue hero.stkz"]');
  await page.getByRole('tab',{name:'Properties',exact:true}).click(); assert.equal(await page.locator('#inspector').isVisible(),true); await page.getByRole('tab',{name:'Library',exact:true}).click();
  checks.push('folder move, search, and Properties/Library switching');
  await page.screenshot({path:path.join(run,'library-root.png')});
  await page.locator('[data-library-path="Characters"]').dblclick(); await page.waitForSelector('[data-library-path="Characters/Walk cycle.stykmov"]'); await page.waitForFunction(()=>[...document.querySelectorAll('.library-thumbnail img')].every(i=>i.complete));
  await page.screenshot({path:path.join(run,'library-assets.png')});
  await close(); current=await launch(); page=current.page;
  await page.getByRole('tab',{name:'Library',exact:true}).click(); await page.waitForSelector('[data-library-path="Blue hero.stkz"]'); await page.waitForSelector('.library-thumbnail img');
  await page.locator('[data-library-path="Blue hero.stkz"]').dblclick(); await settled(page); assert.equal(await page.evaluate(()=>window.styk.editor.selectionFrame.objects.length),4);
  checks.push('library and thumbnails persist through a full desktop restart'); assert.deepEqual(errors,[]);
  const evidence={packaged,run,library,checks,errors}; await writeFile(path.join(run,'evidence.json'),JSON.stringify(evidence,null,2)); console.log(JSON.stringify(evidence,null,2));
} catch(error) { if(current) { await current.page.screenshot({path:path.join(run,'failure.png')}).catch(()=>{}); console.error(await current.page.locator('.library-message').innerText().catch(()=>'')); } throw error; }
finally {await close();}
