'use strict';
/**
 * The statistics service of the desktop process (docs/STATISTICS.md): it checks what the editor hands it with
 * src/stats/schema.mjs, keeps a bounded queue on disk, ends sessions, and uploads anonymous batches.
 *
 * Two files: `stats-state.json` in the app's data folder (on or off, the first-start line, the local days of use that
 * answer the `first` facts, the share of sessions the intake asked for, its pause and the last batch sent), and `stats-session.json` in this window
 * process's own folder (the running session and the queue), so a second window's process never overwrites the first's.
 */
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { WorkspacePreferences } = require('./preferences.cjs');

const DAY_MS = 86400000, RETRY_MS = 30 * 60000, START_DELAY_MS = 5000;
const MAX_QUEUE = 64, MAX_AGE_DAYS = 7, MAX_DAYS_KEPT = 21, MAX_BATCHES = 4;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_ID = /^[a-f0-9]{32}$/;
/** The schema's version pattern: an app version the intake would refuse is not uploaded at all. */
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z0-9.]{1,24})?$/;
/** Fields of a session report that the service fills, never the editor. */
const OWNED = ['kind', 'sid', 'day', 'sample', 'end', 'first', 'age', 'when'];

const pad = n => String(n).padStart(2, '0');
const localDayOf = time => { const d = new Date(time); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const utcDay = time => new Date(time).toISOString().slice(0, 10);
const dayNumber = day => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
/** The Monday that starts the week of `day` (a day number). */
const weekOf = day => { const n = dayNumber(day); return n - (new Date(n * DAY_MS).getUTCDay() + 6) % 7; };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validDay = value => typeof value === 'string' && DAY.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));

/** The intake's origin: https only, and in a development run a site on this computer. */
function statsEndpoint(value, development = false) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return '';
    return url.protocol === 'https:' || development && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) ? url.origin : '';
  } catch { return ''; }
}

const VENDOR_IDS = { 0x8086: 'intel', 0x1002: 'amd', 0x1022: 'amd', 0x10de: 'nvidia', 0x106b: 'apple', 0x5143: 'qualcomm', 0x4d4f4351: 'qualcomm', 0x1414: 'software', 0x1ae0: 'software' };
/**
 * The machine from Electron's basic GPU information: the kind of graphics and its vendor, as the schema's words. The memory
 * (bytes) and the processor count are kept as they are; a batch rounds them to the schema's steps (memoryOf, coresOf), which
 * are only ever defined there.
 */
function machineFacts({ gpuInfo, totalmem, cores } = {}) {
  const devices = Array.isArray(gpuInfo?.gpuDevice) ? gpuInfo.gpuDevice : [];
  const device = devices.find(item => item?.active) ?? devices[0];
  const kind = device ? VENDOR_IDS[Number(device.vendorId)] ?? 'other' : 'unknown';
  const text = String(device?.deviceString ?? '');
  const graphics = kind === 'software' ? 'software' : ['intel', 'apple', 'qualcomm'].includes(kind) ? 'integrated' : kind === 'nvidia' ? 'discrete'
    : kind === 'amd' ? (/\b(RX|R9|R7|Pro W|FirePro|Vega \d\d)\b/i.test(text) ? 'discrete' : /Radeon\(TM\) Graphics|Radeon Graphics|Vega \d\b/i.test(text) ? 'integrated' : 'unknown')
    : 'unknown';
  return { graphics, vendor: kind === 'software' ? 'other' : kind, totalmem, cores };
}

/** Anonymous session summaries, problems and file failures: checked, queued on disk and uploaded. */
class StatsService {
  constructor({ directory, instanceDirectory = directory, schemaPath, version, channel, siteUrl = '', platform = process.platform, arch = process.arch,
    env = process.env, machine = {}, fetchImpl = (...args) => fetch(...args), now = Date.now, randomHex = () => crypto.randomBytes(16).toString('hex'),
    randomPercent = () => crypto.randomInt(100),
    timers = true, quitWaitMs = 2000, onState = () => {}, openStore = (folder, options) => new WorkspacePreferences(folder, options), localDay = localDayOf, localWeekday = time => new Date(time).getDay(),
    localHour = time => new Date(time).getHours() }) {
    this.directory = directory;
    this.settingsStore = openStore(directory, { filename: 'stats-state.json', maxBytes: 128 * 1024 });
    this.sessionStore = openStore(instanceDirectory, { filename: 'stats-session.json', maxBytes: 4 * 1024 * 1024 });
    Object.assign(this, { schemaPath, version, channel, platform, arch, machine, fetch: fetchImpl, now, randomHex, randomPercent, timers, quitWaitMs, onState, localDay, localWeekday, localHour });
    this.siteUrl = statsEndpoint(siteUrl, channel === 'development');
    this.forcedOff = env?.STYK_NO_STATS === '1';
    this.facts = { backend: 'unknown', refresh: 'unknown' };
    this.settings = { v: 1, enabled: true, noticeSeen: false, noticeShown: false, firstDay: null, days: [], backSeen: false, sample: 100, pausedUntil: 0, lastSent: null };
    this.running = null; this.queue = []; this.sent = {};
    this.nextUpload = 0; this.inflight = null; this.closed = false; this.timer = null; this.startTimer = null;
  }

