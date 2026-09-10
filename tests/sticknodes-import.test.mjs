import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {importStickNodes} from '../src/sticknodes/adapter.mjs';
import {prepareEditorLoad} from '../src/editor-load.mjs';
import {Editor} from '../src/editor.mjs';
import {buildGeometry,evaluatedFrame,timeline} from '../src/pivot/geometry.mjs';
import {movieclipTime,movieclipAsset} from '../src/movieclips.mjs';
import {sticknodesDrawables,sticknodesSpriteAsset} from '../src/sticknodes/geometry.mjs';
import {synchronizeExistingDerived} from '../src/document-normalize.mjs';
import {documentChunks,applyDocumentChunk} from '../src/document-transport.mjs';
import {exportSVG} from '../src/svg-export.mjs';
import {ImportClient} from '../src/import-client.mjs';
import {openDocument} from '../src/sticknodes/decoder/project.mjs';
import {gzipSync} from 'node:zlib';

export function syntheticNodes(){
 const i=n=>{const b=Buffer.alloc(4);b.writeInt32BE(n);return b;},f=n=>{const b=Buffer.alloc(4);b.writeFloatBE(n);return b;},color=Buffer.from([255,40,90,220]);
 const node=(root)=>Buffer.concat([Buffer.from([root?255:0]),i(root?0:7),Buffer.from([0,0,1,0]),f(0),f(0),f(1),f(root?0:80),f(root?0:80),i(4),i(4),f(root?0:30),color,i(root?1:0)]);
 return Buffer.concat([i(160),f(1),color,node(true),node(false)]);
}
const geometry=doc=>buildGeometry(doc,evaluatedFrame(doc,0,0,0));
test('raw Stick Nodes import produces editable native handles with absolute Y-down angles',async()=>{
 const bytes=syntheticNodes(),original=Buffer.from(bytes),result=await importStickNodes(bytes,{filename:'synthetic.nodes'}),doc=result.document;
 assert.equal(result.kind,'stkz');assert.deepEqual(bytes,original);prepareEditorLoad(doc);
 const object=doc.keyframes[0].objects[0],joint=geometry(doc).objects.get(0).joints.get(1);
 assert.ok(Math.abs(joint.x-(960+80*Math.cos(Math.PI/6)))<.001);assert.equal(joint.y,500);
 assert.equal(object.angles[0],-Math.PI/6);assert.deepEqual(doc.figure_types[0]._styk.sticknodes.nodeIds,[7]);
 const editor=new Editor();editor.importFigure(doc);const before=editor.object.root_x;editor.moveSelection(12,0);assert.equal(editor.object.root_x,before+12);editor.undo();assert.equal(editor.object.root_x,before);editor.redo();assert.equal(editor.object.root_x,before+12);
});
test('invalid and cancelled imports reject before changing an editor',async()=>{
 await assert.rejects(importStickNodes(syntheticNodes().subarray(0,30),{filename:'broken.nodes'}));
 const controller=new AbortController();controller.abort();await assert.rejects(importStickNodes(syntheticNodes(),{signal:controller.signal}),{name:'AbortError'});
});
test('synthetic full project retains real clip assets, sprites, text, transport and native roundtrip geometry',async()=>{
 const fixture=JSON.parse(await readFile(new URL('./sticknodes-synthetic.json',import.meta.url))),result=await importStickNodes(Buffer.from(fixture.base64,'base64'),{filename:'synthetic.stknds'}),doc=result.document;
 prepareEditorLoad(doc);const clips=doc.figure_types.filter(f=>movieclipAsset(f));assert.equal(clips.length,2);assert.ok(doc.figure_types.some(f=>f.image_assets.length));assert.ok(doc.figure_types.some(f=>f.text_assets.length));
 let transferred;for(const chunk of documentChunks(doc,{maxBytes:2048}))transferred=applyDocumentChunk(transferred,chunk);prepareEditorLoad(transferred);
 const before=geometry(doc).drawables.map(d=>[d.type,d.points]);synchronizeExistingDerived(transferred);assert.deepEqual(geometry(transferred).drawables.map(d=>[d.type,d.points]),before);
 const editor=new Editor();editor.load(transferred);editor.enterMovieclip(clips[0].figure_type_id);const duration=editor.totalTicks;editor.select(editor.evaluatedFrame.objects[0].unique_id);editor.moveSelection(4,5);editor.leaveMovieclip();editor.undo();editor.redo();assert.equal(movieclipAsset(editor.report.figure_types.find(f=>f.figure_type_id===clips[0].figure_type_id)).duration,duration);
});
test('source shape primitives use shared geometry and preserve transparent circle holes',()=>{
 const s={seg:{segment_id:1,primitive_code:3,_sticknodes:{kind:'triangle'}},obj:{scale:2},points:[],start:{x:0,y:0},end:{x:100,y:0},angle:0,length:100,thickness:20};
 assert.deepEqual(sticknodesDrawables(s)[0].points,[{x:0,y:-10},{x:0,y:10},{x:100,y:0}]);
 s.seg._sticknodes={kind:'circle',use_circle_outline:true,circle_is_hollow:true,outline:[1,2,3]};const ring=sticknodesDrawables(s)[0];assert.equal(ring.seg.segment_kind,'circleClear');assert.equal(ring.length,100);assert.equal(ring.thickness,20);
 const a=sticknodesSpriteAsset({width:40,height:20},{_sticknodesSprite:{ratio:3,pivotX:.25,pivotY:.75}});assert.equal(a.display_height,60);assert.deepEqual(a.anchor_start,{x:10,y:15});
});
test('imported figure SVG and normalization preserve its artwork',async()=>{
 const {document:doc}=await importStickNodes(syntheticNodes(),{filename:'rig.nodes'});const before=await (await exportSVG({report:doc})).text();synchronizeExistingDerived(doc);assert.equal(await (await exportSVG({report:doc})).text(),before);assert.ok(before.includes('<svg'));
});
test('native clip engine retains source FPS, loop, single and hold semantics',()=>{
 const asset={duration:20,document:{fps:10}},settings={start:5,offset:2,speed:1,mode:'loop'};
 assert.equal(movieclipTime(asset,settings,29,24),12);assert.equal(movieclipTime(asset,{...settings,mode:'single'},29,24),2);assert.equal(movieclipTime(asset,{...settings,mode:'hold'},1000,24),19);
});

