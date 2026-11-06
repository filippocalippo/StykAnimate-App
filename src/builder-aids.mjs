import { cameraMatrix } from './renderer-geometry.mjs';
import {segmentBranchIndices} from './pivot/structure.mjs';

const BUILDER_HIGHLIGHT_COLORS = Object.freeze({dynamic:'#0000ff',static:'#4444cc',path:'#0000ff'});
export function isBuilderContext(tool) { return ['rig','line','chain','circle','polygon'].includes(tool); }
/** `builderActive` keeps the construction background for every tool while a
 * bounded builder session is open; outside a session it stays tool-scoped. */
export function builderBackgroundColor(settings,{tool,playing=false,previewing=false,builderActive=false}={}) {
  if(!(isBuilderContext(tool)||builderActive)||playing||previewing||!settings?.useBuilderCanvasColor)return undefined;
  const color=settings.builderCanvasColor;
  if(typeof color!=='string'||!/^#[0-9a-f]{6}$/i.test(color))return undefined;
  return (0xff000000|parseInt(color.slice(1),16))>>>0;
}
export function builderShowsStaticHandles(settings,{tool,handleEditHeld=false,connecting=false,builderActive=false}={}) {
  if(handleEditHeld||connecting||['line','chain','circle','polygon','attach'].includes(tool))return true;
  return (tool==='rig'||builderActive)&&settings?.builderShowStaticHandles!==false;
}

const indices=new WeakMap();
function byId(g) {
  let cached=indices.get(g);
  if(!cached){cached=new Map(g.segments.map(s=>[Number(s.seg.segment_id),s]));indices.set(g,cached);}
  return cached;
}
/** Native ancestry uses straight pivot connections, including bent segments. */
export function builderHighlightPath(g,jointIndex) {
  const selected=g?.segments?.[jointIndex];if(!selected)return [];
  const points=[selected.start],seen=new Set(),map=byId(g);
  let parent=Number(selected.seg.parent_id);
  while(parent&&!seen.has(parent)){
    seen.add(parent);const ancestor=map.get(parent);if(!ancestor)break;
    points.push(ancestor.start);parent=Number(ancestor.seg.parent_id);
  }
  return points;
}
/** Screen-sized construction guides only. Artwork belongs to the scene painter:
 * repainting selected silhouettes here bypasses every native occlusion boundary. */
export function drawBuilderHighlight(ctx,geometry,{uid,jointIndex,branch=false,report,frame,view,dragTranslations,cameraEnabled=true}={}) {
  let g;
  for(const candidate of geometry?.objects?.values?.()||[])if(candidate.obj.unique_id===uid){g=candidate;break;}
  const selected=g?.segments?.[jointIndex];if(!selected)return false;
  const matrix=cameraMatrix({report,frame,view,cameraEnabled}),scale=Math.hypot(matrix[0],matrix[1]);
  if(!(scale>0))return false;
  const width=1.5/scale;
  ctx.save();ctx.transform(...matrix);
  const delta=dragTranslations?.get(uid);if(delta)ctx.translate(delta.x,delta.y);
  ctx.globalAlpha=1;ctx.lineWidth=width;ctx.lineCap='butt';ctx.lineJoin='miter';ctx.setLineDash([]);
  const highlighted = branch ? segmentBranchIndices(g.fig.segments, selected.seg.segment_id).map(i => g.segments[i]) : [selected];
  for (const segment of highlighted) {
    // Curved strokes follow their evaluated centerline. Circles, text and
    // images expose their pivot connection without repainting their contents.
    const points=segment.seg.segment_type==='line' && segment.points?.length>1
      ? segment.points : [segment.start,segment.end];
    ctx.strokeStyle=segment.static?BUILDER_HIGHLIGHT_COLORS.static:BUILDER_HIGHLIGHT_COLORS.dynamic;
    ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);
    for(let i=1;i<points.length;i++)ctx.lineTo(points[i].x,points[i].y);
    ctx.stroke();
  }
  const path=branch ? [] : builderHighlightPath(g,jointIndex);
  if(path.length>1){
    ctx.lineWidth=width;ctx.lineCap='butt';ctx.lineJoin='miter';ctx.strokeStyle=BUILDER_HIGHLIGHT_COLORS.path;
    ctx.beginPath();ctx.moveTo(path[0].x,path[0].y);for(let i=1;i<path.length;i++)ctx.lineTo(path[i].x,path[i].y);ctx.stroke();
    ctx.strokeStyle='#ffffff';ctx.setLineDash([width,width]);ctx.stroke();
  }
  ctx.restore();return true;
}
