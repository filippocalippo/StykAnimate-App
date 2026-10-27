import test from 'node:test';
import assert from 'node:assert/strict';
import { figureIntersectsMarquee, getPivotHandles, getPivotHandleRadius, invalidatePivotHandleTopology, pickCanvasHandle, pickCanvasSegment, pivotHandleColor } from '../src/canvas-interactions.mjs';
import { createDemo } from '../src/demo.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

const object = (uid, slot, root, end, options = {}) => ({
  slot, root, obj: { unique_id: uid, object_slot: slot, join: options.join },
  segments: end ? [{ index: 0, seg: { segment_id: 7, parent_id: 0, length: 20, thickness: 2 }, end, static: Boolean(options.static) }] : [],
});
const geometry = objects => ({ objects: new Map(objects.map(g => [g.slot, g])), orderedObjects: objects,
  get drawables() { throw new Error('Handle preparation must not flatten rendering geometry.'); } });

test('segment bodies select their endpoint with screen-space padding and native painter order', () => {
  const a = object(1, 0, {x: 0, y: 0}, {x: 100, y: 0});
  const b = object(2, 1, {x: 0, y: 0}, {x: 100, y: 0});
  for (const g of [a, b]) Object.assign(g.segments[0], {type: 'line', points: [g.root, g.segments[0].end], thickness: 4, alpha: 1, opacity: 1});
  const scene = geometry([a, b]), p = {x: 50, y: 5};
  assert.equal(pickCanvasHandle(scene, p, {minRadius: 8, nearest: true}), null);
  const hit = pickCanvasSegment(scene, p);
  assert.equal(hit.uid, 2); assert.equal(hit.joint, 0); assert.equal(hit.action, 'pose');
  assert.equal(hit.kind, 'segment-body'); assert.deepEqual(hit.point, b.segments[0].end);
  assert.equal(pickCanvasSegment(scene, p, {uid: 1}).uid, 1);
  assert.equal(pickCanvasSegment(scene, p, {scale: 4}), null);
  for (const key of ['hiddenUids', 'lockedUids']) {
    const handles = getPivotHandles(scene, {[key]: new Set([2])});
    assert.equal(pickCanvasSegment(scene, p, {handles}).uid, 1);
    assert.equal(pickCanvasSegment(scene, p, {handles, uid: 2}), null);
  }
  b.segments[0].points = [b.root, {x: 50, y: 50}, b.segments[0].end];
  assert.equal(pickCanvasSegment(scene, {x: 50, y: 50}).uid, 2);
  assert.equal(pickCanvasSegment(scene, {x: 50, y: 0}).uid, 1);
});

test('expanded segment targets respect static, invisible, transparent and non-line artwork', () => {
  for (const patch of [{static: true}, {alpha: 0}, {opacity: 0}, {thickness: 0}, {type: 'image'}, {seg: {visible: false}}]) {
    const g = object(1, 0, {x: 0, y: 0}, {x: 100, y: 0});
    Object.assign(g.segments[0], {type: 'line', points: [g.root, g.segments[0].end], thickness: 4, alpha: 1, opacity: 1}, patch);
    assert.equal(pickCanvasSegment(geometry([g]), {x: 50, y: 0}), null);
  }
});

test('Rotate selects spatial pivots while Pose retains native endpoints and IK dragging',()=>{
  const g=object(1,0,{x:0,y:0},{x:20,y:40});g.segments[0].start={x:10,y:20};g.segments[0].spatialFrame={q:[0,0,0,1]};
  const scene=geometry([g]),descriptorCache={};
  const handles=mode=>getPivotHandles(scene,{selectedUid:1,spatialMode:mode,descriptorCache});
  assert.deepEqual(handles('pose')[1].point,g.segments[0].end);
  assert.deepEqual(handles('rotate')[1].point,g.segments[0].start);assert.equal(handles('rotate')[1].action,'select');
  assert.equal(handles('pose')[1].action,'pose');
  assert.deepEqual(getPivotHandles(scene,{selectedUid:1,spatialMode:'rotate',builder:true})[1].point,g.segments[0].end);
});

