import {_electron as electron,chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),output=path.join(root,'artifacts',`editable-app-${Date.now()}`);await mkdir(output,{recursive:true});
const browser=process.env.STYK_BROWSER_URL?await chromium.launch({channel:'chrome',headless:true}):null;
const app=browser?null:await electron.launch({args:[root],cwd:root,env:{...process.env,STYK_USER_DATA_DIR:path.join(output,'profile')}});
const checks=[],errors=[];let page;
try{
  page=browser?await browser.newPage():await app.firstWindow();if(browser)await page.goto(process.env.STYK_BROWSER_URL);
  if(app)await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setIgnoreMouseEvents(true);w.setFocusable(false);w.webContents.setBackgroundThrottling(false);});
  page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {createDemo}=await import('/src/demo.mjs');styk.editor.load(createDemo());styk.editor.markSaved();
    const proto=Object.getPrototypeOf(styk.editor),original=proto.prepareGeometry;
    proto.prepareGeometry=async function(options){if(globalThis.holdEditable)await new Promise(resolve=>globalThis.releaseEditable=resolve);return original.call(this,options);};
  });
  const play=async()=>{
    await page.evaluate(()=>document.querySelector('#play-button').click());
    await page.waitForFunction(()=>styk.state.playing&&styk.state.playbackPacket);
  };
  const pause=async(hold=false)=>{
    await page.evaluate(hold=>{globalThis.holdEditable=hold;globalThis.releaseEditable=null;document.querySelector('#play-button').click();},hold);
    if(hold)await page.waitForFunction(()=>Boolean(globalThis.releaseEditable));
    else await page.waitForFunction(()=>!styk.state.playing&&!styk.state.editablePreparing&&styk.state.renderer.last);
  };
  const release=()=>page.evaluate(()=>{globalThis.holdEditable=false;globalThis.releaseEditable?.();});
  const exact=async name=>{
    await page.waitForFunction(()=>!styk.state.editablePreparing&&!styk.state.playing&&styk.state.renderer.last);
    const result=await page.evaluate(async()=>{
      const {createRenderer}=await import('/src/renderer.mjs'),{buildGeometry}=await import('/src/pivot/geometry.mjs');
      const renderer=styk.state.renderer,options=renderer.last,canvas=document.createElement('canvas');
      const reference=await createRenderer(canvas,{sharedArtwork:false});reference.resize(renderer.width,renderer.height,renderer.dpr);
      reference.render({...options,geometry:buildGeometry(options.report,options.frame)});
      const surface=document.createElement('canvas');surface.width=renderer.canvas.width;surface.height=renderer.canvas.height;
      const context=surface.getContext('2d',{willReadFrequently:true});
      renderer.render(options);
      context.drawImage(renderer.canvas,0,0);const actual=context.getImageData(0,0,surface.width,surface.height).data;
      context.clearRect(0,0,surface.width,surface.height);context.drawImage(canvas,0,0);const expected=context.getImageData(0,0,surface.width,surface.height).data;
      let max=0;for(let i=0;i<actual.length;i++)max=Math.max(max,Math.abs(actual[i]-expected[i]));
      reference.destroy();return {max,leases:renderer.rasterCache.leases.size,preparation:styk.performance().editablePreparation,fpsHidden:document.querySelector('#playback-fps').hidden};
    });
    checks.push({name,...result});
    assert.equal(result.max,0,name);assert.equal(result.leases,0);assert.equal(result.fpsHidden,true);
    console.log('PASS',name);
  };
  await play();await pause();await exact('Pause completes with exact editable pixels');
  await play();await pause(true);
  await page.evaluate(()=>styk.editor.selectFrame(1));await release();
  await exact('Seek during pending preparation cancels the old pose');
  await play();await pause(true);await play();await release();
  assert.equal(await page.evaluate(()=>styk.state.playing),true);
  await pause();await exact('Restarting playback cannot publish the old paused pose');
  await play();await pause(true);
  const target=await page.evaluate(async()=>{
    const {buildGeometry}=await import('/src/pivot/geometry.mjs');
    const geometry=buildGeometry(styk.editor.report,styk.editor.evaluatedFrame),g=geometry.orderedObjects[0],view=styk.state.view,rect=document.querySelector('#overlay').getBoundingClientRect();
    return {x:rect.x+view.x+g.root.x*view.scale,y:rect.y+view.y+g.root.y*view.scale};
  });
  await page.mouse.move(target.x,target.y);await page.mouse.down();
  assert.equal(await page.evaluate(()=>Boolean(styk.state.drag)),true,'Pointerdown must start the requested gesture while preparation is pending.');
  assert.equal(await page.evaluate(()=>styk.state.editablePreparing),false);
  await page.mouse.move(target.x+20,target.y+12,{steps:3});await page.mouse.up();await release();
  await exact('Dragging while preparation is pending preserves the gesture and exact output');
  assert.deepEqual(errors,[]);
}catch(error){errors.push(error.stack);await page?.screenshot({path:path.join(output,'failure.png')});throw error;}
finally{await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors},null,2));console.log('REPORT',output);if(browser)await browser.close();else await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
