/** Native camera commands and neighboring-pose alignment.
 * Camera-only edits snapshot four values per frame, never the figure arrays.
 */
import {buildGeometry, evaluatedFrame} from './pivot/geometry.mjs';
import {validateObjectChanges} from './pivot/model.mjs';
import {cameraIsIdentity, inverseCameraScale} from './pivot/background.mjs';
import {cameraMatrix, objectBounds} from './renderer-geometry.mjs';
import {animationChannels, animationChannelId} from './animation-channels.mjs';
import {applyAuthoredCameraToFigures} from './camera-bake-authored.mjs';
import {rotateOriginSupport} from './animation-origin-support.mjs';

const clone = value => structuredClone(value);
const fields = ['x', 'y', 'scale', 'angle_rad'];
const defaults = () => ({is_default: true, x: 0, y: 0, scale: 1, angle_rad: 0});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const finite = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
};

export function cameraValues(camera) {
  if (!camera || camera.is_default) return defaults();
  return {...camera, x: camera.x ?? 0, y: camera.y ?? 0, scale: camera.scale ?? 1, angle_rad: camera.angle_rad ?? 0};
}

function checked(camera) {
  for (const field of fields) finite(camera[field], `Camera ${field}`);
  for (const field of ['x', 'y', 'scale']) if (!Number.isFinite(Math.fround(camera[field])))
    throw new Error(`Camera ${field} exceeds the native range.`);
  if (camera.scale <= 0) throw new Error('Camera scale must be positive.');
  inverseCameraScale(camera);
  return {...camera, is_default: camera.x === 0 && camera.y === 0 && camera.scale === 1 && camera.angle_rad === 0};
}

function checkedPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Provide camera position values.');
  for (const key of Object.keys(patch)) {
    if (!fields.includes(key)) throw new Error(`Unknown camera value: ${key}.`);
    finite(patch[key], `Camera ${key}`);
  }
  return patch;
}

function snapshot(editor, index, objects = false) {
  const frame = editor.report.keyframes[index];
  return {index, camera: clone(frame.camera ?? null), ...(objects ? {objects: clone(frame.objects)} : {})};
}

function finishGesture(editor) {
  if (editor._animationEdit) editor.commitAnimationEdit();
  if (editor._drag) editor.commitDrag();
}

function hasAuthoredCamera(editor) {
  return Boolean(editor.report._styk?.layerSheet) || editor.propertyChannels || animationChannels(editor.report).some(channel => channel.target.kind === 'camera' && channel.keys?.length);
}

function cameraTargets(editor,indices){
  if(editor.report._styk?.layerSheet)return editor.sheetEditTimes(indices).map(tick=>({tick,index:Math.max(0,editor.timeline.findLastIndex(row=>row.start<=tick))}));
  const selected=editor._frameIndices(indices);
  return selected.map(index=>({index,tick:selected.length===1&&index===editor.frameIndex?editor.tick:editor.timeline[index].start}));
}

function composedFrame(editor, index, tick = editor.timeline[index].start) {
  const row = editor.timeline[index];
  return evaluatedFrame(editor.report, index, row.count > 1 ? (tick - row.start) / row.count : 0, tick);
}

function cameraKeyEntries(editor, before, after) {
  const entries = [];
  for (let i = 0; i < before.length; i++) for (const field of fields) {
    if (before[i].camera[field] === after[i].camera[field]) continue;
    entries.push({target: {kind: 'camera'}, property: field === 'angle_rad' ? 'rotation' : field,
      tick: before[i].tick ?? editor.timeline[before[i].index].start, value: after[i].camera[field]});
  }
  return entries;
}