test('hidden static endpoints have retained selection-only targets without changing painted handles', () => {
  const parent = object(1, 0, {x: 0, y: 0}, {x: 100, y: 0}, {static: true});
  const scene = geometry([parent]), descriptorCache = {};
  const visible = getPivotHandles(scene);
  const options = {selectStatic: true, showUnselected: false, descriptorCache};
  const targets = getPivotHandles(scene, options), hit = pickCanvasHandle(scene, {x: 100, y: 0}, {handles: targets});
  assert.equal(hit.action, 'select'); assert.equal(hit.uid, 1); assert.equal(hit.id, 7);
  assert.deepEqual(getPivotHandles(scene), visible);
  assert.equal(getPivotHandles(scene, options)[1], targets[1]);
  for (const key of ['hiddenUids', 'lockedUids'])
    assert.equal(pickCanvasHandle(scene, hit.point, {...options, [key]: new Set([1])}), null);
  assert.equal(getPivotHandles(scene, {...options, allowStaticManipulation: true})[1].action, 'pose');
});

test('join target handles include static endpoints, exclude ineligible figures and colour dynamic nodes', () => {
  const a = object(1, 0, {x: 0, y: 0}, {x: 100, y: 0}, {static: true});
  const b = object(2, 1, {x: 200, y: 0}, {x: 230, y: 0});
  const handles = getPivotHandles(geometry([a, b]), {attaching: true, joinTargetUids: new Set([1]), showUnselected: false});
  assert.deepEqual(handles.map(h => h.uid), [1, 1]);
  assert.deepEqual(handles.map(h => h.color), ['#ff8800', '#ffffff']);
  assert.equal(handles[1].id, 7);
  const dynamic = getPivotHandles(geometry([b]), {attaching: true, showUnselected: false});
  assert.deepEqual(dynamic.map(h => h.color), ['#ff8800', '#ff0000']);
});

test('padded node picking chooses the nearest node and keeps painter order for ties', () => {
  const a = object(1, 0, {x:0,y:0}, {x:20,y:0});
  const b = object(2, 1, {x:0,y:0}, {x:30,y:0});
  const scene = geometry([a,b]);
  const options = {minRadius:8, nearest:true};
  assert.equal(pickCanvasHandle(scene,{x:24,y:0},options).uid,1);
  assert.equal(pickCanvasHandle(scene,{x:25,y:0},options).uid,2);
  assert.equal(pickCanvasHandle(scene,{x:20,y:7},options).joint,0);
  assert.equal(pickCanvasHandle(scene,{x:20,y:9},options),null);
  assert.equal(pickCanvasHandle(scene,{x:10,y:15},options),null);
});

test('descriptor retention preserves picking order, refreshes changed figures and explicit topology invalidation',()=>{
  const a=object(1,0,{x:0,y:0},{x:20,y:0}),b=object(2,1,{x:0,y:20},{x:20,y:20}),descriptorCache={};
  const first=getPivotHandles(geometry([a,b]),{descriptorCache});
  const next=getPivotHandles(geometry([a,{...b,root:{x:10,y:20}}]),{descriptorCache});
  assert.equal(next[0],first[0]);assert.equal(next[1],first[1]);assert.notEqual(next[2],first[2]);
  assert.deepEqual(next,getPivotHandles(geometry([a,{...b,root:{x:10,y:20}}])));
  a.segments[0].static=true;invalidatePivotHandleTopology();
  assert.equal(getPivotHandles(geometry([a,b]),{descriptorCache}).length,3);
  assert.equal(getPivotHandles(geometry([a,b]),{descriptorCache,showStatic:true}).length,4);
  assert.equal(getPivotHandles(geometry([a,b]),{descriptorCache,showStatic:true,hiddenUids:new Set([1])}).length,2);
});

test('attached child origins cannot steal a coincident parent endpoint and move the whole assembly', () => {
  const parent = object(1, 0, { x: 0, y: 0 }, { x: 100, y: 0 });
  const child = object(2, 1, { x: 100, y: 0 }, { x: 130, y: 20 }, { join: { target_object_slot: 0, target_handle_id: 7 } });
  for (const selectedUid of [null, 1, 2]) {
    const hit = pickCanvasHandle(geometry([parent, child]), child.root, { selectedUid });
    assert.equal(hit.g, parent); assert.equal(hit.joint, 0); assert.equal(hit.id, 7); assert.equal(hit.action, 'pose');
  }
});

