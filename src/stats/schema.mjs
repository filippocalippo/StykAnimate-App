/**
 * What a StykAnimate statistics report may contain (docs/STATISTICS.md).
 *
 * The app builds reports with this module, the desktop process checks them again before sending, and the site's intake
 * checks them a third time with its own copy of this file. A value that is not described here does not leave the
 * computer: every field is a number in a range, a word from a list, or text that matches a pattern, and an unknown
 * field is refused.
 *
 * Nothing here imports another module, so the site can copy the file as it is.
 */

export const STATS_VERSION = 1;
/** One upload: at most this many bytes of JSON and this many reports. */
export const MAX_BATCH_BYTES = 32 * 1024;
export const MAX_REPORTS = 16;

// ---------------------------------------------------------------------------------------------------- words

export const CHANNELS = Object.freeze(['stable', 'beta', 'internal', 'development']);
export const PLATFORMS = Object.freeze(['win32', 'linux', 'darwin', 'web']);
export const ARCHS = Object.freeze(['x64', 'arm64', 'ia32', 'unknown']);

/** The machine, in steps too wide to tell one computer from another. */
export const GRAPHICS = Object.freeze(['integrated', 'discrete', 'software', 'unknown']);
export const VENDORS = Object.freeze(['intel', 'amd', 'nvidia', 'apple', 'qualcomm', 'other', 'unknown']);
export const BACKENDS = Object.freeze(['webgpu', 'webgl2', 'none', 'unknown']);
export const MEMORY_STEPS = Object.freeze([4, 8, 16, 32, 64]);
export const CORE_STEPS = Object.freeze([2, 4, 8, 16, 32]);
export const REFRESH_STEPS = Object.freeze([60, 75, 90, 120, 144, 165, 240]);
/** The three machine classes the dashboard compares. */
export const MACHINE_CLASSES = Object.freeze(['integrated-small', 'integrated-large', 'discrete']);

/** What a person is doing while frames are counted. */
export const DOING = Object.freeze(['drag', 'play', 'scrub', 'view', 'draw']);
/** Scene size: the segments the engine drew for the frame on show. */
export const SCENES = Object.freeze(['under-1k', '1k-10k', '10k-50k', '50k-200k', 'over-200k']);
/** Where a frame's time went. docs/STATISTICS.md says which span each one is. */
export const STAGES = Object.freeze(['edit', 'evaluate', 'geometry', 'draw', 'overlay', 'interface', 'wait', 'other']);
/** Upper bounds, in milliseconds, of the frame-time histogram. A last, open step holds everything slower. */
export const FRAME_BOUNDS = Object.freeze([4, 8, 12, 17, 21, 25, 33, 42, 50, 67, 83, 100, 150, 250, 500, 1000]);
/** A frame is late when it took longer than this many display refreshes. */
export const LATE_FACTOR = 1.5;

export const FEATURES = Object.freeze(['onion', 'library', 'camera', 'effects', 'drawing', 'ik', 'movieclips', 'sound',
  'builder', 'motion-paths', 'backgrounds', 'pictures', 'layers', 'tutorials', 'palette']);
export const REACHED = Object.freeze(['edit', 'play', 'save', 'export']);
export const ENDINGS = Object.freeze(['clean', 'crashed', 'unknown']);
export const INSTALL_AGES = Object.freeze(['day', 'week', 'month', 'half-year', 'older']);
export const DAY_PARTS = Object.freeze(['morning', 'afternoon', 'evening', 'night']);

export const FILE_OPS = Object.freeze(['open', 'save', 'autosave', 'export', 'recover']);
export const FORMATS = Object.freeze(['styk', 'pivot-animation', 'pivot-figure', 'sticknodes', 'sticknodes-figure', 'picture',
  'gif', 'video', 'picture-sequence', 'svg', 'sound', 'unknown']);
export const FILE_SIZES = Object.freeze(['under-1mb', '1-10mb', '10-50mb', 'over-50mb', 'unknown']);
export const FILE_STAGES = Object.freeze(['read', 'decode', 'prepare', 'serialize', 'encode', 'write', 'replace', 'unknown']);
export const FILE_REASONS = Object.freeze(['disk-full', 'no-permission', 'file-in-use', 'path-gone', 'too-large', 'not-this-format',
  'unsupported-version', 'unsupported-feature', 'damaged', 'out-of-memory', 'timeout', 'graphics-lost', 'worker-stopped',
  'engine', 'unknown']);
