/**
 * The engine owns the open document (D19, docs/engine/editing.md "Phase 3").
 *
 * One styk-edit session per document holds the document and its history. Every call of the editor that changes the document
 * runs in the session (`SESSION_COMMANDS`, engine-commands.mjs); its answer carries a patch that this module applies
 * copy-on-write to `editor.report`, which the interface keeps reading as a read view, then the session's selection, counters and
 * change events. Nothing writes to the read view but those patches: a call the session refuses for this document or selection,
 * or has no command for, raises the refusal (`errors.engineOwner.notSupported`, counted in `report.refused`) and changes nothing,
 * and no code outside the session changes a record in place. What else tells the session something is bookkeeping, not an edit
 * (`@markSaved`, `@touch`, `@publishCel`, the drawing weights: `owner.rs`).
 *
 * Entering a movieclip loads the clip's own document into the editor, and it gets a session of its own like any
 * document: the parent's session stays parked with its history, and every call, read and undo inside the clip is
 * the clip's session's, with a history and unsaved state of its own. Leaving it frees the clip's session and the
 * parent's takes the edit as one `Edit movieclip` entry (`publishMovieclipEdit`).
 *
 * Calls that only move the view (selecting, seeking) stay with the editor; the session
 * receives the view with every call. A drawing's pixel commits (`commitDrawingPixels`, `resampleDrawing`) are the session's too:
 * its entries name the cel and the record of the interface's drawing store and history that hold the tiles, which
 * `engine-owner-drawing.mjs` applies around the call.
 *
 * The clipboards the session's copies fill are shown in the editor's clipboard fields, which the interface reads and
 * writes, and reach the session before the call that pastes them (`engine-clipboards.mjs`).
 *
 * The editor's reads of the frame on show (`evaluatedFrame`, `geometry`, `timeline`) and a few of its own
 * (`SESSION_READS`) are answered by the session too (`engine-shown.mjs`, docs/engine/evaluation.md).
 *
 * In tests `verify` compares the session's document with the read view after every call: a record some other code changed in
 * place shows as a difference.
 */
import {applyDocumentPatch} from './engine-patch.mjs';
import {payloadText} from './engine-open.mjs';
import {messageError} from '../localized-error.mjs';
import {validationLabel} from '../validation-labels.mjs';
import {motionParameterMessages} from '../camera-motion-localization.mjs';
import english from '../locales/en.mjs';
import {invalidateFrameIndex} from '../frame-ids.mjs';
import {layerIdForUid} from '../layers.mjs';
import {drawingMetadata} from '../drawing-model.mjs';
import {drawingResourcesFor} from '../drawing-resources.mjs';
import {editorDraws} from '../editor-draws.mjs';
import {createOwnedDrawings, DRAWING_COMMITS} from './engine-owner-drawing.mjs';
import {appBoundsMarker} from './engine-edit-bounds.mjs';
import {createShown} from './engine-shown.mjs';
import {createClipboards} from './engine-clipboards.mjs';
import {SESSION_COMMANDS, VIEW_CALLS} from './engine-commands.mjs';
import {yieldLoadTask} from '../yield-task.mjs';

/** How many values of each kind a call that draws many identities is handed. */
const MANY_DRAWS = 512;

/** How long one slice of a bake may take: the interface thread is given back between slices. */
const BAKE_SLICE_MS = 6;

/** The calls that end an edit, and the editor's field that holds it: with none open they change
 * nothing and answer false, which the owner knows without asking the session. */
const ENDS_EDIT = {commitVfxClipEdit: '_vfxClipEdit', cancelVfxClipEdit: '_vfxClipEdit', commitAnimationEdit: '_animationEdit', cancelAnimationEdit: '_animationEdit'};

/** The editor's reads the session answers (`Editor::interface_query`): the values the interface shows of the frame on show,
 * from the engine's own evaluation. */
const SESSION_READS = ['animationValue', 'vfxEffects', 'segmentAnimationTarget', 'getIKSettings', 'getSpatialPose', 'getSpatialMotion', 'sampleVfxClip'];
/** Where the values a refusal names start in its message (`styk_edit::PARAMS`). */
const PARAMS = '\u001f';

