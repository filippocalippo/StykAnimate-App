/**
 * The engine owns the open document (D19, docs/engine/editing.md "Phase 3").
 *
 * One styk-edit session per document holds the document and its history. The editor's
 * methods that change the document run in the session; its answer carries a patch that
 * this module applies copy-on-write to `editor.report`, which the interface keeps reading
 * as a read view, then the session's selection, counters and change events.
 *
 * A call the session refuses raises a localized error: the editor never runs it in the session's
 * place. What still runs in the editor is what the session has no command for at all (answered
 * `unported` with the method's own name: `report.editor` counts them) and the editing of a
 * movieclip's own document (`editor._movieclipScopes`). Those calls are written back into the
 * session as records, with a history entry the session keeps in its place and asks the editor to
 * apply on undo and redo (`external.rs`). Edits other modules make in place (gizmo previews)
 * reach the session before its next call.
 *
 * Calls that only move the view (selecting, seeking) stay with the editor; the session
 * receives the view with every call.
 */
import {applyDocumentPatch} from './engine-patch.mjs';
import {editorDraws, withDraws} from '../editor-draws.mjs';
import {messageError} from '../localized-error.mjs';
import {validationLabel} from '../validation-labels.mjs';
import {motionParameterMessages} from '../camera-motion-localization.mjs';
import english from '../locales/en.mjs';
import {invalidateFrameIndex} from '../frame-ids.mjs';
import {invalidateMovieclipTypes} from '../movieclips.mjs';
import {layerIdForUid} from '../layers.mjs';
import {appBoundsMarker} from './engine-edit-bounds.mjs';

/** The undo/redo answer when the entry to apply is the editor's own (external.rs). */
const EXTERNAL_ENTRY = 'external history entry ';
/** How many values of each kind a call that draws many identities is handed. */
const MANY_DRAWS = 512;
/** What the editor shows of a copied audio clip, which the session holds: the interface asks only whether there is one. */
const AUDIO_COPIED = Object.freeze({inSession: true});
/** The tables the read view tracks record by record. */
const TABLES = ['figure_types', 'keyframes', 'backgrounds'];

/** Calls that only change what is shown or selected: the editor runs them, the session
 * receives the result as the view of the next call. */
const VIEW_CALLS = new Set(['select', 'selectMany', 'selectPolygon', 'toggleSegment', 'selectBranch', 'selectConnected', 'selectMarquee',
  'selectSameDefinition', 'invertSelection', 'seek', 'setActiveLayer', 'selectSheetLayer', 'selectFrame', 'keepSelectionOnSeek']);

/** Calls that carry a drawing's pixels (tile buffers): the editor applies them to the drawing
 * store and the records they change reach the session by write-back. Their pixels are never
 * turned into JSON for the session, which does not take them (a stroke is megabytes). */
const PIXEL_CALLS = new Set(['commitDrawingPixels', 'resampleDrawing']);

/** The calls that end an edit, and the editor's field that holds it: with none open they change
 * nothing and answer false, which the owner knows without asking the session. */
const ENDS_EDIT = {commitVfxClipEdit: '_vfxClipEdit', cancelVfxClipEdit: '_vfxClipEdit', commitAnimationEdit: '_animationEdit', cancelAnimationEdit: '_animationEdit'};

/** Calls that read the document or the editor's state, open or close documents, or
 * configure the editor: never routed. */
const QUERIES = new Set(['addEventListener', 'removeEventListener', 'dispatchEvent', 'animationChannel', 'animationValue', 'canDisconnectSegment',
  'drawingTarget', 'figurePalette', 'frameClipboardDocument', 'frameClipboardDocumentView', 'frameIndexForId', 'getCameraMotions',
  'getFrameById', 'getFrameId', 'getIKSettings', 'getLayer', 'getLayerFigureUids', 'getLayerFocus', 'getLayerFolders', 'getLayers', 'getSpatialCamera',
  'getSpatialIKPole', 'getSpatialMotion', 'getSpatialPose', 'getSpatialProportions', 'getVfxClips', 'isFigureFocusLocked', 'isLayerFocusLocked',
  'joinedFigureIds', 'layerForUid', 'layerFrameKeys', 'motionPathReport', 'movieclipProjectReport', 'nativePoseChannel', 'nativePropertyChannel',
  'nearestAnimationKey', 'prepareGeometry', 'resolveAnimationTarget', 'resolveTranslationSelection', 'sampleVfxClip', 'segmentAnimationTarget',
  'serialize', 'vfxEffects', 'segmentValues', 'motionPathFalloff', 'previewInbetween', 'sheetSpan', 'transaction',
  'load', 'loadAsync', 'newDocument', 'detachDocument', 'discardDocument', 'resumeDocument', 'handOverDocument', 'markSaved',
  'setFrameClipboardWorker', 'setInbetweenPlanner', 'setLayerMigrationPlanner', 'enterMovieclip', 'leaveMovieclip',
  'setLayerFocus', 'clearLayerFocus', 'reconcileLayerFocus', 'prepareDrawingCel', 'undo', 'redo', 'constructor']);

/** The editor's public methods the owner routes: everything but queries and view calls. */
export function ownedMethods(editor) {
  const names = new Set();
  for (let prototype = Object.getPrototypeOf(editor); prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (typeof descriptor.value === 'function' && !name.startsWith('_') && !QUERIES.has(name) && !VIEW_CALLS.has(name)) names.add(name);
    }
  }
  return names;
}

/** A call's arguments as text for the session: frame ranges keep their `sheetTicks`, and the app's
 * figure-bounds callback is the marker the engine measures for itself (engine-edit-bounds.mjs). Any other
 * function, or what JSON cannot hold, is not data: `null`. */
function sessionPayload(args) {
  let data = true;
  const replacer = (key, value) => {
    if (typeof value === 'function') { const marker = appBoundsMarker(value); data &&= Boolean(marker); return marker; }
    return Array.isArray(value) && Object.hasOwn(value, 'sheetTicks') ? {'@array': [...value], sheetTicks: value.sheetTicks} : value;
  };
  try { const text = JSON.stringify(args, replacer); return data ? text : null; } catch { return null; }
}
const selectionMetadata = state => Object.fromEntries(['polygonSelection', 'segmentIds', 'branch'].filter(key => Object.hasOwn(state, key)).map(key => [key, state[key]]));

/**
 * @param {object} editor the app's Editor
 * @param {{start?(editor): object|null, methods: Iterable<string>, verify?: boolean, draws?(): Array}} options
 *   `start` gives the session that edits the document the editor just opened (by default the one the
 *   engine opened it with: `openingSession`), `methods` names the calls to route to it, `verify` compares
 *   the session's document after every call (tests), `draws` supplies the random values a call may take (D18).
 */
