/**
 * The engine inspector's reads (developer build only): the document tree of the read view, paged, with raw values; the
 * evaluated frame on show; the history the editor mirrors; and the command log of edit session calls from the span ring.
 *
 * The read view is the interface's (src/editor.mjs); the inspector reads it as the interface does and never writes it.
 * The big tables fetch a record from the session when an index is read (src/lazy-table.mjs), so a page reads at most
 * PAGE records, and a table's rows are shown without fetching any.
 */
import {ringEvents} from './capture.mjs';

/**
 * The app's own `tableOf` (src/lazy-table.mjs), handed over at start: the tools load beside the app's bundle, and a second
 * copy of that module would not know the app's tables. Never import an app module from the tools.
 */
let tableOf = () => null;
export function useTableReader(reader) { tableOf = reader ?? (() => null); }

export const PAGE = 50;
const PREVIEW = 128;

/** A short, safe description of a value: its type and size, or its text for a scalar. */
export function preview(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return JSON.stringify(value.length > PREVIEW ? `${value.slice(0, PREVIEW - 1)}…` : value);
  if (typeof value !== 'object') return String(value);
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${value.length})`;
  if (value instanceof ArrayBuffer) return `ArrayBuffer(${value.byteLength})`;
  if (Array.isArray(value)) return `Array(${value.length})${tableOf(value) ? ' lazy' : ''}`;
  if (value instanceof Map || value instanceof Set) return `${value.constructor.name}(${value.size})`;
  return `Object{${Object.keys(value).length}}`;
}

/** The node at `path` (a list of keys) under `root`. */
export function resolve(root, path = []) {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') throw new Error(`Nothing at ${JSON.stringify(path)}: ${JSON.stringify(key)} is not inside a container.`);
    node = node instanceof Map ? node.get(key) : node[key];
  }
  return node;
}

/**
 * One page of the children of the node at `path`: `{path, kind, size, rows: [{key, preview, container}], cursor, next}`.
 * A lazy table lists its rows (src/lazy-table.mjs) unless `fetch` is set, so the page costs no session reads.
 */
export function treePage(root, {path = [], cursor = 0, fetch = false} = {}) {
  const node = resolve(root, path);
  const container = node !== null && typeof node === 'object' && !ArrayBuffer.isView(node) && !(node instanceof ArrayBuffer);
  if (!container) return {path, kind: typeof node, value: preview(node), size: 0, rows: [], cursor: 0, next: null};
  const table = Array.isArray(node) ? tableOf(node) : null;
  const keys = Array.isArray(node) ? null : node instanceof Map || node instanceof Set ? [...node.keys()] : Object.keys(node);
  const size = keys ? keys.length : node.length;
  const rows = [];
  for (let index = cursor; index < Math.min(size, cursor + PAGE); index++) {
    if (table && !fetch) { rows.push({key: index, preview: JSON.stringify(table.rowAt(index)).slice(0, PREVIEW), container: true}); continue; }
    const key = keys ? keys[index] : index;
    const value = node instanceof Map ? node.get(key) : node instanceof Set ? key : node[key];
    rows.push({key, preview: preview(value), container: value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)});
  }
  return {path, kind: Array.isArray(node) ? (table ? 'table' : 'array') : node instanceof Map ? 'map' : 'object', size, rows, cursor,
    next: cursor + PAGE < size ? cursor + PAGE : null};
}

/** The document's summary and the editor's state: what an agent reads first. */
export function documentSummary(editor) {
  return {
    name: editor.name ?? null, revision: editor.revision, savedRevision: editor._savedRevision ?? null, dirty: editor.dirty,
    tick: editor.tick, totalTicks: editor.totalTicks, fps: editor.report?.fps ?? null,
    figureTypes: editor.report?.figure_types?.length ?? 0, keyframes: editor.report?.keyframes?.length ?? 0,
    layers: (() => { try { return editor.layers?.length ?? null; } catch { return null; } })(), activeLayerId: editor.activeLayerId,
    selection: [...(editor.selectedUids ?? [])].slice(0, PAGE), selectedJoint: editor.selectedJoint ?? -1,
    history: {canUndo: editor.canUndo, canRedo: editor.canRedo, undoLabel: editor.undoLabel, redoLabel: editor.redoLabel,
      undo: editor._undo?.length ?? 0, redo: editor._redo?.length ?? 0},
  };
}

/** The history stacks the editor mirrors, newest first: labels only, never their payloads. */
export function historyPage(editor, {cursor = 0} = {}) {
  const undo = editor._undo ?? [], redo = editor._redo ?? [];
  const rows = [...redo.map((entry, index) => ({stack: 'redo', index, label: entry?.label ?? ''})).reverse(),
    ...undo.map((entry, index) => ({stack: 'undo', index, label: entry?.label ?? ''})).reverse()];
  return {size: rows.length, rows: rows.slice(cursor, cursor + PAGE), cursor, next: cursor + PAGE < rows.length ? cursor + PAGE : null};
}

/** The evaluated frame on show: its figures' ids, types and joint counts (paged), not their geometry. */
export function framePage(editor, {cursor = 0} = {}) {
  const objects = editor.evaluatedFrame?.objects ?? [];
  return {tick: editor.tick, size: objects.length, cursor, next: cursor + PAGE < objects.length ? cursor + PAGE : null,
    rows: objects.slice(cursor, cursor + PAGE).map(object => ({uid: object.unique_id, type: object.figure_type_id, joints: object.joints?.length ?? object.points?.length ?? null,
      visible: object.visible ?? true, layer: object.layer_id ?? object._styk?.layerId ?? null}))};
}

/** The edit session calls the ring still holds, newest first: method, duration and when (the command log). */
export function commandLog(ring, {limit = PAGE, since = 0} = {}) {
  const {events} = ringEvents(ring, Math.max(since, ring.total - ring.capacity));
  const rows = [];
  for (let index = events.length - 1; index >= 0 && rows.length < limit; index--) {
    const event = events[index];
    if (event.name === 'edit session call') rows.push({method: event.args?.method ?? '?', ms: Math.round(event.duration * 1000) / 1000, at: Math.round(event.start)});
  }
  return rows;
}
