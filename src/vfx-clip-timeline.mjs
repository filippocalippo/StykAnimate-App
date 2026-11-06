import {effectMessages,effectPropertyText} from './vfx-localization.mjs';
import {appendLocalized, localizedAttribute} from './localization-bindings.mjs';

import {t as interfaceText} from './localization.mjs';
import {clipContains,vfxFadeAt} from './vfx-clips.mjs';
import {vfxDescriptor} from './vfx.mjs';
import {vfxVisibleKeys,vfxChannelLabel,vfxChannelMessage} from './vfx-key-channels.mjs';
import {openVfxChannelMenu} from './vfx-key-channel-menu.mjs';
import {clipTail} from './vfx-clip-views.mjs';

/** Where an effect lane's keys sit: under the clip's name, near the lane's foot (the lane is `size` px tall, timeline-rows.mjs). */
const keyY=size=>size-9;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const name=c=>c.name||(effectMessages[c.effects[0]?.type]?interfaceText(effectMessages[c.effects[0].type].nameKey):interfaceText("vfxClipTimeline.effects"));
const lowerBound=(keys,tick)=>{let a=0,b=keys.length;while(a<b){const m=(a+b)>>>1;if(keys[m].tick<tick)a=m+1;else b=m;}return a;};
const projections=new WeakMap();

/** Viewport-sized projection. Dense channels skip directly to the next pixel
 * bucket, without scanning offscreen keys or allocating a merged key table. */