/** Whether the file that was on disk before a failed save is still as it was. */
export const KEPT = Object.freeze(['untouched', 'unknown']);

export const PROBLEM_TYPES = Object.freeze(['error', 'engine', 'frozen', 'graphics-lost', 'window-gone', 'worker-stopped']);
/** What the app was doing when a problem happened. */
export const ACTIVITIES = Object.freeze(['starting', 'idle', 'editing', 'dragging', 'playing', 'scrubbing', 'drawing', 'opening',
  'saving', 'exporting', 'recovering', 'closing', 'unknown']);

export const FIGURE_COUNTS = Object.freeze(['1', '2-5', '6-20', '21-100', 'over-100']);
export const FRAME_COUNTS = Object.freeze(['under-50', '50-200', '200-1k', '1k-5k', 'over-5k']);
export const FRAME_RATES = Object.freeze(['under-12', '12-15', '16-24', '25-30', 'over-30']);

/** Whole numbers a session counts. Each is capped so one odd session cannot bend a total. */
export const COUNTS = Object.freeze({ edits: 1e6, undos: 1e6, redos: 1e6, frames: 1e6, plays: 1e5, playSeconds: 86400, opens: 1e4,
  saves: 1e5, exports: 1e4, commands: 1e6, graphicsLost: 1e3, graphicsBack: 1e3, problems: 1e4 });

// ---------------------------------------------------------------------------------------------------- steps

const step = (steps, value) => { for (const s of steps) if (value <= s) return s; return steps.at(-1); };
const nearest = (steps, value) => steps.reduce((best, s) => Math.abs(s - value) < Math.abs(best - value) ? s : best);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export const sceneOf = segments => !finite(segments) ? null : segments < 1e3 ? 'under-1k' : segments < 1e4 ? '1k-10k'
  : segments < 5e4 ? '10k-50k' : segments < 2e5 ? '50k-200k' : 'over-200k';
export const fileSizeOf = bytes => !finite(bytes) ? 'unknown' : bytes < 1048576 ? 'under-1mb' : bytes < 10 * 1048576 ? '1-10mb'
  : bytes < 50 * 1048576 ? '10-50mb' : 'over-50mb';
export const figureCountOf = n => !finite(n) || n < 1 ? null : n < 2 ? '1' : n <= 5 ? '2-5' : n <= 20 ? '6-20' : n <= 100 ? '21-100' : 'over-100';
export const frameCountOf = n => !finite(n) ? null : n < 50 ? 'under-50' : n <= 200 ? '50-200' : n <= 1000 ? '200-1k' : n <= 5000 ? '1k-5k' : 'over-5k';
export const frameRateOf = fps => !finite(fps) || fps <= 0 ? null : fps < 12 ? 'under-12' : fps <= 15 ? '12-15' : fps <= 24 ? '16-24'
  : fps <= 30 ? '25-30' : 'over-30';
/** Memory in gigabytes, rounded up to a step (a 15.8 GB machine reports 16). */
export const memoryOf = bytes => finite(bytes) && bytes > 0 ? String(step(MEMORY_STEPS, Math.round(bytes / 1073741824))) : 'unknown';
export const coresOf = n => finite(n) && n > 0 ? String(step(CORE_STEPS, n)) : 'unknown';
/** The display's refresh rate as its nearest common value. */
export const refreshOf = hz => finite(hz) && hz >= 20 && hz <= 480 ? String(nearest(REFRESH_STEPS, hz)) : 'unknown';
export const dayPartOf = hour => hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 18 ? 'afternoon' : hour >= 18 && hour < 23 ? 'evening' : 'night';
export const installAgeOf = days => !finite(days) || days < 1 ? 'day' : days < 7 ? 'week' : days < 30 ? 'month' : days < 183 ? 'half-year' : 'older';

/** The class the dashboard files a machine under: a separate graphics card, or integrated graphics with little or much memory. */
export function machineClassOf(machine) {
  if (machine?.graphics === 'discrete') return 'discrete';
  return Number(machine?.memory) >= 16 ? 'integrated-large' : 'integrated-small';
}

