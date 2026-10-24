import {errorText} from './error-presentation.mjs';
import {localizedAttribute, appendLocalized, replaceLocalized} from './localization-bindings.mjs';

import {restoreMessageError, messageError} from './localized-error.mjs';
import {t as interfaceText} from './localization.mjs';

import {lassoBounds,lassoContains,selectionStores} from './drawing-lasso.mjs';
import {BRUSH_PRESETS,quickBarMarkup,paletteMarkup} from './drawing-view.mjs';
import {brushMessages} from './drawing-brush-labels.mjs';
import {recentColors,setRecentColors,rememberColor as rememberRecentColor,saveColor,subscribePalette} from './color-palette.mjs';
import {SLIDERS,installDrawingSliders,refreshSliders,formatSlider,displayValue} from './drawing-sliders.mjs';
import {WetInk} from './drawing-wet-ink.mjs';
import {installPressureCurve} from './drawing-pressure-curve.mjs';
import {maskValue,lassoMask,rectPoints,ellipsePoints,combineMasks,invertMask,rectMask,maskEdges,pointFilterWork} from './drawing-pixels.mjs';
import {normalizeBrush,dabRadius,BRUSH_DEFAULTS,BRUSH_KEYS,BRUSH_LENGTHS,LINEAR_PRESSURE} from './drawing-brush.mjs';
import {createBrushStroke,loadDrawingEngine,paintStroke} from './engine/engine-drawing.mjs';
import {drawingMetadata,migrateDrawingFigure,isDrawingLayer,drawingPixelMatrix,inversePoint,transformPoint,DRAWING_MAX_PIXELS,FILL_SOURCE_MAX_PIXELS} from './drawing-model.mjs';
import {TILE,tileKey,parseTileKey,TileStore} from './drawing-tiles.mjs';
import {drawingBarrier,drawingResourcesFor} from './drawing-resources.mjs';
import {drawingCelPrefetch,drawingCelDistances} from './onion-skin.mjs';
import {buildGeometry} from './pivot/geometry.mjs';
import {applyLayerOrder} from './layers.mjs';
import {createFrame} from './demo.mjs';
import {screenToWorld,worldToScreen} from './renderer-geometry.mjs';
import {TRANSFORM_BYTES,transformSupportBounds,tileIntersects,inverseMatrix,multiplyMatrix,indexedTileCoverage} from './drawing-transform.mjs';
import {validatePixelClipboard} from './drawing-clipboard.mjs';
import {selectionMatrix,selectionTiles,selectionPresenter} from './drawing-selection.mjs';
import {installCanvasPinch} from './canvas-pinch.mjs';

