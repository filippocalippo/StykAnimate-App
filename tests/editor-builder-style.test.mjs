import test from 'node:test';
import assert from 'node:assert/strict';
import {builderDrawables,builderStyleTargets,reorderBuilderDrawables} from '../src/editor-builder-style.mjs';
import {defaultFigure} from '../src/demo.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

/** A figure of four segments and two polygons whose drawing orders interleave. */
function orderFigure(){
  const figure=defaultFigure(201);
  figure.name='Order fixture';
  figure.segments=figure.segments.slice(0,4).map((segment,index)=>({...segment,segment_id:[11,22,33,44][index],parent_id:[0,11,22,0][index],z_order:[1,3,5,6][index]}));
  figure.segment_count=4;
  figure.polyfills=[{polyfill_id:1,segment_ids:[0,11,22],segment_ids_raw:[0,11,22],color_rgb:[20,80,200],color_alpha:1,alpha_raw:0,z_order:2},
    {polyfill_id:2,segment_ids:[0,22,44],segment_ids_raw:[0,22,44],color_rgb:[220,80,20],color_alpha:1,alpha_raw:0,z_order:4}];
  return figure;
}
test('native branch includes pivot and descendant-only polygons, not crossing polygons',()=>{
  const figure=orderFigure();
  assert.deepEqual(builderDrawables(figure).map(entry=>`${entry.kind==='segment'?'s':'p'}${entry.index}`),['s0','p0','s1','p1','s2','s3']);
  const targets=builderStyleTargets(figure,{kind:'segment',index:0},{branch:true});
  assert.deepEqual(targets.map(x=>`${x.kind}:${x.index}`),['segment:0','polygon:0','segment:1','segment:2']);
  const raised=reorderBuilderDrawables(builderDrawables(figure),targets,2);
  assert.deepEqual(raised.map(x=>`${x.kind[0]}${x.index}`),['p1','s3','s0','p0','s1','s2']);
});
test('document validation rejects malformed order and polygon alpha before rendering',()=>{
  const editor=ownedEditorFor({demo:false,layerTimeline:true,propertyChannels:true});
  editor.importFigure(orderFigure());
  for(const mutate of [f=>f.segments[0].z_order=Infinity,f=>f.segments[0].z_order=1e50,
    f=>f.polyfills[0].z_order=NaN,f=>f.polyfills[0].color_alpha=-.1,f=>f.polyfills[0].color_alpha=1.1]){
    const report=structuredClone(editor.report);mutate(report.figure_types.find(f=>f.figure_type_id===editor.figure.figure_type_id));
    assert.throws(()=>validateScene(report),/order|opacity|native|finite|float32/i);
  }
  assert.doesNotThrow(()=>validateScene(editor.report));
});
