import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraViewport,pickCameraHandle,cameraDragDelta,drawCameraViewport} from '../src/camera-overlay.mjs';
const report={canvas_width:600,canvas_height:340},frame={camera:{is_default:false,x:23,y:-8,scale:.8,angle_rad:.4}},view={scale:1.5};
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
test('Native camera has four inset corners and world-axis square hit targets',()=>{
 const v=cameraViewport(report,frame,view);assert.equal(v.handles.length,4);
 const h=3/(view.scale*frame.camera.scale),c=Math.cos(.4),s=Math.sin(.4);
 close(v.handles[0].point.x,323+.8*((-300+h)*c-(-170+h)*s));
 close(v.handles[0].point.y,162+.8*((-300+h)*s+(-170+h)*c));
 const p=v.handles[0].point;
 assert.equal(pickCameraHandle(v,{x:p.x+2,y:p.y+2},view)?.kind,'position');
 assert.equal(pickCameraHandle(v,{x:p.x+2.001,y:p.y},view),null);
 assert.equal(pickCameraHandle(v,v.center,view),null);
});
test('Native absolute rotation and radial scale match bundled Pivot formulas',()=>{
 const v=cameraViewport(report,frame,view),p={x:v.center.x+80,y:v.center.y-30};
 close(cameraDragDelta({handle:{kind:'rotation'},viewport:v},p).angle_rad,Math.atan2(-30,80)-Math.atan2(340,600)-.4);
 close(cameraDragDelta({handle:{kind:'scale'},viewport:v},p).scale,2*Math.hypot(80,30)/(Math.hypot(600,340)-6*Math.SQRT2/1.5)/.8);
 close(cameraDragDelta({handle:{kind:'scale'},viewport:v},v.center).scale,.0001/.8);
});
test('Camera move locks dominant first direction, including horizontal tie',()=>{
 const d={handle:{kind:'position'},start:{x:0,y:0},constrain:true};assert.deepEqual(cameraDragDelta(d,{x:2,y:2}),{x:2,y:0});assert.deepEqual(cameraDragDelta(d,{x:3,y:50}),{x:3,y:0});
});
test('Camera rendering retains native colors, inactive dimming and hollow scale squares',()=>{
 const calls=[],ctx=new Proxy({globalAlpha:1},{get:(o,k)=>k in o?o[k]:(...args)=>calls.push([k,...args]),set:(o,k,v)=>{calls.push(['set',k,v]);o[k]=v;return true;}});
 drawCameraViewport(ctx,cameraViewport(report,frame,view),p=>p,{active:false});
 assert.ok(calls.some(c=>c[0]==='set'&&c[1]==='globalAlpha'&&c[2]===.4));
 assert.ok(calls.some(c=>c[0]==='set'&&c[1]==='fillStyle'&&c[2]==='#ff8000'));
 assert.equal(calls.filter(c=>c[0]==='fillRect').length,2);assert.equal(calls.filter(c=>c[0]==='strokeRect').length,4);
});
