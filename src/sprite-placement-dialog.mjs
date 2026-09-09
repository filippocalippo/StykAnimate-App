import {icon} from './icons.mjs';
import {PIVOT_HANDLE_COLORS} from './canvas-interactions.mjs';

const MIN=-2147483648,MAX=2147483647;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const CSS=`
#viewport.sprite-placement #overlay{cursor:crosshair}
dialog.sprite-placement-dialog{width:min(640px,calc(100vw - 32px));max-width:640px}
.sprite-placement-dialog .dialog-head{padding:16px 20px;border-bottom:1px solid #e5e5e5}
.sprite-placement-dialog .dialog-head h2{font-size:13px}.sprite-placement-dialog .dialog-body{padding:16px 20px}
.sprite-placement-caption{margin:0 0 14px;color:#767676;font-size:11px;line-height:1.5}
.sprite-placement-fields{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:12px}
.sprite-placement-group{min-width:0}.sprite-placement-group>button{font-size:11px;padding:5px 7px;margin:0 0 6px -7px;border-radius:4px}
.sprite-placement-group>button[aria-pressed=true]{background:#e5f4ff;color:#0777c7}
.sprite-placement-dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:${PIVOT_HANDLE_COLORS.origin}}.sprite-placement-dot.end{background:${PIVOT_HANDLE_COLORS.segment}}
.sprite-placement-xy{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.sprite-placement-xy label{display:flex;align-items:center;background:#f5f5f5;border:1px solid transparent;border-radius:4px;padding:0 8px;gap:8px;font-size:10px;color:#767676;min-width:0}
.sprite-placement-xy label:focus-within{background:white;border-color:#0d99ff}
.sprite-placement-xy input{height:32px;width:100%;min-width:0;background:transparent;border:0;outline:none;font-size:11px;text-align:right;color:#2c2c2c}
.sprite-placement-preview{height:clamp(200px,43vh,350px);position:relative;background:repeating-conic-gradient(#e9e9e9 0% 25%,#fafafa 0% 50%) 0/16px 16px;border:1px solid #dedede;border-radius:5px;overflow:hidden}
.sprite-placement-preview canvas{display:block;width:100%;height:100%;touch-action:none;cursor:crosshair;outline-offset:-3px}
.sprite-placement-measurements{display:flex;justify-content:space-between;gap:10px;color:#767676;font-size:10px;margin:0 0 9px;font-variant-numeric:tabular-nums}
.sprite-placement-dialog .form-error{font-size:11px;margin:10px 0 0;line-height:1.4;color:#c23930}
.sprite-placement-dialog .dialog-actions{padding:12px 20px;border-top:1px solid #e5e5e5;margin:0}
.sprite-placement-dialog [hidden]{display:none!important}
@media(max-width:440px){.sprite-placement-fields{gap:9px}.sprite-placement-dialog .dialog-body{padding:12px}.sprite-placement-measurements{flex-wrap:wrap}}
`;

/** Native sprite anchors are signed integer image coordinates, including points outside the image. */
export function placedSpriteFigure(figure,{start,end}) {
  if(!figure||figure.segments?.length!==1||figure.image_assets?.length!==1||figure.segments[0].primitive_code!==2)
    throw new Error('Choose one imported sprite image.');
  for(const [name,point] of Object.entries({start,end})) for(const axis of ['x','y'])
    if(!Number.isInteger(point?.[axis])||point[axis]<MIN||point[axis]>MAX)throw new Error(`${name==='start'?'Origin':'End'} ${axis.toUpperCase()} must be a whole image pixel.`);
  const length=Math.hypot(end.x-start.x,end.y-start.y);
  if(!length)throw new Error('Origin and end handles must be at different positions.');
  const angle=Math.atan2(end.y-start.y,end.x-start.x);
  return {...figure,segments:[{...figure.segments[0],length,angle_rad:angle}],image_assets:[{...figure.image_assets[0],
    anchor_start:{...start},anchor_end:{...end},anchor_length:length,anchor_angle_rad:angle}]};
}

