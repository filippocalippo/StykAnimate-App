/**
 * File operations as statistics name them (docs/STATISTICS.md, "Files"): the format of a file, and the stage and reason of a
 * failure. Workers mark the failures they post with `fileStage` and `fileReason` (`workerFailure`); the interface thread
 * reads any error with `failureOf`.
 */
import {FILE_REASONS, FILE_STAGES, FORMATS} from './schema.mjs';
import {enginePanicked, lastPanic} from '../engine/engine-panic.mjs';

/** Extensions and export formats as statistics' FORMATS. */
const BY_EXTENSION = {
  styk: 'styk', json: 'styk', stkz: 'styk-figure', stykmov: 'styk-movieclip', piv: 'pivot-animation', stk: 'pivot-figure',
  stknds: 'sticknodes', nodes: 'sticknodes-figure', nodemc: 'sticknodes-movieclip', zip: 'archive',
  png: 'picture', jpg: 'picture', jpeg: 'picture', webp: 'picture', bmp: 'picture', apng: 'apng', gif: 'gif', svg: 'svg',
  mp4: 'video', webm: 'video', avi: 'video', wmv: 'video', vfw: 'video', mov: 'video', video: 'video',
  wav: 'sound', mp3: 'sound', ogg: 'sound', m4a: 'sound', aac: 'sound', flac: 'sound',
};

/**
 * The format of a file name, an extension or an export format ("png-sequence", "svg-sequence", "mp4"): a word of FORMATS.
 * A name is read only for its extension; nothing of it is kept.
 */
export function formatOf(value) {
  const text = String(value ?? '').toLowerCase();
  if (/-sequence$/.test(text)) return 'picture-sequence';
  const extension = text.includes('.') ? text.slice(text.lastIndexOf('.') + 1) : text.replace(/^export-/, '');
  const format = BY_EXTENSION[extension] ?? 'unknown';
  return FORMATS.includes(format) ? format : 'unknown';
}

/** Operating system codes and message keys that say why a file operation failed. */
const BY_CODE = {
  ENOSPC: 'disk-full', EDQUOT: 'disk-full', EACCES: 'no-permission', EPERM: 'no-permission', EROFS: 'no-permission', EBUSY: 'file-in-use',
  ELOCKED: 'file-in-use', ENOENT: 'path-gone', ENOTDIR: 'path-gone', ETIMEDOUT: 'timeout', import_timeout: 'timeout',
  export_memory_limit: 'out-of-memory', out_of_memory: 'out-of-memory', export_canvas_lost: 'graphics-lost', export_gpu_memory: 'graphics-lost',
  codec_unavailable: 'not-this-format', invalid_native_version: 'unsupported-version', invalid_native_figure: 'damaged', invalid_movieclip: 'damaged',
  engine_unavailable: 'engine',
};
const BY_KEY = [
  [/version/i, 'unsupported-version'], [/tooLarge|exceeds|Limit\b|limit$/, 'too-large'], [/memory/i, 'out-of-memory'], [/timedOut|timeout/i, 'timeout'],
  [/cannotMake|unsupported|notSupported/i, 'unsupported-feature'], [/notA[A-Z]|notThisFormat|unknownFormat|unrecognized|wrongFormat|notRecogni/i, 'not-this-format'],
  [/damaged|corrupt|unreadable|invalid|malformed|truncated/i, 'damaged'], [/stopped|crashed|workerFailed/i, 'worker-stopped'], [/deviceLost|graphicsDevice/i, 'graphics-lost'],
];

/** Why `error` failed a file operation: a word of FILE_REASONS. */
export function reasonOf(error) {
  if (FILE_REASONS.includes(error?.fileReason)) return error.fileReason;
  const code = BY_CODE[error?.code];
  if (code) return code;
  if ((error instanceof RangeError || error?.name === 'RangeError') && /memory|allocation/i.test(error.message)) return 'out-of-memory';
  if (globalThis.WebAssembly && error instanceof WebAssembly.RuntimeError) return 'engine';
  for (const [pattern, reason] of BY_KEY) if (pattern.test(error?.messageKey ?? '')) return reason;
  return 'unknown';
}

/** The stage `error` failed at, or `fallback`: a word of FILE_STAGES. */
export const stageOf = (error, fallback = 'unknown') => FILE_STAGES.includes(error?.fileStage) ? error.fileStage : FILE_STAGES.includes(fallback) ? fallback : 'unknown';

/**
 * What a worker posts with a failure, beside its message: the stage and reason (when it knows them), its stack text (cleaned
 * on the interface thread before anything is kept) and the engine panic that came just before it, if one did.
 */
export function workerFailure(error, stage, reason) {
  return {name: error?.name || 'Error', fileStage: stageOf(error, stage), fileReason: FILE_REASONS.includes(error?.fileReason) ? error.fileReason : reason,
    workerStack: typeof error?.stack === 'string' ? error.stack.slice(0, 8000) : undefined, panic: lastPanic() ?? undefined};
}

/** The fields `workerFailure` posted, put back on the error made from them on the interface thread. */
export function restoreFailure(error, data) {
  if (!data || typeof data !== 'object') return error;
  if (FILE_STAGES.includes(data.fileStage)) error.fileStage = data.fileStage;
  if (FILE_REASONS.includes(data.fileReason)) error.fileReason = data.fileReason;
  if (typeof data.workerStack === 'string') error.workerStack = data.workerStack;
  if (typeof data.name === 'string' && /^\w{1,40}$/.test(data.name) && data.name !== 'AbortError') error.name = data.name;
  // The panic reaches statistics once, as the engine problem it is; the failure keeps it as its cause.
  if (data.panic) { error.panic = data.panic; enginePanicked(data.panic); }
  return error;
}
