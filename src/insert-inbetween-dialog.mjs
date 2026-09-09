import {ThumbnailRenderer} from './thumbnail-renderer.mjs';
import {icon} from './icons.mjs';

const STYLE = `
.styk-inbetween-dialog{width:560px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 40px);margin:auto;padding:0;overflow:auto;border:1px solid #d8d8d8;border-radius:9px;background:#fff;box-shadow:0 18px 64px #0003;color:#2c2c2c;font:12px Inter,'Segoe UI',sans-serif}
.styk-inbetween-dialog::backdrop{background:#0005}.styk-inbetween-dialog *{box-sizing:border-box}.styk-inbetween-dialog button,.styk-inbetween-dialog input,.styk-inbetween-dialog select{font:inherit}.styk-inbetween-dialog button{cursor:pointer}.styk-inbetween-dialog button:disabled{opacity:.45;cursor:default}.styk-inbetween-dialog button:focus-visible,.styk-inbetween-dialog input:focus-visible,.styk-inbetween-dialog select:focus-visible{outline:2px solid #0d99ff;outline-offset:2px}
.styk-inbetween-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #e8e8e8}.styk-inbetween-head h2{margin:0;font-size:13px;font-weight:600}.styk-inbetween-close{width:25px;height:25px;display:grid;place-items:center;background:none;border:0;border-radius:4px;color:#777}.styk-inbetween-close:hover{background:#f0f0f0}.styk-inbetween-close .icon{width:15px;height:15px}
.styk-inbetween-body{padding:16px 20px 18px}.styk-inbetween-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;font-size:11px;color:#767676}.styk-inbetween-summary select{max-width:190px;border:1px solid #dedede;background:white;border-radius:4px;padding:5px 7px;color:#444;font-size:11px}
.styk-inbetween-preview{display:block;width:100%;padding:0;overflow:hidden;border:1px solid #e1e1e1;border-radius:5px;background:#f5f5f5;line-height:0}.styk-inbetween-preview canvas{display:block;width:100%;height:auto;aspect-ratio:16/9}.styk-inbetween-preview:focus-visible{outline-offset:3px}.styk-inbetween-tools{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 0 21px;font-size:10px;color:#909090}.styk-inbetween-onions{display:flex;align-items:center;gap:5px;padding:3px 0;background:none;border:0;color:#676767;font-size:10px!important}.styk-inbetween-onions .icon{width:14px;height:14px}.styk-inbetween-tools [role=status]{white-space:nowrap}
.styk-inbetween-ratio{display:flex;align-items:center;justify-content:space-between;margin-bottom:13px;font-size:11px}.styk-inbetween-number{display:flex;align-items:center;gap:4px;border:1px solid #e4e4e4;background:#f7f7f7;border-radius:4px;height:29px;padding-right:8px;color:#858585}.styk-inbetween-number:focus-within{border-color:#0d99ff;background:#fff}.styk-inbetween-number input{width:65px;min-width:0;border:0;background:transparent;padding:6px;text-align:right;outline:none;font-size:11px;color:#333;appearance:textfield}.styk-inbetween-slider{display:block;width:100%;height:5px;margin:0;accent-color:#0d99ff}.styk-inbetween-endpoints{display:flex;justify-content:space-between;align-items:center;margin-top:10px;color:#858585;font-size:10px}.styk-inbetween-endpoints button{background:none;border:0;padding:2px 0;color:#777;font-size:10px}.styk-inbetween-endpoints button:hover{color:#007be5}.styk-inbetween-timing{margin:18px 0 0;font-size:10px;color:#767676;line-height:1.5}.styk-inbetween-error{margin:13px 0 0;padding:9px 10px;border:1px solid #f4c7c1;border-radius:4px;background:#fff3f1;color:#b42318;font-size:11px;line-height:1.5}.styk-inbetween-dialog [hidden]{display:none!important}
.styk-inbetween-actions{display:flex;justify-content:flex-end;gap:8px;padding:13px 20px;border-top:1px solid #e8e8e8}.styk-inbetween-actions button{min-width:78px;height:31px;padding:0 13px;border:1px solid #d9d9d9;border-radius:5px;background:white;color:#333;font-size:11px;font-weight:500}.styk-inbetween-actions button:hover{background:#f5f5f5}.styk-inbetween-actions .primary{background:#0d99ff;border-color:#0d99ff;color:white}.styk-inbetween-actions .primary:hover{background:#0087e6}
.styk-inbetween-progress{display:block;width:100%;height:5px;margin:12px 0 0;accent-color:#0d99ff}.styk-inbetween-dialog[aria-busy=true] .styk-inbetween-ratio,.styk-inbetween-dialog[aria-busy=true] .styk-inbetween-endpoints{opacity:.55}
.styk-inbetween-number input:focus-visible{outline:none}.styk-inbetween-slider{appearance:none;border:0;border-radius:9px;background:linear-gradient(to right,#0d99ff var(--styk-ratio,50%),#dedede var(--styk-ratio,50%))}.styk-inbetween-slider::-webkit-slider-thumb{appearance:none;width:15px;height:15px;border:2px solid #fff;border-radius:50%;background:#0d99ff;box-shadow:0 0 0 1px #0d99ff}.styk-inbetween-slider::-moz-range-thumb{width:12px;height:12px;border:2px solid #fff;border-radius:50%;background:#0d99ff;box-shadow:0 0 0 1px #0d99ff}
`;
const modes = ['adjacent', 'settings', 'none'];
const progressLabels = {sampling: 'Preparing poses', 'sampling animation': 'Preparing animation poses', animation: 'Preparing animation tracks', validation: 'Checking frames', staging: 'Preparing frames'};
const modeLabels = {adjacent: 'Onion skins · Before + after', settings: 'Onion skins · Settings', none: 'Onion skins · Off'};

