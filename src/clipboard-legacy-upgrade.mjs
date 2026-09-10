import {portableFigure, portableBackground} from './clipboard-assets.mjs';
import {validateScene} from './pivot/model.mjs';
import {validateAnimationDocument} from './animation-channels.mjs';
import {validateFrameIdentities} from './editor-frames.mjs';
import {invalidateFrameIndex} from './frame-ids.mjs';
import {createFrame} from './demo.mjs';

const clone = value => structuredClone(value);
const bytesOf = value => {
  const queue = [value]; let bytes = 0;
  while (queue.length) {
    const item = queue.pop();
    if (typeof item === 'string') bytes += item.length * 2;
    else if (item && typeof item === 'object') {
      bytes += 32;
      for (const [key,child] of Object.entries(item)) {bytes += key.length * 2 + 8;queue.push(child);}
    } else bytes += 8;
  }
  return bytes;
};

export function modernizeLegacyFrame(original, segmentColorTypes = new Set()) {
  const frame = clone(original);
  for (const object of frame.objects) {
    delete object.runtime_segments;
    if (segmentColorTypes.has(object.figure_type_id)) continue;
    const raw = Number(object.color_override_raw) >>> 0;
    object.color_override_raw = (0xff000000 | ((raw | 0) < 0 ? 0 : raw & 0xffffff)) >>> 0;
    object.color_override_rgb = [object.color_override_raw & 255,(object.color_override_raw >>> 8) & 255,(object.color_override_raw >>> 16) & 255];
    object.color_override_mix = 255;
  }
  return frame;
}

/** Same hold expansion as the supplied native migration writer. IDs used by
 * authored channels stay on the first key; added terminal holds get fresh IDs. */
export function planLegacyDestinationUpgrade(report, nextFrameIdentity) {
  const segmentColorTypes = new Set(report.figure_types.filter(fig => fig._styk?.colorMode === 'segments').map(fig => fig.figure_type_id));
  if (![2,3,4].includes(report.version)) throw new Error('Choose a legacy Pivot 2, 3 or 4 destination.');
  const upgraded = {...report,version:5,figure_types:report.figure_types.map(figure=>portableFigure(figure,true)),
    backgrounds:(report.backgrounds ?? []).map(portableBackground),keyframes:[],_styk:clone(report._styk ?? {})};
  const indexes = [], used = new Set([...report.keyframes,...Object.values(report._styk?.frameSources ?? {})].map(frame=>frame._styk?.frameId));
  const id = () => {
    let value;
    do {
      if (!Number.isSafeInteger(nextFrameIdentity) || nextFrameIdentity < 1) throw new Error('Frame identity capacity exceeded.');
      value = `frame-${nextFrameIdentity++}`;
    } while (used.has(value));
    used.add(value);return value;
  };
  let objects = 0;
  for (const original of report.keyframes) {
    indexes.push(upgraded.keyframes.length);
    const frame = modernizeLegacyFrame(original, segmentColorTypes), hold = frame.duration_raw;
    const added = hold > 1 ? 2 : 1;
    objects += frame.objects.length * added;
    if (upgraded.keyframes.length + added > 100000 || objects > 2000000) throw new Error('Legacy hold conversion exceeds the frame or object capacity.');
    if (hold > 1) {
      frame.duration_raw = hold - 1;
      const terminal = clone(frame);terminal.duration_raw = 1;terminal._styk={...terminal._styk,frameId:id()};
      upgraded.keyframes.push(frame,terminal);
    } else upgraded.keyframes.push(frame);
  }
  indexes.push(upgraded.keyframes.length);
  if (upgraded._styk.frameSources) for (const [key,frame] of Object.entries(upgraded._styk.frameSources))
    upgraded._styk.frameSources[key]=modernizeLegacyFrame(frame, segmentColorTypes);
  const draft = upgraded._styk.simpleFrameDraft;
  if (!upgraded.keyframes.length) delete upgraded._styk.simpleFrameDraft;
  else if (draft) {
    draft.index=indexes[draft.index];
    if (draft.baseline) {draft.baseline=modernizeLegacyFrame(draft.baseline, segmentColorTypes);draft.baseline.duration_raw=upgraded.keyframes[draft.index].duration_raw;}
  }
  upgraded._styk.nativeUpgrade={version:1,sourceVersion:report.version,reason:'Paste Pivot 5 keyframes',
    sourceFrameDelayMs:report.frame_delay_ms ?? null,targetFrameDelayMs:1000/report.fps};
  // Imported native easing remains a compatibility fallback. Explicit authored constant keys
  // remain unchanged; identical hold endpoints retain legacy integer poses.
  validateScene(upgraded.keyframes.length ? upgraded : {...upgraded,keyframes:[createFrame([])]});
  validateAnimationDocument(upgraded);validateFrameIdentities(upgraded);
  return {report:upgraded,indexes,nextFrameIdentity};
}

