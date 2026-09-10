import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {buildGeometry, evaluatedFrame} from '../src/pivot/geometry.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';

const near = (a, b, tolerance = .001) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const point = (a, b) => {near(a.x, b.x); near(a.y, b.y);};
function rig(joined = true, {constructionPivot = false, ...options} = {}) {
  const document = emptyDocument(), baseFigure = document.figure_types[0], base = baseFigure.segments[0];
  const s = (id, parent, length, angle, fixed = false) => ({...base, segment_id:id, parent_id:parent, length, angle_rad:angle, is_static:fixed, aux_code:fixed ? 1 : 0});
  const groups = [
    [s(11,0,90,.8), s(12,11,20,.3,true)],
    [s(22,0,90,2), s(24,22,18,1.1,true)],
    [s(33,0,35,0), s(34,33,10,.2,true), s(35,0,25,1.5,true)],
    [s(41,0,16,1.1,true)],
  ];
  if (constructionPivot) {groups[1].push(s(23,22,.00027,-1.6,true)); groups[1][1].parent_id = 23;}
  if (!joined) {
    const all = groups.flat().map(segment => ({...segment, parent_id: segment.segment_id === 22 ? 11 : [33,35].includes(segment.segment_id) ? constructionPivot ? 23 : 22 : segment.segment_id === 41 ? 22 : segment.parent_id}));
    groups.splice(0, groups.length, all);
  }
  document.figure_types = groups.map((segments, i) => ({...structuredClone(baseFigure), figure_type_id:i + 1, segments, segment_count:segments.length}));
  document.figure_types[joined ? 2 : 0].polyfills = [{polyfill_id:1,segment_ids:[joined ? 0 : 22,35,34,33],color_rgb:[10,35,65],alpha_raw:0,z_order:0}];
  const objects = document.figure_types.map((f, i) => createObject(f, i + 1, 300,150));
  if (joined) for (const [slot, parent, handle] of [[1,0,11],[2,1,constructionPivot ? 23 : 22],[3,1,22]])
    objects[slot].join = {target_object_slot:parent,target_unique_id:parent+1,target_handle_id:handle};
  document.keyframes = [createFrame(objects,8)];
  const e = new Editor({demo:false, ...options}).load(document); e.select(joined ? 2 : 1, joined ? 0 : 2); return e;
}
function shapes(e) {return new Map([...e.geometry.objects.values()].flatMap(g => g.segments.map(s => [s.seg.segment_id,s])));}
function sameRig(a,b) {
  const left=shapes(a), right=shapes(b);
  for (const [id,s] of left) {const t=right.get(id); point(s.start,t.start); point(s.end,t.end); near(s.angle,t.angle); near(s.length,t.length);}
}

test('joined IK crosses figure boundaries and matches an equivalent single-figure rig', () => {
  for (const propertyChannels of [false,true]) {
    const joined=rig(true,{propertyChannels}), single=rig(false,{propertyChannels});
    assert.equal(joined.getIKSettings().maxLength,2);
    for (const e of [joined,single]) {e.setNodeIK({enabled:true}); e.poseJoint(365,265);}
    sameRig(joined,single);
    for (const e of [joined,single]) {e.select(1,-1); e.moveSelection(15,-10);}
    sameRig(joined,single); point(shapes(joined).get(22).end,{x:365,y:265});
  }
});

test('shin attachments follow the bone while polygon-connected foot branches follow the target', () => {
  for (const joined of [false,true]) {
    const e=rig(joined), initial=shapes(e);
    e.setNodeIK({enabled:true}); e.poseJoint(365,265);
    const posed=shapes(e);
    near(posed.get(33).angle,0); near(posed.get(34).angle,.2);
    const shinDelta = posed.get(22).angle-initial.get(22).angle;
    for (const id of [24,41]) near(posed.get(id).angle,initial.get(id).angle+shinDelta);
    near(posed.get(35).angle,initial.get(35).angle);
    const thighDelta = posed.get(11).angle-initial.get(11).angle;
    near(posed.get(12).angle,initial.get(12).angle+thighDelta);
    e.rotateIKTarget(.4); near(shapes(e).get(33).angle,.4); near(shapes(e).get(34).angle,.6);
    for (const id of [24,41]) near(shapes(e).get(id).angle,posed.get(id).angle);
    near(shapes(e).get(35).angle,posed.get(35).angle+.4);
  }
});