/** Read-only previews stay in the bounded thumbnail worker. Only Insert edits
 * the model, after revision/identity checks, as one atomic range command. */
export class InsertInbetweenDialog {
  constructor({editor, dialog, renderThumbnail, getSettings = () => ({}), baseURL, token = '', onApply = () => {}, onClose = () => {}, onError = () => {}}) {
    Object.assign(this, {editor, getSettings, baseURL, token, onApply, onClose, onError});
    this.externalRenderer = renderThumbnail;
    this.ownsDialog = !dialog;
    this.dialog = dialog ?? document.createElement('dialog');
    if (this.ownsDialog) document.body.append(this.dialog);
    this.ratio = .5; this.onionMode = 'adjacent'; this.sequence = 0;
    if (!document.querySelector('[data-styk-inbetween-style]')) {
      const style = document.createElement('style'); style.dataset.stykInbetweenStyle = ''; style.textContent = STYLE; document.head.append(style);
    }
  }
  open(indices = [this.editor.frameIndex]) {
    if (this.session) this.cancel();
    indices = this.editor._frameIndices(indices);
    if (!indices.length) throw new Error('Select a keyframe before inserting an inbetween.');
    if (this.editor.dragging || this.editor._animationEdit) throw new Error('Finish the current edit before inserting an inbetween.');
    this.session = {report: this.editor.report, revision: this.editor.revision, draftRevision: this.editor.frameDraftRevision, indices,
      frameIds: indices.map(index => this.editor.getFrameId(index))};
    this.previewIndex = indices.includes(this.editor.frameIndex) ? this.editor.frameIndex : indices[0];
    this.events = new AbortController(); const {signal} = this.events;
    this.renderer = this.externalRenderer ? null : new ThumbnailRenderer(this.editor, {baseURL: this.baseURL, token: this.token});
    this.renderThumbnail = this.externalRenderer ?? this.renderer.renderThumbnail;
    this.dialog.classList.add('styk-inbetween-dialog'); this.dialog.setAttribute('aria-label', 'Insert inbetween');
    this.dialog.innerHTML = `<div class="styk-inbetween-head"><h2>Insert inbetween</h2><button type="button" class="styk-inbetween-close" aria-label="Close insert inbetween">${icon('close')}</button></div>
      <div class="styk-inbetween-body"><div class="styk-inbetween-summary"><span data-summary></span><select aria-label="Preview selected keyframe"></select></div>
      <button type="button" class="styk-inbetween-preview" aria-label="Cycle onion skins"><canvas width="512" height="288" aria-label="Inbetween pose preview"></canvas></button>
      <div class="styk-inbetween-tools"><button type="button" class="styk-inbetween-onions">${icon('layers')}<span></span></button><span role="status" aria-live="polite"></span></div>
      <div class="styk-inbetween-ratio"><label for="styk-inbetween-ratio">Interpolation ratio</label><label class="styk-inbetween-number"><input type="number" min="0" max="100" step="0.1" aria-label="Interpolation percentage"><span>%</span></label></div>
      <input id="styk-inbetween-ratio" class="styk-inbetween-slider" type="range" min="0" max="1" step="0.001" aria-label="Interpolation ratio">
      <div class="styk-inbetween-endpoints"><button type="button" data-ratio="0">Previous pose</button><button type="button" data-ratio="0.5">50%</button><button type="button" data-ratio="1">Next pose</button></div>
      <p class="styk-inbetween-timing"></p><progress class="styk-inbetween-progress" aria-label="Preparing inbetween frames" hidden></progress><p class="styk-inbetween-error" role="alert" hidden></p></div>
      <div class="styk-inbetween-actions"><button type="button" data-inbetween-cancel>Cancel</button><button type="button" class="primary" data-inbetween-insert disabled>Insert${indices.length > 1 ? ` ${indices.length} frames` : ''}</button></div>`;
    this.$ = selector => this.dialog.querySelector(selector);
    this.canvas = this.$('canvas'); this.applyButton = this.$('[data-inbetween-insert]');
    this.applyLabel = this.applyButton.textContent; this.setApplying(false);
    this.$('[data-summary]').textContent = `${indices.length} selected keyframe${indices.length === 1 ? '' : 's'}`;
    for (const index of indices) { const option = document.createElement('option'); option.value = String(index); option.textContent = `Before keyframe ${index + 1}`; this.$('select').append(option); }
    this.$('select').value = String(this.previewIndex); this.$('select').hidden = indices.length < 2;
    this.$('select').addEventListener('change', () => { this.previewIndex = Number(this.$('select').value); this.queuePreview(); }, {signal});
    this.$('[type=range]').addEventListener('input', event => this.setRatio(Number(event.target.value)), {signal});
    this.$('[type=number]').addEventListener('input', event => this.setRatio(event.target.value === '' ? NaN : Number(event.target.value) / 100), {signal});
    for (const button of this.dialog.querySelectorAll('[data-ratio]')) button.addEventListener('click', () => this.setRatio(Number(button.dataset.ratio)), {signal});
    for (const selector of ['.styk-inbetween-preview', '.styk-inbetween-onions']) this.$(selector).addEventListener('click', () => {
      this.onionMode = modes[(modes.indexOf(this.onionMode) + 1) % modes.length]; this.queuePreview();
    }, {signal});
    for (const selector of ['[data-inbetween-cancel]', '.styk-inbetween-close']) this.$(selector).addEventListener('click', () => this.cancel(), {signal});
    this.applyButton.addEventListener('click', () => this.apply(), {signal});
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.cancel(); }, {signal});
    // A close event is queued by the browser. If the same modal was reopened
    // before delivery, the old event must not cancel the new preview session.
    this.dialog.addEventListener('close', () => { if (!this.dialog.open) this.finish(false); }, {signal});
    this.dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter' && !event.target.matches('button,select') && !this.applyButton.disabled) { event.preventDefault(); this.apply(); }
    }, {signal});
    this.editor.addEventListener('change', event => {
      if (this.applying && event.detail?.kind === 'document') this.applyJob?.controller.abort();
      if (!this.applying && ['document', 'edit', 'history', 'frame-draft'].includes(event.detail?.kind)) {
        this.previewAbort?.abort(); this.showError(new Error('The animation changed while this preview was open. Cancel and reopen Insert Inbetween to use the latest poses.'));
      }
    }, {signal});
    this.setRatio(this.ratio);
    if (!this.dialog.open) this.dialog.showModal();
    this.$('[type=range]').focus();
    return this;
  }
  assertCurrent() {
    const session = this.session;
    if (!session || this.editor.report !== session.report || this.editor.revision !== session.revision || this.editor.frameDraftRevision !== session.draftRevision ||
        session.frameIds.some((id, i) => this.editor.getFrameId(session.indices[i]) !== id))
      throw new Error('The selected source keyframes changed. Cancel and reopen this preview.');
  }
  setRatio(ratio) {
    if (this.applying) return;
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      this.sequence++; this.pendingPreview = null; this.previewAbort?.abort();
      if (this.previewRaf) cancelAnimationFrame(this.previewRaf); this.previewRaf = null;
      this.showError(new Error('Enter a percentage from 0 to 100.')); return;
    }
    this.ratio = Math.round(ratio * 1000) / 1000;
    this.$('[type=range]').value = String(this.ratio); this.$('[type=number]').value = String(Math.round(this.ratio * 1000) / 10);
    this.$('[type=range]').style.setProperty('--styk-ratio', `${this.ratio * 100}%`);
    this.queuePreview();
  }
  queuePreview() {
    if (!this.session || this.applying) return;
    try { this.assertCurrent(); } catch (error) { this.showError(error); return; }
    this.applyButton.disabled = true; this.$('[role=alert]').hidden = true;
    this.$('[role=status]').textContent = 'Rendering preview…';
    this.$('.styk-inbetween-onions span').textContent = modeLabels[this.onionMode];
    this.$('.styk-inbetween-onions').setAttribute('aria-label', modeLabels[this.onionMode]);
    const settings = this.getSettings() ?? {}, frames = this.editor.report.keyframes;
    const duration = frames[this.previewIndex === 0 || this.ratio > 0 ? this.previewIndex : this.previewIndex - 1].duration_raw;
    this.$('.styk-inbetween-timing').textContent = `Inserts before keyframe ${this.previewIndex + 1} · ${duration === 0 ? 'Hidden pose' : `${duration} frame${duration === 1 ? '' : 's'} of exposure`}. Existing keyframe exposures stay unchanged.`;
    this.pendingPreview = {generation: ++this.sequence, index: this.previewIndex, inbetween: {ratio: this.ratio, onionMode: this.onionMode,
      onionCount: Math.max(0, Math.min(9, Math.round(settings.onionCount ?? 3))), onionAhead: settings.onionAhead !== false,
      onionOpacity: Math.max(0, Math.min(1, settings.onionOpacity ?? .18))}};
    this.previewAbort?.abort();
    if (!this.previewRaf) this.previewRaf = requestAnimationFrame(() => { this.previewRaf = null; void this.drainPreview(); });
  }
  async drainPreview() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.session && this.pendingPreview) {
        const request = this.pendingPreview; this.pendingPreview = null;
        const controller = this.previewAbort = new AbortController();
        try {
          const rendered = await this.renderThumbnail(request.index, this.canvas, {signal: controller.signal, inbetween: request.inbetween});
          if (!this.session || controller.signal.aborted || request.generation !== this.sequence) continue;
          if (!rendered) throw new Error('The pose preview is unavailable. Adjust the ratio to try again.');
          this.assertCurrent(); this.applyButton.disabled = false; this.$('[role=status]').textContent = 'Click preview to cycle onions';
          this.previewReady = request.generation;
        } catch (error) { if (this.session && !controller.signal.aborted && request.generation === this.sequence) this.showError(error); }
        finally { if (this.previewAbort === controller) this.previewAbort = null; }
      }
    } finally { this.busy = false; }
  }
  showError(error) {
    if (!this.session) return;
    this.applyButton.disabled = true; this.$('[role=alert]').textContent = error.message; this.$('[role=alert]').hidden = false;
    this.$('[role=status]').textContent = ''; this.onError(error);
  }
  setApplying(active) {
    this.applying = active;
    this.dialog.setAttribute('aria-busy', String(active));
    for (const control of this.dialog.querySelectorAll('input,select,[data-ratio],.styk-inbetween-preview,.styk-inbetween-onions')) control.disabled = active;
    this.applyButton.textContent = active ? 'Preparing…' : this.applyLabel;
    this.$('progress').hidden = !active;
    if (active) {
      this.applyButton.disabled = true;
      this.$('[role=alert]').hidden = true;
      this.$('progress').removeAttribute('value');
      this.$('[role=status]').textContent = 'Preparing inbetween frames…';
    }
  }
  updateProgress(job, progress = {}) {
    if (this.applyJob !== job || this.session !== job.session || job.controller.signal.aborted) return;
    const label = progressLabels[progress.phase] ?? 'Preparing frames';
    const total = Number(progress.total), completed = Number(progress.completed);
    const bar = this.$('progress');
    if (Number.isFinite(total) && total > 0 && Number.isFinite(completed)) {
      bar.max = total; bar.value = Math.max(0, Math.min(total, completed));
      this.$('[role=status]').textContent = `${label} · ${Math.round(bar.value)} / ${Math.round(total)}`;
    } else {
      bar.removeAttribute('value'); this.$('[role=status]').textContent = `${label}…`;
    }
  }
  async apply() {
    if (!this.session || this.applying || this.applyButton.disabled || this.previewReady !== this.sequence) return false;
    const job = {session: this.session, controller: new AbortController()};
    let committed = false;
    try {
      this.assertCurrent(); this.applyJob = job; this.setApplying(true);
      const options = {signal: job.controller.signal, onProgress: progress => this.updateProgress(job, progress)};
      // Keep the established synchronous API compatible with isolated clients.
      // Editor's asynchronous method performs cancellable planning and publishes
      // one history command only after its own identity/revision checks.
      const result = await (this.editor.insertInbetweenFramesAsync
        ? this.editor.insertInbetweenFramesAsync(this.ratio, job.session.indices, options)
        : this.editor.insertInbetweenFrames(this.ratio, job.session.indices));
      if (this.applyJob !== job || this.session !== job.session || job.controller.signal.aborted) return false;
      // A refresh callback failure must not leave a committed insertion retryable.
      committed = true; this.finish(true, result);
      this.onApply(result); return result;
    } catch (error) {
      if (this.applyJob === job && this.session === job.session) {
        this.setApplying(false); this.showError(error);
      } else if (committed || !job.controller.signal.aborted) this.onError(error);
      return false;
    } finally {
      // A cancelled operation can settle after a new dialog session has opened.
      if (this.applyJob === job) {
        this.applyJob = null;
        if (this.session === job.session) this.setApplying(false);
      }
    }
  }
  cancel() { this.finish(false); }
  finish(applied, result) {
    if (!this.session) return;
    this.session = null; this.sequence++; this.pendingPreview = null; this.previewAbort?.abort();
    this.applyJob?.controller.abort(); this.applyJob = null; this.applying = false;
    this.dialog.setAttribute('aria-busy', 'false');
    this.events.abort(); if (this.previewRaf) cancelAnimationFrame(this.previewRaf); this.previewRaf = null;
    this.renderer?.destroy(); this.renderer = null;
    if (this.dialog.open) this.dialog.close(); this.dialog.classList.remove('styk-inbetween-dialog');
    this.onClose({applied, result});
  }
  destroy() { this.cancel(); if (this.ownsDialog) this.dialog.remove(); }
}
