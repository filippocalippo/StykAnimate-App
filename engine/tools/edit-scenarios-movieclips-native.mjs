// Native movieclip channels/history recorded before their Rust implementation.
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {documentOf,limb,open,nextKey,prune} from './fixture-kit.mjs';
const folder=fileURLToPath(new URL('../tests/edit/',import.meta.url));
const base=()=>{const e=open(documentOf([limb(),limb()],i=>[180+i*170,150]));nextKey(e,6);e.select(1);e.moveSelection(32.5,-7.25);e.rotateFigure(.175);e.seek(0);return e;};
const write=(name,document,steps)=>{
 writeFileSync(`${folder}/${name}.document.json`,JSON.stringify(prune(structuredClone(document)),(key,value)=>key==='runtime_segments'?undefined:value)+'\n');
 writeFileSync(`${folder}/${name}.scenario.json`,JSON.stringify({name,document:`${name}.document.json`,editor:{},steps},null,1)+'\n');
 execFileSync(process.execPath,[fileURLToPath(new URL('./edit-replay.mjs',import.meta.url)),`${folder}/${name}.scenario.json`,`${folder}/${name}.reference.json`],{stdio:'inherit'});
};
const legacy=()=>{
 const e=base();e.select(1);const figure=e.createMovieclip({start:0,end:7,replace:false,name:'Legacy clip'});
 // A file-authored timed instance, with no saved pose channel yet.
 for(const frame of e.report.keyframes){const o=frame.objects.find(o=>o.unique_id===1);o.figure_type_id=figure.figure_type_id;o.angles=[.2];o._stykMovieclip={start:0,end:7,offset:.25,speed:.8,mode:'loop',restarts:[{tick:4,offset:1.1}]};}
 return e.report;
};
write('clip-create-native',base().report,[['@select',1,-1],['createMovieclip',{start:2,end:6}],['@seek',3.25],['undo'],['redo'],['@seek',7],['undo'],['createEmptyMovieclip','Branch'],['redo']]);
write('clip-create-joined-native',(()=>{const e=base();e.select(2);e.joinTo(1,33);return e.report;})(),[['@select',1,-1],['createMovieclip',{start:1,end:6}],['@seek',2.75],['undo'],['redo']]);
write('clip-unique-legacy-native',legacy(),[['@select',1,-1],['makeMovieclipUnique'],['@seek',3.25],['undo'],['redo'],['makeMovieclipUnique'],['undo'],['undo'],['redo'],['redo']]);
write('clip-place-legacy-native',legacy(),[['@select',1,-1],['placeMovieclip',{end:6}],['@seek',2.75],['placeMovieclip',{start:2,end:9},{move:true}],['@seek',5.25],['placeMovieclip',{start:1,end:8}],['undo'],['undo'],['redo'],['@seek',7.75],['undo'],['createEmptyMovieclip','Branch'],['redo']]);
write('clip-split-legacy-native',legacy(),[['@select',1,-1],['@seek',3.25],['splitMovieclip'],['@seek',4],['splitMovieclip',null],['splitMovieclip','4'],['splitMovieclip',4],['@seek',5.25],['undo'],['redo'],['undo'],['createEmptyMovieclip','Branch'],['redo']]);
write('clip-native-batch-cancel',base().report,[['@select',1,-1],['@batch','Abort conversion',[['createMovieclip',{start:2,end:6}],['placeMovieclip',{start:7,end:2}]]],['createMovieclip',{start:2,end:6}],['undo'],['redo']]);
write('clip-break-native',legacy(),[['@select',1,-1],['@seek',3.25],['breakApartMovieclip'],['undo'],['redo'],['@seek',4.75],['undo'],['breakApartMovieclip'],['undo'],['redo']]);
write('clip-native-extended-bounds',legacy(),[['@select',1,-1],['placeMovieclip',{start:10,end:20},{move:true}],['@seek',19.75],['placeMovieclip',{start:5,end:null}],['undo'],['undo'],['redo'],['redo'],['@seek',30]]);
