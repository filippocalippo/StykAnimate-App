import test from 'node:test';
import assert from 'node:assert/strict';
import {engineEditor} from './support/owned-editor.mjs';
import {DrawingController} from '../src/drawing-controller.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';

test('first-stroke previews keep the drawing layer position while surrounding layers are hidden',()=>{
  const report=emptyDocument();report.keyframes=[createFrame([createObject(report.figure_types[0],1,0,0)])];
  const editor=engineEditor({demo:false,layerTimeline:true},report),layer=editor.createDrawingLayer();
  editor.selectSheetLayer(layer.id);
  editor.reorderLayers([layer.id,'layer-1']);
  const target=editor.prepareDrawingCel(),preview=()=>Object.getOwnPropertyDescriptor(DrawingController.prototype,'renderPreview').get.call({editor,gesture:{target}});
  const order=()=>preview().geometry.orderedObjects.map(g=>g.obj.unique_id);
  assert.deepEqual(order(),[target.object.unique_id,1]);
  editor.setLayerVisible('layer-1',false);editor.setLayerVisible('scene',false);
  assert.deepEqual(order(),[target.object.unique_id,1]);
  editor.setLayerVisible('layer-1',true);editor.setLayerVisible('scene',true);
  assert.deepEqual(order(),[target.object.unique_id,1]);
  editor.reorderLayers(['layer-1',layer.id]);
  assert.deepEqual(order(),[1,target.object.unique_id]);
});
