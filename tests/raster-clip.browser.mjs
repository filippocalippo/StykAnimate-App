import {chromium} from './support/playwright.mjs';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {startDesktopHost} = createRequire(import.meta.url)('../desktop/web-host.cjs');
const backend = await startDesktopHost({appRoot:process.cwd()}); let browser;
try {
  browser = await chromium.launch({channel:'chrome', headless:true});
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${backend.origin}/tests/fixtures/blank.html`);
  const result = await page.evaluate(async () => {
    const {drawGeometry} = await import('/src/pivot/geometry.mjs');
    const {imageBlob} = await import('/src/preview-image.mjs');
    const check = (value, message) => {if (!value) throw new Error(message);};
    const line = (x,y,width=5,kind='line') => ({type:'line',slot:0,opacity:1,alpha:1,rgb:[35,100,220],
      start:{x,y},end:{x:x+35,y:y+20},points:[{x,y},{x:x+35,y:y+20}],thickness:width,
      length:Math.hypot(35,20),seg:{segment_kind:kind},obj:{scale:1},fig:{}});
    const items = Array.from({length:700}, (_,i) => line(500+i,500+i%30,1+i%8));
    items.push(line(-8,2,12,'squareLine'),line(25,15,9),line(200,200,5),line(45,50,5.00004));
    items.push({...line(30,90,4),type:'circle',length:30,seg:{segment_kind:'circle'}});
    items.push({...line(75,45,30),type:'circle',length:-30,seg:{segment_kind:'circleFill'}});
    items.push({...line(0,0,0),type:'poly',points:[{x:-200,y:-200},{x:200,y:-200},{x:200,y:200},{x:-200,y:200}],alpha:.1});
    const cases = [];
    for (const cpu of [false,true]) for (const scale of [.5,1,2]) {
      const width=128, height=128, stats={culledPrimitives:0}, paints=[];
      const render = clip => {
        const canvas = new OffscreenCanvas(width,height), ctx = canvas.getContext('2d',{willReadFrequently:cpu});
        let calls=0; const stroke=ctx.stroke.bind(ctx), fill=ctx.fill.bind(ctx);
        ctx.stroke=(...args)=>{calls++;return stroke(...args);};ctx.fill=(...args)=>{calls++;return fill(...args);};
        ctx.scale(scale,scale);const strokeState={width:1};
        drawGeometry(ctx,{drawables:items,strokeState,...(clip?{clipBounds:{x:0,y:0,width:width/scale,height:height/scale,guard:2/scale,stats}}:{})});
        const pixels=ctx.getImageData(0,0,width,height).data;paints.push(calls);canvas.width=1;
        return {pixels,stroke:strokeState.width};
      };
      const before=render(false),after=render(true);
      check(before.pixels.every((v,i)=>v===after.pixels[i]),'Culling changed visible pixels.');
      check(before.stroke===after.stroke,'Culling changed native brush state.');
      check(stats.culledPrimitives>=700&&paints[1]<paints[0]/10,'Off-screen primitives were still painted.');
      cases.push({cpu,scale,paints,culled:stats.culledPrimitives,pixelDifference:0});
    }
    // Compare the new byte decoder with the retained fallback on identical data.
    const encoded='data:image/bmp;base64,'+btoa('x'.repeat(8*1024*1024)), decode=[];
    const original=Uint8Array.fromBase64;
    try {
      for (const native of [false,true]) {
        Uint8Array.fromBase64=native?original:undefined;
        const samples=[];
        for(let i=0;i<5;i++) {
          const start=performance.now(),blob=await imageBlob(encoded);samples.push(performance.now()-start);
          const bytes=new Uint8Array(await blob.arrayBuffer());
          check(bytes.length===8*1024*1024&&bytes.every(value=>value===120),'Encoded image bytes changed.');
        }
        decode.push({native:Boolean(native&&original),samples});
      }
    } finally {Uint8Array.fromBase64=original;}
    return {cases,decode};
  });
  assert.deepEqual(errors,[]);
  await mkdir('artifacts/raster-clip',{recursive:true});
  await writeFile('artifacts/raster-clip/report.json',JSON.stringify({...result,errors},null,2));
  console.log(JSON.stringify({...result,errors}));
} finally {await browser?.close();backend.stop();}
