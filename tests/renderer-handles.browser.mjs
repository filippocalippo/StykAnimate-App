import {_electron as electron} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),output=path.join(root,'artifacts',`gpu-handle-verification-${Date.now()}`);
await mkdir(output,{recursive:true});
const app=await electron.launch({args:[root],cwd:root,env:{...process.env,STYK_USER_DATA_DIR:path.join(output,'profile')}});
try{
  const page=await app.firstWindow();await page.waitForFunction(()=>window.styk?.ready);
  const result=await page.evaluate(async()=>{
    const {createRenderer}=await import('/src/renderer.mjs');
    const canvas=document.createElement('canvas');canvas.id='handle-test';
    Object.assign(canvas.style,{position:'fixed',left:'16px',top:'16px',width:'256px',height:'128px',zIndex:99999});document.body.append(canvas);
    const renderer=await createRenderer(canvas),frame={objects:[],background_id:0},report={...styk.editor.report,canvas_width:256,canvas_height:128};
    if(!renderer.handleRenderer)throw new Error('GPU handle pipeline is unavailable.');
    const handles=[{uid:1,point:{x:40,y:40},screenRadius:5,color:'#ff0000'},{uid:2,point:{x:40,y:40},screenRadius:5,color:'#0000ff'},
      {uid:3,point:{x:120,y:40},screenRadius:5,color:'#00ff00'}];
    const options={report,frame,canvasHandles:handles,outlineHandles:true,view:{scale:1,x:0,y:0},cameraEnabled:false,editorBackgroundColor:0xffffffff};
    const surface=document.createElement('canvas'),context=surface.getContext('2d',{willReadFrequently:true});
    const check=(condition,message)=>{if(!condition)throw new Error(message);};
    const sample=(x,y)=>Array.from(context.getImageData(Math.floor(x*renderer.dpr),Math.floor(y*renderer.dpr),1,1).data);
    const color=(x,y,rgb)=>{const got=sample(x,y);check(rgb.every((v,i)=>Math.abs(v-got[i])<8),`Pixel (${x},${y}) was ${got}, expected ${rgb}`);};
    async function draw(extra={}){renderer.render({...options,...extra});surface.width=canvas.width;surface.height=canvas.height;context.drawImage(canvas,0,0);await renderer.device.queue.onSubmittedWorkDone();check(!renderer.stats.warnings.length,renderer.stats.warnings.join('\n'));}
    const observations=[];
    for(const dpr of [1,2]){
      if(dpr===2){const grouped=[...handles];Object.defineProperty(grouped,'groups',{value:handles.map((h,offset)=>({uid:h.uid,offset,handles:[h]}))});options.canvasHandles=grouped;}
      renderer.resize(256,128,dpr);await draw();color(40,40,[0,0,255]);color(120,40,[0,255,0]);color(47,40,[255,255,255]);
      await draw();check(renderer.stats.handleUploadBytes===0,'Unchanged handles uploaded records again.');
      await draw({view:{scale:1,x:3,y:4}});color(43,44,[0,0,255]);check(renderer.stats.handleUploadBytes===0,'Panning rewrote world-space handles.');
      await draw({dragTranslations:new Map([[2,{x:20,y:0}]])});color(40,40,[255,0,0]);color(60,40,[0,0,255]);
      check(renderer.stats.handleUploadBytes===32,'Translation uploaded unrelated handles.');
      await draw({view:{scale:2,x:0,y:0}});color(80,80,[0,0,255]);color(87,80,[255,255,255]);
      await draw({canvasHandles:undefined});color(40,40,[255,255,255]);
      observations.push({dpr,checks:'Painter order, colors, radius, pan, translation, visibility, retained uploads passed'});
    }
    renderer.resize(256,128,1);await draw();
    check(renderer.stats.warnings.length===0,renderer.stats.warnings.join('\n'));
    window.__handleTestRenderer=renderer;
    return{observations,stats:renderer.stats};
  });
  await page.locator('#handle-test').screenshot({path:path.join(output,'handles.png')});
  await writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({output,...result}));
}finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