test('unpinned target drags preserve outgoing orientation and bake reversible poses', () => {
  for (const joined of [false,true]) for (const propertyChannels of [false,true]) {
    const e = rig(joined, {propertyChannels}); e.setNodeIK({enabled:true}); e.poseJoint(365,265);
    e.setNodeIK({pinned:false});
    const before = shapes(e), orientations = new Map([33,34,35].map(id => [id, before.get(id).angle]));
    e.beginDrag();
    for (let i = 0; i < 60; i++) {
      const a = .4 + i / 60, target = {x:300 + 130 * Math.cos(a), y:150 + 130 * Math.sin(a)};
      e.poseJoint(target.x,target.y);
      const live = shapes(e); point(live.get(22).end,target);
      for (const id of [24,41]) near(live.get(id).angle-live.get(22).angle,before.get(id).angle-before.get(22).angle);
      for (const [id, angle] of orientations) {
        const error = live.get(id).angle - angle;
        near(Math.atan2(Math.sin(error),Math.cos(error)),0);
      }
    }
    e.commitDrag();
    const posed = shapes(e); near(posed.get(33).angle,before.get(33).angle);
    e.undo(); for (const [id,s] of before) {assert.ok(Math.hypot(shapes(e).get(id).end.x-s.end.x,shapes(e).get(id).end.y-s.end.y)<.001, JSON.stringify({joined,propertyChannels,id,expected:s.end,actual:shapes(e).get(id).end}));}
    e.redo(); for (const [id,s] of posed) point(shapes(e).get(id).end,s.end);
    e.setNodeIK({pinned:true}); for (const [id,s] of posed) point(shapes(e).get(id).end,s.end);
    e.poseJoint(350,260);
    for (const id of [33,34]) near(shapes(e).get(id).angle,posed.get(id).angle);
  }
});

test('foot polygon vertices retain target-space positions while shin attachments retain bone-space positions', () => {
  for (const joined of [false,true]) for (const pinned of [false,true]) for (const propertyChannels of [false,true]) {
    const e=rig(joined,{propertyChannels}); e.setNodeIK({enabled:true,pinned});
    const sample=()=>{
      const current=shapes(e), parent=current.get(22);
      return [24,33,34,35,41].map(id=>{
        const angle=[24,41].includes(id)?parent.angle:e.getIKSettings().target.rotation, c=Math.cos(angle), s=Math.sin(angle);
        const end=current.get(id).end, x=end.x-parent.end.x, y=end.y-parent.end.y;
        return {x:x*c+y*s,y:-x*s+y*c};
      });
    };
    const original=sample(), angle=shapes(e).get(33).angle;
    e.beginDrag();
    for(let i=0;i<120;i++) {
      e.poseJoint(300+125*Math.cos(i/25),150+125*Math.sin(i/25));
      sample().forEach((value,j)=>point(value,original[j]));
    }
    near(shapes(e).get(33).angle,angle);
    e.commitDrag(); sample().forEach((value,j)=>point(value,original[j]));
    e._invalidate(); sample().forEach((value,j)=>point(value,original[j]));
  }
});

test('a polygon foot keeps every vertex distance with legacy partial follower tables', () => {
  for (const joined of [false,true]) {
    const e = rig(joined); e.setNodeIK({enabled:true});
    const c = e.object._stykIK[22];
    c.followers = joined ? {} : {33:0}; c.joinedFollowers = joined ? {3:{33:0}} : {};
    // Metadata from the rejected attachment heuristic must not split this foot.
    c.attachmentOffsets = {24:-.9,35:-.5}; c.joinedAttachmentOffsets = {3:{35:-.5},4:{41:-.9}};
    e._invalidate();
    const vertices = [22,33,34,35], points = () => vertices.map(id=>shapes(e).get(id).end);
    const distances = values => values.flatMap((a,i)=>values.slice(i+1).map(b=>Math.hypot(a.x-b.x,a.y-b.y)));
    const before = distances(points());
    e.beginDrag();
    for (let i=0;i<80;i++) {
      e.poseJoint(300+125*Math.cos(i/20),150+125*Math.sin(i/20));
      distances(points()).forEach((distance,j)=>near(distance,before[j]));
    }
    e.commitDrag(); e.rotateIKTarget(.7);
    distances(points()).forEach((distance,j)=>near(distance,before[j]));
  }
});

