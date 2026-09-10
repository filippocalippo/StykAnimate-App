// The same allowlist runs at the renderer, privileged desktop boundary, and Worker.
// No document content, filenames, paths, raw exception messages, or user text belongs here.
export const SCHEMA_VERSION = 1;
export const POLICY_VERSION = '2026-09-10';
export const MAX_SNAPSHOT_BYTES = 32768;
export const HISTOGRAM_BOUNDS = Object.freeze([1, 4, 8, 16, 33, 50, 100, 250, 500, 1000, 2500, 5000, 15000, 60000, 300000, 3600000]);
export const COUNTERS = Object.freeze([
  'sessions_started', 'sessions_closed', 'active_seconds', 'idle_seconds',
  'mode_simple_seconds', 'mode_advanced_seconds', 'edits',
  'new_project', 'open', 'save_started', 'save_succeeded', 'save_failed', 'save_cancelled',
  'import_started', 'import_succeeded', 'import_failed', 'import_cancelled',
  'import_native', 'import_pivot', 'import_sticknodes', 'import_media',
  'export_started', 'export_succeeded', 'export_failed', 'export_cancelled',
  'export_native', 'export_pivot', 'export_png', 'export_svg', 'export_gif', 'export_jpeg', 'export_video',
  'playback_started', 'playback_seconds', 'playback_frames', 'playback_buffering',
  'undo', 'redo', 'copy', 'paste', 'duplicate', 'delete', 'keyframe', 'inbetween',
  'onion', 'camera', 'ik', 'builder', 'library', 'movieclip', 'settings',
  'recovery_saved', 'recovery_restored', 'recovery_failed',
  'renderer_crashes', 'renderer_hangs', 'backend_errors', 'gpu_errors', 'unclean_starts',
  'long_tasks', 'slow_frames', 'dropped_samples',
]);
export const DIAGNOSTIC_COUNTERS = Object.freeze(COUNTERS.filter(key => /^(renderer_|backend_|gpu_|unclean_|long_tasks|slow_frames|dropped_samples)/.test(key)));
export const TIMINGS = Object.freeze(['startup_ms', 'import_ms', 'import_decode_ms', 'save_ms', 'export_ms', 'recovery_ms', 'frame_ms', 'input_latency_ms', 'long_task_ms', 'playback_interval_ms', 'playback_startup_ms', 'playback_buffering_ms']);
export const GAUGES = Object.freeze(['process_memory_mb', 'process_cpu_percent', 'js_heap_mb', 'gpu_memory_mb', 'draw_calls', 'scene_figures', 'scene_frames', 'scene_primitives', 'upload_kb']);
export const MILESTONES = Object.freeze(['first_launch', 'first_edit', 'first_save', 'first_export']);
export const ERROR_TYPES = Object.freeze(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AbortError', 'OperationError', 'NotSupportedError', 'GPUError', 'RendererCrash', 'RendererHang', 'BackendError', 'UncleanExit']);
export const ERROR_OPERATIONS = Object.freeze(['app', 'startup', 'import', 'save', 'export', 'playback', 'recovery', 'gpu', 'renderer', 'backend']);
export const ERROR_MODULES = Object.freeze(['app.mjs', 'renderer.mjs', 'renderer-geometry.mjs', 'render-artwork.mjs', 'editor.mjs', 'editor-load.mjs', 'import-client.mjs', 'import-worker.mjs', 'document-export.mjs', 'document-export-worker.mjs', 'playback.mjs', 'playback-worker.mjs', 'export-frame-renderer.mjs', 'native-video.mjs', 'main.cjs', 'backend.cjs', 'file-streams.cjs', 'video-export-service.cjs', 'vfw-export-service.cjs']);
export const ENV_ENUMS = Object.freeze({
  os: ['win32', 'darwin', 'linux', 'web', 'unknown'], arch: ['x64', 'arm64', 'ia32', 'unknown'],
  osVersion: ['windows-10', 'windows-11', 'mac', 'linux', 'unknown'],
  ramBucket: ['4-or-less', '8', '16', '32', '64-plus', 'unknown'],
  cpuBucket: ['2-or-less', '4', '8', '16', '32-plus', 'unknown'],
  gpuFamily: ['nvidia', 'amd', 'intel', 'apple', 'qualcomm', 'software', 'unknown'],
  backend: ['webgpu', 'unavailable', 'unknown'], mode: ['simple', 'advanced', 'unknown'],
  locale: ['en', 'it', 'de', 'fr', 'es', 'pt', 'ja', 'ko', 'zh', 'ru', 'pl', 'tr', 'other', 'unknown'],
});
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const number = (value, max = 1e9) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const fail = () => { throw new TypeError('Invalid telemetry snapshot'); };
export function emptyHistogram() { return { count: 0, sum: 0, max: 0, buckets: HISTOGRAM_BOUNDS.map(() => 0) }; }
export function observe(histogram, value) {
  if (!number(value, 3600000)) return;
  const index = HISTOGRAM_BOUNDS.findIndex(bound => value <= bound);
  histogram.count++; histogram.sum += value; histogram.max = Math.max(histogram.max, value); histogram.buckets[index]++;
}
export function percentile(histogram, fraction = .95) {
  if (!histogram?.count) return null;
  const target = Math.ceil(histogram.count * fraction); let count = 0;
  for (let i = 0; i < HISTOGRAM_BOUNDS.length; i++) if ((count += histogram.buckets[i] || 0) >= target) return Math.min(HISTOGRAM_BOUNDS[i], histogram.max);
  return null;
}
export function sanitizeEnvironment(value = {}) {
  return Object.fromEntries(Object.entries(ENV_ENUMS).map(([key, values]) => [key, values.includes(value[key]) ? value[key] : 'unknown']));
}
export function sanitizeError(error, operation = 'app', now = Date.now()) {
  const type = ERROR_TYPES.includes(error?.name) ? error.name : 'Error';
  // Only our module basenames and line numbers; never error text or stack arguments.
  const frames = String(error?.stack || '').split('\n').slice(1, 12).map(line => {
    const match = line.match(/(?:\/|\\)([a-z][a-z0-9-]{0,70}\.(?:mjs|cjs)):(\d+):\d+/i);
    return match && ERROR_MODULES.includes(match[1]) ? { module: match[1], line: Math.min(1e6, Number(match[2])) } : null;
  }).filter(Boolean).slice(0, 5);
  const op = ERROR_OPERATIONS.includes(operation) ? operation : 'app';
  const signature = `${type}:${op}:${frames.map(frame => frame.module + ':' + frame.line).join(',')}`;
  let hash = 2166136261; for (let i = 0; i < signature.length; i++) hash = Math.imul(hash ^ signature.charCodeAt(i), 16777619);
  return { fingerprint: (hash >>> 0).toString(16).padStart(8, '0'), type, operation: op, frames, count: 1, firstAt: now, lastAt: now };
}
export function validateSnapshot(value) {
  if (!object(value) || JSON.stringify(value).length > MAX_SNAPSHOT_BYTES || value.schemaVersion !== SCHEMA_VERSION || !/^[a-f0-9]{64}$/.test(value.installationId || '') || !date(value.day) || !Number.isSafeInteger(value.sequence) || value.sequence < 1) fail();
  const consent = value.consent;
  if (!object(consent) || typeof consent.analytics !== 'boolean' || typeof consent.diagnostics !== 'boolean' || !consent.analytics && !consent.diagnostics || consent.policyVersion !== POLICY_VERSION || !number(consent.updatedAt, 1e14)) fail();
  if (!object(value.app) || !/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z0-9.]{1,24})?$/.test(value.app.version || '') || !['beta', 'stable', 'development'].includes(value.app.channel)) fail();
  const clean = { schemaVersion: SCHEMA_VERSION, installationId: value.installationId, day: value.day, sequence: value.sequence,
    app: { version: value.app.version, channel: value.app.channel },
    consent: { analytics: consent.analytics, diagnostics: consent.diagnostics, policyVersion: POLICY_VERSION, updatedAt: consent.updatedAt },
    environment: sanitizeEnvironment(value.environment), counters: {}, timings: {}, gauges: {}, milestones: {}, errors: [] };
  for (const [key, n] of Object.entries(value.counters || {})) {
    if (!COUNTERS.includes(key) || !Number.isSafeInteger(n) || !number(n)) fail();
    if (DIAGNOSTIC_COUNTERS.includes(key) ? consent.diagnostics : consent.analytics) clean.counters[key] = n;
  }
  for (const [key, h] of Object.entries(value.timings || {})) {
    if (!TIMINGS.includes(key) || !object(h) || !Number.isSafeInteger(h.count) || !number(h.count) || !number(h.sum, 3.6e15) || !number(h.max, 3600000) || !Array.isArray(h.buckets) || h.buckets.length !== HISTOGRAM_BOUNDS.length || !h.buckets.every(n => Number.isSafeInteger(n) && number(n)) || h.buckets.reduce((a, b) => a + b, 0) !== h.count || h.sum > h.count * h.max + .01) fail();
    if (consent.diagnostics) clean.timings[key] = { count: h.count, sum: h.sum, max: h.max, buckets: [...h.buckets] };
  }
  for (const [key, n] of Object.entries(value.gauges || {})) {
    if (!GAUGES.includes(key) || !number(n)) fail();
    if (consent.diagnostics) clean.gauges[key] = n;
  }
  for (const [key, day] of Object.entries(value.milestones || {})) {
    if (!MILESTONES.includes(key) || !date(day) || day > value.day) fail();
    if (consent.analytics) clean.milestones[key] = day;
  }
  if (!Array.isArray(value.errors || []) || (value.errors || []).length > 20) fail();
  for (const e of value.errors || []) {
    if (!object(e) || !/^[a-f0-9]{8}$/.test(e.fingerprint || '') || !ERROR_TYPES.includes(e.type) || !ERROR_OPERATIONS.includes(e.operation) || !Number.isSafeInteger(e.count) || !number(e.count) || !number(e.firstAt, 1e14) || !number(e.lastAt, 1e14) || e.lastAt < e.firstAt || !Array.isArray(e.frames) || e.frames.length > 5) fail();
    const frames = e.frames.map(f => {
      if (!object(f) || !ERROR_MODULES.includes(f.module) || !Number.isSafeInteger(f.line) || !number(f.line, 1e6)) fail();
      return { module: f.module, line: f.line };
    });
    if (consent.diagnostics) clean.errors.push({ fingerprint: e.fingerprint, type: e.type, operation: e.operation, frames, count: e.count, firstAt: e.firstAt, lastAt: e.lastAt });
  }
  // Usage dimensions must not sneak into diagnostic-only consent.
  if (!consent.analytics) { clean.environment.mode = 'unknown'; clean.environment.locale = 'unknown'; }
  return clean;
}
