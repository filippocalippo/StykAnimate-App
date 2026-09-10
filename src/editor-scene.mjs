/** Sparse Scene edits. Native frames keep their timing and object-array identity. */
import {animationChannels, sampleAnimationChannel, validateAnimationDocument, validateAnimationValue} from './animation-channels.mjs';
import {samplePoseTrack} from './animation-pose.mjs';
import {tweenBackground} from './pivot/background.mjs';
import {validateScene} from './pivot/model.mjs';
import {createFrame} from './demo.mjs';
import {evaluatedFrame} from './pivot/geometry.mjs';

const sceneFields = ['background_id', 'background_id_b', 'background_mix', 'background_color', '_stykBackgroundColor'];
const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const pickScene = frame => Object.fromEntries(sceneFields.filter(key => own(frame ?? {}, key)).map(key => [key, frame[key]]));
const keyframeFields = (editor, index) => ({index, fields: pickScene(editor.report.keyframes[index])});
const sceneChannel = (report, property) => animationChannels(report).find(channel => channel.target.kind === 'scene' && channel.property === property);

function sampleNativeScene(report, index, t = 0) {
  const a = report.keyframes[index], b = report.keyframes[index + 1];
  if (!a) return null;
  if (!b || t <= 0 || report.version < 5) return pickScene(a);
  if (t >= 1) return pickScene(b);
  return {...pickScene(a), ...tweenBackground(a, b, t)};
}

/** Scene sampling touches no figures, even inside a large inbetweened scene. */
export function sceneValuesAt(editor, index = editor.frameIndex, tick = editor.tick) {
  if(editor.report._styk?.layerSheet)return pickScene(evaluatedFrame(editor.report,index,0,tick));
  const row = editor.timeline[index];
  let scene = sampleNativeScene(editor.report, index, row.count > 1 ? (tick - row.start) / row.count : 0);
  const pose = sceneChannel(editor.report, 'pose');
  if (pose) scene = samplePoseTrack(editor.report, pose, tick, {sampleNative: sampleNativeScene}) ?? {background_id: 0, background_id_b: 0, background_mix: 0};
  scene = {...scene};
  // Background selection precedes the optional color override, independent of
  // channel insertion order, matching the common animation compositor.
  const background = sampleAnimationChannel(sceneChannel(editor.report, 'backgroundId'), tick);
  if (background !== undefined) { Object.assign(scene, {background_id: background, background_id_b: 0, background_mix: 0}); delete scene._stykBackgroundColor; }
  const color = sampleAnimationChannel(sceneChannel(editor.report, 'color'), tick);
  if (color === null) delete scene._stykBackgroundColor;
  else if (color !== undefined) scene._stykBackgroundColor = color;
  return scene;
}

function editable(editor) {
  const fixed = editor.report._styk?.layers?.fixed?.scene;
  if (fixed?.locked) throw new Error('Unlock the Scene track before editing its background.');
  if (fixed?.visible === false) throw new Error('Show the Scene track before editing its background.');
  if (editor._animationEdit) editor.commitAnimationEdit();
  if (editor._drag) editor.commitDrag();
}

function nextBackgroundId(report) {
  if ((report.backgrounds?.length ?? 0) >= 65534) throw new Error('The native Pivot background table is full.');
  let id = 0; for (const asset of report.backgrounds ?? []) id = Math.max(id, asset.background_id);
  if (!Number.isSafeInteger(id + 1)) throw new Error('Background identity capacity exceeded.');
  return id + 1;
}

function validateBackground(report, background) {
  if (!background || ![0, 1, 2, 3, 4].includes(background.kind)) throw new Error('Expected a decoded image, color or gradient background.');
  validateScene({...report, figure_types: [], backgrounds: [background], keyframes: [createFrame([])]});
}