test('only a real free origin permits translation, while static attachments remain fixed', () => {
  const parent = object(1, 0, { x: 0, y: 0 }, { x: 100, y: 0 }, { static: true });
  const child = object(2, 1, { x: 100, y: 0 }, null, { join: { target_object_slot: 0, target_handle_id: 7 } });
  assert.equal(pickCanvasHandle(geometry([parent, child]), child.root), null);
  assert.equal(pickCanvasHandle(geometry([parent, child]), child.root, { showStatic: true, allowStaticManipulation: true }).action, 'pose');
  child.root = parent.root;
  const hit = pickCanvasHandle(geometry([parent, child]), parent.root, { selectedUid: 2 });
  assert.equal(hit.g, parent); assert.equal(hit.action, 'move');
});

test('front figure wins even over a nearer selected figure; hidden and locked figures cannot capture it', () => {
  const selected = object(1, 0, { x: 0, y: 0 }, { x: 100, y: 0 });
  const other = object(2, 1, { x: 5, y: 0 }, { x: 150, y: 0 });
  const scene = geometry([selected, other]);
  assert.equal(pickCanvasHandle(scene, selected.root, { radius: 6, selectedUid: 1 }).g, other);
  assert.equal(pickCanvasHandle(scene, other.root, { radius: 6, hiddenUids: new Set([2]) }).g, selected);
  assert.equal(pickCanvasHandle(scene, other.root, { lockedUids: new Set([1, 2]) }), null);
});

test('coincident equivalent nodes use native painter order without selected-first priority', () => {
  const back = object(1, 0, { x: 0, y: 0 }, { x: 100, y: 0 });
  const front = object(2, 1, { x: 0, y: 0 }, { x: 100, y: 0 });
  const scene = geometry([back, front]);
  assert.equal(pickCanvasHandle(scene, front.segments[0].end).g, front);
  assert.equal(pickCanvasHandle(scene, front.segments[0].end, { selectedUid: 1 }).g, front);
  assert.equal(pickCanvasHandle(scene, front.segments[0].end, { frame: { object_draw_order: [1, 0] } }).g, back);
});

test('reverse primitive draw order wins over segment index and each origin is tested last', () => {
  const g = object(1, 0, { x: 10, y: 10 }, { x: 10, y: 10 });
  g.segments[0].z = 8;
  g.segments.push({ ...g.segments[0], index: 1, z: 2, seg: { segment_id: 8, parent_id: 0, length: 20 } });
  assert.equal(pickCanvasHandle(geometry([g]), g.root).joint, 0);
});

test('native hit bounds are an open square, not a circle or padded outline', () => {
  const g = object(1, 0, { x: 0, y: 0 }, null), scene = geometry([g]);
  assert.equal(pickCanvasHandle(scene, { x: 4.9, y: 4.9 }).action, 'move');
  assert.equal(pickCanvasHandle(scene, { x: 5, y: 0 }), null);
  assert.equal(pickCanvasHandle(scene, { x: 0, y: -5 }), null);
});

test('projected native square hits retain their screen alignment under a rotated camera', () => {
  const g = object(1, 0, {x: 0, y: 0}, null), scene = geometry([g]);
  const project = point => ({x: (point.x - point.y) / Math.SQRT2, y: (point.x + point.y) / Math.SQRT2});
  assert.equal(pickCanvasHandle(scene, {x: 6, y: 0}), null);
  assert.equal(pickCanvasHandle(scene, {x: 6, y: 0}, {project}).action, 'move');
  assert.equal(pickCanvasHandle(scene, {x: 4.9, y: 4.9}).action, 'move');
  assert.equal(pickCanvasHandle(scene, {x: 4.9, y: 4.9}, {project}), null);
});

test('descriptors omit attached origins and retain joined endpoints when unselected handles are hidden', () => {
  const parent = object(1, 0, { x: 0, y: 0 }, { x: 100, y: 0 });
  const child = object(2, 1, { x: 100, y: 0 }, { x: 130, y: 20 }, { join: { target_object_slot: 0, target_handle_id: 7 } });
  const other = object(3, 2, { x: 200, y: 0 }, { x: 230, y: 0 });
  const scene = geometry([parent, child, other]);
  const handles = getPivotHandles(scene, { showUnselected: false });
  assert.deepEqual(handles.filter(h => h.kind === 'origin').map(h => h.uid), [1, 3]);
  assert.deepEqual(handles.filter(h => h.kind === 'segment').map(h => h.uid), [1, 2]);
  assert.equal(handles.find(h => h.uid === 1 && h.joint === 0).color, '#d3d3d3');
  assert.equal(getPivotHandles(scene, { selectedUid: 1 }).find(h => h.uid === 1 && h.joint === 0).color, '#ffffff');
});

