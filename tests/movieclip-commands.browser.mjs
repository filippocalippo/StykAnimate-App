import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const out=path.resolve('artifacts/movieclips');await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1560,height:1000}}),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
/** Opens a titled section of the inspector unless it is open already (its state is remembered). */
async function openSection(id){const toggle=page.locator(`[data-section-toggle="${id}"]`);if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();}
async function select(tick){await page.evaluate(t=>{styk.editor.seek(t);styk.editor.select(window.clipUid);},tick);await page.getByLabel('Movieclip playback',{exact:true}).waitFor();}
try{
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {createDemo}=await import('/src/demo.mjs'),{pageExporter}=await import('/tests/support/page-export.mjs');styk.settingsUI.commit({timelineMode:'advanced'});styk.editor.load(createDemo());styk.editor.select(1);
    // What the scene draws at each tick of the project on show: the engine's vector frames.
    window.drawn=async()=>{const frames=pageExporter({width:640,height:360},{vector:true});try{await frames.load(styk.editor.report);const svgs=[];for(let t=0;t<30;t++)svgs.push(await(await frames.renderSVGTick(t)).text());return svgs;}finally{frames.dispose();}};
    window.before=await drawn();styk.movieclips.open('range');
  });
  await page.locator('.movieclip-dialog input[name=name]').fill('Five frames');
  await page.locator('.movieclip-dialog input[name=end]').fill('5');await page.locator('.movieclip-dialog button[type=submit]').click();
  await page.waitForFunction(()=>styk.editor.figure?.name==='Five frames');await page.evaluate(()=>window.clipUid=styk.editor.selectedUid);
  check('Playback has no Start, End, Restart or Split controls',await page.locator('[data-movieclip-field=start],[data-movieclip-field=end],[data-action=movieclip-restart],[data-action=movieclip-split]').count()===0);
  await page.getByLabel('Scale (%)',{exact:true}).fill('150');await page.getByLabel('Scale (%)',{exact:true}).press('Tab');
  check('Movieclip scale field edits the presence-clocked instance',await page.evaluate(()=>Math.abs(styk.editor.object.scale-1.5)<1e-6));
  await page.getByLabel('Opacity (%)',{exact:true}).fill('50');await page.getByLabel('Opacity (%)',{exact:true}).press('Tab');
  check('Movieclip opacity field edits the presence-clocked instance',await page.evaluate(()=>Math.abs((styk.editor.object.field28??0)-128)<=1));
  await page.getByLabel('Z-index',{exact:true}).fill('3');await page.getByLabel('Z-index',{exact:true}).press('Tab');
  check('Movieclip z-index field edits the presence-clocked instance',await page.evaluate(()=>styk.editor.object._stykZIndex===3));
  await page.getByLabel('Scale (%)',{exact:true}).fill('100');await page.getByLabel('Scale (%)',{exact:true}).press('Tab');
  await page.getByLabel('Opacity (%)',{exact:true}).fill('100');await page.getByLabel('Opacity (%)',{exact:true}).press('Tab');
  await page.getByLabel('Z-index',{exact:true}).fill('0');await page.getByLabel('Z-index',{exact:true}).press('Tab');
  await select(0);await openSection('bake');await page.locator('[data-action=movieclip-break]').click();
  await page.waitForFunction(()=>!styk.editor.figure?._styk?.movieclip);
  const first=await page.evaluate(()=>styk.editor.selectedUid);
  await select(1);await openSection('bake');await page.locator('[data-action=movieclip-break]').click();
  check('Adjacent breaks reuse one ordinary figure track',await page.evaluate(id=>styk.editor.selectedUid===id,first));
  check('Frame breaks use layer poses without figure channels',await page.evaluate(()=>styk.editor.animationChannels.length===0));
  check('Every frame retains the original scene geometry',await page.evaluate(async()=>{const now=await drawn();return before.every((frame,t)=>frame===now[t]);}));
  await page.screenshot({path:path.join(out,'break-apart-poses.png')});
  await select(2);
  check('Clip returns after the two broken frames',await page.evaluate(()=>styk.editor.evaluatedFrame.objects.some(o=>o.unique_id===clipUid)));
  await page.screenshot({path:path.join(out,'frame-gaps.png')});
  const binary=await page.evaluate(async()=>{
    const {DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs'),{ pageEditor }=await import('/tests/support/page-editor.mjs');
    const e=styk.editor,exporter=new DocumentExporter(),importer=new ImportClient(),numbers=svg=>svg.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g).map(Number);
    const phases=editor=>Array.from({length:8},(_,t)=>{editor.seek(t);return editor.evaluatedFrame.objects.filter(o=>o._stykMovieclip).map(o=>[o.unique_id,o._movieclipSample]);});
    try{const expected=phases(e),blob=await exporter.export(e.report,{format:'styk',name:'presence-test'}),result=await importer.importFile(new File([blob],'presence-test.styk')),reopened=pageEditor({demo:false,layerTimeline:true}).load(result.document);const styk=JSON.stringify(phases(reopened))===JSON.stringify(expected);
      // The Pivot file is opened in the project on show, which draws it; the project itself is put back after.
      const geometry=(await drawn()).map(numbers),piv=await exporter.export(e.report,{format:'piv',name:'presence-test',revision:e.revision}),native=await importer.importFile(new File([piv],'presence-test.piv')),original=structuredClone(e.report),selected=e.selectedUid;
      e.load(native.document);const actual=(await drawn()).map(numbers);e.load(original);e.select(selected);
      return {styk,pivot:geometry.every((values,t)=>values.length===actual[t].length&&values.every((value,i)=>Math.abs(value-actual[t][i])<.001))};}
    finally{exporter.dispose();importer.dispose();}
  });
  check('Binary STYK save and reload retain clocks and frame-only replacements',binary.styk);
  check('Pivot worker export and binary reload preserve rendered geometry',binary.pivot);
  await select(2);const duration=await page.evaluate(()=>styk.editor.totalTicks);
  await page.getByLabel('Movieclip speed',{exact:true}).fill('2');await page.getByLabel('Movieclip speed',{exact:true}).press('Tab');
  check('Playback edits leave scene length unchanged',await page.evaluate(()=>styk.editor.totalTicks)===duration);
  await page.getByLabel('Movieclip speed',{exact:true}).fill('1');await page.getByLabel('Movieclip speed',{exact:true}).press('Tab');
  await page.evaluate(async()=>{window.restarted=await drawn();});
  await select(2);await openSection('bake');await page.locator('[data-action=movieclip-bake]').click();
  await page.waitForFunction(()=>styk.editor._undo.at(-1)?.label==='Bake animation');
  check('Bake button preserves previous breaks and every scene frame',await page.evaluate(async()=>{const now=await drawn();return restarted.every((frame,t)=>frame===now[t]);}));
  await page.evaluate(()=>styk.settingsUI.commit({timelineMode:'simple'}));
  check('Simple uses exactly the same baked poses',await page.evaluate(async()=>{const now=await drawn();return restarted.every((frame,t)=>frame===now[t]);}));
  await page.screenshot({path:path.join(out,'baked-simple.png')});
  await page.evaluate(()=>styk.settingsUI.commit({timelineMode:'advanced'}));
  check('Switching back retains timing and geometry',await page.evaluate(async()=>{const now=await drawn();return restarted.every((frame,t)=>frame===now[t]);}));
  await page.evaluate(async()=>{
    const {createDemo}=await import('/src/demo.mjs');styk.editor.load(createDemo());styk.settingsUI.commit({timelineMode:'simple'});
    styk.editor.select(1);styk.movieclips.open('selection');
  });
  await page.locator('.movieclip-dialog input[name=name]').fill('Simple clip');await page.locator('.movieclip-dialog button[type=submit]').click();
  await page.waitForFunction(()=>styk.editor.figure?.name==='Simple clip');
  const beforeAdd=await page.evaluate(()=>({duration:styk.editor.totalTicks,tick:styk.editor.tick,uid:styk.editor.selectedUid}));
  await page.getByRole('button',{name:/^Add frame$/i}).click();
  check('Simple Add button carries the same clip into the added frame',await page.evaluate(before=>{
    const e=styk.editor,o=e.evaluatedFrame.objects.find(o=>o.unique_id===before.uid);return o&&o._stykMovieclip.clock==='presence'&&o._stykMovieclip.end===undefined&&e.totalTicks===before.duration+1&&e.tick>before.tick;
  },beforeAdd));
  await page.evaluate(()=>styk.settingsUI.commit({timelineMode:'advanced'}));
  check('The added Simple clip remains visible in Advanced',await page.evaluate(async()=>styk.editor.evaluatedFrame.objects.some(o=>o._stykMovieclip)&&(await drawn())[styk.editor.tick].includes('<path')));
  for(const mode of ['simple','advanced']){
    await page.evaluate(async mode=>{
      const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs'),{movieclipFigure}=await import('/src/movieclips.mjs');
      const source=emptyDocument();source.keyframes=Array.from({length:8},(_,t)=>createFrame([createObject(source.figure_types[0],1,200+t*12,250)]));
      const report=emptyDocument();report.figure_types.push(movieclipFigure(2,'Clipboard walk',source,{duration:8,pivot:{x:200,y:250}}));
      report.keyframes=Array.from({length:5},()=>createFrame());
      styk.editor.load(report);styk.settingsUI.commit({timelineMode:mode});styk.editor.seek(0);styk.editor.addFigure(2);window.clipUid=styk.editor.selectedUid;
      styk.state.applyRange=false;styk.fit();
      // The clip's clock at each tick, read from the engine's frame there (the playhead goes back to where it was).
      window.clipPhases=()=>Array.from({length:5},(_,t)=>{const e=styk.editor,tick=e.tick;e.seek(t);const sample=e.evaluatedFrame.objects.find(o=>o.unique_id===clipUid)?._movieclipSample??null;e.seek(tick);return sample;});
    },mode);
    // Keep canvas shortcuts out of the timeline's separate frame clipboard.
    await page.locator('#viewport').focus();await page.keyboard.press('Control+c');
    await page.waitForFunction(()=>styk.editor._selectionClipboard?.objects[0]?.unique_id===clipUid);
    for(let tick=1;tick<5;tick++){
      await page.evaluate(t=>styk.editor.seek(t),tick);await page.locator('#viewport').focus();await page.keyboard.press('Control+v');
      await page.waitForFunction(t=>styk.editor.tick===t&&styk.editor.evaluatedFrame.objects.some(o=>o.unique_id===clipUid),tick);
      check(`${mode}: canvas paste on frame ${tick+1} keeps the original ID`,await page.evaluate(()=>styk.editor.selectedUid===clipUid&&styk.editor.object.root_x===styk.editor.report.canvas_width/2));
    }
    check(`${mode}: five appearances advance one clock`,await page.evaluate(()=>JSON.stringify(clipPhases())==='[0,1,2,3,4]'&&styk.editor.totalTicks===5));
    await select(2);await page.locator('#viewport').focus();await page.keyboard.press('Delete');
    await page.waitForFunction(()=>clipPhases()[2]===null);
    check(`${mode}: Delete removes only frame 3 and pauses one step`,await page.evaluate(()=>JSON.stringify(clipPhases())==='[0,1,null,2,3]'&&styk.editor.totalTicks===5));
    await page.keyboard.press('Control+z');await page.waitForFunction(()=>clipPhases()[2]===2);
    await page.keyboard.press('Control+y');await page.waitForFunction(()=>clipPhases()[2]===null);
    await page.keyboard.press('Control+v');await page.waitForFunction(()=>clipPhases()[2]===2);
    check(`${mode}: undo, redo and pasting back restore the same instance`,await page.evaluate(()=>JSON.stringify(clipPhases())==='[0,1,2,3,4]'&&styk.editor.selectedUid===clipUid));
    await page.keyboard.press('Control+v');await page.waitForFunction(()=>styk.editor._selectionClipboard.pastes===6);
    check(`${mode}: repeated paste creates an independent instance`,await page.evaluate(()=>styk.editor.evaluatedFrame.objects.length===2&&styk.editor.selectedUid!==clipUid&&new Set(styk.editor.evaluatedFrame.objects.map(o=>o.unique_id)).size===2));
    await page.locator('#viewport').focus();await page.keyboard.press('Control+z');await page.waitForFunction(()=>styk.editor.evaluatedFrame.objects.length===1);
    await page.evaluate(()=>styk.editor.select(clipUid));
    await page.locator('[data-action=movieclip-unique]').click();
    await page.waitForFunction(()=>styk.editor.selectedUid!==clipUid&&Boolean(styk.editor.figure?._styk?.movieclip));
    check(`${mode}: Make unique gives this frame an independent ID without changing its pose`,await page.evaluate(()=>styk.editor.object._movieclipSample===2&&JSON.stringify(clipPhases())==='[0,1,null,3,4]'));
    await page.screenshot({path:path.join(out,`clipboard-${mode}.png`)});
    const roundtrip=await page.evaluate(async()=>{
      const {DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs');
      const e=styk.editor,exporter=new DocumentExporter(),importer=new ImportClient(),uid=e.selectedUid,expected=clipPhases();
      try{const blob=await exporter.export(e.report,{format:'styk',name:'clipboard-fix'}),loaded=await importer.importFile(new File([blob],'clipboard-fix.styk'));e.load(loaded.document);e.seek(2);e.select(uid);return JSON.stringify(clipPhases())===JSON.stringify(expected)&&e.object._movieclipSample===2;}
      finally{exporter.dispose();importer.dispose();}
    });
    check(`${mode}: binary STYK reload preserves copied and unique identities`,roundtrip);
  }
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs'),{movieclipFigure}=await import('/src/movieclips.mjs');
    const source=emptyDocument();
    source.keyframes=[createFrame([createObject(source.figure_types[0],11,200,250),createObject(source.figure_types[0],12,200,200,{join:{target_object_slot:0,target_handle_id:1}})])];
    const report=emptyDocument();report.figure_types.push(movieclipFigure(2,'Joined clip',source,{duration:1,pivot:{x:200,y:250}}));
    report.keyframes=Array.from({length:3},()=>createFrame());
    styk.editor.load(report);styk.settingsUI.commit({timelineMode:'advanced'});styk.editor.seek(0);styk.editor.addFigure(2);window.clipUid=styk.editor.selectedUid;
  });
  await select(0);await openSection('bake');await page.locator('[data-action=movieclip-break]').click();
  await page.waitForFunction(()=>!styk.editor.figure?._styk?.movieclip);
  check('Break apart preserves joins between expanded figures',await page.evaluate(()=>{
    const objects=styk.editor.evaluatedFrame.objects,joined=objects.filter(o=>o.join),uids=new Set(objects.map(o=>o.unique_id));
    return joined.length===1&&joined.every(o=>uids.has(o.join.target_unique_id)&&objects[o.join.target_object_slot]?.unique_id===o.join.target_unique_id);
  }));
  check('No browser errors',errors.length===0);
}catch(error){await page.screenshot({path:path.join(out,'commands-failure.png')});throw error;}
finally{await writeFile(path.join(out,'commands-results.json'),JSON.stringify({checks,errors},null,2));await browser.close();}
