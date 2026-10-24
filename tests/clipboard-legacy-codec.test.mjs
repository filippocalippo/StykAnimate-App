import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {Editor} from '../src/editor.mjs';
import {buildGeometry,timeline,evaluatedFrame} from '../src/pivot/geometry.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';
import {missingFixture} from './helpers/local-fixtures.mjs';
import {exportDocument, importBytes, nodeCodec} from './support/codec.mjs';

// A corpus file (beside the repository) through import and a .styk save; otherwise an export and its reimport.
async function api(request) {
  const codec=nodeCodec();
  if (request.path) {
    const file=fileURLToPath(new URL(`../../${request.path}`,import.meta.url));
    const imported=await importBytes(readFileSync(file),path.basename(file),{codec});
    const {bytes}=await exportDocument({document:imported.document,sourceId:imported.sourceId,format:'styk'},{codec});
    return (await importBytes(bytes,'roundtrip.styk',{codec})).document;
  }
  const {bytes,name}=await exportDocument(request,{codec});
  return (await importBytes(bytes,name,{codec})).document;
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
const skip=missingFixture(...['text_bike.piv','Legacy/walking.piv','Legacy/cursor.piv','Legacy/sprite_demo.piv'].map(file=>`../Pivot Animator v5/Animations/${file}`));
const modern=skip?null:await api({path:'Pivot Animator v5/Animations/text_bike.piv'});
for(const [version,file]of [[2,'walking.piv'],[3,'cursor.piv'],[4,'sprite_demo.piv']])test(`real V${version} destination and native text clipboard preserve all old ticks through PIV/STYK/restart`,{skip},async()=>{
  const legacy=await api({path:`Pivot Animator v5/Animations/Legacy/${file}`});assert.equal(legacy.version,version);
  const e=new Editor({demo:false}).load(structuredClone(modern));e.copyFrames([0]);e.load(legacy);
  const before=structuredClone(e.report),oldTicks=e.totalTicks,history=e._undo.length;
  e.appendClipboardFrames();assert.equal(e.report.version,5);assert.equal(e._undo.length,history+1);
  assert.equal(e.report._stykSource.sha256,before._stykSource.sha256);
  assert.equal(e.report._stykSource.source_base64,before._stykSource.source_base64);
  const current=materializePivotDocument(e.report),piv=await api({document:current,format:'piv'}),styk=await api({document:e.report,format:'styk'});
  const afterRestart=await api({document:materializePivotDocument(styk),format:'piv'});
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
