import {presentError} from './error-presentation.mjs';
import {messageError} from './localized-error.mjs';
import {messageHTML, appendLocalized, clearTranslation, localizedAttribute, localizedMarkup, localizedText} from './localization-bindings.mjs';

import {icon} from './icons.mjs';

const STYLE = `
.styk-inbetween-dialog{width:560px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 40px);margin:auto;padding:0;overflow:auto;border:1px solid var(--theme-border, #d8d8d8);border-radius:9px;background:var(--theme-panel, #fff);box-shadow:0 18px 64px var(--theme-shadow, #0003);color:var(--theme-text, #2c2c2c);font:12px Inter,'Segoe UI',sans-serif}
.styk-inbetween-dialog::backdrop{background:var(--theme-backdrop, #0005)}.styk-inbetween-dialog *{box-sizing:border-box}.styk-inbetween-dialog button,.styk-inbetween-dialog input,.styk-inbetween-dialog select{font:inherit}.styk-inbetween-dialog button{cursor:pointer}.styk-inbetween-dialog button:disabled{opacity:.45;cursor:default}.styk-inbetween-dialog button:focus-visible,.styk-inbetween-dialog input:focus-visible,.styk-inbetween-dialog select:focus-visible{outline:2px solid var(--theme-accent, #0d99ff);outline-offset:2px}
.styk-inbetween-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--theme-border, #e8e8e8)}.styk-inbetween-head h2{margin:0;font-size:13px;font-weight:600}.styk-inbetween-close{width:25px;height:25px;display:grid;place-items:center;background:none;border:0;border-radius:4px;color:var(--theme-muted, #777)}.styk-inbetween-close:hover{background:var(--theme-hover, #f0f0f0)}.styk-inbetween-close .icon{width:15px;height:15px}
.styk-inbetween-body{padding:16px 20px 18px}.styk-inbetween-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;font-size:11px;color:var(--theme-muted, #767676)}.styk-inbetween-summary select{max-width:190px;border:1px solid var(--theme-border, #dedede);background:var(--theme-panel, white);border-radius:4px;padding:5px 7px;color:var(--theme-text, #444);font-size:11px}
.styk-inbetween-preview{display:block;width:100%;padding:0;overflow:hidden;border:1px solid var(--theme-border, #e1e1e1);border-radius:5px;background:var(--theme-field, #f5f5f5);line-height:0}.styk-inbetween-preview canvas{display:block;width:100%;height:auto;aspect-ratio:16/9}.styk-inbetween-preview:focus-visible{outline-offset:3px}.styk-inbetween-tools{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 0 21px;font-size:10px;color:var(--theme-muted, #909090)}.styk-inbetween-onions{display:flex;align-items:center;gap:5px;padding:3px 0;background:none;border:0;color:var(--theme-secondary, #676767);font-size:10px!important}.styk-inbetween-onions .icon{width:14px;height:14px}.styk-inbetween-tools [role=status]{white-space:nowrap}
.styk-inbetween-ratio{display:flex;align-items:center;justify-content:space-between;margin-bottom:13px;font-size:11px}.styk-inbetween-number{display:flex;align-items:center;gap:4px;border:1px solid var(--theme-border, #e4e4e4);background:var(--theme-subtle, #f7f7f7);border-radius:4px;height:29px;padding-right:8px;color:var(--theme-muted, #858585)}.styk-inbetween-number:focus-within{border-color:var(--theme-accent, #0d99ff);background:var(--theme-panel, #fff)}.styk-inbetween-number input{width:65px;min-width:0;border:0;background:transparent;padding:6px;text-align:right;outline:none;font-size:11px;color:var(--theme-text, #333);appearance:textfield}.styk-inbetween-slider{display:block;width:100%;height:5px;margin:0;accent-color:#0d99ff}.styk-inbetween-endpoints{display:flex;justify-content:space-between;align-items:center;margin-top:10px;color:var(--theme-muted, #858585);font-size:10px}.styk-inbetween-endpoints button{background:none;border:0;padding:2px 0;color:var(--theme-muted, #777);font-size:10px}.styk-inbetween-endpoints button:hover{color:var(--theme-accent, #007be5)}.styk-inbetween-timing{margin:18px 0 0;font-size:10px;color:var(--theme-muted, #767676);line-height:1.5}.styk-inbetween-error{margin:13px 0 0;padding:9px 10px;border:1px solid var(--theme-border, #f4c7c1);border-radius:4px;background:var(--theme-subtle, #fff3f1);color:var(--theme-danger, #b42318);font-size:11px;line-height:1.5}.styk-inbetween-dialog [hidden]{display:none!important}
.styk-inbetween-actions{display:flex;justify-content:flex-end;gap:8px;padding:13px 20px;border-top:1px solid var(--theme-border, #e8e8e8)}.styk-inbetween-actions button{min-width:78px;height:31px;padding:0 13px;border:1px solid var(--theme-border, #d9d9d9);border-radius:5px;background:var(--theme-panel, white);color:var(--theme-text, #333);font-size:11px;font-weight:500}.styk-inbetween-actions button:hover{background:var(--theme-hover, #f5f5f5)}.styk-inbetween-actions .primary{background:var(--primary);border-color:var(--primary);color:var(--on-primary)}.styk-inbetween-actions .primary:hover{background:var(--primary-hover)}
.styk-inbetween-progress{display:block;width:100%;height:5px;margin:12px 0 0;accent-color:#0d99ff}.styk-inbetween-dialog[aria-busy=true] .styk-inbetween-ratio,.styk-inbetween-dialog[aria-busy=true] .styk-inbetween-endpoints{opacity:.55}
.styk-inbetween-number input:focus-visible{outline:none}.styk-inbetween-slider{appearance:none;border:0;border-radius:9px;background:linear-gradient(to right,var(--theme-action, #0d99ff) var(--styk-ratio,50%),var(--theme-field, #dedede) var(--styk-ratio,50%))}.styk-inbetween-slider::-webkit-slider-thumb{appearance:none;width:15px;height:15px;border:2px solid var(--theme-border, #fff);border-radius:50%;background:var(--theme-action, #0d99ff);box-shadow:0 0 0 1px var(--theme-accent, #0d99ff)}.styk-inbetween-slider::-moz-range-thumb{width:12px;height:12px;border:2px solid var(--theme-border, #fff);border-radius:50%;background:var(--theme-action, #0d99ff);box-shadow:0 0 0 1px var(--theme-accent, #0d99ff)}
`;
const modes = ['adjacent', 'settings', 'none'];
const progressKeys = {sampling: 'insertInbetweenDialog.preparingPoses', 'sampling animation': 'insertInbetweenDialog.preparingAnimationPoses', animation: 'insertInbetweenDialog.preparingAnimationTracks', validation: 'insertInbetweenDialog.checkingFrames', staging: 'insertInbetweenDialog.preparingFrames'};
const modeKeys = {adjacent: 'insertInbetweenDialog.onionSkinsBeforeAfter', settings: 'insertInbetweenDialog.onionSkinsSettings', none: 'insertInbetweenDialog.onionSkinsOff'};

