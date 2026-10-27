import {messageError} from './localized-error.mjs';
import {editorMovieclipMethods} from './editor-movieclips.mjs';

/**
 * Document sessions: one Editor keeps several open projects, one at a time.
 *
 * A session is everything the editor holds for the open document: the report,
 * its name, command history, selection, playhead, saved revision and movieclip
 * scopes. detachDocument() hands that over and leaves the editor ready for a
 * load; resumeDocument() puts a session back and publishes it as a document
 * replacement, so every listener rebuilds exactly as it does after a load.
 * Nothing is cloned or serialized either way.
 *
 * What the editor keeps across sessions is named here: its configuration, the
 * services the application installed, the clipboards (a copy pastes into any
 * project; each carries its source document's token) and the counters that
 * must never repeat, so a cache keyed by a revision can never mistake one
 * project's state for another's.
 */
const SHARED_KEYS = new Set([
  // configuration
  'historyLimit', 'historyBytes', 'propertyChannels', 'layerTimeline', 'autoKey',
  // counters that stay monotonic across every document
  '_revisionSerial', '_loadRequestId', '_layerRevision', '_layerFocusRevision', '_definitionRevision',
  // the engine owner's view of the frame on show, which follows whichever document is open
  '_shown',
  // clipboards
  '_audioClipboard', '_cameraClipboard', '_cameraMotionClipboard', '_figureClipboard', '_selectionClipboard', '_sheetClipboard',
  '_segmentValuesClipboard',
  '_vfxClipClipboard', '_vfxClipClipboardValues', '_drawingPixelClipboard',
  // panel state and diagnostics
  '_vfxTimelineVisible', '_cameraInspectorTab', 'lastLoadTimings',
]);
/** Derived from the report and rebuilt on demand: a resting session does not hold them. */
const DERIVED_KEYS = ['_geometry', '_evaluated', '_sheetPropertyPreview', '_layerDescriptors'];
const sessions = new WeakSet();

const busy = editor => Boolean(editor._drag || editor._animationEdit || editor._authoredPoseEdit);

export const editorSessionMethods = {
  /**
   * Hands the open document over as a session. The editor has no document
   * until the next load() or resumeDocument(), which must follow at once.
   */
  detachDocument() {
    if (busy(this)) throw messageError(new Error(''), 'errors.editorSessions.finishTheCurrentEditFirst', {});
    const session = {};
    for (const key of Object.keys(this)) {
      if (SHARED_KEYS.has(key)) continue;
      if (!DERIVED_KEYS.includes(key)) session[key] = this[key];
      delete this[key];
    }
    sessions.add(session);
    return session;
  },
  /**
   * Detaches the open document for `receive(session)`, as a load that opens beside it does. If the receiver
   * throws, the document stays open exactly as it was and the session is void.
   */
  handOverDocument(receive) {
    const session = this.detachDocument();
    try { receive(session); }
    catch (error) { sessions.delete(session); Object.assign(this, session); throw error; }
  },
  /** Opens a detached session again, as it was left; the session is spent. */
  resumeDocument(session) {
    if (!sessions.has(session)) throw messageError(new Error(''), 'errors.editorSessions.thisProjectIsNoLongerOpen', {});
    if (this.report && busy(this)) throw messageError(new Error(''), 'errors.editorSessions.finishTheCurrentEditFirst', {});
    sessions.delete(session);
    this._loadRequestId = (this._loadRequestId ?? 0) + 1;
    for (const key of Object.keys(this)) if (!SHARED_KEYS.has(key)) delete this[key];
    Object.assign(this, session);
    this._layerRevision = (this._layerRevision ?? 0) + 1;
    this._invalidate({timing: true});
    this._emit('document', {structural: true, timing: true, resumed: true});
    return this;
  },
  /** Ends a detached session without opening it (its project closed): it can never be resumed. */
  discardDocument(session) { return sessions.delete(session); },
};

/** Whether a detached session has unsaved changes: what editor.dirty said as it left. */
export function sessionUnsaved(session) {
  return session._revision !== session._savedRevision ||
    Boolean(session._movieclipScopes?.some(scope => scope.parent._revision !== scope.parent._savedRevision));
}

/**
 * A detached session's whole project and its name: the report itself, or with
 * the movieclips being edited folded into their parents, as a recovery copy of
 * the live editor stores it.
 */
export function sessionProject(session) {
  return {
    report: session._movieclipScopes?.length ? editorMovieclipMethods.movieclipProjectReport.call(session) : session.report,
    name: session._movieclipScopes?.[0]?.parent.name ?? session.name,
  };
}

/** True for a key the editor keeps across sessions (tests and movieclip scopes). */
export const isSharedEditorKey = key => SHARED_KEYS.has(key);
