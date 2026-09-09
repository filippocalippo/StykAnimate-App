import {getVfwCapabilities, configureVfwCodec} from './vfw-video-export.mjs';

const markup = `<h3>Windows AVI codecs</h3><label class="vfw-codec-label">Installed codec<select id="export-vfw-codec" aria-label="Installed Windows AVI codec" disabled><option>Checking installed codecs…</option></select></label>
<div class="vfw-options"><label>Quality %<input id="export-vfw-quality" type="number" min="0" max="100" step="1" value="90" disabled></label><label>Keyframe every<input id="export-vfw-keyframes" type="number" min="0" max="1000000" step="1" value="0" title="0 uses the codec default" disabled></label><label>Rate · Mbit/s<input id="export-vfw-bitrate" type="number" min="0" max="200" step="0.1" value="0" title="0 uses the codec default" disabled></label></div>
<div class="vfw-config"><button id="export-vfw-configure" type="button" disabled>Configure codec…</button><span class="vfw-config-state"></span></div><p class="vfw-status" role="status"></p>`;
const css = `.vfw-export-controls{margin-top:14px;padding-top:12px;border-top:1px solid var(--border,#ddd);min-width:0}.vfw-export-controls h3{font-size:11px;font-weight:600;margin:0 0 10px}.vfw-export-controls label{display:flex;flex-direction:column;gap:5px;font-size:10px;min-width:0}.vfw-codec-label select{max-width:100%;min-width:0;width:100%;font:inherit;height:29px}.vfw-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:10px 0}.vfw-options input{width:100%;box-sizing:border-box;min-width:0;height:28px;font:inherit}.vfw-codec-label select,.vfw-options input{border:1px solid transparent;border-radius:4px;background:var(--field,#f2f2f3);color:inherit;padding:0 8px;outline:none}.vfw-codec-label select:focus,.vfw-options input:focus{border-color:var(--accent,#1595e8);box-shadow:0 0 0 1px var(--accent,#1595e8)}.vfw-config{display:flex;gap:8px;align-items:center;min-width:0}.vfw-config button{white-space:nowrap;font:inherit;font-size:11px;border:1px solid var(--border,#ddd);border-radius:4px;background:var(--panel,#fff);color:inherit;padding:5px 8px;cursor:pointer}.vfw-config button:hover:not(:disabled){background:var(--field,#f2f2f3)}.vfw-config button:disabled{cursor:default}.vfw-config-state,.vfw-status{font-size:10px;color:var(--muted,#75757f);overflow-wrap:anywhere}.vfw-status{margin:9px 0 0;line-height:1.4}.vfw-export-controls :disabled{opacity:.5}`;
const numeric = (element, min, max, label, whole = false) => {
  if (!element.value.trim()) throw new Error(`Enter ${label.toLowerCase()}.`);
  const value = Number(element.value); if (!Number.isFinite(value) || value < min || value > max || (whole && !Number.isInteger(value))) throw new Error(`${label} must be ${whole ? 'a whole number ' : ''}from ${min} to ${max}.`); return value;
};

