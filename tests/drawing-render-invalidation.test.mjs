import test from 'node:test';
import assert from 'node:assert/strict';
import {objectBounds} from '../src/renderer-geometry.mjs';
import {createDrawingFigure} from '../src/drawing-model.mjs';
import {createObject,createFrame} from '../src/demo.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

test('drawing bounds never request a placeholder image, including empty and live cels',()=>{
  const e=ownedEditorFor({demo:false,layerTimeline:true}),fig=createDrawingFigure({figureTypeId:60}),frame=createFrame([createObject(fig,60,100,100)]);
  const items=e._shown.previewGeometry(frame,fig,e.activeLayerId,60).drawables;
  const image=()=>assert.fail('drawing carrier images must not enter the decode/invalidation loop');
  objectBounds(items,{image,url:asset=>asset.data_url});
  fig._styk.drawing.bounds={x:-12,y:-9,width:80,height:60};
  objectBounds(items,{image,url:asset=>asset.data_url});
  const bounds=objectBounds(items,{image,url:asset=>asset.data_url,drawing:()=>({store:{bounds:{x:-20,y:-30,width:200,height:180}}})});
  assert.ok(bounds.width>=200&&bounds.height>=180,'in-flight pixels expand bounds before publication');
});

test('ordinary images still resolve decoded dimensions for their bounds',()=>{
  const item={type:'image',asset:{anchor_length:1,anchor_angle_rad:0},start:{x:0,y:0},end:{x:1,y:0},angle:0,seg:{},obj:{}};
  let requested=0;
  const bounds=objectBounds([item],{url:()=>'/sprite.png',image:url=>{assert.equal(url,'/sprite.png');requested++;return {naturalWidth:100,naturalHeight:70};}});
  assert.equal(requested,1);assert.deepEqual(bounds,{x:-3,y:-3,width:106,height:76});
});
