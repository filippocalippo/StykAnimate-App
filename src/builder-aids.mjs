import { drawGeometry } from './pivot/geometry.mjs';
import { cameraMatrix } from './renderer-geometry.mjs';
import {segmentBranchIndices} from './editor-builder.mjs';

export const BUILDER_HIGHLIGHT_COLORS = Object.freeze({dynamic:'#0000ff',static:'#4444cc',path:'#0000ff'});
export function isBuilderContext(tool) { return ['rig','line','circle','polygon'].includes(tool); }
export function builderBackgroundColor(settings,{tool,playing=false,previewing=false}={}) {
  if(!isBuilderContext(tool)||playing||previewing||!settings?.useBuilderCanvasColor)return undefined;
  const color=settings.builderCanvasColor;
  if(typeof color!=='string'||!/^#[0-9a-f]{6}$/i.test(color))return undefined;
  return (0xff000000|parseInt(color.slice(1),16))>>>0;
}
export function builderShowsStaticHandles(settings,{tool,handleEditHeld=false,connecting=false}={}) {
  if(handleEditHeld||connecting||['line','circle','polygon','attach','handle-edit'].includes(tool))return true;
  return tool==='rig'&&settings?.builderShowStaticHandles!==false;
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
/** Builder-only paint: no document/geometry mutations, bitmap recoloring, or
 * exported-frame effects. Native reference: artifacts/native-static/builder-aids.md. */
export function drawBuilderHighlight(ctx,geometry,{uid,jointIndex,branch=false,report,frame,view,resources={},dragTranslations,cameraEnabled=true}={}) {
  let g;
  for(const candidate of geometry?.objects?.values?.()||[])if(candidate.obj.unique_id===uid){g=candidate;break;}
  const selected=g?.segments?.[jointIndex];if(!selected)return false;
  const matrix=cameraMatrix({report,frame,view,cameraEnabled}),scale=Math.hypot(matrix[0],matrix[1]);
  if(!(scale>0))return false;
  const width=1.5/scale,color=selected.static?BUILDER_HIGHLIGHT_COLORS.static:BUILDER_HIGHLIGHT_COLORS.dynamic;
  ctx.save();ctx.transform(...matrix);
  const delta=dragTranslations?.get(uid);if(delta)ctx.translate(delta.x,delta.y);
  ctx.globalAlpha=1;ctx.lineWidth=width;ctx.lineCap='butt';ctx.lineJoin='miter';ctx.setLineDash([]);
  const highlighted = branch ? segmentBranchIndices(g.fig.segments, selected.seg.segment_id).map(i => g.segments[i]) : [selected];
  for (const selected of highlighted) {
  if(selected.seg.segment_type==='image'){
    ctx.strokeStyle=color;ctx.beginPath();ctx.moveTo(selected.start.x,selected.start.y);ctx.lineTo(selected.end.x,selected.end.y);ctx.stroke();
  }else{
    const fig={...selected.fig,segment_decode:{...selected.fig?.segment_decode,global_style:undefined}};
    const shape={...selected,type:selected.seg.segment_type||'line',fig,seg:{...selected.seg,secondary:null},thickness:selected.thickness===0?width:selected.thickness,rgb:selected.static?[68,68,204]:[0,0,255],alpha:1,opacity:1};
    drawGeometry(ctx,{drawables:[shape]},resources);
  }
  }
  const path=branch ? [] : builderHighlightPath(g,jointIndex);
  if(path.length>1){
    ctx.lineWidth=width;ctx.lineCap='butt';ctx.lineJoin='miter';ctx.strokeStyle=BUILDER_HIGHLIGHT_COLORS.path;
    ctx.beginPath();ctx.moveTo(path[0].x,path[0].y);for(let i=1;i<path.length;i++)ctx.lineTo(path[i].x,path[i].y);ctx.stroke();
    ctx.strokeStyle='#ffffff';ctx.setLineDash([width,width]);ctx.stroke();
  }
  ctx.restore();return true;
}
