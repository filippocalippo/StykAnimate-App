import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Editor} from '../src/editor.mjs';
import {editorBuilderMethods} from '../src/editor-builder.mjs';
import {builderDrawables,builderStyleTargets,reorderBuilderDrawables} from '../src/editor-builder-style.mjs';
import {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit,cancelNativePropertyEdit,getNativePropertyValue} from '../src/native-property-edit.mjs';
import {defaultFigure,createObject} from '../src/demo.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import backend from '../desktop/backend.cjs';
Object.assign(Editor.prototype,editorBuilderMethods);
function fixture(){
  const editor=new Editor({demo:false}),figure=defaultFigure(201);
  figure.name='Order fixture';
  figure.segments=figure.segments.slice(0,4).map((segment,index)=>({...segment,segment_id:[11,22,33,44][index],parent_id:[0,11,22,0][index],z_order:[1,3,5,6][index]}));
  figure.segment_count=4;
  figure.polyfills=[{polyfill_id:1,segment_ids:[0,11,22],segment_ids_raw:[0,11,22],color_rgb:[20,80,200],color_alpha:1,alpha_raw:0,z_order:2},
    {polyfill_id:2,segment_ids:[0,22,44],segment_ids_raw:[0,22,44],color_rgb:[220,80,20],color_alpha:1,alpha_raw:0,z_order:4}];
  editor.importFigure(figure);editor.select(editor.selectedUid,0);editor._undo=[];editor._redo=[];
  editor.figure.image_assets=[{kind:'image',data_url:'data:image/png;base64,'+'A'.repeat(1024*1024)}];
  return editor;
}
const order=editor=>builderDrawables(editor.figure).map(entry=>`${entry.kind==='segment'?'s':'p'}${entry.index}`);
const command=(editor,key,value,options)=>{const token=beginNativePropertyEdit(editor,key,options);previewNativePropertyEdit(token,value);commitNativePropertyEdit(token);};
test('native mixed sequence front/back and one-step movement keep both sets stable',()=>{
  const e=fixture(),original=order(e);assert.deepEqual(original,['s0','p0','s1','p1','s2','s3']);
  e.moveBuilderOrder({kind:'polygon',index:0},'up');assert.deepEqual(order(e),['s0','s1','p0','p1','s2','s3']);
  e.undo();assert.deepEqual(order(e),original);e.redo();
  e.moveBuilderOrder({kind:'polygon',index:0},'back');assert.equal(order(e)[0],'p0');
  e.moveBuilderOrder({kind:'segment',index:0},'front',{branch:true});assert.deepEqual(order(e),['p1','s3','p0','s0','s1','s2']);
  const n=e._undo.length;e.moveBuilderOrder({kind:'segment',index:0},'front',{branch:true});assert.equal(e._undo.length,n);
});
test('native branch includes pivot and descendant-only polygons, not crossing polygons',()=>{
  const e=fixture();assert.deepEqual(builderStyleTargets(e.figure,{kind:'segment',index:0},{branch:true}).map(x=>`${x.kind}:${x.index}`),['segment:0','polygon:0','segment:1','segment:2']);
  const entries=builderDrawables(e.figure),targets=builderStyleTargets(e.figure,{kind:'segment',index:0},{branch:true});
  const raised=reorderBuilderDrawables(entries,targets,{delta:2});
  assert.deepEqual(raised.map(x=>`${x.kind[0]}${x.index}`),['p1','s3','s0','p0','s1','s2']);
});
test('numeric order is one-based, branch delta is relative and boundary-clamped',()=>{
  const e=fixture();e.select(e.selectedUid,1);
  assert.equal(getNativePropertyValue(e,'segment_z_order'),3);
  command(e,'segment_z_order',4,{branch:true});assert.deepEqual(order(e),['s0','p0','p1','s1','s3','s2']);
  e.undo();assert.deepEqual(order(e),['s0','p0','s1','p1','s2','s3']);
  const before=structuredClone(e.figure),history=e._undo.length;
  for(const value of [0,7,2.5,NaN,Infinity]){
    const token=beginNativePropertyEdit(e,'segment_z_order');assert.throws(()=>previewNativePropertyEdit(token,value));cancelNativePropertyEdit(token);
  }
  assert.deepEqual(e.figure,before);assert.equal(e._undo.length,history);
});
test('repeated live previews start at the captured order and cancel restores raw metadata',()=>{
  const e=fixture();e.figure.segment_z_raw=[9,7,5,3];e.figure.poly_z_raw=[8,4];
  const before=structuredClone(e.figure),token=beginNativePropertyEdit(e,'polygon_0_z_order');
  previewNativePropertyEdit(token,6);assert.equal(order(e).at(-1),'p0');
  previewNativePropertyEdit(token,1);assert.equal(order(e)[0],'p0');
  previewNativePropertyEdit(token,2);assert.deepEqual(e.figure,before);
  cancelNativePropertyEdit(token);assert.deepEqual(e.figure,before);assert.equal(e._undo.length,0);
});
test('polygon alpha and ordering history retain source frames/assets and stay small',()=>{
  const e=fixture(),frames=e.report.keyframes,frame=e.frame,objects=frame.objects,assets=e.figure.image_assets;
  e.report._styk.frameSources={source:{...frame,objects:frame.objects.map(o=>({...o}))}};
  const retained=e.report._styk.frameSources.source;
  command(e,'polygon_0_opacity',25);assert.equal(e.figure.polyfills[0].alpha_raw,191);
  e.moveBuilderOrder({kind:'polygon',index:0},'front');
  assert.equal(e.report.keyframes,frames);assert.equal(e.frame,frame);assert.equal(e.frame.objects,objects);assert.equal(e.report._styk.frameSources.source,retained);assert.equal(e.figure.image_assets,assets);
  assert.ok(e._undo.every(item=>item.kind==='native-properties'&&item.bytes<10000));
  e.undo();e.undo();assert.equal(e.figure.polyfills[0].alpha_raw,0);e.redo();assert.equal(e.figure.polyfills[0].alpha_raw,191);
  assert.equal(e.figure.image_assets,assets);assert.equal(e.report._styk.frameSources.source,retained);
});
test('tied authored records stay untouched on no-op and reorder deterministically',()=>{
  const e=fixture();e.figure.segments.forEach(s=>s.z_order=1);e.figure.polyfills.forEach(p=>p.z_order=1);
  const before=structuredClone(e.figure);e.moveBuilderOrder({kind:'segment',index:3},'front');assert.deepEqual(e.figure,before);
  e.moveBuilderOrder({kind:'polygon',index:0},'front');assert.deepEqual(order(e),['p1','s0','s1','s2','s3','p0']);
  e.undo();assert.deepEqual(e.figure,before);
});
test('document validation rejects malformed order and polygon alpha before rendering',()=>{
  const e=fixture();
  for(const mutate of [f=>f.segments[0].z_order=Infinity,f=>f.segments[0].z_order=1e50,
    f=>f.polyfills[0].z_order=NaN,f=>f.polyfills[0].color_alpha=-.1,f=>f.polyfills[0].color_alpha=1.1]){
    const report=structuredClone(e.report);mutate(report.figure_types.find(f=>f.figure_type_id===e.figure.figure_type_id));
    assert.throws(()=>validateScene(report),/order|opacity|native|finite|float32/i);
  }
  assert.doesNotThrow(()=>validateScene(e.report));
});
test('actual PIV and STK encoders retain mixed order and polygon alpha',()=>{
  const e=fixture();e.figure.image_assets=[];e.moveBuilderOrder({kind:'segment',index:1},'back',{branch:true});e.setPolygonOpacity(0,.4);
  const expected=order(e),python=String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
document=json.load(sys.stdin)
store=server.ProjectStore(server.WORKSPACE)
result={}
for kind in ('piv','stk'):
 raw,name=store.export({'document':document,'format':kind,'figureTypeId':document['figure_types'][-1]['figure_type_id']})
 reopened=store.import_bytes(raw,name)['document']
 result[kind]=next(f for f in reopened['figure_types'] if len(f.get('polyfills',[]))==2)
print(json.dumps(result))
`;
  const candidate=backend.pythonCandidates()[0],r=spawnSync(candidate.command,[...candidate.args,'-c',python],{cwd:fileURLToPath(new URL('..',import.meta.url)),input:JSON.stringify(e.serialize()),encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});
  assert.equal(r.status,0,r.error?.message||r.stderr);const reopened=JSON.parse(r.stdout);
  for(const figure of Object.values(reopened)){assert.deepEqual(builderDrawables(figure).map(entry=>`${entry.kind==='segment'?'s':'p'}${entry.index}`),expected);assert.equal(figure.polyfills[0].alpha_raw,153);}
});
