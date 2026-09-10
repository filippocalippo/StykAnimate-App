/** Independent geometry renderer, based on inspected format semantics.
 * SVG rasterization / filters are not the original application's GPU renderer.
 */
import {segmentCurve,toSegmentWorld,clamp,signedDegrees} from './geometry.mjs';
export const escapeXml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const finite=(v,d=0)=>Number.isFinite(v)?v:d;
const color=c=>(c?.hex??'#222222ff');
const f=n=>Math.round(finite(n)*10000)/10000;
const xy=p=>`${f(p.x)},${f(p.y)}`;
/** Parent-first FK; static means an authored, non-draggable limb, NOT a world pin. */
export function layoutFigure(figure,{cachedXY=false}={}) {
 const poses=new Map(),globalScale=finite(figure.scale,1),root=figure.nodes[0],nodes=new Map(figure.nodes.map(n=>[n.id,n])),targets=new Map((figure.connections??[]).map(c=>[c.sourceId,c.targetId])),pending=new Set();
 // Connector anchors depend on two joints, which need not precede them in the
 // serialized tree. Resolve that dependency graph before placing descendants.
 const order=[],done=new Set();
 for(const first of figure.nodes){const stack=[{node:first,leave:false}];while(stack.length){const item=stack.pop(),node=item.node;if(item.leave){pending.delete(node.id);done.add(node.id);order.push(node);continue;}if(done.has(node.id))continue;if(pending.has(node.id))throw new Error(`Cyclic connector/parent dependency at node ${node.id}.`);pending.add(node.id);stack.push({node,leave:true});const deps=[node.parentId,...(node.connector&&targets.has(node.id)?[targets.get(node.id)]:[])];for(const id of deps){if(id==null)continue;const dependency=nodes.get(id);if(!dependency)throw new Error(`Missing joint ${id} required by node ${node.id}.`);if(!done.has(id))stack.push({node:dependency,leave:false});}}}
 for(const node of order){
  const parent=poses.get(node.parentId),start=parent?.end??{x:0,y:0};
  let local=finite(node.local_angle);if(node.kind==='root'&&!figure.posed&&(figure.build??0)<36)local=0;
  let angle=(parent?.angle??0)+local;
  if(node.is_angle_locked&&parent){const rootAngle=poses.get(root.id)?.angle??0,offset=finite(node.angle_lock_offset,finite(node.angle_lock_offset_minuend)-finite(node.angle_lock_offset_subtrahend));
   if(node.angle_lock_is_main_node)angle=rootAngle+offset;
   else{let anchor=nodes.get(node.parentId);while(anchor?.is_static&&anchor.parentId!=null)anchor=nodes.get(anchor.parentId);const anchorAngle=poses.get(anchor?.id)?.angle??0,relative=finite(node.angle_lock_relative_start,anchorAngle),rootStart=finite(node.angle_lock_stickfigure_start,rootAngle),multiplier=finite(node.angle_lock_relative_multiplier,1);angle=relative+signedDegrees(rootStart-rootAngle)*(multiplier-1)-signedDegrees(relative-anchorAngle)*multiplier+offset;}
  }
  const ns=node.use_segment_scale?finite(node.scale,1):1,L=finite(node.length)*ns*globalScale,rad=angle*Math.PI/180;
  let delta=cachedXY?{x:finite(node.local_x)*globalScale,y:-finite(node.local_y)*globalScale}:{x:Math.cos(rad)*L,y:-Math.sin(rad)*L};
  let connectorFraction=1;
  if(node.connector){const target=poses.get(targets.get(node.id));
   if(target){delta={x:target.end.x-start.x,y:target.end.y-start.y};const distance=Math.hypot(delta.x,delta.y),c=node.connector;connectorFraction=clamp(c.method===1?finite(c.percent,.5):distance?finite(c.value)*Math.abs(globalScale)/distance:0,0,1);if(c.reversed)connectorFraction=1-connectorFraction;}
   else if(Number.isFinite(node.connector.local_x)&&Number.isFinite(node.connector.local_y)){// Historical records without a connection table retain their saved offset from the full endpoint.
    const length=Math.hypot(delta.x,delta.y);connectorFraction=length?clamp(1-Math.hypot(node.connector.local_x,node.connector.local_y)*Math.abs(globalScale)/length,0,1):0;
   }
  }
  const drawEnd=node.kind==='root'?{x:0,y:0}:{x:start.x+delta.x,y:start.y+delta.y},end=node.connector?{x:start.x+delta.x*connectorFraction,y:start.y+delta.y*connectorFraction}:drawEnd;
  if(node.connector&&Math.hypot(delta.x,delta.y)>1e-9)angle=-Math.atan2(delta.y,delta.x)*180/Math.PI;
  if(L<0&&!node.connector)angle+=180;
  const scale=Math.abs(ns*globalScale),p={node,start,end,drawEnd,angle,length:Math.hypot(drawEnd.x-start.x,drawEnd.y-start.y),thickness:Math.abs(finite(node.thickness))*scale,scale,connectorFraction};
  const curved=['segment','rounded-segment','trapezoid'].includes(node.kind),sag=curved?finite(node.segment_curve_radius_and_default_curve_radius)*scale:0;
  p.curve=segmentCurve(p.length,sag,!!node.curve_circulization,Math.max(32,Math.abs(sag)>p.length?96:48));
  p.centerline=p.curve.points.map(q=>toSegmentWorld(p,q.x,q.y));poses.set(node.id,p);
 }
 return poses;
}
export function renderSVG(figure,options={}) {
 const poses=layoutFigure(figure,options),defs=[],drawables=[],overlays=[],warnings=new Set(),sid='sn'+String(options.idPrefix??'f').replace(/[^a-zA-Z0-9_-]/g,'');
 let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
 const addBounds=(x,y,r=0)=>{minX=Math.min(minX,x-r);minY=Math.min(minY,y-r);maxX=Math.max(maxX,x+r);maxY=Math.max(maxY,y+r);};
 const colorFor=n=>color(n.use_segment_color?n.color:figure.color);
 function paint(n,p){
  const base=colorFor(n);if(!n.use_gradient)return base;
  const id=`${sid}-g${n.id}`,reverse=n.reverse_gradient,other=color(n.gradient_color),c0=reverse?other:base,c1=reverse?base:other;
  const version=figure.definitionVersion??figure.version,build=figure.definitionBuild??figure.build??0;
  let mode=n.gradient_mode??1;
  if((build<82&&['circle','ellipse','polygon','filled-circle'].includes(n.kind))||(build<=100&&['polygon','filled-circle'].includes(n.kind)))mode=2;
  if(build<=108&&n.kind==='triangle')mode=1;
  let a=p.start,b=p.end;
  if(mode===2){const m=toSegmentWorld(p,p.length/2);defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${f(m.x)}" cy="${f(m.y)}" r="${f(Math.max(.001,(p.length+p.thickness)/2))}"><stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/></radialGradient>`);}
  else{if(mode===0){a=toSegmentWorld(p,p.length/2,-p.thickness/2);b=toSegmentWorld(p,p.length/2,p.thickness/2);}
   defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}"><stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/></linearGradient>`);}
  return `url(#${id})`;
 }
 const pathLine=pts=>'M '+pts.map(xy).join(' L ');
 for(const n of figure.nodes){if(n.kind==='root')continue;
  const p=poses.get(n.id),{start:a,drawEnd:b,length:L,thickness:T}=p,fill=paint(n,p),mid=toSegmentWorld(p,L/2),point=(x,y=0)=>toSegmentWorld(p,x,y);let shape='';
  if(n.is_floaty)warnings.add('Floaty-node dynamics are preserved, not simulated.');
  if(n.is_smart_stretch)warnings.add('Smart-stretch poses are read; native propagation is not simulated during editing.');
  if(n.kind==='segment'||n.kind==='rounded-segment'){
   shape=`<path d="${pathLine(p.centerline)}" fill="none" stroke="${fill}" stroke-width="${f(T)}" stroke-linecap="${n.kind==='rounded-segment'?'round':'butt'}" stroke-linejoin="round"/>`;
   for(const q of p.centerline)addBounds(q.x,q.y,T/2);
  }else if(n.kind==='circle'){
   const r=(L+T)/2,inner=Math.max(0,(L-T)/2),outline=!!n.use_circle_outline,hollow=outline&&n.circle_is_hollow;
   if(n.half_arc){const flipped=!!n.triangle_upside_down,base=flipped?L+T/2:-T/2,rx=L+T,pts=[];
    for(let j=0;j<=64;j++){const t=-Math.PI/2+Math.PI*j/64;pts.push(point(base+(flipped?-1:1)*rx*Math.cos(t),rx*Math.sin(t)));}shape=`<path d="${pathLine(pts)} Z" fill="${fill}"/>`;for(const q of pts)addBounds(q.x,q.y);
   }else if(hollow){shape=`<circle cx="${f(mid.x)}" cy="${f(mid.y)}" r="${f((r+inner)/2)}" fill="none" stroke="${color(n.circle_outline_color)}" stroke-width="${f(r-inner)}"/>`;addBounds(mid.x,mid.y,r);}
   else{shape=`<circle cx="${f(mid.x)}" cy="${f(mid.y)}" r="${f(r)}" fill="${outline?color(n.circle_outline_color):fill}"/>`+(outline&&inner>0?`<circle cx="${f(mid.x)}" cy="${f(mid.y)}" r="${f(inner)}" fill="${fill}"/>`:'');addBounds(mid.x,mid.y,r);}
  }else if(n.kind==='ellipse'){
   if(n.half_arc){const flip=!!n.triangle_upside_down,pts=[];for(let j=0;j<=64;j++){const t=-Math.PI/2+Math.PI*j/64;pts.push(point((flip?L:0)+(flip?-1:1)*L*Math.cos(t),T/2*Math.sin(t)));}shape=`<path d="${pathLine(pts)} Z" fill="${fill}"/>`;for(const q of pts)addBounds(q.x,q.y);}
   else{shape=`<ellipse cx="${f(mid.x)}" cy="${f(mid.y)}" rx="${f(L/2)}" ry="${f(T/2)}" transform="rotate(${f(-p.angle)} ${f(mid.x)} ${f(mid.y)})" fill="${fill}"/>`;for(let j=0;j<64;j++){const t=j*Math.PI/32,q=point(L/2+L/2*Math.cos(t),T/2*Math.sin(t));addBounds(q.x,q.y);}}
  }else if(n.kind==='triangle'){
   let ps=[[0,-T/2],[0,T/2],[L,Math.sign(n.right_triangle_direction??0)*T/2]];if(n.triangle_upside_down)ps=ps.map(([x,y])=>[L-x,y]);const pts=ps.map(([x,y])=>point(x,y));shape=`<polygon points="${pts.map(xy).join(' ')}" fill="${fill}"/>`;for(const q of pts)addBounds(q.x,q.y);
  }else if(n.kind==='trapezoid'){
   const ratio=finite(n.trapezoid_top_thickness_ratio,.5),build=figure.definitionBuild??figure.build??0;
   let ws=T,we=Math.abs(T*ratio);
   if(build>=36&&ratio<0){ws=Math.abs(finite(n.trapezoid_thickness_start,T))*p.scale;we=Math.abs(finite(n.trapezoid_thickness_end,T/2))*p.scale;}
   if(build===36){ws=n.use_trapezoid_thickness_start?Math.abs(finite(n.trapezoid_thickness_start))*p.scale:T;we=n.use_trapezoid_thickness_end?Math.abs(finite(n.trapezoid_thickness_end))*p.scale:T;}
   const left=[],right=[],pts=p.centerline;
   for(let i=0;i<pts.length;i++){const prev=pts[Math.max(0,i-1)],next=pts[Math.min(pts.length-1,i+1)],len=Math.hypot(next.x-prev.x,next.y-prev.y)||1,nx=-(next.y-prev.y)/len,ny=(next.x-prev.x)/len,r=(ws+(we-ws)*i/(pts.length-1))/2;left.push({x:pts[i].x+nx*r,y:pts[i].y+ny*r});right.push({x:pts[i].x-nx*r,y:pts[i].y-ny*r});addBounds(pts[i].x,pts[i].y,r);}
   shape=`<path d="${pathLine([...left,...right.reverse()])} Z" fill="${fill}"/>`;
   if(n.trapezoid_is_rounded_start)shape+=`<circle cx="${f(a.x)}" cy="${f(a.y)}" r="${f(ws/2)}" fill="${fill}"/>`;
   if(n.trapezoid_is_rounded_end)shape+=`<circle cx="${f(b.x)}" cy="${f(b.y)}" r="${f(we/2)}" fill="${fill}"/>`;
  }else if(n.kind==='polygon'||n.kind==='filled-circle'){
   const count=clamp(n.num_polygon_vertices??5,3,256),r=(L+T)/2,pts=[];for(let j=0;j<count;j++){const t=j*Math.PI*2/count;pts.push(point(L/2+r*Math.cos(t),r*Math.sin(t)));}shape=`<polygon points="${pts.map(xy).join(' ')}" fill="${fill}"/>`;addBounds(mid.x,mid.y,r);
   if(n.kind==='filled-circle')warnings.add('Legacy type 4 uses the loader polygon fallback; historical semantics need additional reference files.');
  }
  drawables.push({z:n.id,html:`<g data-node-id="${n.id}" data-static="${!!n.is_static}"><title>Node ${n.id} · ${escapeXml(n.kind)}${n.is_static?' · STATIC':''}</title>${shape}</g>`});
 }
 // Polyfill edges follow a curved parent/child limb, not its straight chord.
 for(const pf of figure.polyfills??[]){const ids=[pf.anchorId,...pf.attachedIds],pts=[];
  for(let i=0;i<ids.length;i++){const a=poses.get(ids[i]),b=poses.get(ids[(i+1)%ids.length]);if(!a||!b)continue;pts.push(a.end);if(b.node.parentId===a.node.id)pts.push(...b.centerline.slice(1,-1));else if(a.node.parentId===b.node.id)pts.push(...a.centerline.slice(1,-1).reverse());}
  if(pts.length>=3){drawables.push({z:pf.anchorId-.1,html:`<polygon data-polyfill="${pf.anchorId}" points="${pts.map(xy).join(' ')}" fill="${color(pf.use_polyfill_color?pf.color:figure.color)}"/>`});for(const q of pts)addBounds(q.x,q.y);}
 }
 if(!Number.isFinite(minX)){minX=-100;minY=-100;maxX=100;maxY=100;}
 const pad=Math.max(8,Math.max(maxX-minX,maxY-minY)*.055),x=minX-pad,y=minY-pad,w=Math.max(1,maxX-minX+pad*2),h=Math.max(1,maxY-minY+pad*2),dot=Math.max(w,h)/200;
 if(options.skeleton||options.selectedId!=null){
  for(const [id,p]of poses){const selected=id===options.selectedId,isStatic=p.node.is_static&&p.node.kind!=='root',root=p.node.kind==='root';if(!options.skeleton&&!selected)continue;
   if(options.skeleton&&!root)overlays.push(`<line x1="${f(p.start.x)}" y1="${f(p.start.y)}" x2="${f(p.end.x)}" y2="${f(p.end.y)}" stroke="${isStatic?'#929b9b':'#168b87'}" stroke-width="1" vector-effect="non-scaling-stroke" opacity=".6"/>`);
  }
  // Static decoration first, movable joints last, so busy artwork cannot hide controls.
  for(const [id,p]of [...poses].sort((a,b)=>Number(!a[1].node.is_static)-Number(!b[1].node.is_static))){const selected=id===options.selectedId,isStatic=p.node.is_static&&p.node.kind!=='root',root=p.node.kind==='root';if(!options.skeleton&&!selected)continue;
   const r=dot*(selected?1.65:root?1.6:isStatic?.65:1.05),attrs=`data-select-node="${id}" data-static="${!!isStatic}" data-root="${root}" class="node-handle ${isStatic?'static-handle':'movable-handle'}" fill="${selected?'#ea7949':root?'#ffc46b':isStatic?'#929b9b':'#ffffff'}" stroke="${isStatic?'#596366':'#168b87'}" stroke-width="1.15" vector-effect="non-scaling-stroke"`;
   overlays.push(isStatic?`<rect ${attrs} x="${f(p.end.x-r)}" y="${f(p.end.y-r)}" width="${f(2*r)}" height="${f(2*r)}"><title>Node ${id} · static: follows its parent</title></rect>`:`<circle ${attrs} cx="${f(p.end.x)}" cy="${f(p.end.y)}" r="${f(r)}"><title>${root?'Move figure':`Pose node ${id}`}</title></circle>`);
   if((options.labels&&!isStatic)||selected)overlays.push(`<text x="${f(p.end.x+dot*2)}" y="${f(p.end.y-dot*2)}" fill="#147c79" font-size="${f(dot*3)}" font-family="monospace" pointer-events="none">${id}${isStatic?' · static':''}</text>`);
  }
 }
 drawables.sort((a,b)=>a.z-b.z);const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${[x,y,w,h].map(f).join(' ')}" role="img" aria-label="Decoded figure geometry"><defs>${defs.join('')}</defs>${drawables.map(d=>d.html).join('')}${overlays.join('')}</svg>`;
 return {svg,viewBox:{x,y,w,h},warnings:[...warnings],poses};
}
