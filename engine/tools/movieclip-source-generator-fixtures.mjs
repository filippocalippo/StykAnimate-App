// Retained source generator census and batches, recorded with the actual editor.
import {fileURLToPath} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
import {documentOf,limb,open,nextKey,createFrame,writeProject,writeReference,prune} from './fixture-kit.mjs';
import {generatorBatchFor} from '../../src/vfx-generator-frame.mjs';
const folder=fileURLToPath(new URL('../crates/styk-eval/tests/fixtures/movieclip-source-generators/',import.meta.url));
mkdirSync(folder,{recursive:true});let counter=0,state=1;
Object.defineProperty(globalThis.crypto,'randomUUID',{configurable:true,value:()=>`c1c1c1c1-0000-4000-8000-${String(++counter).padStart(12,'0')}`});
Math.random=()=> (state=(Math.imul(state,1103515245)+12345)>>>0)/2**32;
const app={layerTimeline:true,propertyChannels:true};
const set=(e,id,params)=>{const effect=e.getVfxClips().find(c=>c.id===id).effects[0];for(const [key,value]of Object.entries(params))e.setVfxClipParameter(id,effect.id,key,value);};
const e=open(documentOf([limb()],()=>[200,180]));nextKey(e,8);e.select(1);e.moveSelection(100,-25);e.rotateFigure(.9);e.seek(0);e.report.keyframes[0]._styk.easing={interpolation:'bezier',bezier:[.2,.02,.4,.94]};
const aura=e.addVfxClip({kind:'figure',uid:1},'aura',{start:1,duration:8});set(e,aura,{seed:12345,density:.1});e.setVfxClip(aura,{fadeIn:2,fadeOut:2,strength:.7});
const blur=e.addVfxClip({kind:'figure',uid:1},'blur',{start:0,duration:9});const fx=e.getVfxClips().find(c=>c.id===blur).effects[0];for(const [tick,value]of [[0,2],[8,18]])e.setVfxClipParameter(blur,fx.id,'radius',value,{key:true,tick});
const inherited=e.createMovieclip({uids:[1],start:2,end:7,replace:false,name:'Generator crop'});
const onlyEditor=open(structuredClone(e.report));onlyEditor.deleteVfxClip(blur);const only=onlyEditor.createMovieclip({uids:[1],start:2,end:7,replace:false,name:'Generator only crop'});
const local=structuredClone(inherited),inside=open(local._styk.movieclip.document);
const particles=inside.addVfxClip({kind:'figure',uid:1},'particles',{start:0,duration:5});set(inside,particles,{seed:54321,rate:2,life:8,space:1,variation:0});inside.setVfxClip(particles,{fadeIn:1,fadeOut:2,strength:.8});local._styk.movieclip.document=inside.report;
const host=(figure,timed)=>{const report=documentOf([limb()]);report.figure_types=[structuredClone(figure)];const o=report.keyframes[0].objects[0];o.figure_type_id=figure.figure_type_id;o.root_x=220;o.root_y=180;o.angles=[.3];o.scale=1.25;report.keyframes[0].duration_raw=8;report.keyframes.push(createFrame());if(timed)o._stykMovieclip={start:0,end:9,offset:.35,speed:.8,mode:'loop',restarts:[{tick:4,offset:1.2}]};return report;};
const presence=figure=>{const editor=open(host(figure,false),app),layer=editor.layerForUid(1);editor.sheetInsertKey([layer],3);editor.sheetInsertKey([layer],4);editor.seek(3);editor.select(1);editor.deleteSelection();return prune(editor.report);};
const cases=[
 ['only-native',only._styk.movieclip.document,false,[0,.25,.75,1,1.5,2,2.5,3,3.25,3.75,4]],
 ['inherited-native',inherited._styk.movieclip.document,false,[0,.25,.75,1,1.5,2,2.5,3,3.25,3.75,4]],
 ['inherited-app',open(structuredClone(inherited._styk.movieclip.document),app).report,true,[0,.25,.75,1,1.5,2,2.5,3,3.25,3.75,4]],
 ['local-native',local._styk.movieclip.document,false,[0,.25,.75,1,1.5,2,2.5,3,3.25,3.75,4]],
 ['local-app',open(structuredClone(local._styk.movieclip.document),app).report,true,[0,.25,.75,1,1.5,2,2.5,3,3.25,3.75,4]],
 ['inherited-timed',host(inherited,true),true,[0,.25,.75,1,2.5,3.75,4,4.25,4.75,6.5,7]],
 ['inherited-presence',presence(inherited),true,[0,.25,1.5,2.5,3,3.25,3.75,4,4.25,4.75,6.5,7]],
 ['local-timed',host(local,true),true,[0,.25,.75,1,2.5,3.75,4,4.25,4.75,6.5,7]],
 ['local-presence',presence(local),true,[0,.25,1.5,2.5,3,3.25,3.75,4,4.25,4.75,6.5,7]],
];
for(const [name,report,sheet,ticks]of cases){
 const written=writeProject(folder,name,report,ticks,{vfx:true,camera:true,native:!sheet});writeReference(written,name);
 const editor=open(structuredClone(report),{propertyChannels:true,layerTimeline:sheet});
 const frames=ticks.map(tick=>{editor.seek(tick);if(editor.tick!==tick)throw new Error(`${name}: cannot seek ${tick}`);const frame=editor.evaluatedFrame,batch=generatorBatchFor(editor.report,frame,editor.geometry);if(batch?.incomplete)throw new Error(`${name}: incomplete batch`);return {tick,clock:frame._vfxTimelineTick??null,batch:batch?{tick:batch.tick,particles:batch.particles,records:[...batch.records],table:[...batch.table],draws:batch.draws.map(d=>[d.record,d.count,d.shape,d.blend,d.uid,d.placement==='behind'?1:0,d.scene?1:0,d.material])}:null};});
 writeFileSync(`${folder}/${name}.batches.json`,JSON.stringify({frames})+'\n');
 console.log(`${name}: ${frames.filter(f=>f.batch).length}/${frames.length} generator batches`);
}
