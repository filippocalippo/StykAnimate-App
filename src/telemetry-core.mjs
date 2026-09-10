import { COUNTERS, DIAGNOSTIC_COUNTERS, TIMINGS, GAUGES, emptyHistogram, observe, sanitizeError, sanitizeEnvironment } from './telemetry-schema.mjs';
const counters = new Set(COUNTERS), diagnosticCounters = new Set(DIAGNOSTIC_COUNTERS), timings = new Set(TIMINGS), gauges = new Set(GAUGES);
export class TelemetryAccumulator {
  constructor() { this.consent = {}; this.reportedErrors = new WeakSet(); this.reset(); }
  reset() { this.data = { counters: {}, timings: {}, gauges: {}, milestones: {}, errors: [] }; }
  configure(consent = {}) { this.consent = consent; this.reportedErrors = new WeakSet(); this.reset(); }
  count(key, value = 1) {
    if (!(diagnosticCounters.has(key) ? this.consent.diagnostics : this.consent.analytics) || !counters.has(key) || !Number.isSafeInteger(value) || value < 0) return;
    this.data.counters[key] = Math.min(1e9, (this.data.counters[key] || 0) + value);
  }
  timing(key, value) {
    if (!this.consent.diagnostics || !timings.has(key) || !Number.isFinite(value) || value < 0 || value > 3600000) return;
    observe(this.data.timings[key] ||= emptyHistogram(), value);
  }
  gauge(key, value) {
    if (this.consent.diagnostics && gauges.has(key) && Number.isFinite(value) && value >= 0 && value <= 1e9) this.data.gauges[key] = Math.max(this.data.gauges[key] || 0, value);
  }
  milestone(key) { if (this.consent.analytics) this.data.milestones[key] ||= new Date().toISOString().slice(0, 10); }
  error(error, operation = 'app') {
    if (!this.consent.diagnostics) return;
    if (error && typeof error === 'object') { if (this.reportedErrors.has(error)) return; this.reportedErrors.add(error); }
    const entry = sanitizeError(error, operation), existing = this.data.errors.find(e => e.fingerprint === entry.fingerprint);
    if (existing) { existing.count++; existing.lastAt = entry.lastAt; }
    else if (this.data.errors.length < 20) this.data.errors.push(entry);
    else this.count('dropped_samples');
  }
  drain() { const data = this.data; this.reset(); return data; }
}

const ACTIONS = Object.freeze({ new: 'new_project', open: 'open', 'open-recent': 'open', undo: 'undo', redo: 'redo', copy: 'copy', cut: 'copy', paste: 'paste', duplicate: 'duplicate', delete: 'delete', 'add-frame': 'keyframe', 'blank-frame': 'keyframe', 'duplicate-frame-after': 'keyframe', 'toggle-onion': 'onion', settings: 'settings', 'toggle-camera': 'camera' });
export class DesktopTelemetryClient extends TelemetryAccumulator {
  constructor(bridge, { getContext = () => ({}) } = {}) {
    super(); this.bridge = bridge; this.getContext = getContext; this.lastActivity = 0; this.lastTick = performance.now(); this.epoch = 0;
  }
  async init() {
    if (!this.bridge?.getTelemetryState) return null;
    const status = await this.bridge.getTelemetryState(); this.applyStatus(status);
    this.unsubscribe = this.bridge.onTelemetryState(status => this.applyStatus(status));
    return status;
  }
  applyStatus(status) {
    if (status.epoch === this.epoch && this.initialized) return;
    this.initialized = true; this.epoch = status.epoch; this.configure(status.consent); this.stopSampling();
    if (!this.consent.analytics && !this.consent.diagnostics) return;
    this.lastActivity = performance.now(); this.lastTick = this.lastActivity;
    this.onActivity = () => { this.lastActivity = performance.now(); };
    // Only a timestamp is retained. Neither key values nor pointer coordinates are inspected.
    for (const name of ['pointerdown', 'keydown']) globalThis.addEventListener?.(name, this.onActivity, { passive: true });
    this.timer = setInterval(() => this.tick(), 15000);
    if (this.consent.diagnostics && typeof PerformanceObserver !== 'undefined') {
      this.observers = [];
      for (const type of ['longtask', 'event']) {
        if (!PerformanceObserver.supportedEntryTypes?.includes(type)) continue;
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries().slice(0, 100)) {
            if (type === 'longtask') { this.count('long_tasks'); this.timing('long_task_ms', entry.duration); }
            else this.timing('input_latency_ms', entry.duration);
          }
        });
        try { observer.observe({ type, buffered: false, ...(type === 'event' ? { durationThreshold: 40 } : {}) }); this.observers.push(observer); } catch { observer.disconnect(); }
      }
    }
  }
  stopSampling() {
    clearInterval(this.timer); this.timer = null;
    for (const name of ['pointerdown', 'keydown']) if (this.onActivity) globalThis.removeEventListener?.(name, this.onActivity);
    for (const observer of this.observers || []) observer.disconnect(); this.observers = [];
  }
  action(name) {
    const key = ACTIONS[name] || (name.startsWith('camera-') ? 'camera' : name.startsWith('builder-') ? 'builder' : name.includes('inbetween') ? 'inbetween' : name.includes('movieclip') ? 'movieclip' : null);
    if (key) this.count(key);
  }
  tick() {
    const now = performance.now(), seconds = Math.min(15, Math.max(0, Math.round((now - this.lastTick) / 1000)));
    this.lastTick = now;
    const context = this.getContext(), foreground = !globalThis.document?.hidden && (!globalThis.document?.hasFocus || document.hasFocus()), active = foreground && (now - this.lastActivity < 60000 || context.playing);
    this.count(active ? 'active_seconds' : 'idle_seconds', seconds);
    if (active && ['simple', 'advanced'].includes(context.mode)) this.count(`mode_${context.mode}_seconds`, seconds);
    if (this.consent.diagnostics && foreground) {
      this.gauge('js_heap_mb', performance.memory?.usedJSHeapSize / 1048576);
      for (const [key, value] of Object.entries(context.gauges || {})) this.gauge(key, value);
    }
    void this.flush(context);
  }
  async flush(context = this.getContext()) {
    if (!this.bridge?.recordTelemetry || !this.consent.analytics && !this.consent.diagnostics) return;
    const delta = this.drain(), epoch = this.epoch;
    try { await this.bridge.recordTelemetry({ epoch, data: delta, environment: sanitizeEnvironment(context) }); }
    catch { this.count('dropped_samples'); } // Telemetry failure must never disrupt editing.
  }
  dispose() { this.stopSampling(); this.unsubscribe?.(); }
}
