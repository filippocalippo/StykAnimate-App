// Saved top-level native VFX read proof through the established replay owner.
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const folder=fileURLToPath(new URL('../tests/movieclip-native-vfx/',import.meta.url));
mkdirSync(folder,{recursive:true});
for(const [tapeName,step,label] of [['bake-native-stored-container',0,'container'],['bake-native-stored-outer-scene',0,'scene-before'],['bake-native-stored-outer-scene',3,'scene-baked']]){
 const tape=JSON.parse(readFileSync(new URL(`../tests/movieclip-bake/${tapeName}.json`,import.meta.url),'utf8'));
 const captured=tape.steps[step],name=`native-vfx-${label}`;
 const document=`${name}.document.json`;
 // Use the real captured report unchanged; no reconstructed channel payload.
 writeFileSync(`${folder}/${document}`,captured.document+'\n');
 const scenario={name,document,editor:{},steps:[['@select',captured.state.selectedUid,-1],['@frame'],... [2.25,7.75,16].flatMap(tick=>[['@seek',tick],['@frame']])]};
 writeFileSync(`${folder}/${name}.scenario.json`,JSON.stringify(scenario)+'\n');
 execFileSync(process.execPath,[fileURLToPath(new URL('./edit-replay.mjs',import.meta.url)),`${folder}/${name}.scenario.json`,`${folder}/${name}.reference.json`],{stdio:'inherit'});
 console.log(`${name}: ${scenario.steps.length} same-owner calls`);
}