export function installEngineOwner(editor, {start = openingSession, methods = ownedMethods(editor), verify = false, draws = null} = {}) {
  const report = {calls: 0, native: 0, fallback: 0, external: 0, synced: 0, refused: {}, verified: 0};
  let session = null, document = null, depth = 0, history = null, nextEntry = 1, applying = false, spare = [];
  /** How many `movieclipBatch` operations the owner is running: the session records them as one entry. */
  let batches = 0;
  /** JavaScript commands of the session's external entries, by identity. */
  const entries = new Map();
  /** Commands the editor recorded during the call it is running for the owner. */
  let captured = null;
  /** Records the editor changed in place, as its change events name them. */
  let hints = null;
  /** The identity of every record when the session last had the same document. */
  let snapshot = null;
  const originals = new Map();

  const view = () => ({tick: editor.tick, frameIndex: editor.frameIndex, selectedUid: editor.selectedUid ?? null, selectedUids: [...(editor.selectedUids ?? [])],
    selectedJoint: editor.selectedJoint ?? -1, activeLayerId: editor.activeLayerId, autoKey: Boolean(editor.autoKey), audioRipple: Boolean(editor.audioRipple),
    sheetSelection: editor._sheetSelection ? {id: editor._sheetSelection.id, contents: Boolean(editor._sheetSelection.contents)} : null,
    ...selectionMetadata(editor._selectionState())});

  // --- the session's document as records -------------------------------------------
  const take = () => {
    const root = editor.report, styk = root._styk ?? null;
    snapshot = {
      keys: Object.keys(root), values: new Map(Object.entries(root)),
      tables: Object.fromEntries(TABLES.map(key => [key, Array.isArray(root[key]) ? root[key].slice() : null])),
      stykKeys: styk ? Object.keys(styk) : null, styk: styk ? new Map(Object.entries(styk)) : null,
      // Small metadata the editor changes in place (layers, palette): compared by text.
      stykText: styk ? new Map(Object.entries(styk).filter(([key]) => !['frameSources', 'layerSheet', 'audio', 'animation'].includes(key)).map(([key, value]) => [key, JSON.stringify(value)])) : null,
      sources: new Map(Object.entries(styk?.frameSources ?? {})),
      activeId: styk?.layers?.activeId,
    };
    hints = null;
  };
  /** The operations that bring the session's document to the read view. */
  const changes = () => {
    const root = editor.report, ops = [], all = hints?.all;
    const keys = Object.keys(root), styk = root._styk ?? null;
    const sameOrder = (before, after) => {
      // Deleting the removed keys and assigning the new ones reproduces this order.
      const simulated = {};
      for (const key of before) if (after.includes(key)) simulated[key] = true;
      for (const key of after) if (!before.includes(key)) simulated[key] = true;
      return JSON.stringify(Object.keys(simulated)) === JSON.stringify(after);
    };
    const record = (path, before, after) => {
      if (Array.isArray(after) && Array.isArray(before)) {
        const named = path[0] === 'figure_types' ? hints?.figures : path[0] === 'keyframes' ? hints?.frames : hints?.backgrounds;
        const known = new Set(before);
        if (before.length === after.length && after.every((item, index) => item === before[index] || !known.has(item))) {
          const every = path[0] === 'figure_types' ? hints?.allFigures : path[0] === 'keyframes' ? hints?.allFrames : hints?.allBackgrounds;
          after.forEach((item, index) => { if (all || every || item !== before[index] || named?.has(index)) ops.push({p: [...path, index], v: item}); });
        } else {
          const where = new Map(before.map((item, index) => [item, index]));
          ops.push({p: path, a: after.map((item, index) => where.has(item) && !all && !named?.has(index) ? where.get(item) : {v: item})});
        }
      } else ops.push({p: path, v: after});
    };
    if (!sameOrder(snapshot.keys, keys)) ops.push({p: [], o: keys.map(key => snapshot.values.get(key) === root[key] && key !== '_styk' && !TABLES.includes(key) ? [key] : [key, root[key]])});
    else for (const key of snapshot.keys) if (!Object.hasOwn(root, key)) ops.push({p: [key], x: 1});
    const rootRebuilt = ops.length && ops.at(-1).p.length === 0;
    for (const key of keys) {
      const before = snapshot.values.get(key), after = root[key];
      if (TABLES.includes(key)) { if (Array.isArray(after) && Array.isArray(snapshot.tables[key]) && !rootRebuilt) record([key], snapshot.tables[key], after); else if (!rootRebuilt || before !== after) ops.push({p: [key], v: after}); continue; }
      if (key === '_styk' && styk && snapshot.styk) {
        const stykKeys = Object.keys(styk);
        if (!sameOrder(snapshot.stykKeys, stykKeys)) { ops.push({p: ['_styk'], v: styk}); continue; }
        for (const name of snapshot.stykKeys) if (!Object.hasOwn(styk, name)) ops.push({p: ['_styk', name], x: 1});
        for (const name of stykKeys) {
          const value = styk[name], old = snapshot.styk.get(name);
          if (name === 'frameSources' && value && typeof value === 'object' && old && typeof old === 'object' && !all) {
            const ids = Object.keys(value), oldIds = [...snapshot.sources.keys()];
            if (!sameOrder(oldIds, ids)) { ops.push({p: ['_styk', name], v: value}); continue; }
            for (const id of oldIds) if (!Object.hasOwn(value, id)) ops.push({p: ['_styk', name, id], x: 1});
            for (const id of ids) if (value[id] !== snapshot.sources.get(id) || hints?.sources?.has(id)) ops.push({p: ['_styk', name, id], v: value[id]});
            continue;
          }
          const text = snapshot.stykText.get(name);
          const changed = all || value !== old || (text !== undefined ? JSON.stringify(value) !== text : hints?.styk?.has(name));
          if (changed || !snapshot.styk.has(name)) ops.push({p: ['_styk', name], v: value});
        }
        continue;
      }
      if (rootRebuilt) continue;
      if (before !== after || all || !snapshot.values.has(key)) ops.push({p: [key], v: after});
    }
    return ops;
  };
  const send = (method, args) => {
    const viewText = JSON.stringify({...view(), patch: true});
    report.capture?.push({name: method, args: JSON.stringify(args), view: viewText});
    const text = session.call(method, JSON.stringify(args), viewText);
    report.trace?.push(`${method} ${JSON.stringify(args).slice(0, 120)} -> ${text.slice(0, 160)}`);
    const answer = JSON.parse(text);
    if (answer.status !== 'ok') throw new Error(`The engine refused the editor's records (${method}): ${answer.error ?? answer.reason}`);
    adoptState(answer, {patch: false});
    // What the session changed besides the editor's records (sources it collected).
    if (Array.isArray(answer.result) && answer.result.length) {
      applying = true;
      try {
        const before = posesBefore();
        applyDocumentPatch(editor.report, answer.result);
        for (const op of answer.result) if (op.p[0] === '_styk' && op.p[1] === 'frameSources' && op.x) editor._generatedFrameSources?.delete(op.p[2]);
        if (answer.result.some(op => op.p[0] === '_styk' && op.p[1] === 'frameSources' && op.p.length === 2)) {
          const kept = new Set(Object.keys(editor.report._styk?.frameSources ?? {}));
          for (const id of [...(editor._generatedFrameSources ?? [])]) if (!kept.has(id)) editor._generatedFrameSources.delete(id);
        }
        refresh(answer.result, before);
        editor._invalidate({timing: true});
      } finally { applying = false; }
    }
    return answer;
  };
  const generated = () => [...(editor._generatedFrameSources ?? [])];
  const counters = () => [editor.layerRevision, editor._nextFrameIdentity, editor._nextUid];
  /** The frame the session retained, while the editor still shows it. */
  let retainedShown = null;
  const stillShown = () => Boolean(retainedShown) && editor._evaluated === retainedShown && !editor._authoredPoseEdit;
  /** The counters the session last had: a flush sends the editor's when they moved. */
  let known = null;
  /** Writes what the editor changed since the session last had its document. */
  /** Whether the editor may have changed the document since the session last had it:
   * a call it ran, a command recorded or an edit announced outside the session's calls. */
  let pending = false;
  const flush = ({entry = null} = {}) => {
    if (!session || applying) return;
    // Selecting changes the active layer in place, without an edit event.
    if (!entry && !pending && !hints && JSON.stringify(counters()) === JSON.stringify(known) && editor.report._styk?.layers?.activeId === snapshot?.activeId) return;
    pending = false;
    const ops = changes();
    if (entry) {
      send('@external', [entry.label, entry.id, entry.retained, generated(), entry.bytes, ops, counters(), stillShown()]);
      report.external++;
    } else if (ops.length || hints?.touched || JSON.stringify(counters()) !== JSON.stringify(known)) { send('@sync', [ops, generated(), Boolean(hints?.touched), counters(), stillShown()]); report.synced++; }
    take();
    check();
  };
  const check = () => {
    if (!verify || !session) return;
    const engine = session.report_json(), view = JSON.stringify(editor.report);
    if (engine !== view) {
      let at = 0; while (engine[at] === view[at]) at++;
      throw new Error(`The engine's document differs from the read view at ${at}: engine …${engine.slice(Math.max(0, at - 60), at + 60)}… view …${view.slice(Math.max(0, at - 60), at + 60)}…`);
    }
    report.verified++;
  };

  // --- answers ------------------------------------------------------------------------
  /** Updates what the editor derives from the records a patch replaced. */
  /** The pose records and layer state before a patch, to update the layer index from. */
  const posesBefore = () => ({frames: editor.report.keyframes, sources: editor.report._styk?.frameSources, layers: editor.report._styk?.layers});
  /** Updates what the editor derives from the records a patch replaced: the layer index
   * from the poses that changed (by identity), frame and type indices, caches. */
  const refresh = (patch, before) => {
    const touched = new Set(patch.map(op => op.p[0] ?? '*'));
    const index = editor._layerUidCounts && before && !touched.has('*') ? before : null;
    if (!index) {
      // Counted again from the document, figures seen before kept.
      const seen = editor._layerSeenUids, revision = editor._layerRevision;
      editor._initializeLayers();
      // The session counts layer revisions; rebuilding the index is not one.
      editor._layerRevision = revision;
      if (seen) for (const uid of seen) editor._layerSeenUids.add(uid);
    } else {
      const counts = editor._layerUidCounts, groups = editor._layerGroups, report = editor.report;
      const delta = new Map(), crossed = [];
      const count = (records, sign) => { for (const record of records) for (const object of record?.objects ?? []) delta.set(object.unique_id, (delta.get(object.unique_id) ?? 0) + sign); };
      const compare = (old, next) => {
        if (old === next) return;
        const previous = new Set(old ?? []), current = new Set(next ?? []);
        count([...previous].filter(record => !current.has(record)), -1);
        count([...current].filter(record => !previous.has(record)), 1);
      };
      compare(index.frames, report.keyframes);
      if (index.sources !== report._styk?.frameSources) compare(Object.values(index.sources ?? {}), Object.values(report._styk?.frameSources ?? {}));
      for (const [uid, amount] of delta) {
        if (!amount) continue;
        const previous = counts.get(uid) ?? 0, next = previous + amount;
        if (next > 0) { counts.set(uid, next); editor._layerSeenUids.add(uid); } else counts.delete(uid);
        if ((previous > 0) !== (next > 0)) crossed.push(uid);
      }
      if (index.layers !== report._styk?.layers) {
        // Assignments or layers changed: every figure regrouped.
        const state = report._styk.layers;
        editor._layerGroups = new Map(state.order.map(id => [id, new Set()]));
        for (const uid of counts.keys()) editor._layerGroups.get(layerIdForUid(report, uid))?.add(uid);
      } else for (const uid of crossed) {
        const layer = groups.get(layerIdForUid(report, uid));
        if (counts.has(uid)) layer?.add(uid); else for (const members of groups.values()) members.delete(uid);
      }
    }
    if (verify && index) {
      // The incremental index equals one counted again from the document.
      const counts = new Map(editor._layerUidCounts), groups = new Map([...editor._layerGroups].map(([id, members]) => [id, [...members].sort((a, b) => a - b)]));
      const seen = editor._layerSeenUids, revision = editor._layerRevision;
      editor._initializeLayers();
      editor._layerRevision = revision; for (const uid of seen) editor._layerSeenUids.add(uid);
      const sorted = map => JSON.stringify([...map].sort(([a], [b]) => String(a).localeCompare(String(b))));
      const fresh = new Map([...editor._layerGroups].map(([id, members]) => [id, [...members].sort((a, b) => a - b)]));
      if (sorted(counts) !== sorted(editor._layerUidCounts) || sorted(groups) !== sorted(fresh)) throw new Error('The layer index after a patch differs from one counted from the document.');
    }
    if (touched.has('keyframes') || touched.has('*')) invalidateFrameIndex(editor.report);
    if (touched.has('figure_types') || touched.has('*')) invalidateMovieclipTypes(editor.report);
    editor._layerDescriptors = null; editor._layerUidArrays = new Map(); editor._nativeAnimationChannels = null;
  };
  const adoptState = (answer, {patch = true} = {}) => {
    const {state} = answer;
    if (patch && answer.patch?.length) {
      applying = true;
      try {
        const before = posesBefore();
        applyDocumentPatch(editor.report, answer.patch);
        refresh(answer.patch, before);
        editor._invalidate({timing: true});
      } finally { applying = false; }
    }
    // The playhead first: the selection belongs to the frame it shows. Set as history
    // sets it: the editor's seek would also end a gesture the session keeps going.
    if (state && (state.tick !== editor.tick || state.frameIndex !== editor.frameIndex)) {
      editor.tick = state.tick; editor.frameIndex = state.frameIndex; editor._invalidate({viewOnly: true});
    }
    if (answer.motionPathError) throw new Error(`The engine could not show the motion-path edit: ${answer.motionPathError}`);
    if (Object.hasOwn(answer, 'drag')) gesture(answer);
    if (Object.hasOwn(answer, 'handleGesture')) handles(answer);
    edits(answer);
    if (state) {
      history = {canUndo: state.canUndo, canRedo: state.canRedo, undoLabel: state.undoLabel, redoLabel: state.redoLabel, dirty: state.dirty};
      editor._nextUid = state.nextUid; editor._nextFrameIdentity = state.nextFrameIdentity; editor._layerRevision = state.layerRevision;
      known = [state.layerRevision, state.nextFrameIdentity, state.nextUid];
      const metadata = selectionMetadata(state);
      if (state.selectedUid !== (editor.selectedUid ?? null) || state.selectedJoint !== (editor.selectedJoint ?? -1)
          || JSON.stringify(state.selectedUids) !== JSON.stringify([...editor.selectedUids])
          || JSON.stringify(metadata) !== JSON.stringify(selectionMetadata(editor._selectionState()))) {
        // The session's selection is the editor's, exactly: assigned, not validated again.
        editor.selectedUids = new Set(state.selectedUids); editor._selectedUid = state.selectedUid; editor.selectedJoint = state.selectedJoint;
        editor._branchSelection = metadata.branch ? {...metadata.branch} : null;
        editor._polygonSelection = metadata.polygonSelection ? {...metadata.polygonSelection} : null;
        const active = editor.figure?.segments[editor.selectedJoint]?.segment_id;
        const ids = new Set(metadata.segmentIds ?? []);
        editor._segmentSelection = ids.size > 1 && ids.has(active) ? {uid: editor.selectedUid, active, ids} : null;
      }
    }
    if (Object.hasOwn(answer, 'sheetSelection')) {
      const chosen = answer.sheetSelection;
      editor._sheetSelection = chosen ? {...(editor._sheetSelection?.id === chosen.id ? editor._sheetSelection : {}), id: chosen.id, contents: chosen.contents} : null;
    }
    if (Array.isArray(answer.depths)) { if (writing) lastDepths = answer.depths; else mirror(answer); }
    if (Number.isFinite(answer.revision)) {
      editor._revision = answer.revision;
      editor._revisionSerial = Math.max(editor._revisionSerial ?? 0, answer.revision);
    }
  };
  /** The editor's history stacks follow the session's: the editor's own commands for the
   * entries it applies, placeholders for the session's entries, so the editor's code that
   * reads or amends the entry on top keeps working. */
  let depths = [0, 0], writing = false, lastDepths = null;
  const mirror = answer => {
    const [undo, redo] = answer.depths, stacks = [editor._undo, editor._redo];
    const placeholder = label => ({kind: 'engine', label, bytes: 0, beforeRevision: editor._revision, afterRevision: answer.revision});
    if (undo > depths[0] && redo === 0 && stacks[0].length === depths[0]) {
      // New entries the session recorded itself (a call may commit a gesture first).
      for (let added = depths[0]; added < undo; added++) stacks[0].push(placeholder(added === undo - 1 ? answer.state?.undoLabel ?? '' : ''));
      editor._redo = [];
    } else if (undo === depths[0] - 1 && redo === depths[1] + 1 && stacks[0].length) stacks[1].push(stacks[0].pop());
    else if (undo === depths[0] + 1 && redo === depths[1] - 1 && stacks[1].length) stacks[0].push(stacks[1].pop());
    // Entries the session retired (oldest first), or stacks out of step: as many as the session has.
    while (editor._undo.length > undo) editor._undo.shift();
    while (editor._redo.length > redo) editor._redo.shift();
    while (editor._undo.length < undo) editor._undo.unshift(placeholder(''));
    while (editor._redo.length < redo) editor._redo.unshift(placeholder(''));
    depths = [undo, redo];
  };
  /** Whether the gesture the session holds is a rig edit or a camera drag (the editor's `_drag` does not say). */
  let rigOrCamera = false;
  /** The session's gesture in progress, as the editor shows it: its draft on show and
   * `_drag` with the figures it took as they were. */
  const gesture = answer => {
    const drag = answer.drag;
    rigOrCamera = Boolean(drag?.rig || drag?.camera);
    if (!drag) {
      if (editor._drag?.engine) {
        // A motion-path edit changed no frame on show: the document's patch invalidated what changed.
        const motion = Boolean(editor._drag.motionPath);
        if (editor._drag.cameraBase) editor._sheetPropertyPreview = null;
        editor._drag = null; editor._authoredPoseEdit = null;
        if (!motion) editor._invalidate();
      }
      return;
    }
    if (answer.motionPath) { motion(answer); return; }
    // A call can end one gesture and begin the next (a duplicate drag opened over another, a rig edit over a move): the new one
    // starts from the draft the session composed, else from the frame the document now shows.
    let base = null;
    if (editor._drag?.engine && editor._drag.serial !== drag.serial) {
      const previous = editor._authoredPoseEdit;
      editor._drag = null; editor._authoredPoseEdit = null;
      if (answer.draftBase && previous) base = previewFrame(answer.draftBase, previous.frame);
      else editor._invalidate();
    }
    if (!editor._drag?.engine) {
      const source = base ?? editor.evaluatedFrame;
      editor._authoredPoseEdit = answer.draft ? {frame: {...source, objects: source.objects.slice()}, source, owned: new Set(), tick: editor.tick, engine: true} : null;
      const taken = new Set(drag.before);
      editor._drag = {engine: true, serial: drag.serial, label: drag.label, scope: drag.translation ? 'translation' : 'selection', authored: Boolean(answer.draft), index: editor.frameIndex,
        before: source.objects.filter(object => taken.has(object.unique_id)).map(object => structuredClone(object)), beforeSelection: editor._selectionState(), changed: false};
    }
    editor._drag.label = drag.label; editor._drag.scope = drag.translation ? 'translation' : 'selection';
    const edit = editor._authoredPoseEdit;
    if (edit && answer.draftFields) edit.frame = {...edit.frame, ...answer.draftFields};
    if (edit && answer.draft?.length) {
      const objects = edit.frame.objects;
      for (const figure of answer.draft) {
        const slot = objects.findIndex(object => object.unique_id === figure.unique_id);
        // A figure the gesture added (drawing a new figure while posing) joins the draft.
        if (slot < 0) {
          const at = Number.isInteger(figure.object_slot) && figure.object_slot <= objects.length ? figure.object_slot : objects.length;
          objects.splice(at, 0, figure); edit.owned.add(at);
          continue;
        }
        if (objects[slot]._movieclipSample !== undefined) figure._movieclipSample = objects[slot]._movieclipSample;
        objects[slot] = figure; edit.owned.add(slot);
      }
    }
    editor._drag.changed = Boolean(drag.changed);
    editor._invalidate();
  };
  /** The session's figure-handle, Handle Edit Mode and segment-value gesture, as the editor shows its own
   * (`_drag.figureHandle`, `_drag.handleEdit`, `_drag.segmentValueOptions`). The stage's pivot marker reads the
   * transform's origin; every answer says where the turns stand, the rest is told once. */
  const handles = answer => {
    const drag = editor._drag?.engine && !editor._drag.motionPath ? editor._drag : null;
    if (!drag) return;
    const {figureHandle, handleEdit, segmentValueOptions} = answer.handleGesture ?? {};
    if (!figureHandle) delete drag.figureHandle;
    else if (drag.figureHandle) Object.assign(drag.figureHandle.transform, {lastAngle: figureHandle.lastAngle, rotation: figureHandle.rotation});
    else {
      const {uid, rotate, scale, origin, distance, lastAngle, rotation} = figureHandle;
      drag.figureHandle = {uid, rotate, scale, transform: {origin: {x: origin[0], y: origin[1]}, distance, lastAngle, rotation}};
    }
    if (!handleEdit) delete drag.handleEdit;
    else if (!drag.handleEdit) {
      const {uid, index, point, bend} = handleEdit;
      drag.handleEdit = {uid, index, point: {x: point[0], y: point[1]}, bend};
    }
    if (!segmentValueOptions) delete drag.segmentValueOptions;
    else drag.segmentValueOptions ??= {...segmentValueOptions};
  };
  /** The session's motion-path edit, as the editor shows its own: `_drag` with what the interface
   * reads of it (the trails sample `report` over `range`; the stage draws the `display` pose; the arc's
   * overlay and the pinned-origin modifier read the falloff, its writes and the pinned figures of the
   * grabbed frame). The answer that opens it carries the fixed part; every answer says how it stands,
   * and `report` (the operations that turn the document into the virtual report the gesture shows)
   * when a pointer move changed it. */
  const motion = answer => {
    const live = answer.motionPath;
    // The gesture this one replaces was committed by the call; its draft is gone.
    if (editor._authoredPoseEdit?.engine) editor._authoredPoseEdit = null;
    let drag = editor._drag?.engine && editor._drag.motionPath ? editor._drag : null;
    if (live.target) drag = editor._drag = motionDrag(answer.drag.label, live);
    if (!drag) throw new Error('The engine holds a motion-path edit the editor does not show.');
    drag.moved = live.moved; drag.range = live.range;
    live.movedSubs?.forEach((moved, index) => { drag.subs[index].moved = moved; });
    if (live.report) drag.ops = live.report;
  };
  /** The editor's session of a motion-path edit, from the call that opened it. `report` and `display`
   * are built when read, from the document as it is then: the document with the operations the session
   * told, and the playhead's pose under it (nothing while the trail is as the document has it). */
  const motionDrag = (label, live) => {
    const drag = {motionPath: true, engine: true, label, scope: 'motion-path', documentToken: editor._documentToken, target: live.target, tick: live.tick, baseline: [], ops: [], moved: false, range: live.range};
    if (live.falloff) Object.assign(drag, {falloff: live.falloff, writes: live.writes, subs: live.subs.map(({tick, kind}) => ({tick, kind, moved: false})), grab: {baseline: live.baseline}});
    else drag.baseline = live.baseline;
    let built = null, shown = null;
    Object.defineProperties(drag, {
      report: {get() {
        if (!this.ops.length) return editor.report;
        if (built?.document !== editor.report || built.ops !== this.ops) {
          const report = {...editor.report};
          applyDocumentPatch(report, this.ops);
          built = {document: editor.report, ops: this.ops, report};
        }
        return built.report;
      }},
      display: {get() {
        if (!this.ops.length) return null;
        const report = this.report;
        if (shown?.report !== report || shown.tick !== editor.tick || shown.range !== this.range) shown = {report, tick: editor.tick, range: this.range, display: editor._motionPathDisplay(this)};
        return shown.display;
      }},
    });
    return drag;
  };
  /** The session's effect-clip and property edits, as the editor shows its own (`_vfxClipEdit`,
   * `_animationEdit`, and the frame a layer sheet's edit previews, `_sheetPropertyPreview`).
   * A mirror begins with the call that opens the edit (`mirrorEdit`); every answer says how the
   * edit stands, and `engine` marks it as the session's until a call the editor runs takes it. */
  const edits = answer => {
    const edit = editor._animationEdit;
    if (edit?.engine && Object.hasOwn(answer, 'animationEdit')) {
      if (answer.animationEdit) {
        edit.changed = answer.animationEdit.changed;
        if (edit.sheet) edit.value = answer.animationEdit.value;
      } else { editor._animationEdit = null; editor._sheetPropertyPreview = null; editor._invalidate(); }
    }
    if (answer.vfxEdit === false && editor._vfxClipEdit?.engine) editor._vfxClipEdit = null;
    if (answer.previewChanges && editor._animationEdit?.engine) {
      editor._sheetPropertyPreview = previewFrame(answer.previewChanges, editor._animationEdit.frame);
      editor._geometry = null;
    }
    // A camera drag shows the frame it began on with the camera it moves.
    if (answer.cameraPreview !== undefined && editor._drag?.engine) {
      const drag = editor._drag;
      drag.cameraBase ??= editor.evaluatedFrame;
      editor._sheetPropertyPreview = {...drag.cameraBase, camera: answer.cameraPreview};
      editor._geometry = null;
    }
  };
  /** The edit a `begin` call opened in the session, as the editor's own would be. */
  const mirrorEdit = (name, answer) => {
    if (name === 'beginVfxClipEdit') { editor._vfxClipEdit = {engine: true, before: editor.report._styk.vfxClips}; return; }
    const opened = answer.animationEdit;
    if (!opened) return;
    // The edit it replaces ended with the call, and its preview with it.
    if (editor._animationEdit?.engine && editor._sheetPropertyPreview) { editor._sheetPropertyPreview = null; editor._invalidate(); }
    const {target, property, exactTarget, tick, initialValue, changed} = opened, edit = {engine: true, target, property, exactTarget, tick, initialValue, selection: editor._selectionState(), changed};
    editor._animationEdit = opened.sheet ? Object.assign(edit, {sheet: true, value: opened.value, frame: editor.evaluatedFrame})
      : Object.assign(edit, {before: editor.report._styk?.animation ?? null, beforeChannel: editor.animationChannel(target, property, {exactTarget})});
  };
  /** The session's change events, for the interface: they describe what the session already has. */
  const emit = answer => {
    const events = answer.events ?? [];
    if (!events.length) return;
    const was = applying; applying = true;
    try { for (const {kind, frameIndex, tick, ...detail} of events) editor._emit(kind, kind === 'seek' ? {} : detail); }
    finally { applying = was; }
  };
  /** What a call returns when its answer is a view the editor holds. */
  const resultOf = (name, answer) => {
    if (['duplicateFigure', 'addFigure', 'importFigure'].includes(name)) return editor.object;
    if (name === 'pasteSelection' || name === 'duplicateSelection') return editor.selectedObjects;
    if (name === 'sheetAppendFrame') return editor.evaluatedFrame;
    if (name === 'beginAnimationEdit') return editor._animationEdit;
    if (name === 'beginVfxClipEdit') return undefined;
    if (name === 'createLayer' && answer.result?.id) return editor.getLayer(answer.result.id);
    return answer.result;
  };

  // --- calls ----------------------------------------------------------------------------
  /** Sessions of the documents open beside this one (editor sessions, tabs), by document. */
  const parked = new Map();
  const park = () => {
    report.log?.push(`park ${Boolean(session)}`);
    if (!session) return;
    parked.set(document, {session, entries: new Map(entries), depths, history, known, snapshot, nextEntry});
    session = null; document = null;
  };
  const call = (method, args) => {
    const answer = JSON.parse(session.call(method, JSON.stringify(args), JSON.stringify(view())));
    if (answer.status !== 'ok') throw new Error(`${method}: ${answer.error ?? answer.reason}`);
    return answer;
  };
  /** Makes the session's document the engine's: the stage draws it, playback and exports read it. */
  const activate = () => session.activate(editor.revision);
  const ensure = () => {
    if (session && document === editor.report) return session;
    report.log?.push(`ensure: session ${Boolean(session)} same ${document === editor.report} name ${editor.name}`);
    park();
    const resumed = parked.get(editor.report);
    if (resumed) {
      parked.delete(editor.report);
      ({session} = resumed); document = editor.report;
      entries.clear(); for (const [id, commands] of resumed.entries) entries.set(id, commands);
      ({depths, history, known, snapshot, nextEntry} = resumed);
      activate();
      return session;
    }
    let started = null;
    try { started = start(editor); } catch (error) { report.broken = String(error.message ?? error); }
    report.log?.push(`start ${Boolean(started)}`);
    if (!started) return null;
    session = started; document = editor.report;
    entries.clear(); depths = [0, 0];
    take();
    try {
      call('@historyLimits', [editor.historyLimit, editor.historyBytes]);
      call('@revisions', [editor._revision, editor._revisionSerial, editor._savedRevision]);
      history = {canUndo: false, canRedo: false, undoLabel: '', redoLabel: '', dirty: editor._revision !== editor._savedRevision};
      activate();
      check();
    } catch (error) {
      session.free(); session = null; document = null; entries.clear();
      report.broken = String(error.message ?? error);
      return null;
    }
    return session;
  };
  /** The values a call may draw: the spare ones, then the caller's (`draws`) or fresh ones
   * up to a few of each kind. */
  const pool = (each = 4) => {
    if (draws) return [...spare, ...draws()];
    const values = [...spare];
    for (const kind of ['uuid', 'seed', 'random']) for (let count = values.filter(([drawn]) => drawn === kind).length; count < each; count++) values.push([kind, editorDraws[kind]()]);
    return values;
  };
  /** The editor's own draws take the spare ones first (then draw as usual). */
  const withSpare = run => {
    const outer = {...editorDraws};
    return withDraws(run, kind => {
      const at = spare.findIndex(([drawn]) => drawn === kind);
      return at >= 0 ? spare.splice(at, 1)[0][1] : outer[kind]();
    }).result;
  };
  /** Ends the edits the session holds before the editor runs a call of its own: they are the session's,
   * and the editor's code would not know to commit them. */
  const endSessionEdits = () => {
    if (editor._animationEdit?.engine) editor.commitAnimationEdit();
    if (editor._vfxClipEdit?.engine) editor.commitVfxClipEdit();
    if (editor._drag?.engine) editor.commitDrag();
  };
  /** Runs `name` in the JavaScript editor, which the session has no command for, and writes what it changed back. */
  const runInEditor = (name, original, args) => {
    // A session batch holds the entries recorded meanwhile as one; the editor's entry would be a child it cannot undo.
    if (batches > 0) throw refuse(name, 'a call the engine does not run inside a grouped edit');
    endSessionEdits();
    report.fallback++; (report.editor ??= {})[name] = (report.editor[name] ?? 0) + 1;
    const outer = captured === null;
    if (outer) captured = [];
    pending = true;
    depth++;
    let result, unsettled = false;
    const done = () => {
      depth--;
      if (outer) {
        const commands = captured; captured = null;
        writeBack(commands);
      }
    };
    try {
      result = spare.length ? withSpare(() => original.apply(editor, args)) : original.apply(editor, args);
      // An asynchronous call is one unit until it settles: calls made meanwhile run here too.
      if (typeof result?.then === 'function') { unsettled = true; return result.finally(done); }
    } finally { if (!unsettled) done(); }
    return result;
  };
  const writeBack = recorded => {
    if (recorded.length) hintsOf(recorded, hints ??= freshHints(), report);
    // An editor call may record a command and then fold it into the next one: only what is
    // still on the editor's stack, in its order, becomes the session's entries.
    const stack = new Set(editor._undo), commands = recorded.filter(command => stack.has(command)).sort((a, b) => editor._undo.indexOf(a) - editor._undo.indexOf(b));
    if (!commands.length) { flush(); return; }
    // One session entry per editor entry; the records changed go with the first. The
    // editor's stack already holds them all: it follows the session's once, at the end.
    writing = true;
    try {
      for (const command of commands) {
        const id = nextEntry++;
        entries.set(id, [command]);
        flush({entry: {id, label: command.label ?? '', bytes: command.bytes ?? 0, retained: retainedSources([command])}});
      }
    } finally { writing = false; }
    if (lastDepths) { depths = [editor._undo.length, editor._redo.length]; mirror({depths: lastDepths, state: null, revision: editor._revision}); lastDepths = null; }
  };
  /** A call the session refuses: counted, and raised as the error the interface shows. */
  const refuse = (name, reason) => {
    const key = `${name}: ${reason}`;
    report.refused[key] = (report.refused[key] ?? 0) + 1;
    return unsupported(name, reason);
  };
  const callSession = (name, original, args) => {
    const live = ensure();
    if (!live) return original.apply(editor, args);
    if (ENDS_EDIT[name] && !editor[ENDS_EDIT[name]]) { report.calls++; report.native++; return false; }
    const flushed = performance.now();
    flush();
    if (report.ms) report.ms.flush += performance.now() - flushed;
    if (PIXEL_CALLS.has(name)) return runInEditor(name, original, args);
    const payload = sessionPayload(args);
    if (payload === null) throw refuse(name, 'arguments that are not plain data');
    report.calls++;
    const timing = report.ms ??= {flush: 0, session: 0, parse: 0, adopt: 0, emit: 0};
    let mark = performance.now();
    let viewText = JSON.stringify({...view(), patch: true, changesOnly: true, draws: pool(), drawPool: true});
    report.capture?.push({name, args: payload, view: viewText});
    let text = live.call(name, payload, viewText);
    // A call that makes more identities than the pool holds (rippling the audio cuts many clips) changed nothing: it asks again with enough.
    if (text.includes('"unported"') && JSON.parse(text).reason?.startsWith('a call that draws more than the pool')) {
      viewText = JSON.stringify({...view(), patch: true, changesOnly: true, draws: pool(MANY_DRAWS), drawPool: true});
      text = live.call(name, payload, viewText);
    }
    const spent = performance.now() - mark;
    timing.session += spent; (timing.byMethod ??= {})[name] = (timing.byMethod[name] ?? 0) + spent; (timing.bytes ??= {})[name] = (timing.bytes[name] ?? 0) + text.length + viewText.length;
    mark = performance.now();
    const answer = JSON.parse(text);
    timing.parse += performance.now() - mark;
    // Draws the call did not take come first next time, so identities follow one sequence.
    spare = [];
    for (const pair of Array.isArray(answer.drawsLeft) ? answer.drawsLeft : []) if (spare.filter(([kind]) => kind === pair[0]).length < 4) spare.push(pair);
    report.trace?.push(`${name} -> ${answer.status} ${answer.reason ?? answer.error ?? ''} rev ${answer.revision} drag ${JSON.stringify(answer.drag)} draft ${JSON.stringify(answer.draft?.map(f => f.unique_id))} state ${JSON.stringify(answer.state).slice(0, 140)}`);
    if (answer.status === 'unported') {
      // The session answers a call it has no command for with the call's own name: the editor runs it.
      if (answer.reason === name) return runInEditor(name, original, args);
      throw refuse(name, answer.reason);
    }
    // A committed gesture's frame stays on show, as the session keeps it (`retained`),
    // until the session lets it go.
    mark = performance.now();
    const shown = answer.retained ? (editor._authoredPoseEdit?.frame ?? editor.evaluatedFrame) : null;
    const kept = answer.retainedKept ? editor._evaluated : null;
    adoptState(answer);
    if (answer.status === 'ok' && (name === 'beginVfxClipEdit' || name === 'beginAnimationEdit')) mirrorEdit(name, answer);
    if (answer.status === 'ok' && (name === 'copyAudioClip' || name === 'cutAudioClip')) editor._audioClipboard = AUDIO_COPIED;
    if (shown && !editor._authoredPoseEdit) { editor._evaluated = retainedShown = retainedFrame(answer, shown); editor._geometry = null; editor._incremental = null; }
    else if (kept && !editor._authoredPoseEdit && !editor._evaluated) { editor._evaluated = kept; }
    if (!answer.retained && !answer.retainedKept) retainedShown = null;
    if (answer.patch?.length) take();
    timing.adopt += performance.now() - mark; mark = performance.now();
    emit(answer);
    timing.emit += performance.now() - mark;
    check();
    if (answer.status === 'error') { report.errors = (report.errors ?? 0) + 1; throw failure(answer.error, answer.errorParams); }
    report.native++;
    return resultOf(name, answer);
  };
  /** `movieclipBatch(label, operation)`: the session records what `operation` does as one history entry. */
  const batchCall = (original, args) => {
    const [label, operation] = args;
    if (typeof operation !== 'function' || !ensure()) return original.apply(editor, args);
    callSession('beginBatch', original, [label]);
    batches++;
    let result;
    try { result = operation(); }
    catch (error) {
      batches--;
      try { callSession('abortBatch', original, []); } catch { /* the operation's own error is the one raised */ }
      throw error;
    }
    batches--;
    callSession('endBatch', original, []);
    return result;
  };

  /** Undo or redo: the session's entry, or the editor's own when it is on top. */
  const historyCall = (redo, args) => {
    const live = ensure();
    if (!live) return originals.get(redo ? 'redo' : 'undo').apply(editor, args);
    // As the editor's undo and redo begin.
    if (editor._vfxClipEdit) editor.cancelVfxClipEdit();
    if (editor._animationEdit) editor.cancelAnimationEdit();
    // Undo ends a gesture first. Redo leaves a pose gesture open under the entry it applies, as the editor's does; the session
    // does not redo under a motion-path edit, a rig edit or a camera drag, which end first as undo ends them.
    if (editor._drag && (!redo || editor._drag.motionPath || rigOrCamera)) editor.cancelDrag();
    flush();
    const historyView = JSON.stringify({...view(), patch: true});
    report.capture?.push({name: redo ? 'redo' : 'undo', args: '[]', view: historyView});
    const answer = JSON.parse(live.call(redo ? 'redo' : 'undo', '[]', historyView));
    if (answer.status === 'unported' && answer.reason?.startsWith(EXTERNAL_ENTRY)) {
      const id = Number(answer.reason.slice(EXTERNAL_ENTRY.length)), [command] = entries.get(id) ?? [];
      if (!command) throw new Error(`The editor has no history entry ${id}.`);
      if ((redo ? editor._redo : editor._undo).at(-1) !== command) throw new Error('The editor\'s history is out of step with the session\'s.');
      // The editor's own replay: drawing entries prepare their tiles first (it may wait),
      // and it moves the entry on the editor's stacks.
      depth++;
      let result;
      try { result = editor._drawingHistoryReplay(command, redo ? 'after' : 'before', args[0]?.signal); }
      catch (error) { depth--; throw error; }
      const finish = () => {
        depth--;
        hintsOf([command], hints ??= freshHints(), report);
        depths = [editor._undo.length, editor._redo.length];
        send('@externalDone', [id, redo, changes(), generated(), counters()]);
        take();
        check();
        return true;
      };
      if (typeof result?.then === 'function') return result.then(finish, error => { depth--; throw error; });
      return finish();
    }
    if (answer.status === 'unported') throw refuse(redo ? 'redo' : 'undo', answer.reason);
    if (answer.status !== 'ok') throw new Error(`The engine could not ${redo ? 'redo' : 'undo'}: ${answer.error ?? answer.reason}`);
    adoptState(answer);
    if (answer.patch?.length) take();
    emit(answer);
    check();
    return answer.result;
  };

  // --- installation ---------------------------------------------------------------------
  for (const name of ['seek', 'undo', 'redo', 'markSaved', '_record', '_pruneFrameSources']) originals.set(name, editor[name]);
  // The owner's methods live on a layer between the editor and its class: document
  // sessions (tabs) move the editor's own properties with each document, never these.
  const dirty = findGetter(editor, 'dirty');
  const getters = Object.fromEntries(['canUndo', 'canRedo', 'undoLabel', 'redoLabel'].map(name => [name, findGetter(editor, name)]));
  const listen = editor._emit;
  const layer = Object.create(Object.getPrototypeOf(editor));
  Object.setPrototypeOf(editor, layer);
  for (const name of new Set(methods)) {
    const original = editor[name];
    if (typeof original !== 'function' || VIEW_CALLS.has(name) || name === 'undo' || name === 'redo') continue;
    originals.set(name, original);
    layer[name] = function owned(...args) {
      // A call made by a call the editor runs belongs to it.
      if (depth > 0 || editor._movieclipScopes?.length) return original.apply(this, args);
      return name === 'movieclipBatch' ? batchCall(original, args) : callSession(name, original, args);
    };
  }
  layer.undo = function owned(...args) { return depth > 0 || editor._movieclipScopes?.length ? originals.get('undo').apply(this, args) : historyCall(false, args); };
  layer.redo = function owned(...args) { return depth > 0 || editor._movieclipScopes?.length ? originals.get('redo').apply(this, args) : historyCall(true, args); };
  // Entering a movieclip loads its own document into the editor before the scope is recorded: that document
  // gets no session (its calls run in the editor, which keeps its history and dirty state meanwhile).
  let entering = false;
  const enterMovieclip = editor.enterMovieclip;
  layer.enterMovieclip = function owned(...args) {
    entering = true;
    try { return enterMovieclip.apply(this, args); } finally { entering = false; }
  };
  layer.markSaved = function owned(...args) {
    const result = originals.get('markSaved').apply(this, args);
    if (session && document === editor.report) { send('@markSaved', []); history.dirty = false; }
    return result;
  };
  // The editor's own commands record into the session's history, through the entry
  // their call writes back; their bookkeeping (revision, weight) still runs here.
  layer._record = function owned(command) {
    // A command recorded as the editor comes back to a document (leaving a movieclip) belongs to that document's session.
    if (!editor._movieclipScopes?.length && depth === 0 && !applying && document !== editor.report) ensure();
    if (!session || document !== editor.report || editor._movieclipScopes?.length) return originals.get('_record').call(this, command);
    originals.get('_record').call(this, command);
    // Pushed (not folded into a batch still open): the session gets an entry for it. The editor's own trimming
    // may have retired older entries meanwhile (an entry heavier than the byte limit leaves only itself): the
    // session retires by its own weights, and the stacks follow it afterwards.
    const recorded = this._undo.at(-1) === command ? [command] : [];
    pending = true;
    if (captured) captured.push(...recorded);
    else if (recorded.length) writeBack(recorded);
  };
  // A drawing's encoded tiles attached to its definition in place (derived publication, no edit event): the session's copy gets them.
  layer._drawingPublished = function owned(figure) {
    if (!session || document !== editor.report) return;
    const index = editor.report.figure_types.indexOf(figure);
    if (index < 0) return;
    pending = true;
    (hints ??= freshHints()).figures.add(index);
    settle();
  };
  // Pose sources only history keeps alive are collected by the session, which holds history.
  layer._pruneFrameSources = function owned(...args) {
    if (!session || document !== editor.report) return originals.get('_pruneFrameSources').apply(this, args);
  };
  for (const [name, read] of Object.entries({
    canUndo: () => history.canUndo, canRedo: () => history.canRedo, undoLabel: () => history.undoLabel, redoLabel: () => history.redoLabel,
  })) {
    const prototype = getters[name];
    Object.defineProperty(layer, name, {configurable: true, get() { return session && document === editor.report && history ? read() : prototype.get.call(this); }});
  }
  Object.defineProperty(layer, 'dirty', {configurable: true,
    get() { return session && document === editor.report && history ? history.dirty || Boolean(this._drag?.changed || this._animationEdit?.changed) : dirty.get.call(this); },
    set(value) {
      dirty.set.call(this, value);
      // The next read of `dirty` is the session's: it has the new revision at once.
      if (value && idle()) flush();
    }});
  /**
   * The engine draws, plays and exports what its session holds, at the editor's revision. An edit made outside
   * the session's calls (a document marked as changed, a definition published after leaving a movieclip) reaches
   * it once the code that made it has finished, unless a gesture is open: that one ends in a call.
   */
  let settling = false;
  const idle = () => session && document === editor.report && depth === 0 && !applying && !editor._drag && !editor._animationEdit && !editor._authoredPoseEdit && !editor._vfxClipEdit;
  const settle = () => {
    if (settling) return;
    settling = true;
    queueMicrotask(() => {
      settling = false;
      if (!idle()) return;
      try { flush(); } catch (error) { report.broken = String(error?.message ?? error); }
    });
  };
  // Edits other modules make in place, or announce without a command.
  editor.addEventListener('change', event => {
    const detail = event.detail;
    if (detail?.kind === 'document') {
      report.log?.push(`document ${JSON.stringify(detail).slice(0, 120)} name ${editor.name} at ${Math.round(performance.now())}`);
      // The session exists from the moment the document opens (or comes back from a tab). A movieclip's own
      // document gets one as it loads (the stage draws the session's document), but its calls then run in the
      // editor (`_movieclipScopes`) and come back as one edit on leaving.
      if (!applying && depth === 0 && !entering && !editor._movieclipScopes?.length) ensure();
    }
    if (!session || document !== editor.report || depth > 0 || applying || !['edit', 'history', 'document'].includes(detail?.kind)) return;
    if (detail.kind === 'document') return;
    pending = true;
    hints ??= freshHints();
    for (const index of detail.figureIndices ?? []) hints.figures.add(index);
    for (const index of detail.frameIndices ?? []) hints.frames.add(index);
    for (const id of detail.sourceIds ?? []) hints.sources.add(id);
    if (detail.definition && !detail.figureIndices?.length) hints.allFigures = true;
    if (detail.label === 'Project metadata') hints.touched = true;
    settle();
  });
  // A call the editor runs names what it changed in place in its events.
  layer._emit = function owned(kind, detail = {}) {
    if (session && document === editor.report && depth > 0 && !applying && ['edit', 'history'].includes(kind)) {
      hints ??= freshHints();
      for (const index of detail.figureIndices ?? []) hints.figures.add(index);
      for (const index of detail.frameIndices ?? []) hints.frames.add(index);
      for (const id of detail.sourceIds ?? []) hints.sources.add(id);
      if (detail.definition && !detail.figureIndices?.length) hints.allFigures = true;
      // A live edit changes the shown keyframe's poses in place (native timelines).
      if (detail.live || detail.changedUids) hints.frames.add(editor._drag?.index ?? editor.frameIndex);
    }
    return listen.call(this, kind, detail);
  };
  report.flush = () => flush();
  report.depths = () => depths;
  /** Whether the session holds the open document (starting it if it can). */
  report.ready = () => Boolean(ensure());
  report.session = () => session;
  report.release = () => { session?.free(); session = null; document = null; for (const value of parked.values()) value.session.free(); parked.clear(); };
  return report;
}

