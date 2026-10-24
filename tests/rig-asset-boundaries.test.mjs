import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {RIG_EXAMPLES,rigExampleDocument} from '../src/rig-examples.mjs';
import {SOLID_RIG_EXAMPLES} from '../src/rig-solids.mjs';
import {inspectorView} from '../src/inspector-view.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';

const visiblePose=document=>{
  const g=buildGeometry(document,document.keyframes[0]).objects.get(0);
  return {
    joints:[...g.joints],
    segments:g.segments.map(s=>({start:s.start,end:s.end,angle:s.angle,length:s.length,width:s.width,rgb:s.rgb,alpha:s.alpha})),
    polygons:g.polys.map(p=>({points:p.points,rgb:p.rgb,alpha:p.alpha,culled:p.culled})),
  };
};
test('every saved library asset imports with ordinary figure and joint properties',async()=>{
  for(const example of RIG_EXAMPLES){
    const source=(await decodeDocument(await buildContainerV2(rigExampleDocument(example.id),'stkz'),'stkz')).document;
    const editor=new Editor({demo:false});editor.load(rigExampleDocument('sliding-carriage'));
    const object=editor.importFigure(source),figure=editor.report.figure_types.find(f=>f.figure_type_id===object.figure_type_id);
    for(const joint of [-1,figure.segments.findIndex(s=>s.segment_id===example.control)]){
      editor.select(object.unique_id,joint);const html=inspectorView({editor});
      assert.doesNotMatch(html,/data-rig-(?:asset|pose|color)|rig-solid-actions/,example.name);
      assert.match(html,joint===-1?/data-field="scale"/:figure.segments[joint]._stykRig?.connector?/id="rig-position"/:/data-field="joint_angle"/,example.name);
      if(joint!==-1)assert.match(html,figure.segments[joint]._stykRig?.connector?/id="rig-position"/:/data-field="joint_length"/,example.name);
    }
  }
});
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
