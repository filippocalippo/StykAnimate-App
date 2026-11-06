/** StykAnimate's own files for tests, scripts and tools: the format read and written by the
 * Rust container module (src/native-file-codec.mjs, built by `node scripts/engine-build.mjs`),
 * in Node and in test pages, with the shapes callers have always used.
 *
 *   const {document, version} = await decodeDocument(bytes, 'styk');   // the container as stored
 *   const document = await openDocument(bytes, 'stkz');                // what opening a file does
 *   const bytes = await buildContainerV2(document, 'styk');            // a document written as a container
 *
 * The app saves from the engine's session (src/engine/engine-document-export.mjs); `buildContainerV2` writes a document
 * given as an object, which is how a test makes a file to read.
 */
import {nativeFileCodec} from '../../src/native-file-codec.mjs';

/** The container as stored, without the document rules: `{document, version, materializedBytes}`. */
export function decodeDocument(data, kind) {
  return nativeFileCodec.open(data, kind, {normalize: false});
}

/** The document opening a file produces: the early wrapper unwrapped, the figure shape checked,
 * browser fields dropped; `verifySource` (default) also checks the embedded original source. */
export async function openDocument(data, kind, {verifySource = true} = {}) {
  return (await nativeFileCodec.open(data, kind, {verifySource})).document;
}

/** A version 2 container around `document` (its JSON is lifted into a skeleton and sections). */
export function buildContainerV2(document, kind) {
  return nativeFileCodec.save(document, kind);
}
