import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePaint,parseColor,samplePaint,segmentPaint,paintBackground,svgPaintDefinition} from '../src/paint.mjs';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
const paint={type:'radial',angle:35,stops:[{offset:0,color:[255,0,0],opacity:.5},{offset:.4,color:[0,255,0],opacity:0},{offset:1,color:[0,0,255],opacity:1}]};
test('HEX shorthand and alpha decode; malformed input is rejected',()=>{
 assert.deepEqual(parseColor('#f008'),{color:[255,0,0],opacity:136/255});
 assert.equal(parseColor('aabbcc00').opacity,0);
 for(const value of ['#12','red','#ggffff'])assert.throws(()=>parseColor(value));
});
test('Paint validation rejects unsafe values and preserves stop ordering',()=>{
 assert.throws(()=>normalizePaint({...paint,angle:NaN}));
 assert.throws(()=>normalizePaint({...paint,stops:[{...paint.stops[0],opacity:2},paint.stops[1]]}));
 assert.deepEqual(normalizePaint({...paint,stops:[...paint.stops].reverse()}),paint);
 assert.equal(samplePaint(paint,.4).opacity,0);
});
test('Advanced paints survive undo, redo and project serialization',()=>{
 const report=emptyDocument(),fig=report.figure_types[0];report.keyframes=[createFrame([createObject(fig,1,100,100)])];
 const e=new Editor({demo:false}).load(report);e.select(1,0);const before=structuredClone(e.figure.segments[0]);
 e.updateBuilderSegmentStyle({paint});assert.deepEqual(e.figure.segments[0].paint,paint);
 assert.equal(e.figure.segments[0].transparency,128);assert.deepEqual(e.figure.segments[0].secondary.rgb,[0,0,255]);
 e.undo();assert.deepEqual(e.figure.segments[0],before);e.redo();
 const reopened=new Editor({demo:false}).load(e.serialize());assert.deepEqual(reopened.report.figure_types[0].segments[0].paint,paint);
 e.updateBuilderSegmentStyle({opacity:.25});assert.equal(segmentPaint(e.figure.segments[0]).stops[0].opacity,64/255);
 e.updateBuilderSegmentStyle({paint:{type:'solid',stops:[paint.stops[0]]}});assert.equal(e.figure.segments[0].secondary,null);
});
test('Gradient SVG definitions preserve offsets and alpha',async()=>{
 for(const type of ['linear','radial']){
  const output=await svgPaintDefinition({...paint,type},{x:0,y:0},{x:100,y:0},'test');assert.ok(output.includes('id="test"'));assert.ok(!output.includes('NaN'));
  if(['linear','radial'].includes(type)){assert.ok(output.includes('offset="0.4"'));assert.ok(output.includes('stop-opacity="0"'));}
 }
 assert.deepEqual(paintBackground(paint).paint,paint);
});
