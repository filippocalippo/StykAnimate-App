/** Simple timeline checkpoints reuse command snapshots; they never copy an animation. */
import {validateScene} from './pivot/model.mjs';
import {createFrame} from './demo.mjs';
import {validateAnimationDocument} from './animation-channels.mjs';
import {planDraftFrameAppend, rebaseDraftAnimation,placeAddedMovieclips} from './frame-draft-animation.mjs';

const clone = value => structuredClone(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const sceneFields = ['background_id', 'background_id_b', 'background_mix', 'background_color', '_stykBackgroundColor'];
export function validateSimpleFrameDraft(report, {validateFrame = true} = {}) {
  const state = report._styk?.simpleFrameDraft;
  if (state === undefined) return;
  if (!state || state.version !== 1 || !['add', 'update'].includes(state.mode) ||
    !Number.isInteger(state.index) || !report.keyframes[state.index] ||
    state.frameId !== report.keyframes[state.index]._styk?.frameId)
    throw new Error('Invalid Simple timeline working frame.');
  if (state.empty !== undefined && typeof state.empty !== 'boolean' || state.empty && (state.mode !== 'add' || state.index !== 0 || report.keyframes.length !== 1))
    throw new Error('An empty Simple animation requires one Add working placeholder.');
  if (state.baseline !== undefined) {
    if (state.baseline?._styk?.frameId !== state.frameId) throw new Error('The working frame checkpoint has a different identity.');
    if (validateFrame) validateScene({...report, keyframes: [state.baseline]});
  }
  if (own(state, 'animationBaseline')) {
    if (state.animationBaseline === undefined) throw new Error('An animation checkpoint must be a channel table or null.');
    if (!state.baseline) throw new Error('An animation checkpoint requires a working frame baseline.');
    if (validateFrame) validateAnimationDocument({...report, _styk: {...report._styk, animation: state.animationBaseline}});
  }
}
const current = editor => {
  const draft = editor._frameDraft;
  return draft?.token === editor._documentToken && (draft.index === editor.frameIndex || editor._frameDraftPreviewing) &&
    draft.frameId === editor.report.keyframes[draft.index]?._styk?.frameId ? draft : null;
};
function fresh(editor, mode, empty = false) {
  return {token: editor._documentToken, index: editor.frameIndex, frameId: editor.getFrameId(), mode,
    empty, baseline: null, captured: new Set(), fields: new Set(), selection: null};
}
function sync(editor) {
  const draft = current(editor);
  if (!editor._frameDraftEnabled || !draft) return;
  const previous = editor.report._styk.simpleFrameDraft;
  const previousTiming = previous?.empty ? 'empty' : previous?.mode === 'add' && previous.baseline ? `${previous.index}:${previous.baseline.duration_raw ?? 1}` : '';
  const nextTiming = draft.empty ? 'empty' : draft.mode === 'add' && draft.baseline ? `${draft.index}:${draft.baseline.duration_raw ?? 1}` : '';
  if (previousTiming !== nextTiming) editor._invalidate({timing:true});
  if (Boolean(previous?.empty) !== draft.empty || previous?.mode !== draft.mode || previous?.index !== draft.index || previous?.frameId !== draft.frameId || previous?.baseline !== (draft.baseline ?? undefined) || previous?.animationBaseline !== draft.animationBaseline)
    editor._frameDraftRevision = (editor._frameDraftRevision ?? 0) + 1;
  editor.report._styk.simpleFrameDraft = {version: 1, mode: draft.mode, index: draft.index, frameId: draft.frameId,
    ...(draft.empty ? {empty:true} : {}),
    ...(draft.baseline ? {baseline: draft.baseline} : {}),
    ...(own(draft, 'animationBaseline') ? {animationBaseline: draft.animationBaseline} : {})};
}
function restore(editor, {validateFrame = true, preservePreparedScene = false} = {}) {
  validateSimpleFrameDraft(editor.report, {validateFrame});
  const state = editor.report._styk.simpleFrameDraft;
  if (!state) return false;
  const tick = editor.timeline[state.index]?.start ?? 0;
  const samePreparedTarget = preservePreparedScene && editor.frameIndex === state.index && editor.tick === tick;
  editor.frameIndex = state.index; editor.tick = tick;
  if (!samePreparedTarget) editor._invalidate({viewOnly: true});
  const draft = fresh(editor, state.mode, Boolean(state.empty));
  if (own(state, 'animationBaseline')) draft.animationBaseline = state.animationBaseline;
  if (state.baseline) {
    draft.baseline = {...state.baseline, objects: state.baseline.objects.slice()};
    const live = new Map(editor.frame.objects.map(object => [object.unique_id, object]));
    draft.captured = new Set(draft.baseline.objects.filter(object => object !== live.get(object.unique_id)).map(object => object.unique_id));
    draft.fields = new Set([...Object.keys(draft.baseline), ...Object.keys(editor.frame)].filter(key => key !== 'objects' &&
      (!draft.baseline[key] || typeof draft.baseline[key] !== 'object' || draft.baseline[key] !== editor.frame[key])));
  }
  editor._frameDraft = draft; sync(editor); return true;
}
function rememberHistory(command, before, after) {
  Object.defineProperty(command, 'frameDraftState', {value: {before, after}, configurable: true});
}
function snapshot(draft) {
  return draft && {version: 1, mode: draft.mode, index: draft.index, frameId: draft.frameId,
    ...(draft.empty ? {empty:true} : {}),
    ...(draft.baseline ? {baseline: draft.baseline} : {}),
    ...(own(draft, 'animationBaseline') ? {animationBaseline: draft.animationBaseline} : {})};
}
function topologyState(editor, draft, value) {
  const state = {version: 1, mode: draft.mode, index: draft.index, frameId: draft.frameId, ...(draft.empty ? {empty:true} : {})};
  if (own(draft, 'animationBaseline')) state.animationBaseline = draft.animationBaseline;
  if (own(value ?? {}, 'animationBaseline')) state.animationBaseline = value.animationBaseline;
  if (!draft.baseline) return {state};
  const frame = editor.report.keyframes[draft.index], live = new Map(frame.objects.map(object => [object.unique_id, object]));
  const affected = new Map((value?.frames?.find(entry => entry.draft)?.objects ?? []).map(object => [object.unique_id, object]));
  const fields = {...draft.baseline}; delete fields.objects;
  const sharedFields = Object.keys(fields).filter(key => fields[key] && typeof fields[key] === 'object' && fields[key] === frame[key]);
  for (const key of sharedFields) delete fields[key];
  // A shared, untouched pose is recovered from the working frame at replay.
  // Later commands are undone first, so no entire-frame history clone is needed.
  return {state, fields, sharedFields, objects: draft.baseline.objects.map(object => ({uid: object.unique_id,
    object: affected.get(object.unique_id) ?? (object === live.get(object.unique_id) ? null : object)}))};
}
function prepareTopologyState(editor, plan) {
  const state = {...plan.state};
  if (plan.objects) {
    const frame = editor.report.keyframes[state.index], live = new Map(frame.objects.map(object => [object.unique_id, object]));
    state.baseline = {...plan.fields, objects: plan.objects.map(entry => entry.object ?? live.get(entry.uid))};
    for (const key of plan.sharedFields) if (own(frame, key)) state.baseline[key] = frame[key];
  }
  editor.report._styk.simpleFrameDraft = state;
}
function overlay(editor) {
  return {state: clone(snapshot(current(editor))), frame: clone(editor.frame), animation: editor.report._styk.animation ?? null, tick: editor.tick};
}
function assignAnimation(editor, animation) {
  if (animation === null) delete editor.report._styk.animation;
  else editor.report._styk.animation = animation;
}
function restoreOverlay(editor, value) {
  editor.report.keyframes[value.state.index] = clone(value.frame);
  editor.report._styk.simpleFrameDraft = clone(value.state);
  if (own(value, 'animation')) assignAnimation(editor, value.animation);
  editor._invalidate({timing: true});
  restore(editor, {validateFrame: false});
}
function retainedBytes(value) {
  const queue = [value]; let bytes = 0;
  while (queue.length) {
    const item = queue.pop();
    if (typeof item === 'string') bytes += item.length * 2;
    else if (item && typeof item === 'object') {
      bytes += 32;
      for (const key of Object.keys(item)) { bytes += key.length * 2 + 8; queue.push(item[key]); }
    } else bytes += 8;
  }
  return bytes;
}
function ensure(editor, draft, frame = editor.frame) {
  if (!draft.baseline) {
    draft.baseline = {...frame, objects: frame.objects.slice()};
    draft.selection = editor._selectionState();
  }
  return draft.baseline;
}
function objects(editor, draft, before) {
  const frame = ensure(editor, draft), replacements = new Map(before.map(object => [object.unique_id, object]));
  frame.objects = frame.objects.map(object => {
    if (draft.captured.has(object.unique_id) || !replacements.has(object.unique_id)) return object;
    draft.captured.add(object.unique_id); return replacements.get(object.unique_id);
  });
}
function field(editor, draft, key, exists, value) {
  const frame = ensure(editor, draft);
  if (draft.fields.has(key)) return;
  draft.fields.add(key);
  if (exists) frame[key] = value; else delete frame[key];
}
function full(editor, draft, before) {
  ensure(editor, draft, before);
  objects(editor, draft, before.objects);
  for (const key of new Set([...Object.keys(draft.baseline), ...Object.keys(before)]))
    if (key !== 'objects') field(editor, draft, key, own(before, key), before[key]);
}
function patchFrame(frame, patch) {
  for (const entry of patch.entries) {
    let parent = frame;
    for (const key of entry.path.slice(0, -1)) parent = parent[key] ??= {};
    if (entry.exists) parent[entry.path.at(-1)] = clone(entry.value); else delete parent[entry.path.at(-1)];
  }
  for (const path of patch.removeEmptyParents ?? []) {
    let parent = frame;
    for (const key of path.slice(0, -1)) parent = parent?.[key];
    const value = parent?.[path.at(-1)];
    if (value && !Object.keys(value).length) delete parent[path.at(-1)];
  }
}
function changedFields(target, fields) {
  for (const entry of fields ?? []) {
    if (entry.exists) target[entry.key] = clone(entry.value); else delete target[entry.key];
  }
}
function figureRange(editor, draft, change) {
  const before = {...editor.frame, objects: editor.frame.objects.slice()}, restored = new Map(before.objects.map(object => [object.unique_id, object]));
  const touched = [];
  for (const patch of change.patches) {
    if (!patch.before.exists) { restored.delete(patch.uid); continue; }
    const object = patch.before.object ?? clone(restored.get(patch.uid));
    changedFields(object, patch.before.fields); restored.set(patch.uid, object); touched.push(object);
  }
  before.objects = (change.beforeSlots ?? before.objects.map(object => object.unique_id)).map(uid => restored.get(uid));
  changedFields(before, change.beforeFields);
  if (change.beforeOrder) {
    const slots = new Map(before.objects.map((object, index) => [object.unique_id, index]));
    before.object_draw_order_unique_ids = change.beforeOrder.slice();
    before.object_draw_order = change.beforeOrder.map(uid => slots.get(uid));
  }
  ensure(editor, draft, before); objects(editor, draft, touched);
  for (const entry of change.beforeFields ?? []) field(editor, draft, entry.key, entry.exists, entry.value);
  if (change.beforeOrder) for (const key of ['object_draw_order', 'object_draw_order_unique_ids']) field(editor, draft, key, true, before[key]);
}

export const editorFrameDraftMethods = {
  /** Placement edits belong to the saved timeline, not an Add-mode pose draft. */
  editFrameDraftTimeline(operation) {
    if(!this._frameDraftEnabled||this._frameDraftSuspended)return operation();
    this._beforeFrameDraftGlobalEdit();
    const draft=current(this),before=draft&&topologyState(this,draft),animation=this.report._styk.animation,previous=this._undo.at(-1);
    this._frameDraftSuspended=true;
    try {
      const result=operation();
      if(result?.then)throw new Error('Prepare timeline edits before publishing them.');
      if(draft&&own(draft,'animationBaseline')){
        const old=new Map((animation?.channels??[]).map(c=>[c.id,c])),after=this.report._styk.animation;
        const changed=new Map((after?.channels??[]).filter(c=>old.get(c.id)!==c).map(c=>[c.id,c]));
        const remaining=new Set((after?.channels??[]).map(c=>c.id));
        const removed=new Set([...old.keys()].filter(id=>!remaining.has(id)));
        draft.animationBaseline={version:1,...draft.animationBaseline,nextKeyId:after?.nextKeyId??1,
          channels:[...(draft.animationBaseline?.channels??[]).filter(c=>!changed.has(c.id)&&!removed.has(c.id)),...changed.values()]};
      }
      if(!current(this))this._frameDraft=fresh(this,draft?.mode??'update');
      const command=this._undo.at(-1);
      if(command&&command!==previous&&before)Object.defineProperty(command,'frameDraftJournal',{value:{before,after:topologyState(this,this._frameDraft)},configurable:true});
      sync(this);return result;
    } finally {this._frameDraftSuspended=false;this._emit('frame-draft');}
  },
  /** Enable only for the Simple timeline. Switching to Advanced keeps all edits. */
  enableFrameDrafts({mode = 'update', index = this.frameIndex, restoreSaved = true, empty = false} = {}) {
    if (!['add', 'update'].includes(mode)) throw new Error('Choose Add or Update frame mode.');
    if (this._animationEdit) this.commitAnimationEdit();
    this.commitDrag();
    if (!this._frameDraftListener) {
      this._frameDraftListener = event => {
        const kind = event.detail?.kind;
        if (kind === 'document') { this._frameDraftPreviewing = false; this._frameDraftPreviewSelection = null; }
        if (!this._frameDraftEnabled || this._frameDraftSuspended || this._frameDraftPreviewing) return;
        const revision = this.frameDraftRevision;
        // Editor publishes prepared documents only after incremental validation
        // has covered this baseline too. Keep metadata checks on every restore.
        if (kind === 'document') { if (!restore(this, {validateFrame: event.detail.prepared !== true, preservePreparedScene: event.detail.scenePrepared === true})) this._frameDraft = fresh(this, 'update'); }
        else if (kind === 'seek' && !current(this)) this._frameDraft = fresh(this, 'update');
        if (['document', 'history', 'seek', 'edit'].includes(kind)) sync(this);
        if (this.frameDraftRevision !== revision && ['document', 'history', 'seek'].includes(kind)) this._emit('frame-draft');
      };
      this.addEventListener('change', this._frameDraftListener);
    }
    this._frameDraftEnabled = true;
    if (!restoreSaved || !restore(this)) this.beginFrameDraft({mode, index, empty});
    else this._emit('frame-draft');
  },
  disableFrameDrafts() {
    // An explicit switch to direct editing must retain both the stored key and
    // a distinct Add working pose, including a project opened in Advanced mode.
    this.endFrameDraftPreview();
    if (this._animationEdit) this.commitAnimationEdit();
    if (!this._frameDraftEnabled && this.report._styk.simpleFrameDraft) {
      this._frameDraftEnabled = true; restore(this);
    }
    this.commitDrag(); const draft = current(this), added = Boolean(draft?.mode === 'add' && (draft.baseline || draft.empty));
    if (added) this.addDraftFrame();
    this.commitFrameDraft(); this._frameDraftEnabled = false; this._frameDraft = null; delete this.report._styk.simpleFrameDraft;
    this._frameDraftRevision = (this._frameDraftRevision ?? 0) + 1;
    this._emit('frame-draft');
    return added;
  },
  beginFrameDraft({mode = 'update', index = this.frameIndex, empty = false} = {}) {
    if (!['add', 'update'].includes(mode)) throw new Error('Choose Add or Update frame mode.');
    if (!Number.isInteger(index) || index < 0 || index >= this.report.keyframes.length) throw new Error('Choose an existing keyframe.');
    if (empty && (mode !== 'add' || index !== 0 || this.report.keyframes.length !== 1)) throw new Error('An empty animation needs one working placeholder.');
    this.commitDrag();
    if (index !== this.frameIndex) this.selectFrame(index);
    this._frameDraft = fresh(this, mode, empty); sync(this); this._emit('frame-draft'); return this.frameDraft;
  },
  get frameDraft() {
    const draft = current(this);
    return this._frameDraftEnabled && draft ? {mode: draft.mode, index: draft.index, dirty: Boolean(draft.baseline),
      empty:draft.empty, storedCount:draft.empty?0:this.report.keyframes.length,
      capturedObjects: draft.captured.size, frameId: draft.frameId} : null;
  },
  get frameDraftRevision() { return this._frameDraftRevision ?? 0; },
  beginFrameDraftPreview() {
    if (!this._frameDraftEnabled || this._frameDraftPreviewing || !current(this)) return false;
    this.commitDrag(); this._frameDraftPreviewSelection = {token: this._documentToken, selection: this._selectionState()};
    this._frameDraftPreviewing = true; return true;
  },
  endFrameDraftPreview() {
    const state = this._frameDraftPreviewSelection;
    if (!this._frameDraftPreviewing) return false;
    this._frameDraftPreviewing = false; this._frameDraftPreviewSelection = null;
    if (state?.token !== this._documentToken) return false;
    this._restoreSelection(state.selection); this._invalidate({viewOnly: true}); this._emit('seek'); return true;
  },
  _beforeFrameDraftSeek(index) {
    const draft = current(this);
    if (!this._frameDraftPreviewing && !this._frameDraftSuspended && this._frameDraftEnabled && draft?.mode === 'add' && draft.baseline && index !== draft.index)
      throw new Error('Add the working frame, or select a frame in the Simple timeline to discard its draft.');
  },
  _beforeFrameDraftGlobalEdit() {
    const draft = current(this);
    if (!this._frameDraftEnabled || draft?.mode !== 'add' || !draft.baseline) return false;
    throw new Error('Add the working frame, or discard its draft before changing saved frames.');
  },
  _applyFrameDraftHistory(command, direction) {
    if (!this._frameDraftEnabled) {
      delete this.report._styk.simpleFrameDraft; this._frameDraft = null; return;
    }
    if (command.frameDraftStored) {
      restoreOverlay(this, command.frameDraftStored[direction]); this._frameDraftRevision = (this._frameDraftRevision ?? 0) + 1; return;
    }
    if (command.frameDraftTopology || command.frameDraftJournal) {
      restore(this, {validateFrame: false}); this._frameDraftRevision = (this._frameDraftRevision ?? 0) + 1; return;
    }
    const state = command.frameDraftState?.[direction];
    if (state) { this.report._styk.simpleFrameDraft = state; restore(this, {validateFrame: false}); }
    else this._frameDraft = fresh(this, 'update');
    this._frameDraftRevision = (this._frameDraftRevision ?? 0) + 1; sync(this);
  },
  _prepareFrameDraftHistory(command, direction) {
    if (command.frameDraftStored) {
      const previous = command.frameDraftStored[direction === 'before' ? 'after' : 'before'];
      if (previous.state.empty) this.report.keyframes=[];
      else if (previous.state.baseline) this.report.keyframes[previous.state.index] = clone(previous.state.baseline);
      if (own(previous.state, 'animationBaseline')) assignAnimation(this, previous.state.animationBaseline);
      delete this.report._styk.simpleFrameDraft; this._frameDraft = null; return;
    }
    const plan = command.frameDraftTopology ?? command.frameDraftJournal;
    if (plan) prepareTopologyState(this, plan[direction]);
  },
  _restoreFrameDraftOverlay(command,direction) {
    if (command.frameDraftStored) {
      const value=command.frameDraftStored[direction];
      this.report.keyframes[value.state.index]=clone(value.frame); this.report._styk.simpleFrameDraft=clone(value.state);
      if (own(value, 'animation')) assignAnimation(this, value.animation);
    }
  },
  commitFrameDraft({mode = current(this)?.mode ?? 'update'} = {}) {
    if (this._animationEdit) this.commitAnimationEdit();
    this.commitDrag();
    if (!this._frameDraftEnabled) return false;
    const changed = Boolean(current(this)?.baseline);
    this._frameDraft = fresh(this, mode, Boolean(current(this)?.empty)); sync(this); this._emit('frame-draft'); return changed;
  },
  updateDraftFrame() {
    if(current(this)?.empty) return this.addDraftFrame();
    this.commitFrameDraft({mode: 'update'});
    return this.beginFrameDraft({mode: 'add', index: this.report.keyframes.length - 1});
  },
  _recordFrameDraft(command) {
    if (this._frameDraftStoredEdit) {
      const pending = this._frameDraftStoredEdit;
      if (pending.recorded) throw new Error('A stored-frame operation must create one history command.');
      const index = this.report.keyframes.length - 1;
      this.frameIndex = index; this.tick = this.timeline[index]?.start ?? 0;
      const baseline = this.frame;
      if (pending.preserveWorking) {
        const working = clone(pending.before.frame);
        working._styk = {...working._styk, frameId: baseline._styk.frameId};
        this.report.keyframes[index] = working;
        this._frameDraft = fresh(this, 'add',pending.empty);
        if (pending.before.state.baseline || pending.before.state.frameId !== baseline._styk.frameId) {
          this._frameDraft.baseline = baseline;
          this._frameDraft.captured = new Set(baseline.objects.map(object => object.unique_id));
          this._frameDraft.fields = new Set(Object.keys(baseline).filter(key => key !== 'objects'));
        }
        if (own(pending.before.state, 'animationBaseline')) {
          this._frameDraft.animationBaseline = this.report._styk.animation ?? null;
          assignAnimation(this, rebaseDraftAnimation(pending.before.state.animationBaseline, pending.before.animation,
            this._frameDraft.animationBaseline, pending.before.tick, this.tick));
        }
      } else this._frameDraft = fresh(this, 'add',pending.empty);
      this._invalidate({viewOnly:true}); this._restoreSelection({...pending.selection,frameIndex:index,tick:this.tick}); sync(this);
      const state = {before:pending.before,after:overlay(this)};
      Object.defineProperty(command, 'frameDraftStored', {value:state,configurable:true});
      command.sourceBytes = (command.sourceBytes ?? 0) + retainedBytes(state);
      command.afterSelection = this._selectionState(); pending.recorded = true; return;
    }
    if (!this._frameDraftEnabled || this._frameDraftSuspended || this._frameDraftPreviewing) return;
    if (command.frameEasing) {
      // Easing belongs to the saved timeline, independently of pose drafts.
      // Keep a pending pose's checkpoint in sync without committing its edits.
      const draft = current(this);
      if (!draft) return;
      const before = topologyState(this, draft);
      if (draft.baseline && command.changes.some(change => change.index === draft.index))
        draft.baseline = {...draft.baseline, _styk: {...draft.baseline._styk, easing: clone(this.frame._styk.easing)}};
      Object.defineProperty(command, 'frameDraftJournal', {value: {before, after: topologyState(this, draft)}, configurable: true});
      sync(this); return;
    }
    let originalDraft, wasDirty;
    try {
    let draft = current(this);
    if (!draft) draft = this._frameDraft = fresh(this, 'update');
    originalDraft = draft; wasDirty = Boolean(draft.baseline);
    if (command.kind === 'topology' || command.kind === 'movieclip-poses') {
      Object.defineProperty(command, 'frameDraftTopology', {value: {
        before: topologyState(this, draft, command.before), after: topologyState(this, draft, command.after)}, configurable: true});
      return;
    }
    // Sparse keys are part of the working pose too. Their immutable channel
    // table is a checkpoint reference; no animation-length pose copy is needed.
    if (command.kind === 'animation') {
      const before = snapshot(draft);
      ensure(this, draft);
      if (!own(draft, 'animationBaseline')) draft.animationBaseline = command.before;
      rememberHistory(command, before, snapshot(draft));
      originalDraft = null;
      return;
    }
    if (command.kind === 'scene' && command.before.channels.length) {
      const before = snapshot(draft);
      ensure(this, draft);
      if (!own(draft, 'animationBaseline')) {
        const animation = this.report._styk.animation;
        const channels = animation.channels.slice();
        for (const entry of [...command.before.channels].sort((a,b)=>b.index-a.index)) {
          if(entry.channel == null)channels.splice(entry.index,1);else channels[entry.index]=entry.channel;
        }
        draft.animationBaseline = command.before.animationExists === false ? null : {...animation, channels};
        const counter = command.before.nextKeyId;
        if(draft.animationBaseline) {
          if (counter?.exists) draft.animationBaseline.nextKeyId = counter.value;
          else delete draft.animationBaseline.nextKeyId;
        }
      }
      for (const entry of command.before.frames) if (entry.index === draft.index)
        for (const key of sceneFields) field(this, draft, key, own(entry.fields, key), entry.fields[key]);
      rememberHistory(command, before, snapshot(draft)); originalDraft = null; return;
    }
    if (command.layerAnimationPatch || command.frameSourceChanges?.length) {
      this._frameDraft = fresh(this, draft.mode); return;
    }
    if (command.kind === 'objects' && command.index === draft.index) objects(this, draft, command.before);
    else if (['frame', 'import', 'figure-splice', 'project'].includes(command.kind) && command.index === draft.index) {
      const before = command.kind === 'frame' ? command.before : command.before.frame;
      if (before) full(this, draft, before);
    } else if (command.kind === 'camera') {
      if (command.before.length !== 1 || command.before[0].index !== draft.index) { this._frameDraft = fresh(this, draft.mode); return; }
      const before = command.before[0];
      if (before.objects) objects(this, draft, before.objects);
      field(this, draft, 'camera', before.camera != null, before.camera);
    } else if (command.kind === 'scene') {
      if (command.before.channels.length || command.before.frames.length > 1) { this._frameDraft = fresh(this, draft.mode); return; }
      const before = command.before.frames.find(entry => entry.index === draft.index);
      if (before) for (const key of sceneFields) field(this, draft, key, own(before.fields, key), before.fields[key]);
    } else if (command.kind === 'native-properties' && command.scope === 'frame' && command.index === draft.index) {
      const patch = command.before, frame = {...this.frame};
      // Clone only touched branches, never unrelated figures or native media.
      const keys = new Set(patch.entries.map(entry => entry.path[0]));
      for (const key of keys) frame[key] = clone(frame[key]);
      patchFrame(frame, patch);
      for (const key of keys) field(this, draft, key, own(frame, key), frame[key]);
    } else if (command.kind === 'figure-range') {
      if (command.changes.length === 1 && command.changes[0].index === draft.index) figureRange(this, draft, command.changes[0]);
      else this._frameDraft = fresh(this, draft.mode);
    } else if (command.kind === 'frame-timing') {
      const change=command.changes.length===1&&command.changes[0];
      if(change?.index===draft.index)field(this,draft,'duration_raw',change.before.exists,change.before.value);
      else this._frameDraft=fresh(this,'update');
    } else if (command.kind === 'ranges') {
      const change = command.changes.length === 1 && command.changes[0];
      if (change?.index === draft.index && change.before.length === 1 && change.after.length === 1 && change.before[0]._styk?.frameId === change.after[0]._styk?.frameId)
        full(this, draft, change.before[0]);
      else this._frameDraft = fresh(this, 'update');
    } else if (command.kind === 'splice' || command.scope?.endsWith('-range')) this._frameDraft = fresh(this, 'update');
    if (draft.baseline && !draft.selection) draft.selection = command.beforeSelection;
    } finally {
      if (originalDraft && originalDraft === this._frameDraft && !command.frameDraftTopology) {
        const after = topologyState(this, originalDraft), before = wasDirty ? after : {state: {...after.state}};
        Object.defineProperty(command, 'frameDraftJournal', {value: {before, after}, configurable: true});
      }
      sync(this);
    }
  },
  /** Native context operations edit stored keys while retaining a separate Add copy. */
  editStoredFrames(operation, {preserveWorking = true, empty = false} = {}) {
    this.commitDrag(); const draft = current(this);
    if (!this._frameDraftEnabled || draft?.mode !== 'add') return operation();
    if (this._frameDraftStoredEdit) throw new Error('Finish the current frame operation first.');
    const pending = {before:overlay(this),selection:this._selectionState(),preserveWorking,empty,recorded:false};
    this._frameDraftStoredEdit = pending; this._frameDraftSuspended = true;
    if (draft.baseline) this.report.keyframes[draft.index] = draft.baseline;
    if (own(draft, 'animationBaseline')) assignAnimation(this, draft.animationBaseline);
    this._frameDraft = fresh(this,'update'); sync(this);
    if(draft.empty) this.report.keyframes=[];
    this._invalidate({timing:true});
    try {
      const result = operation();
      if (result?.then) throw new Error('Stored-frame operations must finish synchronously.');
      if (!pending.recorded) restoreOverlay(this,pending.before);
      return result;
    } catch (error) {
      if (!pending.recorded) { restoreOverlay(this,pending.before); this._restoreSelection(pending.selection); }
      throw error;
    } finally { this._frameDraftStoredEdit = null; this._frameDraftSuspended = false; sync(this); this._emit('frame-draft'); }
  },
  discardFrameDraft() {
    if (this._animationEdit) this.commitAnimationEdit();
    this.commitDrag(); const draft = current(this);
    if (!this._frameDraftEnabled || !draft?.baseline) return false;
    const before = clone(this.frame), after = clone(draft.baseline), beforeSelection = this._selectionState();
    validateScene({...this.report, keyframes: [after]});
    this._frameDraftSuspended = true;
    try {
      this.report.keyframes[draft.index] = after;
      const draftAnimation = own(draft, 'animationBaseline')
        ? {before: this.report._styk.animation ?? null, after: draft.animationBaseline} : undefined;
      if (draftAnimation) {
        if (draftAnimation.after === null) delete this.report._styk.animation;
        else this.report._styk.animation = draftAnimation.after;
      }
      this._invalidate({timing: true}); this.tick = this.timeline[draft.index]?.start ?? 0;
      this._restoreSelection({...beforeSelection, tick: this.tick});
      this._record({kind: 'frame', label: 'Discard frame edits', index: draft.index, before, after: clone(after), beforeSelection,
        afterSelection: this._selectionState(), structural: true, timing: true, ...(draftAnimation ? {draftAnimation} : {})});
      rememberHistory(this._undo.at(-1), snapshot(draft), {version: 1, mode: draft.empty?'add':'update', index: draft.index, frameId: draft.frameId,...(draft.empty?{empty:true}:{})});
    } finally { this._frameDraftSuspended = false; }
    this._frameDraft = fresh(this, draft.empty?'add':'update',draft.empty);
    sync(this); this._emit('edit', {label: 'Discard frame edits', structural: true, timing: true}); return true;
  },
  /** Store an Add-mode working pose at the end without overwriting its source. */
  addDraftFrame({blank=false}={}) {
    if (this._animationEdit) this.commitAnimationEdit();
    this.commitDrag(); const draft = current(this), frames = this.report.keyframes, beforeDraft=snapshot(draft);
    if (frames.length >= 100000) throw new Error('Remove a keyframe before adding beyond the 100,000-keyframe document limit.');
    if(draft?.empty) {
      const source=blank?createFrame([]):clone(this.frame); source._styk={...source._styk,frameId:this.frame._styk.frameId};
      this._frameDraftSuspended=true;
      try {
        this._frameDraft=fresh(this,'add'); sync(this);
        this._rangesEdit('Add keyframe',[{index:0,before:[clone(this.frame)],after:[source]}],{selectIndex:0});
      } finally {this._frameDraftSuspended=false;}
    } else if (this.animationChannels.length || own(draft ?? {}, 'animationBaseline') || this.evaluatedFrame.objects.some(object=>object._stykMovieclip)) {
      const source = blank ? createFrame([]) : placeAddedMovieclips(this,clone(this.evaluatedFrame));
      source.duration_raw = this.frame.duration_raw;
      const identity = this._nextFrameIdentity;
      let insert, animationPlan;
      try {
        insert = this._newInsertedFrames([source])[0];
        animationPlan = planDraftFrameAppend(this, insert);
      } catch (error) { this._nextFrameIdentity = identity; throw error; }
      const changes = [];
      if (draft?.mode === 'add' && draft.baseline)
        changes.push({index: draft.index, before: [clone(this.frame)], after: [clone(draft.baseline)]});
      const index = frames.length; changes.push({index, before: [], after: [insert]});
      this._frameDraftSuspended = true;
      try { this._rangesEdit('Add keyframe', changes, {selectIndex: index, animationPlan}); }
      finally { this._frameDraftSuspended = false; }
    } else {
      const source = blank ? createFrame([]) : placeAddedMovieclips(this,clone(this.frame)), insert = this._newInsertedFrames([source])[0], changes = [];
      if (draft?.mode === 'add' && draft.baseline)
        changes.push({index: draft.index, before: [clone(this.frame)], after: [clone(draft.baseline)]});
      const index = frames.length; changes.push({index, before: [], after: [insert]});
      this._frameDraftSuspended = true;
      try { this._rangesEdit('Add keyframe', changes, {selectIndex: index}); }
      finally { this._frameDraftSuspended = false; }
    }
    this._frameDraft = fresh(this, 'add');
    if (this._frameDraftEnabled) rememberHistory(this._undo.at(-1), beforeDraft, snapshot(this._frameDraft));
    sync(this); this._emit('frame-draft'); return this.frame;
  },
};

/** Guard unsupported working-copy operations before any planner mutates state. */
export function installFrameDraftPreflights(Editor) {
  const all = () => true, multi = values => new Set(values ?? []).size > 1;
  const methods = {
    _topologyEdit: all, replaceFigureDefinition: all,
    duplicateFrame: all, duplicateFrames: all, insertBlankFrame: all, insertDuplicateFrames: all,
    moveFrame: all, deleteFrames: all, reverseFrames: all, bakeFrames: all, pasteFrames: all, insertInbetweenFrames: all,
    setFramesDuration: args => multi(args[0]),
    applyFigureRange: args => multi(args[1]?.indices) || multi(args[1]?.ticks),
    setSceneColor: args => multi(args[1]?.indices), setSceneBackground: args => multi(args[1]?.indices),
    pasteCamera: args => multi(args[0]), resetCamera: args => multi(args[0]), applyCameraToFigures: args => multi(args[0]),
    setCameraValues: args => multi(args[1]), transformCamera: args => multi(args[1]), centerCamera: args => multi(args[1]),
    alignCameraToView: args => multi(args[1]),
  };
  for (const [name, eligible] of Object.entries(methods)) {
    const original = Editor.prototype[name]; if (typeof original !== 'function' || original.frameDraftPreflight) continue;
    const wrapped = function (...args) {
      const draft = current(this);
      if (this._frameDraftEnabled && draft?.mode === 'add' && draft.baseline && eligible(args) && !original.frameDraftAware)
        this._beforeFrameDraftGlobalEdit();
      return original.apply(this, args);
    };
    Object.defineProperty(wrapped, 'frameDraftPreflight', {value: true}); Editor.prototype[name] = wrapped;
  }
}
