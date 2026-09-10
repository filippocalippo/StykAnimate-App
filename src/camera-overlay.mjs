import { cameraValues } from './editor-camera.mjs';

/** Document-space geometry with controls sized in screen pixels. */
export function cameraViewport(report, frame, view = {}) {
  const camera = cameraValues(frame?.camera), width = report.canvas_width, height = report.canvas_height;
  const zoom = view.scale || 1, center = {x: width / 2 + camera.x, y: height / 2 + camera.y};
  const cos = Math.cos(camera.angle_rad), sin = Math.sin(camera.angle_rad);
  const point = (x, y) => ({x: center.x + camera.scale * (x*cos-y*sin), y: center.y + camera.scale * (x*sin+y*cos)});
  const corners = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y]) => point(x*width/2,y*height/2));
  const rotationBase = point(0, -height/2);
  const handles = corners.map((point,index) => ({kind:'scale',index,point}));
  handles.push({kind:'position',index:4,point:center},
    {kind:'rotation',index:5,point:point(0,-height/2-30/(zoom*camera.scale))});
  const guides = [1/3,2/3].flatMap(t => [
    [point(width*(t-.5),-height/2),point(width*(t-.5),height/2)],
    [point(-width/2,height*(t-.5)),point(width/2,height*(t-.5))],
  ]);
  return {camera,center,corners,handles,width,height,zoom,rotationBase,guides};
}

export function pickCameraHandle(viewport, point, view = {}) {
  const radius = 12/(view.scale || viewport.zoom || 1);
  return [...viewport.handles].reverse().find(h => Math.hypot(h.point.x-point.x,h.point.y-point.y)<=radius) ?? null;
}

export function cameraHandleCursor(handle, viewport) {
  if (!handle) return '';
  if (handle.kind === 'position') return 'move';
  if (handle.kind === 'rotation') return 'grab';
  const p = viewport.handles[handle.index].point;
  const angle = Math.atan2(p.y-viewport.center.y,p.x-viewport.center.x);
  return ['ew-resize','nwse-resize','ns-resize','nesw-resize'][((Math.round(angle/(Math.PI/4))%4)+4)%4];
}

export function cameraDragDelta(drag, point) {
  if (drag.handle.kind === 'position') {
    const dx = point.x-drag.start.x, dy = point.y-drag.start.y;
    if (drag.constrain && !drag.axis && (dx || dy)) drag.axis = Math.abs(dx)>=Math.abs(dy)?'x':'y';
    return {x:drag.axis==='y'?0:dx,y:drag.axis==='x'?0:dy};
  }
  const {center,camera} = drag.viewport, start = drag.start ?? drag.handle.point;
  if (drag.handle.kind === 'rotation') {
    const angle = Math.atan2(point.y-center.y,point.x-center.x);
    const previous = drag.lastAngle ?? Math.atan2(start.y-center.y,start.x-center.x);
    drag.rotation = (drag.rotation ?? 0) + Math.atan2(Math.sin(angle-previous),Math.cos(angle-previous));
    drag.lastAngle = angle;
    const absolute = camera.angle_rad+drag.rotation;
    return {angle_rad: (drag.snap ? Math.round(absolute/(Math.PI/12))*(Math.PI/12) : absolute)-camera.angle_rad};
  }
  // Relative to the grab point, so a generous hit target never causes a jump.
  let scale = camera.scale*Math.hypot(point.x-center.x,point.y-center.y)/Math.max(1e-8,Math.hypot(start.x-center.x,start.y-center.y));
  if (drag.snap) scale = Math.round(scale*10)/10;
  return {scale:Math.max(.0001,scale)/camera.scale};
}

export function cameraKeyboardDelta(viewport, handle, dx, dy) {
  if (handle.kind==='position') return {x:dx/viewport.zoom,y:dy/viewport.zoom};
  const direction = dx || -dy;
  if (handle.kind==='rotation') return {angle_rad:direction*Math.PI/180};
  return {scale:Math.max(.0001,viewport.camera.scale+direction*.01)/viewport.camera.scale};
}

export function drawCameraViewport(context, viewport, project, {active=true,onion=false,guides=true,hover=null,dragging=null}={}) {
  const points=viewport.corners.map(project), accent='#1689ee';
  const line = (a,b) => {context.beginPath();context.moveTo(a.x,a.y);context.lineTo(b.x,b.y);context.stroke();};
  context.save();
  context.globalAlpha=onion ? .18 : active ? 1 : .4;
  context.strokeStyle=onion?'#748194':accent;
  context.lineWidth=active?1.5:1;
  context.beginPath();points.forEach((p,i)=>i?context.lineTo(p.x,p.y):context.moveTo(p.x,p.y));context.closePath();
  context.stroke();
  if (!active || onion) {context.restore();return;}
  if (guides) {
    context.save();context.globalAlpha=.35;context.lineWidth=1;context.setLineDash([4,4]);
    for (const [a,b] of viewport.guides) line(project(a),project(b));
    context.restore();
  }
  line(project(viewport.rotationBase),project(viewport.handles[5].point));
  for (const handle of viewport.handles) {
    const p=project(handle.point), highlighted=(dragging ?? hover)?.index===handle.index;
    context.save();context.translate(p.x,p.y);
    if (highlighted) {context.beginPath();context.arc(0,0,16,0,Math.PI*2);context.fillStyle='#1689ee22';context.fill();}
    context.fillStyle=highlighted?accent:'#fff';context.strokeStyle=accent;context.lineWidth=1.8;
    context.beginPath();
    if(handle.kind==='scale') {context.rotate(viewport.camera.angle_rad);context.roundRect(-4.5,-4.5,9,9,2);}
    else context.arc(0,0,handle.kind==='position'?10:8,0,Math.PI*2);
    context.fill();context.stroke();
    context.strokeStyle=highlighted?'#fff':accent;context.lineWidth=1.4;
    if (handle.kind==='position') {line({x:-5,y:0},{x:5,y:0});line({x:0,y:-5},{x:0,y:5});}
    if (handle.kind==='rotation') {context.beginPath();context.arc(0,0,3.8,-Math.PI*.8,Math.PI*.7);context.stroke();}
    context.restore();
  }
  const grip=dragging ?? hover;
  if (grip) {
    const p=project(viewport.handles[grip.index].point),c=viewport.camera;
    const label=grip.kind==='position'?`Move · ${c.x.toFixed(1)}, ${c.y.toFixed(1)} px`:grip.kind==='rotation'?`Rotate · ${(c.angle_rad*180/Math.PI).toFixed(1)}°`:`Scale · ${(c.scale*100).toFixed(1)}%`;
    context.font='12px "Segoe UI", sans-serif';
    const width=context.measureText(label).width+20;
    const canvasWidth=context.canvas?.clientWidth || context.canvas?.width || Infinity;
    const x=Math.max(4,Math.min(p.x-width/2,canvasWidth-width-4)),y=Math.max(4,p.y+20);
    context.fillStyle='#172b42';context.beginPath();context.roundRect(x,y,width,26,6);context.fill();
    context.fillStyle='#fff';context.fillText(label,x+10,y+17);
  }
  context.restore();
}