/** The frame the session keeps on show after a commit: its changed figures (and fields)
 * over the frame that was on show. */
function retainedFrame(answer, drafted) {
  const byUid = new Map(drafted.objects.map(object => [object.unique_id, object]));
  for (const object of answer.retained) if (byUid.get(object.unique_id)?._movieclipSample !== undefined) object._movieclipSample = byUid.get(object.unique_id)._movieclipSample;
  let objects = answer.retained;
  if (answer.retainedChanges) {
    for (const object of answer.retained) byUid.set(object.unique_id, object);
    objects = (answer.retainedOrder ?? drafted.objects.map(object => object.unique_id)).map(uid => byUid.get(uid));
  }
  let frame = {...drafted, ...answer.retainedFields, objects};
  for (const key of answer.retainedRemoved ?? []) delete frame[key];
  if (answer.retainedFieldOrder) {
    const fields = new Set(answer.retainedFieldOrder);
    frame = {...Object.fromEntries(answer.retainedFieldOrder.map(key => [key, frame[key]])), ...Object.fromEntries(Object.entries(frame).filter(([key]) => !fields.has(key)))};
  }
  return frame;
}

/** The frame a layer sheet's property edit previews: the changes over the frame it began on
 * (the figures that changed, the order, the other fields), as a retained frame is laid. */
