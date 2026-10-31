import {segmentBranchIndices} from './pivot/structure.mjs';
import {ConstructionIndex} from './builder-construction.mjs';
/** One bounded raster per placement. Pointer moves only translate the bitmap. */
export function duplicatePreview(geometry,index,{branch=false,flip=false,scale=1}={}) {
  const selected=geometry.segments[index];if(!selected)return null;
  const indices=branch?segmentBranchIndices(geometry.fig.segments,selected.seg.segment_id):[index];
  const segments=indices.map(i=>geometry.segments[i]).filter(Boolean),anchor=selected.start;
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for(const s of segments){const pad=Math.max(3,s.thickness/2)+4;
    const points=s.seg.segment_type==='circle'?[{x:Math.min(s.start.x,s.end.x)-Math.abs(s.length)/2,y:Math.min(s.start.y,s.end.y)-Math.abs(s.length)/2},{x:Math.max(s.start.x,s.end.x)+Math.abs(s.length)/2,y:Math.max(s.start.y,s.end.y)+Math.abs(s.length)/2}]:s.points;
    for(const p of points){left=Math.min(left,p.x-pad);right=Math.max(right,p.x+pad);top=Math.min(top,p.y-pad);bottom=Math.max(bottom,p.y+pad);}}
  if(!Number.isFinite(left))return null;
  const width=Math.max(1,right-left),height=Math.max(1,bottom-top),density=Math.min(Math.max(.05,scale*devicePixelRatio),2048/width,2048/height);
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(width*density);canvas.height=Math.ceil(height*density);
  const ctx=canvas.getContext('2d');ctx.scale(density,density);ctx.translate(-left,-top);ctx.lineCap='round';ctx.lineJoin='round';
  for(const outline of [true,false])for(const s of segments){ctx.beginPath();
    if(s.seg.segment_type==='circle')ctx.arc((s.start.x+s.end.x)/2,(s.start.y+s.end.y)/2,Math.abs(s.length)/2,0,Math.PI*2);
    else s.points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));
    ctx.lineWidth=Math.max(2/density,s.thickness)+(outline?4/density:0);ctx.strokeStyle=outline?'#fff':'#087fee';ctx.stroke();
    if(s.seg.segment_kind==='circleFill'){ctx.fillStyle=outline?'#fff':'#087fee';ctx.fill();}
  }
  const ids=new Set(segments.map(s=>s.seg.segment_id));
  if(branch) for(const polygon of geometry.polys??[]) {
    if(!polygon.poly.segment_ids.every(id=>ids.has(id)||id===selected.seg.parent_id)||!polygon.poly.segment_ids.some(id=>ids.has(id)))continue;
    ctx.beginPath();polygon.points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.fillStyle='#087fee';ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=2/density;ctx.stroke();
  }
  return {canvas,width,height,x:left-anchor.x,y:top-anchor.y,flip,count:segments.length,
    anchor,index:new ConstructionIndex(geometry),uid:geometry.obj.unique_id};
}
export function drawDuplicatePreview(ctx,preview,point,scale) {
  if(!preview)return;ctx.save();ctx.translate(point.x,point.y);ctx.scale(preview.flip?-scale:scale,scale);ctx.globalAlpha=.72;
  ctx.drawImage(preview.canvas,preview.x,preview.y,preview.width,preview.height);ctx.restore();
}
