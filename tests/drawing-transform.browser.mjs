import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const out=process.env.STYK_TRANSFORM_ARTIFACTS||'artifacts/drawing-transform';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
  await page.locator('[data-workspace-mode="draw"]').click();
  await page.evaluate(async()=>{
    const {emptyDocument}=await import('/src/demo.mjs');
    window.freshDrawing=async()=>{const e=styk.editor,d=styk.drawing;e.load(emptyDocument());e.createDrawingLayer();d.settings.filter='nearest';d.settings.resolution=1;const target=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:0,y:0}}),surface=await d.owner.surface(target.figure);return {e,d,target,surface};};
  });
  const sparse=await page.evaluate(async()=>{
    const {e,d,target}=await freshDrawing();e.commitDrawingPixels(target,[{tx:-100000,ty:0,before:null,after:new Uint8ClampedArray([127,5,249,1])},{tx:100000,ty:0,before:null,after:new Uint8ClampedArray([200,100,30,255])}]);
    d.settings.resolution=2;const start=performance.now();await d.action('resample');const ms=performance.now()-start,t=e.drawingTarget(),store=(await d.owner.surface(t.figure)).store;
    const exact=JSON.stringify(store.pixel(-12800000,0))===JSON.stringify([127,5,249,1]),tiles=store.size,width=store.bounds.width;
    e.undo();const undone=e.drawingTarget().figure._styk.drawing.pixelsPerUnit===1;e.redo();await d.barrier();
    const {DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs');
    const exporter=new DocumentExporter();let reopened;
    try{const blob=await exporter.export(e.report,{format:'styk',getRevision:()=>e.revision}),read=await new ImportClient().importFile(new File([blob],'sparse-resample.styk'));e.load(read.document);reopened=(await d.owner.surface(e.drawingTarget().figure)).store;}finally{exporter.dispose();}
    return {ms,exact,tiles,width,undone,reopened:reopened.pixel(-12800000,0).join(',')==='127,5,249,1'&&reopened.size===tiles,reopenedPixel:reopened.pixel(-12800000,0),reopenedTiles:reopened.size};
  });
  console.log(JSON.stringify({sparse}));
  check('resample processes distant sparse islands without allocating their empty span',sparse.exact&&sparse.tiles===8&&sparse.width>25000000);
  check('sparse resampling has exact undo and native save/reopen',sparse.undone&&sparse.reopened);
  const pose=await page.evaluate(async()=>{
    const {e,d,target,surface}=await freshDrawing(),{encodeDrawingPNG}=await import('/src/drawing-png.mjs');
    const p=new Uint8ClampedArray(64*64*4);p.set([127,5,249,1],(30*64+30)*4);p.set([17,51,233,0],(31*64+30)*4);e.commitDrawingPixels(target,[{tx:0,ty:0,before:null,after:p}]);
    e._drawingPixelClipboard={pixelsPerUnit:1,width:2,height:1,world:{x:10,y:10},matrix:[0,1,-1,0,10,10],dataUrl:await encodeDrawingPNG(new Uint8ClampedArray([200,20,40,255,127,5,249,1]),2,1)};
    const before=surface.store.get(0,0).pixels.slice();await d.action('paste-pixels');
    const rotation=surface.store.pixel(9,10).join(',')==='200,20,40,255'&&surface.store.pixel(9,11).join(',')==='127,5,249,1';
    e.undo();const exactUndo=surface.store.get(0,0).pixels.every((n,i)=>n===before[i]);
    e._drawingPixelClipboard.matrix=[1.5,0,0,1.5,10.25,10.25];d.settings.filter='smooth';await d.action('paste-pixels');
    const untouched=surface.store.pixel(30,30).join(',')==='127,5,249,1'&&surface.store.pixel(30,31).join(',')==='17,51,233,0';
    e.undo();e._drawingPixelClipboard.matrix=[-1,0,0,1,10,10];await d.action('paste-pixels');
    return {rotation,exactUndo,untouched,mirrored:surface.store.pixel(9,10).join(',')==='200,20,40,255'&&surface.store.pixel(8,10).join(',')==='127,5,249,1'};
  });
  for(const [name,value] of Object.entries(pose))check('paste: '+name,value);
  const copied=await page.evaluate(async()=>{
    const {e,d,target,surface}=await freshDrawing();
    const pixels=new Uint8ClampedArray(64*64*4);pixels.set([127,5,249,1],(30*64+30)*4);e.commitDrawingPixels(target,[{tx:0,ty:0,before:null,after:pixels}]);
    await d.makeSelection({target:e.drawingTarget(),surface,points:[{x:28,y:28},{x:32,y:28},{x:32,y:32},{x:28,y:32}]});d.selection.angle=90;d.selection.dx=100;
    await d.action('copy-pixels');const clip=e._drawingPixelClipboard,exact=clip.version===2;
    d.cancelSelection();await d.action('paste-pixels');
    const copied=exact&&surface.store.pixel(129,30).join(',')==='127,5,249,1'&&surface.store.pixel(30,30).join(',')==='127,5,249,1';
    e.undo();await d.makeSelection({target:e.drawingTarget(),surface,points:[{x:28,y:28},{x:32,y:28},{x:32,y:32},{x:28,y:32}]});await d.action('cut-pixels');
    const cut=surface.store.pixel(30,30)[3]===0&&!d.operation&&!d.selection;e.undo();return copied&&cut&&surface.store.pixel(30,30).join(',')==='127,5,249,1';
  });
  check('transformed copy and cut preserve low-alpha colors, world placement and exact undo',copied);
  // Hold a real worker reply to exercise the editor barrier and queued pointer.
  await page.evaluate(async()=>{
    const {e,d,target}=await freshDrawing();e.commitDrawingPixels(target,[{tx:0,ty:0,before:null,after:new Uint8ClampedArray([12,34,56,255])}]);
    window.oldRequest=d.owner.worker.request.bind(d.owner.worker);d.owner.worker.request=async(kind,...args)=>{const result=await oldRequest(kind,...args);if(kind==='resample'){window.replyHeld=true;await new Promise(resolve=>window.releaseReply=resolve);}return result;};
    d.settings.resolution=2;window.resample=d.action('resample');resample.catch(()=>{});window.saved=false;
  });
  await page.waitForFunction(()=>window.replyHeld);
  await page.evaluate(()=>{window.saving=styk.drawing.barrier().then(()=>window.saved=true);});
  check('save waits for a pending resample commit',await page.evaluate(()=>!saved&&!!styk.drawing.operation));
  const rect=await page.locator('#viewport').boundingBox(),x=rect.x+rect.width*.4,y=rect.y+rect.height*.4;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+80,y,{steps:8});await page.mouse.up();
  check('a new pen or mouse stroke queues behind resampling',await page.evaluate(()=>styk.drawing.loading?.queued&&styk.drawing.loading.released&&styk.drawing.loading.samples.length>0));
  await page.evaluate(()=>releaseReply());await page.evaluate(async()=>{await resample;await saving;styk.drawing.owner.worker.request=oldRequest;});
  check('the queued stroke commits before the save barrier finishes',await page.evaluate(()=>saved&&!styk.drawing.loading&&!styk.drawing.gesture&&styk.editor._undo.at(-1).label==='Brush stroke'));
  await page.evaluate(async()=>{
    const d=styk.drawing;window.beforeCancel=styk.editor.drawingTarget().figure;window.replyHeld=false;d.owner.worker.request=async(kind,...args)=>{const result=await oldRequest(kind,...args);if(kind==='resample'){window.replyHeld=true;await new Promise(resolve=>window.releaseReply=resolve);}return result;};
    d.settings.resolution=4;window.cancelledWork=d.action('resample').then(()=>false,e=>e.name==='AbortError');
  });
  await page.waitForFunction(()=>window.replyHeld);
  await page.evaluate(()=>{styk.drawing.cancel();releaseReply();});
  check('cancelled resample never publishes its late worker reply',await page.evaluate(async()=>await cancelledWork&&styk.editor.drawingTarget().figure===beforeCancel&&!styk.drawing.operation));
  await page.evaluate(()=>{styk.drawing.owner.worker.request=oldRequest;});
  const dense=await page.evaluate(async()=>{
    const {e,d,target}=await freshDrawing(),tiles=[];for(let ty=0;ty<34;ty++)for(let tx=0;tx<60;tx++)tiles.push({tx,ty,before:null,after:new Uint8ClampedArray([tx*4,ty*7,120,255])});
    e.commitDrawingPixels(target,tiles);await d.barrier();d.settings.filter='smooth';d.settings.resolution=2;
    const gaps=[];let last=performance.now();const timer=setInterval(()=>{const now=performance.now();gaps.push(now-last);last=now;},5),start=performance.now();
    try{await d.action('resample');const ms=performance.now()-start,store=(await d.owner.surface(e.drawingTarget().figure)).store;return {ms,tiles:store.size,bounds:store.bounds,pixel:store.pixel(100,100),ticks:gaps.length,maxGapMs:Math.max(...gaps),workingBytes:d.owner.workingBytes};}finally{clearInterval(timer);}
  });
  console.log(JSON.stringify({dense}));
  check('smooth 4K to 8K resampling exceeds 16MP without a dense canvas',dense.bounds.width*dense.bounds.height>16*1024*1024&&dense.tiles>8000&&dense.pixel.join(',')==='0,0,120,255');
  check('the UI event loop runs during large worker transforms',dense.ticks>10);
  await page.locator('[data-section="Resolution"] > summary').click();await page.getByLabel('Pixel filtering',{exact:true}).selectOption('nearest');
  check('pixel-art filtering is selectable in Properties',await page.evaluate(()=>styk.drawing.settings.filter==='nearest'));
  await page.evaluate(()=>{styk.fit();});await page.waitForTimeout(500);await page.screenshot({path:out+'/workspace.png'});
  check('no uncaught browser errors',errors.length===0);
  await writeFile(out+'/result.json',JSON.stringify({checks,sparse,pose,dense,errors,browser:await browser.version()},null,2));console.log(JSON.stringify({sparse,dense},null,2));
}finally{await browser.close();}
