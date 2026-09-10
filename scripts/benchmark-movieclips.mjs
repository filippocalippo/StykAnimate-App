import {Editor} from '../src/editor.mjs';
import {createFrame,createObject} from '../src/demo.mjs';
import {buildGeometry,evaluatedFrame} from '../src/pivot/geometry.mjs';
import {movieclipCacheStats} from '../src/movieclip-geometry.mjs';
import {writeFile,mkdir} from 'node:fs/promises';

const results=[];
for(const count of [1,25,100,250]){
  const editor=new Editor();editor.select(1);const figure=editor.createMovieclip({start:0,end:20,replace:false});
  const objects=Array.from({length:count},(_,i)=>createObject(figure,i+100,100+(i%25)*30,100+Math.floor(i/25)*30,{_stykMovieclip:{start:0,end:null,offset:0,speed:1,mode:'loop'}}));
  const report={...editor.report,figure_types:[figure],keyframes:[createFrame(objects,120),createFrame(objects.map(o=>({...o})),1)]};
  const sample=tick=>buildGeometry(report,evaluatedFrame(report,0,tick/120,tick));
  const start=performance.now();for(let tick=0;tick<20;tick++)sample(tick);const warmup=performance.now()-start;
  const times=[];let drawableCount=0;
  for(let repeat=0;repeat<8;repeat++)for(let tick=0;tick<20;tick++){
    const start=performance.now();const geometry=sample(tick);times.push(performance.now()-start);drawableCount=geometry.drawables.length;
  }
  times.sort((a,b)=>a-b);
  results.push({instances:count,drawables:drawableCount,warmupMs:+warmup.toFixed(3),medianGeometryMs:+times[Math.floor(times.length*.5)].toFixed(3),p95GeometryMs:+times[Math.floor(times.length*.95)].toFixed(3),...movieclipCacheStats(figure)});
}
await mkdir('artifacts/movieclips',{recursive:true});
await writeFile('artifacts/movieclips/performance.json',JSON.stringify({runtime:process.version,scope:'CPU evaluated-frame and geometry generation; excludes GPU presentation, resource decoding and UI',results},null,2));
console.table(results);
