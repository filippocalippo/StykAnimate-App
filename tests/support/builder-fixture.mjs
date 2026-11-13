/** A figure of `count` segments in limbs of twenty, with `instances` - 1 copies of an unrelated figure beside it: the large rig the Build tests work on. */
import {emptyDocument,createObject,createFrame} from '../../src/demo.mjs';
export function builderFixture(count=1000,instances=1){
 const report=emptyDocument(),figure=report.figure_types[0],base=figure.segments[0];
 figure.segments=Array.from({length:count},(_,i)=>({...base,segment_id:i+1,parent_id:i%20===0?0:i,length:5,angle_rad:(i%20)*.13,thickness:2}));figure.segment_count=count;
 const objects=[createObject(figure,1,200,180)];
 if(instances>1){const other={...figure,figure_type_id:2,name:'Unrelated',segments:figure.segments.map(s=>({...s}))};report.figure_types.push(other);for(let i=1;i<instances;i++)objects.push(createObject(other,i+1,30+(i%25)*30,30+Math.floor(i/25)*30));}
 report.keyframes=[createFrame(objects,1)];return report;
}