function previewCameraKeys(editor, drag, entries) {
  if(editor.report._styk?.layerSheet){const frame={...editor.evaluatedFrame,camera:{...cameraValues(editor.evaluatedFrame.camera),...drag.cameraBaseline.find(e=>e.tick===editor.tick)?.camera}};
    for(const entry of entries)if(entry.tick===editor.tick)frame.camera[entry.property==='rotation'?'angle_rad':entry.property]=entry.value;
    frame.camera=checked(frame.camera);
    editor._sheetPropertyPreview=frame;return;}
  if (!entries.length) { editor.report._styk.animation = drag.animationBefore; return; }
  drag.previewChannels ??= new Map();
  const active = new Map();
  for (const entry of entries) {
    const id = animationChannelId(entry.target, entry.property);
    const values = active.get(id) ?? []; values.push(entry); active.set(id, values);
  }
  const channels = [...drag.animationBefore.channels];
  for (const [id, values] of active) {
    let cached = drag.previewChannels.get(id);
    if (!cached) {
      const source = channels.find(channel => channel.id === id) ?? (editor.propertyChannels ? editor.nativePropertyChannel(values[0].target, values[0].property) : editor._nativeAnimationChannels?.get(id));
      const property = values[0].property, field = property === 'rotation' ? 'angle_rad' : property;
      const keys = source?.keys?.slice() ?? [], byTick = new Map(keys.filter(key => !key.hidden).map(key => [key.tick, key]));
      const baseline = new Map(drag.cameraBaseline.map(entry => [entry.tick ?? editor.timeline[entry.index].start, entry.camera[field]]));
      let serial = 0;
      const ids = new Set(keys.map(key => key.id));
      for (const [tick, value] of baseline) {
        const existing = byTick.get(tick);
        let key;
        if (existing) { key = {...existing}; keys[keys.indexOf(existing)] = key; }
        else {
          let keyId; do { keyId = `camera-preview-${serial++}`; } while (ids.has(keyId));
          ids.add(keyId); key = {id: keyId, tick, value, interpolation: 'linear'}; keys.push(key);
        }
        byTick.set(tick, key);
      }
      keys.sort((a, b) => a.tick - b.tick || Number(Boolean(b.hidden)) - Number(Boolean(a.hidden)));
      cached = {channel: {...source, id, target: {kind: 'camera'}, property, source: 'authored', keys}, baseline, byTick};
      drag.previewChannels.set(id, cached);
    }
    for (const [tick, value] of cached.baseline) cached.byTick.get(tick).value = value;
    for (const entry of values) cached.byTick.get(entry.tick).value = entry.value;
    const index = channels.findIndex(channel => channel.id === id);
    if (index >= 0) channels[index] = cached.channel; else channels.push(cached.channel);
  }
  editor.report._styk.animation = {...drag.animationBefore, channels};
}

function cameraEdit(editor, label, indices, update) {
  finishGesture(editor);
  const authored = hasAuthoredCamera(editor);
  const before = [], after = [];
  for (const {index,tick} of cameraTargets(editor,indices)) {
    const entry = authored ? {index, tick, camera: cameraValues(composedFrame(editor, index, tick).camera)} : snapshot(editor, index);
    const value = update(cameraValues(entry.camera), index, authored ? tick : editor.timeline[index].start);
    if (!value) continue;
    const next = checked(value);
    if (same(cameraValues(entry.camera), next)) continue;
    before.push(entry); after.push({index, ...(authored ? {tick} : {}), camera: next});
  }
  if (!after.length) return 0;
  if (authored) {
    const entries = cameraKeyEntries(editor, before, after);
    if (!entries.length) return 0;
    editor.addAnimationKeys(entries);
  } else editor._commitCameraSnapshots(label, before, after);
  return after.length;
}

function boundsOfGeometry(entry) {
  return objectBounds([
    ...entry.segments.filter(segment => segment.seg.visible !== false).map(segment => ({...segment, type: segment.seg.segment_type || 'line'})),
    ...entry.polys,
  ]);
}

function neighborIndex(editor, direction) {
  if (direction !== -1 && direction !== 1) throw new Error('Choose the previous (-1) or next (1) frame.');
  const index = editor.frameIndex + direction;
  return index >= 0 && index < editor.report.keyframes.length ? index : -1;
}

