export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const hexColor = rgb => '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
export function parseColor(value) {
  let h = String(value).replace(/^#/, '');
  if (/^[\da-f]{3,4}$/i.test(h)) h = [...h].map(c => c + c).join('');
  if (!/^[\da-f]{6}([\da-f]{2})?$/i.test(h)) throw new Error('Use a valid HEX color, optionally including alpha.');
  return {color: [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)), opacity: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1};
}
export function normalizePaint(paint) {
  if (!paint || !['solid', 'linear', 'radial', 'angular', 'diamond'].includes(paint.type)) throw new Error('Invalid paint type.');
  const finite = (v, min, max) => { if (!Number.isFinite(v) || v < min || v > max) throw new Error('Invalid paint value.'); return v; };
  if (!Array.isArray(paint.stops) || paint.stops.length < (paint.type === 'solid' ? 1 : 2) || paint.stops.length > 32) throw new Error('Use between 2 and 32 gradient stops.');
  const stops = paint.stops.map(s => {
    if (!Array.isArray(s.color) || s.color.length !== 3) throw new Error('Invalid RGB color.');
    return {offset: finite(s.offset, 0, 1), color: s.color.map(v => Math.round(finite(v, 0, 255))), opacity: finite(s.opacity, 0, 1)};
  }).sort((a, b) => a.offset - b.offset);
  return {type: paint.type, angle: finite(paint.angle ?? 0, -36000, 36000), stops};
}
export function segmentPaint(segment) {
  if (segment.paint) {
    const p = normalizePaint(segment.paint);
    p.stops[0].color = segment.color_rgb ?? p.stops[0].color;
    p.stops[0].opacity = 1 - (segment.transparency ?? 0) / 255;
    if (segment.secondary && p.type !== 'solid') {p.stops.at(-1).color=segment.secondary.rgb;p.stops.at(-1).opacity=1-(segment.secondary.a??0)/255;}
    return p;
  }
  const stops = [{offset: 0, color: segment.color_rgb ?? [0, 0, 0], opacity: 1 - (segment.transparency ?? 0) / 255}];
  if (segment.secondary) stops.push({offset: 1, color: segment.secondary.rgb, opacity: 1 - (segment.secondary.a ?? 0) / 255});
  return {type: segment.secondary ? 'linear' : 'solid', angle: 0, stops};
}
export const cssColor = s => `rgba(${s.color.join(',')},${s.opacity})`;
export function paintCSS(p) {
  if (p.type === 'solid') return cssColor(p.stops[0]);
  const stops = p.stops.map(s => `${cssColor(s)} ${s.offset * 100}%`).join(',');
  return p.type === 'radial' || p.type === 'diamond' ? `radial-gradient(circle,${stops})` : p.type === 'angular' ? `conic-gradient(from ${p.angle + 90}deg,${stops})` : `linear-gradient(${p.angle + 90}deg,${stops})`;
}
export function samplePaint(p, t) {
  const stops = p.stops; if (t <= stops[0].offset) return stops[0];
  for (let i = 1; i < stops.length; i++) if (t < stops[i].offset) {
    const a = stops[i - 1], b = stops[i], f = (t - a.offset) / (b.offset - a.offset || 1), opacity = a.opacity + (b.opacity - a.opacity) * f;
    return {offset: t, opacity, color: a.color.map((v, j) => v + (b.color[j]-v)*f)};
  }
  return stops.at(-1);
}
export function paintGeometry(p, start, end) {
  const length = Math.max(.001, Math.hypot(end.x - start.x, end.y - start.y));
  const angle = Math.atan2(end.y - start.y, end.x - start.x) + p.angle * Math.PI / 180;
  const cx = (start.x + end.x) / 2, cy = (start.y + end.y) / 2, dx = Math.cos(angle) * length / 2, dy = Math.sin(angle) * length / 2;
  return {cx, cy, length, angle, x1: cx - dx, y1: cy - dy, x2: cx + dx, y2: cy + dy};
}
export function textPaintGeometry(bounds, placement = {x:0,y:0}) {
  const x=(bounds.left??0)-placement.x,y=(bounds.top??(bounds.bottom-bounds.height))-placement.y;
  const width=bounds.width??bounds.right-bounds.left,height=bounds.height??bounds.bottom-bounds.top;
  return {start:{x,y:y+height/2},end:{x:x+width,y:y+height/2},bounds:{x,y,width,height}};
}
export function shapePaintBounds(s) {
  let x=Infinity,y=Infinity,right=-Infinity,bottom=-Infinity;
  for(const p of s.points?.length?s.points:[s.start,s.end]){x=Math.min(x,p.x);y=Math.min(y,p.y);right=Math.max(right,p.x);bottom=Math.max(bottom,p.y);}
  const pad=Math.max(Math.abs(s.length??0),s.thickness??0,1);
  return {x:x-pad,y:y-pad,width:right-x+pad*2,height:bottom-y+pad*2};
}
export function canvasPaint(ctx, p, start, end, mapColor = c => c, bounds = {x:0,y:0,width:ctx.canvas.width,height:ctx.canvas.height}) {
  if (p.type === 'solid') return cssColor({...p.stops[0], color: mapColor(p.stops[0].color)});
  const g = paintGeometry(p, start, end); let brush;
  if (p.type === 'linear') brush = ctx.createLinearGradient(g.x1, g.y1, g.x2, g.y2);
  else if (p.type === 'radial') brush = ctx.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, g.length / 2);
  else if (p.type === 'angular') brush = ctx.createConicGradient(g.angle, g.cx, g.cy);
  else {
    // A repeating tile is avoided: the padded outer area retains the final stop.
    const size = 512, canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), {width:size,height:size});
    const c = canvas.getContext('2d'), data = c.createImageData(size, size), cos = Math.cos(g.angle), sin = Math.sin(g.angle);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const u = (bounds.x + x/(size-1)*bounds.width-g.cx)/(g.length/2), v = (bounds.y+y/(size-1)*bounds.height-g.cy)/(g.length/2);
      const s = samplePaint(p, Math.abs(u * cos + v * sin) + Math.abs(-u * sin + v * cos)), i = (y * size + x) * 4;
      data.data.set([...mapColor(s.color), s.opacity * 255], i);
    }
    c.putImageData(data, 0, 0); brush = ctx.createPattern(canvas, 'no-repeat');
    brush.setTransform(new DOMMatrix([bounds.width / size, 0, 0, bounds.height / size, bounds.x, bounds.y]));
    return brush;
  }
  for (const s of p.stops) brush.addColorStop(s.offset, cssColor({...s, color: mapColor(s.color)}));
  return brush;
}