/** Placement edits a private draft; Apply resolves a sprite ready to attach to an existing handle. */
export class SpritePlacementDialog {
  constructor({dialog,content,onClose=()=>{}}) {
    Object.assign(this,{dialog,content,onClose});
    if(!document.getElementById('sprite-placement-style')){const style=document.createElement('style');style.id='sprite-placement-style';style.textContent=CSS;document.head.append(style);}
  }
  open(figure) {
    this.cancel();
    const asset=figure?.image_assets?.[0];
    if(!asset||!Number.isInteger(asset.width)||asset.width<1||!Number.isInteger(asset.height)||asset.height<1||asset.width*asset.height>16*1024*1024||
      typeof asset.data_url!=='string'||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(asset.data_url))throw new Error('Choose a decoded PNG sprite of at most 16 million pixels.');
    this.figure=figure;this.points={start:{...asset.anchor_start},end:{...asset.anchor_end}};placedSpriteFigure(figure,this.points);
    this.selected='start';this.loaded=false;this.drag=null;this.events=new AbortController();const signal=this.events.signal,session={};this.session=session;
    this.dialog.classList.add('sprite-placement-dialog');
    this.content.innerHTML=`<div class="dialog-head"><h2>Sprite placement</h2><button class="icon-button" data-sprite-close aria-label="Close sprite placement">${icon('close')}</button></div>
      <div class="dialog-body"><p class="sprite-placement-caption">${esc(figure.name||'Sprite')} · ${asset.width} × ${asset.height} px<br>Place the origin where the sprite rotates and the end where another part attaches.</p>
      <div class="sprite-placement-fields">${['start','end'].map((key,index)=>`<div class="sprite-placement-group"><button data-sprite-select="${key}" aria-pressed="${index===0}"><span class="sprite-placement-dot ${index?'end':''}"></span>${index?'End handle':'Origin handle'}</button><div class="sprite-placement-xy">${['x','y'].map(axis=>`<label>${axis.toUpperCase()}<input type="number" step="1" min="${MIN}" max="${MAX}" data-sprite-point="${key}" data-sprite-axis="${axis}" aria-label="${index?'End':'Origin'} ${axis.toUpperCase()}"></label>`).join('')}</div></div>`).join('')}</div>
      <div class="sprite-placement-measurements"><span data-sprite-angle></span><span data-sprite-length></span><span>Arrow keys · 1 px</span></div>
      <div class="sprite-placement-preview"><canvas tabindex="0" aria-label="Sprite handles. Drag a handle or use arrow keys to move it by one image pixel."></canvas></div><p class="form-error" role="alert" data-sprite-error hidden></p></div>
      <div class="dialog-actions"><button class="button" data-sprite-reset>Reset handles</button><span style="flex:1"></span><button class="button" data-sprite-close>Cancel</button><button class="button primary" data-sprite-apply disabled>Choose attachment</button></div>`;
    this.canvas=this.content.querySelector('canvas');this.error=this.content.querySelector('[data-sprite-error]');this.applyButton=this.content.querySelector('[data-sprite-apply]');
    this.content.addEventListener('click',event=>{
      if(event.target.closest('[data-sprite-close]'))return this.cancel();
      if(event.target.closest('[data-sprite-apply]'))return this.apply();
      if(event.target.closest('[data-sprite-reset]')){this.points={start:{...asset.anchor_start},end:{...asset.anchor_end}};this.fit();this.sync();return;}
      const select=event.target.closest('[data-sprite-select]');if(select){this.selected=select.dataset.spriteSelect;this.sync();this.canvas.focus();}
    },{signal});
    this.content.addEventListener('input',event=>{
      const input=event.target;if(!input.matches('[data-sprite-point]'))return;
      this.selected=input.dataset.spritePoint;this.points[this.selected][input.dataset.spriteAxis]=input.valueAsNumber;this.fit();this.sync({fields:false});
    },{signal});
    this.canvas.addEventListener('keydown',event=>{
      const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(!delta)return;
      event.preventDefault();event.stopPropagation();const point=this.points[this.selected];
      point.x=Math.max(MIN,Math.min(MAX,point.x+delta[0]));point.y=Math.max(MIN,Math.min(MAX,point.y+delta[1]));this.fit();this.sync();
    },{signal});
    this.canvas.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;const point=this.local(event),distances=['start','end'].map(key=>({key,distance:Math.hypot(point.x-this.screen(this.points[key]).x,point.y-this.screen(this.points[key]).y)})).sort((a,b)=>a.distance-b.distance);
      if(distances[0].distance>16)return;event.preventDefault();this.selected=distances[0].key;this.drag=event.pointerId;this.canvas.setPointerCapture(event.pointerId);this.canvas.focus();this.sync();
    },{signal});
    this.canvas.addEventListener('pointermove',event=>{
      if(this.drag!==event.pointerId)return;const p=this.local(event);this.points[this.selected]={x:Math.max(MIN,Math.min(MAX,Math.round((p.x-this.view.x)/this.view.scale))),y:Math.max(MIN,Math.min(MAX,Math.round((p.y-this.view.y)/this.view.scale)))};this.sync();
    },{signal});
    const endDrag=event=>{if(this.drag!==event.pointerId)return;this.drag=null;if(this.canvas.hasPointerCapture(event.pointerId))this.canvas.releasePointerCapture(event.pointerId);this.fit();this.sync();};
    this.canvas.addEventListener('pointerup',endDrag,{signal});this.canvas.addEventListener('pointercancel',endDrag,{signal});
    this.dialog.addEventListener('cancel',event=>{event.preventDefault();this.cancel();},{signal});
    this.dialog.addEventListener('close',()=>{if(this.session===session&&!this.dialog.open)this.finish(null);},{signal});
    const ownedCanvas=this.canvas;
    this.contentObserver=new MutationObserver(()=>{if(this.session===session&&!this.content.contains(ownedCanvas))this.finish(null);});
    this.contentObserver.observe(this.content,{childList:true});
    this.observer=new ResizeObserver(()=>{if(this.session===session){this.fit();this.schedule();}});this.observer.observe(this.canvas);
    const promise=new Promise(resolve=>this.resolve=resolve);
    this.dialog.showModal();this.fit();this.sync();this.canvas.focus();
    const image=new Image();this.image=image;image.src=asset.data_url;
    image.decode().then(()=>{if(this.session!==session)return;if(image.naturalWidth!==asset.width||image.naturalHeight!==asset.height)throw new Error('Sprite dimensions do not match its embedded image.');this.loaded=true;this.sync();}).catch(error=>{if(this.session!==session)return;this.loadError=error.message||'The sprite preview could not be loaded.';this.sync();});
    return promise;
  }
  local(event){const rect=this.canvas.getBoundingClientRect();return{x:event.clientX-rect.left,y:event.clientY-rect.top};}
  screen(point){return{x:this.view.x+point.x*this.view.scale,y:this.view.y+point.y*this.view.scale};}
  fit(){
    if(!this.canvas)return;const rect=this.canvas.getBoundingClientRect(),asset=this.figure.image_assets[0],points=Object.values(this.points).filter(point=>Number.isFinite(point.x)&&Number.isFinite(point.y));
    const minX=Math.min(0,...points.map(p=>p.x)),minY=Math.min(0,...points.map(p=>p.y)),maxX=Math.max(asset.width,...points.map(p=>p.x)),maxY=Math.max(asset.height,...points.map(p=>p.y));
    const scale=Math.min(Math.max(1,rect.width-44)/Math.max(1,maxX-minX),Math.max(1,rect.height-44)/Math.max(1,maxY-minY));
    this.view={scale,x:(rect.width-(maxX-minX)*scale)/2-minX*scale,y:(rect.height-(maxY-minY)*scale)/2-minY*scale};
  }
  sync({fields=true}={}){
    if(!this.session)return;let error=this.loadError||'';try{placedSpriteFigure(this.figure,this.points);}catch(value){error=value.message;}
    this.error.textContent=error;this.error.hidden=!error;this.applyButton.disabled=Boolean(error)||!this.loaded;
    for(const button of this.content.querySelectorAll('[data-sprite-select]'))button.setAttribute('aria-pressed',String(button.dataset.spriteSelect===this.selected));
    if(fields)for(const input of this.content.querySelectorAll('[data-sprite-point]'))input.value=String(this.points[input.dataset.spritePoint][input.dataset.spriteAxis]);
    const {start,end}=this.points,length=Math.hypot(end.x-start.x,end.y-start.y),angle=Math.atan2(end.y-start.y,end.x-start.x)*180/Math.PI;
    this.content.querySelector('[data-sprite-angle]').textContent=`Angle ${Number.isFinite(angle)?angle.toFixed(2):'—'}°`;
    this.content.querySelector('[data-sprite-length]').textContent=`Length ${Number.isFinite(length)?length.toFixed(2):'—'} px`;
    this.schedule();
  }
  schedule(){if(this.pending)return;this.pending=requestAnimationFrame(()=>{this.pending=0;if(this.session)this.draw();});}
  draw(){
    const canvas=this.canvas,rect=canvas.getBoundingClientRect(),dpr=Math.min(2,globalThis.devicePixelRatio||1),width=Math.max(1,Math.round(rect.width*dpr)),height=Math.max(1,Math.round(rect.height*dpr));
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);
    const asset=this.figure.image_assets[0];if(this.loaded){ctx.imageSmoothingEnabled=this.view.scale<1;ctx.drawImage(this.image,this.view.x,this.view.y,asset.width*this.view.scale,asset.height*this.view.scale);}
    const start=this.screen(this.points.start),end=this.screen(this.points.end);
    if(![start.x,start.y,end.x,end.y].every(Number.isFinite))return;
    ctx.beginPath();ctx.moveTo(start.x,start.y);ctx.lineTo(end.x,end.y);ctx.lineWidth=1;ctx.strokeStyle='#252525';ctx.setLineDash([3,3]);ctx.stroke();ctx.setLineDash([]);
    for(const [key,p,color]of[['end',end,PIVOT_HANDLE_COLORS.segment],['start',start,PIVOT_HANDLE_COLORS.origin]]){ctx.beginPath();ctx.arc(p.x,p.y,7,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();ctx.lineWidth=1.5;ctx.strokeStyle='#fff';ctx.stroke();if(this.selected===key){ctx.beginPath();ctx.arc(p.x,p.y,2.3,0,Math.PI*2);ctx.fillStyle='#000';ctx.fill();}}
  }
  apply(){if(!this.session||this.applyButton.disabled)return false;const result=placedSpriteFigure(this.figure,this.points);this.finish(result);return true;}
  cancel(){if(this.session)this.finish(null);}
  finish(result){if(!this.session)return;const resolve=this.resolve,ownsContent=this.content.contains(this.canvas);this.session=null;this.resolve=null;this.events.abort();this.observer?.disconnect();this.contentObserver?.disconnect();if(this.pending)cancelAnimationFrame(this.pending);this.pending=0;this.dialog.classList.remove('sprite-placement-dialog');if(ownsContent&&this.dialog.open)this.dialog.close();this.image=null;this.loadError='';this.onClose(result);resolve?.(result);}
  destroy(){this.cancel();}
}
