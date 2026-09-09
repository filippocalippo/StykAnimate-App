import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const page=await browser.newPage();
  page.on('requestfailed',request=>console.log('Request failed',request.url(),request.failure()?.errorText));
  page.on('response',response=>{if(response.status()>=400)console.log('Response failed',response.status(),response.url());});
  page.on('console',message=>{if(message.type()==='error')console.log('Browser error',message.text());});
  await page.goto('http://127.0.0.1:47831/api/health');
  const result=await page.evaluate(async()=>{
    const {Editor}=await import('/src/editor.mjs'),{emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const {ThumbnailRenderer}=await import('/src/thumbnail-renderer.mjs');
    const report=emptyDocument();report.canvas_width=160;report.canvas_height=90;
    const figure=report.figure_types[0];figure.segments=[{...figure.segments[0],length:20,angle_rad:0,thickness:4,color_rgb:[0,0,0]}];figure.segment_count=1;
    report.keyframes=[20,60,100].map(x=>createFrame([createObject(figure,1,x,45)],4));
    const editor=new Editor({demo:false}).load(report), baseline=structuredClone(report.keyframes[1]);
    report.keyframes[1].objects[0].root_x=120;
    report._styk.simpleFrameDraft={version:1,mode:'add',index:1,frameId:baseline._styk.frameId,baseline};
    const renderer=new ThumbnailRenderer(editor,{storedFrames:true}),canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
    const pixel=x=>canvas.getContext('2d').getImageData(x,45,1,1).data[0];const checks=[];
    const check=(name,value)=>{if(!value)throw new Error(name);checks.push(name);};
    try {
      await renderer.renderThumbnail(1,canvas);check('Add thumbnail displays stored baseline',pixel(70)===0&&pixel(130)>240);
      await renderer.renderThumbnail(1,canvas,{storedFrames:false});check('Working preview remains distinct',pixel(130)===0&&pixel(70)>240);
      const inbetween={ratio:.5,onionMode:'none',onionCount:0,onionOpacity:0};
      await renderer.renderThumbnail(1,canvas,{storedFrames:true,inbetween});check('Inbetween samples stored left and right keys',pixel(50)===0&&pixel(80)>240);
      await renderer.renderThumbnail(1,canvas,{storedFrames:false,inbetween});check('Working inbetween is independently selectable',pixel(80)===0&&pixel(50)>240);
      report._styk.simpleFrameDraft={...report._styk.simpleFrameDraft,mode:'update'};editor._emit('frame-draft',{frameIndices:[1]});
      await renderer.renderThumbnail(1,canvas);check('Metadata-only Add to Update refreshes stored thumbnail',pixel(130)===0&&pixel(70)>240);
      check('Metadata changes use one frame patch without reloading assets',renderer.stats.snapshots===1&&renderer.stats.patches===1);
      return{checks,stats:renderer.stats};
    } finally {renderer.destroy();}
  });
  assert.equal(result.checks.length,6);await mkdir('artifacts/stored-frame-thumbnails',{recursive:true});
  await writeFile('artifacts/stored-frame-thumbnails/report.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}