  /** Loads both files, migrates the old consent, ends a session left open and starts this one. */
  async init() {
    this.schema = await import(pathToFileURL(this.schemaPath).href);
    const loaded = await this.settingsStore.get().catch(() => ({}));
    const old = path.join(this.directory, 'telemetry-state.json');
    if (Object.keys(loaded).length) this.readSettings(loaded);
    else if (!this.forcedOff) await this.migrate(old);
    if (this.forcedOff) return this; // Reads nothing it would change, writes nothing.
    await fs.rm(old, { force: true }).catch(() => {});
    if (this.settings.enabled) {
      this.readSession(await this.sessionStore.get().catch(() => ({})));
      if (this.running?.open) this.endSession('unknown');
      this.startSession();
      this.schedule();
    }
    await this.persist();
    return this;
  }
  readSettings(value) {
    const s = this.settings;
    if (typeof value.enabled === 'boolean') s.enabled = value.enabled;
    s.noticeSeen = value.noticeSeen === true; s.noticeShown = value.noticeShown === true; s.backSeen = value.backSeen === true;
    if (validDay(value.firstDay)) s.firstDay = value.firstDay;
    if (Array.isArray(value.days)) s.days = [...new Set(value.days.filter(validDay))].sort().slice(-MAX_DAYS_KEPT);
    if (this.schema.SAMPLE_STEPS.includes(value.sample)) s.sample = value.sample;
    if (Number.isFinite(value.pausedUntil)) s.pausedUntil = value.pausedUntil;
    if (plain(value.lastSent)) s.lastSent = value.lastSent;
  }
  /** A person who chose Reject in the old consent window starts with statistics off and is not shown the line again. */
  async migrate(file) {
    let old;
    try { old = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return; }
    const rejected = old?.decided === true && old.consent?.analytics === false && old.consent?.diagnostics === false;
    this.settings.enabled = !rejected; this.settings.noticeSeen = rejected;
    const first = old?.milestones?.first_launch;
    if (validDay(first) && first <= this.localDay(this.now())) this.settings.firstDay = first;
  }
  readSession(value) {
    const r = value.running;
    if (plain(r) && SESSION_ID.test(r.sid ?? '') && validDay(r.day)) {
      this.running = { sid: r.sid, startedAt: Number(r.startedAt) || 0, day: r.day, sample: this.schema.SAMPLE_STEPS.includes(r.sample) ? r.sample : 100, first: r.first, age: r.age, when: r.when,
        summary: plain(r.summary) ? r.summary : null, unsaved: typeof r.unsaved === 'boolean' ? r.unsaved : null, open: r.open === true, frozen: Number(r.frozen) || 0 };
    }
    for (const report of Array.isArray(value.queue) ? value.queue : []) { try { this.queue.push(this.schema.validateReport(report)); } catch { /* A damaged entry is dropped. */ } }
    if (plain(value.sent)) for (const [key, n] of Object.entries(value.sent)) if (Number.isSafeInteger(n) && n > 0) this.sent[key] = n;
  }