/** Read-only previews are drawn by the engine (`renderThumbnail`, engine-thumbnails.mjs). Only Insert edits
 * the model, after revision/identity checks, as one atomic range command. */
export class InsertInbetweenDialog {
  constructor({editor, dialog, renderThumbnail, getSettings = () => ({}), onApply = () => {}, onClose = () => {}, onError = () => {}}) {
    Object.assign(this, {editor, getSettings, renderThumbnail, onApply, onClose, onError});
    this.ownsDialog = !dialog;
    this.dialog = dialog ?? document.createElement('dialog');
    if (this.ownsDialog) appendLocalized(document.body, this.dialog);
    this.ratio = .5; this.onionMode = 'adjacent'; this.sequence = 0;
    if (!document.querySelector('[data-styk-inbetween-style]')) {
      const style = document.createElement('style'); style.dataset.stykInbetweenStyle = ''; style.textContent = `@layer legacy{${STYLE}}`; appendLocalized(document.head, style);
    }
  }
  open(indices = [this.editor.frameIndex]) {
    if (this.session) this.cancel();
    indices = this.editor._frameIndices(indices);
    if (!indices.length) throw messageError(new Error(''), "errors.insertInbetweenDialog.selectAKeyframeBeforeInsertingAnInbetween", {});
    if (this.editor.dragging || this.editor._animationEdit) throw messageError(new Error(''), "errors.insertInbetweenDialog.finishTheCurrentEditBeforeInsertingAnInbetween", {});
    this.session = {report: this.editor.report, revision: this.editor.revision, draftRevision: this.editor.frameDraftRevision, indices,
      frameIds: indices.map(index => this.editor.getFrameId(index))};
    this.previewIndex = indices.includes(this.editor.frameIndex) ? this.editor.frameIndex : indices[0];
    this.events = new AbortController(); const {signal} = this.events;
    this.dialog.classList.add('styk-inbetween-dialog'); localizedAttribute(this.dialog, 'aria-label', "insertInbetweenDialog.insertInbetween", {});
    localizedMarkup(this.dialog, `<div class="styk-inbetween-head"><h2 data-i18n="insertInbetweenDialog.insertInbetween">${messageHTML("insertInbetweenDialog.insertInbetween", {})}</h2><button type="button" class="styk-inbetween-close" aria-label="Close insert inbetween" data-i18n-aria-label="insertInbetweenDialog.closeInsertInbetween">${icon('close')}</button></div>
      <div class="styk-inbetween-body"><div class="styk-inbetween-summary"><span data-summary></span><select aria-label="Preview selected keyframe" data-i18n-aria-label="insertInbetweenDialog.previewSelectedKeyframe"></select></div>
      <button type="button" class="styk-inbetween-preview" aria-label="Cycle onion skins" data-i18n-aria-label="insertInbetweenDialog.cycleOnionSkins"><canvas width="512" height="288" aria-label="Inbetween pose preview" data-i18n-aria-label="insertInbetweenDialog.inbetweenPosePreview"></canvas></button>
      <div class="styk-inbetween-tools"><button type="button" class="styk-inbetween-onions">${icon('layers')}<span></span></button><span role="status" aria-live="polite"></span></div>
      <div class="styk-inbetween-ratio"><label for="styk-inbetween-ratio" data-i18n="insertInbetweenDialog.interpolationRatio">${messageHTML("insertInbetweenDialog.interpolationRatio", {})}</label><label class="styk-inbetween-number"><input type="number" min="0" max="100" step="0.1" aria-label="Interpolation percentage" data-i18n-aria-label="insertInbetweenDialog.interpolationPercentage"><span>%</span></label></div>
      <input id="styk-inbetween-ratio" class="styk-inbetween-slider" type="range" min="0" max="1" step="0.001" aria-label="Interpolation ratio" data-i18n-aria-label="insertInbetweenDialog.interpolationRatio">
      <div class="styk-inbetween-endpoints"><button type="button" data-ratio="0" data-i18n="insertInbetweenDialog.previousPose">${messageHTML("insertInbetweenDialog.previousPose", {})}</button><button type="button" data-ratio="0.5">50%</button><button type="button" data-ratio="1" data-i18n="insertInbetweenDialog.nextPose">${messageHTML("insertInbetweenDialog.nextPose", {})}</button></div>
      <p class="styk-inbetween-timing"></p><progress class="styk-inbetween-progress" aria-label="Preparing inbetween frames" hidden data-i18n-aria-label="insertInbetweenDialog.preparingInbetweenFrames"></progress><p class="styk-inbetween-error" role="alert" hidden></p></div>
      <div class="styk-inbetween-actions"><button type="button" data-inbetween-cancel data-i18n="common.cancel">${messageHTML("insertInbetweenDialog.cancel", {})}</button><button type="button" class="primary" data-inbetween-insert disabled></button></div>`);
    this.$ = selector => this.dialog.querySelector(selector);
    this.canvas = this.$('canvas'); this.applyButton = this.$('[data-inbetween-insert]');
    // Reuse one caption and one numeric suffix throughout this session: progress
    // callbacks must not accumulate registered nodes or freeze a translated phase.
    this.statusCaption = document.createElement('span');
    this.statusSuffix = document.createTextNode('');
    appendLocalized(this.$('[role=status]'), this.statusCaption);
    this.$('[role=status]').append(this.statusSuffix);
    this.setApplying(false);
    localizedText(this.$('[data-summary]'), "insertInbetweenDialog.selectedKeyframe", {count: indices.length});
    for (const index of indices) { const option = document.createElement('option'); option.value = String(index); localizedText(option, "insertInbetweenDialog.beforeKeyframe", {value: index + 1}); appendLocalized(this.$('select'), option); }
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
        this.previewAbort?.abort(); this.showError(messageError(new Error(''), "errors.insertInbetweenDialog.theAnimationChangedWhileThisPreviewWasOpen", {}));
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
      throw messageError(new Error(''), "errors.insertInbetweenDialog.theSelectedSourceKeyframesChangedCancelAndReopen", {});
  }
  setRatio(ratio) {
    if (this.applying) return;
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      this.sequence++; this.pendingPreview = null; this.previewAbort?.abort();
      if (this.previewRaf) cancelAnimationFrame(this.previewRaf); this.previewRaf = null;
      this.showError(messageError(new Error(''), "errors.insertInbetweenDialog.enterAPercentageFrom0To100", {})); return;
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
    this.setStatus('insertInbetweenDialog.renderingPreview');
    localizedText(this.$('.styk-inbetween-onions span'), modeKeys[this.onionMode]);
    localizedAttribute(this.$('.styk-inbetween-onions'), 'aria-label', modeKeys[this.onionMode]);
    const settings = this.getSettings() ?? {}, frames = this.editor.report.keyframes;
    const duration = frames[this.previewIndex === 0 || this.ratio > 0 ? this.previewIndex : this.previewIndex - 1].duration_raw;
    localizedText(this.$('.styk-inbetween-timing'), "insertInbetweenDialog.insertsBeforeKeyframeExistingKeyframeExposuresStayUnchanged", {value: this.previewIndex + 1, value2: duration === 0 ? {messageKey: 'insertInbetweenDialog.hiddenPose'} : {messageKey: 'counts.exposure', messageParams: {count: duration}}});
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
          if (!rendered) throw messageError(new Error(''), "errors.insertInbetweenDialog.thePosePreviewIsUnavailableAdjustTheRatio", {});
          this.assertCurrent(); this.applyButton.disabled = false; this.setStatus('insertInbetweenDialog.clickPreviewToCycleOnions');
          this.previewReady = request.generation;
        } catch (error) { if (this.session && !controller.signal.aborted && request.generation === this.sequence) this.showError(error); }
        finally { if (this.previewAbort === controller) this.previewAbort = null; }
      }
    } finally { this.busy = false; }
  }
  showError(error) {
    if (!this.session) return;
    this.applyButton.disabled = true; presentError(this.$('[role=alert]'), error); this.$('[role=alert]').hidden = false;
    this.setStatus(null); this.onError(error);
  }
  setStatus(key, suffix = '') {
    if (key) localizedText(this.statusCaption, key);
    else { clearTranslation(this.statusCaption); this.statusCaption.textContent = ''; }
    if (this.statusSuffix.nodeValue !== suffix) this.statusSuffix.nodeValue = suffix;
  }
  setApplying(active) {
    this.applying = active;
    this.dialog.setAttribute('aria-busy', String(active));
    for (const control of this.dialog.querySelectorAll('input,select,[data-ratio],.styk-inbetween-preview,.styk-inbetween-onions')) control.disabled = active;
    const count = this.session.indices.length;
    localizedText(this.applyButton, active ? 'insertInbetweenDialog.preparing' : count > 1 ? 'insertInbetweenDialog.insertFrames' : 'insertInbetweenDialog.insert', active ? {} : count > 1 ? {count} : {value: ''});
    this.$('progress').hidden = !active;
    if (active) {
      this.applyButton.disabled = true;
      this.$('[role=alert]').hidden = true;
      this.$('progress').removeAttribute('value');
      this.setStatus('insertInbetweenDialog.preparingInbetweenFrames2');
    }
  }
  updateProgress(job, progress = {}) {
    if (this.applyJob !== job || this.session !== job.session || job.controller.signal.aborted) return;
    const key = progressKeys[progress.phase] ?? 'insertInbetweenDialog.preparingFrames';
    const total = Number(progress.total), completed = Number(progress.completed);
    const bar = this.$('progress');
    if (Number.isFinite(total) && total > 0 && Number.isFinite(completed)) {
      bar.max = total; bar.value = Math.max(0, Math.min(total, completed));
      this.setStatus(key, ` · ${Math.round(bar.value)} / ${Math.round(total)}`);
    } else {
      bar.removeAttribute('value'); this.setStatus(key, '…');
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
    if (this.dialog.open) this.dialog.close(); this.dialog.classList.remove('styk-inbetween-dialog');
    this.onClose({applied, result});
  }
  destroy() { this.cancel(); if (this.ownsDialog) this.dialog.remove(); }
}
