import {messageError} from './localized-error.mjs';
// The same allowlist runs at the renderer, privileged desktop boundary, and Worker.
// No document content, filenames, paths, raw exception messages, or user text belongs here.
import { emptyPerformance, validatePerformance, trimPerformance,provenance } from './telemetry-performance-schema.mjs';
export * from './telemetry-performance-schema.mjs';
export const SCHEMA_VERSION = 3;
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
  'recovery_started', 'recovery_saved', 'recovery_restored', 'recovery_failed', 'recovery_cancelled',
  'renderer_crashes', 'renderer_hangs', 'backend_errors', 'gpu_errors', 'unclean_starts',
  'long_tasks', 'slow_frames', 'dropped_samples',
  'input_observed_interactions', 'input_background_samples', 'input_discontinuities', 'input_unattributed_samples', 'input_observer_dropped',
  'playback_observed_intervals', 'playback_missed_deadlines', 'playback_discontinuities', 'playback_background_intervals', 'dropped_operation_contexts',
]);
export const DIAGNOSTIC_COUNTERS = Object.freeze(COUNTERS.filter(key => /^(renderer_|backend_|gpu_|unclean_|long_tasks|slow_frames|dropped_|input_|playback_observed_|playback_missed_|playback_discontinuities|playback_background_)/.test(key)));
export const TIMINGS = Object.freeze(['startup_ms', 'import_ms', 'import_decode_ms', 'save_ms', 'export_ms', 'recovery_ms', 'frame_ms', 'input_latency_ms', 'long_task_ms', 'playback_interval_ms', 'playback_startup_ms', 'playback_buffering_ms',
  'input_delay_ms', 'input_processing_ms', 'input_presentation_ms', 'interaction_ms', 'input_anomaly_ms', 'playback_foreground_interval_ms', 'playback_anomaly_ms']);