/**
 * A call's arguments as text for the session. Frame ranges keep their `sheetTicks`, and the app's figure-bounds callback is the
 * marker the engine measures for itself (engine-edit-bounds.mjs). Any other function, or what JSON cannot hold, is not data:
 * `null`. A `Set` (the selected segments) is the list of its members. What JSON would lose is encoded for the session
 * (`styk-edit/src/args.rs`): an object member that is `undefined` (a command may remove what it names) and a number that is not
 * finite (the editor's own validation refuses it); `encoded` says the session has to decode them. Trailing arguments that are
 * `undefined` are not sent: the call is the editor's call without them, whose parameters then take their defaults (JSON would
 * have made each one `null`, which a command can read as a value: no folder, no layer).
 * @returns {{text: string, encoded: boolean}|null}
 */
function sessionPayload(args) {
  let data = true, encoded = false;
  const replacer = function (key, value) {
    if (typeof value === 'function') { const marker = appBoundsMarker(value); data &&= Boolean(marker); return marker; }
    if (typeof value === 'number' && !Number.isFinite(value)) { encoded = true; return {'@number': String(value)}; }
    if (value === undefined && !Array.isArray(this)) { encoded = true; return {'@undefined': true}; }
    return value instanceof Set ? [...value] : Array.isArray(value) && Object.hasOwn(value, 'sheetTicks') ? {'@array': [...value], sheetTicks: value.sheetTicks} : value;
  };
  let count = args.length;
  while (count && args[count - 1] === undefined) count--;
  try { const text = JSON.stringify(count === args.length ? args : args.slice(0, count), replacer); return data ? {text, encoded} : null; } catch { return null; }
}
const selectionMetadata = state => Object.fromEntries(['polygonSelection', 'segmentIds', 'branch'].filter(key => Object.hasOwn(state, key)).map(key => [key, state[key]]));

/** The owner installed on each editor (tests that hold several documents open make one the engine's again before exporting it). */
const installed = new WeakMap();
export const ownerOf = editor => installed.get(editor);

/** How each document a session holds (the open one, a parked tab's, the one a movieclip was entered from) hands it over for a save. */
const handovers = new WeakMap();
/**
 * Hands the document the interface reads as `document` over for a save: a token naming the tree its session holds at this
 * moment (`EditSession.snapshot`), which the export worker writes while the session goes on editing. `undefined` when no
 * session holds it. The saver takes the token, or lets go of it (`releaseSnapshots`).
 */
export const snapshotDocument = document => handovers.get(document)?.(document);

/**
 * @param {object} editor the app's Editor
 * @param {{start?(editor): object|null, verify?: boolean, draws?(): Array, detached?: boolean}} options
 *   `start` gives the session that edits the document the editor just opened (by default the one the
 *   engine opened it with: `openingSession`), `verify` compares the session's document with the read view after
 *   every call (tests), `draws` supplies the random values a call may take (D18).
 *   `detached`: the editor's document is not the engine's (the rig test's own editor beside the open project): its session
 *   answers the editor's reads and calls but the stage, playback and exports keep the project's.
 */
