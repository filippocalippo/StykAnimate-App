import {readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const directory=path.resolve(process.argv[2]);
const result={};
for(const filename of await readdir(directory)){
  if(!filename.endsWith('.cpuprofile'))continue;
  const p=JSON.parse(await readFile(path.join(directory,filename),'utf8'));
  const nodes=new Map(p.nodes.map(n=>[n.id,n])),parents=new Map(),self=new Map(),total=new Map();
  for(const n of p.nodes)for(const c of n.children||[])parents.set(c,n.id);
  for(let i=0;i<p.samples.length;i++){
    const id=p.samples[i],ms=(p.timeDeltas[i]||0)/1000;self.set(id,(self.get(id)||0)+ms);
    for(let at=id;at;at=parents.get(at))total.set(at,(total.get(at)||0)+ms);
  }
  const grouped=new Map();
  for(const [id,n] of nodes){
    const f=n.callFrame,key=`${f.url}:${f.lineNumber}:${f.functionName}`;
    const r=grouped.get(key)||{name:f.functionName||'(anonymous)',url:f.url,line:f.lineNumber+1,selfMs:0,inclusiveMs:0};
    r.selfMs+=self.get(id)||0;r.inclusiveMs+=total.get(id)||0;grouped.set(key,r);
  }
  const rows=[...grouped.values()];
  result[filename]={durationMs:(p.endTime-p.startTime)/1000,self:rows.sort((a,b)=>b.selfMs-a.selfMs).slice(0,20),
    appInclusive:rows.filter(r=>r.url.includes('/src/')).sort((a,b)=>b.inclusiveMs-a.inclusiveMs).slice(0,24)};
}
await writeFile(path.join(directory,'cpu-summary.json'),JSON.stringify(result,null,2));
for(const [name,r] of Object.entries(result))console.log(JSON.stringify({name,durationMs:r.durationMs,self:r.self.slice(0,7),app:r.appInclusive.slice(0,8)}));
