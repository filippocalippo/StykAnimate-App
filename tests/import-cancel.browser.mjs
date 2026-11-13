import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
// An import that does not open (docs/PROJECT-TABS.md: a file opens in a tab of its own, so nothing is
// replaced and nothing asks; the one refusal left is the limit of open projects) keeps every open project
// as it was and is recorded as exactly one cancellation. The page is the developer page (src/devtools/early.js), whose
// statistics collector counts file operations without a desktop process (docs/STATISTICS.md, "Files").
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage();await page.addInitScript({path:path.resolve(import.meta.dirname,'../src/devtools/early.js')});await page.goto(process.env.STYK_URL||'http://127.0.0.1:47843');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {emptyDocument}=await import('/src/demo.mjs'),{buildContainerV2}=await import('/tests/support/native-files.mjs');
    const source=emptyDocument();source._styk={...source._styk,format:'StykAnimate',format_version:1};
    window.projectBytes=await buildContainerV2(source,'styk');
    styk.editor.updateProject({fps:31});
    // An untouched new animation gives its place to the next project, so each one is edited before the next opens.
    for(let guard=0;!styk.projects.tabs.full&&guard<20;guard++){await styk.actions.new();styk.editor.updateProject({fps:20+guard});styk.editor.markSaved();}
    styk.editor.updateProject({fps:27});window.beforeImport=styk.editor.report;
    window.open=styk.projects.tabs.items.map(item=>item.id).join();
    window.cancelledImport=styk.importFiles([new File([window.projectBytes],'refused.styk')]);
  });
  const result=await page.evaluate(async()=>({result:await window.cancelledImport,sameDocument:styk.editor.report===window.beforeImport,dirty:styk.editor.dirty,
    sameProjects:styk.projects.tabs.items.map(item=>item.id).join()===window.open,importing:styk.state.importing,
    collecting:styk.stats.on,summary:styk.stats.flush()}));
  assert.equal(result.result,false);assert.ok(result.sameDocument&&result.dirty&&result.sameProjects);assert.equal(result.importing,false);
  assert.ok(result.collecting,'the developer page collects statistics');
  assert.deepEqual(result.summary.files,[{op:'open',format:'styk',ok:0,failed:0,cancelled:1,ms:0}],'one open, counted as cancelled and not as failed');
  assert.equal(result.summary.counts.problems,undefined,'a refused import is not a problem');
  assert.match(await page.locator('#toast').innerText(),/Close a project/);
  console.log('A refused native import preserves every open project and records exactly one cancellation.');
  // Once a project closes, the same file opens beside the others and the edited project keeps its changes.
  const opened=await page.evaluate(async()=>{
    const edited=styk.projects.tabs.activeId;
    await styk.projects.close(styk.projects.tabs.items.find(item=>!item.dirty&&item.session).id);
    const accepted=await styk.importFiles([new File([window.projectBytes],'accepted.styk')]);
    return {accepted,name:styk.editor.name,count:styk.projects.tabs.size,resting:styk.projects.tabs.get(edited).dirty&&styk.projects.tabs.get(edited).session.report===window.beforeImport};
  });
  assert.deepEqual(opened,{accepted:undefined,name:'accepted',count:12,resting:true});
  console.log('With room for it, the file opens beside the edited project.');
}finally{await browser.close();}
