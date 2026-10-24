import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import backend from '../desktop/web-host.cjs';
const service=await backend.startDesktopHost({appRoot:process.cwd()});let browser;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto(service.origin+'/tests/fixtures/blank.html');
  const result=await page.evaluate(async()=>{
    const {drawGeometry}=await import('/src/pivot/geometry.mjs');
    const obj={scale:1,unique_id:1},fig={figure_type_id:1};
    const triangle=(points,rgb=[210,90,40],alpha=1)=>({type:'poly',slot:0,obj,fig,opacity:1,alpha,rgb,points:points.map(([x,y])=>({x,y})),poly:{_stykSurface:{depth:[1]}}});
    const a=triangle([[10,10],[90,10],[90,90]]),b=triangle([[10,10],[90,90],[10,90]]);
    const paint=items=>{const c=document.createElement('canvas');c.width=c.height=100;drawGeometry(c.getContext('2d'),{drawables:items});return c.getContext('2d').getImageData(0,0,100,100).data;};
    const merged=paint([a,b]);let holes=0;
    for(let y=12;y<88;y++)for(let x=12;x<88;x++)if(merged[(y*100+x)*4+3]!==255)holes++;
    const blue=triangle([[5,5],[95,5],[95,95]],[20,80,220]);
    const layered=paint([a,blue,b]),ref=paint([a,blue,b].map(s=>({...s,poly:{}})));
    // Samples away from shared edges must retain the intermediate blue layer.
    const pixel=(bytes,x,y)=>Array.from(bytes.slice((y*100+x)*4,(y*100+x)*4+4));
    const actual=pixel(layered,70,30),expected=pixel(ref,70,30);
    const transparent=paint([a,b].map(s=>({...s,alpha:.5}))),transparentRef=paint([a,b].map(s=>({...s,alpha:.5,poly:{}})));
    return {holes,actual,expected,transparentMatches:transparent.every((v,i)=>v===transparentRef[i])};
  });
  assert.equal(result.holes,0);assert.deepEqual(result.actual,result.expected);assert.deepEqual(result.actual,[20,80,220,255]);assert.equal(result.transparentMatches,true);assert.deepEqual(errors,[]);
  console.log('PASS: opaque projected faces have no internal seams; painter layers and transparent fills retain their appearance.');
}finally{await browser?.close();await service.stop();}
