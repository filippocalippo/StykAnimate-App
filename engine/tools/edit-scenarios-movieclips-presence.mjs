// Native presence clocks: breaks, imported continuation steps, gaps and history.
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {documentOf,limb,open,nextKey,createObject,createFrame,writeProject,writeReference} from './fixture-kit.mjs';
import {presencePlayback} from '../../src/movieclip-presence.mjs';
const folder=fileURLToPath(new URL('../tests/edit/',import.meta.url));
const views=fileURLToPath(new URL('../crates/styk-eval/tests/fixtures/movieclip-native-presence/',import.meta.url));mkdirSync(views,{recursive:true});
const base=({gaps=false,continuation=false,mode='loop'}={})=>{
 const child=open(documentOf([limb(),limb()],i=>[200+i*120,180]));child.select(2);child.joinTo(1,22);nextKey(child,7);child.select(1);child.moveSelection(63,-14);child.seek(0);const figure=child.createMovieclip({uids:[1],start:0,end:8,replace:false,name:'Presence clip'});
 const report=documentOf([limb()]);report.figure_types.push(figure);report.fps=48;
 const settings=presencePlayback({offset:.35,speed:mode==='once'?4:.8,mode}),objects=present=>[...(present?[createObject(figure,7,300,220,{angles:[.2],scale:1.25,_stykMovieclip:structuredClone(settings)})]:[]),createObject(report.figure_types[0],9,550,150)];
 report.keyframes=gaps?[createFrame(objects(true),3),createFrame(objects(false),2),createFrame(objects(true),6),createFrame(objects(true))]:[createFrame(objects(true),11),createFrame(objects(true))];
 if(continuation)report.keyframes[1]._styk={movieclipContinuations:[{uid:7,typeId:figure.figure_type_id,playback:structuredClone(settings)}]};
 return report;
};
const standard=[['@seek',2.25],['@select',7,-1],['breakApartMovieclip'],['@seek',5.75],['@select',7,-1],['breakApartMovieclip'],['undo'],['redo'],['@seek',0],['@select',7,-1],['breakApartMovieclip'],['undo'],['redo'],['@seek',11],['@select',7,-1],['breakApartMovieclip'],['undo'],['redo']];
const cases=[
 ['clip-break-presence-native',base(),standard],
 ['clip-break-presence-gaps-native',base({gaps:true}),[['@seek',1.75],['@select',7,-1],['breakApartMovieclip'],['@seek',3.5],['@select',7,-1],['breakApartMovieclip'],['@seek',6.25],['@select',7,-1],['breakApartMovieclip'],['undo'],['undo'],['redo'],['redo']]],
 ['clip-break-presence-continuation-native',base({gaps:true,continuation:true}),standard],
 ['clip-break-presence-once-native',base({mode:'once'}),[['@seek',1.25],['@select',7,-1],['breakApartMovieclip'],['@seek',11],['@select',7,-1],['breakApartMovieclip'],['undo'],['redo']]],
 ['clip-break-presence-live-native',base(),[['@select',9,-1],['beginDrag','Outside'],['moveSelection',7,-3],['breakApartMovieclip'],['moveSelection',2,1],['cancelDrag'],['@seek',2.25],['@select',7,-1],['beginDrag','Clip move'],['moveSelection',5,-2],['breakApartMovieclip'],['undo'],['redo']]],
];
for(const [name,document,steps]of cases){
 writeFileSync(`${folder}/${name}.document.json`,JSON.stringify(document,(key,value)=>key==='runtime_segments'?undefined:value)+'\n');
 writeFileSync(`${folder}/${name}.scenario.json`,JSON.stringify({name,document:`${name}.document.json`,editor:{},steps},null,1)+'\n');
 execFileSync(process.execPath,[fileURLToPath(new URL('./edit-replay.mjs',import.meta.url)),`${folder}/${name}.scenario.json`,`${folder}/${name}.reference.json`],{stdio:'inherit'});
 const replay=JSON.parse(readFileSync(`${folder}/${name}.reference.json`,'utf8')),final=JSON.parse(replay.steps.findLast(step=>step.document).document);
 const ticks=[0,.25,.75,1,1.5,2,2.25,2.75,3,3.5,4,4.75,5,5.25,5.75,6,6.5,7,8,9,10,11];
 const written=writeProject(views,name,final,ticks,{vfx:true,camera:true,native:true});writeReference(written,name);
}
