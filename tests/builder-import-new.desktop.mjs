import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd(), output=path.join(root,'artifacts/builder-import-new');
await mkdir(output,{recursive:true});
const profile=path.join(output,`profile-${Date.now()}`);await mkdir(profile,{recursive:true});
await writeFile(path.join(profile,'telemetry-state.json'),JSON.stringify({decided:true,consent:{analytics:false,diagnostics:false,policyVersion:'2026-09-10',updatedAt:Date.now()}}));
const executablePath=process.env.STYK_PACKAGED_EXECUTABLE;
const application=await electron.launch({...(executablePath?{executablePath}:{}),args:executablePath?[]:[root],cwd:root,env:{...process.env,STYK_USER_DATA_DIR:profile}});
const checks=[],errors=[];
try {
  const page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>window.styk?.ready);
  await page.locator('.release-splash[open]').waitFor({timeout:10000});
  await page.evaluate(()=>{for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();});
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const report=emptyDocument(),figure=report.figure_types[0];figure.name='Posed multicolour figure';
    for(const segment of figure.segments){segment.is_static=false;segment.flag_bits={is_static:false};}
    const object=createObject(figure,1,220,220,{
      angles:figure.segments.map((s,i)=>s.angle_rad+.15*(i+1)),
      len_flag:1,lengths:figure.segments.map((s,i)=>s.length*(1+i/10)),
      bend_flag:1,bends:figure.segments.map((s,i)=>i/100),scale:1.2,
      _stykStyle:{segments:{'1':{color:0x466428,thickness:15},'4':{color:0xf0dc46,thickness:18}}},
    });
    report.keyframes=[createFrame([object,createObject(figure,2,500,220)],5)];
    styk.editor.load(report,'Builder import regression');styk.editor.select(1);styk.editor.markSaved();styk.fit();
    window.captureFigure=uid=>styk.editor._shown.figureDocument({figureUid:uid,tick:styk.editor.tick});
    window.originalFigures=[captureFigure(1),captureFigure(2)];
  });
  await page.locator('[data-workspace-mode="rig"]').click();
  await page.evaluate(()=>{styk.editor.select(1,3);styk.editor.deleteSingleSegment();window.editedFigure=captureFigure(1);});
  await page.screenshot({path:path.join(output,'edited-before-import.png')});
  await page.locator('#builder-done').click();
  await page.locator('#builder-exit-import-new').click();
  await page.waitForFunction(()=>!styk.state.builderActive);
  const result=await page.evaluate(()=>{
    const editor=styk.editor,uid=editor.selectedUid,created=captureFigure(uid),expected=editedFigure.keyframes[0].objects[0];
    const fields=['angles','lengths','bends','len_flag','bend_flag','scale','_stykStyle'];
    return {uid,originals:[captureFigure(1),captureFigure(2)],baseline:originalFigures,
      actual:Object.fromEntries(fields.map(k=>[k,created.keyframes[0].objects[0][k]])),
      expected:Object.fromEntries(fields.map(k=>[k,expected[k]])),document:editor.serialize()};
  });
  assert.notEqual(result.uid,1);assert.notEqual(result.uid,2);
  assert.deepEqual(result.actual,result.expected);assert.deepEqual(result.originals,result.baseline);
  checks.push('Actual builder exit preserves edited pose, paint and both original instances');
  await page.screenshot({path:path.join(output,'imported-result.png')});
  await page.evaluate(()=>{styk.editor.undo();styk.editor.redo();});
  await page.waitForFunction(()=>!styk.state.dirtyRender);
  assert.deepEqual(await page.evaluate(()=>[captureFigure(1),captureFigure(2)]),result.baseline);
  checks.push('Undo and redo retain original instances');
  await page.evaluate(document=>{styk.editor.load(document,'Saved builder result');},result.document);
  await page.waitForFunction(()=>!styk.state.dirtyRender);
  assert.deepEqual(await page.evaluate(()=>[captureFigure(1),captureFigure(2)]),result.baseline);
  const restored=await page.evaluate(uid=>captureFigure(uid),result.uid);
  for(const key of Object.keys(result.expected))assert.deepEqual(restored.keyframes[0].objects[0][key],result.expected[key]);
  checks.push('Saved document reload preserves the new and original figures');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors},null,2));
  console.log(JSON.stringify({checks,errors}));
} finally {await application.close();}