export function backgroundPaint(bg) {
  if (bg?.paint) return normalizePaint(bg.paint);
  const stop = (raw, offset) => ({offset,color:[raw>>>16&255,raw>>>8&255,raw&255],opacity:(raw>>>24)/255});
  if (!bg || ![3,4].includes(bg.kind)) return {type:'solid',angle:0,stops:[stop(bg?.color??0xffffffff,0)]};
  return {type:bg.kind===4?'radial':'linear',angle:bg.kind===4?0:Math.atan2((bg.y2??1)-(bg.y1??0),(bg.x2??1)-(bg.x1??0))*180/Math.PI,
    stops:[stop(bg.kind===4?bg.color_b:bg.color_a,0),stop(bg.kind===4?bg.color_a:bg.color_b,1)]};
}
export function paintBackground(p) {
  const raw=s=>((Math.round(s.opacity*255)<<24)|(s.color[0]<<16)|(s.color[1]<<8)|s.color[2])>>>0;
  return {kind:p.type==='solid'?2:p.type==='radial'?4:3,paint:normalizePaint(p),color:raw(p.stops[0]),color_a:raw(p.stops[0]),color_b:raw(p.stops.at(-1)),x1:0,y1:.5,x2:1,y2:.5};
}

/** Native SVG gradients where supported; seamless embedded paint for angular/diamond. */
export async function svgPaintDefinition(p, start, end, id, mapColor = c => c, bounds) {
  const g=paintGeometry(p,start,end), stops=p.stops.map(s=>`<stop offset="${s.offset}" stop-color="${hexColor(mapColor(s.color))}" stop-opacity="${s.opacity}"/>`).join('');
  if(p.type==='linear')return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}">${stops}</linearGradient>`;
  if(p.type==='radial')return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${g.cx}" cy="${g.cy}" r="${g.length/2}">${stops}</radialGradient>`;
  bounds ??= {x:g.cx-g.length,y:g.cy-g.length,width:g.length*2,height:g.length*2};
  const scale=Math.min(4,2048/Math.max(bounds.width,bounds.height)),width=Math.max(1,Math.ceil(bounds.width*scale)),height=Math.max(1,Math.ceil(bounds.height*scale));
  const canvas=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(width,height):Object.assign(document.createElement('canvas'),{width,height});
  const ctx=canvas.getContext('2d');ctx.scale(width/bounds.width,height/bounds.height);ctx.translate(-bounds.x,-bounds.y);
  ctx.fillStyle=canvasPaint(ctx,p,start,end,mapColor,bounds);ctx.fillRect(bounds.x,bounds.y,bounds.width,bounds.height);
  const blob=canvas.convertToBlob?await canvas.convertToBlob({type:'image/png'}):await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  const href='data:image/png;base64,'+btoa(binary);
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" viewBox="0 0 ${bounds.width} ${bounds.height}"><image width="${bounds.width}" height="${bounds.height}" preserveAspectRatio="none" href="${href}"/></pattern>`;
}
