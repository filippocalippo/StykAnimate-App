/** Geometry-keyed face discovery. No document mutation and no raster flood buffer. */
const cache = new WeakMap();
function pointInFill(points, point) {
  let inside = false;
  for (let i=0,j=points.length-1;i<points.length;j=i++) {
    const a=points[i],b=points[j];
    if ((a.y>point.y)!==(b.y>point.y) && point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x) inside=!inside;
  }
  return inside;
}
export function pickFigureFill(geometry, point) {
  let best=null;
  for (const polygon of geometry?.polys??[]) if (!polygon.culled && polygon.alpha>0 && pointInFill(polygon.points,point) && (!best || polygon.z>=best.z)) best=polygon;
  return best;
}
export function enclosedRegions(geometry) {
  if (!geometry) return [];
  if (cache.has(geometry)) return cache.get(geometry);
  const vertices=[],cells=new Map(),edges=[],epsilon=.001;
  function vertex(point) {
    const x=Math.round(point.x/epsilon),y=Math.round(point.y/epsilon);
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) {
      const v=cells.get(`${x+dx}:${y+dy}`);
      if(v&&Math.hypot(v.point.x-point.x,v.point.y-point.y)<=epsilon)return v;
    }
    const v={point,out:[]};vertices.push(v);cells.set(`${x}:${y}`,v);return v;
  }
  for(const segment of geometry.segments) {
    if(segment.seg.visible===false || ![0,6].includes(segment.seg.primitive_code??0))continue;
    const from=vertex(segment.start),to=vertex(segment.end);if(from===to)continue;
    const points=segment.points??[segment.start,segment.end];
    const a={from,to,startId:segment.seg.parent_id,endId:segment.seg.segment_id,points};
    const b={from:to,to:from,startId:a.endId,endId:a.startId,points:points.slice().reverse()};a.twin=b;b.twin=a;
    from.out.push(a);to.out.push(b);edges.push(a,b);
  }
  // Remove dangling strokes: they do not bound a fillable area.
  const leaves=vertices.filter(v=>v.out.length<2);
  for(let i=0;i<leaves.length;i++)for(const edge of leaves[i].out)if(!edge.removed){edge.removed=edge.twin.removed=true;const v=edge.to;v.out=v.out.filter(e=>!e.removed);if(v.out.length===1)leaves.push(v);}
  for(const v of vertices){v.out=v.out.filter(e=>!e.removed);v.out.sort((a,b)=>angle(a)-angle(b));v.out.forEach((e,i)=>{e.order=i;});}
  for(const edge of edges)if(!edge.removed){const out=edge.to.out;edge.next=out[(edge.twin.order+out.length-1)%out.length];}
  const visited=new Set(),regions=[];
  for(const start of edges){
    if(start.removed||visited.has(start))continue;
    const ids=[],points=[];let edge=start;
    while(edge&&!visited.has(edge)){visited.add(edge);for(const id of [edge.startId,edge.endId])if(ids.at(-1)!==id)ids.push(id);points.push(...edge.points.slice(0,-1));edge=edge.next;}
    if(edge!==start)continue;if(ids[0]===ids.at(-1))ids.pop();
    if(ids.length<3||new Set(ids).size!==ids.length)continue;
    let area=0;for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];area+=a.x*b.y-b.x*a.y;}
    if(area<=epsilon)continue;
    regions.push({ids,points,area:area/2});
  }
  regions.sort((a,b)=>a.area-b.area);cache.set(geometry,regions);return regions;
}
function angle(edge){const p=edge.points[0],q=edge.points[1]??edge.to.point;return Math.atan2(q.y-p.y,q.x-p.x);}
export function bucketRegion(geometry,point) {
  return enclosedRegions(geometry).find(region=>pointInFill(region.points,point))??null;
}
export function drawFillHighlight(ctx,points,project,{preview=false}={}) {
  if(!points?.length)return;
  ctx.save();ctx.beginPath();points.forEach((point,i)=>{const p=project(point);if(i)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y);});ctx.closePath();
  ctx.fillStyle=preview?'rgba(13,153,255,.2)':'rgba(13,153,255,.1)';ctx.fill();
  ctx.strokeStyle='#0d99ff';ctx.lineWidth=2;ctx.setLineDash(preview?[5,4]:[]);ctx.stroke();ctx.restore();
}