// ---------------------------------------------------------------------------------------------------- frames

/** Whether a frame that took `ms` is late on a display that refreshes every `refreshMs`. */
export const isLate = (ms, refreshMs) => ms > refreshMs * LATE_FACTOR;
/** A frame-time histogram with nothing in it: one count per step of FRAME_BOUNDS and one for everything slower. */
export const emptyFrameTimes = () => new Array(FRAME_BOUNDS.length + 1).fill(0);
/** The step of the frame-time histogram a frame of `ms` belongs to. */
export function frameStep(ms) {
  for (let i = 0; i < FRAME_BOUNDS.length; i++) if (ms <= FRAME_BOUNDS[i]) return i;
  return FRAME_BOUNDS.length;
}
/**
 * The frame time below which the share `q` (0 to 1) of frames fell, read from a histogram: the upper bound of the step
 * that holds it, and `worst` for the open last step. Null for an empty histogram.
 */
export function frameQuantile(times, q, worst = null) {
  const total = times.reduce((sum, n) => sum + n, 0);
  if (!total) return null;
  const target = Math.max(1, Math.ceil(total * q));
  for (let i = 0, seen = 0; i < times.length; i++) {
    seen += times[i];
    if (seen >= target) return i < FRAME_BOUNDS.length ? (worst === null ? FRAME_BOUNDS[i] : Math.min(FRAME_BOUNDS[i], worst)) : worst ?? FRAME_BOUNDS.at(-1);
  }
  return worst;
}

// ---------------------------------------------------------------------------------------------------- text

/**
 * Error text made safe to send. Our own code writes the messages, but an operating system error can name a path and a
 * message can quote a name from a project, so: anything in quotes, any path, address or e-mail address becomes "…".
 * Numbers stay (a length, an index and a line are what make a message useful).
 */