function draft(editor) {
  const originalAnimation = editor.report._styk?.animation;
  const animation = originalAnimation ?? {version:1,nextKeyId:1,channels:[]};
  const nextKey = animation?.nextKeyId ?? 1;
  return {before: {frames: [], assets: [], channels: [], animationExists:Boolean(originalAnimation)}, after: {frames: [], assets: [], channels: [], animationExists:true},
    animation, nextKey, channels: new Map(), sources: [], touched: 0,
    authoredScene: Boolean(sceneChannel(editor.report, 'pose') || sceneChannel(editor.report, 'color') || sceneChannel(editor.report, 'backgroundId')),
    channel(property) {
      if (this.channels.has(property)) return this.channels.get(property);
      const original = sceneChannel(editor.report, property);
      if (!original && !editor.propertyChannels) throw new Error('Create this Scene channel before editing its keys.');
      const source = original ?? editor.nativePropertyChannel({kind:'scene'}, property);
      const index = original ? animation.channels.indexOf(original) : animation.channels.length + [...this.channels.values()].filter(value => !value.original).length;
      const channel = {...source, target: {...source.target}, keys: source.keys.map(key => ({...key}))};
      // Scene color has its own easing; a native Pose hold is not a color hold.
      if(!original && property==='color')for(const key of channel.keys){key.interpolation='linear';delete key.bezier;}
      const state = {index, original, channel, ticks: new Map(channel.keys.filter(key => !key.hidden).map(key => [key.tick, key])), ids: new Set(channel.keys.map(key => key.id))};
      this.channels.set(property, state); return state;
    },
    key(property, tick, value) {
      const state = this.channel(property), checked = validateAnimationValue({kind: 'scene'}, property, value), existing = state.ticks.get(tick);
      if (existing) {
        if(property==='color'&&(existing.value===null||existing.passthrough)){existing.interpolation='linear';delete existing.bezier;}
        existing.value = checked;delete existing.passthrough;return;
      }
      let id; do {
        if (!Number.isSafeInteger(this.nextKey) || this.nextKey < 1) throw new Error('Animation key identity capacity exceeded.');
        id = `key-${this.nextKey++}`;
      } while (state.ids.has(id));
      state.ids.add(id);
      const key = {id, tick, value: checked, interpolation: property === 'pose' || property === 'backgroundId' ? 'hold' : 'linear'};
      state.channel.keys.push(key); state.ticks.set(tick, key);
    },
    asset(asset) {
      const index = (editor.report.backgrounds?.length ?? 0) + this.after.assets.length;
      this.before.assets.push({index, asset: null}); this.after.assets.push({index, asset});
    },
    pose(index, tick, fields) {
      const source = {...createFrame([]), ...fields};
      const id = editor._assignFrameId(source);
      this.sources.push({id, before: {exists: false}, after: {exists: true, value: source}});
      this.key('pose', tick, {frameId: id});
    },
  };
}

