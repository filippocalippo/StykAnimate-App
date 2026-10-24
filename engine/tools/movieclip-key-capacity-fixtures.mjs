// Actual native authored key capacity/collision calls, recorded after the owning
// JS non-progress fix and BEFORE its Rust publication validation.
import {fileURLToPath} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {documentOf,limb,open,nextKey} from './fixture-kit.mjs';
const folder=fileURLToPath(new URL('../tests/movieclip-key-capacity/',import.meta.url));mkdirSync(folder,{recursive:true});
const MAX=Number.MAX_SAFE_INTEGER,json=value=>JSON.stringify(value,(key,value)=>key==='runtime_segments'?undefined:value);
function prepared(){
 const e=open(documentOf([limb(),limb(),limb()],i=>[180+i*170,150]));nextKey(e,4);e.seek(0);e.select(2);e.createMovieclip({uids:[2],start:0,end:5,replace:false});
 e.addFigure(4);e.createLayer('Second');e.setActiveLayer('layer-2');e.seek(2);e.addFigure(4);return JSON.parse(json(e.report));
}
for(const [name,counter,collisions,tick] of [['capacity-maximum',MAX,[],3],['capacity-last-safe',MAX-1,[],3],['capacity-single-collision',MAX,[MAX],3],['capacity-near-collision',MAX-1,[MAX-1],3],['capacity-double-collision',MAX,[MAX,MAX+1],3],['capacity-existing-key',MAX,[],2],['capacity-maximum-fractional',MAX,[],3.25],['capacity-last-safe-fractional',MAX-1,[],3.25]]){
 const document=prepared(),channel=document._styk.animation.channels.find(channel=>channel.target.kind==='layer'&&channel.target.id==='layer-2');document._styk.animation.nextKeyId=counter;
 if(collisions.length){channel.keys[0].id=`key-${collisions[0]}`;for(const id of collisions.slice(1))channel.keys.push({...structuredClone(channel.keys[0]),id:`key-${id}`,tick:3,hidden:true});}
 open(structuredClone(document)).serialize();writeFileSync(`${folder}/${name}.document.json`,json(document)+'\n');
 const steps=[['@seek',tick],['addFigure',4],['undo'],['redo'],['undo'],['createEmptyMovieclip','Capacity branch'],['redo']];
 writeFileSync(`${folder}/${name}.scenario.json`,JSON.stringify({name,document:`${name}.document.json`,editor:{},steps},null,1)+'\n');
 execFileSync(process.execPath,[fileURLToPath(new URL('./edit-replay.mjs',import.meta.url)),`${folder}/${name}.scenario.json`,`${folder}/${name}.reference.json`],{stdio:'inherit'});
}
