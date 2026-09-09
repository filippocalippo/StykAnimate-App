import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {workloads,createPerformanceEditor,measureEditor} from '../tests/animation-mode-performance-fixture.mjs';

const label=process.argv[2]??'run';
if(!/^[a-z0-9-]+$/i.test(label))throw new Error('Use an alphanumeric run label.');
const result={label,measuredAt:new Date().toISOString(),environment:{node:process.version,cpu:os.cpus()[0].model,
  logicalCpus:os.cpus().length,memoryBytes:os.totalmem(),gc:Boolean(globalThis.gc)},sourceHashes:{},workloads:[]};
for(const name of (await readdir('src')).filter(name=>name.endsWith('.mjs')))
  result.sourceHashes[name]=createHash('sha256').update(await readFile(`src/${name}`)).digest('hex');
await mkdir('artifacts/animation-mode-performance',{recursive:true});
for(const config of workloads) {
  globalThis.gc?.();const started=performance.now();
  let editor=createPerformanceEditor(config);const loadMs=performance.now()-started;
  globalThis.gc?.();const loaded=process.memoryUsage();
  console.log(`BENCH ${config.name}: ${config.frames} frames, ${config.figures} figures/frame, ${config.channels*config.keys} keys`);
  try {
    const measured=await measureEditor(editor,{yieldControl:()=>new Promise(resolve=>setImmediate(resolve)),onPhase:phase=>console.log(`  ${phase} complete`)});
    globalThis.gc?.();const finished=process.memoryUsage();
    result.workloads.push({config,loadMs,memory:{processHeapAfterLoadBytes:loaded.heapUsed,retainedOperationHeapBytes:finished.heapUsed-loaded.heapUsed,rssBytes:finished.rss},...measured});
    console.log(JSON.stringify(measured.timingsMs));
  } catch(error) {result.workloads.push({config,error:error.stack});console.error(error.stack);}
  await writeFile(`artifacts/animation-mode-performance/${label}.json`,JSON.stringify(result,null,2));
  editor=null;globalThis.gc?.();
}
if(result.workloads.some(row=>row.error))process.exitCode=1;
