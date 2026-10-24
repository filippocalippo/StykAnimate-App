// Cropped movieclips retain source easing through fractional final output frames.
import {fileURLToPath} from 'node:url';
import {writeFileSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {timeline, evaluatedFrame} from '../../src/pivot/geometry.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
import {documentOf, limb, open, nextKey, createFrame, writeProject, writeReference} from './fixture-kit.mjs';
const out = fileURLToPath(new URL('../crates/styk-eval/tests/fixtures/movieclip-source/', import.meta.url));
mkdirSync(out, {recursive:true});
for (const sheet of [false, true]) {
 const e=open(documentOf([limb(), limb()], i=>[200+i*150,160]));
 nextKey(e,8);e.select(1);e.moveSelection(100,-25);e.rotateFigure(.9);e.seek(0);e.report.keyframes[0]._styk.easing={interpolation:'bezier',bezier:[.2,.02,.4,.94]};
 const captured=open(e.report,sheet?{layerTimeline:true,propertyChannels:true}:{});captured.select(1);const figure=captured.createMovieclip({start:2,end:7,replace:false,name:'Cropped motion'});
 const name=`cropped-${sheet?'sheet':'native'}`;
 const document=structuredClone(figure._styk.movieclip.document);
 writeFileSync(`${out}/${name}.json`,JSON.stringify(document)+'\n');
 // Direct evaluation permits the final fractional interval; Editor.seek clamps
 // interactive seeks to the last whole output tick, which would record tick 4
 // under the labels 4.25 and 4.75.
 const loaded=open(document,{propertyChannels:true}).report;
 const records=[0,.25,.75,1,1.5,2,2.5,3,3.25,3.75,4,4.25,4.75].map(tick=>{
  const rows=timeline(loaded);let index=rows.findLastIndex(row=>row.start<=tick);index=Math.max(0,index);const row=rows[index];
  const json=JSON.stringify(snapshotPoseFrame(evaluatedFrame(loaded,index,row.count?(tick-row.start)/row.count:0,tick)),(key,value)=>key==='runtime_segments'?undefined:value);
  return {tick,sha256:createHash('sha256').update(json).digest('hex'),bytes:Buffer.byteLength(json),json};
 });
 mkdirSync(`${out}/${name}.records`,{recursive:true});writeFileSync(`${out}/${name}.records/report.json`,JSON.stringify(loaded,(key,value)=>key==='runtime_segments'?undefined:value)+'\n');writeFileSync(`${out}/${name}.records/records.json`,JSON.stringify({file:`${name}.json`,ticks:records})+'\n');
 // Place the same definition in an outer instance; compare geometry at fractional
 // times including the final interval (where simply tweening the local poses holds).
 const parent=documentOf([limb()]);parent.figure_types=[figure];parent.keyframes[0].objects[0].figure_type_id=figure.figure_type_id;parent.keyframes[0].objects[0].angles=[.3];parent.keyframes[0].objects[0].root_x=220;parent.keyframes[0].objects[0].root_y=180;parent.keyframes[0].objects[0].scale=1.25;parent.keyframes[0].objects[0]._stykMovieclip={start:0,end:5,offset:0,speed:1,mode:'loop'};parent.keyframes[0].duration_raw=5;parent.keyframes.push(createFrame());
 const written=writeProject(out,`${name}-host`,parent,[0,.25,.75,1,1.5,2,2.5,3,3.25,3.75,4,4.25,4.75]);writeReference(written,`${name}-host`);
}
