import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const output=path.resolve('artifacts/onion-fix');await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1400,height:950}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');
  await page.waitForFunction(()=>window.styk?.ready);
  const result=await page.evaluate(async()=>{
    const {Editor}=await import('/src/editor.mjs');
    const {OnionSkinCache}=await import('/src/onion-skin.mjs');
    const {normalizeEditorSettings}=await import('/src/settings.mjs');
    const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
    const {createRenderer}=await import('/src/renderer.mjs');
    const {buildGeometry,drawGeometry}=await import('/src/pivot/geometry.mjs');
    const report=emptyDocument(),figure=report.figure_types[0];
    report.canvas_width=640;report.canvas_height=400;
    // Transparent figures exercise the expensive compatibility texture path.
    report.keyframes=Array.from({length:5},(_,i)=>createFrame(Array.from({length:80},(_,j)=>createObject(figure,j+1,40+j%10*55+i*8,45+Math.floor(j/10)*40,{scale:.18,field28:80})),5));
    const editor=new Editor({demo:false}).load(report);editor.selectFrame(2);editor.select(1);
    const make=async(fallback=false)=>{const canvas=document.createElement('canvas');if(fallback)canvas.getContext('2d');const renderer=await createRenderer(canvas);renderer.resize(640,400,1);return renderer;};
    const gpu=await make(),reference=await make(),fallback=await make(true);
    const cache=new OnionSkinCache(),settings=normalizeEditorSettings({onionMode:'frames',onionOpacity:.4});
    const observations=[];
    const read=async renderer=>{
      await renderer.device?.queue.onSubmittedWorkDone();
      const image=new Image();image.src=renderer.canvas.toDataURL();await image.decode();
      const surface=new OffscreenCanvas(640,400),context=surface.getContext('2d');context.drawImage(image,0,0);
      return context.getImageData(0,0,640,400).data;
    };
    const options=()=>({report,frame:editor.evaluatedFrame,geometry:editor.geometry,view:{x:0,y:0,scale:1},cameraEnabled:false,onionFrames:cache.get(editor,settings),liveEditing:true});
    try {
      gpu.render(options());fallback.render(options());await gpu.device.queue.onSubmittedWorkDone();editor.beginDrag();
      for(let i=0;i<12;i++){
        editor.moveSelection(1,0);const start=performance.now();gpu.render(options());
        const row={cpuMs:performance.now()-start,rasterized:gpu.stats.rasterizedObjects,compiled:gpu.stats.compiledObjects,uploadBytes:gpu.stats.uploadBytes};
        fallback.render(options());row.canvasRasterized=fallback.stats.onionRasterizedObjects;observations.push(row);
        await gpu.device.queue.onSubmittedWorkDone();
      }
      editor.commitDrag();
      const comparisons=[];
      for(const [name,patch] of [['behind',{}],['on-top',{onionShowOnTop:true}],['no-tint',{onionTint:false}],['red-tint',{onionTint:true,onionBeforeColor:'#ff0000'}]]){
        Object.assign(settings,patch);const actual=options();gpu.render(actual);
        reference.render({...actual,geometry:buildGeometry(report,editor.evaluatedFrame),onionFrames:new OnionSkinCache().get(editor,settings)});
        const a=await read(gpu),b=await read(reference);let max=0;
        for(let i=0;i<a.length;i++)max=Math.max(max,Math.abs(a[i]-b[i]));
        fallback.render(actual);const c=await read(fallback);let mean=0;
        for(let i=0;i<a.length;i++)mean+=Math.abs(a[i]-c[i]);mean/=a.length;
        comparisons.push({name,maxFreshDifference:max,meanCanvasDifference:mean});
      }
      fallback.render(options());const retainedCanvasRasterized=fallback.stats.onionRasterizedObjects;
      const sprite=new OffscreenCanvas(10,10),brush=sprite.getContext('2d');brush.fillStyle='red';brush.fillRect(0,0,10,10);
      const target=new OffscreenCanvas(10,10),context=target.getContext('2d');context.globalAlpha=.4;
      drawGeometry(context,{drawables:[{type:'image',slot:0,opacity:1,alpha:.5,seg:{},obj:{},start:{x:0,y:0},end:{x:10,y:0},angle:0,
        asset:{anchor_length:10,anchor_angle_rad:0,anchor_start:{x:0,y:0}}}]},{url:()=>'',image:()=>Object.assign(sprite,{complete:true,naturalWidth:10,naturalHeight:10})});
      const spriteAlpha=context.getImageData(5,5,1,1).data[3];
      // Product-level state: a single moving line makes before/current/after
      // ordering obvious in the screenshot and independent pixel assertions.
      const scene=emptyDocument(),f=scene.figure_types[0];
      f.segments=[{...f.segments[0],length:100,thickness:18,angle_rad:0}];f.segment_count=1;
      scene.keyframes=[180,400,620].map(x=>createFrame([createObject(f,1,x,270)],1));
      styk.editor.load(scene);styk.editor.enableFrameDrafts();styk.editor.selectFrame(1);
      Object.assign(styk.state.settings,{onionBefore:1,onionAfter:1,onionMode:'keyframes',onionOpacity:.6,onionTint:true,onionBeforeColor:'#e76b70',onionAfterColor:'#549de7'});
      styk.state.onion=true;styk.fit();
      return {backend:gpu.stats.backend,observations,comparisons,retainedCanvasRasterized,spriteAlpha};
    } finally {gpu.destroy();reference.destroy();fallback.destroy();}
  });
  await page.screenshot({path:path.join(output,'onion-before-current-after.png')});
  // Exercise the app's persistent cache after enabling onion skin. The app
  // authors the layer sheet; legacy channel sampling is covered by unit tests.
  const authored=await page.evaluate(async()=>{
    const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
    const {editor,state}=styk,scene=emptyDocument(),figure=scene.figure_types[0];
    figure.segments=[{...figure.segments[0],length:100,thickness:18,angle_rad:0}];figure.segment_count=1;
    scene.keyframes=[createFrame([createObject(figure,1,180,270)],1)];
    editor.load(scene);editor.disableFrameDrafts();editor.select(1);
    editor.sheetInsertFrames(['scene','camera',...editor.report._styk.layers.order],1,29);
    Object.assign(state.settings,{onionBefore:1,onionAfter:1,onionMode:'keyframes'});
    state.onion=true;styk.fit();
    const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    await paint();
    const observations=[];
    const capture=async name=>{
      await paint();await state.renderer.device?.queue.onSubmittedWorkDone();
      const skins=state.renderer.last.onionFrames;
      observations.push({name,roots:skins.map(skin=>skin.geometry.objects.get(0).root.x)});
    };
    for(const [tick,x] of [[0,180],[10,400],[20,620]]){
      editor.sheetInsertKey(['layer-1'],tick);editor.seek(tick);editor.select(1);editor.updateObject({root_x:x});
    }
    editor.seek(10);await capture('insert');
    editor.seek(20);editor.updateObject({root_x:740});editor.seek(10);await capture('edit');
    editor.sheetInsertKey(['layer-1'],15);editor.seek(15);editor.updateObject({root_x:560});editor.seek(10);await capture('insert-nearer');
    editor.sheetMoveFrames(['layer-1'],15,15,10);await capture('retime');
    editor.sheetClearKeys(['layer-1'],20);await capture('delete');
    editor.undo();await capture('undo');editor.redo();await capture('redo');
    return observations;
  });
  assert.deepEqual(authored.map(row=>row.roots),[[180,620],[180,740],[180,560],[180,740],[180,560],[180,740],[180,560]]);
  await page.screenshot({path:path.join(output,'onion-authored-edits.png')});
  result.authored=authored;
  await writeFile(path.join(output,'browser-report.json'),JSON.stringify({...result,errors},null,2));
  console.log(JSON.stringify({...result,errors},null,2));
  assert.equal(errors.length,0);
  assert.ok(result.observations.every(row=>row.rasterized<=4),'Only the live figure and three dependent ghosts may rasterize.');
  assert.ok(result.observations.every(row=>row.canvasRasterized<=3),'Canvas must retain unaffected ghost artwork.');
  assert.equal(result.retainedCanvasRasterized,0);
  assert.ok(Math.abs(result.spriteAlpha-51)<=1,'Sprite alpha must multiply the surrounding onion opacity.');
  assert.ok(result.comparisons.every(row=>row.maxFreshDifference<=1 && row.meanCanvasDifference<2));
} finally {await browser.close();}
