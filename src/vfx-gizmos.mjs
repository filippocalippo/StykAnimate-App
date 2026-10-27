import {objectBounds,cameraMatrix,worldToScreen} from './renderer-geometry.mjs';
import {VFX_REGISTRY} from './vfx.mjs';
import {layerVisible} from './layers.mjs';
import {isGeneratorType} from './vfx-registry.mjs';
import {canvasFont} from './ui/font-loading.mjs';
import {isMovieclip} from './movieclips.mjs';
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
/** Ephemeral canvas controls. A drag edits one stack through the normal history transaction. */
export class VfxGizmos {
 constructor({canvas,inspector,editor,getOptions,pickNativeHandle,onChange,onError}){
  Object.assign(this,{canvas,inspector,editor,getOptions,pickNativeHandle,onChange,onError});this.abort=new AbortController();this.handles=[];
  for(const [type,handler] of [['pointerdown','down'],['pointermove','move'],['pointerup','up'],['pointercancel','cancel'],['lostpointercapture','cancel']])canvas.addEventListener(type,e=>{try{this[handler](e);}catch(error){this.cancel();onError(error);}},{capture:true,signal:this.abort.signal});
  document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;if(this.drag){event.preventDefault();event.stopImmediatePropagation();this.cancel();}else if(this.editor._vfxAimPick){event.preventDefault();event.stopImmediatePropagation();this.editor._vfxAimPick=null;this.inspector.sync();this.onChange();}},{capture:true,signal:this.abort.signal});
 }
 get active(){return Boolean(this.drag);}
 /** The uids of the figures that figure `uid`'s connected effects filter together at the frame on show, or null: what the engine says of it, read again when the frame or the document changes. */
 group(options,uid){
  const held=this.groupRead,editor=this.editor;
  if(held?.geometry!==options.geometry||held.uid!==uid||held.revision!==editor.revision||held.tick!==editor.tick){
   const members=editor._shown?.vfxGroup(uid);
   this.groupRead={geometry:options.geometry,uid,revision:editor.revision,tick:editor.tick,members:members?new Set(members):null};
  }
  return this.groupRead.members;
 }
 /** What the movieclip instances among `uids` paint, content included (their geometry here is their handle alone): the engine's, read again when the frame or the document changes. */
 clipExtent(options,uids){
  const groups=[...options.geometry.objects.values()].filter(g=>g&&uids.has(g.obj.unique_id)&&isMovieclip(g.fig));
  if(!groups.length)return null;
  const key=groups.map(g=>g.obj.unique_id).join(),held=this.extentRead,editor=this.editor;
  if(held?.geometry!==options.geometry||held.key!==key||held.revision!==editor.revision||held.tick!==editor.tick)
   this.extentRead={geometry:options.geometry,key,revision:editor.revision,tick:editor.tick,rect:editor._shown?.vfxExtent(groups.map(g=>g.obj.unique_id))??null};
  return this.extentRead.rect;
 }
 control(){
  if(!this.inspector.visible)return null;
  const selected=this.inspector.selectedEffect();if(!selected||!selected.effect.enabled)return null;
  if(this.editor.dragging&&!this.drag)return null;
  const options=this.getOptions();if(options.playing||options.vfxEnabled===false)return null;
  const {target,effect}=selected,layer=this.editor.getLayer(target.kind==='scene'?'scene':this.editor.layerForUid(target.uid));if(layer?.locked)return null;
  let bounds,unit=1,map,inverse;
  if(target.kind==='scene'&&isGeneratorType(effect.type)){
   // Generated effects live in stage coordinates, not the camera image.
   bounds={x:0,y:0,width:options.report.canvas_width,height:options.report.canvas_height};map=p=>p;inverse=p=>p;
  }else if(target.kind==='scene'){
   bounds={x:0,y:0,width:options.report.canvas_width,height:options.report.canvas_height};const [a,b,c,d,e,f]=cameraMatrix({...options,view:{scale:1},cameraEnabled:true}),det=a*d-b*c;
   map=p=>({x:(d*(p.x-e)-c*(p.y-f))/det,y:(-b*(p.x-e)+a*(p.y-f))/det});inverse=p=>({x:a*p.x+c*p.y+e,y:b*p.x+d*p.y+f});
  }else{
   let items=options.geometry.drawables.filter(item=>item.obj.unique_id===target.uid);if(target.kind==='segment')items=items.filter(item=>item.seg?.segment_id===target.handleId&&item.fig?.figure_type_id===target.figureTypeId);
   const owner=options.frame.objects.find(o=>o.unique_id===target.uid),group=target.kind==='figure'?this.group(options,target.uid):null;
   // A figure that owns a connected group is measured with the figures its effects filter together.
   if(group)items=options.geometry.drawables.filter(item=>group.has(item.obj.unique_id)&&layerVisible(options.report,item.obj.unique_id));
   // A whole figure's effects cover what a movieclip instance paints; a segment's cover that segment's drawables alone.
   const clip=target.kind==='figure'?this.clipExtent(options,group?new Set([...group].filter(uid=>layerVisible(options.report,uid))):new Set([target.uid])):null;
   if(!items.length&&!clip)return null;
   bounds=items.length?objectBounds(items,{...options.resources,vfxBounds:false}):clip;
   if(items.length&&clip){const x=Math.min(bounds.x,clip.x),y=Math.min(bounds.y,clip.y);bounds={x,y,width:Math.max(bounds.x+bounds.width,clip.x+clip.width)-x,height:Math.max(bounds.y+bounds.height,clip.y+clip.height)-y};}
   unit=Math.max(.000001,Math.abs(owner?.scale??1));map=p=>p;inverse=p=>p;
  }
  const [a,b,c,d,e,f]=cameraMatrix(options),det=a*d-b*c;
  const project=p=>worldToScreen(map(p),options),unproject=p=>inverse({x:(d*(p.x-e)-c*(p.y-f))/det,y:(-b*(p.x-e)+a*(p.y-f))/det});
  return {...selected,options,bounds,unit,project,unproject};
 }
 draw(context){
  this.canvas.classList.toggle('vfx-aim-picking',Boolean(this.editor._vfxAimPick));
  this.handles=[];const control=this.control();this.controlState=control;if(!control)return;
  const {effect:{type,params:p},bounds:b,unit,project}=control,generator=isGeneratorType(type),stage=generator&&control.target.kind==='scene';
  const center={x:b.x+b.width*(p.centerX??(stage?p.x:.5)),y:b.y+b.height*(p.centerY??(stage?p.y:.5))},angle=(p.angle??0)*Math.PI/180;
  const add=(kind,point,label)=>this.handles.push({kind,point,screen:project(point),label});
  const direction=(distance,a=angle)=>({x:center.x+Math.cos(a)*distance,y:center.y+Math.sin(a)*distance});
  if(['vignette','shockwave'].includes(type)||type==='blur'&&p.mode>=2)add('center',center,'Center');
  if(['glow','bloom'].includes(type)||type==='blur'&&p.mode===0)add('radius',direction(p.radius*unit,0),'Radius');
  if(type==='outline')add('width',{x:b.x+b.width+p.width*unit,y:center.y},'Width');
  if(type==='shadow')add('offset',{x:center.x+p.offsetX*unit,y:center.y+p.offsetY*unit},'Offset');
  if(type==='blur'&&p.mode>0)add('blur',direction(p.radius*unit),'Blur');
  if(type==='rgbSplit')add('direction',direction(p.amount*unit),'Amount / angle');
  if(type==='wave'){add('wave',direction(p.wavelength*unit/2),'Wavelength / angle');add('strength',direction(p.strength*unit,angle+Math.PI/2),'Strength');}
  if(type==='shockwave')add('radius',direction(p.radius*unit,0),'Radius');
  if(type==='vignette')add('vignette',direction(b.width*.5*p.radius*p.aspect,0),'Radius');
  if(type==='pixelate'){const origin={x:b.x+p.offsetX*unit,y:b.y+p.offsetY*unit};add('grid',origin,'Grid');add('cell',{x:origin.x+p.size*unit,y:origin.y+(p.linked?p.size:p.sizeY)*unit},'Cell size');}
  if(type==='noise')add('grain',direction(p.size*unit,0),'Grain size');
  if(type==='turbulence'){add('displacement',direction(p.amount*unit,0),'Amount');add('grain',direction(p.size*unit,Math.PI/2),'Scale');}
  if(type==='dissolve')add('progress',{x:b.x+b.width*p.progress,y:b.y+b.height},'Progress');
  if(type==='lightSweep')add('sweep',{x:center.x+Math.cos(angle)*(p.position-.5)*b.width,y:center.y+Math.sin(angle)*(p.position-.5)*b.height},'Position');
  if(type==='crt')add('curvature',{x:b.x+b.width*(1-p.curvature),y:center.y},'Curvature');
  if(stage&&type!=='aura')add('center',center,'Position');
  if(type==='particles'){add('spray',direction(Math.max(18,p.speed*6),p.direction*Math.PI/180),'Direction · speed');if(p.shape===1||p.shape===3)add('emitter',direction(p.radius,p.shape===3?p.direction*Math.PI/180+Math.PI/2:0),'Emitter size');}
  if(type==='explosion')add('blast',direction(120*p.size,-Math.PI/4),'Size');
  if(type==='beam'&&!p.aimUid)add('aim',{x:p.aimX*control.options.report.canvas_width,y:p.aimY*control.options.report.canvas_height},'Aim · drop on a node to lock');
  if(!this.handles.length)return;const base=project(center);context.save();context.lineWidth=1;context.setLineDash([4,4]);context.strokeStyle='#4eb8ff';
  for(const h of this.handles){context.beginPath();context.moveTo(base.x,base.y);context.lineTo(h.screen.x,h.screen.y);context.stroke();}
  context.setLineDash([]);for(const h of this.handles){const active=this.drag?.handle.kind===h.kind;context.beginPath();context.arc(h.screen.x,h.screen.y,active?7:5.5,0,Math.PI*2);context.fillStyle=active?'#109fff':'#fff';context.fill();context.strokeStyle='#087fcc';context.lineWidth=2;context.stroke();}
  if(this.drag){const h=this.handles.find(h=>h.kind===this.drag.handle.kind);if(h){context.font=canvasFont('11px');const width=context.measureText(h.label).width+14;context.fillStyle='#173349';context.fillRect(h.screen.x+12,h.screen.y-13,width,22);context.fillStyle='#fff';context.fillText(h.label,h.screen.x+19,h.screen.y+2);}}
  context.restore();
 }
 point(event){const rect=this.canvas.getBoundingClientRect();return {x:event.clientX-rect.left,y:event.clientY-rect.top};}
 /** One click after Pick: a node or origin locks the beam, empty stage aims at that point. */
 aimPick(event){
  const pick=this.editor._vfxAimPick,options=this.getOptions(),hit=this.pickNativeHandle?.(event);
  event.preventDefault();event.stopImmediatePropagation();
  let values;
  if(hit&&hit.uid!==undefined)values={aimUid:hit.uid>>>0,aimHandle:hit.kind==='origin'?0:Number(hit.id)||0};
  else{const [a,b,c,d,e,f]=cameraMatrix(options),det=a*d-b*c,p=this.point(event),x=(d*(p.x-e)-c*(p.y-f))/det,y=(-b*(p.x-e)+a*(p.y-f))/det,R=options.report;values={aimUid:0,aimHandle:0,aimX:clamp(x/R.canvas_width,-1,2),aimY:clamp(y/R.canvas_height,-1,2)};}
  this.editor._vfxAimPick=null;this.inspector.commit();this.inspector.beforeEdit();
  this.editor.setVfxClipParameters(pick.clip,pick.effect,values);
  this.inspector.sync();this.onChange();
 }
 down(event){if(event.button!==0)return;if(this.editor._vfxAimPick){this.aimPick(event);return;}const point=this.point(event);let handle,distance=121;
  for(const h of this.handles){const d=(h.screen.x-point.x)**2+(h.screen.y-point.y)**2;if(d<distance){handle=h;distance=d;}}
  if(!handle)return;
  // VFX hit slop must not steal a nearer figure origin or joint. Resolve
  // against the app's visible native handles, including its zoom/settings.
  if((this.pickNativeHandle?.(event)?.distanceSquared??Infinity)<=distance)return;
  const control=this.control();if(!control)return;event.preventDefault();event.stopImmediatePropagation();this.inspector.commit();this.inspector.beforeEdit();const stack=control.clip?null:structuredClone(this.editor.vfxEffects(control.target));if(control.clip)this.editor.beginVfxClipEdit();else this.editor.beginAnimationEdit(control.target,'vfxStack',{exactTarget:true});this.drag={control,handle,stack,start:control.unproject(point),pointerId:event.pointerId};this.canvas.setPointerCapture(event.pointerId);this.onChange();}
 move(event){if(!this.drag)return;event.preventDefault();event.stopImmediatePropagation();const {control,handle,stack,start}=this.drag,{bounds:b,unit,effect}=control,p={...effect.params},current=control.unproject(this.point(event)),at={x:handle.point.x+current.x-start.x,y:handle.point.y+current.y-start.y},center={x:b.x+b.width*(p.centerX??.5),y:b.y+b.height*(p.centerY??.5)},dx=at.x-center.x,dy=at.y-center.y,distance=Math.hypot(dx,dy)/unit;
  const changed={};const set=(name,value)=>{const d=VFX_REGISTRY[effect.type].params[name];p[name]=clamp(d.discrete?Math.round(value):value,d.min,d.max);changed[name]=p[name];};
  if(handle.kind==='center'&&!isGeneratorType(effect.type)){set('centerX',(at.x-b.x)/b.width);set('centerY',(at.y-b.y)/b.height);}
  if(handle.kind==='radius')set('radius',distance);
  if(handle.kind==='width')set('width',(at.x-b.x-b.width)/unit);
  if(handle.kind==='offset'){set('offsetX',dx/unit);set('offsetY',dy/unit);}
  if(handle.kind==='blur'){set('radius',distance);if(p.mode===1)set('angle',Math.atan2(dy,dx)*180/Math.PI);}
  if(handle.kind==='direction'){set('amount',distance);set('angle',Math.atan2(dy,dx)*180/Math.PI);}
  if(handle.kind==='wave'){set('wavelength',distance*2);set('angle',Math.atan2(dy,dx)*180/Math.PI);}
  if(handle.kind==='strength')set('strength',distance);
  if(handle.kind==='vignette')set('radius',Math.abs(dx)/(b.width*.5*p.aspect));
  if(handle.kind==='grid'){set('offsetX',(at.x-b.x)/unit);set('offsetY',(at.y-b.y)/unit);}
  if(handle.kind==='cell'){set('size',(at.x-b.x)/unit-p.offsetX);if(!p.linked)set('sizeY',(at.y-b.y)/unit-p.offsetY);}
  if(handle.kind==='grain')set('size',distance);
  if(handle.kind==='displacement')set('amount',distance);
  if(handle.kind==='progress')set('progress',(at.x-b.x)/b.width);
  if(handle.kind==='sweep'){const angle=p.angle*Math.PI/180;set('position',.5+dx/b.width*Math.cos(angle)+dy/b.height*Math.sin(angle));}
  if(handle.kind==='curvature')set('curvature',1-(at.x-b.x)/b.width);
  if(isGeneratorType(effect.type)){
   // Generated effects measure in stage pixels regardless of figure scale.
   const reach=Math.hypot(dx,dy),R=control.options.report;
   if(handle.kind==='center'){set('x',(at.x-b.x)/b.width);set('y',(at.y-b.y)/b.height);}
   if(handle.kind==='spray'){set('direction',Math.atan2(dy,dx)*180/Math.PI);set('speed',reach/6);}
   if(handle.kind==='emitter')set('radius',reach);
   if(handle.kind==='blast')set('size',reach/120);
   if(handle.kind==='aim'){set('aimX',at.x/R.canvas_width);set('aimY',at.y/R.canvas_height);}
  }
  if(control.clip)this.editor.setVfxClipParameters(control.clip,effect.id,changed);else{const next=stack.map(item=>item.id===effect.id?{...item,version:2,params:p}:item);this.editor.previewAnimationEdit(next);}this.onChange();
 }
 up(event){if(!this.drag)return;event?.preventDefault();event?.stopImmediatePropagation();const {pointerId:id,control,handle}=this.drag;
  // Dropping a beam's aim on a node locks onto it within the same edit.
  if(handle.kind==='aim'&&event&&control.clip){const hit=this.pickNativeHandle?.(event);if(hit&&hit.uid!==undefined)this.editor.setVfxClipParameters(control.clip,control.effect.id,{aimUid:hit.uid>>>0,aimHandle:hit.kind==='origin'?0:Number(hit.id)||0});}
  this.drag=null;if(control.clip)this.editor.commitVfxClipEdit();else this.editor.commitAnimationEdit();if(this.canvas.hasPointerCapture(id))this.canvas.releasePointerCapture(id);this.inspector.sync();this.onChange();}
 cancel(){if(!this.drag)return;const {pointerId:id,control}=this.drag;this.drag=null;if(control.clip)this.editor.cancelVfxClipEdit();else this.editor.cancelAnimationEdit();if(this.canvas.hasPointerCapture(id))this.canvas.releasePointerCapture(id);this.inspector.sync();this.onChange();}
 destroy(){this.cancel();this.abort.abort();}
}
