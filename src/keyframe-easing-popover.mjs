import {keyEasing} from './keyframe-easing.mjs';
import {isDiscreteAnimationProperty} from './animation-properties.mjs';
import {createEasingControls} from './keyframe-easing-view.mjs';
import {storedFrameReport} from './pivot-frame-draft.mjs';

const STYLES = `
.styk-easing-popover{position:fixed;inset:auto;margin:0;padding:6px;width:232px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;border:1px solid #dce1e7;border-radius:8px;background:#fff;color:#333;box-shadow:0 4px 20px #0002;font:11px Inter,InterFallback,'Segoe UI',sans-serif}
.styk-easing-popover *{box-sizing:border-box}
.styk-easing-popover [hidden]{display:none!important}
.styk-easing-header{display:flex;align-items:center;justify-content:space-between;padding:1px 5px 5px;color:#77808c;font-size:10px}
.styk-easing-header button{border:0;background:none;color:#77808c;font-size:17px;padding:0 3px;cursor:pointer}
.styk-easing-options{display:grid;gap:1px}
.styk-easing-options button{display:flex;align-items:center;justify-content:space-between;width:100%;height:28px;border:0;border-radius:4px;padding:0 9px;background:#fff;color:#454b55;text-align:left;cursor:pointer;font:inherit}
.styk-easing-options button:hover,.styk-easing-options button:focus-visible{background:#f0f5fa;outline:none}
.styk-easing-options button[aria-checked=true]{background:#e8f4ff;color:#0877c5}
.styk-easing-options button[aria-checked=true]::after{content:'✓'}
.styk-easing-options button:disabled{opacity:.35;cursor:default}
.styk-easing-curve{display:block;width:100%;height:124px;margin-top:7px;border:1px solid #e5eaf0;border-radius:5px;background:#f8fafc;touch-action:none}
.styk-easing-curve circle{cursor:grab;stroke-width:2}
.styk-easing-curve text{font:9px sans-serif;fill:#8390a0}
.styk-easing-points{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;margin:7px 0}
.styk-easing-points label{font-size:9px;color:#7c8693}
.styk-easing-points input{width:100%;height:25px;margin-top:3px;border:1px solid #dce1e7;border-radius:4px;padding:0 4px;font:10px inherit;background:#fff;color:#454b55;appearance:textfield}
.styk-easing-points input:focus{outline:1px solid #0d99ff}
.styk-easing-apply{display:block;width:100%;height:27px;border:0;border-radius:4px;background:#0d99ff;color:#fff;font:inherit;cursor:pointer}
.styk-easing-apply:disabled{opacity:.4;cursor:default}
.styk-easing-error{color:#c43d3d;font-size:10px;line-height:1.4}
.styk-easing-error:empty{display:none}
`;

function keyAnchor(host, records, indices) {
  if (host.strip) {
    const card = host.cards.get(indices[0]), rect = card?.querySelector('.styk-simple-preview, .sheet-preview')?.getBoundingClientRect() ?? host.strip.getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top};
  }
  const rect = host.scroll.getBoundingClientRect();
  const tick = records.length ? records.reduce((tick, {key}) => Math.min(tick, key.tick), Infinity) : host.exposures[indices[0]]?.start ?? host.editor.tick;
  const row = host.tracks.findIndex(track => track.id === host.selectedTrackId);
  return {x: rect.left + 12 + (tick + .5) * host.pxPerTick - host._offsetX(),
    y: rect.top + 31 + Math.max(0, row) * 30 + 15 - host._offsetY()};
}

