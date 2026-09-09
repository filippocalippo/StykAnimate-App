import test from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackTweenCache} from '../src/playback-tween-cache.mjs';
import {evaluatedFrame,buildGeometry} from '../src/pivot/geometry.mjs';
import {createDemo} from '../src/demo.mjs';

test('constant endpoint caching retains exact native floating-point reconstruction',()=>{
  const report=createDemo(),first=report.keyframes[0];
  report.auto_easing=false;
  report.keyframes=[first,structuredClone(first)];
  for(const o of report.keyframes[1].objects){o.record_offset=400;o.record_end=800;}
  // One figure moves while the other figures remain constant.
  report.keyframes[1].objects[0].root_x+=37;
  const tweenCache=new PlaybackTweenCache();let prior;
  for(const t of [.03125,.3,.5,.9375,0,1,.125]){
    const actual=evaluatedFrame(report,0,t,undefined,{tweenCache}),expected=evaluatedFrame(report,0,t);
    assert.deepEqual(actual,expected);assert.deepEqual(buildGeometry(report,actual).drawables,buildGeometry(report,expected).drawables);
    if(t>0&&t<1){if(prior)assert.equal(actual.objects[1],prior.objects[1]);prior=actual;}
  }
});

test('easing, changed endpoints and replaced definitions cannot reuse a constant tween',()=>{
  const report=createDemo(),first=report.keyframes[0];report.keyframes=[first,structuredClone(first)];
  const tweenCache=new PlaybackTweenCache();
  evaluatedFrame(report,0,.1,undefined,{tweenCache});
  report.auto_easing=true;report.keyframes.push(structuredClone(first));report.keyframes[2].objects[1].root_x+=120;
  for(const t of [.2,.7])assert.deepEqual(evaluatedFrame(report,0,t,undefined,{tweenCache}),evaluatedFrame(report,0,t));
  report.auto_easing=false;report.keyframes[1]=structuredClone(first);report.keyframes[1].objects[1].angles[0]+=.001;
  for(const t of [.2,.7])assert.deepEqual(evaluatedFrame(report,0,t,undefined,{tweenCache}),evaluatedFrame(report,0,t));
  report.figure_types=structuredClone(report.figure_types);report.figure_types[0].segments[0].bend_rad=.4;
  assert.deepEqual(evaluatedFrame(report,0,.7,undefined,{tweenCache}),evaluatedFrame(report,0,.7));
});

test('worker cache bounds entry ownership and clears on snapshot invalidation',()=>{
  const cache=new PlaybackTweenCache({maxEntries:2}),figure={};
  for(let i=0;i<5;i++){const a={angles:[i]};cache.lookup(a,structuredClone(a),figure);assert.ok(cache.entries.size<=2);}
  cache.clear();assert.equal(cache.entries.size,0);
});
