// The editor's load (src/editor-load.mjs `prepareEditorLoad`) as the engine's port is recorded against:
// the answer as plain JSON, for load-fixtures.mjs (fixtures) and load-private.mjs (private documents).
import './v8-pin.mjs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const repo = path.resolve(import.meta.dirname, '../..');
export const {prepareEditorLoad} = await import(`${pathToFileURL(repo).href}/src/editor-load.mjs`);

/** What `prepareEditorLoad` returns besides the report, as plain JSON (Maps and Sets in insertion order). */
export function indexesOf(prepared) {
  return {
    nextFrameIdentity: prepared.nextFrameIdentity, nextUid: prepared.nextUid,
    layerUidCounts: [...prepared.layerUidCounts], layerSeenUids: [...prepared.layerSeenUids],
    layerGroups: [...prepared.layerGroups].map(([id, uids]) => [id, [...uids]]),
    figureNames: [...prepared.figureNames], tracks: prepared.tracks,
  };
}

/** A refusal as the editor raises it: its message key (and parameters), or the plain message of an Error
 * that has none, or the kind of exception a malformed document makes the JavaScript throw. */
export function describeError(error) {
  if (error?.messageKey) {
    const params = error.messageParams && Object.keys(error.messageParams).length ? error.messageParams : undefined;
    return {key: error.messageKey, ...(params ? {params} : {})};
  }
  if (error instanceof TypeError || error instanceof RangeError) return {exception: error.name};
  return {message: String(error?.message)};
}

/** Runs the editor's load on a copy of `text` (a JSON document): `{prepared}` or `{error}`. */
export function oracle(text) {
  try { return {prepared: prepareEditorLoad(JSON.parse(text))}; }
  catch (error) { return {error: describeError(error)}; }
}
