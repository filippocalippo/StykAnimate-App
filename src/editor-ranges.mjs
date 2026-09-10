import {keyEasing, autoKeyRange, easingMode} from './keyframe-easing.mjs';
import {evaluatedFrame} from './pivot/geometry.mjs';
import {applyFrameTiming,captureTimingGeometry,restoreTimingGeometry} from './frame-timing-history.mjs';

const clone = value => structuredClone(value);
const BAKE_LIMITS = Object.freeze({frames: 20_000, objects: 1_000_000, segments: 10_000_000});
const duration = ticks => {
  if (!Number.isInteger(ticks) || ticks < 0 || ticks > 65535)
    throw new Error('Keyframe duration must be 0–65,535 frames.');
};

/** Frame-range commands share the editor's bounded, atomic range history. */
export const editorRangeMethods = {
  setFramesDuration(indices = [this.frameIndex], ticks) {
    duration(ticks);
    const selected = this._frameIndices(indices);
    return this._setFrameDurations(selected.map(index=>({index,ticks})));
  },
  _setFrameDurations(values,{label='Change keyframe durations',retainSelection=false}={}){
    // Validate the complete edit before touching a frame or committing a drag.
    this._frameIndices(values.map(value=>value.index));for(const value of values)duration(value.ticks);
    if (this._drag) this.commitDrag();
    const unique=new Map(values.map(value=>[value.index,value.ticks]));
    const changes=[...unique].sort(([a],[b])=>a-b).filter(([index,ticks])=>this.report.keyframes[index].duration_raw!==ticks)
      .map(([index,ticks])=>({index,before:{exists:Object.hasOwn(this.report.keyframes[index],'duration_raw'),value:this.report.keyframes[index].duration_raw},after:{exists:true,value:ticks}}));
    if(!changes.length)return 0;
    const beforeSelection=this._selectionState(),retained=captureTimingGeometry(this);
    const command={kind:'frame-timing',label,changes,beforeSelection,structural:false,timing:true,timingOnly:true};
    applyFrameTiming(this,command,'after');this._invalidate({timing:true});
    if(retainSelection)this._restoreSelection(beforeSelection);
    else{this.frameIndex=changes[0].index;this.tick=this.timeline[this.frameIndex]?.start??0;this._selectIds(this.selectedObjects.map(o=>o.unique_id));}
    command.afterSelection=this._selectionState();this._record(command);restoreTimingGeometry(this,retained);
    this._emit('edit',{label,structural:false,timing:true,timingOnly:true,frameIndices:changes.map(change=>change.index)});
    return changes.length;
  },

  setFramesEasing(indices = [this.frameIndex], easing) {
    const fields = keyEasing(easing), selected = this._frameIndices(indices);
    if (this._drag) this.commitDrag();
    const changes = selected.filter(index => JSON.stringify(this.report.keyframes[index]._styk?.easing) !== JSON.stringify(fields)).map(index => {
      const before = clone(this.report.keyframes[index]), after = clone(before);
      after._styk = {...after._styk, easing: clone(fields)};
      return {index, before: [before], after: [after]};
    });
    this._rangesEdit('Change keyframe easing', changes, {structural: false, retainSelection: true, frameEasing: true});
    return changes.length;
  },

  duplicateFrames(indices = [this.frameIndex]) {
    const selected = this._frameIndices(indices);
    if (!selected.length) return 0;
    if (this.report.keyframes.length + selected.length > 100_000)
      throw new Error('Duplicate fewer keyframes to stay within the 100,000-keyframe document limit.');
    if (this._drag) this.commitDrag();
    const copies = selected.map(index => clone(this.report.keyframes[index]));
    this._frameSplice('Duplicate keyframes', selected.at(-1) + 1, 0, copies);
    return copies.length;
  },

  insertBlankFrame(index = this.frameIndex + 1) {
    if (!Number.isInteger(index) || index < 0 || index > this.report.keyframes.length)
      throw new Error('Choose a valid blank keyframe position.');
    if (this.report.keyframes.length >= 100_000)
      throw new Error('Remove a keyframe before inserting beyond the 100,000-keyframe document limit.');
    if (this._drag) this.commitDrag();
    const frame = clone(this.frame);
    Object.assign(frame, {duration_raw: 1, objects: [], object_draw_order: [], object_draw_order_unique_ids: []});
    if ('object_count' in frame) frame.object_count = 0;
    this._frameSplice('Insert blank keyframe', index, 0, [frame]);
    return index;
  },

  /** Materialize visible output ticks before replacing any source keyframe. */
  bakeFrames(indices = [this.frameIndex]) {
    let selected = this._frameIndices(indices);
    const entries = this.timeline, expanded = new Set(selected);
    let covered = -1;
    for (const index of selected) {
      if (index < covered) continue;
      const [start, end] = autoKeyRange(this.report.keyframes, index, Math.min(index + 1, entries.length - 1), frame => frame._styk?.easing);
      for (let i = start; i < end; i++) expanded.add(i);
      covered = end;
    }
    selected = [...expanded].sort((a, b) => a - b);
    const segmentCounts = new Map(this.report.figure_types.map(figure => [figure.figure_type_id, figure.segments.length]));
    let resultingFrames = this.report.keyframes.length, objects = 0, segments = 0;
    const planned = [];
    for (const index of selected) {
      const frame = this.report.keyframes[index], count = entries[index].count;
      // Hidden keyframes remain available as tween targets and editable poses.
      if (!count || frame.duration_raw === 1) continue;
      resultingFrames += count - 1;
      objects += count * frame.objects.length;
      segments += count * frame.objects.reduce((sum, object) => sum + (segmentCounts.get(object.figure_type_id) ?? 0), 0);
      if (resultingFrames > BAKE_LIMITS.frames || objects > BAKE_LIMITS.objects || segments > BAKE_LIMITS.segments)
        throw new Error('Bake fewer keyframes or reduce their durations: baking is limited to 20,000 resulting keyframes, 1,000,000 generated figures, and 10,000,000 generated segments per command.');
      planned.push({index, count});
    }
    if (!planned.length) return 0;
    if (this.report.auto_easing) {
      const included = new Set(selected), checked = new Set();
      for (const {index, count} of planned) {
        if (count <= 1 || checked.has(index)) continue;
        let start = index, end = index;
        while (start > 0 && entries[start - 1].count > 1) start--;
        while (end + 1 < entries.length && entries[end + 1].count > 1) end++;
        for (let key = start; key <= end; key++) {
          if (!included.has(key))
            throw new Error('Select the entire connected tween run, or bake all keyframes, to preserve automatic easing.');
          checked.add(key);
        }
      }
    }
    if (this._drag) this.commitDrag();
    // In particular, auto easing reads neighbouring keys. Mutating while
    // sampling would change later samples within this same command.
    const changes = planned.map(({index, count}) => ({
      index,
      before: [clone(this.report.keyframes[index])],
      after: Array.from({length: count}, (_, tick) => {
        const frame = clone(evaluatedFrame(this.report, index, tick / count));
        frame.duration_raw = 1;
        if (easingMode(frame._styk?.easing) === 'auto') frame._styk = {...frame._styk, easing: {interpolation: 'constant'}};
        return frame;
      }),
    }));
    this._rangesEdit('Bake keyframes', changes);
    return planned.reduce((sum, entry) => sum + entry.count, 0);
  },
};

export function installEditorRanges(Editor) {
  Object.assign(Editor.prototype, editorRangeMethods);
  return Editor;
}