export function sanitizeMessage(value) {
  let text = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ');
  text = text.replace(/"[^"]{0,400}"|`[^`]{0,400}`|[“”][^“”]{0,400}[“”]/g, '…');
  // A pair of single quotes around a word or phrase, not the apostrophe of "can't".
  text = text.replace(/(^|[\s(=:\[,])'[^']{0,400}'(?=$|[\s)\].,;:])/g, '$1…');
  text = text.replace(/\b[a-z][a-z0-9+.-]{1,15}:\/\/\S+/gi, '…');
  text = text.replace(/\b(?:blob|data|mailto):\S+/gi, '…');
  text = text.replace(/\b[A-Za-z]:[\\/][^\s*?"<>|]*/g, '…');
  text = text.replace(/\\\\[^\s]+/g, '…');
  text = text.replace(/(^|[\s(=:\[,])~?\/(?:[^\s/]+\/)+[^\s)\]]*/g, '$1…');
  text = text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '…');
  return text.replace(/\s+/g, ' ').replace(/(?:… ?){2,}/g, '… ').trim().slice(0, 240);
}

const FRAME_FUNCTION = /^[\w$.<>:#~-]{1,96}$/;
const FRAME_PLACE = /^[\w.-]{1,64}(?:\/[\w.-]{1,64}){0,3}:\d{1,7}$/;
/**
 * One line of a stack, or null when it is not ours to send: "function file:line", "file:line" or "function". The file
 * is a path inside this repository (never an absolute path), with at most three folders.
 */
export function stackFrame(fn, place) {
  const name = typeof fn === 'string' && FRAME_FUNCTION.test(fn) ? fn : '';
  const where = typeof place === 'string' && FRAME_PLACE.test(place) ? place : '';
  return name && where ? `${name} ${where}` : where || name || null;
}
const validFrame = text => {
  if (typeof text !== 'string' || text.length > 180) return false;
  const at = text.indexOf(' ');
  return at < 0 ? FRAME_FUNCTION.test(text) || FRAME_PLACE.test(text) : FRAME_FUNCTION.test(text.slice(0, at)) && FRAME_PLACE.test(text.slice(at + 1));
};

// ---------------------------------------------------------------------------------------------------- checks

/** A report that this module refuses. `field` names the first value that is not allowed. */
export class StatsError extends Error {
  constructor(field) { super(`statistics report refused at ${field}`); this.name = 'StatsError'; this.field = field; }
}
const refuse = field => { throw new StatsError(field); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const whole = max => (v, at) => Number.isSafeInteger(v) && v >= 0 && v <= max ? v : refuse(at);
/** Milliseconds: kept to one decimal. */
const millis = max => (v, at) => finite(v) && v <= max ? Math.round(v * 10) / 10 : refuse(at);
const word = words => (v, at) => typeof v === 'string' && words.includes(v) ? v : refuse(at);
const flag = (v, at) => typeof v === 'boolean' ? v : refuse(at);
const match = (pattern, max) => (v, at) => typeof v === 'string' && v.length <= max && pattern.test(v) ? v : refuse(at);
const maybe = check => (v, at) => v === undefined ? undefined : check(v, at);
const listOf = (check, max, { distinct = false } = {}) => (v, at) => {
  if (!Array.isArray(v) || v.length > max) refuse(at);
  const out = v.map((item, i) => check(item, `${at}[${i}]`));
  if (distinct && new Set(out).size !== out.length) refuse(at);
  return out;
};
const record = fields => (v, at) => {
  if (!plain(v)) refuse(at);
  for (const key of Object.keys(v)) if (!Object.hasOwn(fields, key)) refuse(`${at}.${key}`);
  const out = {};
  for (const [key, check] of Object.entries(fields)) { const value = check(v[key], `${at}.${key}`); if (value !== undefined) out[key] = value; }
  return out;
};
const table = (key, check, max) => (v, at) => {
  if (!plain(v) || Object.keys(v).length > max) refuse(at);
  const out = {};
  for (const [name, value] of Object.entries(v)) { if (!key(name)) refuse(`${at}.${name}`); out[name] = check(value, `${at}.${name}`); }
  return out;
};

const SESSION_ID = /^[a-f0-9]{32}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z0-9.]{1,24})?$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const COMMAND = /^[a-z][a-z0-9:._-]{0,47}$/;
/** The program and format version that wrote a file: "pivot/5", "sticknodes/4.2", "stykanimate/12". */
const MADE_WITH = /^[a-z][a-z-]{0,23}\/[0-9a-z][0-9a-z.]{0,11}$/;
const MESSAGE_KEY = /^[A-Za-z][\w.]{0,119}$/;

const day = (v, at) => typeof v === 'string' && DAY.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v ? v : refuse(at);
const sessionId = match(SESSION_ID, 32);
const stages = table(name => STAGES.includes(name), millis(3.6e6), STAGES.length);
const frameTimes = (v, at) => Array.isArray(v) && v.length === FRAME_BOUNDS.length + 1 ? v.map((n, i) => whole(1e7)(n, `${at}[${i}]`)) : refuse(at);

const smoothCell = (v, at) => {
  const cell = record({ doing: word(DOING), scene: word(SCENES), frames: whole(1e7), late: whole(1e7), times: frameTimes,
    worst: millis(6e5), lateMs: millis(3.6e6), stages: maybe(stages) })(v, at);
  if (cell.late > cell.frames || cell.times.reduce((sum, n) => sum + n, 0) !== cell.frames) refuse(at);
  return cell;
};
const slowMoment = record({ ms: millis(6e5), doing: word(DOING), scene: word(SCENES), stages: maybe(stages) });
const fileCount = record({ op: word(FILE_OPS), format: word(FORMATS), made: maybe(match(MADE_WITH, 36)), ok: whole(1e5),
  failed: whole(1e5), cancelled: whole(1e5), ms: millis(8.64e7) });

const session = record({
  kind: word(['session']), sid: sessionId, day,
  /** Minutes in use (the window in front, with input in the last minute or an animation playing) and minutes open. */
  minutes: whole(2880), open: whole(2880),
  end: word(ENDINGS),
  /** Facts about this installation that the app works out itself, so that no two reports need to be joined. */
  first: record({ ever: flag, day: flag, week: flag, back: flag }),
  age: word(INSTALL_AGES),
  when: record({ weekday: whole(6), part: word(DAY_PARTS) }),
  language: match(LANGUAGE, 12),
  mode: record({ simple: whole(2880), advanced: whole(2880) }),
  features: listOf(word(FEATURES), FEATURES.length, { distinct: true }),
  reached: listOf(word(REACHED), REACHED.length, { distinct: true }),
  counts: record(Object.fromEntries(Object.entries(COUNTS).map(([name, max]) => [name, maybe(whole(max))]))),
  commands: maybe(table(name => COMMAND.test(name), whole(1e6), 24)),
  /** The largest project of the session. */
  project: maybe(record({ scene: word(SCENES), figures: maybe(word(FIGURE_COUNTS)), frames: maybe(word(FRAME_COUNTS)), rate: maybe(word(FRAME_RATES)) })),
  files: maybe(listOf(fileCount, 16)),
  /** At the start of this session: was unsaved work left by a session that ended badly, and did it come back. */
  recovery: maybe(record({ offered: flag, restored: flag, failed: flag })),
  /** For a session that did not end cleanly: whether it had unsaved changes when last seen. */
  unsaved: maybe(flag),
  smooth: maybe(listOf(smoothCell, DOING.length * SCENES.length)),
  slow: maybe(listOf(slowMoment, 5)),
});

const problem = record({
  kind: word(['problem']), sid: sessionId, day,
  type: word(PROBLEM_TYPES),
  message: match(/^[^\u0000-\u001f\u007f]*$/, 240),
  /** The message key, when the app raised the error itself. */
  key: maybe(match(MESSAGE_KEY, 120)),
  stack: listOf((v, at) => validFrame(v) ? v : refuse(at), 12),
  doing: word(ACTIVITIES),
  /** The names of the last commands run, oldest first. */
  trail: listOf(match(COMMAND, 48), 20),
  scene: maybe(word(SCENES)),
  features: maybe(listOf(word(FEATURES), FEATURES.length, { distinct: true })),
  recovered: maybe(flag),
  /** How many times this session hit the same problem. */
  times: whole(1e5),
});

const fileFailure = record({
  kind: word(['file']), sid: sessionId, day,
  op: word(FILE_OPS), format: word(FORMATS), made: maybe(match(MADE_WITH, 36)),
  size: word(FILE_SIZES), scene: maybe(word(SCENES)),
  stage: word(FILE_STAGES), reason: word(FILE_REASONS), key: maybe(match(MESSAGE_KEY, 120)),
  kept: maybe(word(KEPT)), ms: millis(8.64e7),
});

const REPORTS = { session, problem, file: fileFailure };
/** One report, checked: a clean copy, or a StatsError. */
export function validateReport(value, at = 'report') {
  const check = plain(value) && Object.hasOwn(REPORTS, value.kind) ? REPORTS[value.kind] : refuse(`${at}.kind`);
  const report = check(value, at);
  if (report.kind === 'problem' && report.message !== sanitizeMessage(report.message)) refuse(`${at}.message`);
  return report;
}

const batch = record({
  v: (v, at) => v === STATS_VERSION ? v : refuse(at),
  app: record({ version: match(VERSION, 40), channel: word(CHANNELS), platform: word(PLATFORMS), arch: word(ARCHS) }),
  machine: record({ graphics: word(GRAPHICS), vendor: word(VENDORS), backend: word(BACKENDS),
    memory: word([...MEMORY_STEPS.map(String), 'unknown']), cores: word([...CORE_STEPS.map(String), 'unknown']),
    refresh: word([...REFRESH_STEPS.map(String), 'unknown']) }),
  reports: (v, at) => Array.isArray(v) && v.length >= 1 && v.length <= MAX_REPORTS ? v.map((item, i) => validateReport(item, `${at}[${i}]`)) : refuse(at),
});
/**
 * One upload, checked: a clean copy with nothing but the fields above, or a StatsError. `today` (a UTC day) bounds the
 * days a report may carry: not in the future, and not older than `maxAgeDays`.
 */
export function validateBatch(value, { today = new Date().toISOString().slice(0, 10), maxAgeDays = 14 } = {}) {
  const clean = batch(value, 'batch');
  const oldest = new Date(Date.parse(`${today}T00:00:00Z`) - maxAgeDays * 86400000).toISOString().slice(0, 10);
  // A clock can be a day ahead of UTC's.
  const newest = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  clean.reports.forEach((report, i) => { if (report.day < oldest || report.day > newest) refuse(`batch.reports[${i}].day`); });
  if (JSON.stringify(clean).length > MAX_BATCH_BYTES) refuse('batch');
  return clean;
}
