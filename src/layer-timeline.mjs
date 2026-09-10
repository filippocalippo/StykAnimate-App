import {sheetKeyAt} from './layer-sheet.mjs';
import {initializeLayerSheet} from './editor-layer-sheet.mjs';
import {icon} from './icons.mjs';
import {showTimelineMenu} from './timeline-menu.mjs';

export const ROW=32,HEADER=32;
const MAX_SCROLL=8000000;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const element=(tag,parent,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;parent?.append(node);return node;};
/** Adobe-style exposure grid. Painting and DOM size depend only on viewport,
 * not the number of frames, layers, instances or nested clip frames. */
export class Timeline{
  constructor(container,editor,options={}){
    this.editor=editor;this.container=container;Object.assign(this,options);this.events=new AbortController();this.labels=[];this.pxPerTick=14;this.labelWidth=220;
    this.channelMode=false;this.mode='layers';this.selectedLayers=new Set([editor.activeLayerId]);this.start=this.end=Math.max(0,Math.floor(editor.tick));this.selectedTrackId=editor.activeLayerId;
    if(!editor.report._styk.layerSheet){initializeLayerSheet(editor.report);editor._invalidate({timing:true});}
    this.root=element('div',container,'layer-timeline');this.dirty=true;
    this.main=element('div',this.root,'sheet-main');const head=element('div',this.main,'sheet-label-head');element('span',head,'sheet-label-title','Layers');
    this._button(head,'eye','Show all layers',()=>this._run(()=>{for(const layer of editor.layers)if(layer.kind==='layer')editor.setLayerVisible(layer.id,true);}));
    this._button(head,'lock','Unlock all layers',()=>this._run(()=>{for(const layer of editor.layers)if(layer.kind==='layer')editor.setLayerLocked(layer.id,false);}));
    this.labelViewport=element('div',this.main,'sheet-labels');this.scroll=element('div',this.main,'sheet-scroll');this.scroll.tabIndex=0;this.scroll.setAttribute('role','grid');this.scroll.setAttribute('aria-label','Layer frames');this.scroll.setAttribute('aria-multiselectable','true');
    this.spacer=element('div',this.scroll,'sheet-spacer');this.canvas=element('canvas',this.main,'sheet-canvas');
    const overlay=element('div',this.main,'sheet-playhead-clip');this.playhead=element('div',overlay,'sheet-playhead');this.playheadLabel=element('span',this.playhead);
    this.cellAdd=this._button(this.main,'plus','Insert keyframe here',()=>{const hit=this.hover;if(hit){this._selectCell(hit);this.addTrackKey();}});this.cellAdd.classList.add('sheet-cell-add');this.cellAdd.hidden=true;
    this._on(this.cellAdd,'pointerdown',event=>event.stopPropagation());this.divider=element('div',this.main,'sheet-resize');this.divider.setAttribute('role','separator');this.divider.setAttribute('aria-label','Resize layer names');
    const footer=element('div',this.root,'sheet-footer'),layerTools=element('div',footer,'sheet-layer-tools');
    this._button(layerTools,'plus','New layer',()=>this.newLayer());this.deleteLayerButton=this._button(layerTools,'trash','Delete layer',()=>this.deleteLayer());
    this._button(layerTools,'chevron-up','Move layer up',()=>this.reorderLayer(-1)).classList.add('sheet-layer-reorder');this._button(layerTools,'chevron-down','Move layer down',()=>this.reorderLayer(1)).classList.add('sheet-layer-reorder');
    const frameTools=element('div',footer,'sheet-frame-tools');
    this.keyButton=this._button(frameTools,'circle','Insert keyframe (F6)',()=>this.addTrackKey());this.keyButton.classList.add('sheet-key-icon');
    this.duplicateFrameButton=this._button(frameTools,'duplicate','Duplicate frame after current (Ctrl+Enter)',()=>this.duplicateFrameAfter());
    this.extendButton=this._button(frameTools,'plus','Insert frame (F5)',()=>this.insertFrames());
    element('span',frameTools,'divider');this.easing=element('select',frameTools,'inline-select');this.easing.setAttribute('aria-label','Frame interpolation');
    for(const [value,label] of [['constant','Hold'],['linear','Linear'],['ease-in','Ease in'],['ease-out','Ease out'],['bezier','Ease in / out'],['auto','Auto']]){const option=element('option',this.easing,'',label);option.value=value;}
    this._on(this.easing,'change',()=>this._run(()=>editor.sheetSetEasing(this.ids,this.start,this.end,{interpolation:this.easing.value,...(this.easing.value==='bezier'?{bezier:[.42,0,.58,1]}:{})})));
    const position=element('div',footer,'sheet-position');
    this._button(position,'chevron-left','Previous keyframe',()=>this.jumpKey(-1));this._button(position,'chevron-right','Next keyframe',()=>this.jumpKey(1));
    const field=element('label',position,'field');element('span',field,'','Frame');this.frameInput=element('input',field);this.frameInput.type='number';this.frameInput.min='1';this.frameInput.max=String(10000000);this.frameInput.setAttribute('aria-label','Go to frame');
    this._on(this.frameInput,'change',()=>this._run(()=>{this.seek(Number(this.frameInput.value)-1);this.revealPlayhead();}));this._on(this.frameInput,'keydown',event=>event.stopPropagation());
    this.zoomInput=element('input',footer,'sheet-zoom');this.zoomInput.type='range';this.zoomInput.min='6';this.zoomInput.max='36';this.zoomInput.value='14';this.zoomInput.setAttribute('aria-label','Timeline zoom');this._on(this.zoomInput,'input',()=>this.setZoom(Number(this.zoomInput.value)));
    this._button(footer,'more','Timeline options',event=>this._menu(event,{view:true}));
    this.live=element('div',this.root,'sheet-live');this.live.setAttribute('role','status');this.live.setAttribute('aria-live','polite');
    this._on(this.scroll,'scroll',()=>this.update());this._on(this.scroll,'pointerdown',event=>this._pointerDown(event));this._on(this.scroll,'pointermove',event=>this._pointerMove(event));this._on(this.scroll,'pointerup',event=>this._pointerUp(event));this._on(this.scroll,'pointercancel',()=>this._cancelGesture());this._on(this.scroll,'lostpointercapture',()=>this._cancelGesture());
    this._on(this.scroll,'contextmenu',event=>{event.preventDefault();const hit=this._hit(event);if(hit.row<0||!this.tracks[hit.row])return this._menu(event,{view:true});if(!this._contains(hit))this._selectCell(hit);this._menu(event);});
    this._on(this.scroll,'dblclick',event=>this._doubleClick(event));
    this._on(this.main,'pointerleave',()=>{if(!this.gesture){this.hover=null;this.update();}});
    this._on(this.scroll,'keydown',event=>this._keyDown(event));this._on(this.labelViewport,'wheel',event=>{event.preventDefault();this.scroll.scrollTop+=event.deltaY;},{passive:false});
    this._on(this.scroll,'wheel',event=>{if(event.ctrlKey||event.metaKey){event.preventDefault();this.setZoom(clamp(this.pxPerTick*(event.deltaY<0?1.15:.87),6,36));}else if(event.shiftKey){event.preventDefault();this.scroll.scrollLeft+=event.deltaY||event.deltaX;}},{passive:false});
    this._on(this.divider,'pointerdown',event=>{this._columnDrag={x:event.clientX,width:this.labelWidth};this.divider.setPointerCapture(event.pointerId);});
    this._on(this.divider,'pointermove',event=>{if(this._columnDrag){this.labelWidth=clamp(this._columnDrag.width+event.clientX-this._columnDrag.x,140,420);this.root.style.setProperty('--sheet-label',`${this.labelWidth}px`);this.resize();}});this._on(this.divider,'pointerup',()=>{this._columnDrag=null;});
    this._on(editor,'change',event=>{const d=event.detail??{};if(d.kind==='document'||d.structural||d.layers||d.timing||d.layerSheet)this._reindex();
      if(d.kind==='selection'&&!d.sheetSelection&&editor.object){this.selectedTrackId=editor.layerForUid(editor.selectedUid);this.selectedLayers=new Set([this.selectedTrackId]);}
      if(d.kind==='seek'&&!this.gesture&&!this.selecting){this.start=this.end=Math.floor(editor.tick);}this.update(d.kind!=='seek'||!this.paused&&this.gesture?.kind!=='scrub');});
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(this.root);this._reindex();this.resize();
  }
  _on(target,name,fn,options={}){target.addEventListener(name,fn,{...options,signal:this.events.signal});}
  _button(parent,name,title,action){const button=element('button',parent,'icon-button');button.type='button';button.innerHTML=icon(name);button.title=title;button.setAttribute('aria-label',title);this._on(button,'click',event=>{this._run(()=>action(event));if(!this.menu)this.scroll?.focus({preventScroll:true});});return button;}
  _run(operation){try{this.onSeek?.();return operation();}catch(error){this.live.textContent=error.message;this.onError?.(error);return false;}}
  get ids(){return [...this.selectedLayers].filter(id=>this.editor.getLayer(id));}
  get selectedTicks(){return [...new Set([this.start,...this.ids.flatMap(id=>this.editor.layerFrameKeys(id).filter(k=>k.tick>this.start&&k.tick<=this.end).map(k=>k.tick))])].sort((a,b)=>a-b);}
  get selectedTimeRange(){return {start:this.start,end:this.end+1};}
  get selectedFrameIndices(){return this.editor.timeline.filter(row=>row.start>=this.start&&row.start<=this.end).map(row=>row.index);}
  get selectedAnimationKeys(){return [];}
  get loopRange(){return this.end>this.start?{start:this.start,end:this.end+1}:null;}
  _reindex(){
    if(!this.editor.report._styk.layerSheet){initializeLayerSheet(this.editor.report);this.editor._invalidate({timing:true});}
    this.tracks=[...['camera','scene'].map(id=>this.editor.getLayer(id)),...this.editor.layers.filter(l=>l.kind==='layer').reverse()];
    this.trackById=new Map(this.tracks.map(layer=>[layer.id,{...layer,target:layer.kind==='layer'?{kind:'layer',id:layer.id}:{kind:layer.kind},keys:this.editor.layerFrameKeys(layer.id)}]));
    if(!this.editor.getLayer(this.selectedTrackId))this.selectedTrackId=this.editor.activeLayerId;
    this.selectedLayers=new Set([...this.selectedLayers].filter(id=>this.editor.getLayer(id)));if(!this.selectedLayers.size)this.selectedLayers.add(this.selectedTrackId);
    this.labelSignature=null;this.dirty=true;
    this.scroll.setAttribute('aria-rowcount',String(this.tracks.length));this.scroll.setAttribute('aria-colcount',String(this.editor.report._styk.layerSheet.duration));this._extent();
  }
  _extent(){
    if(!this.main)return;this.width=Math.max(1,this.main.clientWidth-this.labelViewport.clientWidth);this.height=Math.max(1,this.main.clientHeight);
    this.logicalWidth=Math.max(this.width,(Math.max(this.editor.totalTicks,this.end+1)+60)*this.pxPerTick);this.logicalHeight=Math.max(this.height,HEADER+this.tracks.length*ROW);
    const width=`${Math.min(MAX_SCROLL,this.logicalWidth)}px`,height=`${Math.min(MAX_SCROLL,this.logicalHeight)}px`;
    if(this.spacer.style.width!==width)this.spacer.style.width=width;if(this.spacer.style.height!==height)this.spacer.style.height=height;
  }
  _offsetX(){const actual=Math.max(0,this.scroll.scrollWidth-this.scroll.clientWidth);return actual?this.scroll.scrollLeft/actual*Math.max(0,this.logicalWidth-this.scroll.clientWidth):0;}
  _offsetY(){return this.scroll.scrollTop;}
  _scrollToX(x){const max=this.logicalWidth-this.scroll.clientWidth;this.scroll.scrollLeft=max>0?clamp(x,0,max)/max*(this.scroll.scrollWidth-this.scroll.clientWidth):0;this.update();}
  _scrollToY(y){this.scroll.scrollTop=y;this.update();}
  resize(){
    this._extent();const ratio=window.devicePixelRatio||1,width=Math.round(this.width*ratio),height=Math.round(this.height*ratio);
    if(this.canvas.width!==width||this.canvas.height!==height){this.canvas.width=width;this.canvas.height=height;this.canvas.style.width=`${this.width}px`;this.canvas.style.height=`${this.height}px`;}
    const css=getComputedStyle(this.root),color=name=>css.getPropertyValue(`--sheet-${name}`).trim();
    this.colors=Object.fromEntries(['surface','hover','line','ink','muted','accent','selected','span','tween'].map(name=>[name,color(name)]));this.font=css.fontFamily;
    this.update();
  }
  setZoom(value){const old=this.pxPerTick,center=(this._offsetX()+this.width/2)/old;this.pxPerTick=clamp(Number(value)||14,6,36);this.zoomInput.value=String(this.pxPerTick);this._extent();this._scrollToX(center*this.pxPerTick-this.width/2);}
  setPaused(value){const resumed=this.paused&&!value;this.paused=value;this.update(Boolean(resumed));}
  update(dirty=true){
    this.dirty||=dirty;if(this.disposed||this.raf)return;
    this.raf=requestAnimationFrame(()=>{this._flushScrub();if(this.dirty){this.dirty=false;this._paint();}this._syncPlayhead();this.raf=null;});
  }
  render(){this.update();}
  _syncPlayhead(){
    const tick=Math.floor(this.editor.tick),x=(tick+.5)*this.pxPerTick-this._offsetX();this.playhead.style.transform=`translateX(${x}px)`;
    if(this.playheadLabel.textContent!==String(tick+1))this.playheadLabel.textContent=String(tick+1);
    if(document.activeElement!==this.frameInput&&this.frameInput.value!==String(tick+1))this.frameInput.value=String(tick+1);
  }
  _paint(){
    this._extent();const ctx=this.canvas.getContext('2d'),dpr=window.devicePixelRatio||1,step=this.pxPerTick,sx=this._offsetX(),sy=this._offsetY(),w=this.width,h=this.height,c=this.colors;
    if(!c)return;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.fillStyle=c.surface;ctx.fillRect(0,0,w,h);
    const first=Math.floor(sx/step),last=Math.ceil((sx+w)/step),firstRow=Math.max(0,Math.floor(sy/ROW)),lastRow=Math.min(this.tracks.length,Math.ceil((sy+h-HEADER)/ROW)),state=this.editor.report._styk.layerSheet;
    ctx.save();ctx.beginPath();ctx.rect(0,HEADER,w,h-HEADER);ctx.clip();
    for(let index=firstRow;index<lastRow;index++){
      const layer=this.tracks[index],track=state.tracks[layer.id],y=HEADER+index*ROW-sy,selected=this.selectedLayers.has(layer.id);
      const rowAccent=layer.kind==='camera'?'#1689ee':layer.kind==='scene'?'#8753c7':null;
      const rowTint=layer.kind==='camera'?'#e8f3ff':layer.kind==='scene'?'#f1eafb':null;
      if(track)for(let i=Math.max(0,sheetKeyAt(track,first).index);i<track.keys.length;i++){
        const key=track.keys[i],next=track.keys[i+1],end=next?.tick??track.end;if(key.tick>last)break;if(end<=first)continue;
        const left=Math.max(-6,key.tick*step-sx+1),right=Math.min(w+6,end*step-sx-1),blank=key.empty||key.value?.frameId===null,tween=next&&!blank&&next.value?.frameId!==null&&!['hold','constant'].includes(key.interpolation);
        ctx.fillStyle=blank?c.surface:rowTint??(tween?c.tween:c.span);ctx.beginPath();ctx.roundRect(left,y+5,Math.max(0,right-left),ROW-10,4);ctx.fill();
        if(tween&&right-left>32){ctx.strokeStyle=c.accent;ctx.globalAlpha=.55;ctx.beginPath();ctx.moveTo(left+13,y+ROW/2);ctx.lineTo(right-7,y+ROW/2);ctx.lineTo(right-11,y+ROW/2-3);ctx.moveTo(right-7,y+ROW/2);ctx.lineTo(right-11,y+ROW/2+3);ctx.stroke();ctx.globalAlpha=1;}
        if(!blank&&end-key.tick>1){ctx.fillStyle=c.muted;ctx.globalAlpha=.55;ctx.fillRect(end*step-sx-4,y+12,2,8);ctx.globalAlpha=1;}
      }
      if(selected){ctx.fillStyle=rowTint??c.selected;ctx.globalAlpha=.65;ctx.fillRect(this.start*step-sx,y+1,(this.end-this.start+1)*step,ROW-2);ctx.globalAlpha=1;}
      if(this.hover?.row===index&&!this.gesture){ctx.fillStyle=c.accent;ctx.globalAlpha=.07;ctx.fillRect(this.hover.tick*step-sx,y+1,step,ROW-2);ctx.globalAlpha=1;}
      ctx.lineWidth=1;ctx.strokeStyle=c.line;ctx.beginPath();
      for(let tick=first;tick<=last;tick++){const x=Math.round(tick*step-sx)+.5;ctx.moveTo(x,y);ctx.lineTo(x,y+ROW);}ctx.moveTo(0,y+ROW-.5);ctx.lineTo(w,y+ROW-.5);ctx.stroke();
      if(track)for(let i=Math.max(0,sheetKeyAt(track,first).index);i<track.keys.length;i++){
        const key=track.keys[i];if(key.tick>last)break;if(key.tick<first||key.empty||key.value?.frameId===null)continue;const x=(key.tick+.5)*step-sx;
        ctx.beginPath();ctx.arc(x,y+ROW/2,Math.min(3.5,step/3),0,Math.PI*2);ctx.fillStyle=rowAccent??c.ink;ctx.fill();
      }
      if(selected){ctx.strokeStyle=rowAccent??c.accent;ctx.strokeRect(this.start*step-sx+.5,y+.5,(this.end-this.start+1)*step-1,ROW-1);}
      if(layer.locked){ctx.fillStyle=c.surface;ctx.globalAlpha=.45;ctx.fillRect(0,y,w,ROW);ctx.globalAlpha=1;}
    }
    const g=this.gesture;
    if(g?.kind==='move'&&(g.delta||g.rowDelta)||g?.kind==='resize'){
      ctx.strokeStyle=c.accent;ctx.lineWidth=2;ctx.setLineDash([4,3]);
      for(const id of this.ids){const row=this.tracks.findIndex(t=>t.id===id)+(g.rowDelta??0),start=g.kind==='resize'?g.span.start:this.start+(g.delta??0),end=g.kind==='resize'?g.span.end+g.delta:this.end+1+(g.delta??0);
        ctx.strokeRect(start*step-sx+1,HEADER+row*ROW-sy+1,(end-start)*step-2,ROW-2);}
      ctx.setLineDash([]);
    }
    ctx.restore();ctx.fillStyle=c.surface;ctx.fillRect(0,0,w,HEADER);ctx.strokeStyle=c.line;ctx.beginPath();ctx.moveTo(0,HEADER-.5);ctx.lineTo(w,HEADER-.5);ctx.stroke();
    ctx.font=`10px ${this.font}`;ctx.textAlign='center';ctx.textBaseline='middle';
    const interval=step<9?10:5;for(let tick=first;tick<=last;tick++){const x=(tick+.5)*step-sx;if(tick===0||(tick+1)%interval===0){ctx.fillStyle=c.muted;ctx.fillText(String(tick+1),x,14);ctx.fillStyle=c.line;ctx.fillRect(Math.round(x),25,1,4);}}
    this._paintLabels(firstRow,lastRow,sy);this._paintHover(sx,sy);
    const key=sheetKeyAt(state.tracks[this.selectedTrackId],this.start).key,value=key?.interpolation==='hold'?'constant':key?.interpolation??'constant';
    if(document.activeElement!==this.easing)this.easing.value=value;
    const locked=this.ids.some(id=>this.editor.getLayer(id)?.locked);for(const button of [this.keyButton,this.extendButton,this.duplicateFrameButton])button.disabled=locked;
    this.deleteLayerButton.disabled=locked||this.editor.report._styk.layers.order.length<2||this.editor.getLayer(this.selectedTrackId)?.kind!=='layer';
    this.easing.disabled=locked||!key;
  }
  _paintHover(sx,sy){
    const hit=this.hover,layer=this.tracks[hit?.row],track=this.editor.report._styk.layerSheet.tracks[layer?.id],key=sheetKeyAt(track,hit?.tick).key;
    this.cellAdd.hidden=!hit||!layer||!this._contains(hit)||this.start!==this.end||layer.locked||Boolean(this.gesture)||key?.tick===hit.tick||this._resizeHit(hit)||this.pxPerTick<12;
    if(!this.cellAdd.hidden){this.cellAdd.style.left=`${this.labelViewport.clientWidth+(hit.tick+.5)*this.pxPerTick-sx-7}px`;this.cellAdd.style.top=`${HEADER+hit.row*ROW-sy+17}px`;}
  }
  _paintLabels(first,last,sy){
    const signature=[first,last,sy,this.editor.layerRevision,this.editor.activeLayerId,...this.ids].join(':');if(signature===this.labelSignature)return;this.labelSignature=signature;
    for(let slot=0;slot<last-first;slot++){
      let node=this.labels[slot];if(!node){
        node=element('div',this.labelViewport,'sheet-layer');node.setAttribute('role','row');
        const name=this._button(node,'layers','Select layer',event=>this._selectLayer(node._id,event));name.classList.add('sheet-layer-name');element('span',name);
        this._on(name,'dblclick',event=>{event.stopPropagation();this._renameLayer(node);});
        const eye=this._button(node,'eye','Toggle layer visibility',()=>this.editor.setLayerVisible(node._id,!this.editor.getLayer(node._id).visible));eye.classList.add('sheet-layer-state');
        const lock=this._button(node,'lock','Toggle layer lock',()=>this.editor.setLayerLocked(node._id,!this.editor.getLayer(node._id).locked));lock.classList.add('sheet-layer-state');
        name.draggable=true;this._on(name,'dragstart',event=>{this.dragLayer=node._id;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',node._id);});
        this._on(node,'dragover',event=>{if(this.dragLayer){event.preventDefault();node.dataset.drop='true';}});this._on(node,'dragleave',()=>delete node.dataset.drop);
        this._on(node,'drop',event=>{event.preventDefault();delete node.dataset.drop;const from=this.dragLayer;this.dragLayer=null;if(from&&from!==node._id)this._run(()=>this.editor.moveLayerTo(from,this.editor.report._styk.layers.order.indexOf(node._id)));});
        this._on(name,'dragend',()=>{this.dragLayer=null;for(const label of this.labels)delete label.dataset.drop;});
        node._name=name;node._eye=eye;node._lock=lock;this._on(node,'contextmenu',event=>{event.preventDefault();this._selectLayer(node._id,event);this._menu(event,{layer:true});});this.labels.push(node);
      }
      const layer=this.tracks[first+slot];node.hidden=false;node._id=layer.id;node.dataset.layerId=layer.id;node.dataset.selected=String(this.selectedLayers.has(layer.id));node.dataset.active=String(layer.id===this.editor.activeLayerId);node.style.transform=`translateY(${(first+slot)*ROW-sy}px)`;
      node.dataset.kind=layer.kind;node.setAttribute('aria-selected',node.dataset.selected);
      if(node._kind!==layer.kind){node._name.innerHTML=icon(layer.kind==='camera'?'camera':layer.kind==='scene'?'scene':'layers')+'<span></span>';node._kind=layer.kind;}
      node._name.draggable=layer.kind==='layer';
      node._name.lastChild.textContent=layer.name;node._name.title=layer.name;node._name.setAttribute('aria-label',`Select layer ${layer.name}`);
      node._eye.dataset.on=String(!layer.visible);node._eye.innerHTML=icon(layer.visible?'eye':'eye-off');node._eye.setAttribute('aria-label',`${layer.visible?'Hide':'Show'} ${layer.name}`);node._eye.title=`${layer.visible?'Hide':'Show'} ${layer.name}`;
      node._lock.dataset.on=String(layer.locked);node._lock.setAttribute('aria-label',`${layer.locked?'Unlock':'Lock'} ${layer.name}`);node._lock.title=`${layer.locked?'Unlock':'Lock'} ${layer.name}`;
    }
    for(let slot=last-first;slot<this.labels.length;slot++)this.labels[slot].hidden=true;
  }
  _selectLayer(id,event={}){
    if(typeof id==='object')id=id._id;
    if(event.shiftKey){const a=this.tracks.findIndex(t=>t.id===this.selectedTrackId),b=this.tracks.findIndex(t=>t.id===id);this.selectedLayers=new Set(this.tracks.slice(Math.min(a,b),Math.max(a,b)+1).map(t=>t.id));}
    else if(event.ctrlKey||event.metaKey){this.selectedLayers.has(id)?this.selectedLayers.delete(id):this.selectedLayers.add(id);if(!this.selectedLayers.size)this.selectedLayers.add(id);}
    else this.selectedLayers=new Set([id]);
    this.selectedTrackId=id;this.editor.selectSheetLayer(id,{contents:id!=='camera'});this.onTrackSelect?.(this.trackById.get(id));this.update();
  }
  selectTrack(id){if(id?.startsWith('figure:'))id=this.editor.layerForUid(Number(id.slice(7)));if(this.trackById.has(id)){this.selectedTrackId=id;this.selectedLayers=new Set([id]);this.update();}}
  _renameLayer(node){const layer=this.editor.getLayer(node._id);if(layer.kind!=='layer')return;const input=element('input',node,'sheet-layer-rename');input.value=layer.name;node._name.hidden=true;input.focus();input.select();let done=false;
    const finish=save=>{if(done)return;done=true;if(save&&input.value!==layer.name)this._run(()=>this.editor.renameLayer(layer.id,input.value));input.remove();node._name.hidden=false;this.update();};input.addEventListener('blur',()=>finish(true),{once:true});input.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Enter')finish(true);if(event.key==='Escape')finish(false);});}
  _hit(event){const rect=this.scroll.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;return {tick:clamp(Math.floor((x+this._offsetX())/this.pxPerTick),0,9999999),row:y<HEADER?-1:Math.floor((y-HEADER+this._offsetY())/ROW),x,y};}
  _contains(hit){return hit.row>=0&&this.selectedLayers.has(this.tracks[hit.row]?.id)&&hit.tick>=this.start&&hit.tick<=this.end;}
  _selectCell(hit,{extend=false,notify=true}={}){
    const layer=this.tracks[hit.row];if(!layer)return;const changed=this.selectedTrackId!==layer.id,anchor=this.anchor??{tick:this.start,row:this.tracks.findIndex(l=>l.id===this.selectedTrackId)};
    if(extend){this.start=Math.min(anchor.tick,hit.tick);this.end=Math.max(anchor.tick,hit.tick);this.selectedLayers=new Set(this.tracks.slice(Math.min(anchor.row,hit.row),Math.max(anchor.row,hit.row)+1).map(l=>l.id));}
    else{this.start=this.end=hit.tick;this.selectedLayers=new Set([layer.id]);this.anchor={tick:hit.tick,row:hit.row};}
    this.selectedTrackId=layer.id;
    if(this.editor._sheetSelection?.id!==layer.id)this.editor.selectSheetLayer(layer.id,{contents:layer.id!=='camera'});
    this.selecting=true;try{if(this.editor.tick!==hit.tick)this.editor.seek(hit.tick,{allowBeyondEnd:true});}finally{this.selecting=false;}
    if(notify||changed)this.onTrackSelect?.(this.trackById.get(layer.id));this.live.textContent=`${layer.name}, frame ${this.start+1}${this.end>this.start?` to ${this.end+1}`:''}`;this.update();
  }
  _doubleClick(event){
    const hit=this._hit(event),layer=this.tracks[hit.row];if(!layer)return;
    const track=this.editor.report._styk.layerSheet.tracks[layer.id],{key,next}=sheetKeyAt(track,hit.tick);
    if(key?.tick!==hit.tick){this._selectCell(hit);this.addTrackKey();}
    else{this.start=key.tick;this.end=(next?.tick??track.end)-1;this.anchor={tick:key.tick,row:hit.row};this.onRangeChange?.(this.selectedFrameIndices);this.update();}
  }
  _resizeHit(hit){
    if(!hit||this.ids.length!==1||!this.selectedLayers.has(this.tracks[hit.row]?.id)||this.tracks[hit.row]?.locked)return null;
    const id=this.tracks[hit.row].id,track=this.editor.report._styk.layerSheet.tracks[id],{key,next}=sheetKeyAt(track,this.start);
    if(!key)return null;const end=next?.tick??track.end;
    return Math.abs(hit.x+this._offsetX()-end*this.pxPerTick)<4?{id,start:key.tick,end}:null;
  }
  _flushScrub(){
    const tick=this.pendingScrub;this.pendingScrub=null;
    if(tick!==undefined&&tick!==null&&tick!==this.editor.tick){this.editor.seek(tick,{evaluate:false,allowBeyondEnd:true});this.onScrub?.(tick);}
    if(this.pendingCell){const hit=this.pendingCell;this.pendingCell=null;this._selectCell(hit,{extend:true,notify:false});}
  }
  _pointerDown(event){
    if(event.button!==0)return;this.onSeek?.();const hit=this._hit(event);if(hit.row>=this.tracks.length)return;
    this.scroll.setPointerCapture(event.pointerId);this.scroll.focus({preventScroll:true});this.cellAdd.hidden=true;
    if(hit.row<0){this.gesture={kind:'scrub',pointer:event.pointerId};this.onScrubStart?.();this.pendingScrub=hit.tick;this.update(false);event.preventDefault();return;}
    const span=this._resizeHit(hit),layer=this.tracks[hit.row],key=sheetKeyAt(this.editor.report._styk.layerSheet.tracks[layer.id],hit.tick).key;
    if(span&&!event.shiftKey&&!event.altKey){this.gesture={kind:'resize',span,hit,pointer:event.pointerId,x:event.clientX,y:event.clientY,delta:0};event.preventDefault();return;}
    const selected=this._contains(hit),move=!event.shiftKey&&!layer.locked&&(selected||key?.tick===hit.tick);
    this.gesture={kind:move?'move':'select',pointer:event.pointerId,hit,x:event.clientX,y:event.clientY,delta:0,rowDelta:0,copy:event.altKey};
    if(!selected||event.shiftKey)this._selectCell(hit,{extend:event.shiftKey});event.preventDefault();
  }
  _pointerMove(event){
    const hit=this._hit(event),g=this.gesture;
    if(!g){
      const resize=this._resizeHit(hit);this.scroll.style.cursor=hit.row<0?'ew-resize':resize?'ew-resize':'default';
      if(this.hover?.tick!==hit.tick||this.hover?.row!==hit.row||Boolean(resize)!==this.hoverResize){this.hover=hit;this.hoverResize=Boolean(resize);this.update();}return;
    }
    if(g.kind==='scrub'){this.pendingScrub=hit.tick;this.update(false);}
    else if(g.kind==='select'){if(Math.abs(event.clientX-g.x)+Math.abs(event.clientY-g.y)>4){this.pendingCell={...hit,row:clamp(hit.row,0,this.tracks.length-1)};this.update();}}
    else if(g.kind==='resize'){g.delta=Math.max(g.span.start+1-g.span.end,Math.round((event.clientX-g.x)/this.pxPerTick));this.update();}
    else if(Math.abs(event.clientX-g.x)+Math.abs(event.clientY-g.y)>4){g.delta=Math.max(-this.start,hit.tick-g.hit.tick);g.rowDelta=clamp(hit.row,0,this.tracks.length-1)-g.hit.row;this.update();}
    const rect=this.scroll.getBoundingClientRect();if(event.clientX>rect.right-20)this.scroll.scrollLeft+=12;if(event.clientX<rect.left+20)this.scroll.scrollLeft-=12;
  }
  _pointerUp(event){
    const g=this.gesture;if(!g)return;this._flushScrub();this.gesture=null;
    if(g.kind==='resize'&&g.delta)this._run(()=>this.editor.sheetSetDuration(g.span.end+g.delta-g.span.start,g.span.id,g.span.start));
    else if(g.kind==='move'&&(g.delta||g.rowDelta)){
      const destinations=this.ids.map(id=>this.tracks[this.tracks.findIndex(t=>t.id===id)+g.rowDelta]?.id);
      const done=this._run(()=>{
        if(destinations.some(id=>!id))throw new Error('Choose destination layers inside the timeline.');
        const containsKeys=this.ids.some(id=>this.editor.layerFrameKeys(id).some(k=>k.tick>=this.start&&k.tick<=this.end));
        return g.rowDelta||!containsKeys?this.editor.sheetTransferFrames(this.ids,destinations,this.start,this.end,this.start+g.delta,{copy:g.copy}):this.editor.sheetMoveFrames(this.ids,this.start,this.end,g.delta,{copy:g.copy});
      });
      if(done){this.selectedLayers=new Set(destinations);this.selectedTrackId=destinations[0];this.start+=g.delta;this.end+=g.delta;this.editor.selectSheetLayer(destinations[0]);this.selecting=true;try{this.editor.seek(this.start,{allowBeyondEnd:true});}finally{this.selecting=false;}}
    }else if(g.kind==='move')this._selectCell(g.hit);
    if(g.kind==='scrub'){this.start=this.end=Math.floor(this.editor.tick);this.onScrubEnd?.();}
    if(this.scroll.hasPointerCapture(event.pointerId))this.scroll.releasePointerCapture(event.pointerId);
    this.onRangeChange?.(this.selectedFrameIndices);this.update();
  }
  _cancelGesture(){if(this.gesture?.kind==='scrub')this.onScrubEnd?.();this.gesture=null;this.pendingScrub=null;this.pendingCell=null;this.update();}
  seek(tick){if(!Number.isInteger(tick)||tick<0)throw new Error('Choose a valid frame.');this.onSeek?.();this.start=this.end=tick;this.editor.seek(tick,{allowBeyondEnd:true});this.update();}
  revealPlayhead(){const x=this.editor.tick*this.pxPerTick,left=this._offsetX();if(x<left)this._scrollToX(x);else if(x>left+this.width-30)this._scrollToX(x-this.width+60);}
  jumpKey(direction){const keys=this.editor.layerFrameKeys(this.selectedTrackId),tick=direction<0?[...keys].reverse().find(k=>k.tick<this.editor.tick)?.tick:keys.find(k=>k.tick>this.editor.tick)?.tick;if(tick!==undefined){this.seek(tick);this.revealPlayhead();}}
  addTrackKey(){return this._run(()=>this.editor.sheetInsertKey(this.ids,this.start));}
  duplicateFrameAfter(){return this._run(()=>{const result=this.editor.sheetDuplicateFrameAfter(this.ids);this.start=this.end=this.editor.tick;this.revealPlayhead();return result;});}
  insertFrames(){return this._run(()=>this.editor.sheetInsertFrames(this.ids,this.start,this.end-this.start+1));}
  clearKeys(){return this.end>0?this._run(()=>this.editor.sheetClearKeys(this.ids,Math.max(1,this.start),this.end)):false;}
  removeFrames(){return this._run(()=>this.editor.sheetRemoveFrames(this.ids,this.start,this.end));}
  copySelection(){return this._run(()=>this.editor.sheetCopyFrames(this.ids,this.start,this.end));}
  cutSelection(){return this._run(()=>{this.editor.sheetCopyFrames(this.ids,this.start,this.end);return this.editor.sheetRemoveFrames(this.ids,this.start,this.end);});}
  pasteSelection(){return this._run(()=>this.editor.sheetPasteFrames(this.ids,this.start));}
  selectAll(){this.selectedLayers=new Set(this.tracks.map(t=>t.id));this.start=0;this.end=this.editor.totalTicks-1;this.update();}
  newLayer(){return this._run(()=>{const layer=this.editor.createLayer();this._reindex();this._selectLayer(layer.id);return layer;});}
  deleteLayer(){return this._run(()=>this.editor.deleteLayer(this.selectedTrackId));}
  reorderLayer(direction){const order=this.editor.report._styk.layers.order,index=order.indexOf(this.selectedTrackId);if(index>=0)return this._run(()=>this.editor.moveLayerTo(this.selectedTrackId,clamp(index-direction,0,order.length-1)));}
  _keyDown(event){const control=event.ctrlKey||event.metaKey;let action;
    if(event.key==='Escape'){this._cancelGesture();this.menu?.remove();event.preventDefault();return;}
    if(event.key==='F5')action=event.shiftKey?'removeFrames':'insertFrames';if(event.key==='F6')action=event.shiftKey?'clearKeys':'addTrackKey';
    if(control&&event.key==='Enter')action='duplicateFrameAfter';
    if(event.key==='Delete'||event.key==='Backspace')action='removeFrames';
    if(control)action=({c:'copySelection',x:'cutSelection',v:'pasteSelection',a:'selectAll'})[event.key.toLowerCase()]??action;
    if(control&&['z','y'].includes(event.key.toLowerCase())){this._run(()=>event.key.toLowerCase()==='y'||event.shiftKey?this.editor.redo():this.editor.undo());event.preventDefault();event.stopPropagation();return;}
    if(action){event.preventDefault();event.stopPropagation();this[action]();return;}
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();event.stopPropagation();const row=this.tracks.findIndex(t=>t.id===this.selectedTrackId),hit={row:clamp(row+(event.key==='ArrowUp'?-1:event.key==='ArrowDown'?1:0),0,this.tracks.length-1),tick:Math.max(0,this.editor.tick+(event.key==='ArrowLeft'?-1:event.key==='ArrowRight'?1:0))};this._selectCell(hit,{extend:event.shiftKey});this.revealPlayhead();}
  }
  _menu(event,{layer=false,view=false}={}){
    const editor=this.editor,selected=editor.getLayer(this.selectedTrackId),locked=this.ids.some(id=>editor.getLayer(id)?.locked);
    if(view)return showTimelineMenu(this,event,[[
      {label:'Select Camera',symbol:'camera',action:()=>this._selectLayer('camera')},
      {label:'Select Scene',symbol:'scene',action:()=>this._selectLayer('scene')},
    ]]);
    if(layer)return showTimelineMenu(this,event,[
      [selected?.kind==='layer'&&{label:'Rename layer',symbol:'text',action:()=>{const node=this.labels.find(node=>node._id===selected.id);if(node)this._renameLayer(node);}},
       {label:selected?.visible===false?'Show layer':'Hide layer',symbol:selected?.visible===false?'eye':'eye-off',action:()=>editor.setLayerVisible(selected.id,selected.visible===false)},
       {label:selected?.locked?'Unlock layer':'Lock layer',symbol:selected?.locked?'unlock':'lock',action:()=>editor.setLayerLocked(selected.id,!selected.locked)}],
      [{label:'New layer',symbol:'plus',action:()=>this.newLayer()},
       selected?.kind==='layer'&&!selected.locked&&editor.report._styk.layers.order.length>1&&{label:'Delete layer',symbol:'trash',danger:true,action:()=>this.deleteLayer()}],
    ]);
    const hasKey=this.ids.some(id=>editor.layerFrameKeys(id).some(k=>k.tick>0&&k.tick>=this.start&&k.tick<=this.end)),
      needsKey=this.ids.some(id=>!editor.layerFrameKeys(id).some(k=>k.tick===this.start)),
      hasFrames=this.ids.some(id=>this.start<(editor.report._styk.layerSheet.tracks[id]?.end??0)),
      clipboard=editor._sheetClipboard,order=editor.getLayers().filter(l=>l.kind==='layer').map(l=>l.id).reverse(),
      destinations=clipboard&&(this.ids.length===clipboard.rows.length?this.ids:this.ids.length===1?order.slice(order.indexOf(this.ids[0]),order.indexOf(this.ids[0])+clipboard.rows.length):[]),
      canPaste=destinations?.length===clipboard?.rows.length&&destinations?.every(id=>!editor.getLayer(id)?.locked);
    showTimelineMenu(this,event,[
      [!locked&&{label:'Duplicate frame after current',shortcut:'Ctrl+Enter',symbol:'duplicate',action:()=>this.duplicateFrameAfter()},
       !locked&&{label:'Insert blank keyframe',symbol:'circle',action:()=>this._run(()=>this.editor.sheetInsertKey(this.ids,this.start,{blank:true}))},
       !locked&&needsKey&&{label:'Insert keyframe',shortcut:'F6',symbol:'circle',action:()=>this.addTrackKey()},
       !locked&&{label:'Insert frames',shortcut:'F5',symbol:'plus',action:()=>this.insertFrames()}],
      [hasFrames&&!locked&&{label:'Copy frames',shortcut:'Ctrl+C',symbol:'duplicate',action:()=>this.copySelection()},
       hasFrames&&!locked&&{label:'Cut frames',shortcut:'Ctrl+X',symbol:'cut',action:()=>this.cutSelection()},
       canPaste&&!locked&&{label:'Paste frames',shortcut:'Ctrl+V',symbol:'clipboard',action:()=>this.pasteSelection()}],
      [hasKey&&!locked&&{label:'Remove keyframe',shortcut:'Shift+F6',symbol:'minus',action:()=>this.clearKeys()},
       hasFrames&&!locked&&{label:'Delete frames',shortcut:'Delete',symbol:'trash',danger:true,action:()=>this.removeFrames()},
       locked&&{label:'Unlock layers',symbol:'unlock',action:()=>{for(const id of this.ids)editor.setLayerLocked(id,false);}}],
    ]);
  }
  destroy(){this.disposed=true;this._cancelGesture();this.events.abort();this.menuEvents?.abort();this.observer.disconnect();if(this.raf)cancelAnimationFrame(this.raf);this.menu?.remove();this.root.remove();}
}