const fixtureBytes=async key=>Buffer.from(JSON.parse(await readFile(new URL('./sticknodes-synthetic.json',import.meta.url)))[key],'base64');
const relabel=(bytes,version,build)=>{const out=Buffer.from(bytes);out.writeInt32BE(version);out.writeInt32BE(build,4);return out;};
function syntheticClip(nodes,version=431,build=117){
 const i=n=>{const b=Buffer.alloc(4);b.writeInt32BE(n);return b;},f=n=>{const b=Buffer.alloc(4);b.writeFloatBE(n);return b;},str=s=>Buffer.concat([i(Buffer.byteLength(s)),Buffer.from(s)]);
 return Buffer.concat([i(version),i(build),str('Synthetic clip'),i(1),i(1),i(0),i(0),i(0),i(0),i(0),i(24),i(2),Buffer.from([0,0]),i(1),str('Synthetic rig'),nodes,f(1),f(0),f(1),i(-1),i(0),i(0)]);
}
test('untested figure versions and profile combinations attempt raw and compressed decoding',async()=>{
 const nodes=await fixtureBytes('modernNodesBase64'),known=await importStickNodes(nodes,{filename:'known.nodes'});
 assert.ok(!known.warnings.some(w=>w.code==='UNVERIFIED_LAYOUT'));
 for(const [version,build] of [[500,200],[434,120],[431,118],[2147483647,2147483647]])for(const gzip of [false,true]){
  const future=relabel(nodes,version,build),original=Buffer.from(future),result=await importStickNodes(gzip?gzipSync(future):future,{filename:'future.nodes'});
  prepareEditorLoad(result.document);assert.deepEqual(geometry(result.document).drawables.map(d=>d.points),geometry(known.document).drawables.map(d=>d.points));assert.deepEqual(future,original);
  assert.ok(result.warnings.some(w=>w.code==='UNVERIFIED_LAYOUT'));const meta=result.document.figure_types[0]._styk.sticknodesImport;
  assert.equal(meta.profile,`${version}-${build}`);assert.equal(meta.layoutGuesses[0].profile,meta.profile);
  synchronizeExistingDerived(result.document);assert.ok(result.document._styk.sticknodes.layoutGuesses.length);
 }
});
test('untested full projects and movie clips use existing layouts and retain their true profiles',async()=>{
 const nodes=await fixtureBytes('modernNodesBase64'),project=await fixtureBytes('latestBase64');
 for(const [filename,bytes] of [['future.stknds',project],['future.nodemc',syntheticClip(nodes)]]){
  const known=await importStickNodes(bytes,{filename}),future=relabel(bytes,500,200),progress=[],doc=await openDocument(future,{filename,onProgress:p=>progress.push(p)});
  assert.equal(doc.version,500);assert.equal(doc.build,200);assert.equal(doc.validation.layoutMode,'best-effort');assert.equal(doc.validation.sourceEOF,future.length);assert.ok(progress.some(p=>p.phase.includes('untested')));
  const result=await importStickNodes(gzipSync(future),{filename});prepareEditorLoad(result.document);
  assert.equal(result.kind,known.kind);assert.equal(result.document.figure_types.length,known.document.figure_types.length);assert.equal(result.document.keyframes.length,known.document.keyframes.length);
  assert.deepEqual(geometry(result.document).drawables.map(d=>d.points),geometry(known.document).drawables.map(d=>d.points));assert.ok(result.warnings.some(w=>w.code==='UNVERIFIED_LAYOUT'));
 }
});
test('known containers also attempt untested independently versioned embedded figures',async()=>{
 const bytes=await fixtureBytes('latestBase64'),source=await openDocument(bytes,{filename:'known.stknds'});
 for(const figure of source.figures){bytes.writeInt32BE(500,figure.dataRange.start);bytes.writeInt32BE(200,figure.dataRange.start+4);}
 const result=await importStickNodes(bytes,{filename:'mixed.stknds'});prepareEditorLoad(result.document);
 assert.equal(result.document._styk.sticknodes.profile,'431-117');assert.deepEqual(result.document._styk.sticknodes.layoutGuesses,[{format:'nodes',profile:'500-200',assumption:'existing-version-branches'}]);
 assert.ok(result.warnings.some(w=>w.code==='UNVERIFIED_LAYOUT'));
});
test('best-effort attempts still reject incompatible bodies, corrupt counts, references and trailing bytes',async()=>{
 const project=relabel(await fixtureBytes('latestBase64'),500,200),source=await openDocument(project,{filename:'future.stknds'}),editor=new Editor(),before=editor.serialize();
 const badCount=Buffer.from(project);badCount.writeInt32BE(2147483647,source.sections[1].start);
 const badReference=Buffer.from(project);badReference.writeInt32BE(999999,source.frames[0].instances[0].range.start+4);
 for(const bytes of [project.subarray(0,project.length-1),Buffer.concat([project,Buffer.from([7])]),badCount,badReference])await assert.rejects(importStickNodes(bytes,{filename:'future.stknds'}),e=>!e.code?.startsWith('UNSUPPORTED_'));
 const badNode=relabel(await fixtureBytes('modernNodesBase64'),500,200);badNode[16]=99;await assert.rejects(importStickNodes(badNode,{filename:'future.nodes'}));
 const clip=syntheticClip(await fixtureBytes('modernNodesBase64'),500,200);await assert.rejects(importStickNodes(Buffer.concat([clip,Buffer.from([7])]),{filename:'future.nodemc'}),{code:'TRAILING_MOVIECLIP_BYTES'});
 assert.deepEqual(editor.serialize(),before);
});
test('rig duplication, deletion and undo keep per-pose imported shape metadata attached to handles',async()=>{
 const {document:doc}=await importStickNodes(syntheticNodes(),{filename:'rig.nodes'});doc.keyframes[0].objects[0]._sticknodesShapes={1:{kind:'rounded-segment',sagitta:15}};
 const editor=new Editor();editor.load(doc);editor.select(1,0);editor.duplicateSegment();assert.equal(Object.keys(editor.object._sticknodesShapes).length,2);
 editor.select(1,0);editor.deleteSegment();assert.equal(Object.keys(editor.object._sticknodesShapes).length,1);editor.undo();assert.equal(Object.keys(editor.object._sticknodesShapes).length,2);editor.redo();prepareEditorLoad(editor.report);
});

