import {_electron as electron,chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),output=path.join(root,'artifacts',`artwork-gpu-${Date.now()}`);await mkdir(output,{recursive:true});
const browser=process.env.STYK_BROWSER_URL?await chromium.launch({channel:'chrome',headless:true}):null;
const app=browser?null:await electron.launch({args:[root],cwd:root,env:{...process.env,STYK_USER_DATA_DIR:path.join(output,'profile')}});
try{
  const page=browser?await browser.newPage():await app.firstWindow();if(browser)await page.goto(process.env.STYK_BROWSER_URL);await page.waitForFunction(()=>window.styk?.ready);
  const result=await page.evaluate(async()=>{
    const {createRenderer}=await import('/src/renderer.mjs');
    const make=async sharedArtwork=>{const c=document.createElement('canvas');c.width=256;c.height=128;document.body.append(c);const r=await createRenderer(c,{sharedArtwork});r.resize(256,128,1);return{r,c};};
    const a=await make(true),b=await make(false),surface=document.createElement('canvas');surface.width=256;surface.height=128;
    const context=surface.getContext('2d',{willReadFrequently:true}),poly={color_rgb:[240,40,20],alpha_raw:0},fig={figure_type_id:1,segments:[],polyfills:[poly]};
    const object=(uid,slot,x,y)=>{const obj={unique_id:uid,object_slot:slot,figure_type_id:1,root_x:x,root_y:y,scale:1,field28:0},root={x,y};return{obj,fig,slot,root,segments:[],polys:[],drawables:[{type:'poly',obj,fig,slot,index:0,poly,points:[[0,0],[24,24],[0,24],[24,0]].map(([dx,dy])=>({x:x+dx,y:y+dy})),z:0,rgb:[240,40,20],alpha:1,opacity:1}]};};
    const first=object(1,0,20,20),second=object(2,1,80,20);
    const scene=(items,previous)=>({objects:new Map(items.map(g=>[g.slot,g])),orderedObjects:items,token:{},previousToken:previous?.token,changedSlots:new Set(items.map(g=>g.slot)),warnings:[]});
    const report={version:5,canvas_width:256,canvas_height:128,figure_types:[fig],backgrounds:[]},observations=[];
    const draw=(target,geometry,view)=>{const frame={objects:geometry.orderedObjects.map(g=>g.obj),background_id:0};target.r.render({report,frame,geometry,view,editorBackgroundColor:0xffffffff,cameraEnabled:false});context.clearRect(0,0,256,128);context.drawImage(target.c,0,0);return context.getImageData(0,0,256,128).data;};
    let geometry=scene([first,second]);
    const check=async(name,view={scale:1,x:0,y:0})=>{
      const actual=draw(a,geometry,view),expected=draw(b,geometry,view);let max=0,changed=0;
      for(let i=0;i<actual.length;i++){const delta=Math.abs(actual[i]-expected[i]);max=Math.max(max,delta);if(delta>1)changed++;}
      await Promise.all([a.r.device.queue.onSubmittedWorkDone(),b.r.device.queue.onSubmittedWorkDone()]);
      if(max>1||a.r.stats.warnings.length||b.r.stats.warnings.length)throw new Error(JSON.stringify({name,max,changed,warnings:[...a.r.stats.warnings,...b.r.stats.warnings]}));
      observations.push({name,maxPixelDifference:max,sharedTextures:a.r.stats.uniqueTextures,referenceTextures:b.r.stats.uniqueTextures,rasterized:a.r.stats.rasterizedObjects});
    };
    await check('two identical translated bow-tie polygons');
    if(a.r.stats.uniqueTextures!==1||b.r.stats.uniqueTextures!==2)throw new Error('Equivalent artwork did not share exactly one texture.');
    const changed={...first,drawables:first.drawables.map(item=>({...item,rgb:[20,220,40]}))};
    geometry=scene([changed,second],geometry);await check('change one instance without destroying its sibling resource');
    geometry=scene([changed],geometry);await check('remove the last original instance');
    geometry=scene([changed,second],geometry);await check('restore an inactive texture');
    if(a.r.stats.rasterizedObjects)throw new Error('Returning artwork lost its retained texture.');
    await check('zoom through the raster resolution boundary',{scale:1.5,x:0,y:0});
    await check('return to the original resolution');
    if(a.r.stats.rasterizedObjects)throw new Error('Returning zoom lost its retained raster variant.');
    a.r.generation++;b.r.generation++;
    await check('asset generation invalidates old raster variants');
    if(!a.r.stats.rasterizedObjects)throw new Error('Asset generation reused stale pixels.');
    if([...a.r.rasterCache.lru.keys()].some(value=>value.generation!==a.r.generation))throw new Error('Old asset generation remained resident.');
    const {Editor}=await import('/src/editor.mjs');
    const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
    const {compilePlaybackPacket,packetTransferables}=await import('/src/playback-worker.mjs');
    const native=emptyDocument();native.canvas_width=256;native.canvas_height=128;
    const nativeFigure=native.figure_types[0];
    nativeFigure.segments=nativeFigure.segments.slice(0,3).map((s,i)=>({...s,segment_id:i+1,parent_id:0,segment_type:'line',segment_kind:'line',primitive_code:0,flags:0,thickness:1,length:i?24:Math.sqrt(2)*24,angle_rad:[Math.PI/4,Math.PI/2,0][i]}));
    nativeFigure.segment_count=3;nativeFigure.polyfills=[{segment_ids:[0,1,2,3],color_rgb:[240,40,20],alpha_raw:0}];
    const nativeObject=createObject(nativeFigure,1,20,20);
    native.keyframes=[createFrame([nativeObject,{...structuredClone(nativeObject),unique_id:2,root_x:80}])];
    const e=new Editor({demo:false});e.load(structuredClone(native));e.select(1);
    const read=target=>{context.clearRect(0,0,256,128);context.drawImage(target.c,0,0);return context.getImageData(0,0,256,128).data;};
    const difference=(actual,expected)=>actual.reduce((max,value,i)=>Math.max(max,Math.abs(value-expected[i])),0);
    const nativeDraw=(geometry,extra={})=>{a.r.render({report:e.report,frame:e.frame,geometry,view:{scale:1,x:0,y:0},cameraEnabled:false,...extra});return read(a);};
    let current=e.geometry;nativeDraw(current);
    const texture=a.r.entries.get(1).texture;
    if(!texture)throw new Error('Native bow-tie fixture did not exercise compatibility rendering.');
    const preview=nativeDraw(current,{dragTranslations:new Map([[1,{x:12.37,y:8.11}]])});
    e.moveSelection(12.37,8.11);current=e.geometry;
    const committed=nativeDraw(current),continuity=difference(preview,committed);
    if(continuity||a.r.entries.get(1).texture!==texture||a.r.stats.rasterizedObjects||a.r.stats.primitiveUploadCalls)throw new Error(`Rigid native commit lost retained artwork: ${continuity}`);
    observations.push({name:'native fractional translation preserves preview pixels and GPU resource',maxPixelDifference:continuity,rasterized:a.r.stats.rasterizedObjects});
    e.beginDrag();e.object.angles[0]+=.3;e.touch();e.commitDrag();nativeDraw(e.geometry);
    if(e.geometry.objects.get(0).renderSource||a.r.entries.get(1).texture===texture)throw new Error('Pose edit kept obsolete translated artwork.');
    for(const [name,scale,camera] of [['shared packet',1,null],['shared packet at double resolution',2,null],['camera crop distinguishes instances',1,{is_default:false,x:30,y:0,scale:1,angle_rad:0}]]){
      native.keyframes[0].camera=camera||{is_default:true,x:0,y:0,scale:1,angle_rad:0};
      const packet=await compilePlaybackPacket(native,0,{sharedArtwork:true,scale}),reference=await compilePlaybackPacket(native,0,{sharedArtwork:false,scale});
      const transferables=packetTransferables(packet);
      if(new Set(transferables).size!==transferables.length)throw new Error('A shared bitmap occurs twice in the transfer list.');
      const pixels=[];
      for(const [target,value] of [[a,packet],[b,reference]]){
        target.r.preparedFrames.clear();target.r.useReport(native);target.r.prepareFrame(value,{report:native,view:{scale:1}});
        target.r.renderPrepared(value.key,{report:native,view:{scale:1}});pixels.push(read(target));
      }
      const max=difference(...pixels);
      if(max>1)throw new Error(`${name} differs by ${max}`);
      if(!camera&&(packet.compatibility.length!==1||reference.compatibility.length!==2||packet.sharing.reusedInstances!==1))throw new Error(`${name}: identical native artwork did not share a bitmap.`);
      if(camera&&(packet.sharing.reusedInstances||packet.compatibility.length!==2))throw new Error('Differently cropped visible native instances shared a bitmap.');
      observations.push({name,maxPixelDifference:max,sharedBitmaps:packet.compatibility.length,referenceBitmaps:reference.compatibility.length,bytes:packet.byteLength,referenceBytes:reference.byteLength});
      for(const value of [packet,reference])for(const entry of value.compatibility)entry.bitmap?.close();
    }
    await Promise.all([a.r.device.queue.onSubmittedWorkDone(),b.r.device.queue.onSubmittedWorkDone()]);
    const {ArtworkRegistry}=await import('/src/render-artwork.mjs');
    const {PlaybackBitmapPool}=await import('/src/playback-bitmap-pool.mjs');
    native.keyframes[0].camera={is_default:true,x:0,y:0,scale:1,angle_rad:0};
    native.keyframes.push(structuredClone(native.keyframes[0]));
    const registry=new ArtworkRegistry(),pool=new PlaybackBitmapPool();
    const p0=await compilePlaybackPacket(native,0,{artworkRegistry:registry}),p1=await compilePlaybackPacket(native,1,{artworkRegistry:registry});
    if(p0.compatibility[0].artworkKey!==p1.compatibility[0].artworkKey)throw new Error('Exact artwork identity changed between native frames.');
    const incoming=p1.compatibility[0].bitmap;pool.acquire(p0);pool.acquire(p1);
    if(incoming.width!==0||p0.compatibility[0].bitmap!==p1.compatibility[0].bitmap)throw new Error('CPU packets retained duplicate bitmaps.');
    a.r.preparedFrames.clear();a.r.prepareFrame(p0,{report:native});a.r.prepareFrame(p1,{report:native});
    if(a.r.preparedFrames.frames.size!==2||a.r.preparedFrames.textures.size!==1)throw new Error('GPU frames retained duplicate textures.');
    a.r.renderPrepared(p1.key,{report:native});const beforeEviction=read(a);
    a.r.preparedFrames._remove(p0.key);pool.release(p0);pool.release(p1);
    if(p1.compatibility[0].bitmap.width!==0)throw new Error('Last CPU packet did not release its bitmap.');
    a.r.renderPrepared(p1.key,{report:native});const afterEviction=read(a);
    const evictionDifference=difference(beforeEviction,afterEviction);
    if(evictionDifference)throw new Error('CPU/neighbor eviction changed a retained GPU frame.');
    observations.push({name:'cross-frame sharing survives independent CPU and GPU eviction',maxPixelDifference:evictionDifference,gpuTextures:a.r.preparedFrames.textures.size,cpuBytes:pool.bytes});
    const {PlaybackResources}=await import('/src/playback-resources.mjs');
    const resources=new PlaybackResources(),cachedRegistry=new ArtworkRegistry();
    const cold=await compilePlaybackPacket(native,0,{resources,artworkRegistry:cachedRegistry,revision:10});
    cachedRegistry.clear();
    const reused=await compilePlaybackPacket(native,1,{resources,artworkRegistry:cachedRegistry,revision:11});
    if(cold.sharing.rasterCacheMisses!==1||reused.sharing.rasterCacheHits!==1||reused.sharing.rasterCacheMisses)throw new Error('Frame revision rerasterized unchanged pixels.');
    cold.compatibility[0].bitmap.close();resources.dispose();
    a.r.preparedFrames.clear();a.r.prepareFrame(reused,{report:native});a.r.renderPrepared(reused.key,{report:native});
    const retainedPixels=read(a),fresh=await compilePlaybackPacket(native,1,{sharedArtwork:false,revision:11});
    b.r.preparedFrames.clear();b.r.prepareFrame(fresh,{report:native});b.r.renderPrepared(fresh.key,{report:native});
    const retainedDifference=difference(retainedPixels,read(b));
    if(retainedDifference)throw new Error(`Worker raster reuse changed pixels by ${retainedDifference}`);
    observations.push({name:'worker artwork survives frame revision and independent resource disposal',maxPixelDifference:retainedDifference,cold:cold.sharing,reused:reused.sharing});
    for(const packet of [reused,fresh])for(const entry of packet.compatibility)entry.bitmap.close();
    const {PlaybackGeometryCache}=await import('/src/playback-geometry-cache.mjs');
    const {PlaybackTweenCache}=await import('/src/playback-tween-cache.mjs');
    native.keyframes[0].duration_raw=8;
    const tweenResources=new PlaybackResources(),geometryCache=new PlaybackGeometryCache(),tweenCache=new PlaybackTweenCache(),tweenArtworks=new ArtworkRegistry();
    for(const tick of [0,1,2,7,8,1]){
      const packet=await compilePlaybackPacket(native,tick,{resources:tweenResources,geometryCache,tweenCache,artworkRegistry:tweenArtworks}),reference=await compilePlaybackPacket(native,tick,{sharedArtwork:false});
      a.r.preparedFrames.clear();b.r.preparedFrames.clear();a.r.prepareFrame(packet,{report:native});b.r.prepareFrame(reference,{report:native});
      a.r.renderPrepared(packet.key,{report:native});const pixels=read(a);b.r.renderPrepared(reference.key,{report:native});
      const max=difference(pixels,read(b));if(max)throw new Error(`Cached native tween ${tick} differs by ${max}`);
      observations.push({name:`retained geometry, tween and raster at tick ${tick}`,maxPixelDifference:max});
      for(const value of [packet,reference])for(const entry of value.compatibility)entry.bitmap.close();
    }
    tweenResources.dispose();
    const {buildGeometry}=await import('/src/pivot/geometry.mjs');
    const navigation=new Editor({demo:false});navigation.load(structuredClone(native));
    navigation.report.keyframes[1].objects[0].root_x+=13.37;navigation._invalidate();
    const checkNavigation=name=>{
      const frame=navigation.evaluatedFrame;
      a.r.render({report:navigation.report,frame,geometry:navigation.geometry,view:{scale:1,x:0,y:0},cameraEnabled:false});const actual=read(a);
      b.r.render({report:navigation.report,frame,geometry:buildGeometry(navigation.report,frame),view:{scale:1,x:0,y:0},cameraEnabled:false});
      const max=difference(actual,read(b));if(max)throw new Error(`${name}: retained editor geometry differs by ${max}; ${JSON.stringify({sameGeometry:JSON.stringify(navigation.geometry.drawables)===JSON.stringify(buildGeometry(navigation.report,frame).drawables),a:a.r.stats,b:b.r.stats})}`);
      observations.push({name,maxPixelDifference:max});
    };
    for(const index of [0,1,0,1,0]){navigation.selectFrame(index);checkNavigation(`editor retained key navigation ${index}`);}
    navigation.setFramesDuration([0],12);checkNavigation('sparse duration edit');navigation.undo();checkNavigation('sparse duration undo');navigation.redo();checkNavigation('sparse duration redo');
    navigation.insertInbetweenFrames(.5,[0]);checkNavigation('inserted key retains exact editor artwork');
    const {PlaybackCache}=await import('/src/playback.mjs');
    const patchReport=structuredClone(native);
    patchReport.keyframes=Array.from({length:5},(_,index)=>{
      const frame=structuredClone(native.keyframes[0]);frame.duration_raw=4;frame.objects[0].root_x+=index*8;return frame;
    });
    const patchCache=new PlaybackCache();
    try{
      patchCache.load(patchReport);const ticks=Array.from({length:patchCache.totalTicks},(_,i)=>i);
      await patchCache.prepareRange(ticks);
      for(const tick of ticks)a.r.prepareFrame(patchCache.get(tick),{report:patchReport});
      const retainedPacket=patchCache.get(0),retainedGPU=a.r.preparedFrames.frames.get(retainedPacket.key),uploads=a.r.preparedFrames.stats.uploads;
      const originalPixelKeys=new Set(retainedPacket.compatibility.map(entry=>entry.artworkKey));
      patchReport.keyframes[2].objects[0].angles[0]+=.17;
      patchCache.updateFrame(2,patchReport.keyframes[2]);a.r.retainPreparedFrames(patchReport,patchCache.cache.values());
      if(patchCache.cache.size!==10||a.r.preparedFrames.frames.size!==10)throw new Error('Local patch did not retain ten independent CPU/GPU packets.');
      await patchCache.prepareRange(ticks);
      if(!patchCache.get(8).compatibility.some(entry=>originalPixelKeys.has(entry.artworkKey)))throw new Error('Unchanged sibling artwork identity changed across a frame revision.');
      for(const tick of ticks){
        const actual=patchCache.get(tick),reference=await compilePlaybackPacket(patchReport,tick,{sharedArtwork:false});
        a.r.prepareFrame(actual,{report:patchReport});a.r.renderPrepared(actual.key,{report:patchReport});const pixels=read(a);
        b.r.clearPreparedFrames();b.r.prepareFrame(reference,{report:patchReport});b.r.renderPrepared(reference.key,{report:patchReport});
        const max=difference(pixels,read(b));if(max)throw new Error(`Revision-retained playback ${tick} differs by ${max}`);
        observations.push({name:`mixed retained/new revision at tick ${tick}`,maxPixelDifference:max});
        for(const entry of reference.compatibility)entry.bitmap?.close();
      }
      if(a.r.preparedFrames.frames.get(retainedPacket.key)!==retainedGPU||a.r.preparedFrames.stats.uploads-uploads!==7)throw new Error('Retained GPU buffers were uploaded again.');
    }finally{patchCache.dispose();}
    const offscreen = globalThis.OffscreenCanvas; let fallbackPacket;
    try {
      globalThis.OffscreenCanvas = undefined;
      fallbackPacket = await compilePlaybackPacket(native, 0, {revision: 100});
    } finally {globalThis.OffscreenCanvas = offscreen;}
    if (!fallbackPacket.compatibility.length || fallbackPacket.compatibility.some(entry => entry.bitmap)) throw new Error('Fallback fixture did not use geometry rasters.');
    a.r.clearPreparedFrames(); a.r.prepareFrame(fallbackPacket, {report: native});
    a.r.renderPrepared(fallbackPacket.key, {report: native}); const fallbackPixels = read(a);
    const fallbackResources = [...a.r.preparedFrames.fallbackRasters.lru.keys()];
    // Editable cache pressure must not release prepared resources.
    a.r.rasterCache.clear();
    a.r.renderPrepared(fallbackPacket.key, {report: native});
    const fallbackDifference = difference(fallbackPixels, read(a));
    if (fallbackDifference || fallbackResources.some(resource => resource.destroyed)) throw new Error('Editor eviction destroyed prepared fallback pixels.');
    observations.push({name: 'prepared fallback rasters survive editable cache eviction', maxPixelDifference: fallbackDifference});
    a.r.clearPreparedFrames();
    if (fallbackResources.some(resource => !resource.destroyed) || a.r.preparedFrames.bytes) throw new Error('Prepared fallback rasters leaked after cache clear.');
    const editFrame=native.keyframes[0],editGeometry=buildGeometry(native,editFrame),editView={scale:1,x:0,y:0};
    a.r.render({report:native,frame:editFrame,geometry:editGeometry,view:editView,cameraEnabled:false});
    const editedFrame=structuredClone(editFrame);editedFrame.objects[0].angles[0]+=.23;
    const editedGeometry=buildGeometry(native,editedFrame),liveBuffer=a.r.shapeBuffer,activeRasters=a.r.layout.map(entry=>entry.texture).filter(Boolean);
    const cancelUpdate=new AbortController();a.r.rasterCache.maxBytes=0;
    let yieldedUpdate=false;
    try{
      await a.r.prepareSceneUpdate({report:native,frame:editedFrame,geometry:editedGeometry,view:editView,cameraEnabled:false,sliceMs:.0001,
        signal:cancelUpdate.signal,yieldControl:()=>{
          yieldedUpdate=true;
          if(a.r.shapeBuffer!==liveBuffer||activeRasters.some(resource=>resource.destroyed))throw new Error('Unpublished editor update changed live GPU resources.');
          cancelUpdate.abort();return Promise.resolve();
        }});
      throw new Error('Cancelled editable layout unexpectedly completed.');
    }catch(error){if(error.name!=='AbortError')throw error;}
    if(!yieldedUpdate||a.r.rasterCache.leases.size||activeRasters.some(resource=>resource.destroyed))throw new Error('Cancelled editable layout leaked its leases or destroyed active textures.');
    const preparedEdit=await a.r.prepareSceneUpdate({report:native,frame:editedFrame,geometry:editedGeometry,view:editView,cameraEnabled:false,sliceMs:.0001,yieldControl:()=>Promise.resolve()});
    if(a.r.shapeBuffer!==liveBuffer)throw new Error('Completed editable preparation published before activation.');
    preparedEdit.activate();preparedEdit.dispose();
    const editOptions={report:native,frame:editedFrame,geometry:editedGeometry,view:editView,cameraEnabled:false};
    a.r.render(editOptions);const editPixels=read(a);b.r.render({...editOptions,geometry:buildGeometry(native,editedFrame)});
    const editDifference=difference(editPixels,read(b));
    if(editDifference||a.r.stats.rasterizedObjects||a.r.rasterCache.leases.size)throw new Error('Published cooperative editor layout differed, rebuilt artwork or leaked a lease.');
    observations.push({name:'cooperative editable layout cancels safely and publishes exact pixels',maxPixelDifference:editDifference});
    a.r.rasterCache.maxBytes=128*1024*1024;
    const stageReport=structuredClone(native),stageFrame=stageReport.keyframes[0],liveResources=[...a.r.rasterCache.lru.keys()];
    let viewReads=0;
    const discarded=await a.r.prepareInitialScene({report:stageReport,frame:stageFrame,cameraEnabled:false,
      getView:()=>({scale:++viewReads===1?1:2,x:0,y:0})});
    const privateResources=[...discarded.stage.rasterCache.lru.keys()];
    if(privateResources.length!==2)throw new Error('Staged viewport change did not retain both private raster variants.');
    discarded.dispose();
    if(privateResources.some(value=>!value.destroyed)||liveResources.some(value=>value.destroyed))throw new Error('Discarded staging lost raster ownership isolation.');
    const activated=await a.r.prepareInitialScene({report:stageReport,frame:stageFrame,cameraEnabled:false,view:{scale:1,x:0,y:0}});
    const transferred=activated.stage.rasterCache,stagedResource=[...transferred.lru.keys()][0];
    a.r.activatePreparedScene(activated);activated.dispose();
    if(a.r.rasterCache!==transferred||stagedResource.destroyed||liveResources.some(value=>!value.destroyed))throw new Error('Published staging did not transfer raster ownership.');
    const stageOptions={report:stageReport,frame:stageFrame,geometry:activated.geometry,view:activated.view,cameraEnabled:false};
    a.r.render(stageOptions);const stagedPixels=read(a);b.r.render({...stageOptions,geometry:buildGeometry(stageReport,stageFrame)});
    const stagedDifference=difference(stagedPixels,read(b));
    if(stagedDifference||a.r.stats.rasterizedObjects)throw new Error('Published raster scene changed pixels or rasterized again.');
    observations.push({name:'private raster variants dispose or transfer with the staged scene',maxPixelDifference:stagedDifference});
    await Promise.all([a.r.device.queue.onSubmittedWorkDone(),b.r.device.queue.onSubmittedWorkDone()]);
    if(a.r.stats.warnings.length||b.r.stats.warnings.length)throw new Error(JSON.stringify([...a.r.stats.warnings,...b.r.stats.warnings]));
    a.r.destroy();b.r.destroy();return observations;
  });
  await writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({output,checks:result}));
}finally{if(browser)await browser.close();else await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
