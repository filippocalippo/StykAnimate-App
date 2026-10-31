import {messageAttributes, localizedAttribute, tupleMessages, messageTuple} from './localization-bindings.mjs';

import {t as interfaceText} from './localization.mjs';
import {LINEAR_PRESSURE} from './drawing-brush.mjs';

/** The tablet pressure curve editor: a cubic Bézier from (0,0) to (1,1) with
 * two draggable control points and Soft / Linear / Firm presets. The curve is
 * a global pen setting (drawing-brush.mjs pressureMap applies it to every
 * brush). Like the drawing sliders, one delegated installation drives every
 * editor in `root` and updates it in place while dragging. */
const PRESSURE_PRESETS=[messageTuple(['soft',interfaceText("drawingPressureCurve.soft"),[.1,.5,.4,.95]], {1: {key: "drawingPressureCurve.soft", params: {}}}),messageTuple(['linear',interfaceText("drawingPressureCurve.linear"),[...LINEAR_PRESSURE]], {1: {key: "drawingPressureCurve.linear", params: {}}}),messageTuple(['firm',interfaceText("drawingPressureCurve.firm"),[.6,.05,.9,.5]], {1: {key: "drawingPressureCurve.firm", params: {}}})];
const S=100,round=n=>Math.round(n*1000)/1000;
const point=(x,y)=>[+(x*S).toFixed(1),+((1-y)*S).toFixed(1)];
const same=(a,b)=>a.every((n,i)=>Math.abs(n-b[i])<.005);
const geometry=([x1,y1,x2,y2])=>{const a=point(x1,y1),b=point(x2,y2);return {a,b,path:`M0 ${S}C${a.join(' ')} ${b.join(' ')} ${S} 0`};};
export function pressureCurveMarkup(curve){
  const {a,b,path}=geometry(curve),presets=PRESSURE_PRESETS.map((_tuple) => {const [id,label,value] = _tuple; const _messages = tupleMessages(_tuple); return `<button type="button" data-pressure-preset="${id}" aria-pressed="${same(curve,value)}"${_messages[1] ? ' ' + messageAttributes(_messages[1].key, _messages[1].params) : ''}>${label}</button>`;}).join('');
  const handle=(i,[cx,cy],key)=>{const params={pressure:Math.round(curve[i*2]*100),response:Math.round(curve[i*2+1]*100)};return `<circle class="draw-pressure-handle" data-pressure-handle="${i}" cx="${cx}" cy="${cy}" r="5" tabindex="0" role="slider" aria-label="${interfaceText(key)}" ${messageAttributes(key,{},'aria-label')} aria-valuetext="${interfaceText('drawingPressureCurve.handleValue',params)}" ${messageAttributes('drawingPressureCurve.handleValue',params,'aria-valuetext')}></circle>`;};
  return `<div class="draw-pressure" data-pressure-curve>
    <svg class="draw-pressure-graph" viewBox="-8 -8 116 116" aria-label="Pen pressure curve: pen pressure across, stroke response up" data-i18n-aria-label="drawingPressureCurve.graphDescription">
      <rect class="draw-pressure-frame" x="0" y="0" width="${S}" height="${S}"></rect>
      <path class="draw-pressure-grid" d="M25 0V${S}M50 0V${S}M75 0V${S}M0 25H${S}M0 50H${S}M0 75H${S}"></path>
      <path class="draw-pressure-diagonal" d="M0 ${S}L${S} 0"></path>
      <path class="draw-pressure-arms" d="M0 ${S}L${a.join(' ')}M${S} 0L${b.join(' ')}"></path>
      <path class="draw-pressure-line" d="${path}"></path>
      ${handle(0,a,'drawingPressureCurve.lightPressureHandle')}${handle(1,b,'drawingPressureCurve.heavyPressureHandle')}
    </svg>
    <div class="ds-segmented draw-pressure-presets" role="group" aria-label="Pressure presets" data-i18n-aria-label="drawingPressureCurve.presets">${presets}</div>
  </div>`;
}
/** Update every editor in `root` to `curve` without re-rendering. */
export function refreshPressureCurve(root,curve){
  const {a,b,path}=geometry(curve);
  for(const el of root.querySelectorAll('[data-pressure-curve]')){
    el.querySelector('.draw-pressure-line')?.setAttribute('d',path);
    el.querySelector('.draw-pressure-arms')?.setAttribute('d',`M0 ${S}L${a.join(' ')}M${S} 0L${b.join(' ')}`);
    [a,b].forEach(([cx,cy],i)=>{const h=el.querySelector(`[data-pressure-handle="${i}"]`);if(!h)return;h.setAttribute('cx',cx);h.setAttribute('cy',cy);localizedAttribute(h,'aria-valuetext','drawingPressureCurve.handleValue',{pressure:Math.round(curve[i*2]*100),response:Math.round(curve[i*2+1]*100)});});
    for(const button of el.querySelectorAll('[data-pressure-preset]'))button.setAttribute('aria-pressed',String(same(curve,PRESSURE_PRESETS.find(p=>p[0]===button.dataset.pressurePreset)[2])));
  }
}
/** Delegate curve editing on `root`: set(curve) applies a value live, end()
 * runs once an interaction finishes (the owner persists the curve). */
export function installPressureCurve(root,{get,set,end,signal}){
  const apply=curve=>{curve=curve.map(n=>round(Math.max(0,Math.min(1,n))));set(curve);refreshPressureCurve(root,curve);};
  const move=(i,x,y)=>{const next=[...get()];next[i*2]=x;next[i*2+1]=y;apply(next);};
  root.addEventListener('pointerdown',event=>{
    const handle=event.target.closest?.('[data-pressure-handle]');if(!handle||event.button!==0)return;
    const svg=handle.ownerSVGElement,editor=handle.closest('[data-pressure-curve]'),i=Number(handle.dataset.pressureHandle);
    event.preventDefault();event.stopPropagation();handle.setPointerCapture(event.pointerId);
    // While owned, inspector refreshes leave the editor's live state alone.
    editor.setAttribute('data-inspector-owned','');editor.classList.add('is-dragging');
    const at=e=>{const m=svg.getScreenCTM()?.inverse();if(!m)return;const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(m);move(i,p.x/S,1-p.y/S);};
    const drag=e=>{if(e.pointerId===event.pointerId)at(e);};
    const up=e=>{if(e.pointerId!==event.pointerId)return;handle.removeEventListener('pointermove',drag);handle.removeEventListener('pointerup',up);handle.removeEventListener('pointercancel',up);editor.removeAttribute('data-inspector-owned');editor.classList.remove('is-dragging');end();};
    handle.addEventListener('pointermove',drag);handle.addEventListener('pointerup',up);handle.addEventListener('pointercancel',up);
  },{signal});
  root.addEventListener('keydown',event=>{
    const handle=event.target.closest?.('[data-pressure-handle]');if(!handle)return;
    const step=event.shiftKey?.1:.02,dx={ArrowLeft:-step,ArrowRight:step}[event.key]??0,dy={ArrowDown:-step,ArrowUp:step}[event.key]??0;if(!dx&&!dy)return;
    event.preventDefault();event.stopPropagation();const i=Number(handle.dataset.pressureHandle),curve=get();move(i,curve[i*2]+dx,curve[i*2+1]+dy);end();
  },{signal});
  root.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-pressure-preset]');if(!button)return;
    event.stopPropagation();apply([...PRESSURE_PRESETS.find(p=>p[0]===button.dataset.pressurePreset)[2]]);end();
  },{signal});
}
