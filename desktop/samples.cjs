'use strict';
/**
 * The sample list of Home and the Add menu: the .piv and .stk files under one folder,
 * and the bytes of one of them for an ordinary import.
 *
 * The rules are those of the Python codec service that served /api/samples and
 * /api/open (backend/server.py `ProjectStore.samples`, `safe_child` and `open`), and
 * the answers carry its statuses, codes and messages: the same files are listed in
 * the same order, and the same paths are refused for the same reasons.
 *
 * The folder is the one that holds the app's source folder when the app runs from
 * source. A packaged app has none: its codec service looked in the folder of its own
 * frozen runtime, which holds no Pivot files, so its list was always empty.
 */
const fs = require('node:fs/promises');
const path = require('node:path');

const MIB = 1024 * 1024;
const MAX_SAMPLE_COUNT = 5000;
const PRIVATE_PARTS = new Set(['.git', '.codex', '.agents', '__pycache__', 'node_modules']);
const EXCLUDED_DIRS = new Set([...PRIVATE_PARTS, 'reports', 'tests', 'vendor', 'reference', 'references', 'reference_runs',
  'snapshots', '__snapshots__', 'dependencies', 'artifacts', 'piv_extracted', 'third_party', 'build', 'dist', 'local',
  'stykanimate', 'stykanimate-webapp']);
const IMPORT_SUFFIXES = new Set(['.piv', '.stk', '.styk', '.stkz', '.stykmov', '.json']);
const NATIVE_SUFFIXES = new Set(['.styk', '.stkz', '.stykmov']);
// codecs/codec_bridge.py read_bounded limits, then the import limits of the desktop codec.
const READ_LIMIT = {native: 512 * MIB, source: 256 * MIB};
const IMPORT_LIMIT = {native: 256 * MIB, source: 128 * MIB};

/** Python's str.casefold(), closely enough for file names. */
const casefold = text => text.toUpperCase().toLowerCase();
/** Python's string order: by code point (JavaScript's < compares UTF-16 units). */
function compareCodePoints(a, b) {
  const left = [...a], right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i].codePointAt(0) - right[i].codePointAt(0);
    if (difference) return difference;
  }
  return left.length - right.length;
}
const sampleOrder = (a, b) => compareCodePoints(a.kind, b.kind) || compareCodePoints(casefold(a.name), casefold(b.name));
/** pathlib's suffix: '' for a name that starts with its only dot. */
const suffixOf = name => { const dot = name.lastIndexOf('.'); return dot > 0 && dot < name.length - 1 ? name.slice(dot) : ''; };

class SampleError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const answer = error => ({ok: false, status: error.status, code: error.code, error: error.message});

function inside(root, target) {
  const relative = path.relative(root, target);
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/** pathlib's Path.resolve(strict=False): links are followed as far as the path exists. */
async function resolveLoose(target) {
  try { return await fs.realpath(target); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    const parent = path.dirname(target);
    return parent === target ? target : path.join(await resolveLoose(parent), path.basename(target));
  }
}

/** The folder whose samples the app lists: the parent of the app's source folder, or null when packaged. */
async function sampleRoot({appRoot, packaged}) {
  if (packaged) return null;
  return path.dirname(await fs.realpath(appRoot));
}

/** {ok: true, samples: [{path, name, kind, size}]}: walked top-down, a folder's files before its subfolders. */
async function listSamples(root) {
  if (!root) return {ok: true, samples: []};
  const result = [];
  async function walk(directory) {
    let entries;
    try { entries = await fs.readdir(directory, {withFileTypes: true}); }
    catch { return false; }
    const subdirectories = [];
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      let directoryEntry = entry.isDirectory();
      // A link to a folder counts as a folder that is not entered, as os.walk does.
      if (entry.isSymbolicLink()) directoryEntry = await fs.stat(full).then(stat => stat.isDirectory(), () => false);
      if (directoryEntry) {
        if (!entry.isSymbolicLink() && !entry.name.startsWith('.') && !EXCLUDED_DIRS.has(casefold(entry.name))) subdirectories.push(full);
        continue;
      }
      const kind = suffixOf(entry.name).toLowerCase();
      if (kind !== '.piv' && kind !== '.stk') continue;
      let size;
      try {
        if (!inside(root, await resolveLoose(full))) continue;
        size = (await fs.stat(full)).size;
      } catch { continue; }
      result.push({path: path.relative(root, full).split(path.sep).join('/'), name: entry.name, kind: kind.slice(1), size});
      if (result.length >= MAX_SAMPLE_COUNT) return true;
    }
    for (const subdirectory of subdirectories) if (await walk(subdirectory)) return true;
    return false;
  }
  await walk(root);
  return {ok: true, samples: result.sort(sampleOrder)};
}