test('native autosizing uses posed incident lengths and preserves both zoom clamps', () => {
  const g = object(1, 0, { x: 0, y: 0 }, { x: 20, y: 0 });
  assert.equal(getPivotHandleRadius(g, 7), 5);
  assert.equal(getPivotHandleRadius(g, 7, { viewScale: .25 }), 2);
  assert.equal(getPivotHandleRadius(g, 7, { viewScale: .5 }), 2.5);
  assert.equal(getPivotHandleRadius(g, 7, { viewScale: 2 }), 5);
  const small = object(2, 0, g.root, { x: 8, y: 0 });
  small.segments[0].length = 8;
  assert.equal(getPivotHandleRadius(small, 7), 2.8);
  small.obj.scale = 2;
  const scaled = { ...small, segments: [{ ...small.segments[0], length: 16 }] };
  assert.equal(getPivotHandleRadius(scaled, 7), 5);
});

test('incoming radius candidate is omitted when its parent is static; outgoing lengths still count', () => {
  const g = object(1, 0, { x: 0, y: 0 }, { x: 20, y: 0 }, { static: true });
  g.segments.push({ index: 1, static: false, length: 2, seg: { segment_id: 8, parent_id: 7, thickness: 8 } });
  assert.equal(getPivotHandleRadius(g, 7), 2); // outgoing two-unit segment
  assert.equal(getPivotHandleRadius(g, 8), 5); // incoming excluded by its static parent
  const wide = object(2, 0, g.root, { x: 2, y: 0 });
  wide.segments[0].length = 2; wide.segments[0].seg.thickness = 8;
  assert.equal(getPivotHandleRadius(wide, 7), 2);
  assert.equal(getPivotHandleRadius(wide, 7, { autoSize: false }), 5);
});

test('shared definition topology resolves posed lengths only for exposed handles',()=>{
  let reads=0;
  const definitions=Array.from({length:30000},(_,index)=>({segment_id:index+1,parent_id:index,length:20,thickness:2,z_order:index+1}));
  const fig={segments:definitions},build=uid=>({fig,slot:uid,obj:{unique_id:uid,scale:1},root:{x:0,y:0},segments:definitions.map((seg,index)=>({
    index,seg,static:index!==0,end:{x:20*(index+1),y:0},get length(){reads++;return 20;}}))});
  const first=build(1);assert.equal(getPivotHandles(geometry([first])).length,2);assert.equal(reads,3);
  reads=0;const next=build(2);assert.equal(getPivotHandles(geometry([next])).length,2);assert.equal(reads,3);
});

test('explicit definition invalidation refreshes in-place static flags, order and adjacency',()=>{
  const g=object(1,0,{x:0,y:0},{x:20,y:0});g.fig={segments:g.segments.map(s=>s.seg)};
  assert.equal(getPivotHandles(geometry([g])).length,2);
  g.segments[0].static=true;invalidatePivotHandleTopology(g.fig);
  assert.equal(getPivotHandles(geometry([g])).length,1);
  g.segments[0].static=false;g.segments[0].length=2;invalidatePivotHandleTopology(g.fig);
  assert.equal(getPivotHandleRadius(g,7),2);
});

test('a picked attached parent joint changes its branch, while its own origin stays fixed', () => {
  const report = createDemo(); report.keyframes.length = 1;
  const parent = report.keyframes[0].objects[0], child = report.keyframes[0].objects[1];
  child.join = { target_object_slot: 0, target_unique_id: parent.unique_id, target_handle_id: 1 };
  const editor = ownedEditorFor({ demo: false }, report);
  const before = editor.geometry, attachment = before.objects.get(1).root;
  const hit = pickCanvasHandle(before, attachment, { radius: 2, selectedUid: child.unique_id });
  assert.equal(hit.g.obj.unique_id, parent.unique_id); assert.equal(hit.action, 'pose');
  const origin = { ...before.objects.get(0).root }, angles = child.angles.slice();
  editor.select(hit.g.obj.unique_id, hit.joint); editor.rotateJoint(.2);
  assert.deepEqual(editor.geometry.objects.get(0).root, origin);
  const moved = editor.frame.objects[1];
  moved.angles.forEach((angle, index) => assert.ok(Math.abs(angle - angles[index] - .2) < 1e-8));
});

