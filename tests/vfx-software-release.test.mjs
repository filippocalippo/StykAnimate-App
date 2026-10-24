import test from 'node:test';
import assert from 'node:assert/strict';
import {withVfx,releaseVfxSoftwareResources} from '../src/vfx-canvas.mjs';
import {VfxCPU} from '../src/vfx-cpu.mjs';
import {createVfx} from '../src/vfx.mjs';

test('explicit worker cleanup releases software region entries and scratch while ordinary calls retain reuse',()=>{
  const previousCanvas=globalThis.OffscreenCanvas,previousImageData=globalThis.ImageData,runPixels=VfxCPU.prototype.runPixels;
  const executors=[];let calls=0;
  globalThis.OffscreenCanvas=class {
    constructor(width,height){this.width=width;this.height=height;this.context={canvas:this,draws:[],lost:false,isContextLost(){return this.lost;},getTransform(){return {a:1,b:0,c:0,d:1,e:0,f:0};},setTransform(){},fillRect(){},clearRect(){},save(){},restore(){},beginPath(){},rect(){},clip(){},drawImage(source){this.draws.push(source);},getImageData(x,y,w,h){return {data:new Uint8ClampedArray(w*h*4)};},putImageData(){}};}
    getContext(type){return type==='webgl2'?null:this.context;}
    transferToImageBitmap(){return {width:this.width,height:this.height,close(){}};}
  };
  globalThis.ImageData=class {constructor(data,width,height){this.data=data;this.width=width;this.height=height;}};
  VfxCPU.prototype.runPixels=function(pixels,width,height){calls++;if(!executors.includes(this))executors.push(this);const slot=this.slot(0,width,height);slot.pixels.set(pixels);return {pixels:slot.pixels,width,height};};
  try{
    const target=new OffscreenCanvas(32,32),context=target.getContext('2d'),stack=[createVfx('blur','blur')],paint=ctx=>ctx.fillRect(3,3,8,8);
    const options={bounds:{x:0,y:0,width:16,height:16},cacheHint:'unchanged'};
    withVfx(context,stack,paint,options);withVfx(context,stack,paint,options);
    assert.equal(calls,1);assert.equal(context.draws[0],context.draws[1]);
    const first=context.draws[0];assert.ok(first.width>1);assert.ok(executors[0].slots[0].pixels.length>0);
    releaseVfxSoftwareResources();assert.equal(first.width,1);assert.equal(first.height,1);assert.equal(executors[0].slots.length,0);assert.equal(target.width,32);
    withVfx(context,stack,paint,options);assert.equal(calls,2);assert.notEqual(context.draws[2],first);assert.equal(executors.length,2);
    const second=context.draws[2];releaseVfxSoftwareResources();assert.equal(second.width,1);assert.equal(executors[1].slots.length,0);
    withVfx(context,stack,paint,{bounds:options.bounds});
    const result=context.draws.at(-1);assert.ok(result.width>1);
    releaseVfxSoftwareResources();releaseVfxSoftwareResources();assert.equal(result.width,1);assert.equal(result.height,1);assert.equal(executors[2].slots.length,0);
    assert.ok(executors.every(executor=>!executor.slots.length&&!executor.canvas),'Independent local and fallback CPU owners are both released.');
  }finally{releaseVfxSoftwareResources();globalThis.OffscreenCanvas=previousCanvas;globalThis.ImageData=previousImageData;VfxCPU.prototype.runPixels=runPixels;}
});
