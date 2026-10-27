/** StykAnimate's own files for tests, scripts and tools: the format read and written by the
 * Rust container module (src/native-file-codec.mjs, built by `node scripts/engine-build.mjs`),
 * in Node and in test pages, with the shapes callers have always used.
 *
 *   const {document, version} = await decodeDocument(bytes, 'styk');   // the container as stored
 *   const document = await openDocument(bytes, 'stkz');                // what opening a file does
 *   const bytes = await buildContainerV2(document, 'styk');            // lift + write
 */
import {nativeFileCodec} from '../../src/native-file-codec.mjs';
import {liftDocument} from '../../src/document-lift.mjs';

export {liftDocument};

/** The container as stored, without the document rules: `{document, version, materializedBytes}`. */
export function decodeDocument(data, kind) {
  return nativeFileCodec.open(data, kind, {normalize: false});
}

/** The document opening a file produces: the early wrapper unwrapped, the figure shape checked,
 * browser fields dropped; `verifySource` (default) also checks the embedded original source. */
export async function openDocument(data, kind, {verifySource = true} = {}) {
  return (await nativeFileCodec.open(data, kind, {verifySource})).document;
}

/** A version 2 container around a lifted document (`liftDocument`'s result). */
export function encodeContainerV2(lifted, kind, options) {
  return nativeFileCodec.save(lifted, kind, options);
}

/** Lifts `document` and writes it. `options`: `preBlobs` and `maxBytes` for the lift, `cache` and `stats` for the write. */
export function buildContainerV2(document, kind, options) {
  return nativeFileCodec.save(liftDocument(document, options), kind, options);
}