test('Pivot handle role colors retain separate orange and unselected origin colors', () => {
  assert.equal(pivotHandleColor(), '#0000ff');
  assert.equal(pivotHandleColor({ selected: true }), '#ff0000');
  assert.equal(pivotHandleColor({ selected: true, origin: true }), '#ff8800');
  assert.equal(pivotHandleColor({ origin: true }), '#0080ff');
  assert.equal(pivotHandleColor({ selected: true, origin: true, joined: true }), '#ffffff');
  assert.equal(pivotHandleColor({ joined: true }), '#d3d3d3');
  assert.equal(pivotHandleColor({ static: true, selected: true, active: true }), '#b04040');
  assert.equal(pivotHandleColor({ static: true }), '#808080');
});

test('indexed picking preserves native order, ties, zoom, rotation and strict hit boundaries',()=>{
  const handles=Array.from({length:2000},(_,i)=>({uid:i,point:{x:(i%100)*20-1000,y:Math.floor(i/100)*20-100},radius:5,screenRadius:5}));
  handles.push({...handles[750],uid:2000});
  for(const scale of [.01,.5,2,12])for(const angle of [0,.3])for(const nearest of [false,true]){
    let projections=0;const project=p=>{projections++;return {x:scale*(p.x*Math.cos(angle)-p.y*Math.sin(angle))+81,y:scale*(p.x*Math.sin(angle)+p.y*Math.cos(angle))-23};};
    for(const point of [handles[750].point,{x:31,y:99},{x:-995,y:-100},{x:9000,y:1000}]){
      const options={handles,project,nearest,minRadius:8},full=pickCanvasHandle(null,point,options);
      projections=0;const indexed=pickCanvasHandle(null,point,{...options,projectionScale:scale});
      assert.deepEqual(indexed,full);
      if(scale>=.5)assert.ok(projections<50,'Only nearby handles should be projected.');
    }
  }
  assert.equal(pickCanvasHandle(null,handles[750].point,{handles,nearest:true,spatial:true}).uid,2000);
});

test('origin marquee uses evaluated attachment points and skips artwork bounds', () => {
  const rect = {left: 40, right: 60, top: 40, bottom: 60}, project = p => ({x: p.x * 2 + 10, y: p.y * 2 + 10});
  const g = {root: {x: 20, y: 20}, obj: {root_x: -999, root_y: -999, join: {target_object_slot: 0}}};
  const boundsOf = () => {throw Error('Origin selection must not measure artwork');};
  assert.equal(figureIntersectsMarquee(g, rect, {mode: 'origins', project, boundsOf}), true);
  assert.equal(figureIntersectsMarquee({...g, root: {x: 100, y: 20}}, rect, {mode: 'origins', project, boundsOf}), false);
  assert.equal(figureIntersectsMarquee({...g, root: {x: 15, y: 25}}, rect, {mode: 'origins', project, boundsOf}), true);
});

test('bounds marquee retains overlap behavior through a rotated viewport', () => {
  const g = {root: {x: 0, y: 0}}, boundsOf = () => ({minX: 0, maxX: 100, minY: 0, maxY: 50});
  const project = p => ({x: -p.y + 200, y: p.x + 10});
  const rect = {left: 155, right: 165, top: 80, bottom: 90};
  assert.equal(figureIntersectsMarquee(g, rect, {project, boundsOf}), true);
  assert.equal(figureIntersectsMarquee(g, rect, {mode: 'origins', project, boundsOf}), false);
  assert.equal(figureIntersectsMarquee(g, {...rect, left: 201, right: 220}, {project, boundsOf}), false);
});

test('Alt handle preference resolves overlapping attached figures without changing ordinary picking', () => {
  const a = object(1, 0, {x:0,y:0}, {x:20,y:0}, {join: {target_object_slot: 1}});
  const b = object(2, 1, {x:100,y:0}, {x:20,y:0}), scene = geometry([a,b]);
  const handles = getPivotHandles(scene), options = {handles, nearest:true, minRadius:8};
  assert.equal(pickCanvasHandle(scene, {x:20,y:0}, options).uid, 2);
  assert.equal(pickCanvasHandle(scene, {x:20,y:0}, {...options, preferredUid:1}).uid, 1);
  assert.equal(pickCanvasHandle(scene, {x:100,y:0}, {...options, preferredUid:1}).uid, 2);
  assert.equal(pickCanvasHandle(scene, {x:40,y:0}, {...options, preferredUid:1}), null);
});
