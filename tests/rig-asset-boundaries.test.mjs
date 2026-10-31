import test from 'node:test';
import assert from 'node:assert/strict';
import {RIG_EXAMPLES,rigExampleDocument} from '../src/rig-examples.mjs';
import {SOLID_RIG_EXAMPLES} from '../src/rig-solids.mjs';
import {geometryOfDocument} from './support/engine-geometry.mjs';

const visiblePose=document=>{
  const g=geometryOfDocument(document).objects.get(0);
  return {
    joints:[...g.joints],
    segments:g.segments.map(s=>({start:s.start,end:s.end,angle:s.angle,length:s.length,width:s.width,rgb:s.rgb,alpha:s.alpha})),
    polygons:g.polys.map(p=>({points:p.points,rgb:p.rgb,alpha:p.alpha,culled:p.culled})),
  };
};
test('all example poses evaluate identically without any preset identity or control metadata',()=>{
  for(const example of RIG_EXAMPLES){
    const poses=[];
    for(const amount of [0,.35,.7]){
      const document=rigExampleDocument(example.id),figure=document.figure_types[0],object=document.keyframes[0].objects[0];
      const controls=example.build?.().controls??[{handle:example.control,channel:'angle'}];
      object.len_flag=1;object.lengths=figure.segments.map(s=>s.length);
      for(const c of controls){
        const i=figure.segments.findIndex(s=>s.segment_id===c.handle);
        if(c.channel==='angle')object.angles[i]+=amount*Math.PI;
        else object.lengths[i]=c.channel==='slide'?.2+amount:object.lengths[i]*(1+amount);
      }
      const expected=visiblePose(document),ordinary=structuredClone(document);
      delete ordinary.figure_types[0]._styk.rigExample;ordinary.figure_types[0].name='User construction';
      assert.deepEqual(visiblePose(ordinary),expected,`${example.name} at ${amount}`);poses.push(expected);
    }
    assert.notDeepEqual(poses[0].joints,poses[1].joints,`${example.name} exercises actual motion`);
  }
});
test('surface rendering extensions are confined to the five opaque solids',()=>{
  const solids=new Set(SOLID_RIG_EXAMPLES.map(r=>r.id));
  for(const example of RIG_EXAMPLES){
    const figure=rigExampleDocument(example.id).figure_types[0];
    assert.equal(figure.polyfills.some(p=>p._stykSurface!==undefined),solids.has(example.id),example.name);
    assert.equal(figure.image_assets.length,0);assert.equal(figure.text_assets.length,0);
  }
});
