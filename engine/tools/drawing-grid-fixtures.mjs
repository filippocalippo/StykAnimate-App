// Editor-built single-image and multi-image movieclips for drawing presentation
// eligibility. This reuses the published cel from the draw-list fixture.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {here,repo,open,whole} from './fixture-kit.mjs';
import {createVfx} from '../../src/vfx.mjs';
const at=process.argv.indexOf('--out');
const out=path.resolve(at<0?path.join(here,'../crates/styk-eval/tests/fixtures/drawing-grid'):process.argv[at+1]);
mkdirSync(out,{recursive:true});
for(const count of [1,2]){
 let counter=0;Object.defineProperty(globalThis.crypto,'randomUUID',{configurable:true,value:()=>`00000000-0000-4000-8000-${String(++counter).padStart(12,'0')}`});
 const document=JSON.parse(readFileSync(path.join(repo,'engine/crates/styk-eval/tests/fixtures/drawlist/drawing-cel.json'),'utf8'));
 const e=open(document);e.setFrameDuration(2);whole(e,1);
 e.changeVfxStack({kind:'figure',uid:1},stack=>{const effect=createVfx('blur','child-blur');effect.params.radius=4;stack.push(effect);});
 if(count===2){const copy=e.duplicateSelection({offset:20})[0];e.select(1,-1,{add:true});if(!copy||e.selectedUids.size!==2)throw new Error('The editor did not select both drawings.');}
 e.createMovieclip({start:0,end:e.totalTicks,name:count===1?'One cel':'Two cels'});
 e.changeVfxStack({kind:'figure',uid:e.selectedUid},stack=>{const effect=createVfx('tint','container-tint');effect.params.color=0xff4080;effect.params.mix=.25;stack.push(effect);});
 const name=count===1?'single-child':'multiple-children';
 if(e.geometry.drawables.length!==count)throw new Error('The captured clip has the wrong drawable count.');
 writeFileSync(path.join(out,name+'.json'),JSON.stringify(e.serialize())+'\n');
 console.log(`${name}: ${count} published drawing images in one movieclip`);
}
