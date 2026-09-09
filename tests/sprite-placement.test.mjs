import test from 'node:test';
import assert from 'node:assert/strict';
import {createImageFigure} from '../src/media-authoring.mjs';
import {placedSpriteFigure} from '../src/sprite-placement-dialog.mjs';
const source=()=>createImageFigure({dataUrl:'data:image/png;base64,AAAA',width:32,height:24,name:'Arm'});
test('placing native integer anchors derives length and angle without modifying imported sprite',()=>{
  const figure=source(),snapshot=structuredClone(figure),result=placedSpriteFigure(figure,{start:{x:4,y:5},end:{x:7,y:9}});
  assert.deepEqual(figure,snapshot);assert.equal(result.image_assets[0].anchor_length,5);assert.equal(result.segments[0].length,5);
  assert.equal(result.segments[0].angle_rad,Math.atan2(4,3));assert.equal(result.image_assets[0].anchor_angle_rad,Math.atan2(4,3));
  assert.notEqual(result.image_assets[0],figure.image_assets[0]);assert.equal(result.image_assets[0].data_url,figure.image_assets[0].data_url);
});
test('sprite anchors support outside-image integer coordinates and reject native-unrepresentable or coincident values',()=>{
  const figure=source();assert.equal(placedSpriteFigure(figure,{start:{x:-10,y:90},end:{x:50,y:-70}}).image_assets[0].anchor_start.x,-10);
  for(const value of [NaN,Infinity,.5,2147483648,-2147483649])assert.throws(()=>placedSpriteFigure(figure,{start:{x:value,y:0},end:{x:10,y:0}}));
  assert.throws(()=>placedSpriteFigure(figure,{start:{x:1,y:2},end:{x:1,y:2}}),/different/);
});
