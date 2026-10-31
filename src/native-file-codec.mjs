/** StykAnimate's own files (.styk, .stkz, .stykmov) through the Rust container module.
 * (native-files.mjs moves finished bytes to and from the desktop; this module reads and writes the format.)
 *
 * Reading and writing the container (header and section checks, checksums, zstd, the
 * document rules, the size limits) is `styk-formats`, compiled into the codec module
 * (engine/crates/styk-codec-wasm, built into src/engine/pkg/ by scripts/engine-build.mjs).
 * The import worker loads the module and calls it here, off the interface thread;
 * docs/engine/formats.md describes the split.
 *
 * What crosses on a read is the lifted form (document-lift.mjs): a JSON skeleton and the byte sections
 * its markers name, parsed and restored into the editor's object model. The app does not save through
 * this module: the engine writes the project its session holds (src/engine/engine-document-export.mjs).
 * `save` makes a file from a document given as an object, for the tests and tools that need one to read.
 *
 *   const {document, version} = await nativeFileCodec.open(bytes, 'styk');
 *   const file = await nativeFileCodec.save(document, 'styk');   // Uint8Array
 */
import {messageError} from './localized-error.mjs';
import {restoreLifted} from './document-lift.mjs';

const MODULE = new URL('./engine/pkg/styk_codec.js', import.meta.url);
/** The module's memory only grows. A call that leaves more than this behind replaces the instance. */
export const NATIVE_FILE_CODEC_RETAINED_BYTES = 128 * 1024 * 1024;

const encoder = new TextEncoder(), decoder = new TextDecoder();

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
   * Writes a version 2 container around a document (tests and tools; the app's saves are the engine's).
   * @param {object} document its JSON is what is lifted into the skeleton and sections
   * @param {'styk'|'stkz'|'stykmov'} kind a `.stkz` or `.stykmov` document must be the self-contained figure
   * @returns {Promise<Uint8Array>}
   */
  async save(document, kind) {
    const bindings = await module();
    let saved;
    try { saved = bindings.saveNativeDocument(kind, encoder.encode(JSON.stringify(document))); }
    catch (failure) { throw asError(bindings, failure); }
    let file;
    try { file = saved.takeBytes(); } finally { saved.free(); }
    trim(bindings);
    return file;
  },
};