function commit(editor, state, label) {
  for (const {index, original, channel} of state.channels.values()) {
    channel.keys.sort((a, b) => a.tick - b.tick || Number(Boolean(b.hidden)) - Number(Boolean(a.hidden)));
    if (same(original, channel)) continue;
    state.before.channels.push({index, channel: original}); state.after.channels.push({index, channel});
  }
  if (!state.after.frames.length && !state.after.channels.length && !state.after.assets.length) return 0;
  if(editor.report._styk?.layerSheet)return editor.movieclipBatch(label,()=>{
    const before={...state.before,channels:[],frames:[]},after={...state.after,channels:[],frames:[]},selection=editor._selectionState();
    if(after.assets.length||state.sources.length){const command={kind:'scene',label,before,after,frameSourceChanges:state.sources,beforeSelection:selection,afterSelection:selection,structural:true,timing:true};
      editor._applyFrameSourceChanges(command,'after');editor._applySceneSnapshot(after);editor._record(command);editor._invalidate();}
    if(state.after.channels.length)editor.sheetApplyChannels(state.after.channels.map(entry=>entry.channel),label);
    return state.touched;
  });
  if (state.after.channels.length) {
    state.before.nextKeyId = {exists: own(state.animation, 'nextKeyId'), value: state.animation.nextKeyId};
    state.after.nextKeyId = {exists: true, value: state.nextKey};
    const channels = state.animation.channels.slice(); for (const entry of state.after.channels) channels[entry.index] = entry.channel;
    // Pose validation must see both existing native/source identities and the
    // unpublished Scene-only sources. Keep the large document arrays shared.
    const frameSources = {...editor.report._styk.frameSources};
    for (const change of state.sources) frameSources[change.id] = change.after.value;
    validateAnimationDocument({...editor.report, _styk: {...editor.report._styk, frameSources,
      animation: {...state.animation, nextKeyId: state.nextKey, channels}}});
  }
  const timing = Boolean(state.after.channels.length);
  const selection = editor._selectionState();
  const command = {kind: 'scene', label, before: state.before, after: state.after, beforeSelection: selection, afterSelection: selection,
    structural: false, timing, ...(state.sources.length ? {frameSourceChanges: state.sources, hadFrameSourceTable: editor.report._styk.frameSources !== undefined} : {})};
  editor._applyFrameSourceChanges(command, 'after'); editor._applySceneSnapshot(state.after);
  editor._invalidate({timing});
  if (!state.authoredScene && state.after.frames.length) editor.tick = editor.timeline[editor.frameIndex].start;
  command.afterSelection = editor._selectionState();
  editor._record(command);
  editor._emit('edit', {label, scene: true, animation: timing, timing, changedFrames: state.after.frames.map(entry => entry.index)});
  return state.touched;
}

function assignBackground(editor, state, id, indices) {
  const pose = sceneChannel(editor.report, 'pose'), background = sceneChannel(editor.report, 'backgroundId'), color = sceneChannel(editor.report, 'color');
  const authored = Boolean(pose || background || color);
  for (const index of indices) {
    const tick = indices.length === 1 && index === editor.frameIndex ? editor.tick : editor.timeline[index].start;
    const current = authored ? sceneValuesAt(editor, index, tick) : pickScene(editor.report.keyframes[index]);
    const next = {...current, background_id: id, background_id_b: 0, background_mix: 0}; delete next._stykBackgroundColor;
    if (same(current, next)) continue;
    state.touched++;
    if (background || editor.propertyChannels) state.key('backgroundId', tick, id);
    else if (pose) state.pose(index, tick, next);
    else { state.before.frames.push(keyframeFields(editor, index)); state.after.frames.push({index, fields: next}); }
    if (color || editor.propertyChannels) state.key('color', tick, null);
  }
}

