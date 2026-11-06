import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraMonitorVisible,drawCameraMonitor} from '../src/camera-monitor.mjs';

test('collapsed camera monitors do not evaluate or rasterize a scene',()=>{
  const canvas={clientWidth:320,clientHeight:180,checkVisibility:()=>false,getContext(){throw Error('Hidden monitor rendered');}};
  assert.equal(cameraMonitorVisible(canvas),false);
  assert.equal(drawCameraMonitor(canvas,{report:{},frame:{}}),false);
  assert.equal(cameraMonitorVisible({...canvas,checkVisibility:()=>true}),true);
  assert.equal(cameraMonitorVisible({clientWidth:0,clientHeight:180}),false);
});

test('a monitor the engine does not draw is left empty, and a failure waits before the next attempt',()=>{
  const context={setTransform(){},clearRect(){}},canvas={clientWidth:320,clientHeight:240,getContext:()=>context};
  const report={canvas_width:640,canvas_height:400};
  assert.equal(drawCameraMonitor(canvas,{report,frame:{}}),false,'no stage');
  let asked=0;
  assert.equal(drawCameraMonitor(canvas,{report,frame:{},stage:{drawCameraMonitor(target,view){asked++;assert.deepEqual([view.width,view.height],[canvas.width,canvas.height]);return false;}}}),false);
  assert.equal(asked,1);
  const errors=[];
  const failing={report,frame:{},onError:error=>errors.push(error),stage:{drawCameraMonitor(){throw new Error('no device');}}};
  assert.equal(drawCameraMonitor(canvas,failing),false);assert.equal(errors.length,1);
  assert.equal(drawCameraMonitor(canvas,failing),false);assert.equal(errors.length,1,'not asked again at once');
});

test('completed GPU-source presentation settles only a new actual DOM canvas lifetime',()=>{
  const events=new Map(),context={setTransform(){},clearRect(){}},canvas={clientWidth:278,clientHeight:139,width:278,height:139,
    getContext(){return context;},addEventListener(name,listener){events.set(name,listener);}};
  let invalidations=0,gpu=true;
  const options={report:{canvas_width:960,canvas_height:540},frame:{},onInvalidate(){invalidations++;},
    stage:{drawCameraMonitor(target,view,afterSourcePaint){assert.equal(target,context);afterSourcePaint?.(gpu);return true;}}};
  assert.equal(drawCameraMonitor(canvas,options),true);assert.equal(invalidations,1);
  drawCameraMonitor(canvas,options);assert.equal(invalidations,1,'ordinary subsequent paint does not loop');
  options.report={...options.report};options.stage={...options.stage};drawCameraMonitor(canvas,options);
  assert.equal(invalidations,1,'document/stage switch preserves the actual destination lifetime');
  canvas.clientWidth=320;drawCameraMonitor(canvas,options);assert.equal(invalidations,1,'size changes preserve the actual DOM canvas paint history');
  events.get('contextlost')();assert.equal(drawCameraMonitor(canvas,options),false);assert.equal(invalidations,1);
  events.get('contextrestored')();assert.equal(invalidations,2,'existing restore invalidation remains');
  drawCameraMonitor(canvas,options);assert.equal(invalidations,3,'first source after restore settles once');
  gpu=false;const direct={...canvas,width:278,height:139,clientWidth:278};drawCameraMonitor(direct,options);assert.equal(invalidations,3,'CPU-source presentation never asks for GPU settling');
  gpu=true;drawCameraMonitor(direct,options);assert.equal(invalidations,3,'prior direct/empty paint preserves the later first-GPU undo behavior');
});
