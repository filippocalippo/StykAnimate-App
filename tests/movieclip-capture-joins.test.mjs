import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {buildGeometry,evaluatedFrame,timeline} from '../src/pivot/geometry.mjs';
const sample=(report,tick)=>{const rows=timeline(report),index=Math.max(0,rows.findLastIndex(r=>r.start<=tick)),row=rows[index];return buildGeometry(report,evaluatedFrame(report,index,row.count?(tick-row.start)/row.count:0,tick));};
const joined=()=>{
 const document=emptyDocument(),figure=document.figure_types[0];document.keyframes=[createFrame([1,2,3,4].map(uid=>createObject(figure,uid,100+uid*100,180)),10)];
 const e=new Editor({demo:false,propertyChannels:true}).load(document);e.select(3);e.joinTo(2,1);e.duplicateFrame();e.selectFrame(1);e.duplicateFrame();e.selectFrame(2);e.setFrameDuration(1);
 e.seek(4);e.select(2);e.moveSelection(13,-7);e.seek(6);e.rotateSelection(.3);e.seek(12);e.captureFrameSource(e.evaluatedFrame);return e;
};
for(const uid of [2,3])test(`capturing joined UID${uid} remaps saved join slots before native crop normalization`,()=>{
 const e=joined(),source=structuredClone(e.report),figure=e.createMovieclip({uids:[uid],start:4,end:16,replace:false}),document=figure._styk.movieclip.document;
 const reopened=new Editor({demo:false}).load(structuredClone(document));
 for(const frame of [...document.keyframes,...document._styk.movieclipSource.document.keyframes,...Object.values(document._styk.movieclipSource.document._styk.frameSources)])for(const object of frame.objects)if(object.unique_id===3){assert.equal(object.join.target_unique_id,2);assert.equal(frame.objects[object.join.target_object_slot].unique_id,2);}
 for(const tick of [0,.25,1.5,5,10.75,11]){
  const actual=sample(reopened.report,tick).drawables,expected=sample(source,tick+4).drawables.filter(d=>[2,3].includes(d.obj.unique_id));assert.equal(actual.length,expected.length);
  actual.forEach((d,i)=>{assert.equal(d.type,expected[i].type);assert.deepEqual(d.rgb,expected[i].rgb);d.points.forEach((p,j)=>{assert.ok(Math.abs(p.x-expected[i].points[j].x)<1e-5);assert.ok(Math.abs(p.y-expected[i].points[j].y)<1e-5);});});
 }
});