export const editorSceneMethods = {
  _applySceneSnapshot(snapshot) {
    const backgrounds = this.report.backgrounds ??= [];
    // Append/remove only imported entries; never clone or rewrite existing media.
    for (const entry of [...snapshot.assets].sort((a, b) => b.index - a.index)) {
      if (entry.fields) {
        for (const [field, state] of Object.entries(entry.fields)) {
          if (state.exists) backgrounds[entry.index][field] = state.value; else delete backgrounds[entry.index][field];
        }
      } else if (entry.asset == null) backgrounds.splice(entry.index, 1);
      else if (entry.index < backgrounds.length) backgrounds[entry.index] = clone(entry.asset);
      else backgrounds.splice(entry.index, 0, clone(entry.asset));
    }
    for (const entry of snapshot.frames) {
      const frame = this.report.keyframes[entry.index];
      for (const field of sceneFields) { if (own(entry.fields, field)) frame[field] = entry.fields[field]; else delete frame[field]; }
    }
    if (snapshot.channels.length) {
      const animation = this.report._styk.animation ?? {version:1,nextKeyId:1,channels:[]}, channels = animation.channels.slice();
      for (const entry of [...snapshot.channels].sort((a,b) => b.index-a.index)) {
        if (entry.channel == null) channels.splice(entry.index,1); else channels[entry.index] = clone(entry.channel);
      }
      this.report._styk.animation = {...animation, channels};
      if (snapshot.nextKeyId?.exists) this.report._styk.animation.nextKeyId = snapshot.nextKeyId.value;
      else delete this.report._styk.animation.nextKeyId;
      if (snapshot.animationExists === false) delete this.report._styk.animation;
    }
  },

  setSceneColor(argb, {indices = [this.frameIndex]} = {}) {
    if (!Number.isInteger(argb) || argb < 0 || argb > 0xffffffff) throw new Error('Scene color must be a 32-bit ARGB value.');
    if(this.report._styk?.layerSheet)return this._sheetPropertyEntries(this.sheetEditTimes(indices).map(tick=>({target:{kind:'scene'},property:'color',tick,value:argb})),'Set scene color');
    editable(this); const selected = this._frameIndices(indices); if (!selected.length) return 0;
    const state = draft(this), color = sceneChannel(this.report, 'color');
    if (color || this.propertyChannels) {
      for (const index of selected) {
        const tick = selected.length === 1 && index === this.frameIndex ? this.tick : this.timeline[index].start;
        if (sceneValuesAt(this, index, tick)._stykBackgroundColor === argb) continue;
        state.key('color', tick, argb); state.touched++;
      }
    } else {
      let asset = argb === 0xffffffff ? {background_id: 0} : this.report.backgrounds?.find(background => background.kind === 2 && background.color === argb);
      if (!asset) {
        asset = {background_id: nextBackgroundId(this.report), kind: 2, color: argb, name: `Color #${(argb & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`};
        state.asset(asset);
      }
      assignBackground(this, state, asset.background_id, selected);
    }
    return commit(this, state, 'Set scene color');
  },

  setSceneBackground(id, {indices = [this.frameIndex]} = {}) {
    if (!Number.isInteger(id) || id < 0 || id !== 0 && !this.report.backgrounds?.some(background => background.background_id === id))
      throw new Error('Choose an existing background.');
    if(this.report._styk?.layerSheet)return this._sheetPropertyEntries(this.sheetEditTimes(indices).flatMap(tick=>['backgroundId','color'].map(property=>({target:{kind:'scene'},property,tick,value:property==='color'?null:id}))),'Set scene background');
    editable(this); const selected = this._frameIndices(indices); if (!selected.length) return 0;
    const state = draft(this); assignBackground(this, state, id, selected);
    return commit(this, state, 'Set scene background');
  },

  importSceneBackground(background, {indices = [this.frameIndex]} = {}) {
    editable(this); const selected = this._frameIndices(indices); if (!selected.length) return null;
    const source = background?.background ?? background;
    const imported = {...clone(source), background_id: nextBackgroundId(this.report)}; imported.name ||= 'Background';
    validateBackground(this.report, imported);
    if(this.report._styk?.layerSheet)return this.movieclipBatch('Import scene background',()=>{
      const state=draft(this);state.asset(imported);commit(this,state,'Import background asset');
      this.setSceneBackground(imported.background_id,{indices});return this.report.backgrounds.find(asset=>asset.background_id===imported.background_id);
    });
    const state = draft(this); state.asset(imported); assignBackground(this, state, imported.background_id, selected);
    commit(this, state, 'Import scene background');
    return this.report.backgrounds.find(asset => asset.background_id === imported.background_id);
  },

  renameSceneBackground(id, name) {
    const index = this.report.backgrounds?.findIndex(background => background.background_id === id) ?? -1;
    if (index < 0) throw new Error('Choose an existing background.');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 160) throw new Error('Background names must contain 1–160 characters.');
    name = name.trim(); const background = this.report.backgrounds[index];
    if (background.name === name) return false;
    if (this._animationEdit) this.commitAnimationEdit(); if (this._drag) this.commitDrag();
    const state = draft(this);
    state.before.assets.push({index, fields: {name: {exists: own(background, 'name'), value: background.name}}});
    state.after.assets.push({index, fields: {name: {exists: true, value: name}}}); state.touched = 1;
    commit(this, state, 'Rename background'); return true;
  },
};

export function installEditorScene(Editor) { Object.assign(Editor.prototype, editorSceneMethods); return Editor; }
