import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import backendService from '../desktop/backend.cjs';
const root=path.resolve(import.meta.dirname,'..'),output=path.join(root,'artifacts','builder-aids');
await mkdir(output,{recursive:true});const backend=await backendService.startBackend({appRoot:root});let browser;
const checks=[],check=(value,label)=>{assert.ok(value,label);checks.push(label);};
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));await page.goto(backend.origin);await page.waitForFunction(()=>window.styk?.ready);
 const pixels=await page.evaluate(async()=>{
  const [{createRenderer},{emptyDocument,createObject},{buildGeometry},{drawBuilderHighlight},{exportSVG}]=await Promise.all([import('/src/renderer.mjs'),import('/src/demo.mjs'),import('/src/pivot/geometry.mjs'),import('/src/builder-aids.mjs'),import('/src/svg-export.mjs')]);
  const results=[],check=(v,label)=>{if(!v)throw Error(label);results.push(label);};
  const make=()=>{const c=document.createElement('canvas');c.width=100;c.height=80;return c;},color=(c,x=2,y=2)=>{const copy=make(),ctx=copy.getContext('2d');ctx.drawImage(c,0,0);return [...ctx.getImageData(x,y,1,1).data];};
  const report=emptyDocument();report.canvas_width=100;report.canvas_height=80;const f=report.figure_types[0];
  f.segments=[{...f.segments[0],length:30,angle_rad:0,thickness:10,color_rgb:[240,20,40],transparency:200,secondary:{rgb:[0,255,0],a:80}}];f.segment_count=1;
  const frame=report.keyframes[0];frame.objects=[createObject(f,7,20,40)];frame.object_draw_order=[0];frame.object_draw_order_unique_ids=[7];
  report.backgrounds=[{background_id:1,kind:2,color:0xff123456}];frame.background_id=1;
  const geometry=buildGeometry(report,frame),options={report,frame,geometry,view:{scale:1,x:0,y:0}},before=JSON.stringify(report);
  const gpuCanvas=make(),gpu=await createRenderer(gpuCanvas);gpu.resize(100,80,1);check(gpu.stats.backend==='WebGPU','Actual WebGPU backend');
  const fallbackCanvas=make();fallbackCanvas.getContext('2d');const fallback=await createRenderer(fallbackCanvas);fallback.resize(100,80,1);
  for(const renderer of [gpu,fallback])for(const [value,expected] of [[0xffa0b1c2,[160,177,194,255]],[0,[0,0,0,0]],[undefined,[18,52,86,255]]]){
   renderer.render({...options,editorBackgroundColor:value});if(renderer.device)await renderer.device.queue.onSubmittedWorkDone();
   check(color(renderer===gpu?gpuCanvas:fallbackCanvas).every((v,i)=>Math.abs(v-expected[i])<=1),`${renderer.stats.backend} construction background ${value??'restored'}`);
  }
  const overlay=make(),ctx=overlay.getContext('2d');drawBuilderHighlight(ctx,geometry,{uid:7,jointIndex:0,report,frame,view:options.view});
  check(color(overlay,30,40).join(',')==='0,0,255,255','Selected vector becomes solid blue despite gradient/alpha');
  const invisibleGeometry=buildGeometry({...report,figure_types:[{...f,segments:[{...f.segments[0],thickness:0}]}]},frame);ctx.clearRect(0,0,100,80);
  drawBuilderHighlight(ctx,invisibleGeometry,{uid:7,jointIndex:0,report,frame,view:options.view});check(color(overlay,30,40)[2]>200&&color(overlay,30,44)[3]===0,'Zero-thickness connector gets native 1.5-pixel construction highlight');
  const staticGeometry=buildGeometry({...report,figure_types:[{...f,segments:[{...f.segments[0],is_static:true,aux_code:1,flags:256}]}]},frame);ctx.clearRect(0,0,100,80);
  drawBuilderHighlight(ctx,staticGeometry,{uid:7,jointIndex:0,report,frame,view:options.view});check(color(overlay,30,40).join(',')==='68,68,204,255','Static selected vector uses native dull blue');
  const imageGeometry=buildGeometry({...report,figure_types:[{...f,segments:[{...f.segments[0],segment_type:'image'}]}]},frame);ctx.clearRect(0,0,100,80);
  drawBuilderHighlight(ctx,imageGeometry,{uid:7,jointIndex:0,report,frame,view:options.view,resources:{image(){throw Error('Bitmap recoloring is forbidden.');}}});check(color(overlay,30,44)[3]===0&&color(overlay,30,40)[2]>200,'Sprite highlight draws only its thin anchor line');
  const glyph={svg_path:'M0 0L20 0L20 12L0 12Z'},asset={asset_index:0,normalized_svg_path:'M0 0L20 0L20 12L0 12Z',bounds:{left:0,bottom:12,width:20,height:12},glyphs:[glyph],placements:[{visible:true,glyph_index:0,x:0,y:12}]};
  const textGeometry=buildGeometry({...report,figure_types:[{...f,text_assets:[asset],segments:[{...f.segments[0],segment_type:'text',extra_u16:0}]}]},frame);ctx.clearRect(0,0,100,80);
  drawBuilderHighlight(ctx,textGeometry,{uid:7,jointIndex:0,report,frame,view:options.view});check(color(overlay,30,45).join(',')==='0,0,255,255','Embedded text glyphs use blue silhouette');
  const svg=await exportSVG({...options,editorBackgroundColor:0xffa0b1c2}),url=URL.createObjectURL(svg),image=new Image();image.src=url;await image.decode();const exported=make();exported.getContext('2d').drawImage(image,0,0);URL.revokeObjectURL(url);
  check(color(exported).join(',')==='18,52,86,255','SVG ignores editor-only construction background');check(JSON.stringify(report)===before,'Every aid leaves native document bytes unchanged');
  const incoming=structuredClone(report),incomingFrame=incoming.keyframes[0];
  const prepared=await gpu.prepareInitialScene({report:incoming,frame:incomingFrame,view:options.view,editorBackgroundColor:0xffa0b1c2});
  check(prepared.editorBackgroundColor===0xffa0b1c2,'Initial scene retains requested construction color');
  let rejected=false;try{gpu.activatePreparedScene(prepared,{editorBackgroundColor:0xff000000});}catch{rejected=true;}
  check(rejected&&!prepared.activated,'Changed construction background rejects stale publication');
  rejected=false;try{gpu.activatePreparedScene(prepared,{editorBackgroundColor:undefined});}catch{rejected=true;}
  check(rejected&&!prepared.activated,'Explicitly cleared construction color rejects stale publication');
  const buffer=prepared.stage.shapeBuffer;gpu.activatePreparedScene(prepared);
  gpu.render({report:incoming,frame:incomingFrame,geometry:prepared.geometry,view:options.view,editorBackgroundColor:0xffa0b1c2});await gpu.device.queue.onSubmittedWorkDone();
  check(gpu.shapeBuffer===buffer&&color(gpuCanvas).join(',')==='160,177,194,255','First live render adopts prepared color and GPU buffer without cold rebuild');
  gpu.destroy();fallback.destroy();return results;
 });checks.push(...pixels);
 await page.evaluate(async()=>{const {emptyDocument,defaultFigure}=await import('/src/demo.mjs');const e=window.styk.editor;e.load(emptyDocument());const f=defaultFigure(201);f.segments=f.segments.slice(0,4).map(s=>({...s,is_static:true,aux_code:Number(s.aux_code)|1,flags:Number(s.flags)|256}));f.segment_count=4;e.importFigure(f);e.select(e.selectedUid,2);e.markSaved();window.__aidBefore=JSON.stringify(e.report);window.__aidHistory=e._undo.length;});
 await page.locator('[data-tool="rig"]').click();await page.keyboard.press('F10');
 check(await page.evaluate(()=>window.styk.state.settings.builderShowStaticHandles===false),'Builder F10 toggles static handles');
 await page.evaluate(()=>{window.__aidHandlePixel=index=>{const {editor:e,state:s}=window.styk,g=[...e.geometry.objects.values()].find(g=>g.obj.unique_id===e.selectedUid),p=g.segments[index].end,d=devicePixelRatio||1;return [...document.querySelector('#overlay').getContext('2d').getImageData(Math.round((p.x*s.view.scale+s.view.x)*d),Math.round((p.y*s.view.scale+s.view.y)*d),1,1).data];};});
 await page.waitForFunction(()=>window.__aidHandlePixel(2).join(',')==='204,68,68,255');
 check(await page.evaluate(()=>window.__aidHandlePixel(0)[3]===0),'F10 hides unrelated static endpoint while selected static remains painted');
 await page.locator('#builder-branch').check();await page.waitForFunction(()=>window.__aidHandlePixel(3).join(',')==='204,68,68,255');
 check(true,'Selected Builder branch keeps descendant static handles visible');
 await page.locator('[data-tool="rig"] ').click();await page.keyboard.press('F12');check(await page.evaluate(()=>window.styk.state.settings.builderHighlightSegment===true),'Builder F12 enables selected highlight');
 await page.keyboard.press('F9');await page.locator('dialog[open] [data-setting="builderCanvasColor"]').waitFor();
 await page.locator('[data-setting="builderCanvasColor"]').fill('#dceeff');await page.locator('[data-setting="builderCanvasColor"]').dispatchEvent('change');
 check(await page.evaluate(()=>window.styk.state.settings.builderCanvasColor==='#dceeff'&&window.styk.state.settings.useBuilderCanvasColor),'F9 construction color activates editor-only background');
 check(await page.locator('[data-setting="useBuilderCanvasColor"]').isChecked(),'Construction color visibly enables its preference checkbox');
 await page.screenshot({path:path.join(output,'preferences.png')});await page.keyboard.press('Escape');
 await page.screenshot({path:path.join(output,'builder.png')});
 check(await page.evaluate(()=>JSON.stringify(window.styk.editor.report)===window.__aidBefore&&window.styk.editor._undo.length===window.__aidHistory),'Actual Builder preferences do not dirty or add document history');
 await page.locator('[data-tool="pose"]').click();await page.evaluate(()=>{const e=window.styk.editor,original=e.alignCameraToView;window.__cameraAlignCalls=0;e.alignCameraToView=function(...args){window.__cameraAlignCalls++;return original.apply(this,args);};});await page.keyboard.press('F10');
 check(await page.evaluate(()=>window.__cameraAlignCalls===1&&window.styk.state.settings.builderShowStaticHandles===false),'F10 retains camera Align to View action outside Builder');
 await page.locator('[data-tool="rig"]').click();await page.evaluate(()=>window.styk.editor.select(window.styk.editor.frame.objects[0].unique_id,2));
 const widths=await page.evaluate(()=>window.styk.editor.figure.segments.map(s=>s.thickness));
 const widthInput=page.locator('input[data-property="thickness"]');await widthInput.fill('23');await widthInput.press('Enter');
 await page.waitForFunction(()=>window.styk.editor.figure.segments[2].thickness===23&&window.styk.editor.figure.segments[3].thickness===23);
 check(await page.evaluate(old=>window.styk.editor.figure.segments[0].thickness===old[0]&&window.styk.editor.figure.segments[1].thickness===old[1],widths),'Actual checked-branch width field updates descendants and preserves unrelated segments');
 await page.locator('[data-tool="rig"]').click();await page.keyboard.press('Control+z');
 await page.waitForFunction(old=>JSON.stringify(window.styk.editor.figure.segments.map(s=>s.thickness))===JSON.stringify(old),widths);
 check(true,'One actual Undo restores heterogeneous branch widths');
 check(errors.length===0,'No application errors');await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks:checks.length,errors}));
}finally{await browser?.close();await backend.stop();}