export function visibleVfxKeys(keys,first,last,step){
 const stride=Math.max(1,Math.ceil(8/step)),begin=Math.max(0,Math.floor(first/stride)*stride),end=Math.ceil(last);
 const cached=projections.get(keys);if(cached?.begin===begin&&cached.end===end&&cached.stride===stride)return cached.ticks;
 const buckets=new Map();
 for(const channel of Object.values(keys)){
  let i=lowerBound(channel,begin);
  while(i<channel.length){const tick=channel[i].tick;if(tick>end)break;const bucket=Math.floor(tick/stride),previous=buckets.get(bucket);if(previous===undefined||tick<previous)buckets.set(bucket,tick);i=stride===1?i+1:lowerBound(channel,(bucket+1)*stride);}
 }
 const ticks=[...buckets.values()].sort((a,b)=>a-b);projections.set(keys,{begin,end,stride,ticks});return ticks;
}
export function appendVfxRows(rows,editor,target={scene:editor._vfxTimelineScene,uid:editor.selectedUid}){
 if(!editor._vfxTimelineVisible)return rows;
 const byLayer=new Map();
 for(const clip of editor.getVfxClips()){
  if(target.scene?clip.target.kind!=='scene':clip.target.kind==='scene'||clip.target.uid!==target.uid)continue;
  const id=clip.target.kind==='scene'?'scene':editor.layerForUid(clip.target.uid),list=byLayer.get(id)??[];list.push(clip);byLayer.set(id,list);
 }
 return rows.flatMap(row=>{
  const clips=byLayer.get(row.id);if(!clips?.length)return [row];
  const lanes=[];
  for(const clip of [...clips].sort((a,b)=>a.start-b.start)){
   let lane=lanes.find(l=>l.end<=clip.start);if(!lane){lane={end:0,clips:[]};lanes.push(lane);}
   lane.clips.push(clip);lane.end=clip.duration===null?Infinity:clip.start+clip.duration;
  }
  return [row,...lanes.map((lane,i)=>({id:`vfx/${row.id}/${i}`,kind:'vfx',name:i?interfaceText('vfxChannels.lane',{count:i+1}):interfaceText("vfxClipTimeline.effects"),nameKey:i?'vfxChannels.lane':'vfxClipTimeline.effects',nameParams:{count:i+1},clips:lane.clips,layerId:row.id,visible:true,locked:row.locked}))];
 });
}
function previewClip(host,clip){const g=host.gesture;return g?.kind==='vfx-clip'&&g.id===clip.id?{...clip,...g.patch}:clip;}
function keyTicks(host,clip){const sx=host._offsetX(),step=host.pxPerTick;return visibleVfxKeys(vfxVisibleKeys(host.editor,clip),Math.max(clip.offset,sx/step-clip.start+clip.offset-1),Math.min(clip.duration===null?Infinity:clip.offset+clip.duration-1,(sx+host.width)/step-clip.start+clip.offset+1),step);}
function keyX(host,clip,tick){return (tick+clip.start-clip.offset+.5)*host.pxPerTick-host._offsetX();}
function fadeX(host,clip,edge){const length=Math.min(clip.duration,clip[edge]);return (clip.start+(edge==='fadeIn'?length:clip.duration-length))*host.pxPerTick-host._offsetX();}
/** An effect lane: each clip a neutral block (the selected one in the accent) with its name, fades and round keys. */
export function paintVfxRow(host,ctx,row,y,size=32){
 const sx=host._offsetX(),step=host.pxPerTick,c=host.colors,g=host.gesture,top=y+3,height=size-6,foot=y+size-4,keyAt=y+keyY(size);
 for(const source of row.clips){
  const clip=previewClip(host,source),duration=clip.duration??host.editor.totalTicks,left=clip.start*step-sx,right=left+duration*step,selected=host.editor._selectedVfxClip===clip.id;
  // Hatched tail: particles emitted inside the clip stay visible after it.
  const tail=clipTail(host.editor,clip);
  if(left>host.width||right+tail*step<0)continue;
  if(tail>0){const ta=Math.max(-5,right),tb=Math.min(host.width+5,right+tail*step);if(tb>ta+1){ctx.save();ctx.globalAlpha=clip.enabled?.6:.25;ctx.beginPath();ctx.rect(ta,top+6,tb-ta,height-12);ctx.clip();ctx.strokeStyle=selected?c.accent:c.muted??c.line;ctx.lineWidth=1;ctx.beginPath();for(let x=ta-14;x<tb;x+=5){ctx.moveTo(x,top+height-6);ctx.lineTo(x+14,top+6);}ctx.stroke();ctx.restore();}}
  if(right<0)continue;
  const a=Math.max(-5,left+1),b=Math.min(host.width+5,right-1),width=Math.max(2,b-a);
  ctx.save();ctx.globalAlpha=clip.enabled?1:.4;ctx.beginPath();ctx.roundRect(a,top,width,height,6);ctx.fillStyle=selected?c['accent-soft']??c.selected:c.cel??c.span;ctx.fill();ctx.lineWidth=selected?1.5:1;ctx.strokeStyle=selected?c['accent-line']??c.accent:c['cel-line']??c.line;ctx.stroke();ctx.clip();
  // A beam's charge-up is shaded before it fires.
  const charge=clip.effects.find(e=>e.type==='beam'&&e.enabled)?.params.charge??0;
  if(charge>0&&clip.duration!==null){ctx.save();ctx.globalAlpha*=.14;ctx.fillStyle=c.accent;ctx.fillRect(left,top,Math.min(charge,duration)*step,height);ctx.restore();}
  if(clip.duration!==null&&(clip.fadeIn||clip.fadeOut)){
   const points=[0,duration,Math.min(duration,clip.fadeIn),Math.max(0,duration-clip.fadeOut)];if(clip.fadeIn+clip.fadeOut>duration)points.push(duration*clip.fadeIn/(clip.fadeIn+clip.fadeOut));points.sort((a,b)=>a-b);
   ctx.strokeStyle=c.accent;ctx.globalAlpha*=.45;ctx.beginPath();for(const [i,time] of points.entries())ctx[i?'lineTo':'moveTo'](left+time*step,foot-vfxFadeAt(clip,time)*(height-4));ctx.stroke();ctx.globalAlpha=clip.enabled?1:.4;
  }
  ctx.font=`11px ${host.font}`;ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillStyle=c.ink;
  const textY=top+Math.min(10,height/2-2);
  if(width>34){ctx.save();ctx.beginPath();ctx.rect(Math.max(left+10,6),top+2,Math.max(1,width-20),15);ctx.clip();ctx.fillText(name(clip),Math.max(left+10,6),textY);if(selected){const filter=vfxChannelLabel(host.editor,clip),x=Math.max(left+10,6)+ctx.measureText(name(clip)).width+10;if(vfxChannelMessage(host.editor,clip).messageKey!=='vfxChannels.allKeys'&&b-x>65){ctx.fillStyle=c.muted;ctx.font=`10px ${host.font}`;ctx.fillText(filter,x,textY);}}ctx.restore();}
  for(const tick of keyTicks(host,clip)){
   if(tick<clip.offset||clip.duration!==null&&tick>=clip.offset+clip.duration)continue;
   const moving=g?.kind==='vfx-key'&&g.id===clip.id&&g.from===tick,time=moving?g.to:tick,x=keyX(host,clip,time);
   const picked=host.editor._selectedVfxKey?.id===clip.id&&host.editor._selectedVfxKey.tick===tick;
   ctx.beginPath();ctx.arc(x,keyAt,picked||moving?4.5:3.5,0,Math.PI*2);ctx.fillStyle=picked||moving?c.ink:c.fx??c.accent;ctx.fill();ctx.strokeStyle=c['key-outline']??c.line;ctx.lineWidth=1;ctx.stroke();
  }
  ctx.restore();
 }
}
function trimEdge(host,clip,hit){
 if(clip.duration===null)return null;
 const x=hit.x+host._offsetX(),left=Math.abs(x-clip.start*host.pxPerTick),right=Math.abs(x-(clip.start+clip.duration)*host.pxPerTick);
 return Math.min(left,right)<=6?(left<=right?'left':'right'):null;
}
function pickClip(host,hit){const clips=host.tracks[hit.row]?.clips;return clips?.find(c=>c.id===host.editor._selectedVfxClip&&trimEdge(host,c,hit))??clips?.find(c=>clipContains(c,hit.tick)&&hit.tick<(c.duration===null?host.editor.totalTicks:c.start+c.duration))??clips?.find(c=>trimEdge(host,c,hit));}
function pickKey(host,clip,hit){
 const y=host.rowY(hit.row);if(Math.abs(hit.y-y-keyY(host.rowSize(hit.row)))>8)return;
 let nearest,distance=9;for(const tick of keyTicks(host,clip)){if(tick<clip.offset||clip.duration!==null&&tick>=clip.offset+clip.duration)continue;const dx=Math.abs(keyX(host,clip,tick)-hit.x);if(dx<distance){nearest=tick;distance=dx;}}return nearest;
}

