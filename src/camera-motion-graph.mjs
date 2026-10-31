
import {descriptorAttributes, localizedAttribute, localizedMarkup, messageHTML, localizedText} from './localization-bindings.mjs';
import {t as interfaceText} from './localization.mjs';

import {icon} from './icons.mjs';

const VIEWS={move:{labelKey: "cameraMotionGraph.move",unit:'px',keys:['x','y']},roll:{labelKey: "cameraMotionGraph.roll",unit:'°',keys:['roll']},zoom:{labelKey: "cameraMotionGraph.zoom",unit:'%',keys:['zoom']}};
const LABELS={x:'X',y:'Y',roll:'cameraMotionGraph.roll',zoom:'cameraMotionGraph.zoom'};
const CHANNELS=Object.keys(LABELS);
const LEFT=36,RIGHT=252,TOP=10,BOTTOM=100,ZERO=(TOP+BOTTOM)/2;
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const number=n=>String(Number(n.toFixed(2)));
export const motionGraphValueLabel=n=>Math.abs(n)>0&&Math.abs(n)<.01?String(Number(n.toPrecision(2))):number(n);
const axisLabel=n=>Math.abs(n)>=10000?`${number(n/1000)}k`:motionGraphValueLabel(n);
const xAt=u=>LEFT+u*(RIGHT-LEFT);
const yAt=(value,scale)=>ZERO-value/scale*(BOTTOM-TOP)/2;
export const motionGraphValues=sample=>({x:sample.x,y:sample.y,roll:sample.rotation*180/Math.PI,zoom:(sample.zoom-1)*100});
/** The ticks a clip's curve is plotted at, bounded however long the clip is: the first and last frame of the clip and the ones between. */
export function motionGraphTicks(clip,fps){
  const span=Math.max(0,clip.duration-1);
  const count=clip.type==='follow'?Math.max(1,Math.min(2048,span)):Math.min(2048,Math.max(256,Math.ceil(span/fps*clip.params.frequency*16)));
  return {count,span,ticks:Array.from({length:count+1},(_,i)=>clip.start+span*i/count)};
}
/** The curve of a clip from what the engine samples of it at `plot.ticks` (`[x, y, rotation, zoom, …]`, as `cameraSamples` answers). */
export function plotMotionGraph({count,span},samples){
  const channels={x:[],y:[],roll:[],zoom:[]},peaks={x:0,y:0,roll:0,zoom:0};
  for(let i=0;i<=count;i++){
    const values=motionGraphValues({x:samples[4*i],y:samples[4*i+1],rotation:samples[4*i+2],zoom:samples[4*i+3]});
    for(const key of CHANNELS){channels[key].push(values[key]);peaks[key]=Math.max(peaks[key],Math.abs(values[key]));}
  }
  return {channels,peaks,count,span};
}
/** What a clip does to the shot at each of `ticks`, read from the engine; nothing where it does not answer. */
function clipSamples(editor,clip,ticks){
  return editor._shown?.cameraSamples(clip,ticks)??ticks.flatMap(()=>[0,0,0,1]);
}
export function motionGraphScale(peak){
  if(peak<1e-8)return 1;
  const base=10**Math.floor(Math.log10(peak)),fraction=peak/base;
  return [1,2,2.5,5,10].find(n=>n>=fraction)*base;
}
export function motionGraphView(){
  return `<div class="motion-graph" data-motion-graph data-inspector-owned="camera-motion-graph"><div class="motion-graph-toolbar"><div class="motion-graph-tabs ui-segmented" data-size="sm" role="group" aria-label="Motion curve channel" data-i18n-aria-label="cameraMotionGraph.motionCurveChannel">${Object.entries(VIEWS).map(([key,v])=>`<button type="button" class="ui-segmented-item" data-motion-graph-channel="${key}" aria-pressed="false"${descriptorAttributes(v, "label")}>${interfaceText(v.labelKey)}</button>`).join('')}</div><button type="button" class="ui-icon-button" data-size="sm" data-motion-graph-fit title="Fit curve" aria-label="Fit curve" data-i18n-title="cameraMotionGraph.fitCurve" data-i18n-aria-label="cameraMotionGraph.fitCurve">${icon('center')}</button></div><svg class="motion-graph-plot" viewBox="0 0 260 124" role="img" aria-label="Camera motion by frame"></svg><div class="motion-graph-readout"></div></div>`;
}

