/** Actual property/track interactions for one UID reused by different rigs. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import backend from '../desktop/backend.cjs';
const appRoot=fileURLToPath(new URL('..',import.meta.url)),out=new URL('../artifacts/mixed-rig-scope/',import.meta.url);
await mkdir(out,{recursive:true});const server=await backend.startBackend({appRoot});let browser;
const checks=[],errors=[],check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
try{
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1560,height:1000}});
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.goto(server.origin);await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(()=>styk.settingsUI.open('interface'));
  await page.locator('.styk-settings [data-setting="timelineMode"][value="advanced"]').check();
  await page.locator('.styk-settings-head button').click();await settle();
  await page.evaluate(async()=>{
    const {emptyDocument,defaultFigure,createObject,createFrame}=await import('/src/demo.mjs'),report=emptyDocument();
    report.canvas_width=640;report.canvas_height=360;report.figure_types.push(defaultFigure(2));
    for(const [index,figure] of report.figure_types.entries()){
      figure.name=index?'Rig B':'Rig A';const base=figure.segments[0];
      figure.segments=[{...base,segment_id:1,parent_id:0,length:index?95:72,angle_rad:index?.25:-.7,thickness:16,
        color_rgb:index?[50,165,210]:[230,70,110],flags:base.flags|512,secondary:{rgb:[70,205,135],a:40}}];figure.segment_count=1;
    }
    report.keyframes=[1,2,1].map((id,index)=>createFrame([createObject(report.figure_types[id-1],7,170+index*30,230),
      createObject(report.figure_types[0],8,450,245)],index===2?1:5));
    const e=styk.editor;e.load(report,'Mixed rig style tracks');
    e.addAnimationKeys(['opacity','gradientOpacity'].flatMap(property=>[0,10].map((tick,index)=>({
      target:{kind:'segment',uid:7,handleId:1},property,tick,value:property==='opacity'?(index?.8:.2):(index?.2:.8)}))));
    e.select(7,0);e.setOrigin(1);e.seek(0);e.select(7,0);styk.fit();
    window.scopeTest={a:{kind:'segment',uid:7,handleId:1,figureTypeId:1},b:{kind:'segment',uid:7,handleId:1,figureTypeId:2}};
  });await settle();
  const scrollTo=async id=>{await page.evaluate(id=>{const t=styk.timeline,index=t.tracks.findIndex(row=>row.id===id);
    if(index<0)throw Error('Missing track '+id);t.scroll.scrollTop=Math.max(0,index*30-30);},id);await settle();};
  const row=id=>page.locator(`.styk-timeline-label:not([hidden])[data-track-id="${id}"]`);
  const expand=async id=>{await scrollTo(id);if(!await page.evaluate(id=>styk.timeline.expandedTracks.has(id),id)){
    await row(id).locator('.styk-timeline-label-disclosure').click();await settle();}};
  const click=async id=>{await scrollTo(id);await row(id).locator('.styk-timeline-label-select').click();await settle();};
  await expand('layer-1');await expand('figure:7');await expand('segment:7:1@1');await expand('segment:7:1@2');
  const tracks=await page.evaluate(()=>Object.fromEntries(['a','b'].map(key=>[key,styk.timeline.tracks.find(row=>row.kind==='channel'&&
    row.property==='opacity'&&row.target?.figureTypeId===scopeTest[key].figureTypeId&&row.target.uid===7).id])));
  const snapshot=()=>page.evaluate(()=>({uid:styk.editor.selectedUid,joint:styk.editor.selectedJoint,type:styk.editor.object?.figure_type_id,
    row:styk.timeline.selectedTrackId,stateRow:styk.state.selectedTrackId,context:styk.state.inspectorContext,tab:styk.state.inspectorTab,
    channels:structuredClone(styk.editor.animationChannels),history:styk.editor._undo.length}));
  const scoped=(value,id)=>value.channels.find(channel=>channel.target.figureTypeId===id&&channel.property==='opacity');
  const field=page.locator('#inspector [data-property="segment_opacity"]'),add=page.locator('[data-track-action="addTrackKey"]');
  await click(tracks.a);let before=await snapshot();
  check('A row selects its matching figure and handle',before.uid===7&&before.joint===0&&before.type===1&&before.row===tracks.a&&before.stateRow===tracks.a);
  await field.fill('35');await field.press('Enter');await settle();let after=await snapshot();
  check('A inspector edit changes only A scoped curve',scoped(after,1).keys.find(key=>key.tick===0).value===.35&&JSON.stringify(scoped(after,2))===JSON.stringify(scoped(before,2))&&after.history===before.history+1);
  await page.evaluate(()=>styk.editor.seek(2));await settle();await add.click();await settle();after=await snapshot();
  check('Toolbar inserts only the exact A property',scoped(after,1).keys.some(key=>key.tick===2)&&!scoped(after,2).keys.some(key=>key.tick===2));
  await page.screenshot({path:fileURLToPath(new URL('active-a.png',out))});
  await page.evaluate(()=>styk.editor.seek(6));await settle();after=await snapshot();
  check('Seek into B preserves dormant A row and clears figure selection',after.uid===null&&after.row===tracks.a&&after.stateRow===tracks.a&&after.tab==='animation');
  check('Dormant A cannot insert a key or expose a figure pose field',await add.isDisabled()&&await field.count()===0);
  const dormant=await snapshot();await page.locator('[data-track-action="trackMenu"]').click();
  check('Dormant context-menu insertion is disabled',await page.getByRole('menuitem',{name:'Insert key at playhead',exact:true}).isDisabled());
  await page.getByRole('menuitem',{name:'Move selected keys…',exact:true}).click();
  await page.locator('.styk-timeline-dialog input[type="number"]').fill('4');await page.locator('.styk-timeline-dialog button[type="submit"]').click();await settle();
  after=await snapshot();check('Existing dormant A key moves without touching B',scoped(after,1).keys.some(key=>key.tick===3)&&!scoped(after,1).keys.some(key=>key.tick===2)&&
    JSON.stringify(scoped(after,2))===JSON.stringify(scoped(dormant,2))&&after.history===dormant.history+1);
  await page.keyboard.press('Control+z');await settle();after=await snapshot();
  check('Dormant key move undoes exactly',JSON.stringify(after.channels)===JSON.stringify(dormant.channels));
  await page.screenshot({path:fileURLToPath(new URL('dormant-a.png',out))});
  await page.evaluate(()=>styk.editor.seek(6));await settle();await click(tracks.b);before=await snapshot();
  await field.fill('65');await field.press('Enter');await settle();after=await snapshot();
  check('B inspector edits its own scope despite reused UID and handle',after.type===2&&scoped(after,2).keys.find(key=>key.tick===6).value===.65&&
    JSON.stringify(scoped(after,1))===JSON.stringify(scoped(before,1)));
  await page.screenshot({path:fileURLToPath(new URL('active-b.png',out))});
  await page.evaluate(()=>styk.editor.seek(0));await settle();check('B becomes dormant on return to A',(await snapshot()).uid===null);
  await page.evaluate(()=>styk.editor.seek(6));await settle();after=await snapshot();
  check('Returning to the matching rig restores its scoped handle',after.uid===7&&after.type===2&&after.joint===0&&after.row===tracks.b&&after.tab==='design');
  const other=await page.evaluate(()=>{const e=styk.editor,g=[...e.geometry.objects.values()].find(g=>g.obj.unique_id===8),s=g.segments[0],v=styk.state.view,r=document.querySelector('#viewport').getBoundingClientRect();
    return {x:r.x+v.x+(s.start.x+s.end.x)/2*v.scale,y:r.y+v.y+(s.start.y+s.end.y)/2*v.scale};});
  await page.mouse.click(other.x,other.y);await settle();check('Canvas selection replaces the scoped track binding',(await snapshot()).uid===8);
  await page.evaluate(()=>styk.editor.seek(0));await settle();check('Seeking does not revive an abandoned scoped selection',(await snapshot()).uid===8);
  await page.evaluate(()=>styk.editor.addAnimationKeys([0,10].map((tick,index)=>({target:{kind:'segment',uid:7,handleId:1},
    property:'opacity',tick,value:index?.7:.9,exactTarget:true}))));await settle();
  await expand('segment:7:1');const globalRow=await page.evaluate(()=>styk.timeline.tracks.find(row=>row.kind==='channel'&&row.property==='opacity'&&
    row.target.kind==='segment'&&row.target.uid===7&&row.target.figureTypeId===undefined).id);
  await click(globalRow);before=await snapshot();
  check('Persisted global row displays its own curve despite scoped override',Math.abs(Number(await field.inputValue())-90)<.0001);
  await field.fill('55');await field.press('Enter');await settle();after=await snapshot();
  const globalChannel=value=>value.channels.find(channel=>channel.target.kind==='segment'&&channel.target.uid===7&&
    channel.target.figureTypeId===undefined&&channel.property==='opacity');
  check('Global inspector edits keep both rig-specific curves unchanged',globalChannel(after).keys.find(key=>key.tick===0).value===.55&&
    JSON.stringify(scoped(after,1))===JSON.stringify(scoped(before,1))&&JSON.stringify(scoped(after,2))===JSON.stringify(scoped(before,2)));
  await page.evaluate(()=>styk.editor.seek(4));await settle();await add.click();await settle();after=await snapshot();
  check('Global toolbar samples and inserts in its own persisted channel',globalChannel(after).keys.some(key=>key.tick===4)&&
    !scoped(after,1).keys.some(key=>key.tick===4)&&!scoped(after,2).keys.some(key=>key.tick===4));
  await page.evaluate(()=>styk.timeline.scroll.focus());await page.keyboard.press('Control+c');
  check('Global property key is copied with its exact target',await page.evaluate(()=>styk.timeline._keyClipboard?.entries.some(entry=>entry.tick===4&&entry.target.figureTypeId===undefined)));
  await page.evaluate(()=>styk.editor.seek(8));await settle();
  await page.evaluate(()=>styk.timeline.scroll.focus());await page.keyboard.press('Control+v');await settle();after=await snapshot();
  check('Property clipboard retains global target instead of the displayed rig scope',globalChannel(after).keys.some(key=>key.tick===8)&&
    !scoped(after,1).keys.some(key=>key.tick===8)&&!scoped(after,2).keys.some(key=>key.tick===8));
  const pasted=JSON.stringify(after.channels);await page.keyboard.press('Control+z');await settle();
  check('Global key paste undo removes only the pasted global key',!(globalChannel(await snapshot()).keys.some(key=>key.tick===8)));
  await page.keyboard.press('Control+Shift+z');await settle();check('Global key paste redo preserves exact channel identities',JSON.stringify((await snapshot()).channels)===pasted);
  await page.screenshot({path:fileURLToPath(new URL('global-and-scoped.png',out))});
  const native=await page.evaluate(async()=>{
    const [{DocumentExporter},{ImportClient},{evaluatedFrame,timeline},{resolveInstanceFigure}]=await Promise.all([
      import('/src/document-export.mjs'),import('/src/import-client.mjs'),import('/src/pivot/geometry.mjs'),import('/src/animation-style.mjs')]);
    const source=styk.editor.serialize(),exporter=new DocumentExporter(),importer=new ImportClient();
    const sample=(report,tick)=>{const rows=timeline(report);let index=0;while(index+1<rows.length&&rows[index+1].start<=tick)index++;
      const frame=evaluatedFrame(report,index,rows[index].count?(tick-rows[index].start)/rows[index].count:0,tick);
      return frame.objects.map(object=>{const figure=resolveInstanceFigure(report.figure_types.find(figure=>figure.figure_type_id===object.figure_type_id),object),s=figure.segments[0];
        return {uid:object.unique_id,alpha:s.transparency,gradient:s.secondary?.a,color:s.color_rgb,root:[object.root_x,object.root_y],angles:object.angles};});};
    const outputs=[];
    try{for(const format of ['styk','piv']){
      const blob=await exporter.export(source,{format,name:'Mixed scopes'}),result=await importer.importFile(new File([blob],`scopes.${format}`));
      if(format==='styk'&&JSON.stringify(result.document._styk.animation)!==JSON.stringify(source._styk.animation))throw Error('Editable scope curves changed');
      for(let tick=0;tick<11;tick++){
        const actual=sample(result.document,tick),expected=sample(source,tick);
        for(let i=0;i<expected.length;i++){
          if(actual[i].uid!==expected[i].uid||actual[i].alpha!==expected[i].alpha||actual[i].gradient!==expected[i].gradient||JSON.stringify(actual[i].color)!==JSON.stringify(expected[i].color))throw Error(`${format} style mismatch at ${tick}`);
          for(let j=0;j<2;j++)if(Math.abs(actual[i].root[j]-expected[i].root[j])>.0002)throw Error(`${format} origin mismatch at ${tick}`);
          for(let j=0;j<expected[i].angles.length;j++)if(Math.abs(actual[i].angles[j]-expected[i].angles[j])>.00001)throw Error(`${format} pose mismatch at ${tick}`);
        }
      }
      outputs.push({format,bytes:blob.size,verifiedTicks:11});
    }}finally{exporter.dispose();importer.dispose();}return outputs;
  });
  check('STYK retains scopes and native PIV preserves each rendered pose and style',native.length===2);
  check('No browser errors',errors.length===0);await writeFile(new URL('report.json',out),JSON.stringify({checks,errors,tracks,exports:native},null,2));
}catch(error){await writeFile(new URL('report.json',out),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}
finally{await browser?.close();server.stop?.();}
