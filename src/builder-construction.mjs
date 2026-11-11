import {messageError} from './localized-error.mjs';
import {localizedText} from './localization-bindings.mjs';
import {builderStrokeAppearance, setBuilderStroke} from './builder-appearance.mjs';
import {segmentBranchIndices} from './pivot/structure.mjs';
import {canvasFont} from './ui/font-loading.mjs';
/** Gesture-local spatial index. Construction never scans unrelated scene objects. */
export class ConstructionIndex {
  constructor(geometry, excluded = new Set()) {
    const points=[];this.lengths=[];
    for(const [id,p] of geometry?.joints ?? []) if(!excluded.has(id))points.push({...p,id,kind:'Joint'});
    for(const s of geometry?.segments ?? []) if(!excluded.has(s.seg.segment_id)) {
      const samples=s.points??[s.start,s.end],middle=(samples.length-1)/2,a=samples[Math.floor(middle)],b=samples[Math.ceil(middle)];
      points.push({x:(a.x+b.x)/2,y:(a.y+b.y)/2,kind:'Midpoint'});
      this.lengths.push(Math.hypot(s.end.x-s.start.x,s.end.y-s.start.y));
    }
    this.axes={x:points.slice().sort((a,b)=>a.x-b.x),y:points.slice().sort((a,b)=>a.y-b.y)};
    this.lengths.sort((a,b)=>a-b);
    const build=(items,depth=0)=>{if(!items.length)return null;const axis=depth%2?'y':'x';items.sort((a,b)=>a[axis]-b[axis]);const m=items.length>>1;return {p:items[m],axis,left:build(items.slice(0,m),depth+1),right:build(items.slice(m+1),depth+1)};};
    this.root=build(points);
  }
  nearest(p,radius,{jointsOnly=false}={}) {
    let best=null,distance=radius*radius;
    const visit=node=>{if(!node)return;const delta=p[node.axis]-node.p[node.axis];visit(delta<0?node.left:node.right);
      const d=(p.x-node.p.x)**2+(p.y-node.p.y)**2;
      if(d<=distance&&(!jointsOnly||node.p.kind==='Joint')){best=node.p;distance=d;}
      if(delta*delta<distance)visit(delta<0?node.right:node.left);
    };visit(this.root);return best;
  }
  snap(p,{radius=8,origin,disabled=false}={}) {
    if(disabled){this.latched=null;return {...p};}
    const joint=this.nearest(p,radius,{jointsOnly:true});
    const held=this.latched&&Math.hypot(p.x-this.latched.x,p.y-this.latched.y)<=radius*1.4?this.latched:null;
    const point=joint??held??this.nearest(p,radius);
    this.latched=point;
    if(point)return {...point};
    const result={...p};
    for(const axis of ['x','y']) {
      const values=this.axes[axis],i=lowerBound(values,p[axis],v=>v[axis]);
      const choices=[values[i],values[i-1],origin].filter(Boolean).sort((a,b)=>Math.abs(a[axis]-p[axis])-Math.abs(b[axis]-p[axis]));
      if(choices[0]&&Math.abs(choices[0][axis]-p[axis])<=radius){result[axis]=choices[0][axis];result.kind='Align';}
    }
    if(!result.kind&&origin) {
      const length=Math.hypot(p.x-origin.x,p.y-origin.y),i=lowerBound(this.lengths,length,v=>v);
      const target=[this.lengths[i],this.lengths[i-1]].filter(Number.isFinite).sort((a,b)=>Math.abs(a-length)-Math.abs(b-length))[0];
      if(length>radius&&Math.abs(target-length)<=radius) {const ratio=target/length;result.x=origin.x+(p.x-origin.x)*ratio;result.y=origin.y+(p.y-origin.y)*ratio;result.kind='Length';}
    }
    return result;
  }
}
function lowerBound(values,value,key){let lo=0,hi=values.length;while(lo<hi){const m=(lo+hi)>>1;if(key(values[m])<value)lo=m+1;else hi=m;}return lo;}
export function strokeSegments(points,scale=1) {
  if(!Number.isFinite(scale)||Math.abs(scale)<1e-8)throw messageError(new Error(''), "errors.builderConstruction.setANonzeroFigureScaleBeforeDrawing", {});
  return points.slice(1).map((p,i)=>({type:'line',length:Math.hypot(p.x-points[i].x,p.y-points[i].y)/Math.abs(scale),angle:Math.atan2(p.y-points[i].y,p.x-points[i].x)-(scale<0?Math.PI:0),start:points[0]}));
}
/** Owns transient pen paths and gesture-local snapping, never document topology. */
export function createConstruction({editor, state, active, render, project,
  onError = console.error, commitSettings = () => {}}) {
  let draft = null, cache = null, geometry = null, feedback = null;
  let rigIndex = null, rigOrigin = null;
  const controls = document.getElementById('chain-controls');
  const finish = document.getElementById('chain-finish');
  const snapButton = document.getElementById('builder-snap');
  let enabled = state.settings.builderSmartSnapping !== false;
  snapButton?.setAttribute('aria-pressed', String(enabled));
  const currentGeometry = () => editor.geometry.objects.get(editor.object?.object_slot);

  function index() {
    const next = currentGeometry();
    if (!cache || next !== geometry) {
      geometry = next;
      cache = new ConstructionIndex(next);
    }
    return cache;
  }
  function sync() {
    controls.hidden = !draft;
    finish.disabled = !draft || draft.points.length < 2;
    localizedText(document.getElementById('chain-count'), "builderConstruction.links", {value: Math.max(0, (draft?.points.length ?? 1) - 1)});
  }
  function cancel() {
    draft = null; feedback = null; geometry = null; cache = null;
    rigIndex = null; rigOrigin = null;
    sync(); render();
  }
  function commit() {
    if (!draft || draft.points.length < 2) return;
    try {
      const specs = strokeSegments(draft.points, editor.object?.scale ?? 1);
      specs[0].parentId = draft.parentId;
      editor.addSegments(specs);
      cancel();
    } catch (error) { onError(error); }
  }
  function snap(point, event = {}, origin) {
    feedback = index().snap(point, {radius: 8 / state.view.scale, origin, disabled: !enabled || event.altKey});
    return feedback;
  }
  function start(point) {
    const selectedId=editor.figure?.segments[editor.selectedJoint]?.segment_id??0,selected=currentGeometry()?.joints.get(selectedId),radius=10/state.view.scale;
    const hit=selected&&Math.hypot(point.x-selected.x,point.y-selected.y)<=radius?{...selected,id:selectedId}:index().nearest(point,radius,{jointsOnly:true});
    if (hit && editor.figure)
      editor.select(editor.selectedUid, editor.figure.segments.findIndex(segment => segment.segment_id === hit.id));
    const parentId = editor.figure?.segments[editor.selectedJoint]?.segment_id ?? 0;
    return {point: currentGeometry()?.joints.get(parentId) ?? point, parentId};
  }
  // Paths rebuild after clicks, Backspace or zoom, never for each pointer move.
  function rebuildPaths() {
    if (!draft) return;
    draft.path = new Path2D(); draft.markers = new Path2D();
    const radius = 4 / state.view.scale;
    draft.points.forEach((point, i) => {
      if (i) draft.path.lineTo(point.x, point.y);
      else draft.path.moveTo(point.x, point.y);
      draft.markers.moveTo(point.x + radius, point.y);
      draft.markers.arc(point.x, point.y, radius, 0, Math.PI * 2);
    });
    draft.pathScale = state.view.scale;
  }
  /** Smart snapping on or off: Structure's Snap and the rail's toggle (toggle-builder-snap) show it. */
  function toggleSnap() {
    enabled = !enabled;
    commitSettings({builderSmartSnapping: enabled});
    for (const button of document.querySelectorAll('#builder-snap, [data-action="toggle-builder-snap"]')) button.setAttribute('aria-pressed', String(enabled));
    feedback = null; render();
  }
  snapButton?.addEventListener('click', toggleSnap);
  finish.addEventListener('click', commit);
  document.getElementById('chain-cancel').addEventListener('click', cancel);
  document.addEventListener('keydown', event => {
    if (!draft || event.target.closest?.('input,textarea,select,[contenteditable=true],dialog,:popover-open')) return;
    if (!['Enter', 'Escape', 'Backspace'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'Enter') commit();
    else if (event.key === 'Escape') cancel();
    else {
      if (draft.points.length > 1) draft.points.pop();
      else cancel();
      rebuildPaths(); sync(); render();
    }
  }, true);
  editor.addEventListener('change', event => {
    if (draft && ['edit', 'history', 'document', 'frame', 'frame-draft', 'seek'].includes(event.detail?.kind)) cancel();
  });
  return {
    cancel, commit, snap, start, toggleSnap,
    get snapping() { return enabled; },
    get active() { return Boolean(draft); },
    beginRig() {
      const geom = currentGeometry(), segment = editor.figure?.segments[editor.selectedJoint];
      if (!geom || !segment) return;
      rigOrigin = geom.segments[editor.selectedJoint].start;
      const excluded = new Set(segmentBranchIndices(editor.figure.segments, segment.segment_id)
        .map(i => editor.figure.segments[i].segment_id));
      rigIndex = new ConstructionIndex(geom, excluded);
    },
    rigSnap(point, event) {
      feedback = rigIndex?.snap(point, {origin: rigOrigin, radius: 8 / state.view.scale,
        disabled: !enabled || event.altKey}) ?? point;
      return feedback;
    },
    click(point, event) {
      if (!active()) return;
      if (!draft) {
        const initial = start(point);
        draft = {points: [initial.point], parentId: initial.parentId, current: initial.point, appearance:builderStrokeAppearance(editor, initial.parentId)};
      } else {
        if ((editor.figure?.segments.length ?? 0) + draft.points.length > 30000) {
          onError(messageError(new Error(''), "errors.builderConstruction.figureSegmentCapacityReachedFinishOrShortenThe", {}));
          return;
        }
        const next = snap(point, event, draft.points.at(-1));
        if (Math.hypot(next.x - draft.points.at(-1).x, next.y - draft.points.at(-1).y) > 1 / state.view.scale)
          draft.points.push(next);
        draft.current = next;
      }
      rebuildPaths(); sync(); render();
    },
    move(point, event) {
      if (!draft) return;
      draft.current = snap(point, event, draft.points.at(-1));
      render();
    },
    draw(ctx) {
      if (!active()) return;
      if (draft) {
        if (draft.pathScale !== state.view.scale) rebuildPaths();
        const origin = project({x: 0, y: 0}), x = project({x: 1, y: 0}), y = project({x: 0, y: 1});
        ctx.save();
        ctx.transform(x.x - origin.x, x.y - origin.y, y.x - origin.x, y.y - origin.y, origin.x, origin.y);
        setBuilderStroke(ctx, draft.appearance);
        if (!draft.appearance.width) ctx.lineWidth = 1 / state.view.scale;
        ctx.stroke(draft.path);
        ctx.lineWidth = 1 / state.view.scale; ctx.strokeStyle = '#0d99ff'; ctx.setLineDash([]);
        ctx.fillStyle = '#fff'; ctx.fill(draft.markers); ctx.stroke(draft.markers);
        ctx.restore();
        const from = project(draft.points.at(-1)), to = project(draft.current);
        ctx.save(); setBuilderStroke(ctx, draft.appearance, state.view.scale);
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); ctx.restore();
      }
      if (feedback?.kind) {
        const point = project(feedback);
        ctx.save(); ctx.strokeStyle = '#ee8a23'; ctx.lineWidth = 2;
        ctx.strokeRect(point.x - 5, point.y - 5, 10, 10);
        ctx.font = canvasFont('11px'); ctx.lineWidth = 4; ctx.strokeStyle = '#fff';
        ctx.strokeText(feedback.kind, point.x + 10, point.y - 10);
        ctx.fillStyle = '#91500e'; ctx.fillText(feedback.kind, point.x + 10, point.y - 10); ctx.restore();
      }
    },
  };
}
