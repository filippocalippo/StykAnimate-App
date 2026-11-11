import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {figurePalette,displayedSegmentPaint} from '../src/figure-colors.mjs';
import {resolveInstanceFigure} from '../src/animation-style.mjs';
import {storedFrameReport} from '../src/pivot-frame-draft.mjs';
import {ownedScope} from './support/owned-scope.mjs';
import {geometryOfDocument} from './support/engine-geometry.mjs';
import {pivotDocument} from './support/engine-export.mjs';

const open = ownedScope();

function fixture({version=5,raw=0,layerTimeline=true,propertyChannels=true,prepare=null}={}){
  const report=emptyDocument();report.version=version;report.frame_delay_ms=40;
  const figure=report.figure_types[0];figure.segments=figure.segments.slice(0,4).map((s,i)=>({...s,segment_id:i+1,parent_id:i,length:40,thickness:5,primitive_code:0,segment_type:'line',segment_kind:'line',color_rgb:i===2?[10,20,30]:[200,40,50],secondary:null,paint:undefined}));
  delete figure.segment_decode;figure.polyfills=[];
  report.keyframes=[0,1,2].map(i=>createFrame([createObject(figure,1,100+i*10,200,{color_override_raw:raw}),createObject(figure,2,250,200,{color_override_raw:raw})],10));
  prepare?.(report);
  const e=open({demo:false,layerTimeline,propertyChannels}, report);e.select(1);return e;
}
const palette=e=>e.figurePalette().map(p=>[p.color,p.segments.length]);
const colors=e=>e.geometry.objects.get(e.selectedSlot).segments.map(s=>s.rgb);

test('attached palette preserves instance membership and undo',()=>{
  const settings={layerTimeline:true};
  const report=fixture().serialize(), child=structuredClone(report.figure_types[0]);
  child.figure_type_id=2;child.segments.forEach(s=>s.color_rgb=[10,20,30]);
  child.segments[0].secondary={rgb:[200,40,50],a:77};
  child.polyfills=[{polyfill_id:7,segment_ids:[0,1,2],color_rgb:[200,40,50],alpha_raw:33,z_order:1}];
  report.figure_types.push(child);
  report.keyframes=report.keyframes.map(()=>createFrame([
    createObject(report.figure_types[0],1,100,200),
    createObject(child,2,140,200,{join:{target_object_slot:0,target_handle_id:1}}),
    createObject(child,3,180,200,{join:{target_object_slot:1,target_handle_id:1}}),
    createObject(child,4,300,200),
  ],10));
  delete report._styk;
  const e=open({demo:false,...settings}, report);e.select(1);
  assert.deepEqual(palette(e),[['#0a141e',9],['#c82832',5]]);
  const entry=e.figurePalette().find(row=>row.color==='#c82832');
  assert.equal(entry.polygons.length,2);
  const unrelated=structuredClone(e.selectionFrame.objects[3]);
  e.replaceFigureColor(entry.color,'#0a141e',{targets:entry});
  assert.deepEqual(palette(e),[['#0a141e',12]]);assert.equal(e._undo.length,1);
  e.replaceFigureColor(entry.color,'#778899',{targets:entry});
  assert.deepEqual(palette(e),[['#0a141e',9],['#778899',5]]);
  assert.deepEqual(e.selectionFrame.objects[3],unrelated);
  const resolved=resolveInstanceFigure(child,e.selectionFrame.objects[1]);
  assert.deepEqual(resolved.polyfills[0].color_rgb,[119,136,153]);
  assert.deepEqual(resolved.segments[0].color_rgb,[10,20,30]);
  assert.deepEqual(resolved.segments[0].secondary.rgb,[119,136,153]);
  const reopened=open({demo:false,...settings},JSON.parse(JSON.stringify(e.serialize())));reopened.select(1);
  assert.deepEqual(palette(reopened),palette(e));
  e.undo();e.undo();assert.deepEqual(palette(e),[['#0a141e',9],['#c82832',5]]);
  e.redo();assert.deepEqual(palette(e),[['#0a141e',12]]);
  e.select(2);assert.deepEqual(palette(e),[['#0a141e',8]]);
  e.select(1,0);assert.deepEqual(palette(e),[['#0a141e',4]]);
});