test('thickness and color edits preserve IK poses across cache rebuilds, history and reload', () => {
  for (const joined of [false,true]) for (const propertyChannels of [false,true]) for (const pinned of [false,true]) {
    const e = rig(joined,{propertyChannels}); e.setNodeIK({enabled:true}); e.poseJoint(365,265);
    if (!pinned) e.setNodeIK({pinned:false});
    const before = shapes(e), controllerState = editor => Object.fromEntries(editor.evaluatedFrame.objects.map(o => [o.unique_id,o._stykIK]));
    const controllers = structuredClone(controllerState(e));
    const check = editor => {
      for (const [id,s] of before) {point(shapes(editor).get(id).end,s.end);near(shapes(editor).get(id).angle,s.angle);}
      assert.deepEqual(controllerState(editor),controllers);
    };
    for (const patch of [{thickness:32},{color:'#ff3300'},{opacity:.5}]) {
      e.updateSegmentStyle(patch); check(e);
      e._invalidate(); check(e);
      check(new Editor({demo:false,propertyChannels}).load(e.serialize()));
      e.undo(); check(e); e.redo(); check(e);
    }
  }
});

test('end-group branches keep their shape through repeated target drags and root edits', () => {
  for(const joined of [false,true])for(const propertyChannels of [false,true]){
    const e=rig(joined,{propertyChannels});e.setNodeIK({enabled:true});
    const initial=shapes(e), relative=initial.get(24).angle-initial.get(22).angle;
    const check=()=>{const current=shapes(e);for(const id of [24,41])near(Math.atan2(Math.sin(current.get(id).angle-current.get(22).angle-relative),Math.cos(current.get(id).angle-current.get(22).angle-relative)),0);};
    for(let gesture=0;gesture<3;gesture++){
      e.beginDrag();for(let i=0;i<90;i++){e.poseJoint(300+120*Math.cos(i/30+gesture),150+120*Math.sin(i/30+gesture));check();}e.commitDrag();check();
      e.setNodeIK({pinned:false});check();e.setNodeIK({pinned:true});check();
    }
    e.select(1,-1);e.beginTranslationDrag();for(let i=0;i<40;i++){e.moveSelection(Math.sin(i/10)*15,-10,{fromStart:true});check();}e.commitDrag();check();
    e.rotateSelection(.3);check();
    const restored=new Editor({demo:false,propertyChannels}).load(e.serialize());
    const current=shapes(restored);near(current.get(24).angle-current.get(22).angle,relative);
  }
});

test('joined unpinning, disabling, stretch and unpinned posing bake every affected figure', () => {
  for (const patch of [{pinned:false},{enabled:false}]) {
    const joined=rig(), single=rig(false);
    for (const e of [joined,single]) {e.setNodeIK({enabled:true,allowStretch:true}); e.poseJoint(600,150); e.setNodeIK(patch);}
    sameRig(joined,single);
    if (patch.pinned === false) {
      for (const e of [joined,single]) {e.beginDrag(); e.poseJoint(700,150); e.poseJoint(360,250); e.commitDrag();}
      sameRig(joined,single);
    }
  }
});

test('each joined end-group branch remains editable through ordinary FK', () => {
  const e=rig(); e.setNodeIK({enabled:true}); e.poseJoint(365,265);
  e.select(3,0); e.rotateJoint(.3); near(shapes(e).get(33).angle,.3); near(shapes(e).get(34).angle,.5);
  const attachment = shapes(e).get(24).angle;
  e.select(2,1); e.rotateJoint(.2); near(shapes(e).get(24).angle,attachment+.2);
  e.select(1,-1); e.moveSelection(10,-10); near(shapes(e).get(33).angle,.3);
});

test('edited target orientation survives root and ancestor FK motion, history and reload', () => {
  for (const joined of [false,true]) for (const propertyChannels of [false,true]) {
    const e = rig(joined,{propertyChannels}); e.setNodeIK({enabled:true}); e.poseJoint(365,265);
    e.rotateIKTarget(.4);
    const foot = shapes(e), ids = [22,33,34,35];
    const check = editor => {for (const id of ids) point(shapes(editor).get(id).end,foot.get(id).end);};
    e.select(1,0); e.rotateJoint(.3); check(e);
    e.select(1,-1); e.moveSelection(12,-10); check(e); e.rotateSelection(.15); check(e);
    e.undo(); check(e); e.redo(); check(e);
    check(new Editor({demo:false,propertyChannels}).load(e.serialize()));
  }
});