test('Set Origin preserves imported asymmetric artwork, curves and per-pose shapes',async()=>{
 const shapes=[{kind:'triangle',right_triangle_direction:1},{kind:'ellipse',half_arc:true},{kind:'trapezoid',sagitta:15,trapezoid_is_rounded_start:true},{kind:'rounded-segment',sagitta:20},{kind:'segment',connector:true,drawRatio:1.5,drawLength:120}];
 const points=doc=>geometry(doc).drawables.flatMap(d=>d.points.map(p=>[Math.round(p.x*1000),Math.round(p.y*1000)])).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 for(const shape of shapes)for(const override of [false,true]){
  const {document:doc}=await importStickNodes(syntheticNodes(),{filename:'rig.nodes'}),seg=doc.figure_types[0].segments[0];
  seg.primitive_code=shape.kind==='rounded-segment'?0:shape.kind==='segment'?6:3;seg._sticknodes=shape;
  if(override)doc.keyframes[0].objects[0]._sticknodesShapes={1:{...shape,sagitta:shape.sagitta?shape.sagitta*2:undefined}};
  const editor=new Editor();editor.load(doc);editor.select(1,0);const before=points(editor.report);editor.setOrigin(1);
  assert.deepEqual(points(editor.report),before,`${shape.kind}, override=${override}`);prepareEditorLoad(editor.report);
  editor.undo();assert.deepEqual(points(editor.report),before);editor.redo();assert.deepEqual(points(editor.report),before);
 }
});

