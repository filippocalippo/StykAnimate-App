import {brushMessages} from './drawing-brush-labels.mjs';
import {tupleMessages, messageTuple, descriptorAttributes, messageAttributes, messageHTML} from './localization-bindings.mjs';

import {t as interfaceText} from './localization.mjs';

import {icon} from './icons.mjs';
import {drawingMetadata,isDrawingLayer} from './drawing-model.mjs';
import {paintStroke} from './engine/engine-drawing.mjs';
import {TileStore} from './drawing-tiles.mjs';
import {SLIDERS,sliderMarkup} from './drawing-sliders.mjs';
import {paletteFor,projectColors} from './color-palette.mjs';
import {BRUSH_DEFAULTS,BRUSH_KEYS,BRUSH_LENGTHS,LINEAR_PRESSURE} from './drawing-brush.mjs';
import {pressureCurveMarkup} from './drawing-pressure-curve.mjs';

export const DRAWING_TOOLS = [
  messageTuple(['brush',interfaceText("drawingView.brush"),'brush',interfaceText("drawingView.paintB")], {1: {key: "drawingView.brush", params: {}}, 3: {key: "drawingView.paintB", params: {}}}), messageTuple(['eraser',interfaceText("drawingView.eraser"),'eraser',interfaceText("drawingView.eraseE")], {1: {key: "drawingView.eraser", params: {}}, 3: {key: "drawingView.eraseE", params: {}}}),
  messageTuple(['fill',interfaceText("drawingView.fill"),'paint-bucket',interfaceText("drawingView.fillG")], {1: {key: "drawingView.fill", params: {}}, 3: {key: "drawingView.fillG", params: {}}}),
  messageTuple(['lasso',interfaceText("drawingView.lasso"),'lasso',interfaceText("drawingView.selectPixelsL")], {1: {key: "drawingView.lasso", params: {}}, 3: {key: "drawingView.selectPixelsL", params: {}}}), messageTuple(['shape',interfaceText("drawingView.shape"),'square',interfaceText("drawingView.lineRectangleAndEllipseU")], {1: {key: "drawingView.shape", params: {}}, 3: {key: "drawingView.lineRectangleAndEllipseU", params: {}}}),
  messageTuple(['transform',interfaceText("drawingView.transform"),'transform',interfaceText("drawingView.transformDrawingV")], {1: {key: "drawingView.transform", params: {}}, 3: {key: "drawingView.transformDrawingV", params: {}}}),
];
// Every preset defines the whole tip, dynamics and blend (starting from the
// brush defaults) so switching presets is deterministic; alpha lock is a
// painting mode and persists.
const TIP=Object.fromEntries(Object.entries(BRUSH_DEFAULTS).filter(([key])=>key!=='alphaLock'));
export const BRUSH_PRESETS = [
  {id:'ink',name:'Ink',description:"Crisp, pressure-sensitive lines",...TIP,size:8,spacingRatio:.08},
  {id:'brushpen',name:'Brush pen',description:"Tapered ink strokes, even with a mouse",...TIP,size:12,spacingRatio:.05,taperIn:24,taperOut:48},
  {id:'pencil',name:'Pencil',description:"Fine grainy lines for rough animation",...TIP,size:2,hardness:.85,flow:.7,pressureOpacity:true,spacingRatio:.05,texture:.5,grain:'paper',sizeJitter:.1},
  {id:'liner',name:'Liner',description:"Smooth, stabilized clean-up lines",...TIP,size:5,spacingRatio:.05,stabilization:.45,taperOut:12},
  {id:'calligraphy',name:'Nib',description:"Flat calligraphy nib: thick and thin by stroke direction",...TIP,size:16,spacingRatio:.03,roundness:.2,angle:40},
  {id:'marker',name:'Marker',description:"Even translucent strokes",...TIP,size:24,hardness:.95,opacity:.35,pressureSize:false,spacingRatio:.12},
  {id:'soft',name:'Soft',description:"Soft edges for shading",...TIP,size:32,hardness:0,flow:.25,spacingRatio:.1},
  {id:'airbrush',name:'Airbrush',description:"Builds up soft paint with pen pressure",...TIP,size:72,hardness:0,flow:.06,pressureSize:false,pressureFlow:true,spacingRatio:.05},
  {id:'charcoal',name:'Charcoal',description:"Rough chalky tip that catches the paper grain",...TIP,size:20,hardness:.8,flow:.6,opacity:.9,pressureOpacity:true,spacingRatio:.06,tip:'chalk',roundness:.75,angleMode:'direction',texture:.6,grain:'paper',scatter:.05,sizeJitter:.15},
  {id:'chalk',name:'Chalk',description:"Broad pastel strokes with a broken edge",...TIP,size:30,hardness:.8,flow:.8,pressureOpacity:true,spacingRatio:.08,tip:'chalk',angleJitter:1,sizeJitter:.2,texture:.5,grain:'paper'},
  {id:'drybrush',name:'Dry brush',description:"Bristle streaks that follow the stroke on canvas grain",...TIP,size:36,flow:.9,spacingRatio:.03,tip:'bristle',angleMode:'direction',texture:.3,grain:'canvas',taperOut:30},
  {id:'sponge',name:'Sponge',description:"Porous, broken texture for foliage and clouds",...TIP,size:44,hardness:.6,flow:.5,pressureSize:false,spacingRatio:.25,tip:'sponge',opacityJitter:.5,angleJitter:1,scatter:.25},
  {id:'blender',name:'Blender',description:"Smudges and blends existing paint",...TIP,blend:'smudge',size:36,hardness:.4,opacity:.8,pressureOpacity:true,spacingRatio:.06,smudgeLength:.85},
  {id:'oil',name:'Oil',description:"Mixes the brush colour into wet paint",...TIP,blend:'smudge',size:28,hardness:.75,spacingRatio:.05,smudgeLength:.6,colorRate:.35},
];
const BRUSH_TIP_LABELS=[messageTuple(['round',interfaceText("drawingView.round")], {1: {key: "drawingView.round", params: {}}}),messageTuple(['chalk',interfaceText("drawingView.chalk")], {1: {key: "drawingView.chalk", params: {}}}),messageTuple(['bristle',interfaceText("drawingView.bristle")], {1: {key: "drawingView.bristle", params: {}}}),messageTuple(['sponge',interfaceText("drawingView.sponge")], {1: {key: "drawingView.sponge", params: {}}})];
const BRUSH_GRAIN_LABELS=[messageTuple(['noise',interfaceText("drawingView.noise")], {1: {key: "drawingView.noise", params: {}}}),messageTuple(['paper',interfaceText("drawingView.paper")], {1: {key: "drawingView.paper", params: {}}}),messageTuple(['canvas',interfaceText("drawingView.canvas")], {1: {key: "drawingView.canvas", params: {}}})];
export const BRUSH_BLEND_LABELS=[messageTuple(['normal',interfaceText("drawingView.normal")], {1: {key: "drawingView.normal", params: {}}}),messageTuple(['behind',interfaceText("drawingView.behind")], {1: {key: "drawingView.behind", params: {}}}),messageTuple(['multiply',interfaceText("drawingView.multiply")], {1: {key: "drawingView.multiply", params: {}}}),messageTuple(['screen',interfaceText("drawingView.screen")], {1: {key: "drawingView.screen", params: {}}}),messageTuple(['overlay',interfaceText("drawingView.overlay")], {1: {key: "drawingView.overlay", params: {}}}),messageTuple(['color',interfaceText("drawingView.color")], {1: {key: "drawingView.color", params: {}}}),messageTuple(['smudge',interfaceText("drawingView.smudge")], {1: {key: "drawingView.smudge", params: {}}})];
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

