import {chromium} from '../tests/support/playwright.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Candidate artwork is authored with native StykAnimate segments, then saved
// and rendered by the running app. Selection of the shipped default is pending.
const out = path.resolve('artifacts/startup-styles');
await mkdir(out, {recursive:true});
const points=[[0,0],[-18,-77],[-36,-96],[-80,-48],[-124,-59],[48,-110],[62,-161],[-43,66],[-101,112],[67,27],[55,73]];
const candidates = ['Contour','Robot','Bubble','Origami','Ink'].map(name=>({name,width:20,points}));
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1500,height:1000},acceptDownloads:true});
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
try {
  await page.goto('http://127.0.0.1:47831');
  await page.waitForFunction(()=>window.styk?.ready);
  for (const [i,candidate] of candidates.entries()) {
    const stem=`${i+1}-${candidate.name.toLowerCase()}`;
    await page.evaluate(async c=>{
      const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
      const doc=emptyDocument(), parents=[0,1,1,3,1,5,0,7,0,9];
      const segments=parents.map((parent,index)=>{
        const id=index+1, start=c.points[parent],end=c.points[id];
        return {segment_id:id,parent_id:parent,length:Math.hypot(end[0]-start[0],end[1]-start[1]),
          angle_rad:Math.atan2(end[1]-start[1],end[0]-start[0]),thickness:c.width,
          bend_rad:0,primitive_code:0,aux_code:0,flags:0,segment_type:'line',segment_kind:'line',
          color_rgb:[13,153,255],transparency:0,visible:true,z_order:id};
      });
      // The head is a filled circle attached at the shoulder, with an invisible
      // neck segment keeping the silhouette detached like the software logo.
      Object.assign(segments[1],{visible:false});
      segments.push({...segments[0],segment_id:11,parent_id:2,length:43,angle_rad:-Math.PI/2,
        thickness:0,primitive_code:3,flags:3,segment_type:'circle',segment_kind:'circleFill',z_order:11});
      const polyfills=[], blue=[13,153,255],dark=[16,44,75],white=[255,255,255];
      const add=(parent,dx,dy,extra={})=>{
        const id=segments.length+1;
        segments.push({...segments[0],segment_id:id,parent_id:parent,length:Math.hypot(dx,dy),angle_rad:Math.atan2(dy,dx),visible:true,z_order:100+id,...extra});return id;
      };
      const disc=(parent,dx,dy,r,color,filled=true,width=3)=>{
        const anchor=add(parent,dx,dy+r,{visible:false});
        return add(anchor,0,-r*2,{primitive_code:filled?3:1,flags:filled?3:1,segment_type:'circle',segment_kind:filled?'circleFill':'circle',thickness:filled?0:width,color_rgb:color});
      };
      const polygon=(parent,vertices,color)=>{
        let previous=[0,0],p=parent;const ids=[];
        for(const v of vertices){p=add(p,v[0]-previous[0],v[1]-previous[1],{visible:false});ids.push(p);previous=v;}
        polyfills.push({segment_ids:ids,color_rgb:color,color_alpha:1,z_order:50+polyfills.length});
      };
      if(c.name==='Contour') {
        segments[10].visible=false;
        // Outer and inner strokes share the same native attachment points.
        for(const s of segments.slice(0,10).filter(s=>s.visible)) {
          s.thickness=24;s.color_rgb=dark;
          add(s.parent_id,Math.cos(s.angle_rad)*s.length,Math.sin(s.angle_rad)*s.length,{thickness:15,color_rgb:white});
        }
        disc(2,0,-24,24,blue,false,5);
      } else if(c.name==='Robot') {
        segments[10].visible=false;
        for(const s of segments.slice(0,10).filter(s=>s.visible)){s.thickness=s.segment_id===1?33:22;s.color_rgb=blue;}
        for(const joint of [0,1,3,5,7,9]){disc(joint,0,0,12,dark);disc(joint,0,0,5,[116,214,255]);}
        polygon(2,[[-28,-45],[24,-45],[29,-36],[29,-4],[-28,-4]],dark);
        polygon(2,[[-23,-39],[22,-39],[22,-14],[-23,-14]],[69,183,255]);
        add(2,-15,-25,{visible:false});const eye=segments.length;
        add(eye,29,0,{thickness:7,color_rgb:dark});
        disc(2,-8,-25,3,white);disc(2,8,-25,3,white);
      } else if(c.name==='Bubble') {
        segments[10].visible=false;
        for(const s of segments.slice(0,10).filter(s=>s.visible))s.thickness=s.segment_id===1?48:25;
        disc(2,0,-27,38,blue);
        for(const joint of [4,6,8,10])disc(joint,0,0,18,blue);
        disc(2,-12,-30,4,dark);disc(2,9,-30,4,dark);
        add(2,-5,-16,{visible:false});add(segments.length,10,0,{thickness:4,color_rgb:dark});
        disc(1,-2,18,9,[159,224,255]);
      } else if(c.name==='Origami') {
        for(const s of segments)s.visible=false;
        for(const s of segments.slice(0,10).filter(s=>s.segment_id!==2)){
          const x=Math.cos(s.angle_rad)*s.length,y=Math.sin(s.angle_rad)*s.length,w=s.segment_id===1?22:13;
          const nx=-Math.sin(s.angle_rad)*w,ny=Math.cos(s.angle_rad)*w;
          polygon(s.parent_id,[[nx,ny],[x+nx*.45,y+ny*.45],[x-nx*.45,y-ny*.45],[-nx,-ny]],blue);
          polygon(s.parent_id,[[0,0],[x+nx*.45,y+ny*.45],[x-nx*.45,y-ny*.45]],s.segment_id%2?dark:[86,199,255]);
        }
        polygon(2,[[0,-59],[30,-27],[0,1],[-30,-27]],blue);
        polygon(2,[[0,-59],[30,-27],[0,1]],dark);
      } else {
        for(const s of segments)s.visible=false;
        for(const s of segments.slice(0,10).filter(s=>s.segment_id!==2)){
          const x=Math.cos(s.angle_rad)*s.length,y=Math.sin(s.angle_rad)*s.length,w=s.segment_id===1?19:12;
          const nx=-Math.sin(s.angle_rad)*w,ny=Math.cos(s.angle_rad)*w;
          polygon(s.parent_id,[[nx,ny],[x+nx*.1,y+ny*.1],[x-nx*.1,y-ny*.1],[-nx*.5,-ny*.5]],dark);
        }
        disc(2,0,-25,25,blue,false,9);
        polygon(1,[[-9,0],[13,-5],[22,65],[7,50]],blue);
      }
      const figure={figure_type_id:1,name:c.name,segment_count:segments.length,segments,polyfills,image_assets:[],text_assets:[]};
      doc.figure_types=[figure];doc.keyframes=[createFrame([createObject(figure,1,490,300)],1)];
      doc._styk.name=`Logo ${c.name}`;
      styk.editor.load(doc,doc._styk.name);styk.editor.select(null);
    },candidate);
    await page.waitForTimeout(500);
    const state=await page.evaluate(()=>({frames:styk.editor.report.keyframes.length,objects:styk.editor.frame.objects.length,ticks:styk.editor.totalTicks}));
    assert.deepEqual(state,{frames:1,objects:1,ticks:1});
    const bytes=await page.evaluate(async()=>{
      const {DocumentExporter}=await import('/src/document-export.mjs');
      const exporter=new DocumentExporter();
      try {return Array.from(new Uint8Array(await (await exporter.export(styk.editor.report,{name:styk.editor.name})).arrayBuffer()));}
      finally {exporter.dispose();}
    });
    await writeFile(path.join(out,`${stem}.styk`),Buffer.from(bytes));
    const png=await page.evaluate(async()=>{
      const {pageExporter}=await import('/tests/support/page-export.mjs');
      const renderer=pageExporter({width:960,height:540});
      try {await renderer.load(styk.editor.report); const canvas=await renderer.renderTick(0);return canvas.toDataURL('image/png').split(',')[1];}
      finally {renderer.dispose();}
    });
    await writeFile(path.join(out,`${stem}.png`),Buffer.from(png,'base64'));
    await page.keyboard.press('Escape');
    await page.screenshot({path:path.join(out,`${stem}-editor.png`)});
    await page.evaluate(()=>styk.editor.markSaved());
    await page.locator('#file-input').setInputFiles(path.join(out,`${stem}.styk`));
    await page.waitForFunction(name=>styk.editor.name===name,stem);
    assert.deepEqual(await page.evaluate(()=>({frames:styk.editor.report.keyframes.length,objects:styk.editor.frame.objects.length,ticks:styk.editor.totalTicks})),state);
    console.log(`Saved and rendered ${stem}`);
  }
  assert.deepEqual(errors,[]);
  await writeFile(path.join(out,'verification.json'),JSON.stringify({candidates:candidates.map(c=>c.name),framesPerProject:1,figuresPerFrame:1,errors},null,2));
} catch(error) {await page.screenshot({path:path.join(out,'failure.png')});console.log(await page.locator('body').innerText());throw error;} finally {await browser.close();}
