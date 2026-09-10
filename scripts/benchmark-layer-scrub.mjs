import {readFileSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {Editor} from '../src/editor.mjs';
const report=JSON.parse(readFileSync(process.argv[2]??'artifacts/timeline-source.json','utf8'));
const results=[];
for(const mode of ['native','layers','edited-layers']){
  const e=new Editor({demo:false,propertyChannels:true,layerTimeline:mode!=='native'}).load(report);
  if(mode==='edited-layers')e.sheetInsertKey(['layer-1'],10);
  if(mode!=='native')e.selectSheetLayer('layer-1');
  const measure=geometry=>{
    const values=[];for(let pass=0;pass<3;pass++)for(let tick=0;tick<e.totalTicks;tick++){
      const start=performance.now();e.seek(tick);if(geometry)void e.geometry;
      if(pass)values.push(performance.now()-start);
    }
    values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length*.5)],p95Ms:values[Math.floor(values.length*.95)],totalMs:values.reduce((a,b)=>a+b,0)};
  };
  results.push({mode,seek:measure(false),geometry:measure(true)});
}
console.log(JSON.stringify(results,null,2));
if(process.env.STYK_BENCH_OUT)writeFileSync(process.env.STYK_BENCH_OUT,JSON.stringify(results,null,2));