  /**
   * The `first` facts, the install's age and the time of day, worked out on this computer at the session's start, and
   * whether this session is one of the share the intake asked for (docs/STATISTICS.md, "How much is sent"). A session
   * that is not chosen has no `running`: nothing is recorded or sent for it, but its day counts for the facts.
   */
  startSession() {
    const time = this.now(), today = this.localDay(time), s = this.settings;
    const ever = !s.firstDay;
    if (ever) s.firstDay = today;
    const since = Math.max(0, dayNumber(today) - dayNumber(s.firstDay));
    const back = !s.backSeen && since >= 7 && since <= 13;
    if (back) s.backSeen = true;
    const first = { ever, day: !s.days.includes(today), week: !s.days.some(day => weekOf(day) === weekOf(today)), back };
    s.days = [...new Set([...s.days, today])].sort().slice(-MAX_DAYS_KEPT);
    if (this.randomPercent() >= s.sample) { this.running = null; this.sent = {}; return; }
    this.running = { sid: this.randomHex(), startedAt: time, day: utcDay(time), sample: s.sample, first, age: this.schema.installAgeOf(since),
      when: { weekday: this.localWeekday(time), part: this.schema.dayPartOf(this.localHour(time)) }, summary: null, unsaved: null, open: true, frozen: 0 };
    // Counts uploaded for problems of sessions that are over are no longer needed.
    for (const key of Object.keys(this.sent)) if (!key.startsWith(`["${this.running.sid}"`)) delete this.sent[key];
  }
  /** Queues the running session's last summary with how it ended. */
  endSession(end) {
    const r = this.running;
    this.running = null;
    if (!r?.summary) return;
    const report = { ...r.summary, kind: 'session', sid: r.sid, day: r.day, sample: r.sample, end, first: r.first, age: r.age, when: r.when };
    if (end !== 'clean' && typeof r.unsaved === 'boolean') report.unsaved = r.unsaved;
    try { this.enqueue(this.schema.validateReport(report)); } catch { /* A summary that no longer passes is not sent. */ }
  }
  enqueue(report) { this.queue.push(report); this.prune(); }
  prune() {
    const oldest = utcDay(this.now() - MAX_AGE_DAYS * DAY_MS);
    this.queue = this.queue.filter(report => report.day >= oldest).slice(-MAX_QUEUE);
  }
  get active() { return this.settings.enabled && !this.forcedOff && !this.closed && Boolean(this.schema); }

