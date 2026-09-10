import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateIKPose} from '../src/ik-evaluation.mjs';
import {solveObjectIK} from '../src/ik.mjs';

function fixture() {
  const figure = {segments:[
    {segment_id:1,parent_id:0,length:90,bend_rad:0},
    {segment_id:2,parent_id:1,length:90,bend_rad:0},
    {segment_id:3,parent_id:2,length:35,bend_rad:0},
  ]};
  const object = {scale:1,angles:[.8,2,0],_stykIK:{2:{enabled:true,pinned:true,chainLength:2,bendDirection:0,
    target:{x:65,y:115,rotation:0},followers:{3:0}}}};
  return {report:{}, figure, object, root:{x:0,y:0}};
}

test('appearance edits reuse the same IK solution without depending on object identity', () => {
  const {report,figure,object,root} = fixture();
  const before = evaluateIKPose(report,'local:1',figure,object,root);
  figure.segments[1].thickness = 40; figure.segments[2].color_rgb = [255,0,0];
  object.field28 = 100; object._stykStyle = {outlineWidth:12};
  assert.equal(evaluateIKPose(report,'local:1',structuredClone(figure),structuredClone(object),{...root}),before);
});

test('every pose dependency invalidates the cached solution, including in-place controller and topology edits', () => {
  for (const mutate of [
    ({root}) => root.x++, ({object}) => object.scale *= 1.1,
    ({object}) => object.angles[0] += .1,
    ({figure}) => figure.segments[0].length++, ({figure}) => figure.segments[0].bend_rad += .1,
    ({object}) => {object.len_flag=1;object.lengths=[80,90,35];},
    ({object}) => {object.bend_flag=1;object.bends=[.1,0,0];},
    ({object}) => object._stykIK[2].target.x++, ({object}) => object._stykIK[2].target.rotation += .2,
    ({object}) => object._stykIK[2].followers[3] += .1,
    ({object}) => object._stykIK[2].bendDirection = -1,
    ({object}) => object._stykIK[2].chainLength = 1,
    ({object}) => object._stykIK[2].pinned = false,
    ({figure}) => figure.segments[2].parent_id = 1,
    ({figure}) => figure.segments[2].is_static = true,
    ({figure}) => figure.polyfills = [{segment_ids:[1,2,3]}],
  ]) {
    const state = fixture(), {report,figure,object,root} = state;
    const first = evaluateIKPose(report,'local:1',figure,object,root); mutate(state);
    const next = evaluateIKPose(report,'local:1',figure,object,root);
    assert.notEqual(next,first); assert.deepEqual(next,solveObjectIK(figure,object,root));
  }
});

test('document caches are isolated and seeking back reproduces a fresh solve', () => {
  const {report,figure,object,root} = fixture();
  const first = evaluateIKPose(report,'local:1',figure,object,root);
  assert.notEqual(evaluateIKPose({},'local:1',figure,object,root),first);
  object._stykIK[2].target.x += 40; evaluateIKPose(report,'local:1',figure,object,root);
  object._stykIK[2].target.x -= 40;
  assert.deepEqual(evaluateIKPose(report,'local:1',figure,object,root),first);
});