export function applyClipboardUpgrade(editor, command, direction) {
  const state = command.clipboardUpgrade[direction];
  editor.report = clone(state.report);
  editor._nextFrameIdentity = state.nextFrameIdentity;
  editor._nextUid = state.nextUid;
  editor._generatedFrameSources = new Set(state.generatedFrameSources);
  editor._sourceTableWasPresent = state.sourceTableWasPresent;
  editor._nativeAnimationChannels = null;editor._authoredPoseEdit = null;editor._authoredCommitPreview = null;
  editor._loadedFigureNames=null;editor._loadedTimelineTracks=null;
  invalidateFrameIndex(editor.report);editor._initializeLayers();editor._invalidate({timing:true});
}

const stateOf = editor => ({report:clone(editor.report),nextFrameIdentity:editor._nextFrameIdentity,nextUid:editor._nextUid,
  generatedFrameSources:[...editor._generatedFrameSources],sourceTableWasPresent:editor._sourceTableWasPresent});

function committedPreview(editor) {
  if (!editor._drag) return editor;
  // Clone these together: a rig gesture and a Simple journal can retain
  // references into the report. Their staged commit must use those same copies.
  const state=clone({report:editor.report,drag:editor._drag,authored:editor._authoredPoseEdit,
    draft:editor._frameDraft,pending:editor._frameDraftStoredEdit});
  const source=new editor.constructor({demo:false,historyLimit:editor.historyLimit,historyBytes:editor.historyBytes}).load(state.report,editor.name);
  source._documentToken=editor._documentToken;source._nextFrameIdentity=editor._nextFrameIdentity;source._nextUid=editor._nextUid;
  source._generatedFrameSources=new Set(editor._generatedFrameSources);source._sourceTableWasPresent=editor._sourceTableWasPresent;
  source._undo=editor._undo.slice();source._redo=editor._redo.slice();source._historySize=editor._historySize;
  source._frameDraftEnabled=editor._frameDraftEnabled;source._frameDraftSuspended=editor._frameDraftSuspended;
  source._frameDraftPreviewing=editor._frameDraftPreviewing;source._frameDraftStoredEdit=state.pending;source._frameDraft=state.draft;
  if (state.draft) state.draft.token=source._documentToken;
  source._drag=state.drag;source._authoredPoseEdit=state.authored;source._restoreSelection(editor._selectionState());
  source.commitDrag();
  return source;
}

/** Stage conversion and existing paste validation away from the visible editor.
 * One non-JSON history payload retains the complete version transition. */
export function pasteWithLegacyUpgrade(editor, index, paste) {
  const source=committedPreview(editor);
  const conversion = planLegacyDestinationUpgrade(source.report,source._nextFrameIdentity);
  const staged = new editor.constructor({demo:false});
  const empty = !conversion.report.keyframes.length;
  staged.load(empty ? {...conversion.report,keyframes:[createFrame([])]} : conversion.report,editor.name);
  if (empty) {staged.report.keyframes=[];staged._initializeLayers();staged._invalidate({timing:true});}
  staged._documentToken=editor._documentToken;
  staged._frameClipboard=editor._frameClipboard;staged._nextFrameIdentity=conversion.nextFrameIdentity;
  staged._nextUid=Math.max(staged._nextUid,source._nextUid);
  staged._generatedFrameSources=new Set(source._generatedFrameSources);staged._sourceTableWasPresent=source._sourceTableWasPresent;
  const count = paste.call(staged,conversion.indexes[index]);
  // Any preflight failure above leaves current gestures and all history intact.
  if (editor._drag) editor.commitDrag();
  const beforeSelection=editor._selectionState(),before=stateOf(editor),after=stateOf(staged);
  const command={kind:'clipboard-upgrade',label:'Paste keyframes · upgrade to Pivot 5',structural:true,timing:true,
    beforeSelection,afterSelection:staged._selectionState()};
  Object.defineProperty(command,'clipboardUpgrade',{value:{before,after}});
  command.sourceBytes=bytesOf(before)+bytesOf(after);
  const draftBefore=clone(editor.report._styk?.simpleFrameDraft),pending=editor._frameDraftStoredEdit;
  const pendingBefore=pending?.before;
  // The native Simple wrapper owns a separate Add working copy. Convert that
  // copy for forward restoration while keeping its exact legacy undo overlay.
  if (pending) pending.before={...pendingBefore,frame:modernizeLegacyFrame(pendingBefore.frame)};
  const suspended=editor._frameDraftSuspended;editor._frameDraftSuspended=true;
  try {
    applyClipboardUpgrade(editor,command,'after');editor._restoreSelection(command.afterSelection);
    editor._record(command);
    if (pending && command.frameDraftStored) command.frameDraftStored.before=pendingBefore;
    if (!pending && editor._frameDraftEnabled) {
      const frame=editor.report.keyframes[editor.frameIndex];
      const draftAfter={version:1,mode:'update',index:editor.frameIndex,frameId:frame._styk.frameId};
      Object.defineProperty(command,'frameDraftState',{value:{before:draftBefore,after:draftAfter},configurable:true});
      editor.report._styk.simpleFrameDraft=draftAfter;editor._applyFrameDraftHistory(command,'after');
    }
    editor._initializeLayers();
  } finally {editor._frameDraftSuspended=suspended;if(pending)pending.before=pendingBefore;}
  editor._emit('edit',{label:command.label,structural:true,timing:true,animation:Boolean(editor.animationChannels.length),upgradedFrom:before.report.version});
  return count;
}