const pointerSample=e=>({clientX:e.clientX,clientY:e.clientY,pressure:e.pressure,pointerType:e.pointerType,timeStamp:e.timeStamp,button:e.button,buttons:e.buttons,shiftKey:e.shiftKey,altKey:e.altKey,ctrlKey:e.ctrlKey,metaKey:e.metaKey,tiltX:e.tiltX,tiltY:e.tiltY});
const yieldToInput=()=>globalThis.scheduler?.yield?globalThis.scheduler.yield():new Promise(resolve=>setTimeout(resolve,0));
const canvas=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;};
const brushKeys=['preset',...BRUSH_KEYS];
// Settings edited as percentages in the inspector.
const PERCENT_SETTINGS=['opacity','flow','hardness','stabilization','roundness','scatter','spacingRatio','texture','smudgeLength','colorRate'];
const hexColor=rgb=>'#'+rgb.slice(0,3).map(n=>(Math.round(n)).toString(16).padStart(2,'0')).join('');
/** A floating selection that moved, scaled, rotated or flipped. */
export const moved=s=>Boolean(s&&(s.dx||s.dy||s.scale!==1||s.angle||(s.fx??1)!==1||(s.fy??1)!==1));
const BRUSH_LIBRARY_KEY='stykanimate.drawing-brushes.v1';
const loadLibrary=()=>{try{const v=JSON.parse(globalThis.localStorage?.getItem(BRUSH_LIBRARY_KEY)||'{}');return {presets:Array.isArray(v.presets)?v.presets.filter(p=>p&&typeof p.id==='string'&&typeof p.name==='string').slice(0,48):[],pressureCurve:Array.isArray(v.pressureCurve)&&v.pressureCurve.length===4&&v.pressureCurve.every(n=>Number.isFinite(n)&&n>=0&&n<=1)?v.pressureCurve:[...LINEAR_PRESSURE]};}catch{return {presets:[],pressureCurve:[...LINEAR_PRESSURE]};}};
const FILTER_LABELS={blur:'Blur drawing',hsl:'Adjust hue and saturation',brightness:'Adjust brightness and contrast',invert:'Invert colours'};
// Actions that keep (or act on) the pixel selection instead of applying it first.
const SELECTION_ACTIONS=['filter-blur','filter-hsl','filter-brightness','filter-invert','swap-colors','save-preset','delete-preset','flip-selection-x','flip-selection-y','copy-pixels','cut-pixels','delete-pixels','apply-selection','cancel-selection','select-all','invert-selection','deselect','fill-selection'];
const PAINT_TOOLS=['brush','eraser','fill','shape'];
// Input samples one stroke may queue: minutes of 240 Hz pen input.
const MAX_STROKE_SAMPLES=65536;
const unionRects=(a,b)=>{if(!a)return b?{...b}:null;if(!b)return{...a};const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y);return{x,y,width:Math.max(a.x+a.width,b.x+b.width)-x,height:Math.max(a.y+a.height,b.y+b.height)-y};};
export class DrawingController {
  constructor({editor,state,overlay,viewport,onRender,onOverlayRender=onRender,onView=()=>{},onUI,onError,onStatus,beforeEdit,artwork,getTimeline,getClipboard,sampleColor,fingerDrawing=()=>'never'}) {
    // Whether a finger draws (docs/TOUCH.md): 'auto' until a pen is used, 'always', or 'never' (a finger pans).
    // The app answers 'never' for Automatic outside the touch interface.
    this.fingerDrawing=fingerDrawing;this.penSeen=false;
    // Dab shapes, the brush samples and the preset thumbnails come from the drawing raster
    // engine; the interface that shows them is built again once it has loaded here.
    loadDrawingEngine().then(()=>{this.previewCache=null;this.onUI();},error=>onError(error));
    Object.assign(this,{editor,state,overlay,viewport,onRender,onUI,onError,onStatus,beforeEdit,artwork,getTimeline,getClipboard,sampleColor,settings:{preset:'ink',...BRUSH_DEFAULTS,spacingRatio:.08,color:'#252525',filterRadius:4,hue:0,saturation:0,lightness:0,brightness:0,contrast:0,mirrorX:false,mirrorY:false,selectShape:'lasso',shapeKind:'rect',shapeFill:false,color2:'#ffffff',resolution:2,filter:'smooth',length:1,tolerance:16,expansion:1,gap:0,sampleAll:false},sequence:0,strokeId:0,sessions:new Map(),strokeStats:{batches:0,maxQueueDepth:0,lastRoundTripMs:0}});
    // Recent colours are the shared palette's (color-palette.mjs), so every
    // picker offers what was painted; the property keeps Draw's old name and
    // stays out of the brush library's saved JSON.
    this.library=Object.defineProperty(loadLibrary(),'recent',{get:recentColors,set:setRecentColors,enumerable:false});
    this.onOverlayRender=onOverlayRender;this.onView=onView;
    this.panel=document.getElementById('inspector');
    const events=this.events=new AbortController(),opts={signal:events.signal};
    this.touchNavigation=installCanvasPinch({overlay,viewport,signal:events.signal,
      enabled:()=>this.active&&!state.playing&&this.penPointerId==null&&performance.now()-(this.lastPen??-Infinity)>=700,
      getView:()=>state.view,
      toLocal:event=>{const r=this.viewRect();return {x:(event.clientX-r.left)*r.clientWidth/r.width,y:(event.clientY-r.top)*r.clientHeight/r.height};},
      setView:view=>{Object.assign(state.view,view);this.onView();this.onRender();},
      onStart:()=>{if(this.gesture?.kind==='pan')this.finish({navigation:false});else this.cancel({navigation:false});this.onRender();},
      onEnd:()=>this.onRender(),
    });
    // The inspector and the canvas quick bar share click, change and slider handling.
    for(const root of [this.panel,this.quickBar=this.createQuickBar()]){
      root.addEventListener('click',event=>this.handleClick(event),opts);
      root.addEventListener('change',event=>{if(event.target.dataset.drawSetting)this.run(()=>this.change(event));},opts);
      installDrawingSliders(root,{get:key=>this.settings[key],set:(key,value)=>this.setSetting(key,value),end:()=>{this.sliderEnded();},signal:events.signal,wheel:root===this.quickBar});
    }
    // The pen pressure curve is global and persists with the brush library.
    installPressureCurve(this.panel,{get:()=>this.library.pressureCurve,set:curve=>{this.library.pressureCurve=curve;this.paintPreview(this.panel);},end:()=>this.saveLibrary(),signal:events.signal});
    // Every UI refresh also refreshes the quick bar, coalesced per frame.
    const ui=this.onUI;this.onUI=()=>{ui();this.queueQuickBar();};
    // The colour rail follows the palette: its view, recent colours and the project's colours.
    const unsubscribe=subscribePalette(()=>{if(this.active)this.onUI();});events.signal.addEventListener('abort',unsubscribe,{once:true});
    editor.addEventListener('change',event=>{if(event.detail?.palette&&this.active)this.queueQuickBar();},opts);
    // pointerrawupdate delivers pen samples as they arrive instead of aligned
    // to the next frame; pointermove still drives everything else and remains
    // the fallback where raw updates are unavailable.
    const raw=typeof window!=='undefined'&&'onpointerrawupdate' in window?[['pointerrawupdate',e=>this.rawMove(e)]]:[];
    for(const [name,handler] of [['pointerdown',e=>this.down(e)],['pointermove',e=>this.move(e)],...raw,['pointerup',e=>this.up(e)],['pointercancel',e=>this.up(e)],['lostpointercapture',e=>this.up(e)]])overlay.addEventListener(name,event=>{
      if(!this.active)return;
      if(event.pointerType==='pen'){
        this.lastPen=performance.now();
        if(event.type==='pointerdown')this.penPointerId=event.pointerId;
        else if(['pointerup','pointercancel','lostpointercapture'].includes(event.type))this.penPointerId=null;
      }
      // The shared viewport owns the entire pan gesture, including moves whose
      // button is -1 and release after Space has already been lifted.
      if(state.drag?.kind==='pan')return;
      if(event.type==='pointerdown'&&(event.button===1||state.space||this.tool==='pan')){this.finish();return;}
      if(!this.gesture&&(this.tool==='pan'||state.space||event.button===1||event.buttons&4))return;
      // Right-click opens the pop-up palette for painting tools, as in Krita.
      if(event.type==='pointerdown'&&event.button===2&&!this.gesture&&PAINT_TOOLS.includes(this.tool)){event.stopImmediatePropagation();event.preventDefault();this.openPalette(event.clientX,event.clientY);return;}
      if(event.type==='pointerdown'&&(event.button!==0&&event.button!==5||state.playing))return;
      event.stopImmediatePropagation();event.preventDefault();this.run(()=>handler(event));
    },{...opts,capture:true});
    overlay.addEventListener('contextmenu',event=>{if(this.active&&PAINT_TOOLS.includes(this.tool)){event.preventDefault();event.stopImmediatePropagation();}},{...opts,capture:true});
    document.addEventListener('pointerdown',event=>{if(this.palette&&!this.palette.hidden&&!this.palette.contains(event.target)&&event.button!==2)this.closePalette();},{...opts,capture:true});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&this.palette&&!this.palette.hidden){event.stopImmediatePropagation();event.preventDefault();this.closePalette();}},{...opts,capture:true});
    // Leaving the window ends the gesture but keeps its ink.
    window.addEventListener('blur',()=>{this.penPointerId=null;this.touchNavigation.cancel();if(this.gesture)this.finish();},opts);
    // The brush ring tracks the last move; it must not linger once the pointer leaves.
    overlay.addEventListener('pointerleave',()=>{if(this.cursor){this.cursor=null;this.onOverlayRender();}},opts);
    editor.addEventListener('change',event=>{
      const kind=event.detail.kind;
      if(['document','seek','history'].includes(kind))this.touchNavigation.cancel();
      if(kind==='document'){this.cancel();this.selection=null;this.marquee=null;this.bind();}
      if(kind==='seek'){this.finish();if(this.operation?.selection)this.operation.abort.abort();this.cancelSelection();}
      if(kind==='history'){if(!this.operation?.history)this.cancel();this.cancelSelection();}
      if(kind==='document'||kind==='seek')this.prefetchCels();
      if(this.active){this.sync();this.prepareVisible();}
    },opts);
    // Navigation begins before the editor changes its active layer or playhead.
    document.addEventListener('pointerdown',event=>{if(this.gesture&&!overlay.contains(event.target))this.finish();if(this.selection&&event.target.closest?.('.layer-timeline,.sheet-filmstrip'))this.run(()=>this.applySelection());},{...opts,capture:true});
    this.bind();
  }
  get interacting(){return Boolean(this.gesture||this.loading||this.operation||this.touchNavigation?.active);}
  bind({required=false}={}){
    // Resources exist only for reports that carry drawings (or while Draw is
    // open and is about to create one); an animation without drawings must
    // never spawn stores, workers or presenters.
    const report=this.editor.report,owner=drawingResourcesFor(report)??((required||this.active||report.figure_types?.some(figure=>drawingMetadata(figure)))?this.editor.drawingResources:null);
    if(owner===this.owner)return;this.owner=owner;if(!owner)return;
    // A decoded or evicted cel changes its own entry's store and stamp; each
    // cached raster records the entries it painted and repaints only when one
    // of them changes. Clearing every raster re-rasterized all figures and
    // onion skins whenever a neighbouring cel finished decoding.
    owner.onChange=()=>{if(this.selection?.presenter)this.selection.presenter.stamp++;if(this.surfaceVersion!==owner.surfaceVersion){this.surfaceVersion=owner.surfaceVersion;if(this.state.renderer)this.state.renderer.lastGeometry=null;}this.onRender();};owner.onError=this.onError;
    // A floating selection is shown in two parts: the cel without the selected pixels, and the
    // selected pixels through the selection's transform (engine/engine-live-cels.mjs).
    owner.liveSource=entry=>{const s=this.selection;return s&&!s.committing&&drawingMetadata(s.target.figure)?.celId===entry.id?{base:s.remainder,float:{store:s.source,matrix:selectionMatrix(s)}}:null;};
    owner.strokeWorker.onmessage=data=>this.strokeMessage(data);owner.strokeWorker.onerror=error=>{owner.strokeWorker.dispose();this.cancel();this.onError(error);};
  }
  /** Decode the cel under the playhead plus its two unique neighbours each way
   * so onion skins and scrubs never wait on the decode queue. Neighbours queue
   * first: the bounded decode queue drops stale pending jobs oldest-first, so
   * the current cel always survives a burst of seeks. */
  prefetchCels(){
    const owner=this.owner;if(!owner||owner.disposed)return;
    // Eviction keeps cels near the playhead; computed lazily when memory is tight.
    owner.distances=()=>drawingCelDistances(this.editor);
    const found=drawingCelPrefetch(this.editor,this.editor.activeLayerId);if(!found)return;
    const miss=error=>{if(error.name!=='AbortError')this.onError(error);};
    for(const figure of found.neighbors)owner.surface(figure).catch(miss);
    if(found.current)owner.surface(found.current).catch(miss);
  }
  run(operation){try{const result=operation();if(result?.catch)result.catch(error=>{this.cancel();if(error.name!=='AbortError')this.onError(error);});return result;}catch(error){this.cancel();this.onError(error);}}
  /** Commands wait for the pixel transaction, not PNG publication. Seeking
   * may update the view meanwhile; the stroke still owns its original key. */
  settle({selection=false}={}){
    if(this.operation)return this.operation.done.then(()=>this.settle({selection}));
    if(this.loading?.done){const pending=this.loading;pending.released=true;return pending.done.then(()=>this.settle({selection}));}
    const finish=this.finish();if(finish?.then)return finish.then(()=>this.settle({selection}));const stroke=this.gesture?.session?.done;
    if(stroke)return stroke.then(()=>this.settle({selection}));
    return this.selection?.committing??(selection?this.applySelection():null);
  }
  /** One pixel transaction owns worker work and its target until publication.
   * Navigation/save barriers await it; Escape terminates it without publishing. */
  pixelOperation(label,operation,{selection=false,labelKey}={}){
    if(this.operation)return this.operation.done.then(()=>this.pixelOperation(label,operation,{selection,labelKey}));
    const owner=this.owner,revision=this.editor.revision,op={owner,selection,abort:new AbortController()};
    op.check=()=>{if(op.abort.signal.aborted||owner!==this.owner||revision!==this.editor.revision)throw messageError(new DOMException('', 'AbortError'), "errors.drawingController.drawingOperationSuperseded", {});};
    op.reserve=(surface,requested=TRANSFORM_BYTES,headroom=0)=>{op.check();op.copiedBytes=0;owner.hold(op,0);owner.reserve(0,surface);const s=owner.stats;op.maxBytes=Math.min(requested,Math.max(0,owner.hardBudget-s.bytes-s.historyBytes-s.deferredBytes-s.workingBytes-headroom));owner.hold(op,op.maxBytes,surface);};
    op.received=tiles=>owner.hold(op,tiles.reduce((n,t)=>n+(t.pixels?.byteLength??0)+(t.before?.byteLength??0)+(t.after?.byteLength??0)+(t.remaining?.byteLength??0),0));
    this.operation=op;owner.busy=true;const statusParams={label:labelKey?{messageKey:labelKey}:label};this.onStatus(interfaceText('drawingController.operation', statusParams), 'drawingController.operation', statusParams);this.onRender();
    op.done=Promise.resolve().then(()=>operation(op)).then(value=>{op.succeeded=true;return value;}).finally(()=>{
      owner.hold(op,0);owner.busy=false;if(this.operation===op)this.operation=null;
      if(op.abort.signal.aborted||!op.succeeded)this.loading=null;else this.resumeQueuedPointer();
      this.onRender();
    });
    return op.done;
  }
  async copyWorkerTiles(surface,op,predicate=()=>true,{encoded=false}={}){
    const tiles=[];let copied=0;
    for(const tile of surface.store){
      if(!predicate(tile))continue;
      const field=encoded&&tile.png?.byteLength<=65536?'png':'pixels',bytes=tile[field];
      if((op.copiedBytes??0)+bytes.byteLength>op.maxBytes)throw messageError(new Error(''), "errors.drawingController.theOperationExceedsTheDrawingWorkingMemoryLimit", {});
      op.copiedBytes=(op.copiedBytes??0)+bytes.byteLength;
      tiles.push({tx:tile.tx,ty:tile.ty,[field]:bytes.slice().buffer,alphaBounds:tile.alphaBounds});
      if(++copied%128===0){await yieldToInput();op.check();}
    }
    return tiles;
  }
  async commitPixels(target,tiles,label,op){
    const command={kind:'drawing-pixels',celId:drawingMetadata(target.figure).celId,tiles};
    const prepared=await op.owner.prepareChanges(command,'after',{signal:op.abort.signal,checkCurrent:op.check});
    try{
      op.check();const changed=this.editor.commitDrawingPixels(target,tiles,label,prepared);
      // History now owns the reply buffers. Release their transaction hold
      // before background history/publication jobs inspect the budget.
      op.owner.hold(op,0);return changed;
    }finally{prepared?.release();}
  }
  resumeQueuedPointer(){
    const queued=this.loading?.queued?this.loading:null;
    if(queued&&!this.gesture&&!this.operation){this.loading=null;this.run(()=>this.down({...queued.event,samples:queued.samples,released:queued.released}));}
  }
  afterGesture(operation){
    const wait=this.settle({selection:true}),report=this.editor.report;
    return wait?wait.then(()=>{if(report!==this.editor.report)throw messageError(new DOMException('', 'AbortError'), "errors.drawingController.drawingDocumentChanged", {});return operation();}):operation();
  }
  history(direction){
    return this.afterGesture(()=>{
      const command=this.editor[direction==='undo'?'_undo':'_redo'].at(-1),side=direction==='undo'?'before':'after';
      if(!this.owner?.history?.needsLoad(command)&&!this.owner?.needsPreparation(command,side))return this.editor[direction]();
      return this.pixelOperation({messageKey:direction==='undo'?'drawingController.restoringUndo':'drawingController.restoringRedo'},async op=>{op.history=true;return this.editor[direction]({signal:op.abort.signal});});
    });
  }
  /** Clicks on presets, swatches, choices and actions (inspector or quick bar). */
  handleClick(event){
    const preset=event.target.closest('[data-draw-preset]'),action=event.target.closest('[data-draw-action]'),swatch=event.target.closest('[data-draw-color]'),choice=event.target.closest('[data-draw-choice]');
    if(preset){this.finish();const id=preset.dataset.drawPreset,found=BRUSH_PRESETS.find(p=>p.id===id)??this.library.presets.find(p=>p.id===id);if(found){const {name,description,...tip}=found;Object.assign(this.settings,tip,{preset:id});}this.quickPresets=false;this.onUI();this.paintPreview(this.panel);}
    if(swatch){this.settings.color=swatch.dataset.drawColor;this.onUI();this.paintPreview(this.panel);}
    if(choice){const key=choice.dataset.drawChoice,value=choice.dataset.value;this.settings[key]=value==='toggle'?!this.settings[key]:value;this.onUI();this.onRender();}
    if(action?.dataset.drawAction==='toggle-quick-presets'){this.quickPresets=!this.quickPresets;this.queueQuickBar();return;}
    // The rail's + saves the brush colour to the palette shown; +N opens the picker with the whole palette.
    if(action?.dataset.drawAction==='add-palette-color'){try{saveColor(this.settings.color);}catch(error){this.onError(error);}this.onUI();return;}
    if(action?.dataset.drawAction==='open-colors'){action.parentElement?.parentElement?.querySelector('.draw-color-primary')?.click();return;}
    if(action)this.run(()=>this.action(action.dataset.drawAction));
  }
  /** Set one drawing setting live (sliders, keys, Ctrl-drag). */
  setSetting(key,value){
    this.settings[key]=value;
    if(BRUSH_KEYS.includes(key)&&key!=='alphaLock')this.settings.preset=null;
    refreshSliders(key,value);this.paintPreview(this.panel);
    if(SLIDERS[key]&&['size','opacity','flow','hardness','stabilization'].includes(key))this.hud(`${SLIDERS[key].label} ${formatSlider(key,displayValue(key,value))}`);
    this.onRender();
  }
  sliderEnded(){this.onUI();}
  /** The shared colour picker for the main or second colour. It writes the
   * setting on every drag step and never keeps the input it opened from, so
   * the quick bar, Properties or palette can re-render under it. */
  colorPicker(input){
    const key=input.dataset.drawSetting==='color2'?'color2':'color',value=this.settings[key]??'#ffffff';
    return {anchor:input,title:key==='color2'?interfaceText('drawingController.secondColor'):interfaceText('drawingController.color'), titleKey: (key==='color2' ? 'drawingController.secondColor' : 'drawingController.color'), titleParams: (key==='color2' ? {} : {}),live:true,placement:'below',gradients:false,alpha:false,
      paint:{type:'solid',stops:[{offset:0,color:value.slice(1).match(/../g).map(n=>parseInt(n,16)),opacity:1}]},
      onChange:paint=>{const hex=hexColor(paint.stops[0].color);if(hex===this.settings[key])return;this.settings[key]=hex;this.paintPreview(this.panel);this.onUI();this.onRender();}};
  }
  /** Keyboard adjustments routed from the hotkey map; true when handled. */
  hotkey(name){
    const s=this.settings;
    if(name==='smaller'||name==='larger'){this.setSetting('size',Math.max(.5,Math.min(2048,s.size*(name==='smaller'?.8:1.25))));this.onUI();return true;}
    if(name==='softer'||name==='harder'){this.setSetting('hardness',Math.max(0,Math.min(1,Math.round((s.hardness+(name==='softer'?-.1:.1))*10)/10)));this.onUI();return true;}
    const opacity=/^opacity-(\d+)$/.exec(name);if(opacity){this.setSetting('opacity',Number(opacity[1])/100);this.onUI();return true;}
    return false;
  }
  /** A transient readout on the canvas for size, opacity and similar changes. */
  hud(text){
    if(!this.active)return;
    const el=this.hudElement??=Object.assign(document.createElement('div'),{className:'drawing-hud',role:'status'});
    if(!el.isConnected)appendLocalized(this.viewport, el);
    el.textContent=text;el.classList.add('is-visible');clearTimeout(this.hudTimer);this.hudTimer=setTimeout(()=>el.classList.remove('is-visible'),900);
  }
  /** Krita's pop-up palette at the pointer: presets, recent colours, the
   * colour pair, size and opacity. A choice or Escape closes it. */
  openPalette(clientX,clientY){
    const palette=this.palette??=this.createPalette();
    palette.innerHTML=paletteMarkup(this);palette.hidden=false;
    const view=this.viewport.getBoundingClientRect(),w=palette.offsetWidth,h=palette.offsetHeight;
    palette.style.left=Math.round(Math.max(8,Math.min(view.width-w-8,clientX-view.left-w/2)))+'px';
    palette.style.top=Math.round(Math.max(8,Math.min(view.height-h-8,clientY-view.top-h/2)))+'px';
    palette.querySelector('[aria-pressed="true"],.drawing-preset')?.focus({preventScroll:true});
  }
  // Emptied when closed so no hidden duplicate controls linger in the page.
  closePalette(){if(this.palette&&!this.palette.hidden){this.palette.hidden=true;replaceLocalized(this.palette);this.viewport.focus({preventScroll:true});}}
  createPalette(){
    const palette=document.createElement('div');palette.className='drawing-palette';palette.setAttribute('role','dialog');localizedAttribute(palette, 'aria-label', 'drawingController.brushPalette', {});palette.hidden=true;appendLocalized(this.viewport, palette);
    const signal=this.events.signal;
    palette.addEventListener('click',event=>{const chosen=event.target.closest('[data-draw-preset],[data-draw-color]');this.handleClick(event);if(chosen)this.closePalette();else if(!palette.hidden&&event.target.closest('[data-draw-action]'))palette.innerHTML=paletteMarkup(this);},{signal});
    palette.addEventListener('change',event=>{if(event.target.dataset.drawSetting)this.run(()=>this.change(event));},{signal});
    palette.addEventListener('contextmenu',event=>event.preventDefault(),{signal});
    installDrawingSliders(palette,{get:key=>this.settings[key],set:(key,value)=>this.setSetting(key,value),end:()=>this.sliderEnded(),signal,wheel:true});
    return palette;
  }
  createQuickBar(){const bar=document.createElement('div');bar.className='drawing-quickbar';bar.setAttribute('role','toolbar');localizedAttribute(bar, 'aria-label', 'drawingController.drawingToolOptions', {});bar.hidden=true;appendLocalized(this.viewport, bar);
    if(typeof ResizeObserver!=='undefined'){this._quickFit=new ResizeObserver(()=>this.fitQuickBar());this._quickFit.observe(this.viewport);}
    return bar;}
  /** Until the quick bar moves into the stage header (M3b, M7b): in a narrow stage it drops the tool's and preset's names,
   * then narrows its sliders, before its row scrolls (with a drawn scrollbar), so no control is cut off. */
  fitQuickBar(){
    const bar=this.quickBar,row=bar?.querySelector('.draw-quick-row');if(!row||bar.hidden)return;
    for(const fit of ['','tight','tighter']){if(fit)bar.dataset.fit=fit;else delete bar.dataset.fit;if(row.scrollWidth<=row.clientWidth+1)return;}
  }
  queueQuickBar(){if(this.quickQueued)return;this.quickQueued=true;requestAnimationFrame(()=>{this.quickQueued=false;this.renderQuickBar();});}
  renderQuickBar(){
    const bar=this.quickBar;if(!bar)return;
    if(!this.active){if(!bar.hidden)bar.hidden=true;return;}
    // Never rebuild under an active slider drag or an open inline edit.
    if(bar.querySelector('.draw-slider.is-dragging,.draw-slider.is-editing'))return;
    // Compare with the last markup, not innerHTML (browsers normalize it), so
    // an unchanged bar is never rebuilt under the pointer.
    const html=quickBarMarkup(this);if(this.quickHTML!==html){bar.innerHTML=html;this.quickHTML=html;}bar.hidden=false;this.fitQuickBar();
  }
  /** Painting tools need a drawing layer. Rather than ignoring the first stroke,
   * switch to an editable drawing layer, or create one (its own undo step). */
  ensurePaintLayer(){
    if(!['brush','fill','shape'].includes(this.tool))return;
    const active=this.editor.getLayer(this.editor.activeLayerId);
    // A hidden or locked drawing layer is a deliberate state; keep its message.
    if(isDrawingLayer(active))return;
    const layers=this.editor.layers.filter(layer=>isDrawingLayer(layer)&&!layer.locked&&layer.visible);
    let layer=layers.find(l=>l.id===this.lastLayer)||layers.at(-1);
    if(layer)this.onStatus(interfaceText('drawingController.paintingLayer', {name:layer.name}), 'drawingController.paintingLayer', {name:layer.name});
    else{layer=this.editor.createDrawingLayer();this.onStatus(interfaceText('drawingController.createdLayer', {name:layer.name}), 'drawingController.createdLayer', {name:layer.name});}
    this.editor.selectSheetLayer(layer.id);this.state.selectedTrackId=layer.id;this.getTimeline()?.selectTrack?.(layer.id);this.sync();this.onUI();
  }
  enter(){if(this.active)return;this.beforeEdit();this.prior={handles:this.state.handles,tool:this.state.tool,rotation:this.state.view.rotation??0,flip:Boolean(this.state.view.flip),documentToken:this.editor._documentToken,layerId:this.editor.activeLayerId,uid:this.editor.selectedUid,joint:this.editor.selectedJoint};this.active=true;this.state.handles=false;this.state.tool='drawing-brush';this.state.drawing=true;this.cursor=null;this.bind();
    const layers=this.editor.layers.filter(layer=>isDrawingLayer(layer)&&!layer.locked&&layer.visible),target=layers.find(l=>l.id===this.editor.activeLayerId)||layers.find(l=>l.id===this.lastLayer)||layers.at(-1);if(target){this.editor.selectSheetLayer(target.id);this.state.selectedTrackId=target.id;}this.sync();this.prepareVisible();this.onUI();this.onRender();}
  exit(){
    if(!this.active)return;
    const wait=this.settle({selection:true});if(wait)return this.run(()=>wait.then(()=>this.exit()));
    this.closePalette();this.active=false;this.state.drawing=false;this.cursor=null;this.owner?.watch(null);
    Object.assign(this.state,{handles:this.prior.handles,tool:this.prior.tool});
    this.state.view.rotation=this.prior.rotation;this.state.view.flip=this.prior.flip;
    // Draw may have selected a cel automatically. Return to a usable figure
    // layer so Animate's frame command and canvas no longer target that cel.
    // Respect a figure layer explicitly selected while Draw was open.
    const e=this.editor,active=e.getLayer(e.activeLayerId);
    if(!active||isDrawingLayer(active)){
      const eligible=layer=>layer?.kind==='layer'&&!isDrawingLayer(layer)&&layer.visible&&!layer.locked;
      const sameDocument=this.prior.documentToken===e._documentToken;
      const prior=sameDocument?e.getLayer(this.prior.layerId):null;
      const target=eligible(prior)?prior:e.layers.find(eligible);
      if(target){
        e.selectSheetLayer(target.id);
        if(sameDocument&&target.id===this.prior.layerId&&this.prior.uid===null)e.select(null);
        if(sameDocument&&target.id===this.prior.layerId&&e.evaluatedFrame.objects.some(o=>o.unique_id===this.prior.uid&&e.layerForUid(o.unique_id)===target.id))
          e.select(this.prior.uid,this.prior.joint);
        this.state.selectedTrackId=target.id;this.getTimeline()?.selectTrack?.(target.id);
      }
    }
    this.onUI();this.onRender();
  }
  get tool(){return this.state.tool==='hand'?'pan':this.state.tool.replace('drawing-','');}
  set tool(value){this.setTool(value);}
  setTool(value){const wait=this.settle({selection:false})??(value!=='lasso'?this.settleFloating():null);if(wait)return this.run(()=>wait.then(()=>this.setTool(value)));
    // Brush and eraser remember their own tip, pressure and size settings.
    this.tips??={eraser:{preset:null,size:24,opacity:1,flow:1,hardness:1,pressureSize:true,pressureOpacity:false,pressureFlow:false,sizeCurve:1,opacityCurve:1,stabilization:0,roundness:1,angle:0,angleMode:'fixed',scatter:0,blend:'normal',alphaLock:false}};
    if(['brush','eraser'].includes(this.tool))this.tips[this.tool]=Object.fromEntries(brushKeys.map(key=>[key,this.settings[key]]));
    if(this.tips[value])Object.assign(this.settings,this.tips[value]);
    this.state.tool=value==='pan'?'hand':'drawing-'+value;if(value==='transform'){try{const t=this.editor.drawingTarget();if(t.object)this.editor.select(t.object.unique_id);}catch{}}this.sync();this.onUI();this.onRender();}
  get pixelClipboard(){return this.editor._drawingPixelClipboard;}
  get exposureMessage(){try{const t=this.editor.drawingTarget();return {key: 'drawingController.exposure', params: {kind: {messageKey: t.figure ? 'drawingController.drawing' : 'drawingController.blank'}, start: t.key.tick+1, end: t.end, hold: this.editor.tick!==t.key.tick ? {messageKey: 'drawingController.editingHold'} : ''}};}catch{return {key: 'drawingController.noExposure', params: {}};}}
  get exposureLabel(){const {key,params}=this.exposureMessage;return interfaceText(key,params);}
  sync(){if(!this.active)return;try{const t=this.editor.drawingTarget();this.exposure={layerId:t.id,start:t.key.tick,end:t.end};this.lastLayer=t.id;}catch{this.exposure=null;}localizedAttribute(this.viewport, 'aria-label', 'drawingController.drawingCanvasBBrushEEraserGFillU', {});this.overlay.style.cursor=this.tool==='pan'?'grab':this.tool==='transform'?'move':'crosshair';}
  propertyValue(key){key=key.slice(5);if(key==='viewAngle')return (this.state.view.rotation??0)*180/Math.PI;if(key==='selectionScale')return (this.selection?.scale??1)*100;if(key==='selectionAngle')return this.selection?.angle??0;return this.settings[key]*(PERCENT_SETTINGS.includes(key)?100:1);}
  propertySet(key,value){key=key.slice(5);if(key==='viewAngle')this.state.view.rotation=value*Math.PI/180;else if(key==='selectionScale'||key==='selectionAngle'){if(this.selection){this.selection[key==='selectionScale'?'scale':'angle']=key==='selectionScale'?value/100:value;this.previewSelection();}}else{this.settings[key]=value/(PERCENT_SETTINGS.includes(key)?100:1);if(['size','opacity','flow','hardness','roundness','angle','scatter','spacingRatio','texture'].includes(key))this.settings.preset=null;}this.onRender();this.paintPreview(this.panel);}
  async prepareVisible(){const owner=this.owner;if(!owner||!this.active||this.gesture)return;let target;try{target=this.editor.drawingTarget();}catch{return;}if(!target.figure)return;const revision=this.editor.revision;try{const entry=await owner.surface(target.figure);if(owner===this.owner&&revision===this.editor.revision){owner.watch(entry);this.onRender();}}catch(error){if(error.name!=='AbortError')this.onError(error);}}
  get renderPreview(){
    const g=this.gesture??this.selection;if(!g?.target?.created&&!g?.target?.migratedFrom)return null;
    if(!g.preview){
      const source=this.editor.evaluatedFrame,report={...this.editor.report,figure_types:[...this.editor.report.figure_types,g.target.figure],_styk:{...this.editor.report._styk,layers:{...this.editor.report._styk.layers,assignments:{...this.editor.report._styk.layers.assignments,[g.target.object.unique_id]:g.target.id}}}};
      let frame=createFrame([...source.objects.filter(o=>o.unique_id!==g.target.object.unique_id),g.target.object]);
      frame.camera=source.camera;
      for(const key of ['background_id','background_id_b','background_mix','background_color','_stykBackgroundColor'])if(key in source)frame[key]=source[key];
      frame=applyLayerOrder(report,frame);
      g.preview={report,frame,geometry:buildGeometry(report,frame)};
    }
    return g.preview;
  }
  /** The renderer keeps the presenter even after its store is evicted:
   * presenter() kicks the re-decode, and v2 callers skip the stale data URL. */
  resource(figure){if(!drawingMetadata(figure))return null;if(!this.owner)this.bind({required:true});const s=this.selection;return s&&drawingMetadata(s.target.figure)?.celId===drawingMetadata(figure).celId?s.presenter:this.owner?.presenter(figure)??null;}
  /** Viewport geometry cached between layout changes: reading it per pointer
   * sample and per overlay frame would force a synchronous layout each time. */
  viewRect(){
    if(!this._viewRect){
      if(!this._viewObserver&&typeof ResizeObserver!=='undefined'){const reset=()=>{this._viewRect=null;};this._viewObserver=new ResizeObserver(reset);this._viewObserver.observe(this.viewport);window.addEventListener('resize',reset,{signal:this.events.signal});window.addEventListener('scroll',reset,{capture:true,passive:true,signal:this.events.signal});}
      const r=this.viewport.getBoundingClientRect();this._viewRect={left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,clientWidth:this.viewport.clientWidth,clientHeight:this.viewport.clientHeight};
    }
    return this._viewRect;
  }
  point(event){const rect=this.viewRect();return screenToWorld({x:(event.clientX-rect.left)*rect.clientWidth/rect.width,y:(event.clientY-rect.top)*rect.clientHeight/rect.height},{report:this.editor.report,frame:this.editor.evaluatedFrame,view:this.state.view,cameraEnabled:false});}
  geometryItem(target){let item;if(target.created||target.migratedFrom)item=buildGeometry({...this.editor.report,figure_types:[...this.editor.report.figure_types,target.figure]},createFrame([target.object])).drawables[0];else item=this.editor.geometry.drawables.find(i=>i.obj.unique_id===target.object.unique_id&&i.type==='image');if(!item)throw messageError(new Error(''), "errors.drawingController.theDrawingPoseIsUnavailable", {});return item;}
  pixelMatrix(target){return this.gesture?.session?.target===target?(this.gesture.session.matrix??this.gesture.session.pixelMatrix??drawingPixelMatrix(this.geometryItem(target))):drawingPixelMatrix(this.geometryItem(target));}
  pixel(event,target){return inversePoint(this.pixelMatrix(target),this.point(event));}
  /** Whether a finger draws now: the setting, and in Automatic until a pen has drawn in this session. */
  fingerDraws(){const mode=this.fingerDrawing?.()??'never';return mode==='always'||(mode==='auto'&&!this.penSeen);}
  async down(event){
    if(this.operation){if(!this.loading)this.loading={id:event.pointerId,sequence:++this.sequence,released:false,samples:[],event:{...pointerSample(event),pointerId:event.pointerId},queued:true};return;}
    if(this.gesture){
      // A pointer arriving while the previous stroke is closing queues behind its commit.
      if(this.gesture.kind==='stroke'&&this.gesture.session.ended&&!this.loading)this.loading={id:event.pointerId,sequence:++this.sequence,released:false,samples:[],event:{...pointerSample(event),pointerId:event.pointerId},queued:true};
      return;
    }
    if(this.loading)return;
    if(event.pointerType==='touch'){
      if(this.penPointerId!=null||performance.now()-(this.lastPen??-Infinity)<700)return;
      if(!this.fingerDraws()){this.overlay.setPointerCapture(event.pointerId);this.gesture={id:event.pointerId,kind:'pan',touch:true,start:pointerSample(event),view:{...this.state.view}};return;}
    }
    if(event.pointerType==='pen'){this.lastPen=performance.now();this.penSeen=true;}
    if(event.altKey&&this.sampleColor&&['brush','fill'].includes(this.tool)){this.overlay.setPointerCapture(event.pointerId);this.gesture={id:event.pointerId,kind:'pick'};this.pickColor(event);return;}
    if((event.ctrlKey||event.metaKey)&&['brush','eraser'].includes(this.tool)){this.overlay.setPointerCapture(event.pointerId);this.gesture={id:event.pointerId,kind:'resize',start:pointerSample(event),size:this.settings.size};return;}
    this._viewRect=null;this.beforeEdit();this.ensurePaintLayer();if(['brush','eraser','fill','shape'].includes(this.tool))this.editor.autoKeyDrawing();this.viewport.focus({preventScroll:true});if(!event.released)this.overlay.setPointerCapture(event.pointerId);
    const sequence=++this.sequence,revision=this.editor.revision,owner=this.owner;
    let target=this.editor.prepareDrawingCel({pixelsPerUnit:this.settings.resolution,world:this.point(event)}),surface;
    const pending=this.loading={id:event.pointerId,sequence,released:event.released??false,samples:event.samples??[],event:pointerSample(event)};
    this.onRender(); // Pause speculative work while the pointer waits for pixels.
    const current=()=>{
      const valid=this.loading===pending&&sequence===this.sequence&&revision===this.editor.revision&&owner===this.owner;
      if(!valid&&this.loading===pending){this.loading=null;this.onRender();if(this.overlay.hasPointerCapture(pending.id))this.overlay.releasePointerCapture(pending.id);}
      return valid;
    };
    try{
      surface=await (pending.done=owner.surface(target.figure,{priority:true}));
      if(!current()){owner.discard(target.figure);return;}
      owner.watch(surface);
      // v1 cels migrate lazily on the first pixel edit; posing keeps them v1.
      const d=drawingMetadata(target.figure);
      if(d?.version===1&&['brush','eraser','fill','lasso','shape'].includes(this.tool)){
        const figure=migrateDrawingFigure(target.figure,this.editor.report.figure_types.reduce((n,f)=>Math.max(n,f.figure_type_id+1),1),{bounds:surface.store.bounds});
        owner.retarget(d.celId,figure);
        target={...target,figure,object:{...structuredClone(target.object),figure_type_id:figure.figure_type_id},migratedFrom:d.celId};
      }
    }catch(error){owner.discard(target.figure);throw error;}
    this.loading=null;
    const point=this.pixel(pending.event,target);surface.pinned=true;
    if(this.tool==='fill'){surface.pinned=false;await this.settleFloating();await this.fill(target,surface,point);return;}
    if(this.tool==='transform'){if(target.created){surface.pinned=false;return;}this.editor.select(target.object.unique_id);this.editor.beginTranslationDrag('Move drawing');this.gesture={id:event.pointerId,target,surface,kind:'pose',start:this.point(event)};}
    else if(this.tool==='lasso'){
      // Shift adds to the selection and Alt subtracts from it, as in Krita.
      const mode=event.shiftKey?'add':event.altKey?'subtract':'replace',shape=this.settings.selectShape;
      if((this.selection||this.marquee)&&!this.marqueeOn(target))this.cancelSelection();
      // Corner handles scale and the top handle rotates the floating selection.
      // A modifier at press chooses a selection mode instead; holding Shift
      // while rotating snaps to 15°.
      const handle=mode==='replace'?this.selectionHandleAt(point,target):null;
      if(handle){const s=await this.ensureFloating(),c={x:s.cx+s.dx,y:s.cy+s.dy};this.gesture={id:event.pointerId,target,surface,kind:'selection-'+handle,center:c,startDistance:Math.max(1e-6,Math.hypot(point.x-c.x,point.y-c.y)),startAngle:Math.atan2(point.y-c.y,point.x-c.x),scale:s.scale,angle:s.angle};this.onRender();return;}
      if(this.selection&&(mode!=='replace'||!this.selectionContains(point)))await this.settleFloating();
      if(!this.selection&&mode==='replace'&&shape!=='wand'&&this.marqueeContains(point))await this.ensureFloating();
      if(this.selection){this.gesture={id:event.pointerId,target,surface,kind:'selection-move',start:point,dx:this.selection.dx,dy:this.selection.dy};}
      else if(shape==='wand'){surface.pinned=false;await this.wandSelect(target,surface,point,mode);return;}
      else this.gesture={id:event.pointerId,target,surface,kind:'lasso',shape,mode,start:point,points:[point]};
    }else if(this.tool==='shape'){
      // Drag out a line, rectangle or ellipse; it applies on release.
      await this.settleFloating();const w=this.point(pending.event);this.gesture={id:event.pointerId,target,surface,kind:this.tool,start:w,end:w};
    }else{
      await this.settleFloating();this.beginStroke(target,surface,{id:event.pointerId,erase:this.tool==='eraser'||event.button===5||Boolean(event.buttons&32)});
      // Shift continues from the previous stroke's end in a straight line.
      const last=this.lastStroke;if(event.shiftKey&&last&&last.layerId===target.id&&last.celId===drawingMetadata(target.figure).celId)this.sampleStroke({...pending.event,world:last.world});
      this.sampleStroke(pending.event);
    }
    for(const sample of pending.samples)this.move({...sample,pointerId:event.pointerId});if(pending.released)this.finish();this.onRender();
  }
  /** Remember the colour that just painted, most recent first. */
  rememberColor(){rememberRecentColor(this.settings.color);}
  saveLibrary(){try{globalThis.localStorage?.setItem(BRUSH_LIBRARY_KEY,JSON.stringify(this.library));}catch{/* Brush library storage is optional. */}}
  /** Open a stroke session on a loaded surface and make it the gesture. */
  beginStroke(target,surface,{id,erase=false}){
      if(!erase)this.rememberColor();
      // Painting keeps the selection outline as a clip mask; a moved or
      // resized floating selection is committed first.
      this.settleFloating();const color=this.settings.color.slice(1).match(/../g).map(n=>parseInt(n,16));
      const d=drawingMetadata(target.figure),s={id:++this.strokeId,target,surface,seq:0,sent:new Set(),before:new Map(),pending:[],posted:new Map(),outstanding:0,ended:false,cancelled:false,erase,revision:this.editor.revision,owner:this.owner};
      s.done=new Promise(resolve=>s.resolveDone=resolve);
      this.sessions.set(s.id,s);this.gesture={id,target,surface,kind:'stroke',session:s};
      // Painting owns the UI thread: publication and thumbnails wait it out.
      s.owner.busy=true;
      const b=this.settings,settings={...this.brushSettings(d.pixelsPerUnit),workingBytes:s.owner.hardBudget,pixelsPerUnit:1/Math.max(1e-9,Math.hypot(...this.pixelMatrix(target).slice(0,2))*(this.state.view.scale||1)),color,erase:s.erase,seed:s.id,mask:this.marqueeOn(target)?this.marquee.mask:null};
      // The path runs here so every dab's extent is known before dispatch:
      // the worker is seeded with exactly the tiles its dabs can reach.
      // Symmetry mirrors each input sample into its own path so mirrored
      // strokes keep even spacing; all dabs share one stroke and undo step.
      s.brush=normalizeBrush(settings);s.matrix=this.pixelMatrix(target);s.settings=settings;
      const report=this.editor.report,axisX=report.canvas_width/2,axisY=report.canvas_height/2,mirrors=s.mirrors=[p=>p];
      if(b.mirrorX)mirrors.push(p=>({x:2*axisX-p.x,y:p.y}));if(b.mirrorY)mirrors.push(p=>({x:p.x,y:2*axisY-p.y}));if(b.mirrorX&&b.mirrorY)mirrors.push(p=>({x:2*axisX-p.x,y:2*axisY-p.y}));
      s.queue=[];s.qi=0;this.owner.strokeWorker.post({kind:'begin',stroke:s.id,settings});
      this.strokePaths(s);
      // Wet ink previews worker brushes it can match closely; exact-only modes skip it.
      const br=s.brush;s.inflight=[];s.wetStyle=!s.erase&&br.blend==='normal'&&br.tip==='round'&&!br.alphaLock&&!settings.mask&&br.flow>=.5&&br.hardness>=.5&&br.roundness>=.9&&br.scatter<=.2?{color:this.settings.color,opacity:br.opacity*(br.texture>.3?.85:1)}:null;
      if(s.wetStyle){this.wet??=new WetInk(this.viewport,this.overlay);this.wetSession=s;}
      return s;
  }
  /** The current brush settings for a stroke, with lengths scaled from
   * document units to cel pixels. The tablet pressure curve is global. */
  brushSettings(scale){
    const b=this.settings,settings={pressureCurve:this.library.pressureCurve};
    for(const key of BRUSH_KEYS)settings[key]=b[key]??BRUSH_DEFAULTS[key];
    for(const key of BRUSH_LENGTHS)settings[key]*=scale;
    return settings;
  }
  /** One dab pipeline per mirror. Its final dab shapes queue for the worker's next batch;
   * a taper-out's provisional tail goes with it. */
  strokePaths(s){
    s.paths=s.mirrors.map((map,index)=>({map,stroke:createBrushStroke(s.brush,shape=>{shape.pi=index;s.pending.push(shape);},{seed:s.brush.seed+index*7919})}));
    s.tailCache=null;
  }
  /** Every path's provisional tail, one array per change. */
  strokeTail(s){
    const version=s.paths.reduce((n,{stroke})=>n+stroke.tailVersion,0);
    if(s.tailCache?.version!==version){const [only]=s.paths;s.tailCache={version,shapes:s.paths.length===1?only.stroke.tailShapes():s.paths.flatMap(({stroke})=>stroke.tailShapes())};}
    return s.tailCache.shapes;
  }
  /** Map one input sample through the stroke's pose and mirrors into its paths. */
  feedStroke(s,{world,lean,pressure,time}){
    for(const {map,stroke} of s.paths){
      const p=inversePoint(s.matrix,map(world));let ax=0,ay=0;
      if(lean){const q=inversePoint(s.matrix,map(lean)),n=Math.hypot(q.x-p.x,q.y-p.y);if(n>1e-9){ax=(q.x-p.x)/n;ay=(q.y-p.y)/n;}}
      stroke.sample({x:p.x,y:p.y,pressure,time,ax,ay});
    }
  }
  /** World-space outline of the dragged shape. Shift constrains lines to 45°
   * and rectangles/ellipses to squares/circles. */
  shapePoints(g){
    let {start:a,end:b}=g;const kind=this.settings.shapeKind??'rect';
    if(g.constrain){const dx=b.x-a.x,dy=b.y-a.y;if(kind==='line'){const angle=Math.round(Math.atan2(dy,dx)/(Math.PI/4))*Math.PI/4,r=Math.hypot(dx,dy);b={x:a.x+Math.cos(angle)*r,y:a.y+Math.sin(angle)*r};}else{const m=Math.max(Math.abs(dx),Math.abs(dy));b={x:a.x+Math.sign(dx||1)*m,y:a.y+Math.sign(dy||1)*m};}}
    if(kind==='line')return [a,b];
    const pts=kind==='ellipse'?ellipsePoints(a,b,128):rectPoints(a,b);return [...pts,pts[0]];
  }
  /** Apply a finished shape: fill its interior or stroke its outline with the brush. */
  pixelTool(target,surface,kind,payload,label,labelKey){
    return this.pixelOperation(label,async op=>{
      surface.pinned=true;
      try{
        op.reserve(surface,op.owner.hardBudget);const bounds=payload.bounds??payload.mask;
        const pointFilter=kind==='filter'&&payload.options.kind!=='blur',maskBytes=payload.mask?.mask?.byteLength??payload.options?.mask?.mask?.byteLength??0;
        const work=pointFilter?pointFilterWork(surface.store,bounds):null;
        if(work&&work.pixels>DRAWING_MAX_PIXELS)throw messageError(new Error(''), "errors.drawingController.selectASmallerAreaTheFilterExceeds16", {});
        // Point filters retain the transferred originals for history and
        // allocate at most one replacement for each occupied input tile.
        const bytes=work?work.bytes*2+maskBytes:bounds.width*bounds.height*(kind==='filter'?72:16)+maskBytes+surface.store.bytes*3;
        if(bytes>op.maxBytes)throw messageError(new Error(''), "errors.drawingController.theOperationExceedsTheDrawingWorkingMemoryLimit", {});
        const tiles=await this.copyWorkerTiles(surface,op,t=>tileIntersects(t,bounds));
        const result=await op.owner.worker.request(kind,{...payload,tiles},{signal:op.abort.signal,transfer:tiles.map(t=>t.pixels)});
        op.check();op.received(result.tiles);return await this.commitPixels(target,result.tiles,label,op);
      }finally{surface.pinned=false;op.owner.discard(target.figure);}
    },{labelKey});
  }
  async commitShape(g){
    const points=this.shapePoints(g);if(Math.hypot(g.end.x-g.start.x,g.end.y-g.start.y)<.5){g.surface.pinned=false;return;}
    if(this.settings.shapeFill&&this.settings.shapeKind!=='line'){
      const matrix=this.pixelMatrix(g.target),mask=lassoMask(points.map(p=>inversePoint(matrix,p)));
      const clip=this.marqueeOn(g.target)?combineMasks(this.marquee.mask,mask,'intersect'):mask;g.surface.pinned=false;
      if(!clip||clip.mask&&!clip.mask.some(Boolean))return;
      return this.pixelTool(g.target,g.surface,'fill-mask',{mask:clip,color:[...this.settings.color.slice(1).match(/../g).map(n=>parseInt(n,16)),Math.round(this.settings.opacity*255)]},'Fill shape','drawingController.fillShape');
    }
    // Dense collinear samples keep edges straight through the curve smoothing.
    this.beginStroke(g.target,g.surface,{id:g.id});let time=performance.now();
    for(let i=0;i<points.length;i++){const p=points[i],q=points[i+1];this.sampleStroke({world:p,timeStamp:time++,pointerType:'mouse'});if(!q)break;const n=Math.floor(Math.hypot(q.x-p.x,q.y-p.y)/1.5);for(let k=1;k<n;k++)this.sampleStroke({world:{x:p.x+(q.x-p.x)*k/n,y:p.y+(q.y-p.y)*k/n},timeStamp:time++,pointerType:'mouse'});}
    this.finish();
  }
  /** Feed one input sample to the stroke: it queues for the worker's next batch. */
  sampleStroke(event){
    const g=this.gesture,s=g?.session;
    if(g?.kind!=='stroke'||s.ended||s.cancelled)return;
    // The cel pose is fixed for the whole stroke: map through its cached matrix.
    const world=event.world??this.point(event),pen=event.pointerType==='pen',pressure=pen?event.pressure||.05:1;
    // Pen tilt is a screen-space lean; map it through the view and cel pose
    // so tilt-driven tips point the same way on a rotated canvas.
    const lean=pen&&(event.tiltX||event.tiltY)&&!event.world?this.point({clientX:event.clientX+Math.sin(event.tiltX*Math.PI/180)*16,clientY:event.clientY+Math.sin(event.tiltY*Math.PI/180)*16}):null;
    const sample={world,lean,pressure,time:event.timeStamp};
    if(s.queue.length>=MAX_STROKE_SAMPLES)throw messageError(new Error(''), "errors.drawingController.drawingInputExceededTheQueueLimit", {});
    s.lastWorld=world;s.lastPressure=pressure;
    // Samples become dabs only as batches leave, so a brush slower than the
    // pointer queues compact input samples instead of an unbounded dab list.
    s.queue.push(sample);
    // An idle worker takes the batch now, so pixels return before the next
    // frame; while it is busy, batches coalesce once per frame.
    if(s.outstanding===0&&!s.soon){s.soon=true;queueMicrotask(()=>{s.soon=false;if(!s.ended)this.flushStroke(s);});}
    else if(!s.raf)s.raf=requestAnimationFrame(()=>{s.raf=null;this.flushStroke(s);});
  }
  /** Post pending dabs. One batch is in flight at a time: while the worker
   * is busy, samples accumulate and leave with its reply, so a brush slower
   * than the pointer never builds a queue of stale work. */
  flushStroke(s){try{
    if(this.sessions.get(s.id)!==s)return;
    if(s.outstanding>0)return;
    // Turn queued samples into at most about one batch of dabs. A batch holds
    // 512 dabs, or more of a small tip, so fine brushes are not throttled by
    // round trips.
    const batch=s.batch??=Math.max(512,Math.min(8192,Math.floor(262144/(dabRadius(s.brush)*2.2+2)**2)));
    while(s.pending.length<batch&&s.qi<s.queue.length){this.feedStroke(s,s.queue[s.qi]);s.queue[s.qi++]=null;}
    if(s.qi>1024&&s.qi*2>s.queue.length){s.queue=s.queue.slice(s.qi);s.qi=0;}
    if(s.ended&&s.qi>=s.queue.length&&!s.drained){s.drained=true;for(const {stroke} of s.paths)stroke.finish();}
    // A taper-out repaints its provisional tail whenever it moves, once the
    // final dabs ahead of it have all left.
    const tail=s.brush.taperOut>0&&s.pending.length<=batch?this.strokeTail(s):null,sendTail=tail&&tail!==s.sentTail?tail:undefined;
    if(!s.pending.length&&!sendTail){this.endStrokeWorker(s);return;}
    const dabs=s.pending.splice(0,batch);
    const tiles=[],store=s.surface.store;
    for(const dab of sendTail?[...dabs,...sendTail]:dabs){
      const x0=dab.left,y0=dab.top,x1=dab.right,y1=dab.bottom;
      if(![x0,y0,x1,y1].every(Number.isFinite)||Math.max(Math.abs(x0),Math.abs(y0),Math.abs(x1),Math.abs(y1))>2147483647*TILE||(Math.ceil((x1-x0)/TILE)+1)*(Math.ceil((y1-y0)/TILE)+1)*TILE*TILE*4>(s.owner?.hardBudget??768*1024*1024))throw messageError(new Error(''), "errors.drawingController.theStrokeExceedsTheDrawingWorkingMemoryLimit", {});
      for(let ty=Math.floor(y0/TILE);ty*TILE<y1;ty++)for(let tx=Math.floor(x0/TILE);tx*TILE<x1;tx++){
        const key=tileKey(tx,ty);if(s.sent.has(key))continue;if((s.sent.size+1)*TILE*TILE*4>(s.owner?.hardBudget??768*1024*1024)/2)throw messageError(new Error(''), "errors.drawingController.theStrokeExceedsTheDrawingWorkingMemoryLimit", {});s.sent.add(key);
        const tile=store.get(tx,ty);tiles.push({tx,ty,pixels:tile?tile.pixels.slice().buffer:null});
      }
    }
    const seq=++s.seq;s.outstanding++;s.posted.set(seq,performance.now());
    this.strokeStats.batches++;this.strokeStats.dabs=(this.strokeStats.dabs??0)+dabs.length;this.strokeStats.maxQueueDepth=Math.max(this.strokeStats.maxQueueDepth,s.outstanding);
    s.owner.strokeWorker.post({kind:'dabs',stroke:s.id,seq,dabs,tiles,tail:sendTail},tiles.map(t=>t.pixels).filter(Boolean));
    if(sendTail)s.sentTail=sendTail;
    s.inflight?.push({seq,dabs:sendTail?[...dabs,...sendTail]:dabs,stamp:null,shownFrame:null,age:0});
    this.endStrokeWorker(s);
  }catch(error){this.cancel();this.onError(error);}}
  endStrokeWorker(s){if(s.ended&&s.drained&&!s.pending.length&&!s.outstanding&&!s.endPosted){s.endPosted=true;s.owner.strokeWorker.post({kind:'end',stroke:s.id});}}
  /** Draw the stroke's unpresented part as wet ink: the last presented dab of
   * each (mirrored) path, the dabs in flight or still pending, then the raw
   * pointer and its predicted position, which the curve smoothing trails. */
  drawWet(){
    const s=this.wetSession,wet=this.wet;if(!s||!wet)return;
    if(!s.wetStyle){wet.clear();return;}
    const view={report:this.editor.report,frame:this.editor.evaluatedFrame,view:this.state.view,cameraEnabled:false},w0=worldToScreen({x:0,y:0},view),wx=worldToScreen({x:1,y:0},view),wy=worldToScreen({x:0,y:1},view);
    const toScreen=p=>({x:w0.x+(wx.x-w0.x)*p.x+(wy.x-w0.x)*p.y,y:w0.y+(wx.y-w0.y)*p.x+(wy.y-w0.y)*p.y});
    const m=s.matrix,pixelToWorld=p=>transformPoint(m,p),a=toScreen(pixelToWorld({x:0,y:0})),b=toScreen(pixelToWorld({x:1,y:0})),unit=Math.hypot(b.x-a.x,b.y-a.y)||1;
    const paths=s.paths.map(()=>[]),add=(i,world,radius)=>{const q=toScreen(world);paths[i].push({x:q.x,y:q.y,r:radius*unit});};
    const pressure=s.paths[0].stroke.pressure,radiusAt=p=>dabRadius(s.brush,pressure?pressure(p??1):p??1);
    s.wetAnchor?.forEach((d,i)=>d&&add(i,pixelToWorld(d),d.radius));
    for(const batch of s.inflight)for(const d of batch.dabs)add(d.pi??0,pixelToWorld(d),d.radius);
    for(const d of s.pending)add(d.pi??0,pixelToWorld(d),d.radius);
    // Queued input not yet turned into dabs; a far-behind worker draws only the newest.
    for(let i=Math.max(s.qi,s.queue.length-2048);i<s.queue.length;i++){const q=s.queue[i];s.paths.forEach(({map},pi)=>add(pi,map(q.world),radiusAt(q.pressure)));}
    if(!s.ended&&s.brush.stabilization===0&&s.lastWorld){
      const radius=radiusAt(s.lastPressure);
      s.paths.forEach(({map},i)=>{add(i,map(s.lastWorld),radius);if(s.predicted)add(i,map(s.predicted),radius);});
    }
    const radius=paths.flat().reduce((n,p)=>Math.max(n,p.r),0);
    wet.draw(paths.filter(p=>p.length),{color:s.wetStyle.color,opacity:s.wetStyle.opacity,blur:s.brush.hardness<.9?(1-s.brush.hardness)*radius*.5:0});
  }
  /** Retire wet ink once the renderer has presented the matching pixels, one
   * frame late so the exact stroke is always on screen before the preview
   * leaves. Batches the renderer never shows (the cel is off screen) expire. */
  settleWet(){
    const s=this.wetSession;if(!s)return;
    this.wetFrame=(this.wetFrame??0)+1;
    const shown=s.surface.presentedStamp??-1;let changed=false;
    s.inflight=s.inflight.filter(batch=>{
      if(batch.stamp!=null)batch.age++;
      const presented=batch.stamp!=null&&shown>=batch.stamp;
      if(presented&&batch.shownFrame==null)batch.shownFrame=this.wetFrame;
      if(!(presented&&this.wetFrame>batch.shownFrame)&&batch.age<30)return true;
      for(const d of batch.dabs)(s.wetAnchor??=[])[d.pi??0]=d;changed=true;return false;
    });
    if(s.ended&&!s.inflight.length&&!s.pending.length){this.wet?.clear();this.wetSession=null;return;}
    if(changed)this.drawWet();
    // Keep frames coming until every wet segment has been replaced.
    if(s.inflight.length)this.onRender();
  }
  strokeMessage(data){
    const s=this.sessions.get(data.stroke);if(!s)return;
    if(data.kind==='error'){const message=data.message;this.cancel();this.onError(restoreMessageError(new Error(message), data));return;}
    if(data.kind==='tiles'){
      s.outstanding=Math.max(0,s.outstanding-1);const posted=s.posted.get(data.seq);s.posted.delete(data.seq);
      if(posted!=null)this.strokeStats.lastRoundTripMs=performance.now()-posted;
      if(s.cancelled)return;
      const store=s.surface.store;
      try{
        const snapshots=[...s.before.values()].reduce((n,p)=>n+(p?.byteLength??0),0)+data.tiles.reduce((n,t)=>n+(!s.before.has(tileKey(t.tx,t.ty))?(store.get(t.tx,t.ty)?.pixels.byteLength??0):0),0);
        s.owner.hold?.(s,snapshots+data.tiles.length*TILE*TILE*4,s.surface);
        s.owner.reserve?.(s.owner.replacementBytes(s.surface,data.tiles,'pixels'),s.surface);
        for(const t of data.tiles){const key=tileKey(t.tx,t.ty);if(!s.before.has(key))s.before.set(key,store.get(t.tx,t.ty)?.pixels??null);store.adopt(t.tx,t.ty,new Uint8ClampedArray(t.pixels));}
        s.owner.hold?.(s,snapshots,s.surface);
      }catch(error){this.cancel();this.onError(error);return;}
      if(data.tiles.length){this.owner.present(s.surface,data.dirty);this.onRender();}
      const batch=s.inflight?.find(b=>b.seq===data.seq);if(batch)batch.stamp=s.surface.stamp;
      if(s.ended)this.flushStroke(s);
      else if((s.pending.length||s.qi<s.queue.length)&&!s.raf)s.raf=requestAnimationFrame(()=>{s.raf=null;this.flushStroke(s);});
      return;
    }
    if(data.kind==='done'){this.sessions.delete(s.id);this.commitStroke(s,data.changes);}
  }
  restoreStroke(s){
    const store=s.surface.store;if(!store||s.owner.disposed)return;
    let dirty=null;for(const [key,before] of s.before){const [tx,ty]=parseTileKey(key);before?store.set(tx,ty,before):store.delete(tx,ty);dirty=unionRects(dirty,{x:tx*TILE,y:ty*TILE,width:TILE,height:TILE});}if(dirty)s.owner.present(s.surface,dirty);
  }
  commitStroke(s,changes){
    const g=this.gesture,valid=g?.session===s&&!s.cancelled&&s.owner===this.owner&&s.revision===this.editor.revision;
    // Worker replies already installed their pixels, so the stroke records history without
    // copying the raster again; a rejected commit restores the snapshots.
    if(g?.session===s)this.gesture=null;
    const finish=()=>{
      if(this.gesture?.session===s)this.gesture=null;
      s.resolveDone?.();s.owner.hold?.(s,0);
      s.owner.busy=this.operation?.owner===s.owner;
      s.surface.pinned=Boolean(this.selection?.surface===s.surface);
      if(this.selection?.surface===s.surface)this.previewSelection();else if(!s.owner.disposed&&!s.surface.disposed)s.owner.discard(s.target.figure);
      if(g?.session===s&&this.overlay.hasPointerCapture(g.id))this.overlay.releasePointerCapture(g.id);
      this.sync();this.onUI();this.onRender();
      this.resumeQueuedPointer();
    };
    const label=s.erase?'Erase stroke':'Brush stroke';
    try{
      if(valid){try{this.editor.commitDrawingPixels(s.target,changes,label,undefined,{resident:true});s.committed=true;}catch(error){this.restoreStroke(s);this.onError(error);}}
      else this.restoreStroke(s);
    }finally{finish();}
  }
  move(event){this.cursor=pointerSample(event);if(this.loading?.id===event.pointerId){if(this.loading.samples.length>=65536)throw messageError(new Error(''), "errors.drawingController.drawingInputExceededTheQueueLimit", {});this.loading.samples.push(pointerSample(event));return;}const g=this.gesture;if(!g||g.id!==event.pointerId){this.onOverlayRender();return;}
    if(g.kind==='pan'){const rect=this.viewRect();this.state.view.x=g.view.x+(event.clientX-g.start.clientX)*rect.clientWidth/rect.width;this.state.view.y=g.view.y+(event.clientY-g.start.clientY)*rect.clientHeight/rect.height;g.last=pointerSample(event);this.onView();}
    else if(g.kind==='stroke'){if(!g.session.ended)this.strokeSamples(event);}
    else if(g.kind==='pose'){const p=this.point(event);this.editor.moveSelection(p.x-g.start.x,p.y-g.start.y,{fromStart:true});}
    else if(g.kind==='lasso'){const p=this.pixel(event,g.target);if(g.shape==='rect')g.points=rectPoints(g.start,p);else if(g.shape==='ellipse')g.points=ellipsePoints(g.start,p);else if(g.points.length<8192&&Math.hypot(p.x-g.points.at(-1).x,p.y-g.points.at(-1).y)>1)g.points.push(p);}
    else if(g.kind==='resize'){this.setSetting('size',Math.max(.5,Math.min(2048,Math.round(g.size*2**((event.clientX-g.start.clientX)/120)*10)/10)));this.cursor=g.start;}
    else if(g.kind==='pick')this.pickColor(event);
    else if(g.kind==='shape'){g.end=this.point(event);g.constrain=event.shiftKey;}
    else if(g.kind==='selection-scale'||g.kind==='selection-rotate'){
      const p=this.pixel(event,g.target),s=this.selection,c=g.center;
      if(g.kind==='selection-scale')s.scale=Math.max(.01,Math.min(10,g.scale*Math.hypot(p.x-c.x,p.y-c.y)/g.startDistance));
      else{let angle=g.angle+(Math.atan2(p.y-c.y,p.x-c.x)-g.startAngle)*180/Math.PI;if(event.shiftKey)angle=Math.round(angle/15)*15;s.angle=((angle%360)+540)%360-180;}
      // Recomposite at most once per frame however fast the pointer moves.
      if(!this.previewQueued){this.previewQueued=true;requestAnimationFrame(()=>{this.previewQueued=false;if(this.selection)this.previewSelection();});}
    }
    else if(g.kind==='selection-move'){const p=this.pixel(event,g.target);this.selection.dx=g.dx+p.x-g.start.x;this.selection.dy=g.dy+p.y-g.start.y;this.previewSelection();}
    this.onRender();
  }
  /** Stroke samples from a pointer event, including coalesced ones. Raw and
   * regular move events report the same samples; timestamps drop repeats. */
  strokeSamples(event){const s=this.gesture.session,samples=event.getCoalescedEvents?.();for(const sample of samples?.length?samples:[event]){if(sample.timeStamp<=(s.lastTime??-Infinity))continue;s.lastTime=sample.timeStamp;this.sampleStroke(sample);}
    // Predicted input extends the wet ink toward where the pen is heading.
    if(s.wetStyle){const predicted=event.getPredictedEvents?.();s.predicted=predicted?.length?this.point(predicted.at(-1)):null;this.queueWet();}}
  /** Draw wet ink now, or at the next frame when it was drawn under 8 ms ago:
   * pens report up to several hundred samples a second, more than any display
   * shows, and each redraw costs the compositor. */
  queueWet(){
    const now=performance.now();
    if(now-(this.wetDrawn??-Infinity)>=8){cancelAnimationFrame(this.wetFrameRequest);this.wetFrameRequest=null;this.wetDrawn=now;this.drawWet();return;}
    this.wetFrameRequest??=requestAnimationFrame(()=>{this.wetFrameRequest=null;this.wetDrawn=performance.now();this.drawWet();});
  }
  rawMove(event){const g=this.gesture;if(g?.kind!=='stroke'||g.id!==event.pointerId||g.session.ended)return;this.strokeSamples(event);}
  /** Pointer release. An interrupted pointer (pointercancel, lost capture: a
   * notification stealing focus, the pen leaving range) keeps what was drawn,
   * as in Krita; only Escape discards a gesture. */
  up(event){if(this.loading?.id===event.pointerId){this.loading.released=true;return;}const g=this.gesture;if(!g||g.id!==event.pointerId)return;if(g.kind==='stroke'&&g.session.ended)return;this.finish();}
  finish({navigation=true}={}){if(navigation&&this.touchNavigation?.active)this.touchNavigation.cancel();const g=this.gesture;
    if(g?.kind==='stroke'&&g.session.ended)return; // the done reply completes the commit
    if(this.loading)this.cancel();if(!g)return;
    if(g.kind==='shape'){this.gesture=null;if(this.overlay.hasPointerCapture(g.id))this.overlay.releasePointerCapture(g.id);this.run(()=>this.commitShape(g));this.onRender();return;}
    if(['pan','pick','resize'].includes(g.kind)){this.gesture=null;if(this.overlay.hasPointerCapture(g.id))this.overlay.releasePointerCapture(g.id);if(g.kind!=='pan')this.onUI();else this.onRender();return;}
    if(g.kind==='stroke'){
      const s=g.session;s.ended=true;cancelAnimationFrame(s.raf);s.raf=null;
      if(s.lastWorld)this.lastStroke={layerId:s.target.id,celId:drawingMetadata(s.target.figure).celId,world:s.lastWorld};
      this.flushStroke(s);
      if(this.overlay.hasPointerCapture(g.id))this.overlay.releasePointerCapture(g.id);
      return; // the gesture stays closing until the worker's done arrives
    }
    this.gesture=null;try{
    if(g.kind==='pose')this.editor.commitDrag();
    else if(g.kind==='lasso')return this.run(()=>this.selectShape(g));
  }finally{g.surface.pinned=g.kind==='lasso'&&Boolean(this.operation)||Boolean(this.selection?.surface===g.surface);if(this.selection?.surface===g.surface)this.previewSelection();else{this.owner.present(g.surface);this.owner.discard(g.target.figure);}if(this.overlay.hasPointerCapture(g.id))this.overlay.releasePointerCapture(g.id);this.sync();this.onUI();this.onRender();}}
  cancel({navigation=true}={}){if(navigation)this.touchNavigation?.cancel();this.operation?.abort.abort();this.previewQueued=false;this.sequence++;const pending=this.loading;this.loading=null;if(pending&&this.overlay.hasPointerCapture(pending.id))this.overlay.releasePointerCapture(pending.id);const g=this.gesture;if(!g){this.fillAbort?.abort();this.onRender();return;}this.gesture=null;if(g.kind==='pan'){Object.assign(this.state.view,g.view);if(this.overlay.hasPointerCapture(g.id))this.overlay.releasePointerCapture(g.id);this.onView();this.onRender();return;}if(g.kind==='pick'){this.pickAbort?.abort();if(this.overlay.hasPointerCapture(g.id))this.overlay.releasePointerCapture(g.id);return;}if(g.kind==='shape'){g.surface.pinned=false;if(this.overlay.hasPointerCapture(g.id))this.overlay.releasePointerCapture(g.id);this.onRender();return;}if(g.kind==='resize'){this.settings.size=g.size;if(this.overlay.hasPointerCapture(g.id))this.overlay.releasePointerCapture(g.id);this.onUI();this.onRender();return;}if(g.kind==='stroke'){const s=g.session;s.cancelled=true;if(this.wetSession===s){this.wetSession=null;this.wet?.clear();}cancelAnimationFrame(s.raf);s.raf=null;this.sessions.delete(s.id);s.resolveDone?.();s.owner.hold?.(s,0);s.owner.busy=false;this.owner.strokeWorker.post({kind:'cancel',stroke:s.id});this.restoreStroke(s);}if(g.kind==='pose')this.editor.cancelDrag();if(g.kind==='selection-move')this.cancelSelection();if(g.kind==='selection-scale'||g.kind==='selection-rotate'){const s=this.selection;if(s){s.scale=g.scale;s.angle=g.angle;this.previewSelection();}}g.surface.pinned=false;this.owner.present(g.surface);this.owner.discard(g.target.figure);this.prepareVisible();if(this.overlay.hasPointerCapture(g.id))this.overlay.releasePointerCapture(g.id);this.onRender();}
  async barrier(options){await this.settle({selection:true});if(this.loading)throw messageError(new Error(''), "errors.drawingController.waitForTheDrawingToFinishLoading", {});await drawingBarrier(this.editor.report,options);}
  /** Fill bounds follow the document, independent of display zoom. */
  fillBounds(target,store){
    const matrix=this.pixelMatrix(target),toPixel=p=>inversePoint(matrix,p);
    const report=this.editor.report,stage=[[0,0],[report.canvas_width,0],[report.canvas_width,report.canvas_height],[0,report.canvas_height]].map(([x,y])=>toPixel({x,y}));
    const box=points=>({x:Math.floor(Math.min(...points.map(p=>p.x))),y:Math.floor(Math.min(...points.map(p=>p.y))),width:Math.ceil(Math.max(...points.map(p=>p.x)))-Math.floor(Math.min(...points.map(p=>p.x))),height:Math.ceil(Math.max(...points.map(p=>p.y)))-Math.floor(Math.min(...points.map(p=>p.y)))});
    return unionRects(box(stage),store.bounds);
  }
  fill(target,surface,point){return this.pixelOperation({messageKey:'drawingController.fillingDrawing'},async op=>{
    const controller=this.fillAbort=op.abort,owner=op.owner,settings={...this.settings},sampleAll=settings.sampleAll;
    try{
      const bounds=this.fillBounds(target,surface.store);
      if(!bounds)return;
      let source;
      if(sampleAll){
        if(bounds.width*bounds.height>FILL_SOURCE_MAX_PIXELS)throw messageError(new Error(''), "errors.drawingController.sampleAllLayersSupportsFillRegionsUpTo", {});
        const sourceBytes=bounds.width*bounds.height*4;
        if(sourceBytes*2>owner.hardBudget)throw messageError(new Error(''), "errors.drawingCompositeTransport.theFillExceedsTheDrawingWorkingMemoryLimit", {});
        // Publication needs its own transfer reservation. It must complete
        // before pinning the destination or reserving the remaining budget.
        await this.barrierForComposite(controller.signal);op.check();
        surface=await owner.surface(target.figure);op.check();surface.pinned=true;
        op.reserve(surface,owner.hardBudget);
        if(sourceBytes*2>op.maxBytes)throw messageError(new Error(''), "errors.drawingCompositeTransport.theFillExceedsTheDrawingWorkingMemoryLimit", {});
        source=await this.sampleArtwork(target,bounds,controller.signal);op.check();
        op.copiedBytes=source.byteLength;
      }else{surface.pinned=true;op.reserve(surface,owner.hardBudget);}
      const tiles=await this.copyWorkerTiles(surface,op,t=>tileIntersects(t,bounds));
      const result=await owner.worker.request('fill',{bounds,tiles,options:{maxBytes:op.maxBytes,...point,color:[...settings.color.slice(1).match(/../g).map(n=>parseInt(n,16)),Math.round(settings.opacity*255)],tolerance:settings.tolerance,expansion:settings.expansion,gap:settings.gap,clip:this.marqueeOn(target)?this.marquee.mask:null},source},{signal:controller.signal,transfer:[...tiles.map(t=>t.pixels),...(source?[source]:[])]});
      op.check();op.received(result.tiles);await this.commitPixels(target,result.tiles,'Fill drawing',op);this.onStatus(interfaceText('drawingController.filled'), 'drawingController.filled');
    }finally{surface.pinned=false;owner.discard(target.figure);if(this.fillAbort===controller)this.fillAbort=null;}
  });}
  async barrierForComposite(signal){await drawingBarrier(this.editor.report,{signal});}
  makeSelection(g){
    const bounds=g.mask??lassoBounds(g.points);if(!bounds)return;const outline=this.marquee;this.endSelection(true);
    const xs=g.points?.map(p=>p.x),ys=g.points?.map(p=>p.y),cx=xs?(Math.min(...xs)+Math.max(...xs))/2:bounds.x+bounds.width/2,cy=ys?(Math.min(...ys)+Math.max(...ys))/2:bounds.y+bounds.height/2;
    return this.pixelOperation({messageKey:'drawingController.selectingPixels'},async op=>{
      const owner=op.owner;g.surface.pinned=true;
      try{
        op.reserve(g.surface);const tiles=await this.copyWorkerTiles(g.surface,op,t=>tileIntersects(t,bounds));
        const result=await owner.worker.request('select',{tiles,points:g.points,mask:g.mask,maxBytes:op.maxBytes},{signal:op.abort.signal,transfer:tiles.map(t=>t.pixels)});
        op.check();op.received(result.tiles);
        const stores=selectionStores(g.surface.store,result.tiles),s={...stores,cx,cy,target:g.target,surface:g.surface,bounds,points:g.points,mask:g.mask,dx:0,dy:0,scale:1,angle:0,filter:this.settings.filter};
        s.presenter=selectionPresenter(s,owner);this.selection=s;if(outline)this.marquee=outline;else this.setMarquee(g.target,g.surface,g.mask??{...bounds,points:g.points});owner.hold(op,0);owner.surfaceVersion++;owner.onChange();this.previewSelection();this.onUI();this.onStatus(interfaceText('drawingController.selected'), 'drawingController.selected');
      }finally{g.surface.pinned=this.selection?.surface===g.surface;if(!g.surface.pinned)owner.discard(g.target.figure);}
    },{selection:true});
  }
  previewSelection(){const s=this.selection;if(!s||s.committing)return;s.presenter.stamp++;this.onRender();}
  commitSelection(s,label,{remove=false,operation,labelKey}={}){
    if(s.committing)return s.committing;
    const commit=async op=>{
      if(this.selection!==s)throw messageError(new DOMException('', 'AbortError'), "errors.drawingController.selectionChanged", {});
      const owner=op.owner,abort=s.abort=op.abort;op.reserve(s.surface);
      const matrix=selectionMatrix(s),selected=new Set(selectionTiles(s.surface.store,s.source,matrix,this.settings.filter,{remove,maxBytes:op.maxBytes}));
      const tiles=await this.copyWorkerTiles(s.surface,op,t=>selected.has(t));
      const source=await this.copyWorkerTiles({store:s.source},op);
      const result=await owner.worker.request('selection',{tiles,selection:{matrix,tiles:source,remove,filter:this.settings.filter,maxBytes:op.maxBytes}},{signal:abort.signal,transfer:[...source.map(t=>t.pixels),...tiles.map(t=>t.pixels)]});
      op.check();if(this.selection!==s)throw messageError(new DOMException('', 'AbortError'), "errors.drawingController.selectionChanged", {});op.received(result.tiles);
      // The selection buffers remain live until the cel replacement finishes;
      // keep them in the owner's budget while it reserves the committed tiles.
      const changed=await this.commitPixels(s.target,result.tiles,label,op);this.endSelection(false);this.marquee=null;return changed;
    };
    s.committing=(operation?commit(operation):this.pixelOperation(label,commit,{labelKey})).finally(()=>{if(this.selection===s)this.endSelection(false);this.onRender();});
    return s.committing;
  }
  selectionContains(point){const s=this.selection;if(!s)return false;const angle=-s.angle*Math.PI/180,x=point.x-s.cx-s.dx,y=point.y-s.cy-s.dy,px=Math.floor(s.cx+(Math.cos(angle)*x-Math.sin(angle)*y)/(s.scale*(s.fx??1))),py=Math.floor(s.cy+(Math.sin(angle)*x+Math.cos(angle)*y)/(s.scale*(s.fy??1)));return s.mask?Boolean(maskValue(s.mask,px,py)):lassoContains(s.points,px,py);}
  applySelection(){const s=this.selection;if(!s)return;if(s.committing)return s.committing;if(!moved(s)){this.cancelSelection();return;}return this.commitSelection(s,'Transform selected pixels',{labelKey:'drawingController.transformSelection'});}
  endSelection(cancel=true){const s=this.selection;if(!s)return;this.selection=null;if(cancel)s.abort?.abort();s.presenter?.dispose();s.surface.pinned=false;this.owner.surfaceVersion++;this.owner.present(s.surface);this.onRender();}
  cancelSelection(){this.endSelection(true);this.marquee=null;this.onUI();this.onRender();}
  async applyFilter(kind){
    if(!FILTER_LABELS[kind])throw messageError(new Error(''), "errors.drawingController.unknownDrawingFilter", {});await this.settleFloating();
    const e=this.editor,target=e.drawingTarget();if(!target.figure)throw messageError(new Error(''), "errors.drawingController.paintADrawingBeforeFilteringIt", {});
    const owner=this.owner,revision=e.revision,surface=await owner.surface(target.figure),clip=this.marqueeOn(target)?this.marquee.mask:null,st=this.settings;
    const base=clip?{x:clip.x,y:clip.y,width:clip.width,height:clip.height}:surface.store.bounds;if(!base)return;
    // Blur spreads paint: read and write a margin around the content.
    const pad=kind==='blur'?Math.ceil(st.filterRadius*2)+2:0,bounds={x:base.x-pad,y:base.y-pad,width:base.width+2*pad,height:base.height+2*pad};
    if(kind==='blur'&&bounds.width*bounds.height>DRAWING_MAX_PIXELS)throw messageError(new Error(''), "errors.drawingController.selectASmallerAreaTheFilterExceeds16", {});
    return this.pixelTool(target,surface,'filter',{bounds,options:{kind,mask:clip,radius:st.filterRadius,hue:st.hue,saturation:st.saturation,lightness:st.lightness,brightness:st.brightness,contrast:st.contrast}},FILTER_LABELS[kind],`drawingController.filter.${kind}`);
  }
  /** The selection outline is the canonical selection: a pixel mask on one
   * cel that clips painting and fills. Moving, scaling or rotating selected
   * pixels floats them into `this.selection`, derived from the outline. */
  setMarquee(target,surface,mask){
    this.marquee=mask?{celId:drawingMetadata(target.figure).celId,target,surface,mask,edges:mask.points?mask.points.flatMap((p,i)=>{const q=mask.points[(i+1)%mask.points.length];return[p.x,p.y,q.x,q.y];}):maskEdges(mask)}:null;
    this.onUI();this.onRender();return this.marquee;
  }
  marqueeOn(target){const m=this.marquee;if(!m||!target?.figure)return false;const id=drawingMetadata(target.figure).celId;return m.celId===id||m.celId===target.migratedFrom;}
  marqueeContains(point){return Boolean(this.marquee&&maskValue(this.marquee.mask,Math.floor(point.x),Math.floor(point.y)));}
  /** Combine a finished lasso, rectangle or ellipse gesture with the outline. */
  selectShape(g){
    if(g.points&&(g.mode??'replace')==='replace'){this.cancelSelection();return this.makeSelection(g);}
    let shape;
    if('maskOverride' in g)shape=g.maskOverride??null;
    else{const points=g.shape==='lasso'||!g.shape?g.points:g.points?.length>2?g.points:null,mask=points?lassoMask(points):null;shape=mask&&(mask.points||mask.mask.some(Boolean))?mask:null;}
    if(!shape&&g.mode==='replace'){this.cancelSelection();return;}
    const combined=combineMasks(this.marqueeOn(g.target)?this.marquee.mask:null,shape,g.mode??'replace');
    this.cancelSelection();if(!combined)return;
    this.setMarquee(g.target,g.surface,combined);return this.float();
  }
  /** Magic wand: select the contiguous region similar to the clicked pixel. */
  async wandSelect(target,surface,point,mode){
    const owner=this.owner,revision=this.editor.revision,bounds=this.fillBounds(target,surface.store);
    if(!bounds)return;if(bounds.width*bounds.height>DRAWING_MAX_PIXELS)throw messageError(new Error(''), "errors.drawingController.zoomInBeforeSelectingTheAreaExceeds16", {});
    const source=this.settings.sampleAll?await this.compositeSource(target,bounds):undefined;
    const tiles=[...TileStore.tilesInRect(bounds.x,bounds.y,bounds.width,bounds.height)].map(([tx,ty])=>surface.store.get(tx,ty)).filter(Boolean).map(t=>({tx:t.tx,ty:t.ty,pixels:t.pixels.slice().buffer}));
    const result=await owner.worker.request('flood-mask',{bounds,tiles,options:{...point,tolerance:this.settings.tolerance,gap:this.settings.gap},source},{transfer:[...tiles.map(t=>t.pixels),...(source?[source]:[])]});
    if(owner!==this.owner||revision!==this.editor.revision)return;
    return this.selectShape({target,surface,mode,shape:'mask',points:null,maskOverride:result.mask});
  }
  /** Float the outlined pixels so they can move, scale or rotate. */
  ensureFloating(){if(this.selection)return this.selection;if(!this.marquee)return null;return this.float().then(()=>this.selection);}
  float(){const m=this.marquee;return this.makeSelection({target:m.target,surface:m.surface,mask:m.mask,points:m.mask.points});}
  settleFloating(){const s=this.selection;if(!s)return;if(moved(s))return this.applySelection();this.endSelection(true);}
  async compositeSource(target,bounds){await this.barrierForComposite();return this.sampleArtwork(target,bounds);}
  /** The visible artwork of the frame, in the pixels of `target`'s cel: the engine draws it
   * (engine/engine-composite.mjs) from the published drawings. */
  sampleArtwork(target,bounds,signal){return this.artwork({bounds,matrix:inverseMatrix(this.pixelMatrix(target)),signal});}
  /** Pixel-space frame of the floating selection (or outline): corners, centre
   * and the rotate handle, placed a fixed screen distance above the top edge. */
  selectionFrame(target){
    const s=this.selection,m=s?.bounds??s?.mask??this.marquee?.mask;if(!m)return null;
    const cx=s?.cx??m.x+m.width/2,cy=s?.cy??m.y+m.height/2,dx=s?.dx??0,dy=s?.dy??0,sc=s?.scale??1,a=(s?.angle??0)*Math.PI/180,fx=s?.fx??1,fy=s?.fy??1,cos=Math.cos(a),sin=Math.sin(a);
    const t=p=>{const u=(p.x-cx)*sc*fx,v=(p.y-cy)*sc*fy;return{x:cx+dx+cos*u-sin*v,y:cy+dy+sin*u+cos*v};};
    const corners=[[m.x,m.y],[m.x+m.width,m.y],[m.x+m.width,m.y+m.height],[m.x,m.y+m.height]].map(([x,y])=>t({x,y}));
    const matrix=this.pixelMatrix(target),o=transformPoint(matrix,{x:0,y:0}),e=transformPoint(matrix,{x:1,y:0}),view={report:this.editor.report,frame:this.editor.evaluatedFrame,view:this.state.view,cameraEnabled:false};
    const so=worldToScreen(o,view),se=worldToScreen(e,view),unit=Math.hypot(se.x-so.x,se.y-so.y)||1;
    const top=t({x:m.x+m.width/2,y:m.y}),up={x:sin,y:-cos},gap=28/unit*(fy<0?-1:1);
    return {corners,center:{x:cx+dx,y:cy+dy},rotate:{x:top.x+up.x*gap,y:top.y+up.y*gap},top,unit};
  }
  /** 'scale' or 'rotate' when a pixel-space point is on a selection handle. */
  selectionHandleAt(point,target){
    if(!this.selection&&!this.marquee)return null;let f;try{f=this.selectionFrame(target);}catch{return null;}if(!f)return null;
    const hit=q=>Math.hypot(point.x-q.x,point.y-q.y)*f.unit<=9;
    if(hit(f.rotate))return 'rotate';if(f.corners.some(hit))return 'scale';return null;
  }
  async action(action){if(action==='cancel-selection')return this.cancelSelection();const pending=this.settle();if(pending)await pending;const e=this.editor,ids=[e.activeLayerId];
    if(action==='new'){const layer=e.createDrawingLayer();this.state.selectedTrackId=layer.id;this.getTimeline()?.selectTrack?.(layer.id);this.sync();this.onUI();return;}
    if(!SELECTION_ACTIONS.includes(action))await this.applySelection();
    if(['select-all','invert-selection'].includes(action)){
      await this.settleFloating();const target=e.drawingTarget();if(!target.figure)throw messageError(new Error(''), "errors.drawingController.paintADrawingBeforeSelectingItsPixels", {});
      const surface=await this.owner.surface(target.figure),bounds=this.fillBounds(target,surface.store);if(!bounds)return;
      const mask=action==='select-all'?rectMask(bounds):invertMask(this.marqueeOn(target)?this.marquee.mask:null,bounds);
      this.cancelSelection();if(mask)this.setMarquee(target,surface,mask);return;
    }
    if(action==='deselect')return this.cancelSelection();
    if(action==='fill-selection'){
      await this.settleFloating();const m=this.marquee;if(!m)throw messageError(new Error(''), "errors.drawingController.selectPixelsBeforeFillingTheSelection", {});
      const target=e.drawingTarget();if(!this.marqueeOn(target))throw messageError(new Error(''), "errors.drawingController.theSelectionBelongsToAnotherDrawing", {});
      const surface=await this.owner.surface(target.figure);return this.pixelTool(target,surface,'fill-mask',{mask:m.mask,color:[...this.settings.color.slice(1).match(/../g).map(n=>parseInt(n,16)),Math.round(this.settings.opacity*255)]},'Fill selection','drawingController.fillSelection');
    }
    if(action==='flip-selection-x'||action==='flip-selection-y'){const s=await this.ensureFloating();if(!s)throw messageError(new Error(''), "errors.drawingController.selectPixelsToFlip", {});const key=action==='flip-selection-x'?'fx':'fy';s[key]=-(s[key]??1);this.previewSelection();this.onUI();return;}
    if(action.startsWith('filter-'))return this.applyFilter(action.slice(7));
    if(action==='swap-colors'){[this.settings.color,this.settings.color2]=[this.settings.color2??'#ffffff',this.settings.color];this.onUI();this.paintPreview(this.panel);return;}
    if(action==='save-preset'){
      const base=interfaceText(brushMessages[this.settings.preset]?.nameKey??'drawingView.custom'),n=this.library.presets.length+1,tip=Object.fromEntries(brushKeys.filter(k=>k!=='preset').map(k=>[k,this.settings[k]]));
      const preset={id:'custom-'+(Date.now()).toString(36)+n,name:base+' '+n,description:interfaceText('drawingController.savedBrush'),...tip};this.library.presets=[...this.library.presets,preset].slice(-48);this.settings.preset=preset.id;this.saveLibrary();this.onUI();this.onStatus(interfaceText('drawingController.brushSaved', {name:preset.name}), 'drawingController.brushSaved', {name:preset.name});return;
    }
    if(action==='delete-preset'){const id=this.settings.preset;if(!this.library.presets.some(p=>p.id===id))return;this.library.presets=this.library.presets.filter(p=>p.id!==id);this.settings.preset=null;this.saveLibrary();this.onUI();return;}
    if(action==='mirror-x'||action==='mirror-y'){const key=action==='mirror-x'?'mirrorX':'mirrorY';this.settings[key]=!this.settings[key];this.onUI();this.onRender();return;}
    if(action==='flip-view'){this.state.view.flip=!this.state.view.flip;this.onUI();this.onRender();return;}
    if(action==='blank')return e.drawingKey(ids,e.tick,{blank:true});if(action==='copy-key'){if(!e.drawingKey(ids))this.onStatus(interfaceText('drawingController.alreadyDrawing'), 'drawingController.alreadyDrawing');return;}
    if(action==='extend')return e.extendDrawing(ids,this.settings.length);if(action==='next-blank'||action==='next-copy')return e.nextDrawing(ids,{blank:action==='next-blank',length:this.settings.length});
    if(action==='apply-selection')return this.applySelection();if(action==='cancel-selection')return this.cancelSelection();if(action==='retry')return this.barrier();
    if(action==='reset-rotation'){this.state.view.rotation=0;this.onRender();return;}
    if(action==='delete-pixels'){const s=await this.ensureFloating();if(!s)return;return this.commitSelection(s,'Delete selected pixels',{remove:true,labelKey:'drawingController.deleteSelection'});}
    if(action==='duplicate-layer'){await this.barrier();const source=e.getLayer(e.activeLayerId),end=e.report._styk.layerSheet.tracks[source.id].end;const old=e._sheetClipboard;try{e.sheetCopyFrames([source.id],0,end-1);return e.movieclipBatch('Duplicate drawing layer',()=>{const layer=e.createLayer(source.name+' copy',{drawing:true});e.sheetPasteFrames([layer.id],0);});}finally{e._sheetClipboard=old;}}
    if(['copy-pixels','cut-pixels'].includes(action)){await this.ensureFloating();return this.pixelOperation({messageKey:'drawingController.copyingPixels'},async op=>{
      const s=this.selection;if(!s)throw messageError(new Error(''), "errors.drawingController.selectPixelsWithTheLassoFirst", {});
      await this.getClipboard().copy('drawing-pixels',async()=>{
        op.reserve(s.surface,op.owner.hardBudget,op.owner.scratchBudget);
        const tiles=await this.copyWorkerTiles({store:s.source},op,()=>true,{encoded:true});
        const result=await op.owner.worker.request('copy-selection',{tiles,maxBytes:op.maxBytes},{signal:op.abort.signal,transfer:tiles.map(t=>t.png??t.pixels)});
        op.check();if(this.selection!==s)throw messageError(new DOMException('', 'AbortError'), "errors.drawingController.theSelectionChangedCopyItAgain", {});
        // Encoding is finished; retain only the packet/transfer working set
        // while the native clipboard acknowledges its bounded chunks.
        op.owner.hold(op,result.tiles.reduce((n,t)=>n+t.png.length*4+128,0)+128*1024,s.surface);
        const bounds=s.source.bounds,matrix=multiplyMatrix(this.pixelMatrix(s.target),selectionMatrix(s)),world=transformPoint(matrix,bounds??s.bounds);
        const clip={version:2,pixelsPerUnit:drawingMetadata(s.target.figure).pixelsPerUnit,bounds,tiles:result.tiles,world,matrix};validatePixelClipboard(clip);e._drawingPixelClipboard=clip;return true;
      },{signal:op.abort.signal,checkCurrent:op.check});
      op.check();if(action==='cut-pixels')await this.commitSelection(s,'Cut selected pixels',{remove:true,operation:op});
      return true;
    });}
    if(action==='paste-pixels')return this.pixelOperation({messageKey:'drawingController.pastingPixels'},op=>this.getClipboard().paste('drawing-pixels',async()=>{
      const clip=e._drawingPixelClipboard;if(!clip)throw messageError(new Error(''), "errors.drawingController.copySelectedPixelsFirst", {});validatePixelClipboard(clip);this.cancelSelection();if(clip.version===2&&!clip.tiles.length)return false;
      const owner=op.owner;
      let target=e.prepareDrawingCel({pixelsPerUnit:this.settings.resolution,world:clip.world}),surface;
      try{
        surface=await owner.surface(target.figure);op.check();surface.pinned=true;op.reserve(surface,owner.hardBudget,owner.scratchBudget);
        const d=drawingMetadata(target.figure);
        if(d.version===1){const figure=migrateDrawingFigure(target.figure,e.report.figure_types.reduce((n,f)=>Math.max(n,f.figure_type_id+1),1),{bounds:surface.store.bounds});owner.retarget(d.celId,figure);target={...target,figure,object:{...structuredClone(target.object),figure_type_id:figure.figure_type_id},migratedFrom:d.celId};}
        const sourceMatrix=clip.matrix??[1/clip.pixelsPerUnit,0,0,1/clip.pixelsPerUnit,clip.world?.x??0,clip.world?.y??0];
        const matrix=multiplyMatrix(inverseMatrix(this.pixelMatrix(target)),sourceMatrix).map(n=>Math.abs(n-Math.round(n))<1e-9?Math.round(n):n);
        const coverage=clip.version===2?indexedTileCoverage(clip.tiles,matrix,this.settings.filter,op.maxBytes):null;
        const bounds=coverage?null:transformSupportBounds({x:0,y:0,width:clip.width,height:clip.height},matrix,this.settings.filter);
        const tiles=await this.copyWorkerTiles(surface,op,t=>coverage?coverage.has(tileKey(t.tx,t.ty)):tileIntersects(t,bounds));
        const result=await owner.worker.request('paste',{tiles,clip,matrix,filter:this.settings.filter,maxBytes:op.maxBytes},{signal:op.abort.signal,transfer:tiles.map(t=>t.pixels)});
        op.check();op.received(result.tiles);return await this.commitPixels(target,result.tiles,'Paste selected pixels',op);
      }finally{if(surface){surface.pinned=false;owner.present(surface);}owner.discard(target.figure);}
    },{signal:op.abort.signal,checkCurrent:op.check}));
    if(action==='resample'){
      const target=e.drawingTarget();if(!target.figure)throw messageError(new Error(''), "errors.drawingController.paintADrawingBeforeResamplingIt", {});
      const resolution=this.settings.resolution,d=drawingMetadata(target.figure),ratio=resolution/d.pixelsPerUnit;
      if(ratio===1){this.onStatus(interfaceText('drawingController.sameResolution'), 'drawingController.sameResolution');return;}
      await this.barrier();
      return this.pixelOperation({messageKey:'drawingController.resamplingDrawing'},async op=>{
        const surface=await op.owner.surface(target.figure);op.check();surface.pinned=true;
        try{
          op.reserve(surface);const tiles=await this.copyWorkerTiles(surface,op);
          const result=await op.owner.worker.request('resample',{tiles,ratio,filter:this.settings.filter,maxBytes:op.maxBytes},{signal:op.abort.signal,transfer:tiles.map(t=>t.pixels)});
          op.check();op.owner.hold(op,0);e.resampleDrawing(target,{pixelsPerUnit:resolution,tiles:result.tiles,bounds:result.bounds,owned:true});
          this.onStatus(interfaceText('drawingController.resampled'), 'drawingController.resampled');
        }finally{surface.pinned=false;}
      });
    }
  }

  change(event){this.finish();const input=event.target,name=input.dataset.drawSetting;if(!name)return;this.settings[name]=input.type==='checkbox'?input.checked:input.type==='color'||name==='filter'||input.dataset.drawText!==undefined?input.value:Number(input.value);if(BRUSH_KEYS.includes(name)&&name!=='alphaLock')this.settings.preset=null;if(name==='filter'&&this.selection){this.selection.filter=this.settings.filter;this.previewSelection();}this.sync();this.onUI();}
  /** Alt-click/drag with the brush or fill picks the visible colour. */
  pickColor(event){
    if(!this.sampleColor||this.picking)return;this.pickAbort?.abort();const abort=this.pickAbort=new AbortController();this.picking=true;
    this.sampleColor(event.clientX,event.clientY,abort.signal).then(rgb=>{if(abort.signal.aborted||!Array.isArray(rgb))return;this.settings.color=hexColor(rgb);this.onUI();this.paintPreview(this.panel);},error=>{if(!abort.signal.aborted&&!/cancel|superseded/i.test(error.message))this.onStatus(errorText(error), error.messageKey, error.messageParams);}).finally(()=>{this.picking=false;});
  }
  /** The inspector's live brush sample, rasterized by the real stroke engine so
   * hardness, flow, opacity, texture and pressure render faithfully. Preview
   * pixels cap the brush at 30 px so the dab stays readable; pixelsPerUnit
   * keeps the stabilization pull honest at that capped scale. Any failure here
   * must never break the inspector. */
  paintPreview(root){
    const preview=root?.querySelector?.('[data-brush-preview]');if(!preview)return;
    try{
      const dpr=window.devicePixelRatio||1,w=Math.round(preview.clientWidth*dpr),h=Math.round(preview.clientHeight*dpr);
      if(w<8||h<8)return;
      if(preview.width!==w||preview.height!==h){preview.width=w;preview.height=h;}
      const s=this.settings,erase=this.tool==='eraser',color=s.color.slice(1).match(/../g).map(n=>parseInt(n,16));
      // The inspector re-renders after every stroke; rasterize the preview
      // stroke only when its inputs change and re-blit the cached result.
      const key=JSON.stringify([w,h,erase,s.color,this.library.pressureCurve,...brushKeys.map(k=>s[k])]),cached=this.previewCache;
      if(cached?.key===key){if(preview.dataset.previewKey!==key){const ctx=preview.getContext('2d');ctx.clearRect(0,0,w,h);if(cached.image)ctx.putImageData(cached.image,cached.x,cached.y);preview.dataset.previewKey=key;}return;}
      const px=Math.max(1,Math.min(30,s.size)),ppu=px/Math.max(.5,s.size);
      const pad=Math.ceil(px/2)+3,span=Math.max(1,w-2*pad),mid=h/2,amp=Math.max(0,Math.min(h*.22,mid-pad-2));
      const store=new TileStore();
      if(erase){
        // A solid mid-gray band lets the transparent erase cut show the
        // checkerboard behind the canvas.
        const band={x:pad,y:Math.floor(mid-amp-px*.6),width:span,height:Math.max(1,Math.ceil(2*(amp+px*.6)))};
        for(const [tx,ty] of TileStore.tilesInRect(band.x,band.y,band.width,band.height))store.set(tx,ty,new Uint8ClampedArray([136,136,136,255]));
      }
      const n=40,samples=[];
      for(let i=0;i<n;i++){const t=i/(n-1);samples.push({x:pad+span*t,y:mid+Math.sin(t*Math.PI*2)*amp,pressure:.15+.85*Math.sin(Math.PI*t),time:i});}
      if(!paintStroke(store,{...this.brushSettings(ppu),color,blend:s.blend==='smudge'?'normal':s.blend,alphaLock:false,erase,seed:1,pixelsPerUnit:ppu},samples))return;
      const bounds=store.bounds,ctx=preview.getContext('2d'),image=bounds?new ImageData(store.readRect(bounds.x,bounds.y,bounds.width,bounds.height),bounds.width,bounds.height):null;
      ctx.clearRect(0,0,w,h);if(image)ctx.putImageData(image,bounds.x,bounds.y);
      this.previewCache={key,image,x:bounds?.x,y:bounds?.y};preview.dataset.previewKey=key;
    }catch{}
  }
  overlayDraw(ctx){
    this.settleWet();
    if(!this.active)return;let target;try{target=this.gesture?.target??this.editor.drawingTarget();}catch{target=null;}
    const view={report:this.editor.report,frame:this.editor.evaluatedFrame,view:this.state.view,cameraEnabled:false};
    ctx.save();
    // Symmetry axes through the stage centre.
    if(this.settings.mirrorX||this.settings.mirrorY){
      const r=this.editor.report,line=(a,b)=>{const p=worldToScreen(a,view),q=worldToScreen(b,view);ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();};
      ctx.setLineDash([6,6]);ctx.lineWidth=1;ctx.strokeStyle='rgba(232,64,160,.85)';
      if(this.settings.mirrorX)line({x:r.canvas_width/2,y:-1e5},{x:r.canvas_width/2,y:1e5});
      if(this.settings.mirrorY)line({x:-1e5,y:r.canvas_height/2},{x:1e5,y:r.canvas_height/2});
    }
    const item=target?.figure?(this.renderPreview?.geometry.drawables.find(i=>i.obj.unique_id===target.object.unique_id)??this.editor.geometry.drawables.find(i=>i.obj.unique_id===target.object.unique_id&&i.type==='image')):null;
    const outline=this.marquee&&(this.marqueeOn(target)?this.marquee:null);
    const matrix=item?drawingPixelMatrix(item):outline?this.pixelMatrix(outline.target):null;
    if(matrix){
      const g=this.gesture,screen=p=>worldToScreen(transformPoint(matrix,p),view);
      // Pixel space → screen as one affine transform for the outline path.
      const o=screen({x:0,y:0}),ux=screen({x:1,y:0}),uy=screen({x:0,y:1}),unit=Math.hypot(ux.x-o.x,ux.y-o.y)||1;
      if(outline){
        const s=this.selection;ctx.save();ctx.transform(ux.x-o.x,ux.y-o.y,uy.x-o.x,uy.y-o.y,o.x,o.y);
        if(s){ctx.translate(s.cx+s.dx,s.cy+s.dy);ctx.rotate(s.angle*Math.PI/180);ctx.scale(s.scale*(s.fx??1),s.scale*(s.fy??1));ctx.translate(-s.cx,-s.cy);}
        const path=outline.path??=(()=>{const p=new Path2D(),e=outline.edges,m=outline.mask;if(!e){p.rect(m.x,m.y,m.width,m.height);return p;}for(let i=0;i<e.length;i+=4){p.moveTo(e[i],e[i+1]);p.lineTo(e[i+2],e[i+3]);}return p;})();
        const width=1/(unit*(s?.scale??1));ctx.lineWidth=width*1.5;ctx.setLineDash([]);ctx.strokeStyle='rgba(255,255,255,.9)';ctx.stroke(path);
        ctx.lineWidth=width;ctx.setLineDash([4*width,4*width]);ctx.strokeStyle='#2878ed';ctx.stroke(path);ctx.restore();
      }
      // Shape previews in world space.
      if(g?.kind==='shape'){
        const pts=this.shapePoints(g),d=drawingMetadata(target.figure);ctx.save();ctx.beginPath();
        pts.forEach((p,i)=>{const q=worldToScreen(p,view);i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);});
        if(g.kind==='shape'&&!this.settings.shapeFill){ctx.lineCap=ctx.lineJoin='round';ctx.strokeStyle=this.settings.color;ctx.globalAlpha=.6;ctx.lineWidth=Math.max(1,this.settings.size*d.pixelsPerUnit*unit);ctx.stroke();}
        else{ctx.fillStyle=this.settings.color;ctx.globalAlpha=.4;ctx.fill();}
        ctx.restore();
      }
      if(this.tool==='lasso'&&this.selection&&outline&&g?.kind!=='lasso'){
        const f=this.selectionFrame(outline.target),sc=p=>worldToScreen(transformPoint(matrix,p),view);ctx.save();ctx.setLineDash([]);
        const top=sc(f.top),rot=sc(f.rotate);ctx.strokeStyle='#2878ed';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(top.x,top.y);ctx.lineTo(rot.x,rot.y);ctx.stroke();
        for(const p of f.corners){const q=sc(p);ctx.fillStyle='#fff';ctx.fillRect(q.x-4.5,q.y-4.5,9,9);ctx.strokeRect(q.x-4.5,q.y-4.5,9,9);}
        ctx.beginPath();ctx.arc(rot.x,rot.y,5,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.stroke();ctx.restore();
      }
      const points=g?.kind==='lasso'?g.points:null;
      if(points?.length){ctx.setLineDash([4,4]);ctx.lineWidth=1;ctx.strokeStyle='#2878ed';ctx.beginPath();points.forEach((p,i)=>{const q=screen(p);i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);});ctx.closePath();ctx.stroke();}
      if(this.cursor&&target?.figure&&this.gesture?.kind!=='pan'&&this.gesture?.kind!=='pick'&&this.state.drag?.kind!=='pan'&&['brush','eraser'].includes(this.tool)){
        const d=drawingMetadata(target.figure),center=worldToScreen(this.point(this.cursor),view),radius=Math.max(1,this.settings.size*d.pixelsPerUnit/2*unit),round=this.settings.roundness??1,angle=(this.settings.angle??0)*Math.PI/180+Math.atan2(ux.y-o.y,ux.x-o.x);
        ctx.setLineDash([]);ctx.beginPath();ctx.ellipse(center.x,center.y,radius,Math.max(1,radius*round),angle,0,Math.PI*2);ctx.strokeStyle='#fff';ctx.lineWidth=3;ctx.stroke();ctx.strokeStyle='#333';ctx.lineWidth=1;ctx.stroke();
      }
    }
    ctx.restore();
  }
  destroy(){this.cancel();this.cancelSelection();this.events.abort();this.wet?.dispose();this.quickBar?.remove();this.hudElement?.remove();this.palette?.remove();this._viewObserver?.disconnect();this._quickFit?.disconnect();this.owner?.dispose();}
}