/** Nonmodal, light-dismiss editor shared by the filmstrip and channel timelines. */
export function showKeyframeEasingPopover() {
  const channelMode = this.channelMode, records = channelMode ? this._channelSelectionRecords() : [];
  const indices = channelMode ? [] : this.selectedFrameIndices;
  if (!(records.length || indices.length)) return;
  if (channelMode) this._assertKeysEditable(records);
  const selection = this.selectedAnimationKeys, report = this.editor.report;
  const frameReport = this.strip ? storedFrameReport(report) : report;
  const settings = this.easingSettings ? this.easingSettings(indices) : channelMode ? records.map(({key, channel}) => key.interpolation === undefined && channel.property === 'pose' && report.auto_easing ? null : keyEasing(key)) :
    indices.map(index => frameReport.keyframes[index]._styk?.easing ?? (report.auto_easing ? null : {interpolation: 'linear'}));
  const initial = settings.every(value => JSON.stringify(value) === JSON.stringify(settings[0])) ? settings[0] : null;
  const discrete = records.some(({channel}) => isDiscreteAnimationProperty(channel.property));
  this.easingPopover?.hidePopover();
  if (this.menu) this.menu.hidden = true;
  this.onSeek?.(this.editor.tick, this.editor.frameIndex);
  if (!document.querySelector('[data-styk-easing-style]')) {
    const style = document.createElement('style'); style.dataset.stykEasingStyle = ''; style.textContent = STYLES; document.head.append(style);
  }
  const anchor = keyAnchor(this, records, indices), popover = document.createElement('div');
  popover.className = 'styk-easing-popover'; popover.popover = 'auto';
  popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-label', 'Keyframe easing'); popover.setAttribute('aria-modal', 'false');
  popover.innerHTML = `<div class="styk-easing-header"><span>Easing</span><button type="button" aria-label="Close easing">×</button></div><form><div data-controls></div><p class="styk-easing-error" role="alert"></p><button class="styk-easing-apply" type="submit">Apply</button></form>`;
  document.body.append(popover); this.easingPopover = popover;
  const events = new AbortController(), options = {signal: events.signal};
  const apply = popover.querySelector('[type=submit]'), error = popover.querySelector('[role=alert]');
  const position = () => {
    const {width, height} = popover.getBoundingClientRect();
    popover.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, anchor.x - width / 2))}px`;
    popover.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, anchor.y - height - 10))}px`;
  };
  const close = (focus = true) => {
    if (popover.matches(':popover-open')) popover.hidePopover();
    events.abort(); popover.remove();
    if (this.easingPopover === popover) this.easingPopover = null;
    if (focus && !this._destroyed && !this.disposed) (this.scroll ?? this.strip).focus({preventScroll:true});
  };
  const save = () => {
    try {
      if (this.editor.report !== report) throw new Error('The animation document has changed. Reopen the keyframe.');
      const easing = controls.read();
      if (this.applyEasing) this.applyEasing(indices, easing);
      else if (channelMode) { this._assertKeysEditable(records); this.editor.setAnimationKeysEasing(selection, easing); }
      else if (this.strip && this.editor.frameDraft?.mode === 'add' && this.editor.frameDraft.dirty)
        this.editor.editStoredFrames(() => this.editor.setFramesEasing(indices, easing));
      else this.editor.setFramesEasing(indices, easing);
      close(); if (this.live) this.live.textContent = 'Keyframe easing updated';
    } catch (failure) { error.textContent = failure.message; position(); }
  };
  const controls = createEasingControls(popover.querySelector('[data-controls]'), {initial: discrete ? {interpolation:'constant'} : initial, discrete,
    onChange: (valid, mode) => { apply.disabled = !valid; apply.hidden = mode !== 'bezier'; error.textContent = ''; position(); },
    onSelect: mode => { if (mode !== 'bezier') save(); },
  });
  popover.querySelector('form').addEventListener('submit', event => {event.preventDefault(); save();}, options);
  popover.querySelector('[aria-label="Close easing"]').addEventListener('click', () => close(), options);
  popover.addEventListener('keydown', event => {event.stopPropagation(); if (event.key === 'Escape') {event.preventDefault(); close();}}, options);
  popover.addEventListener('toggle', event => {if (event.newState === 'closed') close(false);}, options);
  window.addEventListener('resize', () => close(false), options);
  (this.scroll ?? this.strip).addEventListener('scroll', () => close(false), options);
  this.editor.addEventListener('change', () => close(false), options);
  popover.showPopover(); position(); controls.focus();
}
