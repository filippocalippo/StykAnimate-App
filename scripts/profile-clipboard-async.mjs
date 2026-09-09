import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Editor} from '../src/editor.mjs';
import {emptyDocument} from '../src/demo.mjs';
import backend from '../desktop/backend.cjs';
import {nodeClipboardClient} from '../tests/helpers/clipboard-node-client.mjs';

const source=process.argv[2]??'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const output=path.resolve(process.argv[3]??'artifacts/clipboard-akane-async-cpu.json');
const python=backend.pythonCandidates()[0];
const imported=spawnSync(python.command,[...python.args,'-c',String.raw`
import sys,json
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
p=Path(sys.argv[1]);print(json.dumps(server.ProjectStore(server.WORKSPACE).import_bytes(p.read_bytes(),p.name)['document']))
`,source],{encoding:'utf8',windowsHide:true,maxBuffer:512*1024*1024});
if(imported.status!==0)throw new Error(imported.error?.message??imported.stderr);
const document=JSON.parse(imported.stdout),e=new Editor({demo:false}).load(document),worker=nodeClipboardClient();e.setFrameClipboardWorker(worker);
const cases=[['dense-one',[document.keyframes.length-1]],['dense-64',Array.from({length:64},(_,i)=>document.keyframes.length-64+i)],['all',document.keyframes.map((_,i)=>i)]];
const results=[];
async function measure(operation){let maxGap=0,ticks=0,previous=performance.now();const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-previous);previous=now;ticks++;},1);
  try{const count=await operation();await new Promise(resolve=>setImmediate(resolve));return{count,eventLoopMaxGapMs:maxGap,eventLoopSamples:ticks,...e.lastClipboardTimings};}finally{clearInterval(timer);}}
try{for(const[name,indices]of cases){
  e.load(document);const copy=await measure(()=>e.copyFramesAsync(indices));
  const objects=e._frameClipboard.reduce((sum,frame)=>sum+frame.objects.length,0);
  e.load(emptyDocument());const paste=await measure(()=>e.pasteFramesAsync(0));
  const row={name,keys:indices.length,objects,copy,paste};results.push(row);console.log(JSON.stringify(row));
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({date:new Date().toISOString(),source,bytes:fs.statSync(source).size,
    scope:'Node worker CPU diagnostic; excludes native import/parse/Editor.load, no browser UI/render/presentation; event-loop intervals include GC and worker contention',results},null,2));
}}finally{worker.dispose();}