  /** `{enabled, counting, forcedOff, noticeSeen, uploads}` for the bridge: `counting` is false in a session that was not chosen. */
  getState() {
    const enabled = this.settings.enabled && !this.forcedOff;
    return { enabled, counting: enabled && !this.closed && Boolean(this.running), forcedOff: this.forcedOff, noticeSeen: this.settings.noticeSeen, uploads: enabled && Boolean(this.siteUrl) };
  }
  notify() { this.onState(this.getState()); }
  /**
   * Turns statistics on (a fresh session) or off (what was waiting is deleted). The switch is a person's own answer,
   * so it also answers the first-start line.
   */
  async setEnabled(on) {
    if (typeof on !== 'boolean') throw new TypeError('Statistics are turned on or off with true or false.');
    if (this.forcedOff || on === this.settings.enabled && this.settings.noticeSeen) return this.getState();
    this.settings.noticeSeen = true;
    if (on !== this.settings.enabled) {
      this.settings.enabled = on;
      if (on) { this.startSession(); this.schedule(); }
      else { this.dispose(); this.running = null; this.queue = []; this.sent = {}; }
    }
    await this.persist(); this.notify(); return this.getState();
  }
  /** Records that the first-start line was answered ("OK" or "Turn off"): Home no longer shows it. */
  async markNoticeSeen() {
    if (!this.forcedOff && !this.settings.noticeSeen) { this.settings.noticeSeen = true; await this.persist(); this.notify(); }
    return this.getState();
  }
  /** Records that Home displayed the first-start line: from now on uploads may go (docs/STATISTICS.md, "On and off"). */
  async markNoticeShown() {
    if (!this.forcedOff && !this.settings.noticeShown) { this.settings.noticeShown = true; await this.persist(); }
    return this.getState();
  }
  /** Nothing leaves the computer before the first-start line was displayed or answered on this installation. */
  get announced() { return this.settings.noticeShown || this.settings.noticeSeen; }
  /** What only the page knows of the machine: the graphics backend and the display's refresh rate. */
  setFacts(facts) {
    if (!plain(facts) || !this.schema) return;
    if (this.schema.BACKENDS.includes(facts.backend)) this.facts.backend = facts.backend;
    if (facts.refresh === 'unknown' || this.schema.REFRESH_STEPS.map(String).includes(facts.refresh)) this.facts.refresh = facts.refresh;
  }
  /** The running session's summary so far; false when it does not pass the schema (the previous one is kept). */
  recordSession(summary, facts) {
    if (!this.active || !this.running || !plain(summary) || OWNED.some(key => Object.hasOwn(summary, key))) return false;
    if (facts) this.setFacts(facts);
    const { unsaved, ...rest } = summary;
    const r = this.running;
    let clean;
    try { clean = this.schema.validateReport({ ...rest, kind: 'session', sid: r.sid, day: r.day, sample: r.sample, end: 'clean', first: r.first, age: r.age, when: r.when }); }
    catch { return false; }
    // The checked copy is what is kept: nothing the schema does not describe, not even an undefined field, reaches the disk.
    const { kind, sid, day, sample, end, first, age, when, ...kept } = clean;
    r.summary = kept;
    if (typeof unsaved === 'boolean') r.unsaved = unsaved;
    void this.persist().catch(() => {});
    return true;
  }
  /** One `problem` or `file` report from the editor (without sid, day and sample); false when refused. */
  recordReport(report) {
    if (!this.active || !this.running || !plain(report) || !['problem', 'file'].includes(report.kind) || 'sid' in report || 'day' in report || 'sample' in report) return false;
    let clean;
    try { clean = this.schema.validateReport({ ...report, sid: this.running.sid, day: utcDay(this.now()), sample: this.running.sample }); } catch { return false; }
    if (clean.kind === 'problem') this.addProblem(clean);
    else this.enqueue(clean);
    void this.persist().catch(() => {});
    return true;
  }
  signature(p) { return JSON.stringify([p.sid, p.type, p.key ?? '', p.message, p.stack]); }
  /**
   * A problem is sent once a session. While its report waits, a repeat raises its count and a recovery is noted on
   * it; once it was uploaded, later repeats are not sent again.
   */
  addProblem(problem) {
    const key = this.signature(problem);
    if (this.sent[key]) return;
    const queued = this.queue.find(item => item.kind === 'problem' && this.signature(item) === key);
    if (!queued) { this.enqueue(problem); return; }
    if (problem.times > queued.times) queued.times = problem.times;
    if (typeof problem.recovered === 'boolean') queued.recovered = problem.recovered;
  }
  problemOf(type, message) {
    return { kind: 'problem', sid: this.running.sid, day: utcDay(this.now()), sample: this.running.sample, type, message: this.schema.sanitizeMessage(message), stack: [], doing: 'unknown', trail: [] };
  }
  /** The main process's latest knowledge of unsaved work, sent with a session that ends badly. */
  noteUnsaved(dirty) { if (this.active && this.running && typeof dirty === 'boolean') this.running.unsaved = dirty; }
  /** The window's process was lost: a problem, the session ends `crashed`, and a reopened page starts a new one. */
  windowGone(reason) {
    if (!this.active || !this.running) return;
    this.addProblem({ ...this.problemOf('window-gone', /^[a-z-]{1,24}$/.test(reason) ? reason : 'unknown'), times: 1 });
    this.endSession('crashed');
    this.startSession();
    void this.persist().catch(() => {});
  }
  /** The window stopped responding (a freeze); counted per session. */
  unresponsive() {
    if (!this.active || !this.running) return;
    this.addProblem({ ...this.problemOf('frozen', 'The window stopped responding'), times: ++this.running.frozen });
    void this.persist().catch(() => {});
  }
  /** The last batch uploaded, and what is waiting (the running session as it would be sent). */
  preview() {
    const r = this.running, waiting = [...this.queue];
    if (this.active && r?.summary) waiting.push({ ...r.summary, kind: 'session', sid: r.sid, day: r.day, sample: r.sample, end: 'clean', first: r.first, age: r.age, when: r.when });
    return { lastSent: this.settings.lastSent, waiting };
  }

