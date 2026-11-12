/**
 * The running session's summary (docs/STATISTICS.md, "What is sent", `session`): time in use and open, timeline mode time,
 * features touched, how far the session got, whole-number counts, the most used commands, the largest project and file
 * operations per format. The desktop process adds the session's id, day, ending and the installation's `first` facts.
 */
import {COUNTS, FEATURES, REACHED, FILE_OPS, FORMATS, figureCountOf, frameCountOf, frameRateOf, sceneOf} from './schema.mjs';

/** Features a command touches, by its id in the command registry (src/ui/command-catalog.mjs). */
const COMMAND_FEATURES = [
  [/^toggle-onion$/, 'onion'], [/^(add-to-library|library-|panel-toggle-library$)/, 'library'], [/^(camera-|toggle-camera$)/, 'camera'],
  [/^panel-toggle-vfx$/, 'effects'], [/^drawing-/, 'drawing'], [/^movieclip-/, 'movieclips'], [/^toggle-audio$/, 'sound'],
  [/^(builder-|rig-|tool-(line|circle|polygon|rig)$|edit-in-build-mode$|chain-|split-segment$|add-sprite-segment$)/, 'builder'],
  [/^toggle-motion-paths$/, 'motion-paths'], [/^(import-background|background-style)$/, 'backgrounds'], [/^import-sprite$/, 'pictures'],
  [/^timeline-layer-/, 'layers'], [/^tutorials?$|^tutorial-/, 'tutorials'], [/^command-palette$/, 'palette'], [/^(add|edit)-text$/, 'text'],
];
/** Commands that count, by id. */
const COMMAND_COUNTS = {undo: 'undos', redo: 'redos', 'add-frame': 'keyframes', 'extend-keyframe': 'keyframes', 'insert-blank-key': 'keyframes', 'insert-copied-key': 'keyframes'};
const TRAIL = 20, TOP_COMMANDS = 24, MAX_FILE_ROWS = 16;

export class SessionSummary {
  /** `commandIds`: the ids of the command registry; another name is never counted. */
  constructor({commandIds = new Set()} = {}) {
    this.commandIds = commandIds;
    this.inUse = 0; this.open = 0; this.modes = {simple: 0, advanced: 0};
    this.features = new Set(); this.reached = new Set(); this.counts = Object.create(null); this.commands = new Map(); this.trail = [];
    this.project = null; this.files = new Map(); this.recovery = null;
  }

  /** Seconds the window was open, and in use (in front, with input in the last minute or playing) in timeline `mode`. */
  time(seconds, inUse, mode) {
    this.open += seconds;
    if (!inUse) return;
    this.inUse += seconds;
    if (mode === 'simple' || mode === 'advanced') this.modes[mode] += seconds;
  }

  count(name, n = 1) { if (Object.hasOwn(COUNTS, name) && n > 0) this.counts[name] = Math.min(COUNTS[name], (this.counts[name] ?? 0) + Math.round(n)); }
  feature(name) { if (FEATURES.includes(name)) this.features.add(name); }
  reach(name) { if (REACHED.includes(name)) this.reached.add(name); }

  /** A command of the registry ran: its count, the features it touches, and the trail a problem carries. */
  command(id) {
    if (!this.commandIds.has(id)) return;
    this.commands.set(id, (this.commands.get(id) ?? 0) + 1);
    this.count('commands');
    if (COMMAND_COUNTS[id]) this.count(COMMAND_COUNTS[id]);
    for (const [pattern, feature] of COMMAND_FEATURES) if (pattern.test(id)) this.feature(feature);
    this.trail.push(id);
    if (this.trail.length > TRAIL) this.trail.shift();
  }

  /** The project on show: kept when it is the largest of the session (by scene size, then figures). */
  sawProject({segments, figures, frames, fps} = {}) {
    const size = [Number.isFinite(segments) ? segments : -1, Number.isFinite(figures) ? figures : -1];
    if (size[0] < 0 && size[1] < 0) return;
    if (this.project && (this.project.size[0] > size[0] || this.project.size[0] === size[0] && this.project.size[1] >= size[1])) return;
    this.project = {size, scene: sceneOf(segments), figures: figureCountOf(figures), frames: frameCountOf(frames), rate: frameRateOf(fps)};
  }

  /** One file operation: `outcome` is ok, failed or cancelled; `made` the program and format version that wrote an opened file. */
  file(op, format, outcome, ms = 0, made) {
    if (!FILE_OPS.includes(op) || !['ok', 'failed', 'cancelled'].includes(outcome)) return;
    const word = FORMATS.includes(format) ? format : 'unknown', key = `${op} ${word} ${made ?? ''}`;
    let row = this.files.get(key);
    if (!row) {
      if (this.files.size >= MAX_FILE_ROWS) return;
      this.files.set(key, row = {op, format: word, ...(made ? {made} : {}), ok: 0, failed: 0, cancelled: 0, ms: 0});
    }
    row[outcome] = Math.min(1e5, row[outcome] + 1);
    if (outcome === 'ok' && Number.isFinite(ms) && ms > 0) row.ms = Math.min(8.64e7, row.ms + ms);
    const counted = {open: 'opens', save: 'saves', export: 'exports'}[op];
    if (counted && outcome === 'ok') this.count(counted);
    if (outcome === 'ok' && (op === 'save' || op === 'export')) this.reach(op);
  }

  /** At this start, unsaved work from a session that ended badly was offered; then whether it came back. */
  recover(event) {
    if (event === 'offered') this.recovery ??= {offered: true, restored: false, failed: false};
    else if (this.recovery && (event === 'restored' || event === 'failed')) this.recovery[event] = true;
  }

  /** The summary the desktop process completes (`frames` adds the responsiveness numbers, `language` and `unsaved` the rest). */
  build({language = 'en', unsaved, frames} = {}) {
    const minutes = seconds => Math.min(2880, Math.round(seconds / 60));
    const top = [...this.commands].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, TOP_COMMANDS);
    const project = this.project && Object.fromEntries(Object.entries({scene: this.project.scene, figures: this.project.figures,
      frames: this.project.frames, rate: this.project.rate}).filter(([, value]) => value != null));
    return {
      minutes: minutes(this.inUse), open: minutes(this.open), language,
      mode: {simple: minutes(this.modes.simple), advanced: minutes(this.modes.advanced)},
      features: FEATURES.filter(name => this.features.has(name)), reached: REACHED.filter(name => this.reached.has(name)),
      counts: {...this.counts},
      ...(top.length ? {commands: Object.fromEntries(top.map(([id, n]) => [id, Math.min(1e6, n)]))} : {}),
      ...(project?.scene ? {project} : {}),
      ...(this.files.size ? {files: [...this.files.values()].map(row => ({...row, ms: Math.round(row.ms * 10) / 10}))} : {}),
      ...(this.recovery ? {recovery: {...this.recovery}} : {}),
      ...(typeof unsaved === 'boolean' ? {unsaved} : {}),
      ...frames,
    };
  }
}
