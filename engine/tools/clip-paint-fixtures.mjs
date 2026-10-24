#!/usr/bin/env node
// Background paint geometry from the real Editor and the existing Canvas owner.
//   node engine/tools/clip-paint-fixtures.mjs [--out <folder>]
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {here,open,emptyDocument} from './fixture-kit.mjs';
import {createVfx} from '../../src/vfx.mjs';
import {encodeDrawingPNG} from '../../src/drawing-png.mjs';
import {backgroundBounds} from '../../src/pivot/background.mjs';
import {cameraMatrix} from '../../src/renderer-geometry.mjs';
const at=process.argv.indexOf('--out');
const out=path.resolve(at<0?path.join(here,'../crates/styk-eval/tests/fixtures/clip-paint'):process.argv[at+1]);
mkdirSync(out,{recursive:true});
let id=0;Object.defineProperty(globalThis.crypto,'randomUUID',{configurable:true,value:()=>`00000000-0000-4000-8000-${String(++id).padStart(12,'0')}`});
const image=await encodeDrawingPNG(new Uint8Array([255,0,0,255,0,0,255,255]),2,1);
const cases=[
 ['color-identity',e=>e.setSceneColor(0xff101018)],
 ['color-camera',e=>{e.setSceneColor(0xff101018);e.setCameraValues({x:25,y:-20,scale:.85,angle_rad:.14});}],
 ['color-alpha',e=>e.setSceneColor(0x80101820)],
 ['gradient-identity',e=>e.importSceneBackground({kind:3,name:'Clip gradient',color_a:0xff101018,color_b:0xff204060,x1:0,y1:0,x2:1,y2:1})],
 ['color-hidden',e=>{e.setSceneColor(0xff101018);e.setLayerVisible('scene',false);}],
 ['color-scene-fx',e=>{e.setSceneColor(0xff101018);e.changeVfxStack({kind:'scene'},stack=>{const effect=createVfx('tint','clip-paint-scene-tint');effect.params.color=0x204060;effect.params.mix=.25;stack.push(effect);});}],
 ['image-identity',e=>e.importSceneBackground({kind:1,name:'Clip two-pixel image',data_url:image,width:2,height:1,mime_type:'image/png'})],
];
const rows=[];
for(const[name,edit]of cases){
 const e=open(emptyDocument(),{layerTimeline:true});edit(e);const frame=e.evaluatedFrame;
 if(frame.objects.length)throw Error('Background geometry fixture contains foreground objects');
 writeFileSync(path.join(out,name+'.json'),JSON.stringify(e.serialize(),null,2)+'\n');
 for(const viewport of [{x:0,y:0,width:960,height:540},{x:123.25,y:45.75,width:320.5,height:192.25}]){
  const bounds=backgroundBounds(frame,960,540,true,e.report,viewport);
  const matrix=cameraMatrix({report:e.report,frame,view:{scale:139/540,x:(278-960*139/540)/2,y:0},cameraEnabled:true});
  rows.push({name,viewport:[viewport.x,viewport.y,viewport.width,viewport.height],bounds:[bounds.x,bounds.y,bounds.width,bounds.height],clearRaster:bounds.clearRaster,matrix});
 }
}
writeFileSync(path.join(out,'bounds.reference.json'),JSON.stringify(rows)+'\n');
console.log(`${cases.length} Editor documents, ${rows.length} background paint-bound samples`);