/** The graph patches its own SVG; inspector inputs and their pointer capture stay
 * mounted. Curve samples change only with clip data/fps, never with playhead time. */
export class CameraMotionGraph{
  constructor(root,editor){
    this.root=root;this.editor=editor;this.events=new AbortController();
    const on=(target,type,fn)=>target.addEventListener(type,fn,{signal:this.events.signal});
    on(editor,'change',event=>{
      if(event.detail?.kind==='document'){this.clip=null;this.scales=null;this.hover=null;this.previewClip=null;}
      this.update();
    });
    on(root,'click',event=>{
      const button=event.target.closest('[data-motion-graph-channel],[data-motion-graph-fit]');if(!button)return;
      event.preventDefault();event.stopPropagation();
      if(button.dataset.motionGraphChannel)this.channel=button.dataset.motionGraphChannel;
      else this.scales=null;
      this.needsPlot=true;this.update();
    });
    on(root,'focusin',event=>{
      const key=event.target.closest('[data-property-row]')?.querySelector('[data-motion-field]')?.dataset.motionField;
      const channel=key==='roll'?'roll':key==='zoom'?'zoom':['move','moveX','moveY','direction','offsetX','offsetY','lag','deadZone','lookAhead'].includes(key)?'move':['zoomFit','padding','maxZoom'].includes(key)?'zoom':null;
      if(channel&&channel!==this.channel){this.channel=channel;this.needsPlot=true;this.update();}
    });
    on(root,'pointermove',event=>{
      const svg=event.target.closest('.motion-graph-plot');if(!svg)return;
      const rect=svg.getBoundingClientRect();this.hover=clamp(((event.clientX-rect.left)/rect.width*260-LEFT)/(RIGHT-LEFT),0,1);this.update();
    });
    on(root,'pointerout',event=>{
      if(event.target.closest('.motion-graph-plot')&&!event.relatedTarget?.closest?.('.motion-graph-plot')){this.hover=null;this.update();}
    });
  }
  update(){if(this.raf)return;this.raf=requestAnimationFrame(()=>{this.raf=null;this.render();});}
  preview(clip){this.previewClip=clip;this.update();}
  render(){
    const node=this.root.querySelector('[data-motion-graph]');if(!node)return;
    const id=node.closest('[data-motion-id]').dataset.motionId;
    const clip=this.previewClip?.id===id?this.previewClip:this.editor.getCameraMotions().find(c=>c.id===id);if(!clip)return;
    const fps=this.editor.report.fps,newClip=this.clip?.id!==id;
    if(newClip){this.channel=clip.type==='pulse'?'zoom':'move';this.scales=null;this.hover=null;}
    // A follow curve also changes when the followed figures or the camera keys do.
    const generation=clip.type==='follow'?this.editor.revision:0;
    const sampled=clip!==this.clip||fps!==this.fps||generation!==this.generation;
    this.generation=generation;
    if(sampled){const plot=motionGraphTicks(clip,fps);this.plot=plotMotionGraph(plot,clipSamples(this.editor,clip,plot.ticks));}
    const replaced=this.node!==node||this.cursor!==node.querySelector('[data-motion-graph-cursor]');
    this.clip=clip;this.fps=fps;this.node=node;
    if(sampled||replaced||this.needsPlot){
      this.needsPlot=false;this.scales??={};
      // Keep the scale while editing so changing amplitude visibly changes the
      // curve. Grow only when necessary; Fit curve explicitly tightens it again.
      for(const [key,view] of Object.entries(VIEWS))this.scales[key]=Math.max(this.scales[key]??0,motionGraphScale(Math.max(...view.keys.map(k=>this.plot.peaks[k]))));
      this.paintPlot();
    }
    this.paintCursor();
  }
  paintPlot(){
    const {clip,plot,channel,node}=this,view=VIEWS[channel],scale=this.scales[channel];
    node.dataset.channel=channel;node.dataset.muted=String(!clip.enabled);
    for(const button of node.querySelectorAll('[data-motion-graph-channel]'))button.setAttribute('aria-pressed',String(button.dataset.motionGraphChannel===channel));
    const duration=Math.max(1,plot.span),fadeIn=xAt(Math.min(1,clip.params.fadeIn/duration)),fadeOut=xAt(clamp((clip.duration-clip.params.fadeOut)/duration,0,1));
    const svg=node.querySelector('svg.motion-graph-plot');
    localizedAttribute(svg, 'aria-label', clip.enabled?'cameraMotionGraph.inFramesTo':'cameraMotionGraph.inFramesToMuted', {label:{messageKey:view.labelKey},unit:view.unit,value:clip.start+1,value2:clip.start+clip.duration,value3:''});
    svg.dataset.scale=String(scale);
    const lines=view.keys.map(key=>`<polyline data-motion-curve="${key}" class="motion-graph-line motion-series-${key}" points="${plot.channels[key].map((value,i)=>`${number(xAt(i/plot.count))},${number(yAt(value,scale))}`).join(' ')}"/>`).join('');
    localizedMarkup(svg, `<g class="motion-graph-fades"><rect x="${LEFT}" y="${TOP}" width="${fadeIn-LEFT}" height="${BOTTOM-TOP}"><title>${messageHTML("cameraMotionGraph.fadeInFrames", {fadeIn: clip.params.fadeIn})}</title></rect><rect x="${fadeOut}" y="${TOP}" width="${RIGHT-fadeOut}" height="${BOTTOM-TOP}"><title>${messageHTML("cameraMotionGraph.fadeOutFrames", {fadeOut: clip.params.fadeOut})}</title></rect></g><path class="motion-graph-grid" d="M${LEFT} ${TOP}H${RIGHT}M${LEFT} ${BOTTOM}H${RIGHT}M${xAt(.5)} ${TOP}V${BOTTOM}"/><path class="motion-graph-zero" d="M${LEFT} ${ZERO}H${RIGHT}"/><g class="motion-graph-axis"><text x="30" y="${TOP+3}" text-anchor="end">${axisLabel(scale)}</text><text x="30" y="${ZERO+3}" text-anchor="end">0</text><text x="30" y="${BOTTOM+3}" text-anchor="end">${axisLabel(-scale)}</text><text x="${LEFT}" y="118">${clip.start+1}</text><text x="${xAt(.5)}" y="118" text-anchor="middle">${number(clip.start+1+plot.span/2)}</text><text x="${RIGHT}" y="118" text-anchor="end">${clip.start+clip.duration}</text></g>${lines}<g data-motion-graph-cursor><path class="motion-graph-cursor-line"/><g>${view.keys.map(key=>`<circle class="motion-graph-dot motion-series-${key}" data-motion-dot="${key}" r="3"/>`).join('')}</g></g>`);
    localizedMarkup(node.querySelector('.motion-graph-readout'), `<span data-motion-graph-frame></span>${view.keys.map(key=>`<span class="motion-graph-value motion-series-${key}"><i></i>${key==='x'||key==='y'?LABELS[key]:messageHTML(LABELS[key])} <output data-motion-value="${key}"></output></span>`).join('')}${!clip.enabled?`<span class="motion-graph-muted" data-i18n="cameraMotionGraph.muted">${messageHTML("cameraMotionGraph.muted", {})}</span>`:''}`);
    this.cursor=node.querySelector('[data-motion-graph-cursor]');
    this.cursorSignature=null;
  }
  paintCursor(){
    const {clip,node,plot,channel}=this,view=VIEWS[channel];
    const tick=this.hover==null?this.editor.tick:clip.start+Math.round(this.hover*plot.span);
    const inside=tick>=clip.start&&tick<clip.start+clip.duration;
    const signature=`${tick}:${inside}`;if(signature===this.cursorSignature)return;this.cursorSignature=signature;
    const cursor=node.querySelector('[data-motion-graph-cursor]');cursor.style.display=inside?'':'none';
    const [sx,sy,rotation,zoom]=clipSamples(this.editor,clip,[tick]),values=motionGraphValues({x:sx,y:sy,rotation,zoom});
    const x=xAt(plot.span?(tick-clip.start)/plot.span:0);
    cursor.querySelector('path').setAttribute('d',`M${x} ${TOP}V${BOTTOM}`);
    for(const key of view.keys){
      const dot=cursor.querySelector(`[data-motion-dot="${key}"]`);dot.setAttribute('cx',x);dot.setAttribute('cy',yAt(values[key],this.scales[channel]));
      node.querySelector(`[data-motion-value="${key}"]`).textContent=`${motionGraphValueLabel(values[key])}${view.unit}`;
    }
    localizedText(node.querySelector('[data-motion-graph-frame]'), "cameraMotionGraph.f", {value: number(tick+1)});
  }
  destroy(){this.events.abort();if(this.raf)cancelAnimationFrame(this.raf);}
}
