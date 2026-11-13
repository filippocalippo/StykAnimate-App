import {interfaceLocalization, t as interfaceText} from './localization.mjs';

import {messageHTML, localizedText} from './localization-bindings.mjs';
/** Presentation state only. Frame completion is reported by the renderer/encoder;
 * elapsed time never advances the progress bar. GIF has two explicit passes. */
export class ExportProgress {
  constructor({frames = 1, passes = 1, start = 0, now = () => performance.now()} = {}) {
    Object.assign(this, {frames, passes, start, now, started: now(), phase: 'preparing', rendered: 0, completed: 0, active: 0});
  }
  frameStarted(tick) {
    this.active = this.rendered;
    this.tick = tick ?? this.start;
    this.phase = this.passes === 2 && this.rendered < this.frames ? 'palette' : 'rendering';
  }
  frameRendered() { this.rendered++; this.phase = 'processing'; }
  update({completed, phase} = {}) {
    if (Number.isFinite(completed)) this.completed = Math.max(this.completed, Math.min(this.frames * this.passes, completed));
    if (this.completed === this.frames * this.passes) this.phase = 'encoding';
    if (['encoding', 'complete', 'saving'].includes(phase)) this.phase = phase === 'complete' ? 'encoding' : phase;
  }
  snapshot() {
    const work = this.frames * this.passes;
    // A GIF whose encoder kept the first pass's frames draws none in the second: its frames encoded count as its frames.
    const active = Math.max(this.active, this.completed - 1), delivered = Math.max(this.rendered, this.completed);
    const pass = Math.min(this.passes, Math.floor(active / this.frames) + 1);
    const rendered = Math.min(this.frames, Math.max(0, delivered - (pass - 1) * this.frames));
    const elapsed = Math.max(0, (this.now() - this.started) / 1000);
    const done = this.completed;
    const rate = elapsed >= 1 && done > 0 ? done / elapsed : null;
    const finalizing = ['encoding', 'saving'].includes(this.phase);
    return {phase: this.phase, pass, passes: this.passes, rendered, remaining: this.frames - rendered,
      frames: this.frames, frame: Math.min(this.frames, active % this.frames + 1), sourceFrame: (this.tick ?? this.start) + 1,
      elapsed, rate, eta: rate && done >= 3 && done < work ? (work - done) / rate : null,
      // Reserve the final portion for container finalization and the actual save.
      percent: this.phase === 'saving' ? 98 : finalizing ? 95 : Math.min(95, Math.floor(done / work * 95))};
  }
}

export function exportTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const value = Math.max(0, Math.round(seconds));
  if (value < 60) return `${interfaceLocalization.formatNumber(value)}s`;
  if (value < 3600) return `${interfaceLocalization.formatNumber(Math.floor(value / 60))}m ${interfaceLocalization.formatNumber(value % 60)}s`;
  return `${interfaceLocalization.formatNumber(Math.floor(value / 3600))}h ${interfaceLocalization.formatNumber(Math.floor(value % 3600 / 60))}m`;
}

/** The progress view (features/export.css): it replaces the export dialog's settings while an export runs. */
export const exportProgressMarkup = `<div class="export-progress">
  <div class="export-progress-head"><strong id="export-stage" role="status" aria-live="polite" data-i18n="exportProgress.preparingAnimation">Preparing animation…</strong><output id="export-percent">0%</output></div>
  <progress id="export-progress" max="100" aria-label="Export progress" aria-describedby="export-frame-detail" data-i18n-aria-label="exportProgress.exportProgress"></progress>
  <p id="export-frame-detail"></p>
  <dl class="export-progress-stats"><div><dt>${messageHTML("exportProgress.rendered", {})}</dt><dd id="export-rendered">0</dd></div><div><dt>${messageHTML("exportProgress.leftToRender", {})}</dt><dd id="export-remaining">—</dd></div><div><dt>${messageHTML("exportProgress.elapsed", {})}</dt><dd id="export-elapsed">${messageHTML("exportProgress.message0s", {})}</dd></div><div><dt>${messageHTML("exportProgress.estRemaining", {})}</dt><dd id="export-eta">—</dd></div></dl>
  <p id="export-pass-note" hidden></p>
  <div class="export-progress-actions"><button type="button" class="ui-button" data-variant="outline" id="cancel-export" data-i18n="exportProgress.cancelExport">Cancel export</button></div>
</div>`;

export function mountExportProgress(content, options, cancel) {
  const model = new ExportProgress(options);
  const field = id => content.querySelector(`#export-${id}`);
  const paint = () => {
    if (!field('progress')?.isConnected) return;
    const s = model.snapshot(), preparing = s.phase === 'preparing';
    const stageKey = s.phase === 'saving' ? 'exportProgress.savingYourFile' : s.phase === 'encoding' ? 'exportProgress.finishingYourFile' : preparing ? 'exportProgress.preparingAnimation' : s.pass === 1 && s.passes === 2 ? 'exportProgress.buildingGifColors' : s.phase === 'processing' ? 'exportProgress.encodingFrames' : 'exportProgress.renderingFrames';
    localizedText(field('stage'), stageKey);
    if (preparing) field('progress').removeAttribute('value'); else field('progress').value = s.percent;
    field('percent').textContent = preparing ? '—' : `${s.percent}%`;
    localizedText(field('frame-detail'), preparing ? 'counts.framesToExport' : s.phase === 'saving' ? 'exportProgress.chooseWhereToSave' : s.phase === 'encoding' ? 'exportProgress.allFramesRendered' : 'exportProgress.frameProgress', {count: s.frames, stage: {messageKey: s.phase === 'processing' ? 'exportProgress.processing' : 'exportProgress.rendering'}, frame: s.frame, total: s.frames, sourceFrame: s.sourceFrame});
    field('rendered').textContent = `${interfaceLocalization.formatNumber(s.rendered)} / ${interfaceLocalization.formatNumber(s.frames)}`;
    field('remaining').textContent = interfaceLocalization.formatNumber(s.remaining);
    field('elapsed').textContent = exportTime(s.elapsed);
    field('eta').textContent = s.eta === null ? '—' : `~${exportTime(s.eta)}`;
    field('pass-note').hidden = s.passes !== 2;
    if (s.passes === 2) localizedText(field('pass-note'), 'exportProgress.passProgress', {pass:s.pass,total:2});
  };
  const button = content.querySelector('#cancel-export');
  button.onclick = () => { button.disabled = true; localizedText(button, "exportProgress.cancelling", {}); cancel(); };
  paint(); const timer = setInterval(paint, 250);
  return {
    frameStarted(tick) {model.frameStarted(tick); paint();},
    frameRendered() {model.frameRendered(); paint();},
    update(value) {model.update(value); paint();},
    dispose() {clearInterval(timer);},
  };
}
