export class OnionControls {
  constructor({button, toggleButton, getSettings, getEnabled, onChange, onToggle}) {
    Object.assign(this,{button,toggleButton,getSettings,getEnabled,onChange,onToggle});
    const panel=this.panel=document.createElement('div');panel.className='onion-popover';panel.id='onion-popover';panel.setAttribute('popover','auto');panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Onion skin settings');
    const number=(key,label,min,max)=>`<label>${label}<input type="number" data-onion="${key}" min="${min}" max="${max}" step="1"></label>`;
    panel.innerHTML=`<header><strong>Onion skin</strong><button type="button" data-onion-toggle></button></header><p>Compare nearby poses while you animate.</p><div class="onion-directions"><div>${number('onionBefore','Before',0,10)}<input type="color" data-onion="onionBeforeColor" aria-label="Previous pose color"></div><span class="onion-current" title="Current frame">◆</span><div>${number('onionAfter','After',0,10)}<input type="color" data-onion="onionAfterColor" aria-label="Following pose color"></div></div><label class="onion-opacity">Opacity <output></output><input type="range" data-onion="onionOpacity" min="0" max="100" step="1"></label><label class="onion-check"><input type="checkbox" data-onion="onionTint">Tint vector artwork</label><label class="onion-check"><input type="checkbox" data-onion="onionFade">Fade distant poses</label><label class="onion-check" title="Draw onion skins over the current pose"><input type="checkbox" data-onion="onionShowOnTop">Show on top</label><details><summary>Sampling and visibility</summary><label>Show<select data-onion="onionScope"><option value="all">All visible figures</option><option value="selected">Selected figures</option></select></label><label>Sample<select data-onion="onionMode"><option value="keyframes">Keyframes</option><option value="frames">Output frames</option></select></label>${number('onionStep','Spacing',1,20)}<label class="onion-check"><input type="checkbox" data-onion="onionJoined">Include joined figures</label><label class="onion-check"><input type="checkbox" data-onion="onionCamera">Previous camera outline</label></details><footer>O toggles onion skin · 0 hides a direction</footer>`;
    document.body.append(panel);button.setAttribute('aria-controls',panel.id);button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded','false');
    button.addEventListener('click',event=>{event.stopPropagation();this.sync();panel.togglePopover();});
    panel.addEventListener('toggle',event=>{button.setAttribute('aria-expanded',String(event.newState==='open'));if(event.newState==='open')this.position();});
    panel.addEventListener('keydown',event=>event.stopPropagation());
    panel.addEventListener('click',event=>{event.stopPropagation();if(event.target.closest('[data-onion-toggle]')){onToggle();this.sync();}});
    panel.addEventListener('input',event=>{
      const input=event.target.closest('[data-onion]');if(!input)return;
      let value=input.type==='checkbox'?input.checked:['number','range'].includes(input.type)?Number(input.value):input.value;
      if(input.type==='number'&&(!input.value||!input.validity.valid))return;
      if(input.dataset.onion==='onionOpacity')value/=100;
      this.pending={...this.pending,[input.dataset.onion]:value};
      if(!this.raf)this.raf=requestAnimationFrame(()=>{this.raf=0;const patch=this.pending;this.pending=null;onChange(patch);this.sync();});
    });
    window.addEventListener('resize',()=>{if(panel.matches(':popover-open'))this.position();});
    panel.querySelector('details').addEventListener('toggle',()=>{if(panel.matches(':popover-open'))this.position();});
    this.sync();
  }
  position(){const r=this.button.getBoundingClientRect();const panel=this.panel;panel.style.left=`${Math.max(8,Math.min(innerWidth-panel.offsetWidth-8,r.right-panel.offsetWidth))}px`;panel.style.top=`${Math.max(8,r.top-panel.offsetHeight-8)}px`;}
  sync(){const settings=this.getSettings(),enabled=this.getEnabled();this.toggleButton.setAttribute('aria-pressed',String(enabled));this.toggleButton.classList.toggle('active',enabled);
    for(const input of this.panel.querySelectorAll('[data-onion]')){if(document.activeElement===input)continue;const value=settings[input.dataset.onion];if(input.type==='checkbox')input.checked=value;else input.value=input.dataset.onion==='onionOpacity'?Math.round(value*100):value;}
    this.panel.querySelector('output').textContent=`${Math.round(settings.onionOpacity*100)}%`;
    const toggle=this.panel.querySelector('[data-onion-toggle]');toggle.textContent=enabled?'On':'Off';toggle.setAttribute('aria-pressed',String(enabled));toggle.setAttribute('aria-label','Enable onion skin');
  }
}