/** Only two accessible sliders are mounted, for the selected visible block.
 * All other blocks and keys use the timeline's existing virtual canvas. */
function syncFadeHandles(host){
 if(!host.vfxHandles){
  const overlay=host.vfxHandles=document.createElement('div');overlay.className='vfx-timeline-overlay';appendLocalized(host.main, overlay);
  for(const edge of ['fadeIn','fadeOut']){
   const node=document.createElement('button');node.type='button';node.className='vfx-fade-handle';node.dataset.vfxFade=edge;node.setAttribute('role','slider');node.setAttribute('aria-orientation','horizontal');localizedAttribute(node, 'aria-label', (edge==='fadeIn' ? "vfxClipTimeline.fadeIn" : "vfxClipTimeline.fadeOut"), (edge==='fadeIn' ? {} : {}));appendLocalized(overlay, node);
   host._on(node,'pointerdown',event=>host._pointerDown(event));
   host._on(node,'keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();host._cancelGesture();host.scroll.focus();return;}
    if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(event.key))return host._keyDown(event);
    event.preventDefault();event.stopPropagation();const clip=host.editor.getVfxClips().find(c=>c.id===host.editor._selectedVfxClip);if(!clip||clip.duration===null)return;
    const delta=(["ArrowRight","ArrowUp"].includes(event.key)?1:-1)*(event.shiftKey?10:1),value=event.key==='Home'?0:event.key==='End'?clip.duration:clamp(clip[edge]+delta,0,clip.duration);
    host._run(()=>host.editor.setVfxClip(clip.id,{[edge]:value}));host.update();
   });
  }
 }
 const index=host.tracks.findIndex(r=>r.kind==='vfx'&&r.clips.some(c=>c.id===host.editor._selectedVfxClip)),row=host.tracks[index],source=row?.clips.find(c=>c.id===host.editor._selectedVfxClip),clip=source&&previewClip(host,source);
 const layout=host.layout,y=index<0?0:host.rowY(index),size=index<0?0:host.rowSize(index),ceiling=layout.pinned&&index<layout.system?layout.header:layout.contentTop;
 host.vfxHandles.hidden=!clip||clip.duration===null||y<ceiling||y+size>host.height;
 if(host.vfxHandles.hidden)return;
 const left=clip.start*host.pxPerTick-host._offsetX(),right=left+clip.duration*host.pxPerTick;
 for(const node of host.vfxHandles.children){const edge=node.dataset.vfxFade,x=clamp(fadeX(host,clip,edge),left+7,right-7);node.hidden=x<5||x>host.width-5||right-left<18;node.disabled=Boolean(row.locked);node.style.left=`${x}px`;node.style.top=`${y-layout.header+6}px`;node.dataset.dragging=String(host.gesture?.edge===edge);node.setAttribute('aria-valuemin','0');node.setAttribute('aria-valuemax',String(clip.duration));node.setAttribute('aria-valuenow',String(Math.min(clip[edge],clip.duration)));localizedAttribute(node, 'aria-valuetext', 'counts.frames', {count:clip[edge]});localizedAttribute(node, "title", 'vfxClipTimeline.valueValue1Frames', {value: edge==='fadeIn'?{messageKey: "vfxClipTimeline.fadeIn"}:{messageKey: "vfxClipTimeline.fadeOut"}, value1: clip[edge]});}
}
export function installVfxTimeline(Timeline){
 const p=Timeline.prototype;
 p._openVfxChannels=function(anchor){const clip=this.editor.getVfxClips().find(c=>c.id===this.editor._selectedVfxClip);if(clip)openVfxChannelMenu(this.editor,clip,anchor,{signal:this.events.signal});};
 p._effectRows=function(rows){
  if(this.gesture?.kind.startsWith('vfx'))this._cancelGesture();
  const e=this.editor;
  // Selecting frame cells also selects their figures. Keep the effect context
  // until a canvas/inspector selection explicitly changes it, including seeks.
  if(!e._sheetSelection||this._effectDocument!==e._documentToken){
   this._effectDocument=e._documentToken;this._effectTarget={scene:e._vfxTimelineScene,uid:e.selectedUid};
  }
  return appendVfxRows(rows,e,this._effectTarget);
 };
 const paint=p._paint;p._paint=function(){paint.call(this);syncFadeHandles(this);};
 p._selectVfxRow=function(row,id){
  const clip=row.clips.find(c=>c.id===id)??row.clips[0];if(!clip)return;
  const e=this.editor;if(clip.target.kind!=='scene'&&e.selectedUid!==clip.target.uid)e.select(clip.target.uid);
  e._selectedVfxKey=null;e._selectedVfxClip=clip.id;e._emit('vfx-selection',{source:'timeline'});this.update();
 };
 const down=p._pointerDown;p._pointerDown=function(event){
  const hit=this._hit(event),row=this.tracks[hit.row];if(row?.kind!=='vfx'||event.button!==0)return down.call(this,event);
  event.preventDefault();this.onSeek?.();const clip=pickClip(this,hit);if(!clip){this.editor.seek(hit.tick,{allowBeyondEnd:true});return;}
  const fade=event.target.dataset.vfxFade;
  if(fade)event.target.focus({preventScroll:true});else this.scroll.focus();this._selectVfxRow(row,clip.id);if(row.locked)return;
  this.scroll.setPointerCapture(event.pointerId);
  const trim=trimEdge(this,clip,hit);
  const tick=fade||trim?undefined:pickKey(this,clip,hit);
  if(tick!==undefined){const properties=Object.keys(vfxVisibleKeys(this.editor,clip));this.editor._selectedVfxKey={id:clip.id,tick,properties};this.gesture={kind:'vfx-key',id:clip.id,from:tick,to:tick,properties,x:event.clientX};}
  else if(clip.duration!==null){const edge=fade??trim??'move';this.gesture={kind:'vfx-clip',id:clip.id,original:clip,x:event.clientX,edge,patch:{}};}
  this.update();
 };
 const move=p._pointerMove;p._pointerMove=function(event){
  const g=this.gesture;
  if(!g?.kind.startsWith('vfx')){
   const hit=this._hit(event),clip=pickClip(this,hit),tick=clip&&pickKey(this,clip,hit);
   this.scroll.title=clip?(tick!==undefined?interfaceText('vfxClipTimeline.frameValueValue1', {value: tick+clip.start-clip.offset+1, value1: Object.entries(vfxVisibleKeys(this.editor,clip)).filter(([,keys])=>keys[lowerBound(keys,tick)]?.tick===tick).map(([property])=>effectPropertyText(property,vfxDescriptor(property))).join(', ')}):name(clip)):'';
   const result=move.call(this,event);if(clip&&!g)this.scroll.style.cursor=this.tracks[hit.row].locked?'default':trimEdge(this,clip,hit)||tick!==undefined?'ew-resize':clip.duration!==null?'grab':'default';return result;
  }
  let delta=Math.round((event.clientX-g.x)/this.pxPerTick);
  if(g.kind==='vfx-key')g.to=clamp(g.from+delta,0,10000000);
  else{const c=g.original;
   if(g.edge==='move')g.patch={start:clamp(c.start+delta,0,10000000-c.duration)};
   if(g.edge==='right')g.patch={duration:clamp(c.duration+delta,1,10000000-c.start)};
   if(g.edge==='left'){delta=clamp(delta,-c.start,c.duration-1);g.patch={start:c.start+delta,duration:c.duration-delta,offset:c.offset+delta};}
   if(g.edge==='fadeIn'||g.edge==='fadeOut')g.patch={[g.edge]:clamp(c[g.edge]+delta*(g.edge==='fadeIn'?1:-1),0,c.duration)};
  }
  this.update();
 };
 const up=p._pointerUp;p._pointerUp=function(event){
  const g=this.gesture;if(!g?.kind.startsWith('vfx'))return up.call(this,event);
  this.gesture=null;if(this.scroll.hasPointerCapture(event.pointerId))this.scroll.releasePointerCapture(event.pointerId);
  this._run(()=>{if(g.kind==='vfx-key'){this.editor.moveVfxClipKeys(g.id,g.from,g.to,{properties:g.properties});this.editor._selectedVfxKey={id:g.id,tick:g.to,properties:g.properties};const clip=this.editor.getVfxClips().find(c=>c.id===g.id);this.editor.seek(Math.max(0,g.to+clip.start-clip.offset),{allowBeyondEnd:true});}else if(g.edge==='left')this.editor.trimVfxClipStart(g.id,g.patch.start??g.original.start);else this.editor.setVfxClip(g.id,g.patch);});this.update();
 };
 const key=p._keyDown;p._keyDown=function(event){
  if(!this.editor._selectedVfxClip||event.target.matches('input,select,textarea'))return key.call(this,event);
  if(this.editor._selectedVfxKey&&["ArrowLeft","ArrowRight"].includes(event.key)&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();event.stopPropagation();this._run(()=>{const k=this.editor._selectedVfxKey,to=Math.max(0,k.tick+(event.key==='ArrowRight'?1:-1)*(event.shiftKey?10:1));this.editor.moveVfxClipKeys(k.id,k.tick,to,{properties:k.properties});this.editor._selectedVfxKey={...k,tick:to};const clip=this.editor.getVfxClips().find(c=>c.id===k.id);this.editor.seek(Math.max(0,to+clip.start-clip.offset),{allowBeyondEnd:true});});this.update();return;}
  if(event.key==='Escape'){if(this.gesture)this._cancelGesture();else{this.editor._selectedVfxClip=null;this.editor._selectedVfxKey=null;this.editor._emit('vfx-selection');}event.preventDefault();return;}
  if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();this._run(()=>{const k=this.editor._selectedVfxKey;if(k){this.editor.deleteVfxClipKeys(k.id,k.tick,{properties:k.properties});this.editor._selectedVfxKey=null;}else{this.editor.deleteVfxClip(this.editor._selectedVfxClip);this.editor._selectedVfxClip=null;}});return;}
  if((event.ctrlKey||event.metaKey)&&['c','d','v'].includes(event.key.toLowerCase())){event.preventDefault();this._run(()=>{const id=this.editor._selectedVfxClip,c=this.editor.getVfxClips().find(c=>c.id===id);if(!c)return;if(event.key.toLowerCase()==='c')this.editor.copyVfxClip(id);else this.editor._selectedVfxClip=event.key.toLowerCase()==='d'?this.editor.duplicateVfxClip(id):this.editor.pasteVfxClip(c.target);this.editor._emit('vfx-selection');});return;}
  return key.call(this,event);
 };
}
