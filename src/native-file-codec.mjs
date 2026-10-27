/** StykAnimate's own files (.styk, .stkz, .stykmov) through the Rust container module.
 * (native-files.mjs moves finished bytes to and from the desktop; this module reads and writes the format.)
 *
 * Reading and writing the container (header and section checks, checksums, zstd, the
 * document rules, the size limits) is `styk-formats`, compiled into the codec module
 * (engine/crates/styk-codec-wasm, built into src/engine/pkg/ by scripts/engine-build.mjs).
 * The import and document-export workers each load the module and call it
 * here, off the interface thread; docs/engine/formats.md describes the split.
 *
 * What crosses is the lifted form (document-lift.mjs): a JSON skeleton and the byte sections
 * its markers name. An opened file is parsed and restored into the editor's object model; a save
 * hands the skeleton and sections the worker lifted from its document to the writer.
 *
 *   const {document, version} = await nativeFileCodec.open(bytes, 'styk');
 *   const file = await nativeFileCodec.save(liftDocument(document), 'styk', {cache});   // Uint8Array
 */
import {messageError} from './localized-error.mjs';
import {restoreLifted} from './document-lift.mjs';

const MODULE = new URL('./engine/pkg/styk_codec.js', import.meta.url);
/** The module's memory only grows. A call that leaves more than this behind replaces the instance. */
export const NATIVE_FILE_CODEC_RETAINED_BYTES = 128 * 1024 * 1024;

const encoder = new TextEncoder(), decoder = new TextDecoder();
const NO_BLOCKS = {get: () => undefined, put() {}};

let loading = null;
/** This thread's instance of the module, loaded by the first call. */
function module() {
  return loading ??= (async () => {
    const bindings = await import(MODULE.href);
    if (globalThis.process?.versions?.node && !globalThis.WorkerGlobalScope) {
      // Node (tests, tools): read the module from disk; fetch() has no file URLs there.
      const {readFile} = await import('node:fs/promises');
      const wasm = await readFile(new URL('./engine/pkg/styk_codec_bg.wasm', import.meta.url)).catch(() => {
        throw new Error('The container module is not built: run node scripts/engine-build.mjs (src/engine/pkg/styk_codec_bg.wasm is missing).');
      });
      await bindings.default({module_or_path: wasm});
    } else await bindings.default();
    return bindings;
  })().catch(error => { loading = null; throw error; });
}

/** A failure of the module as the editor's localized error; a trap leaves the instance unusable, so it is replaced. */
function asError(bindings, failure) {
  if (failure instanceof bindings.NativeFailure) {
    const error = messageError(new Error(''), failure.messageKey, failure.kind ? {kind: failure.kind} : {});
    if (failure.code) error.code = failure.code;
    failure.free();
    return error;
  }
  try { bindings.__wbg_reset_state(); } catch { /* the next call reports its own failure */ }
  return failure;
}

const trim = bindings => { if (bindings.memoryBytes() > NATIVE_FILE_CODEC_RETAINED_BYTES) bindings.__wbg_reset_state(); };

export const nativeFileCodec = {
  /**
   * Reads a file into the editor's object model.
   * @param {Uint8Array|ArrayBuffer} data the file
   * @param {'styk'|'stkz'|'stykmov'} kind
   * @param {{normalize?: boolean, verifySource?: boolean}} rules `normalize` (default) applies the
   *   document rules: the early project wrapper is unwrapped, a figure file's shape is checked, fields
   *   only older builds or the browser wrote are dropped. `verifySource` (default with `normalize`) also
   *   checks the embedded original source. Without `normalize` the container is returned as stored.
   * @returns {Promise<{document: object, version: number, materializedBytes: number}>}
   *   `version` is 0 for a plain JSON project, otherwise the container version.
   */
  async open(data, kind, {normalize = true, verifySource = normalize} = {}) {
    const bindings = await module();
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let opened;
    try { opened = bindings.openNativeFile(bytes, kind, normalize, verifySource && normalize); }
    catch (failure) { throw asError(bindings, failure); }
    let skeleton, version, markers, materializedBytes;
    const sections = [];
    try {
      skeleton = opened.takeSkeleton();
      for (let index = 0; index < opened.sectionCount; index++) sections.push({bytes: opened.takeSection(index)});
      version = opened.version; markers = opened.markers; materializedBytes = opened.materializedBytes;
    } finally { opened.free(); }
    trim(bindings);
    const parsed = JSON.parse(decoder.decode(skeleton));
    return {document: markers ? restoreLifted(parsed, sections) : parsed, version, materializedBytes};
  },

  /**
   * Writes a version 2 container around a lifted document.
   * @param {{skeleton: object, sections: {bytes: Uint8Array}[]}} lifted what liftDocument returns
   * @param {'styk'|'stkz'|'stykmov'} kind a `.stkz` or `.stykmov` skeleton must be the self-contained figure
   * @param {{cache?: object, stats?: object}} options `cache` (container-cache.mjs) supplies compressed
   *   blocks written before; `stats` receives what it reused.
   * @returns {Promise<Uint8Array>}
   */
  async save(lifted, kind, {cache, stats} = {}) {
    const bindings = await module();
    if (stats) Object.assign(stats, {hits: 0, misses: 0, rawBytesReused: 0, compressedBytesReused: 0});
    const [arrays, payloads] = lifted.sections.map(section => section.bytes);
    let saved;
    try { saved = bindings.saveNativeFile(kind, encoder.encode(JSON.stringify(lifted.skeleton)), arrays, payloads, cache ?? NO_BLOCKS); }
    catch (failure) { throw asError(bindings, failure); }
    let file;
    try {
      file = saved.takeBytes();
      if (stats) Object.assign(stats, {hits: saved.hits, misses: saved.misses, rawBytesReused: saved.rawBytesReused,
        compressedBytesReused: saved.compressedBytesReused, cacheBytes: cache?.byteLength || 0, cacheEntries: cache?.size || 0,
        container_raw_bytes: saved.containerRawBytes});
    } finally { saved.free(); }
    trim(bindings);
    return file;
  },
};
