// Additive retained-source coverage: source clocks, effects, native channels and follow sampling.
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {timeline,evaluatedFrame} from '../../src/pivot/geometry.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
import {documentOf,limb,open,nextKey,createFrame,writeProject,writeReference,prune} from './fixture-kit.mjs';
const folder=fileURLToPath(new URL('../crates/styk-eval/tests/fixtures/movieclip-source-coverage/',import.meta.url));
const fixture=name=>JSON.parse(readFileSync(new URL(`../crates/styk-eval/tests/fixtures/${name}.json`,import.meta.url),'utf8'));
mkdirSync(folder,{recursive:true});let counter=0;
Object.defineProperty(globalThis.crypto,'randomUUID',{configurable:true,value:()=>`c0c0c0c0-0000-4000-8000-${String(++counter).padStart(12,'0')}`});
const app={layerTimeline:true,propertyChannels:true};
const base=()=>{const e=open(documentOf([limb(),limb()],i=>[200+i*150,160]));nextKey(e,8);e.select(1);e.moveSelection(100,-25);e.rotateFigure(.9);e.seek(0);e.report.keyframes[0]._styk.easing={interpolation:'bezier',bezier:[.2,.02,.4,.94]};return e;};
const capture=(document,{uids=[1],start=2,end=7,sheet=false}={})=>{const e=open(structuredClone(document),sheet?app:{});return e.createMovieclip({uids,start,end,replace:false,name:'Source crop'});};
const keyedBlur=e=>{const id=e.addVfxClip({kind:'figure',uid:1},'blur',{start:0,duration:9});const fx=e.getVfxClips().find(c=>c.id===id).effects[0];for(const [tick,value]of [[0,2],[8,18]])e.setVfxClipParameter(id,fx.id,'radius',value,{key:true,tick});};
const cases=[];
{
 const e=base();keyedBlur(e);const figure=capture(e.report);
 cases.push(['effects-inherited',figure]);
 cases.push(['effects-recursive-crop',capture(figure._styk.movieclip.document,{start:1,end:5})]);
 const mixed=open(structuredClone(figure._styk.movieclip.document),app);mixed.seek(1);mixed.select(1);mixed.moveSelection(9,-4);const partial=structuredClone(figure);partial._styk.movieclip.document=mixed.report;cases.push(['effects-partial-authoring',partial]);
 const empty=structuredClone(figure);empty._styk.movieclip.document._styk.vfxClips={version:1,clips:[]};cases.push(['effects-empty-local',empty]);
 const local=open(structuredClone(figure._styk.movieclip.document));const id=local.addVfxClip({kind:'figure',uid:1},'tint',{start:0,duration:5});const fx=local.getVfxClips().find(c=>c.id===id).effects[0];for(const [tick,value]of [[0,.1],[4,.8]])local.setVfxClipParameter(id,fx.id,'mix',value,{key:true,tick});
 const override=structuredClone(figure);override._styk.movieclip.document=local.report;cases.push(['effects-local-override',override]);
}
{
 const e=open(base().report,app);e.select(1);e.createMovieclip({start:1,end:8});const uid=e.selectedUid;
 e.seek(3);e.select(uid);e.deleteSelection();e.seek(4);e.select(uid);e.setMovieclipPlayback({offset:.375,speed:.8},{allFrames:true});
 cases.push(['presence-gap',capture(e.report,{uids:[uid],sheet:true})]);
}
{
 const e=open(base().report,app);e.select(1);e.createMovieclip({start:1,end:8});const uid=e.selectedUid;
 for(const f of [...e.report.keyframes,...Object.values(e.report._styk.frameSources)])for(const o of f.objects)if(o.unique_id===uid)o._stykMovieclip={start:0,end:9,offset:.35,speed:.8,mode:'loop',restarts:[{tick:4,offset:1.2}]};
 cases.push(['timed-restarts',capture(e.report,{uids:[uid],sheet:true})]);
}
for(const name of ['channels-figure','channels-pose','channels-follow']) {
 const document=fixture(`channels/${name}`);
 // The unjoined case isolates the pose curve; joined captures are below.
 if(name==='channels-pose')for(const frame of [...document.keyframes,...Object.values(document._styk.frameSources??{})])for(const object of frame.objects)object.join=null;
 cases.push([name,capture(document,{start:4,end:16,uids:['channels-follow','channels-pose'].includes(name)?[2]:[1]})]);
}
for(const uid of [2,3])cases.push([`channels-pose-joined-uid${uid}`,capture(fixture('channels/channels-pose'),{start:4,end:16,uids:[uid]})]);
for(const [name,figure]of cases) {
 const document=prune(structuredClone(figure._styk.movieclip.document)),duration=figure._styk.movieclip.duration;
 const ticks=[...new Set([0,.25,.75,1,1.5,2,2.5,3,3.25,3.75,duration-1,duration-.75,duration-.25])].filter(t=>t>=0&&t<duration).sort((a,b)=>a-b);
 const loaded=open(document).report,records=[],samples=[];
 for(const tick of ticks){const rows=timeline(loaded);let index=Math.max(0,rows.findLastIndex(row=>row.start<=tick));const row=rows[index];const evaluated=evaluatedFrame(loaded,index,row.count?(tick-row.start)/row.count:0,tick);const json=JSON.stringify(snapshotPoseFrame(evaluated),(key,value)=>key==='runtime_segments'?undefined:value);records.push({tick,sha256:createHash('sha256').update(json).digest('hex'),bytes:Buffer.byteLength(json),json});samples.push([tick,evaluated.objects.filter(o=>Object.hasOwn(o,'_movieclipSample')).map(o=>[o.unique_id,o._movieclipSample]),evaluated._vfxTimelineTick??null]);}
 mkdirSync(`${folder}/${name}.records`,{recursive:true});writeFileSync(`${folder}/${name}.records/report.json`,JSON.stringify(loaded,(key,value)=>key==='runtime_segments'?undefined:value)+'\n');writeFileSync(`${folder}/${name}.records/records.json`,JSON.stringify({file:`${name}.json`,ticks:records})+'\n');writeFileSync(`${folder}/${name}.samples.json`,JSON.stringify(samples)+'\n');
 const local=writeProject(folder,name,loaded,ticks.filter(t=>t<=duration-1),{vfx:true,camera:true,native:true});writeReference(local,name);
 const appDocument=open(document,app).report;const shown=writeProject(folder,`${name}-app`,appDocument,ticks.filter(t=>t<=duration-1),{vfx:true,camera:true});writeReference(shown,`${name}-app`);
 const parent=documentOf([limb()]);parent.figure_types=[figure];parent.keyframes[0].objects[0].figure_type_id=figure.figure_type_id;parent.keyframes[0].objects[0].angles=[.3];parent.keyframes[0].objects[0].root_x=220;parent.keyframes[0].objects[0].root_y=180;parent.keyframes[0].objects[0].scale=1.25;parent.keyframes[0].objects[0]._stykMovieclip={start:0,end:duration,offset:0,speed:1,mode:'loop'};parent.keyframes[0].duration_raw=duration;parent.keyframes.push(createFrame());
 const host=writeProject(folder,`${name}-host`,parent,ticks,{vfx:true,camera:true});writeReference(host,`${name}-host`);
}
