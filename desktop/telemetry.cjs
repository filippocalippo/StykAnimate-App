'use strict';
const crypto = require('node:crypto');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { WorkspacePreferences } = require('./preferences.cjs');
const config = require('./service-config.json');
const DAY = 86400000, UPLOAD_INTERVAL = 15 * 60000;
const dayOf = time => new Date(time).toISOString().slice(0, 10);
const enabled = consent => Boolean(consent?.analytics || consent?.diagnostics);
const timeout = ms => AbortSignal.timeout(ms);
function endpoint(value, development = false) {
  if (!value) return '';
  try { const url = new URL(value); if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return '';
    return url.protocol === 'https:' || development && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) ? url.origin : ''; } catch { return ''; }
}
class TelemetryService {
  constructor({ directory, schemaPath, version, development = false, siteUrl = development ? process.env.STYK_SITE_URL || config.siteUrl : config.siteUrl, fetchImpl = fetch, now = Date.now, onState = () => {} }) {
    this.store = new WorkspacePreferences(directory, { filename: 'telemetry-state.json', maxBytes: 300 * 1024 });
    this.schemaPath = schemaPath; this.version = version; this.channel = development ? 'development' : config.channel; this.siteUrl = endpoint(siteUrl, development);
    this.fetch = fetchImpl; this.now = now; this.onState = onState; this.epoch = 1; this.lastUpload = 0; this.nextUpload = 0; this.status = 'Waiting for your choice';
    this.pending = Promise.resolve(); this.state = { consent: {}, days: {}, milestones: {}, deletions: [], sequence: 0, acknowledged: null };
  }
  async init({ timers = true } = {}) {
    this.schema = await import(pathToFileURL(this.schemaPath).href);
    const loaded = await this.store.get();
    this.state.sequence = Number.isSafeInteger(loaded.sequence) && loaded.sequence >= 0 ? loaded.sequence : 0;
    if (loaded.consent?.policyVersion === this.schema.POLICY_VERSION) {
      this.state.consent = { analytics: loaded.consent.analytics === true, diagnostics: loaded.consent.diagnostics === true, policyVersion: this.schema.POLICY_VERSION, updatedAt: Number(loaded.consent.updatedAt) || this.now() };
      this.state.decided = loaded.decided === true;
    }
    if (/^[a-f0-9]{64}$/.test(loaded.token || '')) this.state.token = loaded.token;
    try { if (loaded.acknowledged?.day === dayOf(this.now())) this.state.acknowledged = this.schema.validateSnapshot(loaded.acknowledged); } catch { /* Invalid baseline is discarded. */ }
    this.state.deletions = (Array.isArray(loaded.deletions) ? loaded.deletions : []).filter(d => /^[a-f0-9]{64}$/.test(d?.token || '') && endpoint(d.url, true) === d.url).slice(0, 4);
    if (enabled(this.state.consent) && this.state.token) {
      for (const [day, data] of Object.entries(loaded.days || {}).slice(-7)) {
        try { if (this.now() - Date.parse(day) < 7 * DAY) this.state.days[day] = this.schema.validateSnapshot(data); } catch { /* Discard corrupt local summaries. */ }
      }
      this.state.milestones = Object.assign({}, ...Object.values(this.state.days).map(d => d.milestones));
      if (this.state.consent.analytics) for (const key of this.schema.MILESTONES) {
        const day = loaded.milestones?.[key];
        if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && dayOf(Date.parse(day)) === day && day <= dayOf(this.now())) this.state.milestones[key] = day;
      }
      this.ensureIdentity(); this.count('sessions_started'); this.milestone('first_launch');
      this.sessionCounted = this.state.consent.analytics;
      if (loaded.running && this.state.consent.diagnostics) this.count('unclean_starts');
    }
    this.state.running = enabled(this.state.consent); this.refreshStatus();
    await this.persist();
    this.timersEnabled = timers; this.configureTimer();
    return this;
  }
  configureTimer() {
    clearInterval(this.timer); this.timer = null;
    if (this.timersEnabled && (enabled(this.state.consent) || this.state.deletions.length)) {
      this.timer = setInterval(() => { if (enabled(this.state.consent)) void this.persist().catch(() => {}); void this.upload().catch(() => {}); }, 60000); this.timer.unref?.();
    }
  }
  ensureIdentity() {
    if (!this.state.token) this.state.token = crypto.randomBytes(32).toString('hex');
    this.id = crypto.createHash('sha256').update(this.state.token).digest('hex');
  }
  refreshStatus() { this.status = this.state.deletions.length ? 'Deletion pending; retrying when online' : !enabled(this.state.consent) ? 'Collection is off' : !this.siteUrl ? 'Local only · service not configured' : 'Batched · sends at most every 15 minutes'; }
  getState() {
    return { epoch: this.epoch, decided: Boolean(this.state.decided), consent: { analytics: false, diagnostics: false, policyVersion: this.schema.POLICY_VERSION, ...this.state.consent },
      installationId: enabled(this.state.consent) ? this.id || null : null, siteUrl: this.siteUrl, publisher: config.publisher, contact: config.contact,
      status: this.status, lastUpload: this.lastUpload || null, pendingDays: Object.keys(this.state.days).length, deletionPending: this.state.deletions.length > 0 };
  }
  notify() { this.onState(this.getState()); }
  async setConsent(value) {
    if (typeof value?.analytics !== 'boolean' || typeof value?.diagnostics !== 'boolean') throw new TypeError('Choose analytics and diagnostics separately.');
    this.epoch++; this.controller?.abort();
    this.state.consent = { analytics: value.analytics, diagnostics: value.diagnostics, policyVersion: this.schema.POLICY_VERSION, updatedAt: this.now() };
    this.state.decided = true; this.state.running = enabled(value);
    if (enabled(value)) {
      this.ensureIdentity();
      // Changing a category drops its unsent data. Retained server history can be deleted separately.
      for (const [day, data] of Object.entries(this.state.days)) this.state.days[day] = this.schema.validateSnapshot({ ...data, consent: this.state.consent, sequence: ++this.state.sequence });
      if (!value.analytics) this.state.milestones = {};
      if (value.analytics && !this.sessionCounted) { this.count('sessions_started'); this.milestone('first_launch'); this.sessionCounted = true; }
    } else { this.state.days = {}; this.state.milestones = {}; }
    this.refreshStatus(); await this.persist(); this.configureTimer(); this.notify(); return this.getState();
  }
  today() {
    if (!enabled(this.state.consent)) return null;
    this.ensureIdentity(); const day = dayOf(this.now());
    if (this.state.acknowledged?.day !== day) this.state.acknowledged = null;
    for (const key of Object.keys(this.state.days)) if (this.now() - Date.parse(key) > 7 * DAY) delete this.state.days[key];
    if (!this.state.days[day] && this.state.acknowledged?.installationId === this.id) {
      this.state.days[day] = this.schema.validateSnapshot({ ...this.state.acknowledged, consent: this.state.consent, sequence: ++this.state.sequence });
      this.state.milestones = { ...this.state.days[day].milestones, ...this.state.milestones };
    }
    return this.state.days[day] ||= { schemaVersion: 1, installationId: this.id, day, sequence: ++this.state.sequence, app: { version: this.version, channel: this.channel }, consent: { ...this.state.consent },
      environment: this.schema.sanitizeEnvironment({ os: process.platform, arch: process.arch, osVersion: process.platform === 'win32' ? Number(os.release().split('.')[2]) >= 22000 ? 'windows-11' : 'windows-10' : process.platform === 'darwin' ? 'mac' : 'linux',
        ramBucket: os.totalmem() <= 5 * 1073741824 ? '4-or-less' : os.totalmem() <= 9 * 1073741824 ? '8' : os.totalmem() <= 17 * 1073741824 ? '16' : os.totalmem() <= 33 * 1073741824 ? '32' : '64-plus',
        cpuBucket: os.availableParallelism() <= 2 ? '2-or-less' : os.availableParallelism() <= 4 ? '4' : os.availableParallelism() <= 8 ? '8' : os.availableParallelism() <= 16 ? '16' : '32-plus' }),
      counters: {}, timings: {}, gauges: {}, errors: [], milestones: { ...this.state.milestones } };
  }
  record({ epoch, data, environment }) {
    if (epoch !== this.epoch || !enabled(this.state.consent) || !data) return false;
    const today = dayOf(this.now());
    if (!this.state.days[today] && Object.keys(data.counters || {}).every(key => key === 'idle_seconds') && !Object.keys(data.timings || {}).length && !Object.keys(data.gauges || {}).length && !Object.keys(data.milestones || {}).length && !data.errors?.length) return false;
    const current = this.today(); let changed = false;
    const safe = this.schema.validateSnapshot({ ...current, counters: {}, timings: {}, gauges: {}, errors: [], milestones: {}, ...data,
      schemaVersion: 1, installationId: this.id, day: current.day, sequence: current.sequence, app: current.app, consent: this.state.consent, environment: this.schema.sanitizeEnvironment(environment) });
    for (const [key, n] of Object.entries(safe.counters)) if (n > 0) { current.counters[key] = Math.min(1e9, (current.counters[key] || 0) + n); changed = true; }
    for (const [key, h] of Object.entries(safe.timings)) {
      if (!h.count) continue; changed = true;
      const target = current.timings[key] ||= this.schema.emptyHistogram();
      target.count += h.count; target.sum += h.sum; target.max = Math.max(target.max, h.max); h.buckets.forEach((n, i) => target.buckets[i] += n);
    }
    for (const [key, n] of Object.entries(safe.gauges)) if (current.gauges[key] === undefined || n > current.gauges[key]) { current.gauges[key] = n; changed = true; }
    for (const [key, day] of Object.entries(safe.milestones)) if (!this.state.milestones[key]) { this.state.milestones[key] = day; changed = true; }
    current.milestones = { ...this.state.milestones };
    for (const entry of safe.errors) { const existing = current.errors.find(e => e.fingerprint === entry.fingerprint);
      if (!entry.count) continue; changed = true;
      if (existing) { existing.count += entry.count; existing.lastAt = Math.max(existing.lastAt, entry.lastAt); }
      else if (current.errors.length < 20) current.errors.push(entry);
    }
    for (const [key, value] of Object.entries(safe.environment)) if (value !== 'unknown' && value !== current.environment[key]) { current.environment[key] = value; changed = true; }
    if (changed) current.sequence = ++this.state.sequence;
    return changed;
  }
  count(key, n = 1) { this.record({ epoch: this.epoch, data: { counters: { [key]: n } } }); }
  milestone(key) { if (this.state.consent.analytics) this.record({ epoch: this.epoch, data: { milestones: { [key]: dayOf(this.now()) } } }); }
  error(name, operation, counter) { if (this.state.consent.diagnostics) { if (counter) this.count(counter); this.record({ epoch: this.epoch, data: { errors: [this.schema.sanitizeError({ name }, operation, this.now())] } }); } }
  sampleMemory(megabytes) { if (this.state.consent.diagnostics) this.record({ epoch: this.epoch, data: { gauges: { process_memory_mb: megabytes } } }); }
  persist() { return this.store.set(this.state); }
  preview() { return { policyVersion: this.schema.POLICY_VERSION, retentionDays: 30, consent: this.getState().consent, snapshots: Object.values(this.state.days) }; }
  async upload({ force = false } = {}) {
    if (this.inflight || !this.siteUrl || !force && this.now() < this.nextUpload) return false;
    this.inflight = true;
    try {
      for (const deletion of [...this.state.deletions]) {
        const response = await this.fetch(deletion.url + '/api/v1/telemetry', { method: 'DELETE', headers: { Authorization: 'Bearer ' + deletion.token }, signal: timeout(5000), redirect: 'error' });
        if (!response.ok) throw new Error('Deletion unavailable');
        this.state.deletions = this.state.deletions.filter(item => item !== deletion); await this.persist();
      }
      if (!enabled(this.state.consent)) { this.refreshStatus(); this.configureTimer(); this.notify(); return true; }
      const snapshot = Object.values(this.state.days).sort((a, b) => a.day.localeCompare(b.day))[0];
      if (!snapshot) return true;
      if (this.state.acknowledged?.day === snapshot.day && this.state.acknowledged?.sequence === snapshot.sequence) return true;
      // Idle time is carried with the next useful report; leaving the app open must not produce idle-only uploads.
      if (!force && this.state.acknowledged?.day === snapshot.day) {
        const usefulReport = value => JSON.stringify({ ...value, sequence: 0, counters: { ...value.counters, idle_seconds: 0 } });
        if (usefulReport(this.state.acknowledged) === usefulReport(snapshot)) return true;
      }
      const epoch = this.epoch, sequence = snapshot.sequence, day = snapshot.day;
      const payload = JSON.stringify(this.schema.validateSnapshot(snapshot));
      this.controller = new AbortController(); const abortTimer = setTimeout(() => this.controller?.abort(), 5000);
      let response;
      try { response = await this.fetch(this.siteUrl + '/api/v1/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.state.token }, body: payload, signal: this.controller.signal, redirect: 'error' }); }
      finally { clearTimeout(abortTimer); this.controller = null; }
      if (epoch !== this.epoch) return false;
      if (!response.ok) { const seconds = Number(response.headers.get('Retry-After')); this.nextUpload = this.now() + Math.max(UPLOAD_INTERVAL, Number.isFinite(seconds) ? Math.min(86400, seconds) * 1000 : UPLOAD_INTERVAL); throw new Error('Service unavailable'); }
      if (day !== dayOf(this.now()) && this.state.days[day]?.sequence === sequence) delete this.state.days[day];
      if (day === dayOf(this.now())) this.state.acknowledged = JSON.parse(payload);
      this.lastUpload = this.now(); this.nextUpload = this.now() + UPLOAD_INTERVAL + crypto.randomInt(0, 60000); this.refreshStatus(); await this.persist(); this.notify(); return true;
    } catch { this.nextUpload = Math.max(this.nextUpload, this.now() + UPLOAD_INTERVAL); this.status = this.state.deletions.length ? 'Deletion pending; retrying when online' : 'Offline or service busy · summaries queued locally'; this.notify(); return false; }
    finally { this.inflight = false; }
  }
  async deleteData() {
    this.epoch++; this.controller?.abort();
    if (this.state.token && this.siteUrl && !this.state.deletions.some(d => d.token === this.state.token)) {
      if (this.state.deletions.length >= 4) throw new Error('Complete the pending deletion before resetting again.');
      this.state.deletions.push({ token: this.state.token, url: this.siteUrl });
    }
    this.state.token = null; this.id = null; this.state.days = {}; this.state.milestones = {}; this.state.acknowledged = null; this.state.running = false;
    this.state.consent = { analytics: false, diagnostics: false, policyVersion: this.schema.POLICY_VERSION, updatedAt: this.now() }; this.state.decided = true;
    await this.persist(); this.configureTimer(); this.refreshStatus(); this.notify(); await this.upload({ force: true }); return this.getState();
  }
  async feedback(value) {
    if (!this.siteUrl) throw new Error('Feedback service is not configured yet. Contact ' + config.contact + '.');
    if (!['bug', 'idea', 'other'].includes(value?.category) || typeof value?.message !== 'string' || value.message.trim().length < 5 || value.message.length > 2000) throw new Error('Use 5–2,000 characters for your feedback.');
    // Feedback is explicitly submitted; it never enables profiling or invents an installation identifier.
    this.ensureIdentity(); await this.persist();
    const response = await this.fetch(this.siteUrl + '/api/v1/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.state.token }, body: JSON.stringify({ id: crypto.randomUUID(), category: value.category, message: value.message.trim(), appVersion: this.version, platform: process.platform }), signal: timeout(5000), redirect: 'error' });
    if (!response.ok) throw new Error('Feedback could not be sent. Try again later or email ' + config.contact + '.');
    return { sent: true };
  }
  async close() { clearInterval(this.timer); this.count('sessions_closed'); this.state.running = false; await this.persist(); }
}
module.exports = { TelemetryService, endpoint };