/** A small stroke drawn by the real brush engine, cached per preset tip. Smudge
 * presets drag two colour bands so the thumbnail shows what they do. */
const thumbnails=new Map();
function presetThumbnail(p){
  if(typeof document==='undefined')return '';
  const key=p.id+':'+JSON.stringify(BRUSH_KEYS.map(k=>p[k]));
  const hit=thumbnails.get(key);if(hit)return hit;
  const W=120,H=36,store=new TileStore(),size=Math.max(2.5,Math.min(10,p.size*.5))*2;
  if(p.blend==='smudge'){const band=new Uint8ClampedArray(W*H*4);for(let y=6;y<H-6;y++)for(let x=0;x<W;x++)band.set(x<W/2?[222,78,78,255]:[64,96,208,255],(y*W+x)*4);store.writeRect(0,0,W,H,band);}
  try{
    // Lengths scale with the thumbnail's capped tip size.
    const scale=size/Math.max(.5,p.size??BRUSH_DEFAULTS.size),tip={...BRUSH_DEFAULTS,...p};for(const k of BRUSH_LENGTHS)tip[k]*=scale;
    const samples=[];
    for(let i=0;i<=28;i++){const t=i/28;samples.push({x:10+t*(W-20),y:H/2+Math.sin(t*Math.PI*2)*H*.2,pressure:.25+.75*Math.sin(Math.PI*t),time:i*16});}
    if(!paintStroke(store,{...tip,color:[42,42,48],seed:11,pixelsPerUnit:scale},samples))return '';
    const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;canvas.getContext('2d').putImageData(new ImageData(store.readRect(0,0,W,H),W,H),0,0);
    const url=canvas.toDataURL('image/png');canvas.width=canvas.height=1;
    if(thumbnails.size>=96)thumbnails.delete(thumbnails.keys().next().value);thumbnails.set(key,url);return url;
  }catch{return '';}
}
const presetButton=(p,s)=>`<button class="drawing-preset" data-draw-preset="${escape(p.id)}" aria-pressed="${s.preset===p.id}" title="${escape(p.description)}"${descriptorAttributes(brushMessages[p.id] ?? p, "description", "title")}><img class="drawing-preset-thumb" src="${presetThumbnail(p)}" alt=""><span ${brushMessages[p.id] ? messageAttributes(brushMessages[p.id].nameKey) : ''}>${escape(p.name)}</span></button>`;
export const presetGrid=(drawing)=>{const s=drawing.settings,custom=drawing.library?.presets??[];return `<div class="drawing-presets" role="group" aria-label="Brush presets" data-i18n-aria-label="drawingView.brushPresets">${[...BRUSH_PRESETS,...custom].map(p=>presetButton(p,s)).join('')}</div>`;};
/** The colours Draw offers: the project's, the recent ones or a personal
 * palette, whichever the colour picker shows, so the rail and every picker agree. */
