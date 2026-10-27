import {appendLocalized, localizedAttribute} from './localization-bindings.mjs';
/** Room kept between a marker and the playhead's tab, so the two never share a target. */
const GAP=2;
function setAttributeOnce(element,name,value){if(element.getAttribute(name)!==value)element.setAttribute(name,value);}

/**
 * Onion range markers on the ruler: a bracket at each end of the range and a tinted band back to the playhead.
 * Dragging a marker moves its end one frame per timeline frame under the pointer, at any zoom; pressing a marker
 * never seeks. Markers sit beside the playhead's tab even at zero frames, so the tab stays grabbable. Arrow keys
 * step a focused marker. The markers show while onion skin is on, unless turned off in its settings.
 */
export class OnionTimelineRange {
  constructor(host){
    this.host=host;this.controller=host.onionController;this.events=new AbortController();this.tabHalf=15;
    const signal=this.events.signal;
    this.overlay=document.createElement('div');this.overlay.className='onion-range-overlay';
    this.parts=['before','after'].map(direction=>{
      const sign=direction==='before'?-1:1,band=document.createElement('div'),end=document.createElement('button'),count=document.createElement('span');
      band.className=`onion-range-band ${direction}`;
      end.type='button';end.className=`onion-range-end ${direction}`;count.className='onion-range-count';appendLocalized(end, count);
      end.setAttribute('role','slider');localizedAttribute(end, 'aria-label', "onionTimelineRange.onionFrames", {direction:{messageKey:direction==='before'?'onionFrameField.before':'onionFrameField.after'}});end.setAttribute('aria-orientation','horizontal');
      appendLocalized(this.overlay, band, end);
      const part={direction,sign,band,end,count,drag:null};
      end.addEventListener('pointerdown',event=>this._press(part,event),{signal});
      end.addEventListener('pointermove',event=>this._move(part,event),{signal});
      end.addEventListener('pointerup',event=>{if(part.drag?.id===event.pointerId){event.stopPropagation();this._finish(part,true);}},{signal});
      end.addEventListener('pointercancel',()=>this._finish(part,false),{signal});
      end.addEventListener('lostpointercapture',()=>this._finish(part,false),{signal});
      end.addEventListener('click',event=>event.stopPropagation(),{signal});
      end.addEventListener('keydown',event=>{
        event.stopPropagation();
        if(event.key==='Escape'&&part.drag){event.preventDefault();this._finish(part,false);return;}
        if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home"].includes(event.key)||!this.controller)return;
        event.preventDefault();this._finish(part,false);
        const range=this.controller.snapshot()[direction];
        const delta=event.key==='ArrowLeft'?-sign:event.key==='ArrowRight'?sign:event.key==='ArrowUp'?1:-1;
        this.controller.change(this,{[range.key]:event.key==='Home'?0:Math.max(0,Math.min(range.max,range.span+delta))});
      },{signal});
      return part;
    });
    window.addEventListener('blur',()=>{for(const part of this.parts)this._finish(part,false);},{signal});
    appendLocalized(host.main, this.overlay);
    // The playhead's tab grows with its frame number; follow its width without reading layout while painting.
    if(host.playheadLabel&&typeof ResizeObserver==='function'){
      this.tabObserver=new ResizeObserver(([entry])=>{const half=(entry.borderBoxSize?.[0]?.inlineSize??entry.contentRect.width)/2;if(Math.abs(half-this.tabHalf)>.25){this.tabHalf=half;this.update();}});
      this.tabObserver.observe(host.playheadLabel,{box:'border-box'});
    }
    this.unsubscribe=this.controller?.subscribe(()=>this.update());this.update();
  }
  /** A frame cell's left edge in the timeline's coordinates. */
  edge(tick){return this.host.labelWidth+tick*this.host.pxPerTick-this.host.offsetX();}
  get visible(){return Boolean(this.controller?.getEnabled())&&this.controller.settings.onionTimelineMarkers!==false;}
  _press(part,event){
    if(event.button!==0||!this.controller||part.drag)return;
    event.preventDefault();event.stopPropagation();part.end.focus({preventScroll:true});
    this.controller.begin(this);
    const range=this.controller.snapshot()[part.direction];
    part.drag={id:event.pointerId,x:event.clientX,span:range.span,max:range.max};
    part.end.setPointerCapture?.(event.pointerId);part.end.dataset.dragging='true';
  }
  _move(part,event){
    const drag=part.drag;if(event.pointerId!==drag?.id)return;
    event.preventDefault();event.stopPropagation();
    // One frame of pointer travel is one frame of range, so the marker stays under the pointer at every zoom.
    const span=Math.max(0,Math.min(drag.max,drag.span+part.sign*Math.round((event.clientX-drag.x)/this.host.pxPerTick)));
    if(span!==this.controller.snapshot()[part.direction].span)this.controller.preview(this,{[part.direction==='before'?'onionRangeBefore':'onionRangeAfter']:span});
  }
  _finish(part,commit){
    const drag=part.drag;if(!drag)return;part.drag=null;delete part.end.dataset.dragging;
    if(part.end.hasPointerCapture?.(drag.id))part.end.releasePointerCapture(drag.id);
    if(commit)this.controller.commit(this);else this.controller.cancel(this);
  }
  update(){
    const visible=this.visible;if(this.overlay.hidden!==!visible)this.overlay.hidden=!visible;
    if(!visible){for(const part of this.parts)this._finish(part,false);return;}
    const range=this.controller.snapshot(this.host.pendingScrub??undefined),cellLeft=this.edge(range.tick),cellRight=cellLeft+this.host.pxPerTick;
    const center=(cellLeft+cellRight)/2,tabLeft=center-this.tabHalf-GAP,tabRight=center+this.tabHalf+GAP;
    // The markers show over the grid only: from the label column to the grid's end (the ruler tools' column follows it).
    const clip=`xywh(${this.host.labelWidth}px 0 ${Math.max(0,this.host.width??0)}px 100%)`;if(clip!==this.clip){this.clip=clip;this.overlay.style.clipPath=clip;}
    for(const {direction,sign,band,end,count} of this.parts){
      const value=range[direction],outer=sign<0?this.edge(value.endpoint):this.edge(value.endpoint)+this.host.pxPerTick;
      // The band covers the frames in the range; the marker sits at its outer edge or beside the tab, whichever is further out.
      const inner=sign<0?cellLeft:cellRight,marker=sign<0?Math.min(outer,tabLeft):Math.max(outer,tabRight);
      band.hidden=value.span===0;
      if(value.span){band.style.left=`${Math.min(outer,inner)}px`;band.style.width=`${Math.abs(inner-outer)}px`;}
      end.style.left=`${marker}px`;
      // Playback moves the markers every frame: write the slider's values only when they change.
      setAttributeOnce(end,'aria-valuemin','0');setAttributeOnce(end,'aria-valuemax',String(value.max));setAttributeOnce(end,'aria-valuenow',String(value.span));
      // The slider name identifies its side; its value uses the locale's frame plural.
      localizedAttribute(end, 'aria-valuetext', 'counts.frames', {count:value.span});
      localizedAttribute(end, "title", "onionTimelineRange.dragToChange", {spanLabel:{messageKey:'counts.frames',params:{count:value.span}}});
      if(count.textContent!==String(value.span))count.textContent=String(value.span);
      this.overlay.style.setProperty(`--onion-${direction}`,range.settings[direction==='before'?'onionBeforeColor':'onionAfterColor']);
    }
  }
  destroy(){this.events.abort();for(const part of this.parts)this._finish(part,false);this.tabObserver?.disconnect();this.controller?.cancel(this);this.unsubscribe?.();this.overlay.remove();}
}