export const GAUGES = Object.freeze(['process_memory_mb', 'process_cpu_percent', 'js_heap_mb', 'gpu_memory_mb', 'draw_calls', 'scene_figures', 'scene_frames', 'scene_primitives', 'upload_kb']);
export const MILESTONES = Object.freeze(['first_launch', 'first_edit', 'first_save', 'first_export']);
export const FIRST_SUCCESS_BUCKETS = Object.freeze(['under-1m', '1-5m', '5-30m', '30m-2h', '2-24h', 'over-24h']);
export const MAX_OPERATION_CONTEXTS = 12;
export const OPERATION_CONTEXT_ENUMS = Object.freeze({
  operation: ['import', 'save', 'export', 'recovery', 'playback'],
  stage: ['prepare', 'validate', 'decode', 'serialize', 'encode', 'request', 'write', 'complete', 'playback'],
  format: ['native', 'pivot', 'sticknodes', 'media', 'png', 'svg', 'gif', 'jpeg', 'video', 'unknown'],
  size: ['unknown', 'under-1mb', '1-10mb', '10-50mb', '50mb-plus'],
  complexity: ['unknown', 'under-100', '100-999', '1000-9999', '10000-plus'],
  fps: ['unknown', 'up-to-24', '25-30', '31-60', 'over-60'],
  outcome: ['succeeded', 'failed', 'cancelled'],
});
export const ERROR_CODES = Object.freeze(['unknown', 'invalid_document', 'unsupported_format', 'unsupported_feature', 'file_too_large', 'snapshot_failed', 'serialize_failed', 'decode_failed', 'backend_unavailable', 'backend_rejected', 'write_failed', 'permission_denied', 'disk_full', 'worker_failed', 'worker_busy', 'timeout', 'out_of_memory', 'device_lost', 'cancelled']);
export const TRAFFIC_TYPES = Object.freeze(['external', 'internal', 'mixed', 'unknown']);
export const contextKey = value => Object.keys(OPERATION_CONTEXT_ENUMS).map(key => value[key]).join(':')+(value.provenance?JSON.stringify(value.provenance):'');
export function operationContext(value = {}) {
  return Object.fromEntries(Object.entries(OPERATION_CONTEXT_ENUMS).map(([key, choices]) => [key, choices.includes(value[key]) ? value[key] : choices.includes('unknown') ? 'unknown' : choices[0]]));
}
// Reserve the fixed context allowance for failures before successful work.
// Never grow it: displaced timing samples remain visible in the drop counter.
export function operationContextSlot(rows, value) {
  const key=contextKey(value),existing=rows.find(row=>contextKey(row)===key);
  if(existing)return {row:existing,dropped:0};
  const priority=row=>(row.outcome==='failed'?100:row.outcome==='cancelled'?40:row.operation==='playback'?0:20)+(row.stage==='complete'?10:0);
  let dropped=0;
  if(rows.length>=MAX_OPERATION_CONTEXTS){
    let index=0;
    for(let i=1;i<rows.length;i++)if(priority(rows[i])<priority(rows[index]))index=i;
    if(priority(value)<=priority(rows[index]))return {row:null,dropped:0};
    dropped=rows[index].timing.count;rows.splice(index,1);
  }
  const row={...value,timing:emptyHistogram()};rows.push(row);return {row,dropped};
}
export function formatFamily(value = '') {
  const extension = String(value).toLowerCase().split('.').at(-1);
  return ['piv', 'stk'].includes(extension) ? 'pivot' : ['nodes', 'nodemc', 'stknds', 'zip'].includes(extension) ? 'sticknodes' : ['styk', 'stkz', 'stykmov', 'json', 'native'].includes(extension) ? 'native' : ['png', 'svg', 'gif', 'jpeg'].includes(extension) ? extension : extension === 'jpg' ? 'jpeg' : ['bmp', 'webp', 'media'].includes(extension) ? 'media' : ['mp4', 'webm', 'avi', 'video'].includes(extension) ? 'video' : 'unknown';
}
export const sizeBucket = n => !Number.isFinite(n) || n < 0 ? 'unknown' : n < 1048576 ? 'under-1mb' : n < 10 * 1048576 ? '1-10mb' : n < 50 * 1048576 ? '10-50mb' : '50mb-plus';
export const complexityBucket = n => !Number.isFinite(n) || n < 0 ? 'unknown' : n < 100 ? 'under-100' : n < 1000 ? '100-999' : n < 10000 ? '1000-9999' : '10000-plus';
export const fpsBucket = n => !Number.isFinite(n) || n <= 0 ? 'unknown' : n <= 24 ? 'up-to-24' : n <= 30 ? '25-30' : n <= 60 ? '31-60' : 'over-60';
export const ERROR_TYPES = Object.freeze(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AbortError', 'OperationError', 'NotSupportedError', 'GPUError', 'RendererCrash', 'RendererHang', 'BackendError', 'UncleanExit']);
export const ERROR_OPERATIONS = Object.freeze(['app', 'startup', 'import', 'save', 'export', 'playback', 'recovery', 'gpu', 'renderer', 'backend']);
// Basenames of shipped modules (src/, src/engine/, desktop/) that may appear in a forwarded stack; the server holds the same list.
export const ERROR_MODULES = Object.freeze(['app.mjs', 'renderer-geometry.mjs', 'editor.mjs', 'import-client.mjs', 'import-worker.mjs', 'document-export.mjs', 'document-export-worker.mjs', 'native-video-export.mjs', 'main.cjs', 'file-streams.cjs', 'video-export-service.cjs', 'vfw-export-service.cjs', 'camera-monitor.mjs', 'geometry.mjs', 'background.mjs',  'export-canvas.mjs', 'export-memory.mjs', 'preview-image.mjs', 'native-file-codec.mjs',    'engine.mjs', 'engine-clipboards.mjs', 'engine-composite.mjs', 'engine-document.mjs', 'engine-drawing-worker.mjs', 'engine-drawing.mjs', 'engine-edit-bounds.mjs', 'engine-export-worker.mjs', 'engine-document-export.mjs', 'engine-export.mjs', 'engine-failure.mjs', 'engine-live-cels.mjs', 'engine-memory.mjs', 'engine-open.mjs', 'engine-owner-drawing.mjs', 'engine-owner.mjs', 'engine-patch.mjs', 'engine-pictures.mjs', 'engine-playback.mjs', 'engine-preview-worker.mjs', 'engine-previews.mjs', 'engine-shown.mjs', 'engine-stage.mjs', 'engine-thumbnails.mjs', 'engine-worker.mjs']);
export const ENV_ENUMS = Object.freeze({
  os: ['win32', 'darwin', 'linux', 'web', 'unknown'], arch: ['x64', 'arm64', 'ia32', 'unknown'],
  osVersion: ['windows-10', 'windows-11', 'mac', 'linux', 'unknown'],
  ramBucket: ['4-or-less', '8', '16', '32', '64-plus', 'unknown'],
  cpuBucket: ['2-or-less', '4', '8', '16', '32-plus', 'unknown'],
  gpuFamily: ['nvidia', 'amd', 'intel', 'apple', 'qualcomm', 'software', 'unknown'],
  backend: ['webgpu', 'webgl2', 'canvas2d', 'unavailable', 'unknown'], mode: ['simple', 'advanced', 'unknown'],
  locale: ['en', 'it', 'de', 'fr', 'es', 'pt', 'ja', 'ko', 'zh', 'ru', 'pl', 'tr', 'other', 'unknown'],
});
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const number = (value, max = 1e9) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const fail = () => { throw messageError(new TypeError(''), "errors.telemetrySchema.invalidTelemetrySnapshot", {}); };
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
export function sanitizeError(error, operation = 'app', now = Date.now(), context = {}) {
  const type = ERROR_TYPES.includes(error?.name) ? error.name : 'Error';
  // Only our module basenames and line numbers; never error text or stack arguments.
  const forwarded = Array.isArray(error?.telemetryFrames) ? error.telemetryFrames.filter(frame=>ERROR_MODULES.includes(frame?.module)&&Number.isSafeInteger(frame.line)&&frame.line>=0&&frame.line<=1e6).map(frame=>({module:frame.module,line:frame.line})).slice(0,5) : [];
  const frames = forwarded.length ? forwarded : String(error?.stack || '').split('\n').slice(1, 12).map(line => {
    const match = line.match(/(?:\/|\\)([a-z][a-z0-9-]{0,70}\.(?:mjs|cjs)):(\d+):\d+/i);
    return match && ERROR_MODULES.includes(match[1]) ? { module: match[1], line: Math.min(1e6, Number(match[2])) } : null;
  }).filter(Boolean).slice(0, 5);
  const op = ERROR_OPERATIONS.includes(operation) ? operation : 'app';
  const aliases = { ENOSPC: 'disk_full', EACCES: 'permission_denied', EPERM: 'permission_denied', import_timeout: 'timeout', ETIMEDOUT: 'timeout',
    export_memory_limit:'out_of_memory', export_canvas_lost:'device_lost', codec_unavailable:'unsupported_format',
    invalid_native_figure:'invalid_document',invalid_movieclip:'invalid_document',invalid_native_version:'unsupported_format' };
  const rawCode = error?.telemetryCode || error?.code, code = ERROR_CODES.includes(rawCode) ? rawCode : Object.hasOwn(aliases, rawCode) ? aliases[rawCode] : type === 'AbortError' ? 'cancelled' : 'unknown';
  const rawStage = error?.telemetryStage || context.stage, stage = OPERATION_CONTEXT_ENUMS.stage.includes(rawStage) ? rawStage : 'unknown';
  const format = OPERATION_CONTEXT_ENUMS.format.includes(context.format) ? context.format : 'unknown';
  const complexity = OPERATION_CONTEXT_ENUMS.complexity.includes(context.complexity) ? context.complexity : 'unknown';
  const signature = `${type}:${op}:${frames.map(frame => frame.module + ':' + frame.line).join(',')}:${code}:${stage}:${format}:${complexity}`;
  let hash = 2166136261; for (let i = 0; i < signature.length; i++) hash = Math.imul(hash ^ signature.charCodeAt(i), 16777619);
  return { fingerprint: (hash >>> 0).toString(16).padStart(8, '0'), type, operation: op, frames, code, stage, format, complexity, count: 1, firstAt: now, lastAt: now };
}
/** Worker messages retain safe source locations without transferring raw stacks. */
export function diagnosticDetails(error, stage, fallback='unknown') {
  const entry=sanitizeError(error,'app',0,{stage});
  return {name:entry.type,telemetryCode:entry.code==='unknown'?fallback:entry.code,
    telemetryStage:entry.stage,telemetryFrames:entry.frames};
}
function validHistogram(h) {
  return object(h) && Number.isSafeInteger(h.count) && number(h.count) && number(h.sum, 3.6e15) && number(h.max, 3600000) && Array.isArray(h.buckets) && h.buckets.length === HISTOGRAM_BOUNDS.length && h.buckets.every(n => Number.isSafeInteger(n) && number(n)) && h.buckets.reduce((a, b) => a + b, 0) === h.count && h.sum <= h.count * h.max + .01;
}
export function validateSnapshot(value) {
  if (!object(value) || JSON.stringify(value).length > MAX_SNAPSHOT_BYTES || ![1, 2, SCHEMA_VERSION].includes(value.schemaVersion) || !/^[a-f0-9]{64}$/.test(value.installationId || '') || !date(value.day) || !Number.isSafeInteger(value.sequence) || value.sequence < 1) fail();
  const consent = value.consent;
  if (!object(consent) || typeof consent.analytics !== 'boolean' || typeof consent.diagnostics !== 'boolean' || !consent.analytics && !consent.diagnostics || consent.policyVersion !== POLICY_VERSION || !number(consent.updatedAt, 1e14)) fail();
  if (!object(value.app) || !/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z0-9.]{1,24})?$/.test(value.app.version || '') || !['beta', 'stable', 'development'].includes(value.app.channel)) fail();
  const clean = { schemaVersion: value.schemaVersion, installationId: value.installationId, day: value.day, sequence: value.sequence,
    app: { version: value.app.version, channel: value.app.channel },
    consent: { analytics: consent.analytics, diagnostics: consent.diagnostics, policyVersion: POLICY_VERSION, updatedAt: consent.updatedAt },
      environment: sanitizeEnvironment(value.environment), counters: {}, timings: {}, gauges: {}, milestones: {}, errors: [] };
  if (value.schemaVersion >= 2) {
    if (!TRAFFIC_TYPES.includes(value.app.traffic) || typeof value.app.build !== 'string' || !/^(unknown|[a-f0-9]{12,40})$/.test(value.app.build)) fail();
    Object.assign(clean.app, { traffic: value.app.traffic, build: value.app.build });
    clean.operationContexts = []; clean.firstSuccess = {};
  }
  for (const [key, n] of Object.entries(value.counters || {})) {
    if (!COUNTERS.includes(key) || !Number.isSafeInteger(n) || !number(n)) fail();
    if (DIAGNOSTIC_COUNTERS.includes(key) ? consent.diagnostics : consent.analytics) clean.counters[key] = n;
  }
  for (const [key, h] of Object.entries(value.timings || {})) {
    if (!TIMINGS.includes(key) || !validHistogram(h)) fail();
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
    const code = e.code ?? 'unknown', stage = e.stage ?? 'unknown', format = e.format ?? 'unknown', complexity = e.complexity ?? 'unknown';
    if (!ERROR_CODES.includes(code) || stage !== 'unknown' && !OPERATION_CONTEXT_ENUMS.stage.includes(stage) || !OPERATION_CONTEXT_ENUMS.format.includes(format) || !OPERATION_CONTEXT_ENUMS.complexity.includes(complexity)) fail();
    if (consent.diagnostics) clean.errors.push({ fingerprint: e.fingerprint, type: e.type, operation: e.operation, frames, ...(value.schemaVersion >= 2 ? { code, stage, format, complexity } : {}),...(value.schemaVersion>=3?{provenance:provenance(e.provenance)}:{}), count: e.count, firstAt: e.firstAt, lastAt: e.lastAt });
  }
  if (value.schemaVersion >= 2) {
    if (!Array.isArray(value.operationContexts || []) || (value.operationContexts || []).length > MAX_OPERATION_CONTEXTS || !object(value.firstSuccess || {})) fail();
    const seen = new Set();
    for (const row of value.operationContexts || []) {
      if (!object(row) || !Object.entries(OPERATION_CONTEXT_ENUMS).every(([key, choices]) => choices.includes(row[key])) || !validHistogram(row.timing)) fail();
      const key = contextKey(row); if (seen.has(key)) fail(); seen.add(key);
      if (consent.diagnostics) clean.operationContexts.push({ ...operationContext(row),...(value.schemaVersion>=3?{provenance:provenance(row.provenance)}:{}), timing: { count: row.timing.count, sum: row.timing.sum, max: row.timing.max, buckets: [...row.timing.buckets] } });
    }
    for (const [key, bucket] of Object.entries(value.firstSuccess || {})) {
      if (!['save', 'export'].includes(key) || !FIRST_SUCCESS_BUCKETS.includes(bucket)) fail();
      if (consent.analytics) clean.firstSuccess[key] = bucket;
    }
  }
  if (value.schemaVersion >= 3) {
    if (!Number.isSafeInteger(value.diagnosticGeneration ?? 0) || (value.diagnosticGeneration ?? 0)<0 || (value.diagnosticGeneration ?? 0)>1e9) fail();
    clean.diagnosticGeneration=value.diagnosticGeneration??0;
    const perf=validatePerformance(value.performance);
    clean.performance=consent.diagnostics?perf:emptyPerformance();
  }
  // Usage dimensions must not sneak into diagnostic-only consent.
  if (!consent.analytics) { clean.environment.mode = 'unknown'; clean.environment.locale = 'unknown'; }
  return clean;
}

// Diagnostic reset preserves product activity, milestones, consent and feedback.
export const RESET_COUNTERS = Object.freeze(COUNTERS.filter(key=>DIAGNOSTIC_COUNTERS.includes(key)||/^(save|import|export|recovery)_(started|succeeded|saved|restored|failed|cancelled)$/.test(key)||/^playback_(seconds|frames|buffering)$/.test(key)));
export function clearDiagnostics(snapshot,generation=0){
  const clean={...snapshot,counters:{...snapshot.counters},timings:{},gauges:{},errors:[],operationContexts:[]};
  for(const key of RESET_COUNTERS)delete clean.counters[key];
  if(snapshot.schemaVersion>=3){clean.performance=emptyPerformance();clean.diagnosticGeneration=generation;}
  return clean;
}
export function fitSnapshot(snapshot){
  if(snapshot.performance){
    trimPerformance(snapshot.performance);
    const excess=JSON.stringify(snapshot).length-MAX_SNAPSHOT_BYTES+128;
    if(excess>0)trimPerformance(snapshot.performance,Math.max(100,JSON.stringify(snapshot.performance).length-excess));
  }
  return snapshot;
}
