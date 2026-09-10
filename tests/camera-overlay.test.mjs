import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraViewport,pickCameraHandle,cameraDragDelta,cameraKeyboardDelta,drawCameraViewport} from '../src/camera-overlay.mjs';
const report={canvas_width:600,canvas_height:340},frame={camera:{is_default:false,x:23,y:-8,scale:.8,angle_rad:.4}},view={scale:1.5};
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);

test('camera has four corners, a center move grip, and a screen-sized rotation stalk',()=>{
 const v=cameraViewport(report,frame,view);assert.equal(v.handles.length,6);
 assert.deepEqual(v.handles[4].point,v.center);assert.equal(v.handles[4].kind,'position');
 close(Math.hypot(v.rotationBase.x-v.handles[5].point.x,v.rotationBase.y-v.handles[5].point.y)*view.scale,30);
 for(const zoom of [.25,1,4]){const v=cameraViewport(report,frame,{scale:zoom}),p=v.handles[1].point;
 assert.equal(pickCameraHandle(v,{x:p.x+11/zoom,y:p.y})?.index,1);
 assert.equal(pickCameraHandle(v,{x:p.x+13/zoom,y:p.y}),null);}
});
test('scale and rotation do not jump when grabbed off-center',()=>{
 const v=cameraViewport(report,frame,view);
 for(const kind of ['scale','rotation']){const handle=v.handles.find(h=>h.kind===kind),start={x:handle.point.x+3,y:handle.point.y+2};
 const delta=cameraDragDelta({handle,viewport:v,start},start);close(kind==='scale'?delta.scale:delta.angle_rad,kind==='scale'?1:0);}
});
test('relative radial scaling holds the center and snaps in ten percent increments',()=>{
 const v=cameraViewport(report,frame,view),handle=v.handles[1],start=handle.point;
 const point={x:v.center.x+1.33*(start.x-v.center.x),y:v.center.y+1.33*(start.y-v.center.y)};
 close(cameraDragDelta({handle,viewport:v,start},point).scale,1.33);
 close(cameraDragDelta({handle,viewport:v,start,snap:true},point).scale,1.1/.8);
});
test('rotation unwraps smoothly across the angle boundary and snaps to 15 degrees',()=>{
 const v=cameraViewport(report,frame,view),at=a=>({x:v.center.x+100*Math.cos(a),y:v.center.y+100*Math.sin(a)});
 const d={handle:v.handles[5],viewport:v,start:at(3.1)};
 close(cameraDragDelta(d,at(-3.1)).angle_rad,2*Math.PI-6.2);
 close(cameraDragDelta(d,at(-3)).angle_rad,2*Math.PI-6.1);
 d.snap=true;const delta=cameraDragDelta(d,at(-3)).angle_rad;close((delta+.4)/(Math.PI/12),2);
});
test('camera movement locks the first dominant direction',()=>{
 const d={handle:{kind:'position'},start:{x:0,y:0},constrain:true};assert.deepEqual(cameraDragDelta(d,{x:2,y:2}),{x:2,y:0});assert.deepEqual(cameraDragDelta(d,{x:3,y:50}),{x:3,y:0});
});
test('keyboard camera nudges are predictable in pixels, degrees and scale',()=>{
 const v=cameraViewport(report,frame,view);close(cameraKeyboardDelta(v,v.handles[4],1,0).x,1/1.5);
 close(cameraKeyboardDelta(v,v.handles[5],1,0).angle_rad,Math.PI/180);
 close(cameraKeyboardDelta(v,v.handles[1],1,0).scale,.81/.8);
});
test('inactive camera renders only an outline without misleading interactive grips',()=>{
 const calls=[],ctx=new Proxy({},{get:(o,k)=>k in o?o[k]:(...args)=>calls.push([k,...args]),set:(o,k,v)=>{o[k]=v;return true;}});
 drawCameraViewport(ctx,cameraViewport(report,frame,view),p=>p,{active:false});
 assert.equal(calls.filter(c=>c[0]==='stroke').length,1);assert.equal(calls.filter(c=>c[0]==='arc').length,0);
});