function previewFrame({figures, order, fields, removed, fieldOrder}, base) {
  return retainedFrame({retained: figures, retainedChanges: true, retainedOrder: order, retainedFields: fields, retainedRemoved: removed, retainedFieldOrder: fieldOrder}, base);
}

const freshHints = () => ({figures: new Set(), frames: new Set(), backgrounds: new Set(), sources: new Set(), styk: new Set()});

/** The records the editor's history commands changed in place, by kind. */
function hintsOf(commands, into, report) {
  const frames = entries => { for (const entry of entries ?? []) { if (entry?.sourceId) into.sources.add(entry.sourceId); else if (Number.isInteger(entry?.index)) into.frames.add(entry.index); } };
  for (const command of commands) {
    for (const change of command.frameSourceChanges ?? []) into.sources.add(change.id);
    switch (command.kind) {
      case 'movieclip-batch': hintsOf(command.commands ?? [], into, report); break;
      case 'objects': case 'frame': case 'project': case 'figure-splice': into.frames.add(command.index); break;
      case 'import': into.frames.add(command.index); into.allFigures = true; break;
      case 'figure': case 'native-properties': case 'movieclip-definition': into.figures.add(command.index); break;
      case 'topology': case 'movieclip-poses':
        if (Number.isInteger(command.index)) into.figures.add(command.index);
        for (const side of ['before', 'after']) frames(command[side]?.frames);
        break;
      case 'camera': for (const side of ['before', 'after']) frames(command[side]); break;
      case 'frame-timing': case 'figure-range': for (const change of command.changes ?? []) if (Number.isInteger(change.index)) into.frames.add(change.index); break;
      case 'scene': into.allBackgrounds = true; into.allFrames = true; break;
      case 'disconnect': into.allFrames = true; into.allFigures = true; break;
      // These replace their records (or table) by identity, or change compared metadata.
      case 'ranges': case 'splice': case 'layers': case 'layer-sheet': case 'animation': case 'camera-motion': case 'vfx-clips': case 'palette': case 'audio': case 'fields': break;
      default:
        into.all = true;
        report.unknownKinds = [...new Set([...(report.unknownKinds ?? []), command.kind])];
    }
  }
}

