import {clamp, hexColor, parseColor, normalizePaint, paintCSS, samplePaint, canvasPaint} from './paint.mjs';

function hsv(rgb) {
  const [r,g,b] = rgb.map(v => v / 255), max = Math.max(r,g,b), min = Math.min(r,g,b), d = max-min;
  return [d ? ((max === r ? (g-b)/d + (g<b?6:0) : max===g ? (b-r)/d+2 : (r-g)/d+4)*60) : 0, max ? d/max : 0, max];
}
function rgb(h,s,v) {
  const f = n => {const k=(n+h/60)%6; return Math.round(255*v*(1-s*Math.max(0,Math.min(k,4-k,1))));};
  return [f(5),f(3),f(1)];
}
let active;
export function openColorPicker({anchor, paint, gradients = true, alpha = true, onChange}) {
  active?.();
  let dragCleanup;
  let draft = normalizePaint(paint), selected = 0, savedGradient, hue = hsv(draft.stops[0].color)[0];
  const panel = document.createElement('div'); panel.className='paint-picker'; panel.setAttribute('role','dialog'); panel.setAttribute('aria-label','Color picker'); panel.setAttribute('popover','manual');
  panel.innerHTML = `<header><strong>Fill</strong><button type="button" data-close aria-label="Close color picker">×</button></header>
    <div class="paint-tabs"><button type="button" data-mode="solid">◼ &nbsp; Solid</button>${gradients ? '<button type="button" data-mode="gradient">◩ &nbsp; Gradient</button>' : ''}</div>
    <section data-gradient><div class="paint-toolbar"><select aria-label="Gradient type"><option value="linear">Linear</option><option value="radial">Radial</option><option value="angular">Angular</option><option value="diamond">Diamond</option></select><label><input data-angle type="number" step="1" aria-label="Gradient angle">°</label><button type="button" data-reverse title="Reverse gradient" aria-label="Reverse gradient">⇄</button><button type="button" data-rotate title="Rotate 90°" aria-label="Rotate gradient">↻</button></div><canvas class="paint-preview" width="520" height="140" aria-label="Gradient preview"></canvas><div class="paint-ramp" aria-label="Gradient stops"></div><div class="paint-toolbar"><strong>Stops</strong><button type="button" data-add aria-label="Add gradient stop">+</button><button type="button" data-remove aria-label="Remove gradient stop">−</button><label class="paint-position"><input data-position type="number" min="0" max="100" step="1" aria-label="Stop position">%</label></div></section>
    <div class="paint-sv" tabindex="0" role="slider" aria-label="Saturation and brightness" aria-valuemin="0" aria-valuemax="100"><i></i></div>
    <div class="paint-sliders"><input data-hue type="range" min="0" max="360" step="1" aria-label="Hue"><input data-alpha type="range" min="0" max="100" step="1" aria-label="Opacity"></div>
    <div class="paint-values"><label>HEX<input data-hex type="text" spellcheck="false" maxlength="9" aria-label="Hex color"></label><label data-opacity-label>Alpha %<input data-opacity type="number" min="0" max="100" step="1" aria-label="Alpha percent"></label></div><p class="paint-error" role="status"></p>`;
  (anchor.closest('dialog') || document.body).append(panel); panel.showPopover();
  const $ = s => panel.querySelector(s), stop = () => draft.stops[selected];
  const rect=anchor.getBoundingClientRect(); panel.style.left=Math.max(8,Math.min(rect.left-292,innerWidth-300))+'px'; panel.style.top=Math.max(8,Math.min(rect.top,innerHeight-panel.offsetHeight-8))+'px';
  const close = () => {dragCleanup?.();panel.remove(); document.removeEventListener('pointerdown',outside,true); document.removeEventListener('keydown',key,true); if(anchor.isConnected)anchor.focus(); if(active===close)active=null;}; active=close;
  const outside=e=>{if(!panel.contains(e.target)&&e.target!==anchor)close();};
  const key=e=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close();}else if(panel.contains(e.target)){if(e.key==='Tab'){const items=[...panel.querySelectorAll('button,input,select,[tabindex]')].filter(n=>!n.disabled&&n.getClientRects().length);const i=items.indexOf(document.activeElement);if(e.shiftKey&&i===0){e.preventDefault();items.at(-1).focus();}else if(!e.shiftKey&&i===items.length-1){e.preventDefault();items[0].focus();}} }};
  panel.addEventListener('keydown',e=>e.stopPropagation());
  document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key,true);
  const commit=()=>{try{onChange(normalizePaint(draft));$('.paint-error').textContent='';}catch(e){$('.paint-error').textContent=e.message;}};
  function draw() {
    const s=stop(), [,,v]=hsv(s.color), saturation=hsv(s.color)[1], gradient=draft.type!=='solid';
    $('[data-gradient]').hidden=!gradient;
    for(const b of panel.querySelectorAll('[data-mode]'))b.setAttribute('aria-pressed',String((b.dataset.mode==='gradient')===gradient));
    $('select').value=gradient?draft.type:'linear'; $('[data-angle]').value=draft.angle;
    $('[data-hex]').value=hexColor(s.color).slice(1).toUpperCase(); $('[data-opacity]').value=Math.round(s.opacity*100);$('[data-alpha]').value=s.opacity*100;$('[data-hue]').value=hue;
    $('[data-alpha]').hidden=!alpha;$('[data-opacity-label]').hidden=!alpha;
    $('.paint-sv').style.backgroundColor=`hsl(${hue} 100% 50%)`;$('.paint-sv i').style.left=saturation*100+'%';$('.paint-sv i').style.top=(1-v)*100+'%';$('.paint-sv').setAttribute('aria-valuenow',Math.round(saturation*100));$('.paint-sv').setAttribute('aria-valuetext',`${Math.round(saturation*100)}% saturation, ${Math.round(v*100)}% brightness`);
    $('[data-alpha]').style.backgroundImage=`linear-gradient(to right,transparent,${hexColor(s.color)}),repeating-conic-gradient(#ccc 0% 25%,#fff 0% 50%)`; 
    if(gradient){const canvas=$('canvas'),ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle=canvasPaint(ctx,draft,{x:120,y:70},{x:400,y:70});ctx.fillRect(0,0,520,140);
      $('.paint-ramp').style.background=paintCSS({...normalizePaint(draft),type:'linear',angle:0});
      $('.paint-ramp').replaceChildren(...draft.stops.map((s,i)=>{const b=document.createElement('button');b.type='button';b.className='paint-stop';b.style.left=s.offset*100+'%';b.style.background=hexColor(s.color);b.setAttribute('aria-label',`Stop ${i+1}, ${Math.round(s.offset*100)}%`);b.setAttribute('aria-pressed',String(i===selected));b.onclick=()=>{selected=i;hue=hsv(stop().color)[0];draw();};b.onpointerdown=e=>{e.stopPropagation();selected=i;hue=hsv(stop().color)[0];drag(e,$('.paint-ramp'),fraction=>{stop().offset=fraction;draw();},true);};b.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();selected=i;stop().offset=clamp(stop().offset+(e.key==='ArrowLeft'?-.01:.01));draw();commit();}if(e.key==='Delete'){selected=i;remove();}};return b;}));
      $('[data-position]').value=Math.round(s.offset*100);$('[data-remove]').disabled=draft.stops.length<=2;$('[data-add]').disabled=draft.stops.length>=32;
    }
    panel.style.top=Math.max(8,Math.min(rect.top,innerHeight-panel.offsetHeight-8))+'px';
  }
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
  $('.paint-sv').onpointerdown=e=>drag(e,$('.paint-sv'),(s,v)=>{stop().color=rgb(hue,s,1-v);draw();});
  $('.paint-sv').onkeydown=e=>{const keys=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'];if(!keys.includes(e.key))return;e.preventDefault();let [,s,v]=hsv(stop().color);s=clamp(s+(e.key==='ArrowRight'?.01:e.key==='ArrowLeft'?-.01:0));v=clamp(v+(e.key==='ArrowUp'?.01:e.key==='ArrowDown'?-.01:0));stop().color=rgb(hue,s,v);draw();commit();};
  $('[data-hue]').oninput=e=>{hue=Number(e.target.value);const [,s,v]=hsv(stop().color);stop().color=rgb(hue,s,v);draw();};$('[data-hue]').onchange=commit;
  $('[data-alpha]').oninput=e=>{stop().opacity=Number(e.target.value)/100;draw();};$('[data-alpha]').onchange=commit;
  $('[data-opacity]').onchange=e=>{stop().opacity=clamp(Number(e.target.value)/100);draw();commit();};
  $('[data-hex]').onchange=e=>{try{const value=parseColor(e.target.value);stop().color=value.color;if(alpha&&[4,8].includes(e.target.value.replace('#','').length))stop().opacity=value.opacity;hue=hsv(stop().color)[0];draw();commit();}catch(error){$('.paint-error').textContent=error.message;}};
  draw();$('[data-hex]').focus();return close;
}

/** Retain existing input/change bindings while replacing platform color dialogs. */
export function installColorPickers(resolve) {
  document.addEventListener('click',e=>{
    const input=e.target.closest('input[type="color"], [data-paint-picker]');if(!input||input.disabled)return;
    e.preventDefault();e.stopImmediatePropagation();const custom=input.paintPicker?.(e) ?? resolve?.(input,e);if(custom===false)return;
    openColorPicker(custom??{anchor:input,paint:{type:'solid',stops:[{offset:0,...parseColor(input.value)}]},gradients:false,alpha:false,onChange:paint=>{input.value=hexColor(paint.stops[0].color);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}});
  },true);
}
