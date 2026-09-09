import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

// Keep runs separate: sampled runs and concurrently edited source snapshots are
// not interchangeable with the frozen, unprofiled confirmation run.
const directory=path.resolve(process.argv[2]);
const report=JSON.parse(await readFile(path.join(directory,'report.json'),'utf8'));
const stats=values=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return{n:a.length,min:a[0]??null,p50:a[Math.floor(a.length*.5)]??null,p95:a[Math.floor(a.length*.95)]??null,max:a.at(-1)??null};};
const groups={};
for(const row of report.phases){
  if(!row.parts)continue;
  const raw=JSON.parse(await readFile(path.join(directory,`${row.name}.json`),'utf8'));
  const key=`${row.scenario}/${row.repeat===1?'first':row.repeat?'repeat':'control'}`;
  const g=groups[key]??={gestures:0,invalid:0,handleCounts:[],down:[],first:[],motion:[],release:[],cancel:[],undo:[],redo:[],dispatch:[],cpu:[],raf:[],longTasks:[],rates:[],methods:{},maxRasterizedObjects:0};
  g.gestures++;
  if(row.renderingFailed||row.applicationErrors?.length||(!raw.frames.length&&!row.scenario.startsWith('hover'))){g.invalid++;continue;}
  if(row.target?.handleCount)g.handleCounts.push(row.target.handleCount);
  for(const i of raw.inputs){if(i.part==='down'&&i.type==='pointerdown')g.down.push(i.handlerMs);if(i.part==='motion')g.dispatch.push(i.at-i.eventAt);}
  for(const l of row.latencies){const group={'first-move':'first',motion:'motion',up:'release',cancel:'cancel',undo:'undo',redo:'redo'}[l.part];if(group)g[group].push(l.fromEventMs);}
  for(const f of raw.frames){if(f.part==='motion')g.cpu.push(f.cpuMs);g.maxRasterizedObjects=Math.max(g.maxRasterizedObjects,f.rasterizedObjects||0);}
  g.raf.push(...raw.raf.filter(r=>r.part==='motion').map(r=>r.ms));
  // Observer delivery may follow the task into the next gesture. Attribute by
  // task start, including when summarizing runs captured before this correction.
  g.longTasks.push(...raw.longTasks.filter(t=>t.at>=raw.start&&t.at<raw.end).map(t=>t.ms));g.rates.push(row.motionInputRate);
  for(const c of raw.calls)(g.methods[`${c.part}/${c.name}`]??=[]).push(c.ms);
}
for(const g of Object.values(groups)){
  for(const k of ['down','first','motion','release','cancel','undo','redo','dispatch','cpu','raf','longTasks','rates'])g[k]=stats(g[k]);
  g.handleCounts=[...new Set(g.handleCounts)];g.methods=Object.fromEntries(Object.entries(g.methods).map(([k,v])=>[k,stats(v)]));
}
await writeFile(path.join(directory,'drag-summary.json'),JSON.stringify({mode:report.mode,sourceUnchanged:report.sourceUnchanged,changedDuringRun:report.changedDuringRun,errors:[...new Set(report.errors)],groups},null,2));
const f=n=>n==null?'—':n.toFixed(1),range=s=>s.n?`${f(s.min)}–${f(s.max)}`:'—';
let md='All latency values are milliseconds. Event latency includes dispatch delay and ends at CPU-complete render submission, not physical display. Motion p95 pools matched input/render observations. First/repeat groups remain separate.\n\n| Scenario / gesture | Valid / total | Down handler max | First move range | Motion p95 | CPU p95 | Release range | Long task max |\n|---|---:|---:|---:|---:|---:|---:|---:|\n';
for(const [name,g] of Object.entries(groups))md+=`| ${name} | ${g.gestures-g.invalid} / ${g.gestures} | ${f(g.down.max)} | ${range(g.first)} | ${f(g.motion.p95)} | ${f(g.cpu.p95)} | ${range(g.release)} | ${f(g.longTasks.max)} |\n`;
await writeFile(path.join(directory,'drag-summary.md'),md);
console.log(md);
