/** Native builder buttons/keyboard plus selected styled native export in the real app. */
import {chromium} from 'playwright';
import {createRequire} from 'node:module';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const appRoot = fileURLToPath(new URL('..', import.meta.url)), out = path.join(appRoot, 'artifacts');
const {startBackend} = createRequire(import.meta.url)('../desktop/backend.cjs');
await mkdir(out, {recursive: true}); const backend = await startBackend({appRoot});
const checks = [], errors = []; let browser, page;
const near = (a,b) => assert.ok(Math.abs(a-b) < .001, `${a} != ${b}`);
try {
  browser = await chromium.launch({channel:'chrome',headless:true}); page = await browser.newPage({viewport:{width:1500,height:1020},acceptDownloads:true});
  page.setDefaultTimeout(15000); page.on('pageerror',error=>errors.push(error.stack||error.message));
  await page.goto(backend.origin); await page.waitForFunction(()=>styk?.ready);
  await page.evaluate(async()=>{
    const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'), report=emptyDocument(), figure=report.figure_types[0], base=figure.segments[0];
    report.canvas_width=800; report.canvas_height=450; figure.name='Builder verification';
    figure.segments=[{...base,segment_id:11,parent_id:0,length:90,angle_rad:-.35,bend_rad:.2},
      {...base,segment_id:22,parent_id:11,length:70,angle_rad:1.2,bend_rad:.3},
      {...base,segment_id:33,parent_id:22,length:60,angle_rad:.4,bend_rad:0},
      {...base,segment_id:44,parent_id:0,length:70,angle_rad:2.2,bend_rad:0}];
    figure.segments[0].secondary={rgb:[255,40,80],a:0};
    figure.segment_decode={global_style:{u28:1073741824,outline_thickness:2,rgb:[30,40,50],u30:0}};
    report.keyframes=[0,1].map(i=>createFrame([createObject(figure,1,220+i*25,210,{angles:figure.segments.map(s=>s.angle_rad+i*.3)}),
      createObject(figure,2,540,240,{scale:.6})],i?1:4));
    styk.editor.load(report,'Builder UI'); styk.editor.select(1,0); styk.fit();
  });
  const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.locator('[data-tool="rig"]').click(); await settle();
  const snapshot=()=>page.evaluate(async()=>{
    const {buildGeometry}=await import('/src/pivot/geometry.mjs'), e=styk.editor;
    return {report:e.serialize(),history:e._undo.length,frames:e.report.keyframes.map(frame=>Object.fromEntries(buildGeometry(e.report,frame).objects.get(0).joints)),
      ids:e.figure.segments.map(s=>s.segment_id)};
  });
  async function undo(before) {
    await page.evaluate(()=>document.activeElement?.blur()); await page.keyboard.press('Control+z'); await settle();
    assert.deepEqual((await snapshot()).report,before.report); assert.equal((await snapshot()).history,before.history);
  }
  async function selectJoint(){
    const p=await page.evaluate(()=>{const joint=styk.editor.geometry.objects.get(0).joints.get(11),r=document.querySelector('#viewport').getBoundingClientRect(),v=styk.state.view;return{x:r.left+v.x+joint.x*v.scale,y:r.top+v.y+joint.y*v.scale};});
    await page.mouse.click(p.x,p.y); await settle(); assert.equal(await page.evaluate(()=>styk.editor.selectedJoint),0);
  }
  async function operation(name,action,verify){await selectJoint();const before=await snapshot();await action();await settle();const after=await snapshot();assert.equal(after.history,before.history+1,name);verify(after,before);await undo(before);checks.push(name);console.log('PASS',name);}
  const retained=(after,before)=>{assert.deepEqual(after.ids,[22,33,44]);for(let i=0;i<2;i++)for(const id of[0,22,33,44]){near(after.frames[i][id].x,before.frames[i][id].x);near(after.frames[i][id].y,before.frames[i][id].y);}};
  const deleted=(after,before)=>{assert.deepEqual(after.ids,[22,33,44]);for(let i=0;i<2;i++)for(const id of[22,33]){near(after.frames[i][id].x,before.frames[i][id].x+before.frames[i][0].x-before.frames[i][11].x);near(after.frames[i][id].y,before.frames[i][id].y+before.frames[i][0].y-before.frames[i][11].y);}};
  await operation('Inspector Delete removes one segment and reconnects its children',()=>page.locator('#inspector [data-action="delete-single-segment"]').click(),deleted);
  await operation('Inspector Unsplit keeps every surviving joint fixed',()=>page.locator('#inspector [data-action="unsplit-segment"]').click(),retained);
  for(const [action,axis,branch]of[['mirror-segment','horizontal',false],['mirror-segment-vertical','vertical',false],['mirror-branch','horizontal',true],['mirror-branch-vertical','vertical',true]]){
    await operation(`Inspector ${action} uses the selected parent pivot`,()=>page.locator(`#inspector [data-action="${action}"]`).click(),(after,before)=>{
      for(let i=0;i<2;i++)for(const id of[11,22,33]){
        const a=after.frames[i],b=before.frames[i],expected=branch||id===11?{x:axis==='horizontal'?2*b[0].x-b[id].x:b[id].x,y:axis==='vertical'?2*b[0].y-b[id].y:b[id].y}:
          {x:b[id].x+a[11].x-b[11].x,y:b[id].y+a[11].y-b[11].y};near(a[id].x,expected.x);near(a[id].y,expected.y);
      }
    });
  }
  await operation('Rig Delete key removes one segment',()=>page.keyboard.press('Delete'),deleted);
  await operation('Rig Ctrl Delete removes the joint while preserving endpoints',()=>page.keyboard.press('Control+Delete'),retained);
  await operation('Rig Shift Delete removes only the chosen branch',()=>page.keyboard.press('Shift+Delete'),after=>assert.deepEqual(after.ids,[44]));
  await page.evaluate(()=>{
    styk.editor.addAnimationKeys([
      {target:{kind:'segment',uid:1,handleId:11},property:'opacity',tick:0,value:1},
      {target:{kind:'segment',uid:1,handleId:11},property:'opacity',tick:4,value:.2},
      {target:{kind:'segment',uid:1,handleId:11},property:'gradientOpacity',tick:0,value:1},
      {target:{kind:'segment',uid:1,handleId:11},property:'gradientOpacity',tick:4,value:.4},
      {target:{kind:'figure',uid:1},property:'outlineOpacity',tick:0,value:1},
      {target:{kind:'figure',uid:1},property:'outlineOpacity',tick:4,value:.6},
    ]);styk.editor.seek(4);styk.editor.select(1,0);
  });await settle();
  for(const kind of['stk','piv']){
    await page.locator('[data-action="export"]').first().click();
    const downloading=page.waitForEvent('download');await page.locator(`[data-action="export-${kind}"]`).click();
    await(await downloading).saveAs(path.join(out,`builder-style-ui.${kind}`));
    const bytes=Array.from(await readFile(path.join(out,`builder-style-ui.${kind}`)));
    const values=await page.evaluate(async ({kind,bytes})=>{
      const{ImportClient}=await import('/src/import-client.mjs'),{buildGeometry}=await import('/src/pivot/geometry.mjs');
      const{document:report}=await new ImportClient().importFile(new File([new Uint8Array(bytes)],`builder-style-ui.${kind}`));
      const figure=kind==='stk'?report.figure_types.find(f=>f.segments.some(s=>s.transparency===204)):buildGeometry(report,report.keyframes[4]).objects.get(0).fig;
      return {primary:figure?.segments[0].transparency,secondary:figure?.segments[0].secondary?.a,outline:figure?.segment_decode?.global_style?.u30,count:report.keyframes.length};
    },{kind,bytes});
    assert.equal(values.primary,204);assert.equal(values.secondary,153);assert.equal(values.outline,102);if(kind==='piv')assert.equal(values.count,5);
    checks.push(`Actual ${kind.toUpperCase()} menu exports the selected instance’s current animated style`);console.log('PASS',checks.at(-1));
  }
  assert.deepEqual(errors,[]);await page.screenshot({path:path.join(out,'builder-topology-app.png')});
  await writeFile(path.join(out,'builder-topology-app.json'),JSON.stringify({checks,errors},null,2));
}catch(error){await page?.screenshot({path:path.join(out,'builder-topology-app-failure.png')}).catch(()=>{});await writeFile(path.join(out,'builder-topology-app.json'),JSON.stringify({checks,errors,failure:error.stack},null,2));throw error;}
finally{await browser?.close();backend.stop();}
