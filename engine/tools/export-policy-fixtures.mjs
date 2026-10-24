#!/usr/bin/env node
// Records the existing Editor/exportSVG branch before changing Rust export policy.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {repo,emptyDocument,createObject,createFrame,open} from './fixture-kit.mjs';
import {createVfx,activeVfx,vfxStack} from '../../src/vfx.mjs';
import {exportFrameGeometry} from '../../src/export-frame-core.mjs';
import {hasDrawableVfx} from '../../src/vfx-drawable.mjs';
import {generatorBatchFor} from '../../src/vfx-generator-frame.mjs';
import {evaluateParticle} from '../../src/vfx-generators.mjs';
let counter=0;
Object.defineProperty(globalThis.crypto,'randomUUID',{configurable:true,value:()=>`00000000-0000-4000-8000-${String(++counter).padStart(12,'0')}`});
const outIndex=process.argv.indexOf('--out');
const out=path.resolve(outIndex<0?`${repo}/engine/crates/styk-export/tests/fixtures/policy`:process.argv[outIndex+1]);
mkdirSync(out,{recursive:true});
const base=()=>{const d=emptyDocument();d.canvas_width=320;d.canvas_height=240;d.keyframes=[createFrame([createObject(d.figure_types[0],1,160,180,{scale:.5})],12)];return d;};
const stack=(type='blur',params={radius:2})=>{const e=createVfx(type,'export-policy');return [{...e,params:{...e.params,...params}}];};
const saved=(scope,effects,source=base())=>{source.keyframes[0].objects[0]._stykVfx={[scope]:effects};return open(source);};
const fixtures=[];
const add=(name,editor,ticks=[0])=>fixtures.push({name,editor,ticks});
add('plain-vector',open(base()));
const drawing=JSON.parse(readFileSync(`${repo}/engine/crates/styk-eval/tests/fixtures/drawlist/drawing-cel.json`));
add('plain-drawing',open(drawing));
const alternating=open(structuredClone(drawing),{propertyChannels:false,layerTimeline:false});alternating.changeVfxStack({kind:'figure',uid:1},s=>s.push(...stack()));alternating.setFrameDuration(2);alternating.duplicateFrame();alternating.selectFrame(1);alternating.changeVfxStack({kind:'figure',uid:1},s=>s.splice(0));add('alternating-drawing',alternating,[0,2,0]);
add('figure-filter',saved('figure',stack()));
add('disabled-filter',saved('figure',stack().map(e=>({...e,enabled:false}))));
add('neutral-filter',saved('figure',stack('blur',{radius:0})));
add('wildcard-unused-filter',saved('*/999',stack()));
add('foreign-unused-filter',saved('999/999',stack()));
add('handle-unused-filter',saved('1/999',stack()));
const scene=open(base());scene.changeVfxStack({kind:'scene'},s=>s.push(...stack()));add('scene-filter',scene);
const hidden=saved('figure',stack());hidden.setLayerVisible(hidden.layerForUid(1),false);add('hidden-filter',hidden);
for(const [name,target] of [['timeline-figure-filter',{kind:'figure',uid:1}],['timeline-wildcard-filter',{kind:'segment',uid:1,handleId:1}]]){
 const e=open(base(),{layerTimeline:true});e.addVfxClip(target,'blur',{start:0,duration:10});add(name,e,[1]);
}
for(const [name,rate,start,tick] of [['generator-active',4,0,1],['generator-zero-rate',0,0,1],['generator-before-start',4,5,0]]){
 const e=open(base(),{layerTimeline:true}),id=e.addVfxClip({kind:'figure',uid:1},'particles',{start,duration:10});
 const clip=e.getVfxClips().find(c=>c.id===id);e.setVfxClipParameters(id,clip.effects[0].id,{rate,life:3,seed:7});add(name,e,[tick]);
}
for(const [name,source] of [['mesh','spatial-mesh-skinned'],['depth-surface','spatial-surfaces-skin']]){
 add(name,open(JSON.parse(readFileSync(`${repo}/engine/crates/styk-eval/tests/fixtures/records/${source}/report.json`))));
}
const nested=saved('figure',stack());nested.select(1);nested.createMovieclip({uids:[1],start:0,end:nested.totalTicks,replace:true});add('nested-filter',nested);
const nestedUnused=saved('*/999',stack());nestedUnused.select(1);nestedUnused.createMovieclip({uids:[1],start:0,end:nestedUnused.totalTicks,replace:true});add('nested-unused-filter',nestedUnused);
// Container node stacks are valid saved metadata, even though the editor has
// no node-effects control for movieclip handles; reopen through its real loader.
const containerSource=open(base(),{propertyChannels:false,layerTimeline:false});containerSource.select(1);const container=containerSource.createMovieclip({uids:[1],start:0,end:containerSource.totalTicks,replace:true});const containerReport=containerSource.serialize();for(const frame of containerReport.keyframes)for(const object of frame.objects)if(object.figure_type_id===container.figure_type_id)object._stykVfx={'*/999':stack()};add('container-unused-filter',open(containerReport));
const nestedSceneReport=structuredClone(containerSource.serialize()),asset=nestedSceneReport.figure_types.find(f=>f._styk?.movieclip)._styk.movieclip;
const inner=open(asset.document);inner.changeVfxStack({kind:'scene'},s=>s.push(...stack()));asset.document=inner.serialize();add('nested-scene-filter',open(nestedSceneReport));
const additive=open(base(),{layerTimeline:true}),additiveId=additive.addVfxClip({kind:'figure',uid:1},'particles',{start:0,duration:10});
const additiveClip=additive.getVfxClips().find(c=>c.id===additiveId);additive.setVfxClipParameters(additiveId,additiveClip.effects[0].id,{rate:4,life:3,seed:7,blend:1});add('generator-additive',additive,[1]);
const recorded=[];
for(const {name,editor,ticks} of fixtures){
 const report=editor.serialize();writeFileSync(`${out}/${name}.json`,JSON.stringify(report)+'\n');
 for(const tick of ticks){editor.seek(tick);const frame=editor.evaluatedFrame,geometry=exportFrameGeometry(editor.report,frame),batch=generatorBatchFor(editor.report,frame,geometry);
  const scene=activeVfx(vfxStack(frame)).length>0,generated=Boolean(batch),drawables=geometry.drawables.map(item=>({uid:item.obj.unique_id,type:item.type,hasVfx:hasDrawableVfx(item),depth:Boolean(item.poly?._stykSurface?.depthTest)}));
  let liveParticles=0;for(const draw of batch?.draws??[])for(let i=0;i<draw.count;i++)if(evaluateParticle(batch,draw,i,{}))liveParticles++;
  recorded.push({name,tick,composited:scene||generated||drawables.some(d=>d.hasVfx||d.type==='mesh'||d.depth),scene,generated,particles:batch?.particles??0,liveParticles,drawBlends:batch?.draws.map(draw=>draw.blend)??[],drawables});
 }
}
writeFileSync(`${out}/reference.json`,JSON.stringify(recorded,null,2)+'\n');
console.log(JSON.stringify(recorded.map(({name,tick,composited,generated,particles})=>({name,tick,composited,generated,particles})),null,2));
