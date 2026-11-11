import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {missingFixture} from './helpers/local-fixtures.mjs';
import {roundTrip, exportDocument, importBytes, nodeCodec} from './support/codec.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';
import {pivotDocument} from './support/engine-export.mjs';
const clone=structuredClone;
/** `change(report)` writes into the document before it opens. */
function fixture({authored=true,easing=false,joined=true,change}={}){
  const report=emptyDocument(),figure=report.figure_types[0],base=figure.segments[0];
  figure.segments=[7,99,301].map((id,i)=>({...clone(base),segment_id:id,parent_id:i?7:0,length:[78,43,31][i],angle_rad:[-.8,.5,-1.2][i],bend_rad:[.2,-.3,.1][i]}));
  figure.segment_count=3;report.figure_types.push({...clone(figure),figure_type_id:2});report.auto_easing=easing;
  report.keyframes=[0,1,2,3].map(i=>{
    const object=createObject(figure,1,100+i*17,200-i*11);object.angles=[[-2.8,2.3,.5],[2.7,-2.8,-.9],[-1.7,.8,2.4],[.4,-.6,-2.2]][i];
    object.scale=[.8,1.7,1.2,.65][i];object.len_flag=object.bend_flag=1;object.lengths=[78+i*7,43-i*3,31+i*2];object.bends=[[.2,-.3,.1],[-.9,.7,.2],[1.1,-.5,-.6],[.1,.4,.8]][i];
    const child=createObject(report.figure_types[1],2,350+i*4,280);if(joined)child.join={target_object_slot:0,target_unique_id:1,target_handle_id:99};
    const frame=createFrame([object,child],i===3?1:[7,5,8][i]);frame.camera={is_default:false,x:i*3,y:-i*2,scale:1+i*.1,angle_rad:i*.15};return frame;
  });
  change?.(report);
  const editor=ownedEditorFor({demo:false,layerTimeline:true,propertyChannels:true}, report);
  if(authored)editor.addAnimationKeys([
    ...[['rotation',[-.5,.9,-1.7]],['scale',[.6,1.8,.95]],['x',[83,177,121]],['y',[230,168,249]]].flatMap(([property,values])=>[0,8,20].map((tick,i)=>({target:{kind:'figure',uid:1},property,tick,value:values[i]}))),
    {target:{kind:'camera'},property:'rotation',tick:0,value:.17},{target:{kind:'camera'},property:'rotation',tick:20,value:-.22},
  ]);
  editor.select(1,0);return editor;
}
/** The colours the engine paints the first figure's parts in, back to front. */
function drawn(editor,tick=0){editor.seek(tick);return editor.geometry.objects.get(0).drawables.map(item=>item.rgb);}
function roundtrip(document,format){
  return roundTrip({document,format});
}
test('native PIV retains tied segment and polygon paint order through required topology reordering',async ()=>{
  const editor=fixture({authored:false,change:report=>{
    const figure=report.figure_types[0];
    figure.segments.forEach((segment,i)=>{segment.z_order=1;segment.color_rgb=[30+i*70,50,190];});
    figure.polyfills=[{polyfill_id:1,segment_ids:[0,7,99],color_rgb:[240,10,80],alpha_raw:0,z_order:1}];
  }});
  const expected=drawn(editor);
  editor.setOrigin(99);const native=await roundtrip(pivotDocument(editor.report),'piv');
  assert.deepEqual(drawn(ownedEditorFor({demo:false},native)),expected);
});
test('native writer changes keep untouched source PIV bytes identical',{skip:missingFixture('../Pivot Animator v5/Animations/tween_camera.piv')},async()=>{
  const codec=nodeCodec(),source=readFileSync(fileURLToPath(new URL('../../Pivot Animator v5/Animations/tween_camera.piv',import.meta.url)));
  const imported=await importBytes(source,'tween_camera.piv',{codec}),{bytes:output}=await exportDocument({...imported,format:'piv'},{codec});
  assert.ok(output.length>0);assert.ok(Buffer.from(output).equals(source));
});
