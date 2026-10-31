import {messageError} from './localized-error.mjs';
/** Small editable rigs used by the library, regression suite and benchmarks.
 * Hidden segments are ordinary zero-width controls, not baked artwork. */
import {createFrame, createObject} from './demo.mjs';
import {CONNECTOR_3D_EXAMPLES} from './rig-examples-3d.mjs';
import {SOLID_RIG_EXAMPLES} from './rig-solids.mjs';
import {MECHANISM_RIG_EXAMPLES} from './rig-mechanism-examples.mjs';

const line=(id,parent,length,angle=0,width=6,name='',rig)=>({segment_id:id,parent_id:parent,length,angle_rad:angle,
  thickness:width,bend_rad:0,primitive_code:0,aux_code:0,flags:0,segment_type:'line',segment_kind:'line',
  color_rgb:[13,153,255],transparency:0,visible:width>0,z_order:id,name,...(rig?{_stykRig:rig}:{})});
const connector=(id,a,b,span,angle=0,width=5,name='Connector',position=.5)=>line(id,a,position,angle,width,name,{connector:{start:a,end:b,restLength:span}});
const stretch=(restLength,width='keep')=>({restLength,min:0,max:8,width});
const follower=(driver,mode='stretch',influence=1)=>({follow:{driver,mode,influence}});

const CONSTRAINT_TEST_RIGS = [
  {id:'sliding-carriage',name:'Sliding carriage',description:'Slide the connector joint to move the carriage along its rail. The carriage remains rigid.',control:3,
    segments:()=>[line(1,0,120,Math.PI,0,'Rail start'),line(2,0,120,0,0,'Rail end'),connector(3,1,2,240,0,4,'Rail · slide me'),
      line(4,3,30,-Math.PI/2,16,'Carriage stem'),line(5,4,35,0,22,'Carriage body'),line(6,4,35,Math.PI,22,'Carriage body')]},
  {id:'articulated-piston',name:'Articulated piston',description:'Rotate the crank. The piston spans two independent anchors and its sleeve follows the middle joint.',control:2,
    segments:()=>[line(1,0,100,Math.PI,0,'Fixed mount'),line(2,0,100,-.7,8,'Crank'),connector(3,1,2,187.87,-.35,8,'Piston rod'),
      line(4,3,48,-.35,22,'Sleeve'),line(5,3,8,-.35+Math.PI/2,30,'Seal')]},
  {id:'telescoping-panels',name:'Telescoping panels',description:'Stretch the extension control. Panel spacing changes while each panel keeps its width.',control:1,
    segments:()=>[line(1,0,180,0,0,'Extension · stretch me',{stretch:stretch(180)}),
      line(2,1,60,Math.PI,0,'Spacing A',follower(1)),line(3,2,45,0,30,'Panel A',follower(1,'rigid')),
      line(4,2,60,Math.PI,0,'Spacing B',follower(1)),line(5,4,45,0,30,'Panel B',follower(1,'rigid')),
      line(6,4,60,Math.PI,0,'Spacing C',follower(1)),line(7,6,45,0,30,'Panel C',follower(1,'rigid'))]},
  {id:'flexing-muscle',name:'Flexing muscle',description:'Bend the forearm. The span across the arm controls a muscle that thickens as it shortens.',control:2,
    segments:()=>{const c=connector(3,0,2,160,0,0,'Muscle driver');c._stykRig.stretch=stretch(160,'inverse');return [
      line(1,0,80,0,6,'Upper arm'),line(2,1,80,0,6,'Forearm · bend me'),c,
      line(4,3,55,Math.PI,22,'Muscle',follower(3)),line(5,3,55,0,22,'Muscle',follower(3))];}},
  {id:'stretchy-mouth',name:'Stretchy mouth',description:'Stretch the mouth-width control. Lip details follow the span; teeth retain their size.',control:2,
    segments:()=>{const c=connector(3,1,2,160,0,5,'Mouth span');c._stykRig.stretch=stretch(160);return [
      line(1,0,80,Math.PI,0,'Left corner'),line(2,0,80,0,0,'Right corner · stretch me',{stretch:stretch(80)}),c,
      line(4,3,65,Math.PI+.18,7,'Upper lip left',follower(3)),line(5,3,65,-.18,7,'Upper lip right',follower(3)),
      line(6,3,28,Math.PI,0,'Tooth offset',follower(3)),line(7,6,15,Math.PI/2,12,'Rigid tooth',follower(3,'rigid'))];}},
  {id:'nested-curve-controls',name:'Nested curve controls',description:'Slide either construction connector. Their middle joints anchor a third connector and its attached marker.',control:4,
    segments:()=>[line(1,0,120,Math.PI,0,'Point A'),line(2,0,125,-Math.PI/2,0,'Point B'),line(3,0,120,0,0,'Point C'),
      connector(4,1,2,173.277,-.805,3,'A–B interpolation'),connector(5,2,3,173.277,.805,3,'B–C interpolation'),
      connector(6,4,5,120,0,5,'Nested connector'),line(7,6,12,-Math.PI/2,18,'Attached marker')]},
];

export const RIG_EXAMPLES=[...MECHANISM_RIG_EXAMPLES,...SOLID_RIG_EXAMPLES,...CONNECTOR_3D_EXAMPLES];

export function rigExampleDocument(id) {
  const example=RIG_EXAMPLES.find(r=>r.id===id)??CONSTRAINT_TEST_RIGS.find(r=>r.id===id);if(!example)throw messageError(new Error(''), "errors.rigExamples.unknownRigExample", {});
  const built=example.build?.(),segments=built?.segments??example.segments();
  const palette=[[13,153,255],[81,111,135],[118,172,208],[232,154,56]];
  if(!built)segments.forEach((s,i)=>{s.color_rgb=palette[i%palette.length].slice();});
  const figure={figure_type_id:1,name:example.name,segments,segment_count:segments.length,
    polyfills:built?.polyfills??[],image_assets:[],text_assets:[],_styk:{colorMode:'segments',rigExample:{id,description:example.description,control:example.control,...(built?.projection?{projection:built.projection}:{}),...(built?.sliders?{sliders:built.sliders}:{})}}};
  const object=createObject(figure,1,320,230);
  return {version:5,canvas_width:640,canvas_height:460,fps:24,auto_easing:false,auto_easing_disabled_raw:1,
    figure_types:[figure],backgrounds:[],keyframes:[createFrame([object],1)],_styk:{format:'StykAnimate',format_version:1,name:example.name}};
}