const drawingPalette=drawing=>paletteFor(projectColors(drawing.editor?.report),drawing.library?.recent??[]);
const paletteLabelMessage=({view})=>view==='mine'?null:{key:view==='project'?'colorPicker.projectColors':'colorPicker.recent'};
const paletteLabel=palette=>escape(palette.view==='mine'?palette.name:interfaceText(paletteLabelMessage(palette).key));
const paletteLabelAttributes=palette=>{const ref=paletteLabelMessage(palette);return ref?messageAttributes(ref.key,{},'aria-label'):'';};
// The swatch group for Properties and the pop-up palette.
const paletteSwatches=drawing=>{
  const palette=drawingPalette(drawing),{colors}=palette,current=drawing.settings.color.toLowerCase();
  return colors.length?`<div class="drawing-swatches" role="group" aria-label="${paletteLabel(palette)}" ${paletteLabelAttributes(palette)}>${colors.map(c=>`<button class="drawing-swatch" data-draw-color="${c}" style="background:${c}" title="${c.toUpperCase()}" aria-label="Use ${c.toUpperCase()}" aria-pressed="${c===current}" ${messageAttributes("drawingView.use", {value: c.toUpperCase()}, "aria-label")}></button>`).join('')}</div>`:'';
};
// The rail shows this many colours; +N opens the picker with the rest.
const RAIL_COLORS=8;
/** Main and second colour as an overlapping pair (X swaps), with the hex. */
const colorPair=(s,{hex=true}={})=>`<div class="draw-colors"><div class="draw-color-pair"><input type="color" class="draw-color-primary" data-draw-setting="color" value="${s.color}" aria-label="Drawing color" title="Main color · Alt-click the canvas to pick" data-i18n-aria-label="drawingView.drawingColor" data-i18n-title="drawingView.mainColorAltClickTheCanvasToPick"><input type="color" class="draw-color-secondary" data-draw-setting="color2" value="${s.color2??'#ffffff'}" aria-label="Second color" title="Second color" data-i18n-aria-label="drawingView.secondColor" data-i18n-title="drawingView.secondColor"></div><button class="icon-button draw-color-swap" data-draw-action="swap-colors" title="Swap colors · X" aria-label="Swap colors" data-i18n-title="drawingView.swapColorsX" data-i18n-aria-label="drawingView.swapColors">${icon('loop')}</button>${hex?`<span class="hex-label">${s.color.toUpperCase()}</span>`:''}</div>`;

/** Tool properties use the shared inspector sections; timing stays in the timeline.
 * The canvas quick bar owns everyday settings (colour, size, opacity, flow,
 * smoothing, mirror and tool modes); Properties holds only what it lacks, so
 * each control has exactly one home. */