/** A value an engine error names, as the editor's message takes it: a field label or camera-motion parameter the
 * interface translates, else the value itself. */
function errorParam(value) {
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, '@label')) return validationLabel(value['@label']);
    if (Object.hasOwn(value, '@motionParameter')) return {messageKey: motionParameterMessages[value['@motionParameter'].key], diagnosticValue: value['@motionParameter'].label};
    if (Object.hasOwn(value, '@message')) return {messageKey: value['@message'], diagnosticValue: english[value['@message']]};
    if (Object.hasOwn(value, '@vfxParameter')) {
      const {type, param} = value['@vfxParameter'], messageKey = param === 'enabled' ? 'vfxChannels.enabled' : `vfxCatalog.parameter.${type}.${param}.label`;
      return {messageKey, diagnosticValue: english[messageKey] ?? param};
    }
  }
  return value;
}

/** The editor's error for an engine refusal: a message key and the values the message names. A message that needs a
 * value the engine did not name says only that a value is not valid (`error.unnamed` holds the message it stands for). */
function failure(error, params) {
  try {
    const values = Object.fromEntries(Object.entries(params ?? {}).map(([name, value]) => [name, errorParam(value)]));
    const needed = [...String(english[error] ?? '').matchAll(/\{([A-Za-z]\w*)\}/g)].map(match => match[1]);
    if (needed.some(name => !Object.hasOwn(values, name))) return Object.assign(messageError(new Error(''), 'errors.engineOwner.invalidValue', {}), {unnamed: error});
    return messageError(new Error(''), error, values);
  } catch { return new Error(error); }
}

