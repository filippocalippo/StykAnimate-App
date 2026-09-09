import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Editor} from '../src/editor.mjs';
import {buildGeometry,timeline,evaluatedFrame} from '../src/pivot/geometry.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';
import backend from '../desktop/backend.cjs';

function api(request) {
  const script=String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
r=json.load(sys.stdin);store=server.ProjectStore(server.WORKSPACE)
if 'path' in r:
 p=server.WORKSPACE/r['path']; imported=store.import_bytes(p.read_bytes(),p.name)
 raw,_=store.export({'document':imported['document'],'sourceId':imported['sourceId'],'format':'styk'})
 print(raw.decode('utf-8'))
else:
 raw,name=store.export(r); imported=store.import_bytes(raw,name)
 print(json.dumps(imported['document']))
`;
  const python=backend.pythonCandidates()[0],result=spawnSync(python.command,[...python.args,'-c',script],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),input:JSON.stringify(request),encoding:'utf8',windowsHide:true,maxBuffer:20*1024*1024});
  assert.equal(result.status,0,result.error?.message||result.stderr);return JSON.parse(result.stdout);
}
function geometry(report,tick) {
  const rows=timeline(report);let index=0;
  while(index+1<rows.length&&rows[index+1].start<=tick)index++;
  const row=rows[index];return buildGeometry(report,evaluatedFrame(report,index,row.count?(tick-row.start)/row.count:0,tick));
}
function compare(actual,expected,label) {
  assert.equal(actual.objects.size,expected.objects.size,label);
  for (const [slot,object] of expected.objects) {
    const next=actual.objects.get(slot);assert.ok(next,label);
    for(const [id,p]of object.joints) {
      const q=next.joints.get(id);assert.ok(q,`${label}:${id}`);
      assert.ok(Math.abs(p.x-q.x)<.002&&Math.abs(p.y-q.y)<.002,`${label}:${id}:${JSON.stringify([p,q])}`);
    }
  }
  assert.deepEqual(actual.drawables.map(x=>x.rgb),expected.drawables.map(x=>x.rgb),label);
}
const modern=api({path:'Pivot Animator v5/Animations/text_bike.piv'});
for(const [version,file]of [[2,'walking.piv'],[3,'cursor.piv'],[4,'sprite_demo.piv']])test(`real V${version} destination and native text clipboard preserve all old ticks through PIV/STYK/restart`,()=>{
  const legacy=api({path:`Pivot Animator v5/Animations/Legacy/${file}`});assert.equal(legacy.version,version);
  const e=new Editor({demo:false}).load(structuredClone(modern));e.copyFrames([0]);e.load(legacy);
  const before=structuredClone(e.report),oldTicks=e.totalTicks,history=e._undo.length;
  e.appendClipboardFrames();assert.equal(e.report.version,5);assert.equal(e._undo.length,history+1);
  assert.equal(e.report._stykSource.sha256,before._stykSource.sha256);
  assert.equal(e.report._stykSource.source_base64,before._stykSource.source_base64);
  const current=materializePivotDocument(e.report),piv=api({document:current,format:'piv'}),styk=api({document:e.report,format:'styk'});
  const afterRestart=api({document:materializePivotDocument(styk),format:'piv'});
  assert.ok(piv.figure_types.some(f=>f.text_assets?.length),'Pasted native text remains embedded');
  if(version===4)assert.ok(piv.figure_types.some(f=>f.image_assets?.length),'Legacy sprite remains embedded');
  for(let tick=0;tick<oldTicks;tick++) {
    compare(geometry(e.report,tick),geometry(before,tick),`live:${tick}`);
    compare(geometry(piv,tick),geometry(current,tick),`piv:${tick}`);
    compare(geometry(afterRestart,tick),geometry(current,tick),`restart:${tick}`);
  }
  compare(geometry(piv,oldTicks),geometry(current,oldTicks),'pasted text');
  const after=structuredClone(e.report);e.undo();assert.deepEqual(e.report,before);e.redo();assert.deepEqual(e.report,after);
});
