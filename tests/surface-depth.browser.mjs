import {chromium} from './support/playwright.mjs';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto(`${process.env.STYK_URL??'http://127.0.0.1:47861'}/tests/fixtures/blank.html`);
 const result=await page.evaluate(async()=>{
  const {paintDepthSurfaces,releaseSurfaceRaster}=await import('/src/surface-raster.mjs');
  const nativeGet=OffscreenCanvas.prototype.getContext;
  const results=[];
  for(const software of [false,true]){
   let contexts=0,gl,allocations=0,uploads=0,bytes=0;
   OffscreenCanvas.prototype.getContext=function(type,...args){if(type==='webgl2'){contexts++;if(software)return null;}const result=nativeGet.call(this,type,...args);if(type==='webgl2'){
    gl=result;const allocate=gl.bufferData.bind(gl),upload=gl.bufferSubData.bind(gl);
    gl.bufferData=(target,data,...rest)=>{allocations++;bytes=typeof data==='number'?data:data.byteLength;return allocate(target,data,...rest);};
    gl.bufferSubData=(...args)=>{uploads++;return upload(...args);};
   }return result;};
   const c=new OffscreenCanvas(240,240),ctx=c.getContext('2d'),points=[{x:20,y:20},{x:220,y:20},{x:20,y:220}];
   const shape=(rgb,depthValues)=>({type:'poly',poly:{_stykSurface:{depthTest:true}},alpha:1,points,rgb,depthValues});
   const red=shape([255,0,0],[1,-1,0]),blue=shape([0,0,255],[0,0,0]);
   for(const items of [[red,blue],[blue,red]]){
    ctx.clearRect(0,0,240,240);paintDepthSurfaces(ctx,items);
    const a=ctx.getImageData(40,40,1,1).data,b=ctx.getImageData(170,35,1,1).data;
    if(a[0]!==255||a[2]!==0||b[2]!==255||b[0]!==0)throw new Error(`Incorrect intersection ${software}: ${a}/${b}`);
   }
   if(contexts!==1)throw new Error('Depth renderer recreated its context between poses.');
   if(!software&&(allocations!==1||uploads!==2))throw new Error('Repeated poses reallocate the GPU buffer.');
   releaseSurfaceRaster(ctx);paintDepthSurfaces(ctx,[red,blue]);if(contexts!==2)throw new Error('Released depth resources were reused.');
   // Near-plane clipping can produce a convex quad. Both halves must use the
   // same depth interpolation in WebGL and in the software fallback.
   const quad={...red,points:[{x:20,y:20},{x:220,y:20},{x:220,y:220},{x:20,y:220}],depthValues:[1,-1,-1,1]};
   ctx.clearRect(0,0,240,240);paintDepthSurfaces(ctx,[quad,blue]);
   for(const [x,y,color]of [[40,40,0],[40,180,0],[180,40,2],[180,180,0]])if(ctx.getImageData(x,y,1,1).data[color]!==255)throw new Error(`Clipped face fan failed ${software}: ${x},${y}`);
   // A tile boundary must not expose the background inside a connected surface.
   c.width=2100;c.height=1200;ctx.setTransform(10,0,0,10,0,0);paintDepthSurfaces(ctx,[red,blue]);
   for(const x of [1023,1024,1025])if(ctx.getImageData(x,500,1,1).data[3]!==255)throw new Error('Depth tile seam.');
   if(!software){
    const before=allocations;paintDepthSurfaces(ctx,Array(2000).fill(red));
    if(allocations!==before+1||bytes<2000*18*4)throw new Error('Growing depth batch did not resize its buffer.');
    paintDepthSurfaces(ctx,[blue,red]);
    if(bytes!==4096)throw new Error('A smaller batch retained an oversized GPU buffer.');
    // Public callers can mutate their points and colors; scratch reuse must
    // never turn mutable geometry into a stale per-face cache.
    red.rgb=[0,255,0];ctx.clearRect(0,0,240,240);paintDepthSurfaces(ctx,[red]);
    if(ctx.getImageData(400,400,1,1).data[1]!==255)throw new Error('Updated face color was not uploaded.');
    red.rgb=[255,0,0];
    gl.getExtension('WEBGL_lose_context').loseContext();
    if(!gl.isContextLost())throw new Error('Context loss fixture did not lose its context.');
    c.width=c.height=240;ctx.resetTransform();paintDepthSurfaces(ctx,[red,blue]);
    if(ctx.getImageData(40,40,1,1).data[0]!==255||ctx.getImageData(170,35,1,1).data[2]!==255)throw new Error('Lost depth context left the artwork blank.');
   }
   releaseSurfaceRaster(ctx);OffscreenCanvas.prototype.getContext=nativeGet;
   results.push({software,contexts,intersections:true,tileSeams:false});
  }
  return results;
 });console.log(JSON.stringify(result));
}finally{await browser.close();}