export function drawingInspector(drawing,{numericField,group:renderGroup,grid,heading,propertyToggle},poseView='') {
  const {editor,settings:s,tool}=drawing;
  const field=(label,key,value,unit='',limits='',labelKey)=>numericField(label,'draw:'+key,value,unit,limits,{}, {legacyField:false,labelKey});
  const group=(titleKey,body)=>renderGroup(titleKey?interfaceText(titleKey):'',body,'',{titleKey:titleKey||null});
  const sliders=(...keys)=>`<div class="draw-sliders">${keys.map(key=>sliderMarkup(key,s[key])).join('')}</div>`;
  const button=(action,label,symbol='plus',disabled=false,title='', _messages = {})=>`<button class="button" data-draw-action="${action}" ${disabled?'disabled':''} title="${title}" ${_messages.title ? messageAttributes(_messages.title.key, _messages.title.params, 'title') : ''}>${icon(symbol)}<span ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params) : ''}>${label}</span></button>`;
  const iconButton=(action,symbol,title,disabled=false, _messages = {})=>`<button class="icon-button" data-draw-action="${action}" title="${title}" aria-label="${title}" ${disabled?'disabled':''} ${_messages.title ? messageAttributes(_messages.title.key, _messages.title.params, 'title') : ''} ${_messages.title ? messageAttributes(_messages.title.key, _messages.title.params, 'aria-label') : ''}>${icon(symbol)}</button>`;
  const toggle=(key,labelKey,symbol,titleKey=labelKey)=>propertyToggle('draw-'+key,interfaceText(labelKey),Boolean(s[key]),symbol,{title:interfaceText(titleKey),labelKey,titleKey,attrs:`data-draw-setting="${key}"`});
  const select=(key,label,options, _messages = {})=>`<label class="drawing-resolution" ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params) : ''}>${label}<select class="inline-select" data-draw-setting="${key}" data-draw-text aria-label="${label}" ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params, 'aria-label') : ''}>${options.map((_tuple) => {const [value,text] = _tuple; const _messages = tupleMessages(_tuple); return `<option value="${value}" ${s[key]===value?'selected':''} ${_messages.text ? messageAttributes(_messages.text.key, _messages.text.params) : ''}${_messages[1] ? ' ' + messageAttributes(_messages[1].key, _messages[1].params) : ''}>${text}</option>`;}).join('')}</select></label>`;
  const details=(label,body, _messages = {})=>`<details class="inspector-section inspector-disclosure" data-section="${label}"><summary class="inspector-title" ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params) : ''}>${label}</summary><div class="inspector-disclosure-body">${body}</div></details>`;
  const swatches=paletteSwatches(drawing);
  const quickHint=`<p class="drawing-hint drawing-quick-note">${icon('sliders')}${messageHTML("drawingView.colorSizeAndOpacityAreInTheBar", {})}</p>`;
  const preview=`<canvas class="drawing-preview" data-inspector-owned data-section="brush-preview" data-brush-preview aria-label="Brush stroke preview" data-i18n-aria-label="drawingView.brushStrokePreview"></canvas>`;
  let target;try{target=editor.drawingTarget();}catch{}
  const layer=editor.getLayer(editor.activeLayerId),eligible=isDrawingLayer(layer)&&!layer.locked&&layer.visible;
  const toolTuple=DRAWING_TOOLS.find(t=>t[0]===tool),toolMessage=toolTuple?tupleMessages(toolTuple)[1]:{key:"drawingView.hand"};
  let html=heading(interfaceText(toolMessage.key),toolTuple?.[2]??'hand',{titleKey:toolMessage.key});
  if(!eligible)html+=group('',`<div class="drawing-empty" ${messageAttributes((isDrawingLayer(layer) ? "drawingView.showAndUnlockThisDrawingLayer" : "drawingView.paintOnTheCanvasToStartADrawing"), (isDrawingLayer(layer) ? {} : {}))}>${isDrawingLayer(layer)?interfaceText("drawingView.showAndUnlockThisDrawingLayer"):interfaceText("drawingView.paintOnTheCanvasToStartADrawing")}</div><div class="property-context-actions">${button('new',interfaceText("drawingView.newDrawingLayer"),'brush', undefined, undefined, {label: {key: "drawingView.newDrawingLayer", params: {}}})}</div>`);
  if(tool==='brush'||tool==='eraser') {
    const custom=drawing.library?.presets??[],isCustom=custom.some(p=>p.id===s.preset);
    if(tool==='brush')html+=group("drawingView.preset",presetGrid(drawing)+`<div class="property-context-actions">${button('save-preset',interfaceText("drawingView.saveBrush"),'plus', undefined, undefined, {label: {key: "drawingView.saveBrush", params: {}}})}${isCustom?button('delete-preset',interfaceText("drawingView.deleteBrush"),'trash', undefined, undefined, {label: {key: "drawingView.deleteBrush", params: {}}}):''}</div>`);
    html+=group('',preview+(tool==='brush'?swatches:'')+sliders('hardness')+quickHint);
    if(tool==='brush')html+=group("drawingView.painting",select('blend',interfaceText("drawingView.blend"),BRUSH_BLEND_LABELS, {label: {key: "drawingView.blend", params: {}}})+(s.blend==='smudge'?sliders('smudgeLength','colorRate'):'')+`<div class="property-toggle-grid drawing-toggle-grid">${toggle('alphaLock','drawingView.lockAlpha','lock')}</div>`);
    const smudge=s.blend==='smudge'&&tool==='brush';
    html+=details(interfaceText("drawingView.tip"),(smudge?'':select('tip',interfaceText("drawingView.shape"),BRUSH_TIP_LABELS, {label: {key: "drawingView.shape", params: {}}}))+sliders('roundness','angle','spacingRatio')+select('angleMode',interfaceText("drawingView.tipFollows"),[messageTuple(['fixed',interfaceText("drawingView.fixedAngle")], {1: {key: "drawingView.fixedAngle", params: {}}}),messageTuple(['direction',interfaceText("drawingView.strokeDirection")], {1: {key: "drawingView.strokeDirection", params: {}}}),messageTuple(['tilt',interfaceText("drawingView.penTilt")], {1: {key: "drawingView.penTilt", params: {}}})], {label: {key: "drawingView.tipFollows", params: {}}}), {label: {key: "drawingView.tip", params: {}}});
    html+=details(interfaceText("drawingView.stroke"),sliders('taperIn',...(smudge?[]:['taperOut']))+select('stabilizerMode',interfaceText("drawingView.smoothing"),[messageTuple(['average',interfaceText("drawingView.average")], {1: {key: "drawingView.average", params: {}}}),messageTuple(['string',interfaceText("drawingView.pulledString")], {1: {key: "drawingView.pulledString", params: {}}})], {label: {key: "drawingView.smoothing", params: {}}})+`<div class="drawing-hint">${messageHTML("drawingView.tapersThinTheStartAndEndOfEvery", {})}</div>`, {label: {key: "drawingView.stroke", params: {}}});
    if(!smudge)html+=details(interfaceText("drawingView.texture"),select('grain',interfaceText("drawingView.grain"),BRUSH_GRAIN_LABELS, {label: {key: "drawingView.grain", params: {}}})+sliders('texture','grainScale'), {label: {key: "drawingView.texture", params: {}}});
    html+=details(interfaceText("drawingView.dynamics"),`<div class="property-toggle-grid drawing-toggle-grid">${toggle('pressureSize','drawingView.sizePressure','scale')}${toggle('pressureOpacity','drawingView.opacityPressure','circle')}${toggle('pressureFlow','drawingView.flowPressure','activity')}</div>`+sliders('sizeCurve','opacityCurve','sizeJitter','opacityJitter','angleJitter','scatter'), {label: {key: "drawingView.dynamics", params: {}}});
    html+=details(interfaceText("drawingView.penPressure"),pressureCurveMarkup(drawing.library?.pressureCurve??LINEAR_PRESSURE)+`<div class="drawing-hint">${messageHTML("drawingView.appliesToEveryBrushDragTheHandlesAbove", {})}</div>`, {label: {key: "drawingView.penPressure", params: {}}});
    html+=group("drawingView.assist",`<div class="property-toggle-grid drawing-toggle-grid">${toggle('mirrorY','drawingView.mirrorVertically','flip','drawingView.mirrorPaintingAcrossTheHorizontalCentreHorizontalMirroring')}</div><div class="drawing-hint">${messageHTML(tool==='brush'?"drawingView.brushGestureHints":"drawingView.shiftClickStraightLineCtrlDragSizeSize", {value:""})}</div>`);
  }
  if(tool==='fill')html+=group("drawingView.fill",swatches+quickHint+`<div class="property-toggle-grid drawing-toggle-grid">${toggle('sampleAll','drawingView.sampleAllLayers','layers')}</div><div class="drawing-hint">${messageHTML("drawingView.altClickPicksAColourFillsStayInside", {})}</div>`);
  if(tool==='shape')html+=group("drawingView.shape",swatches+quickHint+`<div class="drawing-hint">${messageHTML("drawingView.outlinesUseTheCurrentBrushShiftConstrainsTo", {})}</div>`);
  if(tool==='lasso'){
    html+=group("drawingView.select",(s.selectShape==='wand'?sliders('gap')+`<div class="property-toggle-grid drawing-toggle-grid">${toggle('sampleAll','drawingView.sampleAllLayers','layers')}</div>`:'')+`<div class="drawing-hint" data-i18n="drawingView.shiftAddsToTheSelectionAltSubtractsDragInside">Shift adds to the selection, Alt subtracts. Drag inside it to move pixels, a corner to scale or the top handle to rotate (Shift snaps to 15°).</div>`);
    const sel=drawing.selection,selected=Boolean(sel||drawing.marquee),moved=Boolean(sel&&(sel.dx||sel.dy||sel.scale!==1||sel.angle||(sel.fx??1)!==1||(sel.fy??1)!==1));
    html+=selected
      ?group("drawingView.selection",grid(field(interfaceText("drawingView.scale"),'selectionScale',(drawing.selection?.scale??1)*100,'%','min="1" max="1000"','drawingView.scale')+field(interfaceText("drawingView.angle"),'selectionAngle',drawing.selection?.angle??0,'°','','drawingView.angle'))+`<div class="property-context-actions">${moved?button('apply-selection',interfaceText("drawingView.apply"),'check', undefined, undefined, {label: {key: "drawingView.apply", params: {}}}):''}${button('cancel-selection',interfaceText("drawingView.deselect"),'close', undefined, undefined, {label: {key: "drawingView.deselect", params: {}}})}${button('invert-selection',interfaceText("drawingView.invert"),'flip', undefined, undefined, {label: {key: "drawingView.invert", params: {}}})}${button('fill-selection',interfaceText("drawingView.fill"),'paint-bucket', undefined, undefined, {label: {key: "drawingView.fill", params: {}}})}</div><div class="property-context-actions">${iconButton('flip-selection-x','flip',interfaceText("drawingView.flipSelectedPixelsHorizontally"), undefined, {title: {key: "drawingView.flipSelectedPixelsHorizontally", params: {}}})}${iconButton('flip-selection-y','rotate',interfaceText("drawingView.flipSelectedPixelsVertically"), undefined, {title: {key: "drawingView.flipSelectedPixelsVertically", params: {}}})}${iconButton('copy-pixels','duplicate',interfaceText("drawingView.copySelectedPixelsCtrlC"), undefined, {title: {key: "drawingView.copySelectedPixelsCtrlC", params: {}}})}${iconButton('cut-pixels','cut',interfaceText("drawingView.cutSelectedPixelsCtrlX"), undefined, {title: {key: "drawingView.cutSelectedPixelsCtrlX", params: {}}})}${iconButton('delete-pixels','trash',interfaceText("drawingView.deleteSelectedPixelsDelete"), undefined, {title: {key: "drawingView.deleteSelectedPixelsDelete", params: {}}})}</div>`)
      :group("drawingView.selection",`<div class="drawing-empty">${messageHTML("drawingView.dragOnTheCanvasToSelectPixels", {})}</div><div class="property-context-actions">${button('select-all',interfaceText("drawingView.selectAll"),'square', undefined, undefined, {label: {key: "drawingView.selectAll", params: {}}})}</div>`);
  }
  if(tool==='lasso'||tool==='transform')html+=details(interfaceText("drawingView.filters"),`<div class="drawing-hint">${messageHTML("drawingView.appliesToTheSelectionOrToTheWhole", {})}</div>`+sliders('filterRadius')+`<div class="property-context-actions">${button('filter-blur',interfaceText("drawingView.blur"),'circle', undefined, undefined, {label: {key: "drawingView.blur", params: {}}})}${button('filter-invert',interfaceText("drawingView.invertColors"),'flip', undefined, undefined, {label: {key: "drawingView.invertColors", params: {}}})}</div>`+sliders('hue','saturation','lightness')+`<div class="property-context-actions">${button('filter-hsl',interfaceText("drawingView.applyColor"),'check', undefined, undefined, {label: {key: "drawingView.applyColor", params: {}}})}</div>`+sliders('brightness','contrast')+`<div class="property-context-actions">${button('filter-brightness',interfaceText("drawingView.applyTone"),'check', undefined, undefined, {label: {key: "drawingView.applyTone", params: {}}})}</div>`, {label: {key: "drawingView.filters", params: {}}});
  if(tool==='transform')html+=`<div class="drawing-pose">${poseView}</div>`;
  if(tool==='pan')html+=group("drawingView.view",grid(field(interfaceText("drawingView.rotation"),'viewAngle',(drawing.state.view.rotation??0)*180/Math.PI,'°','min="-180" max="180"','drawingView.rotation'))+`<div class="property-context-actions">${button('reset-rotation',interfaceText("drawingView.resetRotation"),'rotate', undefined, undefined, {label: {key: "drawingView.resetRotation", params: {}}})}<button class="button" data-draw-action="flip-view" aria-pressed="${Boolean(drawing.state.view.flip)}" title="Mirror the view to check proportions · M" data-i18n-title="drawingView.mirrorTheViewToCheckProportionsM">${icon('flip')}<span data-i18n="drawingView.flipView">${messageHTML("drawingView.flipView", {})}</span></button></div>`);
  const filter=`<label class="drawing-resolution">${messageHTML("drawingView.pixelFiltering", {})}<select class="inline-select" data-draw-setting="filter" aria-label="Pixel filtering" data-i18n-aria-label="drawingView.pixelFiltering"><option value="smooth" ${s.filter!=='nearest'?'selected':''} data-i18n="drawingView.smooth">${messageHTML("drawingView.smooth", {})}</option><option value="nearest" ${s.filter==='nearest'?'selected':''} data-i18n="drawingView.nearestPixelArt">${messageHTML("drawingView.nearestPixelArt", {})}</option></select></label>`;
  const d=drawingMetadata(target?.figure),ratio=d?s.resolution/d.pixelsPerUnit:1,canResample=Boolean(d);
  html+=details(interfaceText("drawingView.resolution"),`${filter}<label class="drawing-resolution">${messageHTML("drawingView.newDrawings", {})}<select class="inline-select" data-draw-setting="resolution" aria-label="New drawing resolution" data-i18n-aria-label="drawingView.newDrawingResolution">${[1,2,4].map(n=>`<option value="${n}" ${s.resolution===n?'selected':''}>${n}×</option>`).join('')}</select></label>${d?`<div class="drawing-resolution-info">${messageHTML("drawingView.current", {pixelsPerUnit: d.pixelsPerUnit})}</div>`:''}<div class="property-context-actions">${button('resample',interfaceText("drawingView.resampleDrawing"),'transform',!canResample||ratio===1,interfaceText("drawingView.resizePixelsToTheSelectedResolutionUpscalingCannot"), {label: {key: "drawingView.resampleDrawing", params: {}}, title: {key: "drawingView.resizePixelsToTheSelectedResolutionUpscalingCannot", params: {}}})}</div>`, {label: {key: "drawingView.resolution", params: {}}});
  return html;
}

