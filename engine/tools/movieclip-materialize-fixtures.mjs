// Explicit editable materialization oracle, recorded before the Rust implementation.
import {fileURLToPath} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createMovieclipMaterializer} from '../../src/movieclip-materialize.mjs';
import {documentOf,limb,open,nextKey,prune} from './fixture-kit.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
const folder=fileURLToPath(new URL('../crates/styk-eval/tests/fixtures/movieclip-materialize/',import.meta.url));
mkdirSync(folder,{recursive:true});
for (const variant of ['plain','flip','joined','nested']) {
 const e=open(documentOf([limb(),limb()],i=>[200+i*160,160]));nextKey(e,8);e.select(1);e.moveSelection(52.75,-17.125);e.rotateFigure(.6);e.seek(0);
 if(variant==='joined'){e.select(2);e.joinTo(1,33);}
 e.report.keyframes[0]._styk.easing={interpolation:'bezier',bezier:[.2,.02,.4,.94]};
 const editor=open(e.report,{layerTimeline:true,propertyChannels:true});editor.select(1);editor.createMovieclip({start:2,end:7});
 if(variant==='nested')editor.createMovieclip({start:2,end:7});
 editor.seek(3);const frame=snapshotPoseFrame(editor.evaluatedFrame);const selected=frame.objects.find(o=>o.unique_id===editor.selectedUid);
 if(variant==='flip'){selected.image_text_flags=1;selected.scale=1.375;selected.angles=[.37];}
 selected.privatePartData={survives:['editable',3]};
 const materializer=createMovieclipMaterializer(editor.report);const result=materializer.frame(frame);
 const write=(name,value)=>writeFileSync(`${folder}/${variant}.${name}.json`,JSON.stringify(value,(key,value)=>key==='runtime_segments'?undefined:value)+'\n');
 write('document',prune(editor.report));write('frame',frame);write('reference',{frame:result,figures:materializer.figures,identities:[...materializer.identities]});
}
