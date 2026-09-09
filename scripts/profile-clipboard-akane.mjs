import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Editor} from '../src/editor.mjs';
import {emptyDocument} from '../src/demo.mjs';
import backend from '../desktop/backend.cjs';

const source=process.argv[2]??'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const output=path.resolve(process.argv[3]??'artifacts/clipboard-akane-baseline.json');
const python=backend.pythonCandidates()[0];
const imported=spawnSync(python.command,[...python.args,'-c',String.raw`
import sys,json
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
p=Path(sys.argv[1]);print(json.dumps(server.ProjectStore(server.WORKSPACE).import_bytes(p.read_bytes(),p.name)['document']))
`,source],{encoding:'utf8',windowsHide:true,maxBuffer:512*1024*1024});
if(imported.status!==0)throw new Error(imported.error?.message??imported.stderr);
const document=JSON.parse(imported.stdout),e=new Editor({demo:false}).load(document);
const cases=[['dense-one',[document.keyframes.length-1]],['dense-64',Array.from({length:64},(_,i)=>document.keyframes.length-64+i)],['all',document.keyframes.map((_,i)=>i)]];
const results=[];
for(const[name,indices]of cases){
  e.load(document);let start=performance.now();const count=e.copyFrames(indices),copyMs=performance.now()-start;
  start=performance.now();const portable=e.frameClipboardDocument(),portableMs=performance.now()-start;
  const objects=portable.keyframes.reduce((sum,frame)=>sum+frame.objects.length,0);
  e.load(emptyDocument());start=performance.now();const pasted=e.pasteFrames(0),pasteMs=performance.now()-start;
  const row={name,keys:indices.length,objects,count,pasted,copyMs,portableMs,pasteMs,historyBytes:e._undo.at(-1)?.bytes};results.push(row);console.log(JSON.stringify(row));
}
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({date:new Date().toISOString(),source,bytes:fs.statSync(source).size,scope:'Node CPU-only synchronous model baseline; excludes native import, JSON parse and Editor.load; not browser input/presentation latency',results},null,2));