/** `safe_child`: the file `relative` names under `root`, resolved. */
async function sampleFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0'))
    throw new SampleError(400, 'invalid_path', 'A relative file path is required.');
  const normalized = relative.replaceAll('\\', '/');
  // PurePosixPath(...).parts: empty and '.' components disappear.
  const parts = normalized.split('/').filter(part => part && part !== '.');
  if (normalized.startsWith('/') || normalized.includes(':') ||
      parts.some(part => part === '..' || part.startsWith('.') || PRIVATE_PARTS.has(casefold(part))))
    throw new SampleError(403, 'path_forbidden', 'The path must stay inside the project directory.');
  const target = await resolveLoose(path.join(root, ...parts));
  if (!inside(root, target)) throw new SampleError(403, 'path_forbidden', 'The path must stay inside the project directory.');
  return target;
}

/** The bytes of one sample, checked as /api/open checked them before importing them:
 * {ok: true, name, bytes} or {ok: false, status, code, error}. */
async function readSample(root, relative) {
  try {
    if (!root) throw new SampleError(404, 'file_not_found', 'This project file no longer exists.');
    const target = await sampleFile(root, relative), name = path.basename(target), suffix = suffixOf(name).toLowerCase();
    // filename_only(): the file name the import will carry must name a supported file.
    const cleaned = name.replace(/[\x00-\x1f\x7f:*?"<>|]/g, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 220);
    if (!cleaned || !IMPORT_SUFFIXES.has(suffixOf(cleaned).toLowerCase()))
      throw new SampleError(415, 'unsupported_file', 'Choose a .styk project, .stykmov movieclip, .stkz figure, .piv, or .stk file.');
    if (suffix === '.json') throw new SampleError(415, 'unsupported_sample', 'Use file import to open a native JSON project.');
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) throw new SampleError(404, 'file_not_found', 'This project file no longer exists.');
    const native = NATIVE_SUFFIXES.has(suffix), limit = native ? READ_LIMIT.native : READ_LIMIT.source;
    // A Pivot error in the codec service: 422 invalid_project with its message.
    if (stat.size > limit) throw new SampleError(422, 'invalid_project', `File exceeds the ${limit / MIB} MiB size limit`);
    const bytes = await readBounded(target, limit);
    if (bytes.length > (native ? IMPORT_LIMIT.native : IMPORT_LIMIT.source))
      throw new SampleError(413, 'file_too_large', 'This file exceeds the import size limit.');
    return {ok: true, name, bytes};
  } catch (error) {
    if (error instanceof SampleError) return answer(error);
    // The service answered an OSError so, and anything else as a codec failure.
    if (typeof error?.code === 'string' && error?.syscall) return answer(new SampleError(500, 'file_error', 'The local file operation could not be completed.'));
    return answer(new SampleError(500, 'codec_error', 'The project operation failed.'));
  }
}

async function readBounded(target, limit) {
  const file = await fs.open(target, 'r');
  try {
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = new Uint8Array(Math.min(16 * MIB, limit + 1 - total));
      if (!chunk.length) break;
      const {bytesRead} = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > limit) throw new SampleError(422, 'invalid_project', 'File grew past the size limit while reading');
    if (chunks.length === 1 && chunks[0].byteOffset === 0 && chunks[0].length === chunks[0].buffer.byteLength) return chunks[0];
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally { await file.close(); }
}

module.exports = {sampleRoot, listSamples, readSample, MAX_SAMPLE_COUNT};