/** The pop-up palette (right-click): presets, the palette's colours, the
 * colour pair and the two sliders painters reach for most. */
export function paletteMarkup(drawing){
  const s=drawing.settings;
  return `${colorPair(s)}${paletteSwatches(drawing)}${drawing.tool==='brush'||drawing.tool==='eraser'?presetGrid(drawing):''}<div class="draw-sliders">${sliderMarkup('size',s.size)}${sliderMarkup('opacity',s.opacity)}</div>`;
}
/** The canvas quick bar: the settings a painter changes constantly, next to
 * the work instead of in the inspector. Choice buttons carry
 * data-draw-choice="setting" and data-value. */
export function quickBarMarkup(drawing){
  const s=drawing.settings,tool=drawing.tool;
  const choice=(key,value,label,title=label, _messages = {})=>`<button type="button" class="draw-quick-choice" data-draw-choice="${key}" data-value="${value}" aria-pressed="${s[key]===value}" title="${title}" ${_messages.title ? messageAttributes(_messages.title.key, _messages.title.params, 'title') : ''} ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params) : ''}>${label}</button>`;
  const toggleButton=(key,symbol,title, _messages = {})=>`<button type="button" class="icon-button draw-quick-toggle" data-draw-choice="${key}" data-value="toggle" aria-pressed="${Boolean(s[key])}" title="${title}" aria-label="${title}" ${_messages.title ? messageAttributes(_messages.title.key, _messages.title.params, 'title') : ''} ${_messages.title ? messageAttributes(_messages.title.key, _messages.title.params, 'aria-label') : ''}>${icon(symbol)}</button>`;
  const slider=(key,label)=>sliderMarkup(key,s[key],{compact:true,label,labelKey:SLIDERS[key].labelKey});
  const divider='<span class="draw-quick-divider" aria-hidden="true"></span>';
  // The bar names its tool, and painting tools keep the palette one click away
  // next to the colour pair: its first colours, +N for the rest (the picker)
  // and + to save the brush colour where the picker's + saves it (saveTarget).
  const toolTuple=DRAWING_TOOLS.find(t=>t[0]===tool),toolMessage=toolTuple?tupleMessages(toolTuple)[1]:{key:"drawingView.hand"},toolName=interfaceText(toolMessage.key),toolIcon=toolTuple?.[2]??'hand';
  const palette=drawingPalette(drawing),current=s.color.toLowerCase(),shown=palette.colors.slice(0,RAIL_COLORS),more=palette.colors.length-shown.length;
  const canAdd=Boolean(palette.target)&&!palette.saved.includes(current)&&palette.saved.length<palette.limit,where=palette.target==='mine'?palette.name:{messageKey:'colorPicker.projectColors'};
  const rail=shown.map(c=>`<button type="button" class="draw-quick-swatch" data-draw-color="${c}" style="background:${c}" title="${c.toUpperCase()}" aria-label="Use ${c.toUpperCase()}" aria-pressed="${c===current}" ${messageAttributes("drawingView.use", {value: c.toUpperCase()}, "aria-label")}></button>`).join('')
    +(more?`<button type="button" class="draw-quick-more" data-draw-action="open-colors" title="All ${palette.colors.length} colors" aria-label="Show all ${palette.colors.length} colors" ${messageAttributes("drawingView.allColors", {length: palette.colors.length}, "title")} ${messageAttributes("drawingView.showAllColors", {length: palette.colors.length}, "aria-label")}>+${more}</button>`:'')
    +(canAdd?`<button type="button" class="draw-quick-add" data-draw-action="add-palette-color" title="${escape(interfaceText("drawingView.addTo",{value:current.toUpperCase(),where}))}" aria-label="${escape(interfaceText("drawingView.addTo",{value:current.toUpperCase(),where}))}" ${messageAttributes("drawingView.addTo", {value: current.toUpperCase(), where: where}, "title")} ${messageAttributes("drawingView.addTo", {value: current.toUpperCase(), where: where}, "aria-label")}>${icon('plus')}</button>`:'');
  const colors=()=>colorPair(s,{hex:false})+(rail?`<div class="draw-quick-swatches" role="group" aria-label="${paletteLabel(palette)}" ${paletteLabelAttributes(palette)}>${rail}</div>`:'');
  let body=`<span class="draw-quick-tool" title="${escape(toolName)}" ${messageAttributes(toolMessage.key,{},"title")}>${icon(toolIcon)}<span ${messageAttributes(toolMessage.key)}>${escape(toolName)}</span></span>`+divider;
  if(tool==='brush'||tool==='eraser'){
    const preset=[...BRUSH_PRESETS,...(drawing.library?.presets??[])].find(p=>p.id===s.preset);
    if(tool==='brush')body+=`<button type="button" class="draw-quick-preset" data-draw-action="toggle-quick-presets" aria-expanded="${Boolean(drawing.quickPresets)}" title="Brush presets" data-i18n-title="drawingView.brushPresets">${preset?`<img src="${presetThumbnail(preset)}" alt="">`:icon('brush')}<span ${brushMessages[preset?.id] ? messageAttributes(brushMessages[preset.id].nameKey) : !preset ? messageAttributes("drawingView.custom") : ''}>${escape(preset?.name??interfaceText("drawingView.custom"))}</span></button>`+colors()+divider;
    body+=slider('size',interfaceText("drawingView.size"))+slider('opacity',interfaceText("drawingView.opacity"))+slider('flow',interfaceText("drawingView.flow"))+slider('stabilization',interfaceText("drawingView.smooth"))+divider+toggleButton('mirrorX','flip',interfaceText("drawingView.mirrorPaintingShiftM"), {title: {key: "drawingView.mirrorPaintingShiftM", params: {}}});
  }else if(tool==='fill')body+=colors()+divider+slider('tolerance',interfaceText("drawingView.tolerance"))+slider('gap',interfaceText("drawingView.gaps"))+slider('expansion',interfaceText("drawingView.expand"));
  else if(tool==='lasso')body+=choice('selectShape','lasso',interfaceText("drawingView.lasso"), undefined, {label: {key: "drawingView.lasso", params: {}}})+choice('selectShape','rect',interfaceText("drawingView.rectangle"), undefined, {label: {key: "drawingView.rectangle", params: {}}})+choice('selectShape','ellipse',interfaceText("drawingView.ellipse"), undefined, {label: {key: "drawingView.ellipse", params: {}}})+choice('selectShape','wand',interfaceText("drawingView.wand"), undefined, {label: {key: "drawingView.wand", params: {}}})+(s.selectShape==='wand'?divider+slider('tolerance',interfaceText("drawingView.tolerance")):'');
  else if(tool==='shape')body+=choice('shapeKind','line',interfaceText("drawingView.line"), undefined, {label: {key: "drawingView.line", params: {}}})+choice('shapeKind','rect',interfaceText("drawingView.rectangle"), undefined, {label: {key: "drawingView.rectangle", params: {}}})+choice('shapeKind','ellipse',interfaceText("drawingView.ellipse"), undefined, {label: {key: "drawingView.ellipse", params: {}}})+divider+`<button type="button" class="draw-quick-choice" data-draw-choice="shapeFill" data-value="toggle" aria-pressed="${Boolean(s.shapeFill)}" title="Fill the shape instead of outlining it" data-i18n-title="drawingView.fillTheShapeInsteadOfOutliningIt">${icon('paint-bucket')}${messageHTML("drawingView.fill", {})}</button>`+colors()+divider+slider('size',interfaceText("drawingView.size"))+slider('opacity',interfaceText("drawingView.opacity"));
  else body+=`<button type="button" class="draw-quick-choice" data-draw-action="flip-view" aria-pressed="${Boolean(drawing.state.view.flip)}" title="Mirror the view · M" data-i18n-title="drawingView.mirrorTheViewM" data-i18n="drawingView.flipView">${messageHTML("drawingView.flipView", {})}</button><button type="button" class="draw-quick-choice" data-draw-action="reset-rotation" title="Reset view rotation" data-i18n-title="drawingView.resetViewRotation" data-i18n="drawingView.resetRotation">${messageHTML("drawingView.resetRotation", {})}</button>`;
  const presets=tool==='brush'&&drawing.quickPresets?`<div class="draw-quick-presets">${presetGrid(drawing)}</div>`:'';
  return `<div class="draw-quick-row">${body}</div>${presets}`;
}
