/** Local regression evidence for the supplied hands pack; runs outside the UI. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {nodeCodec, exportDocument, importBytes} from '../tests/support/codec.mjs';
import {Editor} from '../src/editor.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';
import {synchronizeExistingDerived} from '../src/document-normalize.mjs';
import {buildGeometry,evaluatedFrame,timeline} from '../src/pivot/geometry.mjs';

const directory='artifacts/figure-palette';await mkdir(directory,{recursive:true});
const source=JSON.parse(await readFile(process.argv[2]??`${directory}/hands-source.json`,'utf8'));
const e=new Editor({demo:false,propertyChannels:true,layerTimeline:true}).load(source);
const uid=e.evaluatedFrame.objects[0].unique_id;e.select(uid);
const timings={},measure=(key,fn)=>{const start=performance.now(),value=fn();timings[key]=performance.now()-start;return value;};
const initial=e.figurePalette(),count=e.figure.segments.length;
measure('figureColorMs',()=>e.setFigureColor('#44aacc'));
e.select(uid,0);measure('segmentColorMs',()=>e.updateBuilderSegmentStyle({color:'#eecc11'}));
measure('paletteReplaceMs',()=>e.replaceFigureColor('#44aacc','#778899'));
assert.deepEqual(e.figurePalette().map(p=>[p.color,p.segments.length]),[['#778899',count-1],['#eecc11',1]]);
const historyBytes=e._undo.reduce((sum,command)=>sum+Buffer.byteLength(JSON.stringify(command)),0);
const saved=measure('serializeMs',()=>e.serialize());await writeFile(`${directory}/hands-edited.json`,JSON.stringify(saved));
const materialized=measure('materializeMs',()=>materializePivotDocument(saved));synchronizeExistingDerived(materialized);
await writeFile(`${directory}/hands-pivot.json`,JSON.stringify(materialized));
// Export each through the codec the app runs and reopen it, as a save and a later open would.
for(const [format,stem,document] of [['styk','hands-edited',saved],['piv','hands-pivot',materialized]]){
  const codec=nodeCodec(),{bytes,name}=await exportDocument({document:JSON.parse(JSON.stringify(document)),format,filename:`${stem}.${format}`},{codec});
  await writeFile(`${directory}/${stem}.${format}`,bytes);
  const reopenedDocument=(await importBytes(bytes,name,{codec})).document;
  await writeFile(`${directory}/${stem}-reopened.json`,JSON.stringify(reopenedDocument));
  console.log(format,bytes.length,'bytes',reopenedDocument.keyframes.length,'keys');
}
const reopened=JSON.parse(await readFile(`${directory}/hands-edited-reopened.json`,'utf8'));
const native=JSON.parse(await readFile(`${directory}/hands-pivot-reopened.json`,'utf8'));
const digest=(report,frame)=>{
  const geometry=buildGeometry(report,frame);
  return [...geometry.objects.values()].map(g=>({uid:g.obj.unique_id,segments:g.segments.map(s=>({rgb:s.rgb,alpha:s.alpha,start:s.start,end:s.end})),polys:g.polys.map(p=>({rgb:p.rgb,alpha:p.alpha}))})).sort((a,b)=>a.uid-b.uid);
};
const sample=(report,tick)=>{const rows=timeline(report);let index=0;while(index+1<rows.length&&rows[index+1].start<=tick)index++;return evaluatedFrame(report,index,rows[index].count?(tick-rows[index].start)/rows[index].count:0,tick);};
const ticks=[0,1,10,Math.max(0,e.totalTicks-1)];
for(const tick of new Set(ticks)){
  const expected=digest(e.report,sample(e.report,tick));
  assert.deepEqual(digest(reopened,sample(reopened,tick)),expected,`STYK round trip at ${tick}`);
  const actual=digest(native,sample(native,tick));
  assert.equal(actual.length,expected.length,`PIV object count at ${tick}`);
  for(let i=0;i<actual.length;i++)assert.ok(JSON.stringify([actual[i].uid,actual[i].segments.map(s=>[s.rgb,s.alpha]),actual[i].polys])===JSON.stringify([expected[i].uid,expected[i].segments.map(s=>[s.rgb,s.alpha]),expected[i].polys]),`PIV colors at ${tick}, figure ${expected[i].uid}`);
  for(let i=0;i<actual.length;i++)for(let j=0;j<actual[i].segments.length;j++)for(const point of ['start','end'])for(const axis of ['x','y'])assert.ok(Math.abs(actual[i].segments[j][point][axis]-expected[i].segments[j][point][axis])<.002,`PIV geometry at ${tick}`);
}
const evidence={source:{version:source.version,frames:source.keyframes.length,figureTypes:source.figure_types.length,firstFrameObjects:source.keyframes[0].objects.length},uid,segments:count,initial:initial.map(p=>[p.color,p.segments.length]),final:e.figurePalette().map(p=>[p.color,p.segments.length]),historyBytes,timings,verifiedTicks: ticks};
await writeFile(`${directory}/roundtrip-report.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
