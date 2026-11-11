import test from 'node:test';
import assert from 'node:assert/strict';
import {builderFixture} from '../scripts/builder-benchmark-fixture.mjs';
import {bucketRegion,enclosedRegions} from '../src/builder-fill.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';
export function squareFixture(){const f=builderFixture(4);f.figure_types[0].segments.forEach((s,i)=>{s.parent_id=i;s.length=80;s.angle_rad=i*Math.PI/2;s.thickness=4;});f.keyframes[0].objects[0].angles=f.figure_types[0].segments.map(s=>s.angle_rad);return f;}
test('multi-selection styles and deletion are atomic',()=>{
 const e = ownedEditorFor({propertyChannels:false}, builderFixture(8));e.select(1,1);e.toggleSegment(1,5);assert.deepEqual([...e.selectedSegmentIds],[2,6]);
 const geometry=e.geometry,before=JSON.stringify(e.serialize());e.updateBuilderSegmentStyle({color:'#ff3300',thickness:19});
 const g=e.geometry.objects.get(0);for(const s of g.segments){assert.equal(s.thickness,[1,5].includes(s.index)?19:2);assert.deepEqual(s.rgb,[1,5].includes(s.index)?[255,51,0]:geometry.objects.get(0).segments[s.index].rgb);}
 e.undo();assert.equal(JSON.stringify(e.serialize()),before);assert.equal(e.selectedSegmentIds.size,2);
 const n=e._undo.length;e.deleteSegment({handleIds:e.selectedSegmentIds,branch:false});assert.equal(e.figure.segments.length,6);assert.equal(e._undo.length,n+1);e.undo();assert.equal(JSON.stringify(e.serialize()),before);assert.deepEqual([...e.selectedSegmentIds],[2,6]);
});
test('bucket detects a closed native outline, ignores open strokes, and creates editable fills',()=>{
 const e = ownedEditorFor(undefined, squareFixture());e.select(1,0);const g=e.geometry.objects.get(0),root=g.root;
 const region=bucketRegion(g,{x:root.x+40,y:root.y+40});assert.ok(region);assert.equal(enclosedRegions(g).length,1);assert.equal(bucketRegion(g,{x:root.x-20,y:root.y-20}),null);
 const before=JSON.stringify(e.serialize());const poly=e.addPolygon(region.ids);e.selectPolygon(1,e.figure.polyfills.findIndex(p=>p.polyfill_id===poly.polyfill_id));assert.equal(e.selectedPolygonIndex,0);e.removePolygon(0);assert.equal(e.selectedPolygonIndex,-1);e.undo();assert.equal(e.selectedPolygonIndex,0);e.undo();assert.equal(JSON.stringify(e.serialize()),before);
 const open={...g,segments:g.segments.slice(0,3)};assert.equal(bucketRegion(open,{x:root.x+40,y:root.y+40}),null);
});
