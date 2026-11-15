import {presentError} from './error-presentation.mjs';
import {replaceLocalized, localizedAttribute, localizedMarkup, messageHTML, appendLocalized, messageAttributes} from './localization-bindings.mjs';
import {t as interfaceText} from './localization.mjs';

import {clamp, hexColor, parseColor, normalizePaint, paintCSS, samplePaint, canvasPaint} from './paint.mjs';
import {createColorMagnifier} from './color-picker-magnifier.mjs';
import {placeFloating, presentsAsSheet} from './ui/anchor-position.mjs';
import {createPersonalPalette, currentPersonalPalette, deletePersonalPalette, moveShownColor, paletteFor, personalPalettes, projectPalette,
  rememberColor, removeShownColor, renamePersonalPalette, saveColor, selectPersonalPalette, setPaletteView, subscribePalette, suggestPaletteName} from './color-palette.mjs';

function hsv(rgb) {
  const [r,g,b] = rgb.map(v => v / 255), max = Math.max(r,g,b), min = Math.min(r,g,b), d = max-min;
  return [d ? ((max === r ? (g-b)/d + (g<b?6:0) : max===g ? (b-r)/d+2 : (r-g)/d+4)*60) : 0, max ? d/max : 0, max];
}
function rgb(h,s,v) {
  const f = n => {const k=(n+h/60)%6; return Math.round(255*v*(1-s*Math.max(0,Math.min(k,4-k,1))));};
  return [f(5),f(3),f(1)];
}
let active;
let canvasSampler;
const PALETTE_COLUMNS = 10;
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
/** `live` applies every drag step instead of only the release, and
 * `placement` 'below' opens under the anchor instead of beside it. Every
 * picker ends with the shared palette (color-palette.mjs): the project's
 * colours, the recent ones or a personal palette, one click from the colour
 * being edited. */