test('foot articulation edits update only the edited branch and keep its new orientation planted', () => {
  for (const joined of [false,true]) for (const propertyChannels of [false,true]) {
    const e = rig(joined,{propertyChannels}); e.setNodeIK({enabled:true}); e.poseJoint(365,265); e.rotateIKTarget(.4);
    const before = shapes(e), saved = e.serialize();
    e.select(joined ? 3 : 1, joined ? 0 : 4);
    e.rotateJoint(.3); near(shapes(e).get(33).angle,.7); near(shapes(e).get(34).angle,.9);
    for (const id of [24,35,41]) point(shapes(e).get(id).end,before.get(id).end);
    e.undo();
    sameRig(e,new Editor({demo:false,propertyChannels}).load(saved));
    assert.deepEqual(e.evaluatedFrame.objects.map(o=>o._stykIK),new Editor({demo:false,propertyChannels}).load(saved).evaluatedFrame.objects.map(o=>o._stykIK));
    e.redo();
    const posed = shapes(e);
    e.select(1,-1); e.moveSelection(10,-10);
    for (const id of [22,33,34,35]) point(shapes(e).get(id).end,posed.get(id).end);
    sameRig(e,new Editor({demo:false,propertyChannels}).load(e.serialize()));
  }
});

test('bending a foot rotates its descendants without changing its target-space starting angle', () => {
  for (const joined of [false,true]) {
    const e = rig(joined); e.setNodeIK({enabled:true}); e.poseJoint(365,265); e.rotateIKTarget(.4);
    e.select(joined ? 3 : 1, joined ? 0 : 4); e.updateSegment({bend_rad:.3});
    near(shapes(e).get(33).angle,.4); near(shapes(e).get(34).angle,.9);
    const foot = shapes(e); e.select(1,-1); e.moveSelection(10,-10);
    for (const id of [22,33,34,35]) point(shapes(e).get(id).end,foot.get(id).end);
  }
});

test('unpinned root transforms carry the foot and re-pinning captures its current orientation', () => {
  for (const joined of [false,true]) for (const propertyChannels of [false,true]) {
    const e = rig(joined,{propertyChannels}), uid = joined ? 2 : 1, index = joined ? 0 : 2;
    e.setNodeIK({enabled:true}); e.rotateIKTarget(.4); e.setNodeIK({pinned:false});
    e.select(1,-1); e.rotateSelection(.3); near(shapes(e).get(33).angle,.7);
    const free = shapes(e); e.moveSelection(8,-6);
    for (const id of [22,24,33,34,35,41]) point(shapes(e).get(id).end,{x:free.get(id).end.x+8,y:free.get(id).end.y-6});
    e.select(uid,index); e.rotateIKTarget(.6); near(shapes(e).get(33).angle,.9);
    const rotated = shapes(e); e.setNodeIK({pinned:true});
    e.select(1,-1); e.moveSelection(10,-10);
    for (const id of [22,33,34,35]) point(shapes(e).get(id).end,rotated.get(id).end);
  }
});

test('pasting a joined rig remaps controller parenting to the pasted foot', () => {
  const e=rig(); e.setNodeIK({enabled:true}); e.rotateIKTarget(.4);
  e._selectIds([1,2,3,4]); e.copySelection(); e.pasteSelection();
  const copies=e.frame.objects.slice(4), shin=copies.find(o=>o.figure_type_id===2), foot=copies.find(o=>o.figure_type_id===3);
  assert.ok(Object.hasOwn(shin._stykIK[22].joinedFollowers,String(foot.unique_id)));
  assert.equal(Object.keys(shin._stykIK[22].joinedFollowers).length,1);
  e.select(shin.unique_id,0); e.poseJoint(380,280);
  near(e.geometry.objects.get(foot.object_slot).segments[0].angle,.4);
});

test('near-zero construction pivots keep shin artwork attached and the next foot bone planted', () => {
  for (const joined of [false,true]) for (const propertyChannels of [false,true]) for (const legacy of [false,true]) {
    const e = rig(joined,{constructionPivot:true,propertyChannels}); e.setNodeIK({enabled:true});
    if (legacy) {
      // Early controllers captured the static ankle pivot instead of the foot.
      const source = e.evaluatedFrame, frame = structuredClone(source);
      const object = frame.objects.find(o=>o._stykIK?.[22]);
      object._stykIK[22].followers = {23:-1.6,41:1.1}; delete object._stykIK[22].joinedFollowers;
      const document = e.serialize(); document.keyframes = [frame]; delete document._styk.layerSheet; delete document._styk.animation; delete document._styk.frameSources;
      e.load(document); e.select(joined ? 2 : 1,joined ? 0 : 2);
    }
    const initial = shapes(e), check = () => {
      const live = shapes(e);
      for (const id of [23,24,41]) near(live.get(id).angle-live.get(22).angle,initial.get(id).angle-initial.get(22).angle);
      for (const id of [33,34,35]) near(live.get(id).angle,initial.get(id).angle);
    };
    e.poseJoint(365,265); check();
    const planted = shapes(e); e.select(1,-1); e.moveSelection(10,-10); check();
    for (const id of [33,34,35]) point(shapes(e).get(id).end,planted.get(id).end);
    e.rotateSelection(.2); check();
    for (const id of [33,34,35]) point(shapes(e).get(id).end,planted.get(id).end);
    sameRig(e,new Editor({demo:false,propertyChannels}).load(e.serialize()));
  }
});