for(const version of [2,3,4,5])test(`Pivot ${version}: whole figure, node, whole figure, palette, undo and reopen`,()=>{
  const e=fixture({version,raw:version<5?196:0}),definitions=structuredClone(e.report.figure_types);
  const other=structuredClone(e.evaluatedFrame.objects[1]);
  e.setFigureColor('#44aacc');assert.deepEqual(palette(e),[['#44aacc',4]]);
  e.select(1,0);e.updateBuilderSegmentStyle({color:'#eecc11'});
  assert.deepEqual(palette(e),[['#44aacc',3],['#eecc11',1]]);
  assert.deepEqual(colors(e),[[238,204,17],[68,170,204],[68,170,204],[68,170,204]]);
  e.setFigureColor('#9933ee');assert.deepEqual(palette(e),[['#9933ee',4]]);
  e.undo();assert.equal(e._undo.length,2);assert.deepEqual(palette(e),[['#44aacc',3],['#eecc11',1]]);
  e.replaceFigureColor('#44aacc','#222222');assert.deepEqual(palette(e),[['#222222',3],['#eecc11',1]]);
  const saved=e.serialize(),reopened=open({demo:false,layerTimeline:true,propertyChannels:true},JSON.parse(JSON.stringify(saved)));reopened.select(1);
  assert.deepEqual(colors(reopened),colors(e));assert.deepEqual(e.report.figure_types,definitions);
  assert.deepEqual(e.evaluatedFrame.objects[1],other);
  e.undo();e.redo();assert.deepEqual(palette(e),[['#222222',3],['#eecc11',1]]);
});

test('legacy source colors are read from the object, including negative black',()=>{
  for(const raw of [0,196,0x0033cc,0xffffffff]){
    const e=fixture({version:4,raw});assert.deepEqual(e.figurePalette()[0].color,raw===196?'#c40000':raw===0x0033cc?'#cc3300':'#000000');
    e.select(1,2);e.updateBuilderSegmentStyle({color:'#123456'});
    assert.deepEqual(colors(e)[0],raw===196?[196,0,0]:raw===0x0033cc?[204,51,0]:[0,0,0]);assert.deepEqual(colors(e)[2],[18,52,86]);
  }
});

test('partial tint is baked once; other segment colors and alpha remain exact',()=>{
  const e=fixture({raw:0x80603020});const before=colors(e),opacities=e.figure.segments.map(s=>s.transparency);
  e.select(1,1);e.updateBuilderSegmentStyle({color:'#00ffaa'});
  assert.deepEqual(colors(e),before.map((rgb,i)=>i===1?[0,255,170]:rgb));
  assert.deepEqual(e.figure.segments.map(s=>s.transparency),opacities);assert.equal(e.object.color_override_raw,0);
});

test('all gradient stops and fills participate; each segment counts once per color',()=>{
  const e=fixture({prepare:report=>{
    const fig=report.figure_types[0];
    fig.segments[0].secondary={rgb:[10,20,30],a:77};
    fig.segments[1].paint={type:'radial',angle:25,stops:[{offset:0,color:[200,40,50],opacity:1},{offset:.5,color:[10,20,30],opacity:.5},{offset:1,color:[200,40,50],opacity:.7}]};
    fig.segments[1].secondary={rgb:[200,40,50],a:77};
    fig.polyfills=[{polyfill_id:7,segment_ids:[0,1,2],color_rgb:[10,20,30],alpha_raw:33,z_order:1}];
  }}),fig=e.figure;
  const entries=figurePalette(e.report,fig,e.object),entry=entries.find(row=>row.color==='#0a141e');
  assert.equal(entry.segments.length,3);assert.deepEqual(entry.polygons,[7]);
  e.replaceFigureColor(entry.color,'#778899');
  const resolved=resolveInstanceFigure(e.figure,e.object),paint=displayedSegmentPaint(e.report,resolved,e.object,resolved.segments[1]);
  assert.deepEqual(paint.stops[1],{offset:.5,color:[119,136,153],opacity:.5});assert.equal(paint.angle,25);
  assert.deepEqual(resolved.polyfills[0].color_rgb,[119,136,153]);assert.equal(resolved.polyfills[0].alpha_raw,33);
});

test('a picker retains its original segments after colors merge',()=>{
  const e=fixture(),entry=e.figurePalette().find(row=>row.color==='#c82832');
  e.replaceFigureColor(entry.color,'#0a141e',{targets:entry});assert.deepEqual(palette(e),[['#0a141e',4]]);
  e.replaceFigureColor(entry.color,'#778899',{targets:entry});assert.deepEqual(palette(e),[['#778899',3],['#0a141e',1]]);
});

test('clearing a full figure override does not reveal hidden gradient transparency',()=>{
  const e=fixture({raw:0xff663322,prepare:report=>{report.figure_types[0].segments[2].secondary={rgb:[255,255,255],a:255};}});
  assert.equal(e.figurePalette().length,1);e.select(1,0);e.updateBuilderSegmentStyle({color:'#aabbcc'});
  const resolved=resolveInstanceFigure(e.figure,e.object);assert.equal(resolved.segments[2].secondary,null);
  assert.deepEqual(resolved.segments[2].color_rgb,[34,51,102]);assert.equal(resolved.segments[2].transparency,0);
});

