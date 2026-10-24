#!/usr/bin/env node
// Real Editor paints spanning every fractional camera-monitor edge and corner.
// The recorded Canvas PNG sample table is independent of this project generator.
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {here,open,documentOf,joint,emptyDocument} from './fixture-kit.mjs';
const at=process.argv.indexOf('--out');
const out=path.resolve(at<0?path.join(here,'../crates/styk-raster/tests/fixtures/canvas-paint'):process.argv[at+1]);
mkdirSync(out,{recursive:true});
let id=0;Object.defineProperty(globalThis.crypto,'randomUUID',{configurable:true,value:()=>`00000000-0000-4000-8000-${String(++id).padStart(12,'0')}`});
for(const vertical of [false,true])for(const overlap of [false,true]){
 id=0;
 const segments=Array.from({length:overlap?2:1},(_,i)=>[i+1,0,vertical?340:1000,vertical?Math.PI/2:0]);
 const base=open(documentOf([segments],()=>vertical?[480,-20]:[-20,270]),{layerTimeline:true});
 if(vertical)base.setCanvasSize(960,300);
 base.setSceneColor(0x00101820);
 for(let i=0;i<segments.length;i++)joint(base,i+1).updateSegment({thickness:200,color_rgb:i?[32,96,240]:[240,48,32],transparency:overlap?128:0});
 const doc=base.serialize();id=0;
 const e=open(JSON.parse(JSON.stringify(doc)),{layerTimeline:true});
 for(let i=1;i<=segments.length;i++)joint(e,i).updateSegment({thickness:2000});
 const name=`corner-${overlap?'overlap':'vector'}-${vertical?'vertical':'horizontal'}`;
 writeFileSync(path.join(out,name+'.json'),JSON.stringify(e.serialize(),null,2)+'\n');
}
for(const [name,angle] of [['background-tiny-camera',1e-11],['background-negative-tiny-camera',-1e-11]]){
 id=0;const e=open(emptyDocument(),{layerTimeline:true});
 e.setCanvasSize(1000,1000);e.setSceneColor(0xff101018);e.setCameraValues({angle_rad:angle});
 writeFileSync(path.join(out,name+'.json'),JSON.stringify(e.serialize(),null,2)+'\n');
}
console.log('6 Editor documents spanning clip corners and the original-matrix painter boundary');
