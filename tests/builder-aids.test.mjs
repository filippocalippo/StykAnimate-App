import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEditorSettings } from '../src/settings.mjs';
import { builderBackgroundColor, builderShowsStaticHandles, builderHighlightPath, drawBuilderHighlight } from '../src/builder-aids.mjs';
import { getPivotHandles } from '../src/canvas-interactions.mjs';

const figure=()=>{
 const segments=[{id:10,parent:0,start:{x:0,y:0},end:{x:20,y:0},static:true},{id:30,parent:10,start:{x:20,y:0},end:{x:20,y:20},static:true},{id:90,parent:30,start:{x:20,y:20},end:{x:40,y:20},static:true},{id:100,parent:0,start:{x:0,y:0},end:{x:0,y:40},static:true}].map((s,index)=>({...s,index,seg:{segment_id:s.id,parent_id:s.parent,segment_type:'image',length:20},points:[s.start,{x:99,y:99},s.end]}));
 return {slot:0,root:{x:0,y:0},obj:{unique_id:7,scale:1},segments};
};
test('construction preferences validate and remain independent from scene/playback colors',()=>{
 const s=normalizeEditorSettings({builderCanvasColor:'#A0B1C2',useBuilderCanvasColor:true,builderShowStaticHandles:false,builderHighlightSegment:true});
 assert.equal(s.builderCanvasColor,'#a0b1c2');assert.equal(s.builderShowStaticHandles,false);assert.equal(s.builderHighlightSegment,true);
 assert.equal(builderBackgroundColor(s,{tool:'rig'}),0xffa0b1c2);
 for(const state of [{tool:'pose'},{tool:'rig',playing:true},{tool:'rig',previewing:true}])assert.equal(builderBackgroundColor(s,state),undefined);
 assert.equal(builderBackgroundColor({...s,useBuilderCanvasColor:false},{tool:'rig'}),undefined);
 assert.equal(normalizeEditorSettings({builderCanvasColor:'red'}).builderCanvasColor,'#ffffff');
 assert.equal(builderBackgroundColor({...s,builderCanvasColor:'#000000'},{tool:'rig'}),0xff000000);
});
test('hide static applies only to Builder with native connecting and Handle Edit exceptions',()=>{
 const settings={builderShowStaticHandles:false};assert.equal(builderShowsStaticHandles(settings,{tool:'rig'}),false);
 assert.equal(builderShowsStaticHandles({}, {tool:'rig'}),true);
 for(const tool of ['line','circle','polygon','attach','handle-edit'])assert.equal(builderShowsStaticHandles(settings,{tool}),true);
 assert.equal(builderShowsStaticHandles(settings,{tool:'rig',connecting:true}),true);
 assert.equal(builderShowsStaticHandles(settings,{tool:'pose',handleEditHeld:true}),true);
 assert.equal(builderShowsStaticHandles(settings,{tool:'pose'}),false);
});
test('hidden static keeps only selected static or selected branch and native Builder colors',()=>{
 const g=figure(),geometry={objects:new Map([[0,g]])};
 const handles=options=>getPivotHandles(geometry,{selectedUid:7,selectedJoint:1,builder:true,...options}).filter(x=>x.kind==='segment');
 assert.deepEqual(handles({}).map(x=>x.joint),[1]);assert.equal(handles({})[0].color,'#cc4444');
 assert.deepEqual(handles({selectedBranch:true}).map(x=>x.joint),[1,2]);
 assert.deepEqual(handles({showStatic:true}).map(x=>x.color),['#999999','#cc4444','#999999','#999999']);
 assert.equal(getPivotHandles(geometry,{selectedUid:7}).filter(x=>x.kind==='segment').length,0);
 assert.equal(handles({attaching:true}).length,4);
});
test('highlight ancestry follows stable IDs and straight pivots, with finite cyclic rejection',()=>{
 const g=figure();assert.deepEqual(builderHighlightPath(g,2),[{x:20,y:20},{x:20,y:0},{x:0,y:0}]);
 assert.deepEqual(builderHighlightPath(g,-1),[]);
 const cyclic=figure();cyclic.segments[0].seg.parent_id=90;
 assert.ok(builderHighlightPath(cyclic,2).length<=4);
});
test('sprite highlight strokes its anchor and blue/white ancestry without painting image or mutating source',()=>{
 const g=figure(),geometry={objects:new Map([[0,g]])},before=JSON.stringify(g),calls=[];
 const ctx=new Proxy({strokeStyle:'',lineWidth:0},{get(target,key){if(key in target)return target[key];return(...args)=>calls.push({key,args,color:target.strokeStyle,width:target.lineWidth});},set(target,key,value){target[key]=value;return true;}});
 assert.equal(drawBuilderHighlight(ctx,geometry,{uid:7,jointIndex:2,report:{canvas_width:100,canvas_height:100},frame:{camera:{is_default:true}},view:{scale:2},resources:{image(){throw Error('Sprite highlight must not request bitmap.');}}}),true);
 assert.deepEqual(calls.filter(x=>x.key==='stroke').map(x=>[x.color,x.width]),[['#4444cc',.75],['#0000ff',.75],['#ffffff',.75]]);
 assert.ok(!calls.some(x=>x.key==='drawImage'));
 assert.equal(JSON.stringify(g),before);
});
