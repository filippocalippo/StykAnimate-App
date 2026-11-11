import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {rigExampleDocument} from '../src/rig-examples.mjs';
import {MECHANISM_RIG_EXAMPLES} from '../src/rig-mechanism-examples.mjs';
import {rigAssetControls,rigAssetControlChange,rigAssetControlValues} from './helpers/example-controls.mjs';
import {geometryOfDocument} from './support/engine-geometry.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-4,`${a} != ${b}`),wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
const scene=e=>e.geometry.objects.get(0),shape=(e,id)=>scene(e).segments.find(s=>s.seg.segment_id===id);
const editorFor=id=>{const e=newOwnedEditor({demo:false});e.load(rigExampleDocument(id));e.select(1,0);return e;};
const change=(e,key,value)=>rigAssetControlChange(e,{dataset:{rigAsset:key},valueAsNumber:value});
const poses=g=>g.objects.get(0).segments.map(s=>[s.start.x,s.start.y,s.end.x,s.end.y]);

test('gears counter-rotate 1:1 through complete turns and retain their axles',()=>{
  const e=editorFor('counter-rotating-gears'),p=MECHANISM_RIG_EXAMPLES[0].build().proof,centers=[scene(e).joints.get(p.left),scene(e).joints.get(p.right)];
  for(const turn of [0,30,179,181,270,360,0]){change(e,'drive',turn);near(wrap(shape(e,p.reverse).angle),wrap(Math.PI/12-turn*Math.PI/180));assert.deepEqual([scene(e).joints.get(p.left),scene(e).joints.get(p.right)],centers);}
  change(e,'drive',60);const a=shape(e,p.reverse).angle;e.rotateFigure(.4);near(wrap(shape(e,p.reverse).angle-a),.4);
});
test('one fan control spreads nine connected ribs with independent fractional angle checks',()=>{
  const e=editorFor('folding-fan'),p=MECHANISM_RIG_EXAMPLES[1].build().proof;
  for(const open of [0,100,20,75,0]){change(e,'open',open);p.tips.forEach((id,i)=>{near(shape(e,id).angle,(-170+1.6*open*i/8)*Math.PI/180);near(shape(e,id).length,174);assert.deepEqual(shape(e,id).start,scene(e).joints.get(p.pivot));});}
});
test('accordion panel projection uses alternating fold angles with rigid uprights',()=>{
  const e=editorFor('accordion-screen-3d'),p=MECHANISM_RIG_EXAMPLES[2].build().proof;
  for(const fold of [0,38,80])for(const depth of [5,45,100]){change(e,'fold',fold);change(e,'depth',depth);
    p.bottoms.slice(1).forEach((id,i)=>{const a=scene(e).joints.get(p.bottoms[i]),b=scene(e).joints.get(id);near(b.x-a.x,91*Math.cos(fold*Math.PI/180));near(b.y-a.y,(i%2?-1:1)*91*Math.sin(fold*Math.PI/180)*depth/100);});
    p.tops.forEach((id,i)=>{const top=scene(e).joints.get(id),bottom=scene(e).joints.get(p.bottoms[i]);near(top.x,bottom.x);near(top.y,bottom.y-165);});
  }
});
test('crate width and reset depth respond oppositely without changing height',()=>{
  const e=editorFor('expanding-crate-3d'),p=MECHANISM_RIG_EXAMPLES[3].build().proof;
  for(const amount of [35,90,165,55]){change(e,'expand',amount);const a=scene(e).joints.get(p.front[0]),b=scene(e).joints.get(p.front[1]),c=scene(e).joints.get(p.front[2]);near(b.x-a.x,210*amount/100);near(c.y-b.y,136);
    p.back.forEach(id=>{near(shape(e,id).length,74*(2-amount/100));near(shape(e,id).angle,-38*Math.PI/180);});}
});
test('conveyor travel projects every corner toward the vanishing point in both dimensions',()=>{
  const e=editorFor('perspective-conveyor-3d'),p=MECHANISM_RIG_EXAMPLES[4].build().proof;
  for(const value of [0,42,95,10]){change(e,'travel',value);const center=scene(e).joints.get(p.travel);
    p.cargo.forEach((id,i)=>{const v=scene(e).joints.get(id);near(v.x-center.x,p.corners[i][0]*(1-value/100));near(v.y-center.y,p.corners[i][1]*(1-value/100));});}
});
for(const example of MECHANISM_RIG_EXAMPLES)test(`${example.name}: named controls, gesture undo, native saves and async poses`,async()=>{
  const e=editorFor(example.id),initial=e.serialize(),controls=rigAssetControls(e.figure),selection=e.selectedJoint;
  e.beginDrag('Pose asset');for(const c of controls)change(e,c.key,c.max);e.commitDrag();assert.equal(e._undo.length,1);assert.equal(e.selectedJoint,selection);
  const posed=e.serialize(),expected=poses(e.geometry);e.undo();assert.deepEqual(e.serialize(),initial);e.redo();assert.deepEqual(e.serialize(),posed);
  for(const c of controls)near(rigAssetControlValues(e)[c.key],c.max);
  for(const kind of ['styk','stkz']){const d=(await decodeDocument(await buildContainerV2(posed,kind),kind)).document;assert.equal(d.figure_types[0]._styk.rigExample.controls,undefined);assert.deepEqual(poses(geometryOfDocument(d)),expected);}
  for(const c of controls){assert.throws(()=>change(e,c.key,NaN));assert.throws(()=>change(e,c.key,c.max+1));}assert.deepEqual(e.serialize(),posed);
  e.rotateFigure(.4);for(const c of controls){near(rigAssetControlValues(e)[c.key],c.max);change(e,c.key,c.min);near(rigAssetControlValues(e)[c.key],c.min);}
});