/** Dialog-local controls. No observers, polling, or listeners survive dispose. */
export class VfwExportControls {
  constructor({container, button, dialog, getDimensions, canExport = () => true, onError = () => {}}) {
    this.container = container; this.button = button; this.dialog = dialog; this.getDimensions = getDimensions; this.canExport = canExport; this.onError = onError;
    this.generation = 0; this.disposed = false; this.configurations = new Map(); this.codecs = []; this.loadedKey = null;
    this.element = document.createElement('section'); this.element.className = 'vfw-export-controls'; container.append(this.element);
    this.button.hidden = !globalThis.stykDesktop?.getVfwCapabilities; this.element.hidden = this.button.hidden;
    if (this.button.hidden) return;
    if (!document.getElementById('vfw-export-controls-style')) { const style = document.createElement('style'); style.id = 'vfw-export-controls-style'; style.textContent = css; document.head.append(style); }
    this.element.innerHTML = markup;
    this.select = this.element.querySelector('#export-vfw-codec'); this.quality = this.element.querySelector('#export-vfw-quality'); this.keyframes = this.element.querySelector('#export-vfw-keyframes'); this.bitrate = this.element.querySelector('#export-vfw-bitrate'); this.configureButton = this.element.querySelector('#export-vfw-configure'); this.status = this.element.querySelector('.vfw-status'); this.configStatus = this.element.querySelector('.vfw-config-state');
    this.onChange = () => this._selection(); this.onConfigure = () => this.configure().catch(error => { if (!this.disposed) this.onError(error); });
    this.onInput = () => { const key = this._currentKey(); clearTimeout(this.timer); if (key === this.requestedKey) { this._selection(); return; } this.button.disabled = true; this.configureButton.disabled = true; this.timer = setTimeout(() => this.refresh(), 150); };
    this.onClose = () => { if (!dialog.open || !this.element.isConnected) this.dispose(); };
    this.select.addEventListener('change', this.onChange); this.configureButton.addEventListener('click', this.onConfigure); dialog.addEventListener('input', this.onInput); dialog.addEventListener('close', this.onClose);
    this.refresh();
  }
  _size() {
    const size = this.getDimensions();
    if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1 || size.width > 16384 || size.height > 16384 || size.width * size.height > 16777216) throw new Error('Choose valid video dimensions up to 16 million pixels.');
    return {width: size.width, height: size.height};
  }
  _currentKey() { try { const size = this._size(); return `${size.width}:${size.height}`; } catch { return null; } }
  _configurationKey() { return `${this.select?.value}|${this.loadedKey}`; }
  async refresh() {
    if (this.disposed || this.element.hidden) return;
    clearTimeout(this.timer); const generation = ++this.generation; let size;
    this.button.disabled = true; this.select.disabled = true; this.configureButton.disabled = true; this.status.textContent = 'Checking installed Windows codecs…';
    try {
      size = this._size(); this.requestedKey = `${size.width}:${size.height}`;
      const key = this.requestedKey, previous = this.select.value, result = await getVfwCapabilities(size);
      if (this.disposed || generation !== this.generation || this._currentKey() !== key) return;
      if (result.platform && result.platform !== 'win32') { this.element.hidden = true; this.button.hidden = true; return; }
      this.loadedKey = key; this.codecs = result.codecs ?? []; this.select.replaceChildren();
      for (const codec of this.codecs) { const option = document.createElement('option'); option.value = codec.id; option.textContent = codec.label; option.disabled = !codec.supported; option.title = codec.reason || `${codec.fourcc} · ${codec.provider}`; this.select.append(option); }
      const selected = this.codecs.find(codec => codec.id === previous && codec.supported) ?? this.codecs.find(codec => codec.supported && codec.kind === 'installed') ?? this.codecs.find(codec => codec.supported);
      if (!selected) { const option = document.createElement('option'); option.value = ''; option.textContent = 'No compatible codec'; this.select.append(option); this.select.value = ''; this.status.textContent = result.reason || 'No installed codec accepts this canvas size.'; return; }
      this.select.value = selected.id; this.select.disabled = false; this._selection();
    } catch (error) { if (!this.disposed && generation === this.generation) { this.loadedKey = null; this.status.textContent = error.message; } }
  }
  _selection() {
    if (this.disposed) return; const codec = this.codecs.find(codec => codec.id === this.select.value), ready = Boolean(codec?.supported && this.loadedKey === this._currentKey());
    this.button.disabled = !ready || this.configuring || !this.canExport(); this.configureButton.disabled = !ready || !codec?.configure || this.configuring;
    this.quality.disabled = !ready || !codec?.quality; this.keyframes.disabled = !ready || !codec?.keyframes; this.bitrate.disabled = !ready || !codec?.dataRate;
    this.configStatus.textContent = this.configurations.has(this._configurationKey()) ? 'Custom codec settings' : '';
    if (ready) this.status.textContent = `${codec.fourcc} · ${codec.arch === 'x86' ? '32-bit' : '64-bit'} ${codec.kind === 'uncompressed' ? 'native uncompressed AVI' : 'installed Windows codec'}. ${this.loadedKey.replace(':', ' × ')} px. Transparent areas become black.`;
  }
  getOptions() {
    if (this.disposed || this.element.hidden) throw new Error('Installed Windows codecs are unavailable in this app.');
    const codec = this.codecs.find(codec => codec.id === this.select.value);
    if (!codec?.supported || this.loadedKey !== this._currentKey() || this.configuring) throw new Error('Wait for the installed codec check or choose a compatible codec.');
    return {codecId: codec.id, quality: codec.quality ? numeric(this.quality, 0, 100, 'Quality') / 100 : .9,
      keyframeEvery: codec.keyframes ? numeric(this.keyframes, 0, 1000000, 'Keyframe interval', true) : 0,
      bitrate: codec.dataRate ? Math.round(numeric(this.bitrate, 0, 200, 'Bitrate') * 1000000) : 0,
      configurationId: this.configurations.get(this._configurationKey())};
  }
  async configure() {
    const options = this.getOptions(), size = this._size(), key = this._configurationKey(), codec = this.codecs.find(codec => codec.id === options.codecId);
    if (!codec?.configure) return;
    this.configuring = true; this._selection(); this.configStatus.textContent = 'Codec settings are open…';
    try {
      const result = await configureVfwCodec({codecId: options.codecId, ...size, configurationId: options.configurationId});
      if (!this.disposed && result?.configurationId) this.configurations.set(key, result.configurationId);
    } finally { this.configuring = false; if (!this.disposed) this._selection(); }
  }
  dispose() {
    if (this.disposed) return; this.disposed = true; this.generation++; clearTimeout(this.timer);
    this.select?.removeEventListener('change', this.onChange); this.configureButton?.removeEventListener('click', this.onConfigure); this.dialog.removeEventListener('input', this.onInput); this.dialog.removeEventListener('close', this.onClose); this.configurations.clear();
  }
}