export function openColorPicker({anchor, paint, gradients = true, alpha = true, onChange, title, titleKey = title == null ? 'colorPicker.fill' : null, titleParams, live = false, placement = 'side'}) {
  active?.();
  let dragCleanup;
  const lifetime = new AbortController(), surface = canvasSampler?.surface();
  const magnifier=surface && createColorMagnifier({anchor,signal:lifetime.signal,sample:canvasSampler.sample});
  let sampling = false, samplePointer = null, eyedropper = false;
  let draft = normalizePaint(paint), selected = 0, savedGradient, hue = hsv(draft.stops[0].color)[0];
  // The palette remembers the colour a picker ends on when it changed.
  // paletteMenu is null, 'list', 'delete' or {form: 'new' | 'copy' | 'rename'}.
  let paletteKey = '', paletteCleanup = null, paletteMenu = null, changed = false;
  const initialHex = hexColor(draft.stops[0].color);
  const panel = document.createElement('div'); panel.className='paint-picker'; panel.setAttribute('role','dialog'); localizedAttribute(panel, 'aria-label', "colorPicker.colorPicker", {}); panel.setAttribute('popover','manual');
  const label = escapeHTML(titleKey ? interfaceText(titleKey, titleParams) : title);
  localizedMarkup(panel, `<header><strong ${titleKey ? messageAttributes(titleKey, titleParams) : ''}>${label}</strong><button type="button" data-eyedropper aria-pressed="false" title="Pick a color from the canvas" data-i18n-title="colorPicker.pickAColorFromTheCanvas"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 5 5 5M16 7l3-3a2.1 2.1 0 0 1 3 3l-3 3M15 8 4 19l-1 3 3-1L17 10"/></svg>${messageHTML("colorPicker.eyedropper", {})}</button><button type="button" data-close aria-label="Close color picker" data-i18n-aria-label="colorPicker.closeColorPicker">×</button></header>
    <div class="paint-tabs"${gradients ? '' : ' hidden'}><button type="button" data-mode="solid"><span class="paint-tab-swatch" data-kind="solid" aria-hidden="true"></span>${messageHTML("colorPicker.nbspSolid", {})}</button>${gradients ? `<button type="button" data-mode="gradient"><span class="paint-tab-swatch" data-kind="gradient" aria-hidden="true"></span>${messageHTML("colorPicker.nbspGradient", {})}</button>` : ''}</div>
    <section data-gradient><div class="paint-toolbar"><select aria-label="Gradient type" data-i18n-aria-label="colorPicker.gradientType"><option value="linear" data-i18n="colorPicker.linear">Linear</option><option value="radial" data-i18n="colorPicker.radial">Radial</option><option value="angular" data-i18n="colorPicker.angular">Angular</option><option value="diamond" data-i18n="colorPicker.diamond">Diamond</option></select><label><input data-angle type="number" step="1" aria-label="Gradient angle" data-i18n-aria-label="colorPicker.gradientAngle">°</label><button type="button" data-reverse title="Reverse gradient" aria-label="Reverse gradient" data-i18n-title="colorPicker.reverseGradient" data-i18n-aria-label="colorPicker.reverseGradient">⇄</button><button type="button" data-rotate title="Rotate 90°" aria-label="Rotate gradient" data-i18n-title="colorPicker.rotate90" data-i18n-aria-label="colorPicker.rotateGradient">↻</button></div><canvas class="paint-preview" width="520" height="140" aria-label="Gradient preview" data-i18n-aria-label="colorPicker.gradientPreview"></canvas><div class="paint-ramp" aria-label="Gradient stops" data-i18n-aria-label="colorPicker.gradientStops"></div><div class="paint-toolbar"><strong data-i18n="colorPicker.stops">Stops</strong><button type="button" data-add aria-label="Add gradient stop" data-i18n-aria-label="colorPicker.addGradientStop">+</button><button type="button" data-remove aria-label="Remove gradient stop" data-i18n-aria-label="colorPicker.removeGradientStop">−</button><label class="paint-position"><input data-position type="number" min="0" max="100" step="1" aria-label="Stop position" data-i18n-aria-label="colorPicker.stopPosition">%</label></div></section>
    <div class="paint-sv" tabindex="0" role="slider" aria-label="Saturation and brightness" aria-valuemin="0" aria-valuemax="100" data-i18n-aria-label="colorPicker.saturationAndBrightness"><i></i></div>
    <div class="paint-sliders"><input data-hue type="range" min="0" max="360" step="1" aria-label="Hue" data-i18n-aria-label="colorPicker.hue"><input data-alpha type="range" min="0" max="100" step="1" aria-label="Opacity" data-i18n-aria-label="colorPicker.opacity"></div>
    <div class="paint-values"><label>${messageHTML("colorPicker.hex", {})}<input data-hex type="text" spellcheck="false" maxlength="9" aria-label="Hex color" data-i18n-aria-label="colorPicker.hexColor"></label><label data-opacity-label>${messageHTML("colorPicker.alpha", {})}<input data-opacity type="number" min="0" max="100" step="1" aria-label="Alpha percent" data-i18n-aria-label="colorPicker.alphaPercent"></label></div><section class="paint-palette" aria-label="Palette" data-i18n-aria-label="colorPicker.palette"></section><p class="paint-error" role="status"></p>`);
  appendLocalized(anchor.closest('dialog') || document.body, panel); panel.showPopover();
  const $ = s => panel.querySelector(s), stop = () => draft.stops[selected];
  $('[data-eyedropper]').hidden=!surface;
  $('[data-eyedropper]').onclick=()=>{
    eyedropper=!eyedropper;
    $('[data-eyedropper]').setAttribute('aria-pressed',String(eyedropper));
    surface?.classList.toggle('paint-eyedropper',eyedropper);
    if(!eyedropper)magnifier?.hide();
  };
  const rect=anchor.getBoundingClientRect(), below=placement==='below';
  // An upright phone's touch interface shows the picker as a sheet from the bottom edge (anchor-position.mjs).
  const sheet=presentsAsSheet(panel);
  const place=()=>{if(sheet){placeFloating(panel,anchor);return;}panel.style.top=Math.max(8,Math.min(below?rect.bottom+8:rect.top,innerHeight-panel.offsetHeight-8))+'px';};
  if(!sheet)panel.style.left=Math.max(8,Math.min(below?rect.left-8:rect.left-292,innerWidth-300))+'px'; place();
  const close = () => {lifetime.abort();paletteCleanup?.();if(changed&&hexColor(stop().color)!==initialHex)rememberColor(hexColor(stop().color));surface?.classList.remove('paint-eyedropper');dragCleanup?.();panel.remove(); document.removeEventListener('pointerdown',outside,true); document.removeEventListener('keydown',key,true); if(anchor.isConnected)anchor.focus(); if(active===close)active=null;}; active=close;
  const onCanvas=e=>surface && (e.target===surface || surface.contains(e.target));
  const consume=e=>{e.preventDefault();e.stopImmediatePropagation();};
  const outside=e=>{
    if(eyedropper && onCanvas(e) && !dragCleanup){
      consume(e);
      if(e.button!==0 || sampling)return;
      magnifier?.hide();
      samplePointer=e.pointerId;
      sampling=true;
      const selectedStop=stop();
      Promise.resolve().then(()=>canvasSampler.sample(e.clientX,e.clientY,lifetime.signal)).then(color=>{
        if(lifetime.signal.aborted)return;
        selectedStop.color=color;
        hue=hsv(stop().color)[0];draw();commit();
      }).catch(error=>{if(!lifetime.signal.aborted)presentError($('.paint-error'), error);}).finally(()=>{sampling=false;});
      return;
    }
    if(!panel.contains(e.target)&&e.target!==anchor)close();
  };
  const key=e=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();if(paletteMenu)closeMenu();else close();}else if(panel.contains(e.target)){if(e.key==='Tab'){const items=[...panel.querySelectorAll('button,input,select,[tabindex]')].filter(n=>!n.disabled&&n.getClientRects().length);const i=items.indexOf(document.activeElement);if(e.shiftKey&&i===0){e.preventDefault();items.at(-1).focus();}else if(!e.shiftKey&&i===items.length-1){e.preventDefault();items[0].focus();}} }};
  panel.addEventListener('keydown',e=>e.stopPropagation());
  document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key,true);
  for(const type of ['pointermove','pointerup','click','dblclick','contextmenu','pointercancel']){
    document.addEventListener(type,e=>{
      if(type==='pointermove'){
        if(eyedropper && onCanvas(e) && !dragCleanup && !sampling)magnifier?.move(e);else magnifier?.hide();
      }
      if(dragCleanup)return;
      if((eyedropper && onCanvas(e)) || (samplePointer!==null && e.pointerId===samplePointer))consume(e);
      if(type==='click'||type==='pointercancel')samplePointer=null;
    },{capture:true,signal:lifetime.signal});
  }
  surface?.addEventListener('pointerleave',()=>magnifier?.hide(),{signal:lifetime.signal});
  window.addEventListener('blur',()=>magnifier?.hide(),{signal:lifetime.signal});
  const commit=()=>{try{onChange(normalizePaint(draft));changed=true;$('.paint-error').textContent='';}catch(e){presentError($('.paint-error'), e);}};
  function draw() {
    const s=stop(), [,,v]=hsv(s.color), saturation=hsv(s.color)[1], gradient=draft.type!=='solid';
    $('[data-gradient]').hidden=!gradient;
    for(const b of panel.querySelectorAll('[data-mode]'))b.setAttribute('aria-pressed',String((b.dataset.mode==='gradient')===gradient));
    $('select').value=gradient?draft.type:'linear'; $('[data-angle]').value=draft.angle;
    $('[data-hex]').value=hexColor(s.color).slice(1).toUpperCase(); $('[data-opacity]').value=Math.round(s.opacity*100);$('[data-alpha]').value=s.opacity*100;$('[data-hue]').value=hue;
    $('[data-alpha]').hidden=!alpha;$('[data-opacity-label]').hidden=!alpha;
    $('.paint-sv').style.backgroundColor=`hsl(${hue} 100% 50%)`;$('.paint-sv i').style.left=saturation*100+'%';$('.paint-sv i').style.top=(1-v)*100+'%';$('.paint-sv').setAttribute('aria-valuenow',Math.round(saturation*100));localizedAttribute($('.paint-sv'),'aria-valuetext','colorPicker.saturationBrightness',{saturation:Math.round(saturation*100),brightness:Math.round(v*100)});
    $('[data-alpha]').style.backgroundImage=`linear-gradient(to right,transparent,${hexColor(s.color)}),repeating-conic-gradient(#ccc 0% 25%,#fff 0% 50%)`; 
    if(gradient){const canvas=$('canvas'),ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle=canvasPaint(ctx,draft,{x:120,y:70},{x:400,y:70});ctx.fillRect(0,0,520,140);
      $('.paint-ramp').style.background=paintCSS({...normalizePaint(draft),type:'linear',angle:0});
      replaceLocalized($('.paint-ramp'), ...draft.stops.map((s,i)=>{const b=document.createElement('button');b.type='button';b.className='paint-stop';b.style.left=s.offset*100+'%';b.style.background=hexColor(s.color);localizedAttribute(b, 'aria-label', "colorPicker.stop", {value: i+1, value2: Math.round(s.offset*100)});b.setAttribute('aria-pressed',String(i===selected));b.onclick=()=>{selected=i;hue=hsv(stop().color)[0];draw();};b.onpointerdown=e=>{e.stopPropagation();selected=i;hue=hsv(stop().color)[0];drag(e,$('.paint-ramp'),fraction=>{stop().offset=fraction;draw();},true);};b.onkeydown=e=>{if(["ArrowLeft","ArrowRight"].includes(e.key)){e.preventDefault();selected=i;stop().offset=clamp(stop().offset+(e.key==='ArrowLeft'?-.01:.01));draw();commit();}if(e.key==='Delete'){selected=i;remove();}};return b;}));
      $('[data-position]').value=Math.round(s.offset*100);$('[data-remove]').disabled=draft.stops.length<=2;$('[data-add]').disabled=draft.stops.length>=32;
    }
    renderPalette();
    place();
  }
  // Live pickers apply each drag step, so the brush and swatches follow the pointer.
  const update=()=>{draw();if(live)commit();};
  function drag(e, surface, update, horizontal=false) {
    e.preventDefault();const r=surface.getBoundingClientRect();
    const move=event=>update(clamp((event.clientX-r.left)/r.width),clamp((event.clientY-r.top)/r.height));
    move(e);const cleanup=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);dragCleanup=null;};const up=()=>{cleanup();commit();};const cancel=()=>{cleanup();};dragCleanup=cleanup;
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',up,{once:true});window.addEventListener('pointercancel',cancel,{once:true});
  }
  $('[data-close]').onclick=close;
  for(const b of panel.querySelectorAll('[data-mode]'))b.onclick=()=>{if(b.dataset.mode==='solid'){if(draft.type!=='solid')savedGradient=structuredClone(draft);draft={type:'solid',angle:0,stops:[{...stop(),offset:0}]};}else if(draft.type==='solid')draft=savedGradient??{type:'linear',angle:0,stops:[{...stop(),offset:0},{offset:1,color:stop().color.reduce((a,b)=>a+b,0)>600?[32,32,32]:[255,255,255],opacity:stop().opacity}]};selected=0;draw();commit();};
  $('select').onchange=e=>{draft.type=e.target.value;draw();commit();};
  $('[data-angle]').onchange=e=>{const n=Number(e.target.value);if(Number.isFinite(n))draft.angle=((n%360)+360)%360;draw();commit();};
  $('[data-rotate]').onclick=()=>{draft.angle=(draft.angle+90)%360;draw();commit();};
  $('[data-reverse]').onclick=()=>{draft.stops=draft.stops.map(s=>({...s,offset:1-s.offset})).reverse();selected=draft.stops.length-1-selected;draw();commit();};
  const add=t=>{if(draft.stops.length>=32)return;const s=samplePaint(normalizePaint(draft),t);draft.stops.push({...structuredClone(s),offset:t});selected=draft.stops.length-1;hue=hsv(stop().color)[0];draw();commit();};
  $('[data-add]').onclick=()=>add(.5);$('.paint-ramp').onclick=e=>{if(e.target===$('.paint-ramp'))add(clamp((e.clientX-e.target.getBoundingClientRect().left)/e.target.clientWidth));};
  const remove=()=>{if(draft.stops.length<=2)return;draft.stops.splice(selected,1);selected=Math.min(selected,draft.stops.length-1);hue=hsv(stop().color)[0];draw();commit();};$('[data-remove]').onclick=remove;
  $('[data-position]').onchange=e=>{stop().offset=clamp(Number(e.target.value)/100);draw();commit();};
  $('.paint-sv').onpointerdown=e=>drag(e,$('.paint-sv'),(s,v)=>{stop().color=rgb(hue,s,1-v);update();});
  $('.paint-sv').onkeydown=e=>{const keys=["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"];if(!keys.includes(e.key))return;e.preventDefault();let [,s,v]=hsv(stop().color);s=clamp(s+(e.key==='ArrowRight'?.01:e.key==='ArrowLeft'?-.01:0));v=clamp(v+(e.key==='ArrowUp'?.01:e.key==='ArrowDown'?-.01:0));stop().color=rgb(hue,s,v);draw();commit();};
  $('[data-hue]').oninput=e=>{hue=Number(e.target.value);const [,s,v]=hsv(stop().color);stop().color=rgb(hue,s,v);update();};$('[data-hue]').onchange=commit;
  $('[data-alpha]').oninput=e=>{stop().opacity=Number(e.target.value)/100;update();};$('[data-alpha]').onchange=commit;
  $('[data-opacity]').onchange=e=>{stop().opacity=clamp(Number(e.target.value)/100);draw();commit();};
  $('[data-hex]').onchange=e=>{try{const value=parseColor(e.target.value);stop().color=value.color;if(alpha&&[4,8].includes(e.target.value.replace('#','').length))stop().opacity=value.opacity;hue=hsv(stop().color)[0];draw();commit();}catch(error){presentError($('.paint-error'), error);}};
  // The palette: Project | Recent | Mine ▾, + and one grid of swatches.
  // Mine ▾ opens the personal palettes in place of the grid: choose one, make
  // one, save the project's colours as one, or copy, rename or delete the one
  // shown. Project colours are the editor's (undoable, saved with the project).
  const paletteRoot=$('.paint-palette'),source=projectPalette(),esc=escapeHTML;
  const PLUS='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  const CARET='<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const paletteState=()=>paletteFor(source?source.colors():[]);
  const paletteAction=(action,focus)=>{
    try{action();$('.paint-error').textContent='';}catch(error){presentError($('.paint-error'), error);}
    renderPalette(true);if(focus)paletteRoot.querySelector(focus)?.focus();
  };
  const menuMarkup=({view,project})=>{
    const mine=currentPersonalPalette(),palettes=personalPalettes();
    if(paletteMenu?.form){
      const form=paletteMenu.form,value=form==='rename'?mine?.name:suggestPaletteName(form==='copy'?interfaceText("colorPicker.projectColors"):interfaceText("colorPicker.myPalette"));
      const titleKey=form==='rename'?"colorPicker.renamePalette":form==='copy'?"colorPicker.saveProjectColorsAsAPalette":"colorPicker.newPalette",title=interfaceText(titleKey);
      return `<form class="paint-palette-form" data-palette-form><label><span ${messageAttributes(titleKey)}>${title}</span><input data-palette-name type="text" maxlength="60" spellcheck="false" value="${esc(value??'')}"></label><div class="paint-palette-form-actions"><button type="button" data-palette-cancel data-i18n="common.cancel">${messageHTML("colorPicker.cancel", {})}</button><button type="submit" class="is-primary" ${messageAttributes((form==='rename' ? "colorPicker.rename" : "colorPicker.create"), (form==='rename' ? {} : {}))}>${form==='rename'?interfaceText("colorPicker.rename"):interfaceText("colorPicker.create")}</button></div></form>`;
    }
    if(paletteMenu==='delete')return `<div class="paint-palette-form" role="group" aria-label="Delete palette" data-i18n-aria-label="colorPicker.deletePalette"><p ${messageAttributes("colorPicker.deleteAndItsColorsThisCanTBe", {name: mine.name, length: mine.colors.length})}>Delete “${esc(mine.name)}” and its ${mine.colors.length} colors? This can’t be undone.</p><div class="paint-palette-form-actions"><button type="button" data-palette-cancel data-i18n="common.cancel">${messageHTML("colorPicker.cancel", {})}</button><button type="button" class="is-danger" data-palette-delete-confirm data-i18n="common.delete">${messageHTML("colorPicker.delete", {})}</button></div></div>`;
    const item=(attrs,label,disabled=false, _messages = {})=>`<button type="button" role="menuitem" class="paint-palette-item" ${attrs}${disabled?' disabled':''}><span class="paint-palette-name" ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params) : ''}>${label}</span></button>`;
    const rows=palettes.map(p=>`<button type="button" role="menuitemradio" class="paint-palette-item" data-palette-pick="${esc(p.id)}" aria-checked="${view==='mine'&&p.id===mine?.id}"><span class="paint-palette-chips" aria-hidden="true">${p.colors.slice(0,5).map(c=>`<i style="--swatch:${c}"></i>`).join('')}</span><span class="paint-palette-name">${esc(p.name)}</span><small>${p.colors.length}</small></button>`).join('');
    const shown=view==='mine'&&mine;
    return `<div class="paint-palette-menu" role="menu" aria-label="Your palettes" data-i18n-aria-label="colorPicker.yourPalettes">${rows||`<p class="paint-palette-empty" data-i18n="colorPicker.keepThePalettesYouReuseLikeSkinTones">${messageHTML("colorPicker.keepThePalettesYouReuseLikeSkinTones", {})}</p>`}`
      +`<hr>${item('data-palette-new',interfaceText("colorPicker.newPalette2"), undefined, {label: {key: "colorPicker.newPalette2", params: {}}})}${source&&project.length?item('data-palette-copy',interfaceText("colorPicker.saveProjectColorsAsAPalette2"), undefined, {label: {key: "colorPicker.saveProjectColorsAsAPalette2", params: {}}}):''}`
      +(shown?`<hr>${source?item('data-palette-to-project',esc(interfaceText('colorPicker.addPaletteToProject',{name:mine.name})),!mine.colors.length,{label:{key:'colorPicker.addPaletteToProject',params:{name:mine.name}}}):''}${item('data-palette-rename',interfaceText("colorPicker.rename2"), undefined, {label: {key: "colorPicker.rename2", params: {}}})}${item('data-palette-delete',interfaceText("colorPicker.delete2"), undefined, {label: {key: "colorPicker.delete2", params: {}}})}`:'')+'</div>';
  };
  const gridMarkup=({view,name,colors})=>{
    const editable=view!=='recent',nameRef=view==='mine'?name:{messageKey:view==='project'?'colorPicker.project':'colorPicker.recent'},label=interfaceText('colorPicker.paletteColors',{name:nameRef});
    if(!colors.length){const key=view==='project'?'colorPicker.saveTheColorsThisProjectReusesWithThey':view==='mine'?'colorPicker.emptyPersonalPalette':'colorPicker.colorsYouPaintAndPickAppearHere',params=view==='mine'?{name}:{};return `<p class="paint-palette-empty" ${messageAttributes(key,params)}>${esc(interfaceText(key,params))}</p>`;}
    return `<div class="paint-palette-grid" role="group" aria-label="${esc(label)}" ${messageAttributes("colorPicker.paletteColors",{name:nameRef},"aria-label")}>${colors.map(color=>`<button type="button" class="ui-swatch" data-palette-swatch="${color}" style="--swatch:${color}"${editable?' draggable="true"':''} aria-label="Use ${color.toUpperCase()}" title="${color.toUpperCase()}${editable?interfaceText("colorPicker.dragToReorderRightClickToRemove"):''}" ${messageAttributes("colorPicker.use", {value: color.toUpperCase()}, "aria-label")} ${editable?messageAttributes("colorPicker.swatchHint",{color:color.toUpperCase()},"title"):""}></button>`).join('')}</div>`;
  };
  function renderPalette(force){
    const state=paletteState(),{view,name,target,saved,limit}=state,current=hexColor(stop().color);
    const key=JSON.stringify([view,name,state.colors,target,paletteMenu,personalPalettes().map(p=>[p.id,p.name,p.colors.length]),state.project.length]);
    if(force||key!==paletteKey){
      paletteKey=key;
      const tab=(value,label, _messages = {})=>`<button type="button" data-palette-view="${value}" aria-pressed="${value===view}" ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params) : ''}>${label}</button>`;
      const views=`<div class="paint-palette-views" role="group" aria-label="Palette" data-i18n-aria-label="colorPicker.palette">${source?tab('project',interfaceText("colorPicker.project"), {label: {key: "colorPicker.project", params: {}}}):''}${tab('recent',interfaceText("colorPicker.recent"), {label: {key: "colorPicker.recent", params: {}}})}<button type="button" class="paint-palette-mine" data-palette-menu aria-pressed="${view==='mine'}" aria-expanded="${Boolean(paletteMenu)}" aria-haspopup="menu" title="Your palettes, kept on this computer for every project" data-i18n-title="colorPicker.yourPalettesKeptOnThisComputerForEvery"><span ${view==='mine'?'':messageAttributes('colorPicker.mine')}>${view==='mine'?esc(name):interfaceText("colorPicker.mine")}</span>${CARET}</button></div>`;
      const add=target&&!paletteMenu?`<button type="button" class="paint-palette-add" data-palette-add>${PLUS}</button>`:'';
      localizedMarkup(paletteRoot, `<div class="paint-palette-head">${views}${add}</div>${paletteMenu?menuMarkup(state):gridMarkup(state)}`);
      const input=paletteRoot.querySelector('[data-palette-name]');if(input){input.focus();input.select();}
    }
    // One tab stop: the current colour's swatch, or the first.
    const swatches=[...paletteRoot.querySelectorAll('[data-palette-swatch]')],match=swatches.find(button=>button.dataset.paletteSwatch===current);
    for(const button of swatches){button.setAttribute('aria-pressed',String(button===match));button.tabIndex=button===(match??swatches[0])?0:-1;}
    const add=paletteRoot.querySelector('[data-palette-add]');
    if(add){
      const where=target==='mine'?name:{messageKey:'colorPicker.projectColors'},kept=saved.includes(current),full=saved.length>=limit;
      const key=kept?'colorPicker.colorAlreadyInPalette':full?'colorPicker.paletteFull':'drawingView.addTo',params=kept?{color:current.toUpperCase(),name:where}:full?{name:target==='mine'?name:{messageKey:'colorPicker.theProjectPalette'}}:{value:current.toUpperCase(),where};
      add.disabled=kept||full;localizedAttribute(add,'title',key,params);localizedAttribute(add,'aria-label',key,params);
    }
  }
  const closeMenu=()=>{paletteMenu=null;renderPalette(true);paletteRoot.querySelector('[data-palette-menu]')?.focus();};
  const removeSwatch=button=>{
    const next=button.nextElementSibling??button.previousElementSibling,color=button.dataset.paletteSwatch;
    paletteAction(()=>removeShownColor(color));
    paletteRoot.querySelector(`[data-palette-swatch="${next?.dataset.paletteSwatch}"]`)?.focus();
  };
  paletteRoot.addEventListener('click',e=>{
    const t=e.target,view=t.closest('[data-palette-view]'),swatch=t.closest('[data-palette-swatch]'),pick=t.closest('[data-palette-pick]'),mine=currentPersonalPalette();
    const menu=next=>paletteAction(()=>{paletteMenu=next;},next==='list'?'.paint-palette-item:not(:disabled)':null);
    if(view)paletteAction(()=>{setPaletteView(view.dataset.paletteView);paletteMenu=null;});
    else if(t.closest('[data-palette-menu]'))paletteMenu?closeMenu():menu('list');
    else if(pick)paletteAction(()=>{selectPersonalPalette(pick.dataset.palettePick);paletteMenu=null;},'[data-palette-menu]');
    else if(t.closest('[data-palette-new]'))menu({form:'new'});
    else if(t.closest('[data-palette-copy]'))menu({form:'copy'});
    else if(t.closest('[data-palette-rename]'))menu({form:'rename'});
    else if(t.closest('[data-palette-delete]'))menu('delete');
    else if(t.closest('[data-palette-cancel]'))menu('list');
    // Deletion synchronously refreshes subscribers; the confirmation needs the palette to exist.
    else if(t.closest('[data-palette-delete-confirm]'))paletteAction(()=>{paletteMenu=null;deletePersonalPalette(mine.id);},'[data-palette-menu]');
    else if(t.closest('[data-palette-to-project]'))paletteAction(()=>{source.addMany(mine.colors);setPaletteView('project');paletteMenu=null;},'[data-palette-view="project"]');
    else if(t.closest('[data-palette-add]'))paletteAction(()=>saveColor(hexColor(stop().color)));
    else if(swatch){stop().color=parseColor(swatch.dataset.paletteSwatch).color;hue=hsv(stop().color)[0];draw();commit();}
  });
  paletteRoot.addEventListener('submit',e=>{
    e.preventDefault();
    const name=paletteRoot.querySelector('[data-palette-name]').value,form=paletteMenu?.form;
    paletteAction(()=>{
      if(form==='rename')renamePersonalPalette(currentPersonalPalette().id,name);
      else createPersonalPalette(name,form==='copy'?source.colors():[]);
      paletteMenu=null;
    },'[data-palette-menu]');
  });
  paletteRoot.addEventListener('contextmenu',e=>{
    const swatch=e.target.closest('[draggable][data-palette-swatch]');if(!swatch)return;
    e.preventDefault();removeSwatch(swatch);
  });
  paletteRoot.addEventListener('keydown',e=>{
    const item=e.target.closest('.paint-palette-item');
    if(item&&["ArrowDown","ArrowUp"].includes(e.key)){
      e.preventDefault();const items=[...paletteRoot.querySelectorAll('.paint-palette-item:not(:disabled)')],i=items.indexOf(item);
      items[(i+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();return;
    }
    const swatch=e.target.closest('[data-palette-swatch]');if(!swatch)return;
    const swatches=[...paletteRoot.querySelectorAll('[data-palette-swatch]')],i=swatches.indexOf(swatch);
    const step={ArrowLeft:-1,ArrowRight:1,ArrowUp:-PALETTE_COLUMNS,ArrowDown:PALETTE_COLUMNS,Home:-i,End:swatches.length-1-i}[e.key];
    if(step!==undefined){e.preventDefault();const next=swatches[Math.max(0,Math.min(swatches.length-1,i+step))];for(const b of swatches)b.tabIndex=b===next?0:-1;next.focus();}
    else if((e.key==='Delete'||e.key==='Backspace')&&swatch.hasAttribute('draggable')){e.preventDefault();removeSwatch(swatch);}
  });
  // Dropping a project or personal colour on another moves it to that place.
  let dragging=null;
  paletteRoot.addEventListener('dragstart',e=>{const swatch=e.target.closest('[draggable][data-palette-swatch]');if(!swatch)return;dragging=swatch.dataset.paletteSwatch;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',dragging);});
  paletteRoot.addEventListener('dragover',e=>{if(dragging&&e.target.closest('[data-palette-swatch]')){e.preventDefault();e.dataTransfer.dropEffect='move';}});
  paletteRoot.addEventListener('drop',e=>{
    const target=e.target.closest('[data-palette-swatch]');if(!dragging||!target)return;e.preventDefault();
    const color=dragging,index=[...paletteRoot.querySelectorAll('[data-palette-swatch]')].indexOf(target);
    paletteAction(()=>moveShownColor(color,index));
  });
  paletteRoot.addEventListener('dragend',()=>{dragging=null;});
  // Recent colours, personal palettes, the view and the project's colours (undo, another document) can change while it is open.
  const stopRecent=subscribePalette(()=>renderPalette()),stopProject=source?.subscribe?.(()=>renderPalette());
  paletteCleanup=()=>{stopRecent();stopProject?.();};
  // A touch screen's keyboard waits until the hex field is tapped (docs/TOUCH.md); the picker itself takes focus.
  draw();if(document.documentElement.dataset.input==='touch'){panel.tabIndex=-1;panel.focus({preventScroll:true});}else $('[data-hex]').focus();return close;
}

/** Retain existing input/change bindings while replacing platform color dialogs. */
export function installColorPickers(resolve, sampler) {
  canvasSampler=sampler;
  document.addEventListener('click',e=>{
    const input=e.target.closest('input[type="color"], [data-paint-picker]');if(!input||input.disabled)return;
    e.preventDefault();e.stopImmediatePropagation();const custom=input.paintPicker?.(e) ?? resolve?.(input,e);if(custom===false)return;
    openColorPicker(custom??{anchor:input,paint:{type:'solid',stops:[{offset:0,...parseColor(input.value)}]},gradients:false,alpha:false,onChange:paint=>{input.value=hexColor(paint.stops[0].color);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}});
  },true);
}
