// Unsupported-combination evidence built by the actual editor; these refusals are
// admission safety coverage, never successful Rust command-port replay counts.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {open, joint} from './fixture-kit.mjs';
const folder = fileURLToPath(new URL('../tests/movieclip-admission/', import.meta.url));
mkdirSync(folder, {recursive: true});
const json = value => JSON.stringify(value, (key, value) => key === 'runtime_segments' ? undefined : value);
const base = () => open(JSON.parse(readFileSync(new URL('../tests/movieclip-native-extension/extend-imported.document.json', import.meta.url), 'utf8')));
const write = (name, editor) => {
 const document = json(editor.report); open(JSON.parse(document)).serialize();
 writeFileSync(`${folder}/${name}.document.json`, document+'\n');
 const scenario={name,document:`${name}.document.json`,editor:{},steps:[['@select',2,-1],['addMovieclipToNextKeyframes',1],['undo'],['redo']]};
 writeFileSync(`${folder}/${name}.scenario.json`,JSON.stringify(scenario,null,1)+'\n');
 execFileSync(process.execPath,[fileURLToPath(new URL('./edit-replay.mjs',import.meta.url)),`${folder}/${name}.scenario.json`,`${folder}/${name}.reference.json`],{stdio:'inherit'});
};
for(const where of ['shown','future','source']){
 const editor=base();if(where==='future')editor.selectFrame(1);
 joint(editor,22,1);editor.setNodeIK({enabled:true,pinned:true,chainLength:2,bendDirection:1,allowStretch:false});
 if(where==='source'){
  editor.captureFrameSource(editor.frame);
  for(const frame of editor.report.keyframes)for(const object of frame.objects)delete object._stykIK;
 }
 editor.seek(0);editor.select(2);write(`native-ik-${where}`,editor);
}
{
 const editor=base();editor.enableFrameDrafts();editor.select(2);write('native-saved-draft',editor);
}

{
 const editor=base(),asset=editor.report.figure_types.find(figure=>figure._styk?.movieclip)._styk.movieclip;
 const nested=open(structuredClone(asset.document)),uid=nested.frame.objects[0].unique_id;
 joint(nested,22,uid);nested.setNodeIK({enabled:true,pinned:true,chainLength:2,bendDirection:1,allowStretch:false});
 asset.document=nested.report;editor.select(2);write('native-ik-asset',editor);
}
