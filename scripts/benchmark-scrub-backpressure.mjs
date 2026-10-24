/** Generated 1,500-instance scrub under 4x CPU throttling. CDP mouse events
 * arrive independently of rendering; gated=false restores eager seeking only.
 * Measures completed previews, not display scanout or physical input latency. */
import {chromium} from '../tests/support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const output='artifacts/scrub-backpressure';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});const results=[];
try{for(const gated of [false,true]){
const page=await browser.newPage({viewport:{width:1500,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>styk.ready);
await page.evaluate(async gated=>{
const {Editor}=await import('/src/editor.mjs'),{createFrame,createObject}=await import('/src/demo.mjs'),{Timeline}=await import('/src/layer-timeline.mjs');
const e=new Editor();e.selectMany([1,2,3]);const figure=e.createMovieclip({start:0,end:20,replace:false});
const objects=Array.from({length:1500},(_,i)=>createObject(figure,i+100,40+(i%40)*22,60+Math.floor(i/40)*22,{scale:.18,_stykMovieclip:{start:0,end:null,offset:i%20,speed:1,mode:'loop'}}));
styk.settingsUI.commit({timelineMode:'advanced'});styk.editor.load({...e.report,figure_types:[figure],keyframes:[createFrame(objects,120),createFrame(objects.map(o=>({...o})),1)]});styk.editor.markSaved();styk.fit();
window.bench={seeks:0,presentations:[],tasks:[],active:false,history:styk.editor.historySize,revision:styk.editor.revision};
const flush=Timeline.prototype._flushScrub;Timeline.prototype._flushScrub=function(options){window.activeTimeline=this;return flush.call(this,gated?options:{force:true});};
styk.editor.addEventListener('change',event=>{if(bench.active&&event.detail.kind==='seek')bench.seeks++;});
const renderer=styk.state.renderer,render=renderer.render;renderer.render=function(options){const value=render.call(this,options);if(bench.active&&styk.state.scrubbing)bench.presentations.push({tick:styk.editor.tick,at:performance.now(),target:activeTimeline?.pendingScrub??styk.editor.tick});return value;};
},gated);
await page.waitForFunction(()=>!styk.state.dirtyRender);await page.waitForTimeout(500);
const box=await page.locator('.sheet-scroll').boundingBox();
await page.evaluate(()=>{bench.active=true;bench.started=performance.now();bench.observer=new PerformanceObserver(list=>bench.tasks.push(...list.getEntries().map(e=>e.duration)));bench.observer.observe({type:'longtask'});});
const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
await page.mouse.move(box.x+8,box.y+15);await page.mouse.down();
const inputs=[];for(let step=1;step<=90;step++){
inputs.push(cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:box.x+8+step*7,y:box.y+15,button:'left',buttons:1}));
await new Promise(r=>setTimeout(r,8));
}await Promise.all(inputs);
await page.screenshot({path:`${output}/${gated?'after':'before'}-drag.png`});
const target=await page.evaluate(()=>activeTimeline.pendingScrub??styk.editor.tick);
await page.mouse.up();await page.waitForFunction(()=>!styk.state.dirtyRender);
await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const result=await page.evaluate(()=>{bench.active=false;bench.observer.disconnect();return {...bench,observer:undefined,elapsedMs:performance.now()-bench.started,finalTick:styk.editor.tick,historyUnchanged:bench.history===styk.editor.historySize,revisionUnchanged:bench.revision===styk.editor.revision,backend:styk.state.renderer.stats.backend,preparation:styk.state.editablePreparationStats};});
assert.equal(result.finalTick,target);assert.ok(result.historyUnchanged&&result.revisionUnchanged);assert.deepEqual(errors,[]);
if(gated)assert.ok(new Set(result.presentations.map(p=>p.tick)).size>3,'Dense scrubbing must present intermediate frames before release');
const exactPixels=await page.evaluate(async()=>{const {buildGeometry}=await import('/src/pivot/geometry.mjs'),renderer=styk.state.renderer,options={...renderer.last};renderer.render(options);const cached=renderer.canvas.toDataURL();renderer.render({...options,geometry:buildGeometry(styk.editor.report,styk.editor.evaluatedFrame)});return cached===renderer.canvas.toDataURL();});
assert.ok(exactPixels,'Released frame pixels must match fresh geometry and compilation');result.exactPixels=exactPixels;
await page.screenshot({path:`${output}/${gated?'after':'before'}-released.png`});results.push({gated,target,...result,errors});await page.close();
}
await writeFile(`${output}/report.json`,JSON.stringify(results,null,2));console.log(results.map(r=>({gated:r.gated,seeks:r.seeks,presentations:new Set(r.presentations.map(p=>p.tick)).size,longTasks:r.tasks.length,maxTask:Math.max(0,...r.tasks),elapsed:r.elapsedMs,finalTick:r.finalTick,backend:r.backend})));
}finally{await browser.close();}