test('legacy embedded RGB backgrounds survive conversion and native normalization',async()=>{
 const fixture=JSON.parse(await readFile(new URL('./sticknodes-synthetic.json',import.meta.url))),result=await importStickNodes(Buffer.from(fixture.legacyBase64,'base64'),{filename:'legacy.stknds'});
 const doc=result.document,bg=doc.backgrounds.find(b=>b.kind===1);assert.ok(bg?.data_url.startsWith('data:image/png;base64,iVBOR'));assert.equal(bg.width,1);assert.equal(bg.height,1);
 assert.equal(doc.keyframes[0].background_id,bg.background_id);assert.ok(result.warnings.some(w=>w.code==='LEGACY_BACKGROUND_FIT'));
 synchronizeExistingDerived(doc);prepareEditorLoad(doc);assert.equal(doc.backgrounds.find(b=>b.kind===1).data_url,bg.data_url);
});

function mockImportWorker(t){
 const original=globalThis.Worker;
 globalThis.Worker=class extends EventTarget{messages=[];postMessage(m){this.messages.push(m);}terminate(){}reply(data){this.dispatchEvent(new MessageEvent('message',{data}));}};
 t.after(()=>{if(original===undefined)delete globalThis.Worker;else globalThis.Worker=original;});
 const client=new ImportClient({baseURL:'http://localhost',timeoutMs:1000});t.after(()=>client.dispose());return client;
}
test('worker progress and cancellation cannot complete or replace the next import',async t=>{
 const client=mockImportWorker(t),progress=[],request=client.importFile(new File([syntheticNodes()],'a.nodes'),{entryIndex:3,onProgress:p=>progress.push(p)}),rejected=assert.rejects(request,{name:'AbortError'});
 await new Promise(r=>setImmediate(r));const first=client.worker.messages[0];assert.equal(first.entryIndex,3);
 client.worker.reply({id:first.id,progress:{phase:'Parsing',progress:.2}});assert.equal(progress.length,1);assert.equal(client.pending.size,1);
 client.cancelPending();await rejected;const next=client.importFile(new File([syntheticNodes()],'b.nodes'));await new Promise(r=>setImmediate(r));const second=client.worker.messages.at(-1);
 client.worker.reply({id:first.id,ok:true,result:{filename:'stale.nodes'}});assert.equal(client.pending.size,1);
 client.worker.reply({id:second.id,ok:true,result:{filename:'b.nodes'}});assert.equal((await next).filename,'b.nodes');assert.equal(client.pending.size,0);
});
test('cancelling while file bytes are being read never dispatches stale decoding work',async t=>{
 const client=mockImportWorker(t);let finish;const request=client.importFile({name:'a.stknds',size:16,arrayBuffer:()=>new Promise(r=>finish=r)}),rejected=assert.rejects(request,{name:'AbortError'});
 client.cancelPending();finish(new ArrayBuffer(16));await rejected;assert.equal(client.worker.messages.length,0);
});