export const editorCameraMethods = {
  _applyCameraSnapshot(entries) {
    for (const entry of entries) {
      const frame = this.report.keyframes[entry.index];
      if (entry.camera == null) delete frame.camera; else frame.camera = clone(entry.camera);
      if (entry.objects) this._replaceObjects(entry.index, entry.objects);
    }
  },

  _commitCameraSnapshots(label, before, after, beforeSelection = this._selectionState()) {
    this._applyCameraSnapshot(after);
    this._invalidate();
    this.tick = this.timeline[this.frameIndex].start;
    this._record({kind: 'camera', label, before, after, beforeSelection, afterSelection: this._selectionState(), structural: false, timing: false});
    this._emit('edit', {label, camera: true, changedFrames: after.map(entry => entry.index)});
    return true;
  },

  copyCamera() {
    this._cameraClipboard = checked(cameraValues(this.evaluatedFrame.camera));
    return clone(this._cameraClipboard);
  },

  pasteCamera(indices = [this.frameIndex]) {
    if (!this._cameraClipboard) return 0;
    const values = this._cameraClipboard;
    return cameraEdit(this, 'Paste camera', indices, camera => ({...camera, ...Object.fromEntries(fields.map(key => [key, values[key]]))}));
  },

  setCameraValues(patch, indices = [this.frameIndex]) {
    checkedPatch(patch);
    if (!Object.keys(patch).length) return 0;
    return cameraEdit(this, 'Edit camera values', indices, camera => ({...camera, ...patch}));
  },

  resetCamera(indices = [this.frameIndex]) {
    return cameraEdit(this, 'Reset camera', indices, camera => ({...camera, ...defaults()}));
  },

  /** Translation and angle are offsets; scale is a positive multiplier. */
  transformCamera(delta, indices = [this.frameIndex]) {
    checkedPatch(delta);
    return cameraEdit(this, 'Transform camera', indices, camera => ({...camera,
      x: camera.x + (delta.x ?? 0), y: camera.y + (delta.y ?? 0),
      angle_rad: camera.angle_rad + (delta.angle_rad ?? 0), scale: camera.scale * (delta.scale ?? 1)}));
  },

  beginCameraDrag({indices = [this.frameIndex], label = 'Move camera'} = {}) {
    finishGesture(this);
    const selected = this._frameIndices(indices); if (!selected.length) return false;
    const beforeSelection = this._selectionState();
    const authored = hasAuthoredCamera(this);
    if (!authored || selected.length > 1&&!this.report._styk?.layerSheet) this.tick = this.timeline[this.frameIndex].start;
    this._drag = {camera: true, label, index: this.frameIndex, before: [], changed: false,
      beforeSelection, cameraBefore: selected.map(index => snapshot(this, index)), documentToken: this._documentToken};
    const drag = this._drag;
    if (authored) {
      drag.animationOriginal = this.report._styk.animation;
      drag.animationBefore = this.report._styk.animation ?? {version:1, nextKeyId:1, channels:[]};
      drag.cameraBaseline = cameraTargets(this,indices).map(({index,tick}) => {
        return {index, tick, camera: cameraValues(composedFrame(this, index, tick).camera)};
      });
      drag.cameraCurrent = clone(drag.cameraBaseline);
    }
    this._invalidate();
    return true;
  },

  /** A pointer move is O(selected camera count), independent of scene size. */
  updateCameraDrag(delta, {fromStart = true} = {}) {
    try { checkedPatch(delta); }
    catch (error) { if (this._drag?.camera) this.cancelCameraDrag(); throw error; }
    if (!this._drag?.camera && !this.beginCameraDrag()) return false;
    const drag = this._drag;
    if (drag.documentToken !== this._documentToken || drag.index !== this.frameIndex) {
      this.cancelCameraDrag(); throw new Error('The document or frame changed during the camera gesture.');
    }
    try {
      const baseline = drag.cameraBaseline ?? drag.cameraBefore;
      const values = baseline.map((entry, i) => {
        const camera = cameraValues(fromStart ? entry.camera : drag.animationBefore ? drag.cameraCurrent[i].camera : this.report.keyframes[entry.index].camera);
        const next = checked({...camera,
          x: camera.x + (delta.x ?? 0), y: camera.y + (delta.y ?? 0),
          angle_rad: camera.angle_rad + (delta.angle_rad ?? 0), scale: camera.scale * (delta.scale ?? 1)});
        return {...entry, camera: !drag.animationBefore && fields.every(field => cameraValues(entry.camera)[field] === next[field]) ? clone(entry.camera) : next};
      });
      if (drag.animationBefore) {
        drag.cameraEntries = cameraKeyEntries(this, baseline, values);
        previewCameraKeys(this, drag, drag.cameraEntries); drag.cameraCurrent = values;
        drag.changed = Boolean(drag.cameraEntries.length);
      } else { this._applyCameraSnapshot(values); drag.changed = !same(drag.cameraBefore, values); }
      this._invalidate(); this._emit('edit', {live: true, camera: true, animation: Boolean(drag.animationBefore), changedFrames: values.map(entry => entry.index)});
      return true;
    } catch (error) { this.cancelCameraDrag(); throw error; }
  },

  commitCameraDrag() {
    const drag = this._drag; if (!drag?.camera) return false;
    if (drag.animationBefore) {
      this._sheetPropertyPreview=null;
      this._drag = null;
      if (drag.animationOriginal) this.report._styk.animation = drag.animationOriginal; else delete this.report._styk.animation;
      this._invalidate();
      if (!drag.cameraEntries?.length) return false;
      this.addAnimationKeys(drag.cameraEntries); return true;
    }
    const after = drag.cameraBefore.map(entry => snapshot(this, entry.index));
    this._drag = null;
    if (same(drag.cameraBefore, after)) return false;
    return this._commitCameraSnapshots(drag.label, drag.cameraBefore, after, drag.beforeSelection);
  },

  cancelCameraDrag() {
    const drag = this._drag; if (!drag?.camera) return false;
    this._drag = null;this._sheetPropertyPreview=null;
    if (drag.animationBefore) {
      if (drag.animationOriginal) this.report._styk.animation = drag.animationOriginal; else delete this.report._styk.animation;
    }
    else this._applyCameraSnapshot(drag.cameraBefore);
    this._invalidate();
    this._emit('edit', {label: 'Cancel camera move', camera: true, changedFrames: drag.cameraBefore.map(entry => entry.index)});
    return true;
  },

  /** Follow the bounding box of the same selected UIDs in each selected key. */
  centerCamera(axis = 'both', indices = [this.frameIndex], {boundsOf = boundsOfGeometry} = {}) {
    if (!['both', 'x', 'y'].includes(axis)) throw new Error('Camera centering axis must be both, x or y.');
    if (typeof boundsOf !== 'function') throw new Error('Provide a figure bounds function.');
    const ids = new Set(this.selectedUids);
    if (!ids.size) return 0;
    return cameraEdit(this, 'Center camera on figures', indices, (camera, index, tick) => {
      const geometry = buildGeometry(this.report, composedFrame(this, index, tick));
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const entry of geometry.objects.values()) if (entry && ids.has(entry.obj.unique_id)) {
        const b = boundsOf(entry);
        if (!b || !['minX', 'minY', 'maxX', 'maxY'].every(key => Number.isFinite(b[key]))) continue;
        minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY); maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
      }
      if (!Number.isFinite(minX)) return null;
      return {...camera, ...(axis !== 'y' ? {x: (minX + maxX - this.report.canvas_width) / 2} : {}),
        ...(axis !== 'x' ? {y: (minY + maxY - this.report.canvas_height) / 2} : {})};
    });
  },

  /** View x/y are local canvas pixels, scale is CSS pixels per world pixel. */
  alignCameraToView({x, y, scale, width, height}, indices = [this.frameIndex]) {
    for (const [key, value] of Object.entries({x, y, scale, width, height})) finite(value, `Canvas ${key}`);
    if (scale <= 0 || width <= 0 || height <= 0) throw new Error('Canvas dimensions and zoom must be positive.');
    const w = this.report.canvas_width, h = this.report.canvas_height;
    return cameraEdit(this, 'Align camera with canvas', indices, camera => ({...camera,
      x: (width / 2 - x) / scale - w / 2, y: (height / 2 - y) / scale - h / 2,
      scale: Math.min(width / w, height / h) / scale}));
  },

  /** Bake the inverse camera transform into each instance, retaining joins. */
  applyCameraToFigures(indices = [this.frameIndex], options = {}) {
    finishGesture(this);
    if (this.report._styk?.layers?.fixed?.camera?.visible === false) return 0;
    if(this.report._styk?.layerSheet)return applyAuthoredCameraToFigures(this,indices,{...options,ticks:options.ticks??this.sheetEditTimes(indices)});
    if(options.ticks !== undefined || animationChannels(this.report).some(channel=>channel.keys?.length))return applyAuthoredCameraToFigures(this,indices,options);
    const before = [], after = [];
    for (const index of this._frameIndices(indices)) {
      const frame = this.report.keyframes[index], camera = cameraValues(frame.camera);
      if (cameraIsIdentity(camera)) continue;
      const matrix = cameraMatrix({report: this.report, frame}), scale = inverseCameraScale(camera);
      const original = snapshot(this, index, true), transformed = clone(original);
      transformed.camera = {...camera, ...defaults()};
      for (const object of transformed.objects) {
        const x = object.root_x, y = object.root_y;
        object.root_x = matrix[0] * x + matrix[2] * y + matrix[4];
        object.root_y = matrix[1] * x + matrix[3] * y + matrix[5];
        object.scale *= scale; object.angles = object.angles.map(angle => angle - camera.angle_rad);
        rotateOriginSupport(this.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id), object, -camera.angle_rad);
        delete object.runtime_segments;
      }
      const draft = {...frame, camera: transformed.camera, objects: transformed.objects};
      this._synchronizeAnimationOrigins(draft,original.objects);
      validateObjectChanges(this.report, draft, new Set(draft.objects.map(object => object.unique_id)));
      if (draft.objects.some(object => object.join)) {
        const geometry = buildGeometry(this.report, draft);
        for (const object of draft.objects) if (object.join) {
          const root = geometry.objects.get(object.object_slot)?.root;
          if (root) { object.root_x = root.x; object.root_y = root.y; }
        }
        this._synchronizeAnimationOrigins(draft,original.objects);
      }
      before.push(original); after.push(transformed);
    }
    if (!after.length) return 0;
    this._commitCameraSnapshots('Apply camera to figures', before, after);
    return after.length;
  },

  /** Match native handle ID and UID, never segment-array position in the neighbor. */
  locateHandle(direction = -1, {uid = this.selectedUid, jointIndex = this.selectedJoint, handleId, editMode = false} = {}) {
    if (editMode) return this.locateEditedHandle(direction, {uid, jointIndex, handleId});
    finishGesture(this);
    const index = neighborIndex(this, direction); if (index < 0) return false;
    const current = this.selectionFrame ?? this.frame;
    const slot = current.objects.findIndex(object => object.unique_id === uid), object = current.objects[slot];
    const neighbor = composedFrame(this, index), neighborSlot = neighbor.objects.findIndex(object => object.unique_id === uid);
    if (!object || neighborSlot < 0) return false;
    const figure = this.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id);
    const handle = handleId ?? (jointIndex < 0 ? 0 : figure?.segments[jointIndex]?.segment_id);
    if (!Number.isInteger(handle) || handle < 0) return false;
    const source = buildGeometry(this.report, current).objects.get(slot)?.joints.get(handle);
    const target = buildGeometry(this.report, neighbor).objects.get(neighborSlot)?.joints.get(handle);
    if (!source || !target) return false;
    const dx = target.x - source.x, dy = target.y - source.y;
    if (!dx && !dy) return false;
    if (!this.selectedUids.has(uid)) this.select(uid, jointIndex);
    this.beginTranslationDrag(direction < 0 ? 'Locate handle in previous frame' : 'Locate handle in next frame');
    try { this.moveSelection(dx, dy); return this.commitDrag(); }
    catch (error) { this.cancelDrag(); throw error; }
  },

  locateCamera(direction = -1, channel = 'position', indices = [this.frameIndex]) {
    if (!['position', 'rotation', 'scale', 'pose'].includes(channel)) throw new Error('Choose camera position, rotation, scale or pose.');
    const index = neighborIndex(this, direction); if (index < 0) return 0;
    const camera = cameraValues(composedFrame(this, index).camera);
    const keys = channel === 'position' ? ['x', 'y'] : channel === 'rotation' ? ['angle_rad'] : channel === 'scale' ? ['scale'] : fields;
    return this.setCameraValues(Object.fromEntries(keys.map(key => [key, camera[key]])), indices);
  },
};

export function installEditorCamera(Editor) {
  Object.assign(Editor.prototype, editorCameraMethods);
  return Editor;
}
