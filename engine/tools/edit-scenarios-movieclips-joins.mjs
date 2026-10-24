// Captured joins keep their parent when unrelated preceding figures are filtered out.
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {open} from './fixture-kit.mjs';
const folder=fileURLToPath(new URL('../tests/edit/',import.meta.url));
const original=JSON.parse(readFileSync(new URL('../crates/styk-eval/tests/fixtures/channels/channels-pose.json',import.meta.url),'utf8'));
// Keep its editor-built figure pose channel; unrelated scene/camera/layer
// channels are outside the recorded native editing admission.
original._styk.animation.channels=original._styk.animation.channels.filter(c=>c.property==='pose'&&c.target.kind==='figure');
for(const uid of [2,3]){
 const name=`clip-capture-joined-channel-uid${uid}`,document=open(structuredClone(original)).report;
 writeFileSync(`${folder}/${name}.document.json`,JSON.stringify(document,(key,value)=>key==='runtime_segments'?undefined:value)+'\n');
 writeFileSync(`${folder}/${name}.scenario.json`,JSON.stringify({name,document:`${name}.document.json`,editor:{},steps:[['@select',uid,-1],['createMovieclip',{uids:[uid],start:4,end:16,replace:false,name:'Joined crop'}],['@seek',7.25],['undo'],['redo']]},null,1)+'\n');
 execFileSync(process.execPath,[fileURLToPath(new URL('./edit-replay.mjs',import.meta.url)),`${folder}/${name}.scenario.json`,`${folder}/${name}.reference.json`],{stdio:'inherit'});
 const captured=open(structuredClone(original)).createMovieclip({uids:[uid],start:4,end:16,replace:false});open(structuredClone(captured._styk.movieclip.document));
}
