import test from 'node:test';
import assert from 'node:assert/strict';
import {formatSegmentValues,parseSegmentValues} from '../src/editor-handle-commands.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

const near=(a,b,tolerance=2e-4)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);

function document({joined=false,curved=false,scale=1}={}){
  const report=emptyDocument(),figure=report.figure_types[0],base=figure.segments[0];
  figure.segments=[{...base,segment_id:11,parent_id:0,length:100,angle_rad:.2,bend_rad:curved?.7:0},
    {...base,segment_id:22,parent_id:11,length:55,angle_rad:1,bend_rad:curved?-.3:0},
    {...base,segment_id:33,parent_id:0,length:60,angle_rad:2.5}];figure.segment_count=3;
  const objects=[createObject(figure,1,300,220,{scale})];
  if(joined){objects.push(createObject(figure,2,0,0,{join:{target_object_slot:0,target_handle_id:11}}));
    objects.push(createObject(figure,3,0,0,{join:{target_object_slot:1,target_handle_id:0}}));}
  report.keyframes=[createFrame(objects),createFrame([createObject(figure,1,320,200)])];
  return report;
}
function fixture(options){const editor=ownedEditorFor({demo:false,layerTimeline:true,propertyChannels:true}, document(options));editor.select(1,0);return editor;}

test('relative angles use the nearest incoming end tangent through joined origin ancestors',()=>{
  const editor=fixture({joined:true,curved:true});
  editor.select(3,0);near(editor.segmentValues({relative:true}).angle,(.2-(.2+.7))*180/Math.PI);
  const parent=structuredClone(editor.frame.objects[0]);editor.setSegmentValues({angle:0},{relative:true});
  near(editor.object.angles[0],.9);assert.deepEqual(editor.frame.objects[0],parent);
  editor.select(1,1);near(editor.segmentValues({relative:true}).angle,(1-.9)*180/Math.PI);
});

test('native colon clipboard uses degrees, unscaled length and visible-field numeric compaction',()=>{
  assert.equal(formatSegmentValues({angle:30,bend:-15,length:42.5}),'30:-15:42.5');
  assert.deepEqual(parseSegmentValues('30,5:-15,25:42,5'),{angle:30.5,bend:-15.25,length:42.5});
  assert.deepEqual(parseSegmentValues('1:2'),{angle:1,bend:2});
  assert.deepEqual(parseSegmentValues('ignored:30:bad:-15:42.5:99'),{angle:30,bend:-15,length:42.5});
  assert.deepEqual(parseSegmentValues('1:2:Infinity'),{angle:1,bend:2});
  assert.deepEqual(parseSegmentValues('bad'),{});
  for(const text of['1:2:0','1'.repeat(101)])assert.throws(()=>parseSegmentValues(text));
  const editor=fixture({scale:3});const copy=editor.copySegmentValues();near(parseSegmentValues(copy).length,100);
  editor.select(1,1);editor.pasteSegmentValues(copy);const values=editor.segmentValues();near(values.angle,.2*180/Math.PI);near(values.length,100);
  editor.pasteSegmentValues('90');near(editor.segmentValues().angle,90);near(editor.segmentValues().length,100);
  assert.equal(editor.pasteSegmentValues('bad'),false);
});