export function installEngineOwner(editor, {start = openingSession, verify = false, draws = null, detached = false} = {}) {
  const report = {calls: 0, native: 0, refused: {}, errors: 0, verified: 0};
  let session = null, document = null, history = null, spare = [];
  /** How many `movieclipBatch` operations the owner is running: the session records them as one entry. */
  let batches = 0;

  const view = () => ({tick: editor.tick, frameIndex: editor.frameIndex, selectedUid: editor.selectedUid ?? null, selectedUids: [...(editor.selectedUids ?? [])], layerFocusLock: editor.layerFocusLock(), // the layers Focus and lock leaves free: the session locks the rest for the call
    selectedJoint: editor.selectedJoint ?? -1, activeLayerId: editor.activeLayerId, autoKey: Boolean(editor.autoKey), audioRipple: Boolean(editor.audioRipple),
    sheetSelection: editor._sheetSelection ? {id: editor._sheetSelection.id, contents: Boolean(editor._sheetSelection.contents)} : null,
    ...selectionMetadata(editor._selectionState())});

  // --- what the interface reads of the frame on show ----------------------------------
  /** How many answers are being applied: the session is the editor's source of truth meanwhile, so a read does not tell it
   * the editor's view (the selection is applied after the playhead). */
  let adopting = 0;
  /** Whether the session answers for the editor's document. */
  const reading = () => document === editor.report || Boolean(ensure());
  /** Where the playhead is: the session needs no more to say what the frame on show is (the selection is the editor's to
   * tell with a call, and asking for it here would read the frame on show). */
  const playhead = () => JSON.stringify({tick: editor.tick, frameIndex: editor.frameIndex});
  const shown = createShown({
    ask(kind, args) {
      if (!reading()) return null;
      if (kind === 'active') return 'true';
      try { return session.query(kind, JSON.stringify(args), adopting ? 'null' : playhead()); }
      catch (error) { throw queryFailure(error); }
    },
    source(motion) {
      if (!reading()) return null;
      return {session, view: playhead(), motion};
    },
    report: () => editor.report,
  });
  /** The frame a gesture or an edit is composed on: the one on show before it began. */
  const baseFrame = () => editor._sheetPropertyPreview ?? editor._documentFrame();

  const check = () => {
    if (!verify || !session) return;
    const engine = session.report_json(), view = JSON.stringify(editor.report);
    if (engine !== view) {
      let at = 0; while (engine[at] === view[at]) at++;
      throw new Error(`The engine's document differs from the read view at ${at}: engine …${engine.slice(Math.max(0, at - 60), at + 60)}… view …${view.slice(Math.max(0, at - 60), at + 60)}…`);
    }
    report.verified++;
  };
  /** A bookkeeping call of the owner (`owner.rs`): not an edit, no history entry. `patch`: the answer's document changes reach the read
   * view, as a call's do (a call that retires history entries collects their pose sources). */
  const send = (method, args, {patch = false} = {}) => {
    const answer = JSON.parse(session.call(method, JSON.stringify(args), JSON.stringify({...view(), patch: true})));
    if (answer.status !== 'ok') throw new Error(`The engine refused the owner's ${method}: ${answer.error ?? answer.reason}`);
    adoptState(answer, {patch});
    return answer;
  };

  // --- answers ------------------------------------------------------------------------
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
    editor._layerDescriptors = null; editor._layerUidArrays = new Map();
  };
  const applyAnswer = (answer, {patch = true} = {}) => {
    const {state} = answer;
    if (patch && answer.patch?.length) {
      const before = posesBefore(), layers = new Set(Object.keys(editor.report._styk?.layers?.byId ?? {}));
      applyDocumentPatch(editor.report, answer.patch, answer.payloads ? payloadText : null);
      refresh(answer.patch, before);
      // A layer a call creates joins the layer focus the editor holds (the session left it free as it made it).
      editor._includeCreatedLayersInFocus(Object.keys(editor.report._styk?.layers?.byId ?? {}).filter(id => !layers.has(id)));
      editor._invalidate({timing: true});
    }
    // The playhead first: the selection belongs to the frame it shows. Set as history
    // sets it: the editor's seek would also end a gesture the session keeps going.
    if (state && (state.tick !== editor.tick || state.frameIndex !== editor.frameIndex)) {
      editor.tick = state.tick; editor.frameIndex = state.frameIndex; editor._invalidate();
    }
    if (answer.motionPathError) throw new Error(`The engine could not show the motion-path edit: ${answer.motionPathError}`);
    if (Object.hasOwn(answer, 'drag')) gesture(answer);
    if (Object.hasOwn(answer, 'handleGesture')) handles(answer);
    edits(answer);
    if (state) {
      history = {canUndo: state.canUndo, canRedo: state.canRedo, undoLabel: state.undoLabel, redoLabel: state.redoLabel, dirty: state.dirty};
      editor._nextUid = state.nextUid; editor._nextFrameIdentity = state.nextFrameIdentity; editor._layerRevision = state.layerRevision;
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
    if (Array.isArray(answer.depths)) mirror(answer);
    if (answer.drawingRetired) retired();
    if (Number.isFinite(answer.revision)) {
      editor._revision = answer.revision;
      editor._revisionSerial = Math.max(editor._revisionSerial ?? 0, answer.revision);
    }
  };
  const adoptState = (answer, options) => {
    adopting++;
    try { applyAnswer(answer, options); } finally { adopting--; }
  };
  /** The editor's history stacks follow the session's: placeholders for its entries, so the editor's code that
   * reads the stacks' depth keeps working. */
  let depths = [0, 0];
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
      const source = base ?? baseFrame();
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
    let built = null, displayed = null;
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
        if (displayed?.report !== report || displayed.tick !== editor.tick || displayed.range !== this.range) displayed = {report, tick: editor.tick, range: this.range, display: motionDisplay()};
        return displayed.display;
      }},
    });
    return drag;
  };
  /** The pose the session shows at the playhead while the motion-path edit changes it, with the geometry of that pose
   * (read when something needs it), or null outside the ticks it changes. */
  const motionDisplay = () => {
    const frame = shown.motionFrame();
    if (!frame) return null;
    let geometry;
    return {frame, get geometry() { return geometry ??= shown.geometry(frame, {motion: true}); }};
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
      drag.cameraBase ??= baseFrame();
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
    // An edit of several targets (a branch, a draw order) names them all (`targets`) and holds a value for each.
    const {target, targets, property, exactTarget, tick, initialValue, changed} = opened, edit = {engine: true, target, ...(targets ? {targets} : {}), property, exactTarget, tick, initialValue, selection: editor._selectionState(), changed};
    editor._animationEdit = opened.sheet ? Object.assign(edit, {sheet: true, value: opened.value, frame: baseFrame()}) : edit;
  };
  /** The session's change events, for the interface: they describe what the session already has. */
  const emit = answer => {
    const events = answer.events ?? [];
    if (!events.length) return;
    for (const {kind, frameIndex, tick, ...detail} of events) editor._emit(kind, kind === 'seek' ? {} : detail);
  };
  /** What a call returns when its answer is a view the editor holds. */
  const resultOf = (name, answer) => {
    if (['duplicateFigure', 'addFigure', 'importFigure'].includes(name)) return editor.object;
    // What was pasted is what is selected, unless nothing was (the session answers an empty list then).
    if (name === 'pasteSelection' || name === 'duplicateSelection') return answer.result?.length === 0 ? [] : editor.selectedObjects;
    if (name === 'sheetAppendFrame') return editor.evaluatedFrame;
    // The timeline's copy answers with the clipboard it filled, which the answer carried (the filmstrip and the shared clipboard take it as done).
    if (name === 'sheetCopyFrames') return editor._sheetClipboard;
    if (name === 'beginAnimationEdit') return editor._animationEdit;
    if (name === 'beginVfxClipEdit') return undefined;
    if ((name === 'createLayer' || name === 'createDrawingLayer') && answer.result?.id) return editor.getLayer(answer.result.id);
    return answer.result;
  };

  // --- calls ----------------------------------------------------------------------------
  /** Sessions of the documents open beside this one (editor sessions, tabs), by document. */
  const parked = new Map();
  const park = () => {
    if (!session) return;
    parked.set(document, {session, depths, history});
    session = null; document = null;
  };
  /** A clipboard the editor only shows a marker of, read from the session that holds it. */
  const readClipboard = (holder, kind) => JSON.parse(holder.query('clipboard', JSON.stringify([kind]), 'null')).v;
  /** Frees a session that is closed. The clipboards read what they keep in it first (a copied audio clip's recording) and name
   * it no more, so a freed session is never called. Every session of a closed project or a left movieclip ends here. */
  const end = ended => {
    try { clipboards.surrender(ended, readClipboard); } finally { ended.free(); }
  };
  /** Ends the session of a document that is closed (or a movieclip that is left), whether it is the open one or parked. */
  const forget = closed => {
    let ended = null;
    if (document === closed) { ended = session; session = null; document = null; }
    else { ended = parked.get(closed)?.session; parked.delete(closed); }
    if (ended) end(ended);
  };
  /** The token of the tree the session of document `held` holds, the open one or a parked one. */
  const handOver = held => (document === held ? session : parked.get(held)?.session)?.snapshot();
  const call = (method, args) => {
    const answer = JSON.parse(session.call(method, JSON.stringify(args), JSON.stringify(view())));
    if (answer.status !== 'ok') throw new Error(`${method}: ${answer.error ?? answer.reason}`);
    return answer;
  };
  /** Makes the session's document the engine's: the stage draws it, playback and exports read it. */
  const activate = () => detached ? undefined : session.activate(editor.revision);
  const ensure = () => {
    if (session && document === editor.report) return session;
    park();
    // The groups the interface holds are another session's.
    shown.release();
    const resumed = parked.get(editor.report);
    if (resumed) {
      parked.delete(editor.report);
      ({session} = resumed); document = editor.report; handovers.set(document, handOver);
      ({depths, history} = resumed);
      // Revisions never repeat across the documents one editor holds (editor-sessions.mjs): the editor's numbering went on meanwhile.
      call('@revisions', [null, editor._revisionSerial, null]);
      activate();
      return session;
    }
    let started = null;
    try { started = start(editor); } catch (error) { report.broken = String(error.message ?? error); }
    if (!started) return null;
    session = started; document = editor.report; handovers.set(document, handOver);
    depths = [0, 0];
    try {
      call('@historyLimits', [editor.historyLimit, editor.historyBytes]);
      call('@revisions', [editor._revision, editor._revisionSerial, editor._savedRevision]);
      history = {canUndo: false, canRedo: false, undoLabel: '', redoLabel: '', dirty: editor._revision !== editor._savedRevision};
      activate();
      check();
    } catch (error) {
      const failed = session; session = null; document = null;
      failed.free();
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
  /** Ends the edits the session holds before a drawing's pixels are committed: the commit is not part of them. */
  const endSessionEdits = () => {
    // The session ends them itself: one it refuses to commit is cancelled.
    const end = (commit, cancel) => { try { commit(); } catch { cancel(); } };
    if (editor._animationEdit?.engine) end(() => editor.commitAnimationEdit(), () => editor.cancelAnimationEdit());
    if (editor._vfxClipEdit?.engine) end(() => editor.commitVfxClipEdit(), () => editor.cancelVfxClipEdit());
    if (editor._drag?.engine) end(() => editor.commitDrag(), () => editor.cancelDrag());
  };
  /** The cels a call copied take the pixels of the cels they copy: the interface holds the pixels, not the session. */
  const forkDrawings = forks => {
    const cels = new Map(editor.report.figure_types.filter(drawingMetadata).map(figure => [drawingMetadata(figure).celId, figure]));
    for (const [from, to] of forks) {
      const old = cels.get(from), copy = cels.get(to);
      if (old && copy) editor.drawingResources.fork(old, copy);
    }
  };
  /** A call the session refuses: counted, and raised as the error the interface shows. */
  const refuse = (name, reason) => {
    const key = `${name}: ${reason}`;
    report.refused[key] = (report.refused[key] ?? 0) + 1;
    return unsupported(name, reason);
  };
  /** `drawing`: the pixel step of a drawing commit (engine-owner-drawing.mjs): it runs once the answer is adopted, before the events. */
  const callSession = (name, args, drawing = null) => {
    const live = ensure();
    if (!live) throw refuse(name, 'no engine session runs this document');
    if (ENDS_EDIT[name] && !editor[ENDS_EDIT[name]]) { report.calls++; report.native++; return false; }
    // The session ends the edits it holds before a drawing's pixels are committed.
    if (drawing) endSessionEdits();
    // A clip takes the pixels its drawings' definitions carry: strokes not yet published would be left out of it.
    if (name === 'createMovieclip' && drawingResourcesFor(editor.report)?.stats.unpublished) throw messageError(new Error(''), 'errors.editorMovieclips.finishDrawingPublicationBeforeCreatingAMovieclip', {});
    // The clipboards the call pastes are the session's: the ones the interface wrote or another project copied reach it first.
    clipboards.handOver(name, live, (kind, data, foreign) => {
      const handed = JSON.parse(live.call('@setClipboard', JSON.stringify([kind, data, foreign]), JSON.stringify(view())));
      if (handed.status === 'error') throw failure(handed.error, handed.errorParams);
      if (handed.status !== 'ok') throw new Error(`The engine did not take the ${kind} clipboard: ${handed.reason}`);
    }, readClipboard);
    const payload = sessionPayload(args);
    if (payload === null) throw refuse(name, 'arguments that are not plain data');
    report.calls++;
    // A paste says how often the figures were pasted, which sets where the next paste lands.
    const pastes = name === 'pasteSelection' ? {figureClipboardPastes: true} : {};
    const encoded = payload.encoded ? {encoded: true} : {};
    const viewText = more => JSON.stringify({...view(), patch: true, changesOnly: true, draws: pool(more), drawPool: true, ...pastes, ...encoded});
    let text = live.call(name, payload.text, viewText());
    // A call that makes more identities than the pool holds (rippling the audio cuts many clips) changed nothing: it asks again with enough.
    if (text.includes('"unported"') && JSON.parse(text).reason?.startsWith('a call that draws more than the pool')) text = live.call(name, payload.text, viewText(MANY_DRAWS));
    const answer = JSON.parse(text);
    // Draws the call did not take come first next time, so identities follow one sequence.
    spare = [];
    for (const pair of Array.isArray(answer.drawsLeft) ? answer.drawsLeft : []) if (spare.filter(([kind]) => kind === pair[0]).length < 4) spare.push(pair);
    // A call the session has no command for (answered with the call's own name), or refuses for this document or selection.
    if (answer.status === 'unported') throw refuse(name, answer.reason);
    // A committed gesture's frame stays on show, as the session keeps it (`retained`),
    // until the session lets it go.
    const drafted = answer.retained ? (editor._authoredPoseEdit?.frame ?? baseFrame()) : null;
    const kept = answer.retainedKept ? editor._evaluated : null;
    adoptState(answer);
    if (answer.clipboard) clipboards.adopt(answer.clipboard, live);
    if (answer.figureClipboardPastes) clipboards.pasted(answer.figureClipboardPastes);
    if (answer.drawingForks?.length) forkDrawings(answer.drawingForks);
    if (answer.status === 'ok' && (name === 'beginVfxClipEdit' || name === 'beginAnimationEdit')) mirrorEdit(name, answer);
    if (drafted && !editor._authoredPoseEdit) { editor._evaluated = retainedShown = retainedFrame(answer, drafted); editor._geometry = null; }
    else if (kept && !editor._authoredPoseEdit && !editor._evaluated) { editor._evaluated = kept; }
    if (!answer.retained && !answer.retainedKept) retainedShown = null;
    if (drawing && answer.status === 'ok') drawing.adopted(answer);
    emit(answer);
    check();
    if (answer.status === 'error') { report.errors++; throw failure(answer.error, answer.errorParams); }
    report.native++;
    return resultOf(name, answer);
  };
  /** The frame the session retained, while the editor still shows it. */
  let retainedShown = null;
  /** `bakeMovieclip()`: the session samples the clip in slices (`bakeMovieclipBegin`, `bakeMovieclipSample`, `bakeMovieclipPublish`,
   * `movieclip_bake.rs`) and the interface gets the thread back between them (D7), so the sampling of a long clip does not hold it. Each slice is
   * sized from how long the last one took. Publication is one step (0.2 to 2.6 s on large documents, docs/engine/editing.md). An edit between
   * slices ends the bake, as the session ends its job. */
  const bakeCall = async () => {
    callSession('bakeMovieclipBegin', []);
    const report = editor.report, revision = editor.revision;
    let slice = 1, done = false;
    try {
      while (!done) {
        const started = performance.now();
        ({done} = callSession('bakeMovieclipSample', [slice]));
        const took = Math.max(performance.now() - started, 0.25);
        slice = Math.max(1, Math.min(slice * 2, Math.round(slice * BAKE_SLICE_MS / took), 1024));
        if (done) break;
        await yieldLoadTask();
        if (editor.report !== report || editor.revision !== revision) throw messageError(new Error(''), 'errors.editorMovieclips.theSceneChangedWhileBakingTryAgain', {});
      }
      return callSession('bakeMovieclipPublish', []);
    } catch (error) {
      if (editor.report === report) { try { callSession('bakeMovieclipCancel', []); } catch { /* the bake's own error is the one raised */ } }
      throw error;
    }
  };

  /** `movieclipBatch(label, operation)`: the session records what `operation` does as one history entry. */
  const batchCall = args => {
    const [label, operation] = args;
    if (typeof operation !== 'function') throw refuse('movieclipBatch', 'an operation that is not a function');
    callSession('beginBatch', [label]);
    batches++;
    let result;
    try { result = operation(); }
    catch (error) {
      batches--;
      // The session's abort takes back the group's entries; the pixels of its drawing commits go back with them.
      try { drawings.abortBatch(); } catch { /* the operation's own error is the one raised */ }
      try { callSession('abortBatch', []); } catch { /* the operation's own error is the one raised */ }
      throw error;
    }
    batches--;
    callSession('endBatch', []);
    return result;
  };

  /** Undo or redo: the session's entry. */
  const historyCall = (redo, args) => {
    const live = ensure();
    if (!live) throw refuse(redo ? 'redo' : 'undo', 'no engine session runs this document');
    // As the editor's undo and redo begin.
    if (editor._vfxClipEdit) editor.cancelVfxClipEdit();
    if (editor._animationEdit) editor.cancelAnimationEdit();
    // Undo ends a gesture first. Redo leaves a pose gesture open under the entry it applies, as the editor's does; the session
    // does not redo under a motion-path edit, a rig edit or a camera drag, which end first as undo ends them.
    if (editor._drag && (!redo || editor._drag.motionPath || rigOrCamera)) editor.cancelDrag();
    // An entry that names pixel commits waits for its pixels (they may be on the disk) and applies them with the session's step.
    return drawings.replay(redo, args[0]?.signal, pixels => perform(live, redo, pixels));
  };
  /** The session's undo or redo and the adoption of its answer; `pixels` applies the drawing store's tiles before the events. */
  const perform = (live, redo, pixels) => {
    const answer = JSON.parse(live.call(redo ? 'redo' : 'undo', '[]', JSON.stringify({...view(), patch: true})));
    if (answer.status === 'unported') throw refuse(redo ? 'redo' : 'undo', answer.reason);
    if (answer.status !== 'ok') throw new Error(`The engine could not ${redo ? 'redo' : 'undo'}: ${answer.error ?? answer.reason}`);
    adoptState(answer);
    pixels?.(answer);
    emit(answer);
    check();
    return answer.result;
  };

  // --- installation ---------------------------------------------------------------------
  // The interface's half of the drawing pixel commits (a cel's tiles live in the drawing store, not in the session).
  const drawings = createOwnedDrawings(editor, {
    live: () => ensure(),
    call: (name, args, step) => callSession(name, args, step),
    adjust(record, delta) {
      if (session && document === editor.report) { send('@drawingBytes', [record, delta], {patch: true}); check(); }
    },
    // The commit's pixels could not be applied: the session takes its entry back.
    retract(record) {
      send('@retractDrawing', [record], {patch: true});
      check();
    },
    // Cel definitions changed in place (revision, bounds): the session's copies follow at once.
    synced(figures) { for (const figure of figures) editor._drawingPublished(figure); },
  });
  /** A call retired a history entry that referred to drawings: the store lets go of what no entry refers to, once the call has ended. */
  let collecting = false;
  const retired = () => {
    if (collecting) return;
    collecting = true;
    queueMicrotask(() => { collecting = false; if (session && document === editor.report) editor._collectDrawingHistory(); });
  };
  const originalMarkSaved = editor.markSaved;
  // The owner's methods live on a layer between the editor and its class: document
  // sessions (tabs) move the editor's own properties with each document, never these.
  const dirty = findGetter(editor, 'dirty');
  const getters = Object.fromEntries(['canUndo', 'canRedo', 'undoLabel', 'redoLabel'].map(name => [name, findGetter(editor, name)]));
  const layer = Object.create(Object.getPrototypeOf(editor));
  Object.setPrototypeOf(editor, layer);
  // The clipboard fields the interface reads: a mirror of the session's, written through to it.
  const clipboards = createClipboards(editor, layer, () => editor._documentToken);
  for (const name of SESSION_COMMANDS) {
    if (VIEW_CALLS.has(name)) continue;
    layer[name] = DRAWING_COMMITS.has(name) ? function owned(...args) { return drawings[name](args); } : function owned(...args) { return callSession(name, args); };
  }
  layer.movieclipBatch = function owned(...args) { return batchCall(args); };
  layer.bakeMovieclip = function owned() { return bakeCall(); };
  // The reads the session answers.
  for (const name of SESSION_READS) {
    layer[name] = function read(...args) {
      if (!reading()) throw refuse(name, 'no engine session runs this document');
      let text;
      try { text = session.query(name, JSON.stringify(args), adopting ? 'null' : JSON.stringify(view())); }
      catch (error) { throw queryFailure(error); }
      return JSON.parse(text).v;
    };
  }
  layer.undo = function owned(...args) { return historyCall(false, args); };
  layer.redo = function owned(...args) { return historyCall(true, args); };
  // Entering a movieclip loads its document, which gets its session as any document does (the 'document' event below);
  // leaving it gives the clip's edit to the session of the document it was in, and ends the clip's own.
  const leaveMovieclip = editor.leaveMovieclip;
  layer.leaveMovieclip = function owned(...args) {
    const clip = editor.report;
    try { return leaveMovieclip.apply(this, args); }
    finally {
      // Once left (a leave that fails stays in the clip) the clip's session is of no use any more.
      if (editor.report !== clip) forget(clip);
    }
  };
  // A project closed ends its sessions: its own, and those of the documents it was entered from inside movieclips.
  const discardDocument = editor.discardDocument;
  layer.discardDocument = function owned(detached) {
    const discarded = discardDocument.call(this, detached);
    if (discarded) for (const closed of [detached.report, ...(detached._movieclipScopes ?? []).map(scope => scope.parent.report)]) forget(closed);
    return discarded;
  };
  layer._publishMovieclipEdit = function owned(...args) { return callSession('publishMovieclipEdit', args); };
  layer.markSaved = function owned(...args) {
    const result = originalMarkSaved.apply(this, args);
    if (session && document === editor.report) { send('@markSaved', []); history.dirty = false; }
    return result;
  };
  // A drawing's encoded tiles attached to its definition in place (derived publication, no edit event): the session's copy gets them.
  layer._drawingPublished = function owned(figure) {
    const celId = drawingMetadata(figure)?.celId;
    if (!session || document !== editor.report || !celId) return;
    send('@publishCel', [celId, figure]);
    check();
  };
  // The drawing store keeps the pixels the session's history refers to.
  const historyPixels = editor.historyPixels;
  layer._collectDrawingHistory = function owned() {
    const refs = session && document === editor.report ? drawings.refs() : undefined;
    drawingResourcesFor(editor.report)?.collectHistory([...editor._undo, ...editor._redo], refs);
  };
  layer.historyPixels = function owned(direction) {
    return (session && document === editor.report ? drawings.root(direction === 'redo') : null) ?? historyPixels.call(this, direction);
  };
  for (const [name, read] of Object.entries({
    canUndo: () => history.canUndo, canRedo: () => history.canRedo, undoLabel: () => history.undoLabel, redoLabel: () => history.redoLabel,
  })) {
    const prototype = getters[name];
    Object.defineProperty(layer, name, {configurable: true, get() { return session && document === editor.report && history ? read() : prototype.get.call(this); }});
  }
  Object.defineProperty(layer, 'dirty', {configurable: true,
    get() {
      return session && document === editor.report && history
        ? history.dirty || Boolean(this._drag?.changed || this._animationEdit?.changed) || Boolean(this._movieclipScopes?.some(scope => scope.parent._revision !== scope.parent._savedRevision))
        : dirty.get.call(this);
    },
    set(value) {
      if (!(session && document === editor.report)) return dirty.set.call(this, value);
      // The project is marked changed or saved outside a command: a new revision without history, or the saved one.
      if (!value) return this.markSaved();
      if (!this.dirty) send('@touch', []);
      this._emit('edit', {label: 'Project metadata'});
    }});
  // A session exists from the moment a document opens (or comes back from a tab, or a movieclip is left). A movieclip's own
  // document gets one as it loads.
  editor.addEventListener('change', event => { if (event.detail?.kind === 'document') ensure(); });
  report.depths = () => depths;
  /** Whether the session holds the open document (starting it if it can). */
  report.ready = () => Boolean(ensure());
  /** Makes the session's document the engine's again, as it is now: the engine holds one document for the stage, playback and exports. */
  report.activate = () => { if (ensure()) activate(); };
  report.session = () => session;
  /** How many sessions the owner holds: the open document's, and those of the documents open beside it or a movieclip is entered from. */
  report.sessions = () => (session ? 1 : 0) + parked.size;
  report.release = () => {
    // The clipboards let go of the sessions first: none names one that is freed.
    clipboards.release();
    const ended = [session, ...[...parked.values()].map(value => value.session)];
    session = null; document = null; parked.clear();
    for (const value of ended) value?.free();
    shown.release(); editor._shown = null;
  };
  // The editor reads the frame on show, its geometry and its timeline from the session.
  editor._shown = shown;
  installed.set(editor, report);
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

/** The editor's error for a refusal of a read: the session raises the message key, followed by the values the message names after
 * `PARAMS` (`styk_edit::error_key`, `error_params`), where a call's answer carries them apart. What is not a message of the
 * editor's (an engine failure) is raised as it came. */
function queryFailure(error) {
  const [key, params] = String(error?.message ?? error).split(PARAMS);
  if (!Object.hasOwn(english, key)) return error;
  try { return failure(key, params === undefined ? undefined : JSON.parse(params)); } catch { return error; }
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