/** The error for a call the session refuses (a document it does not edit yet): the call ran nowhere. */
function unsupported(name, reason) {
  const error = messageError(new Error(''), 'errors.engineOwner.notSupported', {});
  error.reason = `${name}: ${reason}`;
  return error;
}

function findGetter(object, name) {
  for (let prototype = Object.getPrototypeOf(object); prototype; prototype = Object.getPrototypeOf(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor) return descriptor;
  }
  throw new Error(`The editor has no ${name}.`);
}

/** The pose sources the editor's commands keep alive (`_pruneFrameSources`). */
function retainedSources(commands) {
  const ids = new Set();
  const visit = command => {
    if (command.kind === 'movieclip-batch') { for (const child of command.commands ?? []) visit(child); return; }
    for (const id of command.retainedFrameSourceIds ?? []) ids.add(id);
    for (const change of command.frameSourceChanges ?? []) ids.add(change.id);
    for (const side of ['before', 'after']) {
      if (command.kind === 'topology' || command.kind === 'movieclip-poses') for (const entry of command[side]?.frames ?? []) if (entry.sourceId) ids.add(entry.sourceId);
      const sheet = command.kind === 'layer-sheet' ? command[side] : null;
      for (const track of Object.values(sheet?.tracks ?? {})) for (const key of track.keys ?? []) {
        if (key.value?.frameId) ids.add(key.value.frameId);
        for (const patch of key.movieclipPatches ?? []) if (patch.frameId) ids.add(patch.frameId);
      }
    }
  };
  for (const command of commands) visit(command);
  return [...ids];
}

/**
 * The session of the document the editor just opened: started from the opening the engine made it with, on
 * the tree the editor's read view was built from, so nothing is converted again. Null when the document
 * has no opening (its session was started already).
 */
export function openingSession(editor) {
  const opening = editor._opening;
  if (!opening) return null;
  const session = opening.startSession({tick: editor.tick, frameIndex: editor.frameIndex, selectedUid: editor.selectedUid ?? null,
    selectedUids: [...editor.selectedUids], selectedJoint: editor.selectedJoint ?? -1, activeLayerId: editor.activeLayerId, autoKey: Boolean(editor.autoKey),
    layerRevision: editor.layerRevision, nextFrameIdentity: editor._nextFrameIdentity, nextUid: editor._nextUid,
    propertyChannels: Boolean(editor.propertyChannels), layerTimeline: Boolean(editor.layerTimeline)});
  editor._opening = null;
  return session;
}
