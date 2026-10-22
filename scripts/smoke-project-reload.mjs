import {_electron as electron} from '../tests/support/playwright.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {buildContainerV2} from '../src/native-container.mjs';
const root=process.cwd(),out=path.join(root,'artifacts',`reload-${Date.now()}`),profile=path.join(out,'profile'),file=path.join(out,'Reload.styk');
await mkdir(profile,{recursive:true});
await writeFile(path.join(profile,'telemetry-state.json'),JSON.stringify({decided:true,consent:{analytics:false,diagnostics:false,policyVersion:'2026-09-10',updatedAt:Date.now()}}));
async function write(fps){const d=emptyDocument();d.fps=fps;d.keyframes=[createFrame([createObject(d.figure_types[0],1,480,280)])];await writeFile(file,await buildContainerV2(d,'styk'));}
await write(24);
const app=await electron.launch({args:[root],cwd:root,timeout:60000,env:{...process.env,STYK_USER_DATA_DIR:profile,STYK_STARTUP_VIEW:'editor'}});
try{
 const page=await app.firstWindow();await page.waitForFunction(()=>window.styk?.ready,null,{timeout:60000});
 for(const sel of ['.styk-privacy [data-decline]','.release-splash [aria-label="Close welcome screen"]'])await page.locator(sel).click({timeout:1000}).catch(()=>{});
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
 await page.evaluate(()=>styk.editor.setFPS(20));
 await page.evaluate(()=>styk.actions.open());
 assert.equal(await page.evaluate(()=>styk.projects.tabs.size),2);
 assert.equal(await page.evaluate(()=>styk.ui.commands.get("reload-project").label),"Reload from disk");
 const before=await page.evaluate(()=>({id:styk.projects.tabs.activeId,count:styk.projects.tabs.size,token:styk.state.documentToken}));
 await write(30);assert.equal(await page.evaluate(()=>styk.actions['reload-project']()),true);
 assert.deepEqual(await page.evaluate(()=>({id:styk.projects.tabs.activeId,count:styk.projects.tabs.size,token:styk.state.documentToken})),before);
 assert.equal(await page.evaluate(()=>styk.editor.report.fps),30);
 await page.evaluate(()=>styk.editor.setFPS(18));await write(36);
 await page.evaluate(()=>{window.reloadResult=styk.actions['reload-project']();});
 await page.locator('#keep-editing').click();assert.equal(await page.evaluate(()=>window.reloadResult),false);assert.equal(await page.evaluate(()=>styk.editor.report.fps),18);
 await page.evaluate(()=>{window.reloadResult=styk.actions['reload-project']();});
 assert.equal(await page.locator('#save-changes').count(),0);await page.locator('#discard-changes').click();assert.equal(await page.evaluate(()=>window.reloadResult),true);assert.equal(await page.evaluate(()=>styk.editor.report.fps),36);
 const other=await page.evaluate(()=>styk.projects.tabs.items.find(item=>item.id!==styk.projects.tabs.activeId).session.report.fps);assert.equal(other,20);
 const valid=await readFile(file);await writeFile(file,'invalid file');
 assert.equal(await page.evaluate(async()=>{try{await styk.actions['reload-project']();return false;}catch{return true;}}),true);
 assert.equal(await page.evaluate(()=>styk.editor.report.fps),36);await writeFile(file,valid);
 await page.evaluate(()=>styk.actions.new());assert.equal(await page.evaluate(()=>styk.actions['reload-project']()),false);
 await page.screenshot({path:path.join(out,'reload.png')});
 console.log('PASS: disk changes load in the same tab and capability; Cancel preserves edits; discard reloads without Save; invalid files preserve document; unsaved projects refuse reload.');
}finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
