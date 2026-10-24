// New pose sources join the active layer before the next real command records them.
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {withDraws} from '../../src/editor-draws.mjs';
import {documentOf,limb,open,nextKey,prune,writeProject,writeReference} from './fixture-kit.mjs';
const folder=fileURLToPath(new URL('../tests/edit/',import.meta.url));
const views=fileURLToPath(new URL('../crates/styk-eval/tests/fixtures/movieclip-native-membership/',import.meta.url));mkdirSync(views,{recursive:true});
const actual=JSON.parse(readFileSync(new URL('../crates/styk-eval/tests/fixtures/channels/channels-pose.json',import.meta.url),'utf8'));
actual._styk.animation.channels=actual._styk.animation.channels.filter(c=>c.property==='pose'&&c.target.kind==='figure');
const base=()=>{const e=open(documentOf([limb(),limb()],i=>[180+i*170,150]));nextKey(e,6);e.select(1);e.moveSelection(32.5,-7.25);e.seek(0);e.createLayer('Front');return e;};
const conversion=[['@select',2,-1],['createMovieclip',{uids:[2],start:4,end:16,replace:false,name:'Joined crop'}],['@seek',7.25],['undo'],['redo'],['@select',2,-1],['createMovieclip',{uids:[2],start:4,end:16,name:'Joined conversion'}],['@seek',10.75],['undo'],['redo'],['undo'],['createEmptyMovieclip','Branch'],['redo']];
const cases=[
 ['clip-capture-active-layer-native',actual,conversion],
 ['clip-capture-active-anchor-native',(()=>{const d=structuredClone(actual);for(const uid of [1,2,3])d._styk.layers.assignments[uid]='layer-2';return d;})(),conversion],
 ['clip-capture-active-plain-native',base().report,[['@select',1,-1],['createMovieclip',{start:2,end:6}],['@seek',3.25],['undo'],['redo'],['undo'],['createEmptyMovieclip','Branch'],['redo']]],
 ['clip-capture-active-cancel-native',base().report,[['@select',1,-1],['beginDrag','Outside'],['moveSelection',7,-3],['createMovieclip',{start:7,end:2}],['moveSelection',2,1],['cancelDrag'],['@batch','Abort conversion',[['createMovieclip',{start:2,end:6}],['placeMovieclip',{start:7,end:2}]]],['createMovieclip',{start:2,end:6}],['undo'],['redo']]],
 ['clip-break-active-layer-native',(()=>{const e=base();e.select(1);const f=e.createMovieclip({start:0,end:7,replace:false});for(const frame of e.report.keyframes){const o=frame.objects.find(o=>o.unique_id===1);o.figure_type_id=f.figure_type_id;o.angles=[.2];o._stykMovieclip={start:0,end:7,offset:.25,speed:.8,mode:'loop'};}return e.report;})(),[['@select',1,-1],['@seek',3.25],['breakApartMovieclip'],['undo'],['redo'],['@seek',4.75],['breakApartMovieclip'],['undo'],['undo'],['createEmptyMovieclip','Branch'],['redo']]],
];
const historyEvidence=(name,document,steps)=>{
 const editor=open(prune(structuredClone(document))),records=[],record=editor._record,captured=new WeakMap();let step=0,drawn=0;
 editor._record=function(command){const capturedPendingBytes=this._pendingSourceBytes??0;record.call(this,command);captured.set(command,capturedPendingBytes);const {bytes,...sized}=command;
  if(sized.sourceBytes!==undefined&&sized.frameSourceChanges)sized.frameSourceChanges=sized.frameSourceChanges.map(change=>({id:change.id,before:{exists:change.before.exists},after:{exists:change.after.exists}}));
  records.push({step,kind:command.kind,label:command.label,bytes,capturedPendingBytes,sourceBytes:command.sourceBytes??null,precomputedBytes:command.precomputedBytes??null,enumerableJSON:JSON.stringify(sized)});
 };
 const entry=command=>({kind:command.kind,label:command.label,bytes:command.bytes,capturedPendingBytes:captured.get(command)??0,layerChanges:command.layerChanges??[],...(command.commands?{commands:command.commands.map(entry)}:{})});
 const state=()=>({historySize:editor._historySize,undo:editor._undo.map(entry),redo:editor._redo.map(entry),pendingSourceBytes:editor._pendingSourceBytes??0,pendingSourceLayerChanges:editor._pendingSourceLayerChanges??[]});
 const states=[{step:0,...state()}],run=([method,...args])=>method==='@batch'?editor.movieclipBatch(args[0],()=>{let last;for(const call of args[1])last=run(call);return last;}):editor[method==='@seek'?'seek':method==='@select'?'select':method](...args);
 const source=kind=>{drawn++;if(kind==='uuid')return `d0d0d0d0-0000-4000-8000-${String(drawn).padStart(12,'0')}`;const bits=Math.imul(drawn,0x9e3779b1)>>>0;return kind==='seed'?bits:bits/2**32;};
 for(const call of steps){step++;try{withDraws(()=>run(call),source);}catch{}states.push({step,...state()});}
 return {scenario:name,historyLimit:editor.historyLimit,historyBytes:editor.historyBytes,records,states};
};
for(const [name,document,steps]of cases){
 writeFileSync(`${folder}/${name}.document.json`,JSON.stringify(prune(structuredClone(document)),(key,value)=>key==='runtime_segments'?undefined:value)+'\n');
 writeFileSync(`${folder}/${name}.scenario.json`,JSON.stringify({name,document:`${name}.document.json`,editor:{},steps},null,1)+'\n');
 execFileSync(process.execPath,[fileURLToPath(new URL('./edit-replay.mjs',import.meta.url)),`${folder}/${name}.scenario.json`,`${folder}/${name}.reference.json`],{stdio:'inherit'});
 writeFileSync(`${folder}/${name}.history.json`,JSON.stringify(historyEvidence(name,document,steps))+'\n');
 const replay=JSON.parse(readFileSync(`${folder}/${name}.reference.json`,'utf8')),final=JSON.parse(replay.steps.findLast(step=>step.document).document),ticks=[0,.25,1,2,2.25,3,3.25,4,4.75,5.25,6,7.25,10.75,15.75];
 const written=writeProject(views,name,final,ticks,{vfx:true,camera:true,native:true});writeReference(written,name);
}
