import {mkdir,writeFile} from 'node:fs/promises';
import {RIG_EXAMPLES,rigExampleDocument} from '../src/rig-examples.mjs';
import {buildContainerV2} from '../tests/support/native-files.mjs';
import {validateScene} from '../src/pivot/model.mjs';
const directory='artifacts/connector-3d-rigs';await mkdir(directory,{recursive:true});
for(const example of RIG_EXAMPLES){
  const document=rigExampleDocument(example.id);validateScene(document);
  await writeFile(`${directory}/${example.id}.stkz`,await buildContainerV2(document,'stkz'));
  const source=document.keyframes[0],control=example.control-1,fig=document.figure_types[0];
  document.keyframes=Array.from({length:9},(_,index)=>{
    const phase=index/8,frame=structuredClone(source),o=frame.objects[0];frame.keyframe_index=index;frame.duration_raw=index===8?1:9;
    const controls=example.build?.().controls;
    if(controls){
      for(const c of controls){
        const stops=c.demo??[c.min,c.max,c.min],t=phase*(stops.length-1),i=Math.min(stops.length-2,Math.floor(t)),value=stops[i]+(stops[i+1]-stops[i])*(t-i),raw=c.offset+value*c.scale;
        if(c.channel==='angle')o.angles[c.handle-1]=raw;
        else{if(!o.len_flag){o.len_flag=1;o.lengths=fig.segments.map(s=>s.length);}o.lengths[c.handle-1]=raw;}
      }
    }
    else if(example.id==='perspective-tunnel-3d')o.angles[control]+=.65*Math.sin(phase*Math.PI*2);
    else o.angles[control]+=phase*Math.PI*2;
    // Animate every independent yaw in the gyroscope, and genuine sliding
    // attachment channels in the cube, helix and tunnel.
    if(example.id==='orbital-gyroscope-3d')fig.segments.forEach((s,i)=>{if(i!==control&&s.name.includes('Turn ·'))o.angles[i]-=phase*Math.PI*2*(i%2?1:2);});
    const sliders=fig._styk.rigExample.sliders;
    if(sliders?.length){o.len_flag=1;o.lengths=fig.segments.map(s=>s.length);const slider=sliders.at(-1);o.lengths[slider-1]=.5+.35*Math.sin(phase*Math.PI*2);}
    return frame;
  });validateScene(document);await writeFile(`${directory}/${example.id}.styk`,await buildContainerV2(document,'styk'));
}
await writeFile(`${directory}/README.md`,'# Editable rig collection\n\nEach .stkz is a reusable figure. Each .styk is an animated demonstration (73 ticks at 24 FPS). Open Library → Rig examples in the app to try a rig and Add to Animate. Previews and imported figures use ordinary joint Angle, Length and connector Slide properties.\n\nDrag Turn to rotate. Hold Ctrl while dragging Depth to stretch its projection. Connector middle joints slide with an ordinary drag. Static construction joints remain editable in Build Figure. Opaque solids use Builder one-sided fills with editable reference joints and individual face colors. There is no special preset runtime, grouped shading or 3D mesh.\n\nSee docs/ROTATING-CUBE.md in the repository to build a cube from scratch.\n\n'+RIG_EXAMPLES.map(r=>`- **${r.name}**`).join('\n')+'\n');
console.log(`Wrote ${RIG_EXAMPLES.length} reusable figures and ${RIG_EXAMPLES.length} animated projects to ${directory}.`);
