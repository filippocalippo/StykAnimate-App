import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('.'),out=path.resolve(process.env.STYK_PIXEL_CLIPBOARD_ARTIFACTS||'artifacts/drawing-clipboard'),profile=path.join(out,`profile-${Date.now()}`),checks=[],errors=[];
await mkdir(profile,{recursive:true});
await writeFile(path.join(profile,'stats-state.json'),JSON.stringify({v:1,enabled:false,noticeSeen:true}));
const env={...process.env,STYK_USER_DATA_DIR:profile,STYK_LIBRARY_DIR:path.join(profile,'library')};delete env.ELECTRON_RUN_AS_NODE;
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
const applications=[],app=await electron.launch({args:[root],cwd:root,env,timeout:45000});applications.push(app);
const sink=async application=>application.evaluate(async({clipboard},{file})=>{
  const fs=process.getBuiltinModule('node:fs');globalThis.pixelClipboardTest={fail:false,writes:0};
  clipboard.writeBuffer=(_format,bytes)=>{if(pixelClipboardTest.fail)throw Error('Injected native publication failure');fs.writeFileSync(file,bytes);pixelClipboardTest.writes++;};
  clipboard.readBuffer=()=>fs.existsSync(file)?fs.readFileSync(file):Buffer.alloc(0);
},{file:path.join(profile,'clipboard-fixture.bin')});
try{
  const first=await app.firstWindow();first.on('pageerror',error=>errors.push(error.message));await first.waitForFunction(()=>window.styk?.ready,undefined,{timeout:45000});
  // Keep real preload, trusted IPC and native transfer services in two desktop
  // processes. Substitute only the OS sink with a shared test file.
  await sink(app);
  const setup=page=>page.evaluate(async()=>{
    const {emptyDocument}=await import('/src/demo.mjs'),{SharedClipboard}=await import('/src/shared-clipboard.mjs');
    const e=styk.editor,d=styk.drawing;styk.state.settings.autosaveSeconds=0;e.load(emptyDocument());e.createDrawingLayer();void e.drawingResources;d.bind();d.settings.resolution=1;d.settings.filter='nearest';
    window.shared=new SharedClipboard(e,stykDesktop);d.getClipboard=()=>shared;
  });
  await setup(first);
  const packet=await first.evaluate(async()=>{
    const e=styk.editor,d=styk.drawing,target=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:0,y:0}}),surface=await d.owner.surface(target.figure);
    e.commitDrawingPixels(target,[{tx:-100000,ty:0,before:null,after:new Uint8ClampedArray([127,5,249,1])},{tx:100000,ty:0,before:null,after:new Uint8ClampedArray([20,40,60,255])}]);
    await d.barrier();await d.makeSelection({target:e.drawingTarget(),surface,points:[{x:-6400000,y:0},{x:6400064,y:0},{x:6400064,y:64},{x:-6400000,y:64}]});d.selection.dx=128;
    await d.action('copy-pixels');return{version:e._drawingPixelClipboard.version,tiles:e._drawingPixelClipboard.tiles.length,id:shared.id};
  });
  check('source window publishes a sparse packet through native IPC',packet.version===2&&packet.tiles===2&&!!packet.id);
  const secondApp=await electron.launch({args:[root],cwd:root,env:{...env,STYK_USER_DATA_DIR:path.join(profile,'destination')},timeout:45000});applications.push(secondApp);
  const second=await secondApp.firstWindow();second.on('pageerror',error=>errors.push(error.message));await second.waitForFunction(()=>window.styk?.ready,undefined,{timeout:45000});await sink(secondApp);await setup(second);
  const pasted=await second.evaluate(async()=>{
    const e=styk.editor,d=styk.drawing;await d.action('paste-pixels');const surface=await d.owner.surface(e.drawingTarget().figure),obj=e.drawingTarget().object;
    // New cel origin comes from the clipboard's world-space bounds.
    const exact=surface.store.size===2&&surface.store.pixel(0,0).join(',')==='127,5,249,1'&&surface.store.pixel(12800000,0).join(',')==='20,40,60,255';
    const world=e._drawingPixelClipboard.world;await d.history('undo');const undone=!e.drawingTarget().figure;await d.history('redo');
    return {exact,undone,redone:surface.store.pixel(12800000,0).join(',')==='20,40,60,255',world,id:shared.id,object:obj.position??null};
  });
  check('a separate renderer restores exact sparse pixels and one undo/redo',pasted.id===packet.id&&pasted.exact&&pasted.undone&&pasted.redone&&pasted.world.x===-6399872);
  await app.evaluate(()=>{pixelClipboardTest.fail=true;});
  const failed=await first.evaluate(async()=>{
    const e=styk.editor,d=styk.drawing,s=d.selection,revision=e.revision,undo=e._undo.length;let message;
    try{await d.action('cut-pixels');}catch(error){message=error.message;}
    return {message,intact:e.revision===revision&&e._undo.length===undo&&s.surface.store.pixel(-6400000,0).join(',')==='127,5,249,1',selected:d.selection===s,busy:!!d.operation};
  });
  check('native publication failure preserves cut artwork, selection and history',failed.message?.includes('Injected native')&&failed.intact&&failed.selected&&!failed.busy);
  const writes=await app.evaluate(()=>pixelClipboardTest.writes);check('failed overwrite preserves the last complete native packet',writes===1);
  check('desktop renderers have no uncaught errors',errors.length===0);
  await writeFile(path.join(out,'desktop-result.json'),JSON.stringify({checks,packet,pasted,writes,errors,osClipboard:'Shared fixture file; OS clipboard untouched and not certified by this test.'},null,2));
}finally{for(const application of applications)await application.evaluate(({app})=>app.exit(0)).catch(()=>{});}
