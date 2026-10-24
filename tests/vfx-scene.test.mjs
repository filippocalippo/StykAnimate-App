import test from 'node:test';
import assert from 'node:assert/strict';
import {sceneVfxPlan,checkSceneVfxPlan,sceneVfxBounds} from '../src/vfx-scene.mjs';
import {createVfx,vfxPadding} from '../src/vfx.mjs';
import {backgroundBounds} from '../src/pivot/background.mjs';
import {cameraMatrix} from '../src/renderer-geometry.mjs';

const effect=(type,params)=>{const e=createVfx(type,type);Object.assign(e.params,params);return e;};
test('camera and tile sampling includes exterior pixels without moving the effect domain',()=>{
 const frame={_stykVfx:{figure:[effect('shockwave',{strength:-50}),effect('wave',{strength:20})]}};
 const full=sceneVfxPlan(frame,640,480,undefined,2),tile=sceneVfxPlan(frame,128,128,{width:640,height:480,x:512,y:0},2);
 assert.equal(full.pad,142);assert.equal(tile.pad,full.pad);
 assert.deepEqual(tile.outputSize,full.outputSize);assert.equal(tile.viewport.x,370);assert.equal(tile.viewport.y,-142);
 assert.equal(tile.width,412);assert.equal(tile.height,412);
 assert.deepEqual(sceneVfxBounds({canvas_width:320,canvas_height:240},tile),{x:185,y:-71,width:206,height:206});
 assert.ok(checkSceneVfxPlan(tile));
 assert.throws(()=>checkSceneVfxPlan(sceneVfxPlan(frame,4096,4096,undefined,2)),{code:'vfx_surface_budget'});
 assert.throws(()=>checkSceneVfxPlan(tile,256),{code:'vfx_surface_budget'});
});
test('zero-strength and neutral effects require no sampling surface',()=>{
 const frame={_stykVfx:{figure:[effect('shockwave',{effectStrength:0}),effect('blur',{radius:0})]}};
 assert.equal(sceneVfxPlan(frame,320,240).pad,0);
 assert.equal(sceneVfxPlan({},320,240).width,320);
 assert.deepEqual(sceneVfxPlan({},320,240).viewport,{width:320,height:240,x:0,y:0});
});
test('small blur guards cover the actual minimum kernel at reduced resolution',()=>{
 for(const type of ['blur','glow','bloom','shadow']){
  const e=effect(type,{radius:.1,...(['glow','shadow'].includes(type)?{spread:0}:{}),...(type==='shadow'?{offsetX:0,offsetY:0}:{})});
  assert.ok(vfxPadding([e],.25)>=3,type);
  assert.ok(vfxPadding(Array(16).fill(e),.25)>=48,type);
 }
});
test('expanded background bounds contain all camera sampling corners after rotation and zoom',()=>{
 const report={canvas_width:320,canvas_height:240},frame={camera:{x:80,y:-20,scale:1.4,angle_rad:.7}};
 const viewport={x:-60,y:-60,width:440,height:360},bounds=backgroundBounds(frame,320,240,true,report,viewport);
 const [a,b,c,d,e,f]=cameraMatrix({report,frame}),det=a*d-b*c;
 for(const x of [-60,380])for(const y of [-60,300]){
  const wx=(d*(x-e)-c*(y-f))/det,wy=(-b*(x-e)+a*(y-f))/det;
  assert.ok(wx>=bounds.x&&wx<=bounds.x+bounds.width);assert.ok(wy>=bounds.y&&wy<=bounds.y+bounds.height);
 }
 assert.deepEqual(backgroundBounds({},320,240,true,report,viewport),{...viewport,clearRaster:false});
});