  baseBatch() {
    const s = this.schema, word = (list, value) => list.includes(value) ? value : 'unknown';
    return { v: s.STATS_VERSION, app: { version: this.version, channel: this.channel, platform: word(s.PLATFORMS, this.platform), arch: word(s.ARCHS, this.arch) },
      machine: { graphics: word(s.GRAPHICS, this.machine.graphics), vendor: word(s.VENDORS, this.machine.vendor), backend: this.facts.backend,
        memory: s.memoryOf(this.machine.totalmem), cores: s.coresOf(this.machine.cores), refresh: this.facts.refresh } };
  }
  /** The oldest reports that fit one batch; a report the intake would refuse on its own is dropped. */
  nextBatch(base, today) {
    const refusedAlone = report => { try { this.schema.validateBatch({ ...base, reports: [report] }, { today }); return false; } catch { return true; } };
    this.queue = this.queue.filter(report => !refusedAlone(report));
    for (let n = Math.min(this.schema.MAX_REPORTS, this.queue.length); n > 0; n--) {
      const items = this.queue.slice(0, n);
      try { return { items, batch: this.schema.validateBatch({ ...base, reports: items }, { today }) }; } catch { /* Too large: one fewer. */ }
    }
    return null;
  }
  /** Uploads what is waiting (never the running session); true when something was delivered. */
  upload({ quitting = false } = {}) {
    if (this.inflight) return this.inflight.then(() => false);
    this.inflight = this.send(quitting).finally(() => { this.inflight = null; });
    return this.inflight;
  }
  async send(quitting) {
    if (this.forcedOff || !this.settings.enabled || !this.announced || !this.siteUrl || !this.schema || !VERSION.test(this.version ?? '')) return false;
    const time = this.now();
    if (time < this.nextUpload || time < this.settings.pausedUntil) return false;
    let delivered = false;
    for (let round = 0; round < MAX_BATCHES && this.queue.length; round++) {
      const base = this.baseBatch(), next = this.nextBatch(base, utcDay(time));
      if (!next) break;
      let response;
      try {
        response = await this.fetch(`${this.siteUrl}/api/v1/stats`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next.batch), redirect: 'error', signal: AbortSignal.timeout(quitting ? 2000 : 10000) });
      } catch { this.nextUpload = this.now() + RETRY_MS; break; }
      if (!this.settings.enabled) return delivered; // Turned off while the batch was on its way: nothing is kept.
      const status = response.status;
      const answer = status === 200 ? await response.json().catch(() => null) : null;
      if (answer?.ok === true) {
        // The share of sessions the intake wants, for the sessions that start from now on.
        if (this.schema.SAMPLE_STEPS.includes(answer.sample)) this.settings.sample = answer.sample;
        this.delivered(next); delivered = true; await this.persist(); continue;
      }
      if ([400, 413, 422].includes(status)) { this.drop(next.items); await this.persist(); continue; }
      if (status === 410) { this.drop(next.items); this.settings.pausedUntil = this.now() + DAY_MS; await this.persist(); break; }
      const seconds = Number(response.headers?.get?.('Retry-After'));
      // 429 and 5xx: the intake cannot take it now. Anything else unexpected is retried later too, never dropped.
      this.nextUpload = this.now() + ((status === 429 || status >= 500) && Number.isFinite(seconds) && seconds > 0 ? Math.min(DAY_MS, seconds * 1000) : RETRY_MS);
      break;
    }
    return delivered;
  }
  drop(items) { const sent = new Set(items); this.queue = this.queue.filter(item => !sent.has(item)); }
  /** What was uploaded leaves the queue; an uploaded problem is remembered so the session does not send it twice. */
  delivered({ items, batch }) {
    for (const copy of batch.reports) if (copy.kind === 'problem') this.sent[this.signature(copy)] = copy.times;
    this.drop(items);
    this.settings.lastSent = batch;
  }

  schedule() {
    if (!this.timers || this.timer) return;
    this.startTimer = setTimeout(() => { void this.upload().catch(() => {}); }, START_DELAY_MS); this.startTimer.unref?.();
    this.timer = setInterval(() => { if (this.queue.length) void this.upload().catch(() => {}); }, RETRY_MS); this.timer.unref?.();
  }
  /** Writes both files. Calls during a write are folded into one more write of the latest state. */
  persist() {
    if (this.forcedOff || !this.schema) return Promise.resolve();
    this.dirty = true;
    this.writing ??= (async () => {
      try {
        while (this.dirty) {
          this.dirty = false;
          const settings = JSON.stringify(this.settings);
          const session = this.settings.enabled ? { running: this.running, queue: this.queue, sent: this.sent } : {};
          await Promise.all([settings === this.settingsWritten ? null : this.settingsStore.set(this.settings), this.sessionStore.set(session)]);
          this.settingsWritten = settings;
        }
      } finally { this.writing = null; }
    })();
    return this.writing;
  }
  /** Resolves once nothing is being written. */
  settled() { return (this.writing ?? Promise.resolve()).catch(() => {}); }
  /** An orderly quit: the session ends `clean` and what waits is sent, waiting at most two seconds. */
  close() {
    this.closing ??= (async () => {
      this.dispose();
      if (this.forcedOff || !this.schema || !this.settings.enabled) { this.closed = true; return; }
      this.endSession('clean');
      this.closed = true;
      await this.persist().catch(() => {});
      let timer;
      const limit = new Promise(resolve => { timer = setTimeout(resolve, this.quitWaitMs); timer.unref?.(); });
      await Promise.race([this.upload({ quitting: true }).catch(() => false), limit]);
      clearTimeout(timer);
    })();
    return this.closing;
  }
  /** Stops the timers. */
  dispose() { clearTimeout(this.startTimer); clearInterval(this.timer); this.startTimer = null; this.timer = null; }
}

module.exports = { StatsService, machineFacts, statsEndpoint };