test('target rotation affects the same foot branches when pinned and unpinned', () => {
  for (const joined of [false,true]) for (const pinned of [false,true]) {
    const e=rig(joined,{constructionPivot:true}); e.setNodeIK({enabled:true,pinned}); e.poseJoint(365,265);
    const before=shapes(e); e.rotateIKTarget(.4);
    for(const id of [23,24,41]) point(shapes(e).get(id).end,before.get(id).end);
    for(const id of [33,34,35]) near(shapes(e).get(id).angle,before.get(id).angle+.4);
  }
});

test('overlapping chains across joins are rejected and isolated geometry stays retained', () => {
  const e=rig(); e.setNodeIK({enabled:true});
  e.select(1,0); assert.throws(()=>e.setNodeIK({enabled:true}),/share bones/);
  e.addFigure(); const unrelated=e.geometry.objects.get(e.selectedSlot);
  e.select(2,0); e.poseJoint(355,265);
  assert.equal(e.geometry.objects.get(unrelated.slot),unrelated);
});

test('splitting a joined ancestor preserves the IK chain base and child articulation', () => {
  const e=rig(); e.setNodeIK({enabled:true}); e.poseJoint(365,265); const before=e.serialize(), foot=shapes(e).get(33).end;
  e.select(1,0); e.splitSegment();
  assert.equal(e.frame.objects[1]._stykIK[22].chainLength,3);
  point(shapes(e).get(22).end,{x:365,y:265}); near(shapes(e).get(33).angle,0);
  e.undo(); assert.deepEqual(e.serialize(),before);
  e.select(3,0); e.splitSegment();
  const split=e.serialize(); e.undo(); assert.deepEqual(e.serialize(),before); e.redo(); assert.deepEqual(e.serialize(),split);
  const oldRoot=e.geometry.objects.get(2).segments.find(s=>s.seg.parent_id===0).angle;
  e.select(2,0); e.rotateIKTarget(.3);
  const root=e.geometry.objects.get(2).segments.find(s=>s.seg.parent_id===0); near(root.angle,oldRoot+.3);
});

test('joined IK undo, cancel and native/Pivot persistence retain all solved branches', () => {
  const e=rig(); e.setNodeIK({enabled:true}); const before=e.serialize();
  e.beginDrag(); e.poseJoint(355,265); e.commitDrag(); const after=e.serialize();
  e.undo(); assert.deepEqual(e.serialize(),before); e.redo(); assert.deepEqual(e.serialize(),after);
  e.beginDrag(); e.poseJoint(340,240); e.cancelDrag(); assert.deepEqual(e.serialize(),after);
  for (const report of [after,materializePivotDocument(after)]) sameRig(e,new Editor({demo:false}).load(report));
});

test('joined IK interpolation is identical to a monolithic rig and independent of slot order', () => {
  const joined=rig(), single=rig(false);
  for (const e of [joined,single]) {
    e.setNodeIK({enabled:true}); e.poseJoint(360,260); const a=structuredClone(e.frame); delete a._styk;
    e.select(1,-1); e.moveSelection(20,-10); const b=structuredClone(e.frame); delete b._styk;
    e.report.keyframes=[a,b]; e._invalidate({timing:true});
  }
  for (const t of [.7,.1,.9,.5]) {
    const a=buildGeometry(joined.report,evaluatedFrame(joined.report,0,t)), b=buildGeometry(single.report,evaluatedFrame(single.report,0,t));
    for (const g of a.objects.values()) for (const s of g.segments) point(s.end,b.objects.get(0).joints.get(s.seg.segment_id));
  }
  const report=joined.serialize();
  for (const frame of report.keyframes) {
    frame.objects.reverse(); const slots=new Map(frame.objects.map((o,slot)=>[o.unique_id,slot]));
    frame.objects.forEach((o,slot)=>{o.object_slot=slot;if(o.join)o.join.target_object_slot=slots.get(o.join.target_unique_id);});
    frame.object_draw_order=frame.objects.map((_,i)=>i);
  }
  const reordered=new Editor({demo:false}).load(report);
  sameRig(joined,reordered);
});