test('opacity alone preserves palette and gradients and one action makes one undo entry',()=>{
  const e=fixture(),before=palette(e);e.setFigureColor(undefined,{opacity:.5});assert.deepEqual(palette(e),before);assert.equal(e._undo.length,1);
  e.setFigureColor('#112233',{opacity:.7});assert.equal(e._undo.length,2);assert.equal(e.object.field28,77);e.undo();assert.deepEqual(palette(e),before);
});

test('range recoloring changes selected frames and preserves sibling instances',()=>{
  const e=fixture({layerTimeline:false,propertyChannels:false});e.replaceFigureColor('#c82832','#123456',{indices:[0,2]});
  const first=e.report.keyframes[0].objects[0];assert.ok(first._stykStyle);assert.equal(e.report.keyframes[1].objects[0]._stykStyle,undefined);assert.equal(e.report.keyframes[2].objects[1]._stykStyle,undefined);
  assert.equal(e._undo.length,1);e.undo();assert.equal(e.report.keyframes[0].objects[0]._stykStyle,undefined);
});

test('invalid colors and locked layers leave document and history untouched',()=>{
  const e=fixture(),before=e.serialize();assert.throws(()=>e.setFigureColor([1,2,999]));assert.throws(()=>e.replaceFigureColor('#c82832','#000000',{targets:{segments:[{handleId:1,stops:[99]}]}}));
  assert.equal(e._undo.length,0);assert.deepEqual(e.serialize(),before);
  e.setLayerLocked(e.layerForUid(1),true);assert.throws(()=>e.setFigureColor('#123456'),/unlock/);
});

test('native export materializes instance colors and preserves untouched legacy figures',()=>{
  const e=fixture({version:4,raw:196});e.select(1,0);e.updateBuilderSegmentStyle({color:'#123456'});
  const output=pivotDocument(e.serialize());
  const before=e.geometry.drawables.map(s=>s.rgb),after=geometryOfDocument(output,output.keyframes[0]).drawables.map(s=>s.rgb);
  assert.deepEqual(after,before);
});

test('layer-sheet recoloring edits held cells and cuts an interpolated boundary',()=>{
  const e=fixture();e.sheetSetEasing(['layer-1'],0,20,{interpolation:'constant'});e.seek(5);e.select(1);e.setFigureColor('#112233');
  e.seek(0);assert.deepEqual(palette(e),[['#112233',4]]);e.seek(9);assert.deepEqual(palette(e),[['#112233',4]]);
  e.seek(10);assert.notDeepEqual(palette(e),[['#112233',4]]);
  e.sheetSetEasing(['layer-1'],10,20,{interpolation:'linear'});e.seek(15);e.select(1);e.setFigureColor('#445566');
  assert.ok(e.layerFrameKeys('layer-1').some(key=>key.tick===15));assert.deepEqual(palette(e),[['#445566',4]]);
});

test('unchanged recolors do not create undo entries',()=>{
  const e=fixture();e.replaceFigureColor('#c82832','#c82832');assert.equal(e._undo.length,0);
  e.setFigureColor('#445566');const count=e._undo.length;e.setFigureColor('#445566');assert.equal(e._undo.length,count);
  e.resetFigureColors();const resetCount=e._undo.length;e.resetFigureColors();assert.equal(e._undo.length,resetCount);
});

test('reset colors preserves authored gradient layout and stop opacity',()=>{
  const e=fixture();e.select(1,0);e.updateBuilderSegmentStyle({paint:{type:'radial',angle:42,stops:[{offset:0,color:[1,2,3],opacity:.4},{offset:.3,color:[50,60,70],opacity:.2},{offset:1,color:[90,100,110],opacity:.6}]}});
  const before=displayedSegmentPaint(e.report,e.figure,e.object,resolveInstanceFigure(e.figure,e.object).segments[0]);
  e.resetFigureColors();const paint=displayedSegmentPaint(e.report,e.figure,e.object,resolveInstanceFigure(e.figure,e.object).segments[0]);
  assert.deepEqual(paint,{...before,stops:before.stops.map(stop=>({...stop,color:[200,40,50]}))});
});

test('recolored legacy instances retain their palette when copied across Pivot versions',()=>{
  for(const [from,to] of [[4,5],[5,4],[4,4]]){
    const source=fixture({version:from,raw:from<5?196:0});source.select(1,0);source.updateBuilderSegmentStyle({color:'#123456'});source.select(1);source.copySelection();
    const expected=palette(source),destination=fixture({version:to,raw:to<5?196:0});
    destination._selectionClipboard=source._selectionClipboard;destination.pasteSelection();assert.deepEqual(palette(destination),expected,`${from} to ${to}`);
  }
});

