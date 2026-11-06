import {messageError} from './localized-error.mjs';
// Bounded, content-free diagnostic contract. Kept separate from legacy histograms.
export const PERFORMANCE_BOUNDS = Object.freeze([1,2,4,8,12,16,20,25,33,40,50,66,80,100,125,150,200,250,350,500,750,1000,2000,5000,15000,60000,300000,3600000]);
export const RESOURCE_BOUNDS = Object.freeze([1,4,16,64,128,256,512,768,1024,1536,2048,3072,4096,8192,16384,65536,1e9]);
export const PERFORMANCE_METRICS = Object.freeze(Object.fromEntries([
  ...['frame','scene','geometry','prepare','submit','camera','vfx','overlay','worker_roundtrip','worker_compute','worker_queue','worker_transfer','serialize','decode','encode','dialog','write','loaf','loaf_script','loaf_layout','gpu'].map(name=>[name,{family:'stage',unit:'ms'}]),
  ...['edit','seek','pan','zoom','undo','redo','command'].map(name=>['action_'+name,{family:'action',unit:'ms'}]),
  ...['heap','gpu','process','backend','cache'].map(name=>['memory_'+name,{family:'memory',unit:'MiB'}]),
  ...['hits','misses','evictions','pending'].map(name=>['cache_'+name,{family:'cache',unit:'count'}]),
  ['playback_interval',{family:'playback',unit:'ms'}], ['playback_lateness',{family:'playback',unit:'ms'}], ['quality_reduced',{family:'playback',unit:'ms'}],
  ...['gpu','vfx','import_worker','playback_worker','camera'].map(name=>['recovery_'+name,{family:'recovery',unit:'ms'}]),
]));
export const PERFORMANCE_CONTEXT = Object.freeze({
  backend:['unknown','webgpu','webgl2','canvas2d','unavailable'],
  complexity:['unknown','under-100','100-999','1000-9999','10000-plus'],
  fps:['unknown','up-to-24','25-30','31-60','over-60'],
  pixels:['unknown','under-1mp','1-4mp','4mp-plus'],
  phase:['unknown','editing','playing','before_open','opened','stopped','closed','idle'],
  quality:['unknown','full','reduced'],
  outcome:['observed','started','recovered','failed','cancelled','unresolved'],
  source:['unknown','app','renderer','timeline','editor','camera','vfx','other'],
});
export const COVERAGE_KEYS = Object.freeze(['frame_candidates','frame_sampled','action_candidates','action_sampled','action_unpresented','background_excluded','dropped','incident_dropped','loaf_supported','loaf_unsupported','gpu_supported','gpu_unsupported']);
export const MAX_PERFORMANCE_ROWS=48, MAX_INCIDENTS=3, PERFORMANCE_BYTE_BUDGET=16000;
const familyCaps={stage:24,action:7,memory:18,cache:4,playback:3,recovery:8};
const indexes=new WeakMap();
const priority=row=>PERFORMANCE_METRICS[row.metric].family==='recovery'?100:PERFORMANCE_METRICS[row.metric].family==='memory'&&['closed','idle'].includes(row.context.phase)?90:PERFORMANCE_METRICS[row.metric].family==='memory'&&['stopped','before_open','opened'].includes(row.context.phase)?70:row.metric.startsWith('action_')?50:row.metric==='playback_lateness'?46:row.metric==='playback_interval'?45:row.metric==='frame'?40:20;
const validNumber=(n,max=1e9)=>Number.isFinite(n)&&n>=0&&n<=max;
const integer=(n,max=1e9)=>Number.isSafeInteger(n)&&validNumber(n,max);
const sameFields=(a,b)=>b&&Object.keys(a).length===Object.keys(b).length&&Object.entries(a).every(([key,value])=>b[key]===value);
const fail=()=>{throw messageError(new TypeError(''), "errors.telemetryPerformanceSchema.invalidPerformanceDiagnostics", {});};
export const performanceBounds=metric=>PERFORMANCE_METRICS[metric]?.unit==='ms'?PERFORMANCE_BOUNDS:RESOURCE_BOUNDS;
export function performanceContext(value={}) {
  const result=Object.fromEntries(Object.entries(PERFORMANCE_CONTEXT).map(([key,choices])=>[key,choices.includes(value[key])?value[key]:choices[0]]));
  result.features=integer(value.features,31)?value.features:0;
  return result;
}
export function provenance(value={}) {
  return {release:/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z0-9.]{1,24})?$/.test(value.release||'')?value.release:'0.0.0',
    build:/^(unknown|[a-f0-9]{12,40})$/.test(value.build||'')?value.build:'unknown',
    traffic:['external','internal','mixed','unknown'].includes(value.traffic)?value.traffic:'unknown',
    ram:['4-or-less','8','16','32','64-plus'].includes(value.ram)?value.ram:'unknown',
    cpu:['2-or-less','4','8','16','32-plus'].includes(value.cpu)?value.cpu:'unknown',
    gpu:['nvidia','amd','intel','apple','qualcomm','software'].includes(value.gpu)?value.gpu:'unknown'};
}
export const performanceKey=row=>JSON.stringify([row.metric,row.context,row.provenance]);
export function emptyPerformance(){return {rows:[],incidents:[],coverage:{}};}
export function coverage(perf,key,n=1){if(COVERAGE_KEYS.includes(key)&&integer(n))perf.coverage[key]=Math.min(1e9,(perf.coverage[key]||0)+n);}
export function performanceSlot(perf,metric,context={},source={}) {
  if(!Object.hasOwn(PERFORMANCE_METRICS,metric))return null;
  const candidate={metric,context:performanceContext(context),provenance:provenance(source)};
  let index=indexes.get(perf);
  if(!index||index.rows.size!==perf.rows.length){index={rows:new Map(perf.rows.map(row=>[performanceKey(row),row])),families:{}};for(const row of perf.rows){const family=PERFORMANCE_METRICS[row.metric].family;index.families[family]=(index.families[family]||0)+1;}indexes.set(perf,index);}
  const key=performanceKey(candidate),found=index.rows.get(key);
  if(found)return found;
  const family=PERFORMANCE_METRICS[metric].family;
  const fullFamily=(index.families[family]||0)>=familyCaps[family];
  if(perf.rows.length>=MAX_PERFORMANCE_ROWS||fullFamily){
    let victim=null;
    for(const row of perf.rows)if((!fullFamily||PERFORMANCE_METRICS[row.metric].family===family)&&(!victim||priority(row)<priority(victim)))victim=row;
    if(!victim||priority(candidate)<=priority(victim))return null;
    const victimFamily=PERFORMANCE_METRICS[victim.metric].family;
    perf.rows.splice(perf.rows.indexOf(victim),1);index.rows.delete(performanceKey(victim));index.families[victimFamily]--;
    coverage(perf,'dropped',Math.max(victim.eligible,victim.count));
  }
  const row={...candidate,count:0,sum:0,max:0,buckets:performanceBounds(metric).map(()=>0),eligible:0,missed:0};
  perf.rows.push(row);index.rows.set(key,row);index.families[family]=(index.families[family]||0)+1;return row;
}
export function recordPerformance(perf,metric,value,context={},source={},eligible=1,missed=0) {
  if(!Object.hasOwn(PERFORMANCE_METRICS,metric)||value!==null&&!validNumber(value,performanceBounds(metric).at(-1)))return;
  const row=performanceSlot(perf,metric,context,source);
  if(!row){coverage(perf,'dropped',Math.max(eligible,1));return;}
  row.eligible=Math.min(1e9,row.eligible+eligible);
  if(value===null)return;
  if(row.count>=1e9){coverage(perf,'dropped');return;}
  row.count++;row.sum+=value;row.max=Math.max(row.max,value);row.missed+=missed?1:0;
  row.buckets[performanceBounds(metric).findIndex(bound=>value<=bound)]++;
}
export function addIncident(perf,incident) {
  if(perf.incidents.length>=MAX_INCIDENTS){
    const index=perf.incidents.reduce((best,row,i)=>row.duration<perf.incidents[best].duration?i:best,0);
    coverage(perf,'incident_dropped');
    if(incident.duration<=perf.incidents[index].duration)return;
    perf.incidents.splice(index,1);
  }
  perf.incidents.push(incident);
}
export function mergePerformance(target,incoming,source) {
  for(const [key,n] of Object.entries(incoming.coverage))coverage(target,key,n);
  for(const entry of incoming.rows){
    const row=performanceSlot(target,entry.metric,entry.context,source||entry.provenance);
    if(!row||row.count+entry.count>1e9){coverage(target,'dropped',Math.max(entry.eligible,entry.count));continue;}
    row.count+=entry.count;row.sum+=entry.sum;row.max=Math.max(row.max,entry.max);
    row.eligible=Math.min(1e9,row.eligible+entry.eligible);row.missed+=entry.missed;
    entry.buckets.forEach((n,i)=>row.buckets[i]+=n);
  }
  for(const incident of incoming.incidents)addIncident(target,{...incident,provenance:source||incident.provenance});
}
export function trimPerformance(perf,budget=PERFORMANCE_BYTE_BUDGET) {
  // Drop whole contextual groups, never truncate a histogram or lose its coverage flag.
  while(JSON.stringify(perf).length>budget&&(perf.rows.length||perf.incidents.length)){
    if(perf.incidents.length){perf.incidents.pop();coverage(perf,'incident_dropped');}
    else {let index=0;for(let i=1;i<perf.rows.length;i++)if(priority(perf.rows[i])<priority(perf.rows[index]))index=i;const [row]=perf.rows.splice(index,1);coverage(perf,'dropped',Math.max(row.eligible,row.count));}
  }
  return perf;
}
export function validatePerformance(value=emptyPerformance()) {
  if(!value||!Array.isArray(value.rows)||value.rows.length>MAX_PERFORMANCE_ROWS||!Array.isArray(value.incidents)||value.incidents.length>MAX_INCIDENTS||!value.coverage||JSON.stringify(value).length>20000)fail();
  const clean=emptyPerformance(),keys=new Set();
  for(const [key,n] of Object.entries(value.coverage)){if(!COVERAGE_KEYS.includes(key)||!integer(n))fail();clean.coverage[key]=n;}
  for(const entry of value.rows){
    if(!entry||!Object.hasOwn(PERFORMANCE_METRICS,entry.metric))fail();
    const context=performanceContext(entry.context),source=provenance(entry.provenance);
    if(!sameFields(context,entry.context)||!sameFields(source,entry.provenance))fail();
    const bounds=performanceBounds(entry.metric);
    if(!integer(entry.count)||!integer(entry.eligible)||!integer(entry.missed)||entry.missed>entry.count||!validNumber(entry.sum,1e18)||!validNumber(entry.max,bounds.at(-1))||!Array.isArray(entry.buckets)||entry.buckets.length!==bounds.length||!entry.buckets.every(n=>integer(n))||entry.buckets.reduce((a,b)=>a+b,0)!==entry.count||entry.sum>entry.max*entry.count+.01)fail();
    const row={metric:entry.metric,context,provenance:source,count:entry.count,sum:entry.sum,max:entry.max,buckets:[...entry.buckets],eligible:entry.eligible,missed:entry.missed};
    const key=performanceKey(row);if(keys.has(key))fail();keys.add(key);clean.rows.push(row);
  }
  for(const incident of value.incidents){
    if(!incident||!['stall','error','gpu'].includes(incident.kind)||!validNumber(incident.duration,3600000)||!Array.isArray(incident.recent)||incident.recent.length>4)fail();
    const context=performanceContext(incident.context),source=provenance(incident.provenance);
    if(!sameFields(context,incident.context)||!sameFields(source,incident.provenance))fail();
    const stages={};
    if(!incident.stages||Object.keys(incident.stages).length>12)fail();
    for(const [key,n] of Object.entries(incident.stages)){if(PERFORMANCE_METRICS[key]?.family!=='stage'||!validNumber(n,3600000))fail();stages[key]=n;}
    const recent=incident.recent.map(row=>{if(!Array.isArray(row)||row.length!==3||!row.every(n=>validNumber(n)))fail();return [...row];});
    clean.incidents.push({kind:incident.kind,duration:incident.duration,context,provenance:source,stages,recent});
  }
  return clean;
}
export function performancePercentile(row,fraction=.95){
  if(!row?.count)return null;let count=0;
  for(const [i,bound] of performanceBounds(row.metric).entries())if((count+=row.buckets[i])>=Math.ceil(row.count*fraction))return Math.min(bound,row.max);
  return null;
}
