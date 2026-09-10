import {normalizePaint} from './paint.mjs';
import {styleColor, polygonIdentity, resolveInstanceFigure, animationStyleValue} from './animation-style.mjs';
import {segmentPaint} from './paint.mjs';
/** Native Shift operations. Styles journal small fields; topology is committed
 * once across every source pose. See artifacts/native-static/builder-branch-rules.md. */
import {builderDrawables} from './editor-builder-style.mjs';

const clone = value => value === undefined ? undefined : structuredClone(value);
const kinds = ['line', 'circle', 'image', 'circleFill', 'circleClear', 'text', 'squareLine'];
const circles = new Set([1, 3, 4]);
const finite = (value, label, min = -Infinity, max = Infinity) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`${label} must be a finite number between ${min} and ${max}.`);
  return value;
};
const rgb = value => {
  if (typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)) value = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
  if (!Array.isArray(value) || value.length !== 3 || value.some(n => !Number.isInteger(n) || n < 0 || n > 255))
    throw new Error('Color must be a six-digit hex color or three RGB bytes.');
  return [...value];
};
const transparency = value => Math.round(255 * (1 - finite(value, 'Opacity', 0, 1)));
const code = segment => segment.primitive_code ?? kinds.indexOf(segment.segment_kind ?? segment.segment_type ?? 'line');
const field = (path, value) => ({path, exists: true, value});

function branch(figure, selectedIndex, whole = true, polygons = false) {
  const selected = figure?.segments[selectedIndex];
  if (!selected) return {indices: [], queue: [], polygons: []};
  const children = new Map();
  if (whole) figure.segments.forEach((segment, index) => {
    const list = children.get(segment.parent_id) ?? []; list.push(index); children.set(segment.parent_id, list);
  });
  const queue = [selectedIndex], ids = new Set([selected.segment_id]);
  for (let i = 0; i < queue.length; i++) for (const index of children.get(figure.segments[queue[i]].segment_id) ?? []) {
    const id = figure.segments[index].segment_id;
    if (!ids.has(id)) {ids.add(id); queue.push(index);}
  }
  const indices = whole ? figure.segments.flatMap((segment, index) => ids.has(segment.segment_id) ? [index] : []) : [selectedIndex];
  ids.add(selected.parent_id);
  return {indices, queue, polygons: polygons && whole ? (figure.polyfills ?? []).flatMap((polygon, index) =>
    polygon.segment_ids?.every(id => ids.has(id)) ? [index] : []) : []};
}
/** Iterative O(V+E), preserving source-array order and sparse native handle IDs. */
export const branchSegmentIndices = (figure, selectedIndex) => branch(figure, selectedIndex).indices;

function stylePatch(figure, selectedIndex, patch, targets) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Choose a branch style patch.');
  for (const key of Object.keys(patch)) if (!['color', 'opacity', 'thickness', 'static', 'gradient', 'paint'].includes(key))
    throw new Error(`Branch style ${key} is not editable. Use the caps or circle-fill command to change shape.`);
  const values = {};
  if ('paint' in patch) {
    values.paint = normalizePaint(patch.paint);
    const first = values.paint.stops[0], last = values.paint.stops.at(-1);
    patch = {...patch, color:first.color, opacity:first.opacity, gradient:values.paint.type === 'solid' ? null : {color:last.color, opacity:last.opacity}};
  }
  if ('color' in patch) values.color = rgb(patch.color);
  if ('opacity' in patch) values.alpha = transparency(patch.opacity);
  // Fixed numeric input follows the existing editor's native float domain.
  // Only the increment/decrement action has Pivot's 1,000-unit clamp.
  if ('thickness' in patch) values.thickness = finite(patch.thickness, 'Thickness', 0, 1e6);
  if ('static' in patch) {
    if (typeof patch.static !== 'boolean') throw new Error('Static must be true or false.');
    values.static = patch.static;
  }
  if ('gradient' in patch && patch.gradient !== null && patch.gradient !== false) {
    const gradient = patch.gradient;
    if (!gradient || typeof gradient !== 'object' || Array.isArray(gradient) || Object.keys(gradient).some(key => !['color', 'opacity'].includes(key)))
      throw new Error('Gradient must contain a color and opacity, or be null.');
    values.gradientColor = rgb(gradient.color ?? figure?.segments[selectedIndex]?.secondary?.rgb ?? '#ffffff');
    if ('opacity' in gradient) values.gradientAlpha = transparency(gradient.opacity);
  }
  const entries = [];
  for (const index of targets.indices) {
    const segment = figure.segments[index], base = ['segments', index];
    if ('paint' in values) entries.push(field([...base, 'paint'], values.paint));
    else if (segment.paint && ('color' in patch || 'opacity' in patch || 'gradient' in patch)) {
      const paint = clone(segment.paint);
      if ('color' in values) paint.stops[0].color = values.color;
      if ('alpha' in values) paint.stops[0].opacity = 1-values.alpha/255;
      if ('gradient' in patch) { if (!values.gradientColor) {paint.type='solid';paint.stops=[paint.stops[0]];} else {paint.stops.at(-1).color=values.gradientColor;if ('gradientAlpha' in values)paint.stops.at(-1).opacity=1-values.gradientAlpha/255;} }
      entries.push(field([...base, 'paint'], paint));
    }
    if ('color' in values) entries.push(field([...base, 'color_rgb'], [...values.color]));
    if ('alpha' in values) entries.push(field([...base, 'transparency'], values.alpha), field([...base, 'color_alpha'], 1 - values.alpha / 255));
    if ('thickness' in values) entries.push(field([...base, 'thickness'], values.thickness), field([...base, 'visible'], values.thickness > .01 || code(segment) > 0));
    if ('static' in values) {
      const aux = (segment.aux_code ?? 0) & ~1 | Number(values.static), flags = code(segment) | (aux << 8);
      const bits = {...segment.flag_bits, is_static: values.static};
      if ('raw' in bits) bits.raw = flags;
      if ('high_byte' in bits) bits.high_byte = aux;
      if ('set_bits' in bits) bits.set_bits = Array.from({length: 16}, (_, bit) => bit).filter(bit => flags & (1 << bit));
      entries.push(field([...base, 'is_static'], values.static), field([...base, 'aux_code'], aux), field([...base, 'flags'], flags), field([...base, 'flag_bits'], bits));
    }
    if ('color' in patch || 'opacity' in patch || 'gradient' in patch) {
      let secondary = segment.secondary;
      if ('gradient' in patch) secondary = values.gradientColor ? {...segment.secondary, rgb: [...values.gradientColor], a: values.gradientAlpha ?? segment.secondary?.a ?? 0} : null;
      const primary = values.color ?? segment.color_rgb ?? [0, 0, 0], alpha = values.alpha ?? segment.transparency ?? 0;
      if (!values.paint && !segment.paint && secondary && primary.every((n, i) => n === secondary.rgb[i]) && alpha === (secondary.a ?? 0)) secondary = null;
      // Include this path even when unchanged: previews can disable/re-enable a
      // coincident gradient without losing the original field during undo.
      entries.push({path: [...base, 'secondary'], exists: secondary !== undefined, value: clone(secondary)});
    }
  }
  if ('color' in patch || 'opacity' in patch) for (const index of targets.polygons) {
    const base = ['polyfills', index];
    if ('color' in values) entries.push(field([...base, 'color_rgb'], [...values.color]));
    if ('alpha' in values) entries.push(field([...base, 'alpha_raw'], values.alpha), field([...base, 'color_alpha'], 1 - values.alpha / 255));
  }
  return {entries, removeEmptyParents: []};
}
/** Standard native-properties patch; does not mutate the definition. */
export function builderBranchStylePatch(figure, selectedIndex, patch) {
  return stylePatch(figure, selectedIndex, patch, branch(figure, selectedIndex, true, 'color' in patch || 'opacity' in patch));
}
function apply(figure, patch) {
  for (const {path, exists, value} of patch.entries) {
    let parent = figure; for (const key of path.slice(0, -1)) parent = parent[key];
    if (exists) parent[path.at(-1)] = clone(value); else delete parent[path.at(-1)];
  }
}
/** Cache branch membership once for a continuous numeric property gesture. */
export function builderBranchStyleBinding(editor, patch) {
  const figure = editor.figure, selected = editor.selectedJoint;
  if (!figure?.segments[selected]) return null;
  const targets = branch(figure, selected, true, 'color' in patch || 'opacity' in patch);
  const initial = stylePatch(figure, selected, patch, targets), keys = Object.keys(patch).sort().join(',');
  return {paths: initial.entries.map(entry => entry.path), segmentIndices: [...targets.indices], mutate(targetFigure, value = patch) {
    if (Object.keys(value).sort().join(',') !== keys) throw new Error('The branch style gesture fields changed.');
    apply(targetFigure, stylePatch(targetFigure, selected, value, targets));
  }};
}
function capture(figure, paths) {
  return {entries: paths.map(path => {
    let parent = figure; for (const key of path.slice(0, -1)) parent = parent[key];
    const exists = Object.hasOwn(parent, path.at(-1));
    return {path, exists, value: exists ? clone(parent[path.at(-1)]) : undefined};
  }), removeEmptyParents: []};
}
function command(editor, label, patch) {
  if (!patch.entries.length) return false;
  if (editor.dragging) editor.commitDrag();
  const figure = editor.figure, index = editor.report.figure_types.indexOf(figure), selection = editor._selectionState();
  const before = capture(figure, patch.entries.map(entry => entry.path));
  if (JSON.stringify(before.entries) === JSON.stringify(patch.entries)) return false;
  apply(figure, patch);
  editor._record({kind: 'native-properties', scope: 'figure', index, label, before, after: clone(patch),
    beforeSelection: selection, afterSelection: editor._selectionState(), definition: true, structural: false, timing: false});
  editor._invalidate(); editor._emit('edit', {label, definition: true}); return true;
}
function shapePatch(figure, indices, target) {
  const entries = [];
  for (const index of indices) {
    const segment = figure.segments[index]; if (code(segment) === target) continue;
    const base = ['segments', index], flags = target | ((segment.aux_code ?? 0) << 8);
    entries.push(...Object.entries({primitive_code: target, segment_kind: kinds[target], segment_type: circles.has(target) ? 'circle' : 'line',
      flags, visible: segment.thickness > .01 || target > 0}).map(([key, value]) => field([...base, key], value)));
    if (segment.flag_bits) {
      const bits = {...segment.flag_bits};
      if ('raw' in bits) bits.raw = flags;
      if ('low_byte' in bits) bits.low_byte = target;
      if ('set_bits' in bits) bits.set_bits = Array.from({length: 16}, (_, bit) => bit).filter(bit => flags & (1 << bit));
      entries.push(field([...base, 'flag_bits'], bits));
    }
  }
  return {entries, removeEmptyParents: []};
}
function retainRuntimePose(object, segments) {
  const runtime = object.runtime_segments; if (!runtime) return;
  for (const [flag, values, field] of [['len_flag', 'lengths', 'length'], ['bend_flag', 'bends', 'bend_rad']]) {
    if (object[flag] || !segments.some((segment, i) => runtime[i]?.[field] !== undefined && runtime[i][field] !== (segment[field] ?? 0))) continue;
    object[flag] = 1; object[values] = segments.map((segment, i) => runtime[i]?.[field] ?? segment[field] ?? 0);
  }
}
function newHandles(segments, count) {
  const used = new Set(segments.map(segment => segment.segment_id)), result = [];
  let candidate = 1; for (const id of used) candidate = Math.max(candidate, id + 1);
  for (let i = 0; i < count; i++) {
    if (candidate > 65535) candidate = 1;
    while (used.has(candidate) && candidate <= 65535) candidate++;
    if (candidate > 65535) throw new Error('Figure joint capacity reached.');
    result.push(candidate); used.add(candidate++);
  }
  return result;
}
function splitAngle(angle, firstBend) {
  // Native Split's epsilon gates the angle adjustment only; both bend fields
  // are still divided. NormalizeAngle performs one wrap, preserving +/-pi.
  if (Math.abs(firstBend) <= .001) return angle;
  const next = angle + firstBend;
  return next > Math.PI ? next - Math.PI * 2 : next < -Math.PI ? next + Math.PI * 2 : next;
}

export const editorBuilderBranchMethods = {
  updateBuilderSegmentStyle(patch = {}, {branch: whole = false} = {}) {
    const figure = this.figure, selected = this.selectedJoint;
    if (!figure?.segments[selected]) return false;
    if (typeof whole !== 'boolean') throw new Error('Choose whether to style the whole branch.');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Choose a segment style patch.');
    const {shape, ...style} = patch, targets = branch(figure, selected, whole, 'color' in patch || 'opacity' in patch);
    const changes = stylePatch(figure, selected, style, targets);
    if (this.propertyChannels && this.object && !('shape' in patch) && !('static' in patch)) {
      const entries = [];
      for (const index of targets.indices) {
        const target = {kind:'segment',uid:this.object.unique_id,handleId:figure.segments[index].segment_id,figureTypeId:figure.figure_type_id};
        let values={...patch};
        if ('gradient' in values && !('paint' in values)) {
          const paint=segmentPaint(resolveInstanceFigure(figure,this.object).segments[index]);
          if (!values.gradient) {paint.type='solid';paint.stops=[paint.stops[0]];}
          else {paint.type=paint.type === 'solid' ? 'linear' : paint.type;paint.stops=[paint.stops[0],{offset:1,color:rgb(values.gradient.color ?? '#ffffff'),opacity:values.gradient.opacity ?? 1}];}
          values.paint=paint;
        }
        delete values.gradient;
        if (values.paint) {
          const paint=normalizePaint(values.paint);values={...values,paint,color:paint.stops[0].color,opacity:paint.stops[0].opacity};
          if(paint.type !== 'solid') {values.gradientColor=styleColor(paint.stops.at(-1).color);values.gradientOpacity=paint.stops.at(-1).opacity;}
          const current=segmentPaint(resolveInstanceFigure(figure,this.object).segments[index]);
          const layout=p=>JSON.stringify({...p,stops:p.stops.map((stop,i)=>i===0||i===p.stops.length-1?{offset:stop.offset}:stop)});
          if(layout(paint)===layout(current))delete values.paint;
          else {
            values.paint={...paint,stops:paint.stops.map(stop=>({...stop}))};
            Object.assign(values.paint.stops[0],{color:current.stops[0].color,opacity:current.stops[0].opacity});
            if(paint.type!=='solid')Object.assign(values.paint.stops.at(-1),{color:current.stops.at(-1).color,opacity:current.stops.at(-1).opacity});
          }
        }
        for (const [property,raw] of Object.entries(values)) {
          const value=property === 'color' ? styleColor(rgb(raw)) : raw;
          if(JSON.stringify(value)!==JSON.stringify(animationStyleValue(figure,this.object,target,property)))entries.push({target,property,value});
        }
      }
      for (const index of targets.polygons) for (const property of ['color','opacity']) if (property in patch) entries.push({
        target:{kind:'polygon',uid:this.object.unique_id,polygonId:polygonIdentity(figure.polyfills[index],index),figureTypeId:figure.figure_type_id},property,
        value:property === 'color' ? styleColor(rgb(patch[property])) : patch[property]});
      return this.addAnimationKeys(entries);
    }
    if ('shape' in patch) {
      if (whole) throw new Error('Use the branch caps or circle-fill command to change shape.');
      if ([2, 5].includes(code(figure.segments[selected]))) throw new Error('Image and text segments retain their media type.');
      const target = typeof shape === 'number' ? shape : kinds.indexOf(shape);
      if (![0, 1, 3, 4, 6].includes(target)) throw new Error('Choose a round line, square line, or circle style.');
      // Resolve combined static + shape patches without overriding the new
      // static bit, while copying neither assets nor the whole definition.
      const preview = {segments: []}; preview.segments[selected] = clone(figure.segments[selected]); apply(preview, changes);
      const merged = new Map(changes.entries.map(entry => [JSON.stringify(entry.path), entry]));
      for (const entry of shapePatch(preview, [selected], target).entries) merged.set(JSON.stringify(entry.path), entry);
      changes.entries = [...merged.values()];
    }
    return command(this, whole ? 'Edit segment branch style' : 'Edit segment style', changes);
  },
  updateSegmentBranchStyle(patch = {}) {
    return this.updateBuilderSegmentStyle(patch, {branch: true});
  },
  changeBranchThickness(delta) {
    finite(delta, 'Thickness change'); if (!this.figure?.segments[this.selectedJoint]) return false;
    if(this.propertyChannels) {
      const figure=this.figure,object=this.object,resolved=resolveInstanceFigure(figure,object);
      return this.addAnimationKeys(branchSegmentIndices(figure,this.selectedJoint).map(index=>({
        target:{kind:'segment',uid:object.unique_id,handleId:figure.segments[index].segment_id,figureTypeId:figure.figure_type_id},
        property:'thickness',value:Math.fround(Math.min(1000,Math.max(0,resolved.segments[index].thickness+delta))),
      })));
    }
    const entries = [];
    for (const index of branchSegmentIndices(this.figure, this.selectedJoint)) {
      const segment = this.figure.segments[index], value = Math.fround(Math.min(1000, Math.max(0, segment.thickness + delta)));
      entries.push(field(['segments', index, 'thickness'], value), field(['segments', index, 'visible'], value > .01 || code(segment) > 0));
    }
    return command(this, 'Change branch thickness', {entries, removeEmptyParents: []});
  },
  setBranchCaps(square) {
    const selected = this.figure?.segments[this.selectedJoint]; if (!selected) return false;
    square ??= code(selected) === 0;
    if (typeof square !== 'boolean') throw new Error('Square caps must be true or false.');
    const indices = branchSegmentIndices(this.figure, this.selectedJoint).filter(index => code(this.figure.segments[index]) === code(selected));
    return command(this, 'Change branch caps', shapePatch(this.figure, indices, square ? 6 : 0));
  },
  setBranchFill(style) {
    const selected = this.figure?.segments[this.selectedJoint]; if (!selected || !circles.has(code(selected))) return false;
    style ??= code(selected) === 3 ? 4 : code(selected) === 4 ? 1 : 3;
    const target = typeof style === 'number' ? style : kinds.indexOf(style);
    if (!circles.has(target)) throw new Error('Choose circle, circleFill, or circleClear.');
    const indices = branchSegmentIndices(this.figure, this.selectedJoint).filter(index => circles.has(code(this.figure.segments[index])));
    return command(this, 'Change branch circle fill', shapePatch(this.figure, indices, target));
  },
  splitSegmentBranch(fraction = .5) {return this.splitBuilderSegments({branch: true, fraction});},
  /** Native Split also accepts circles and media. The optional fraction extends
   * its midpoint operation while preserving original endpoint identities. */
  splitBuilderSegments({branch: whole = true, fraction = .5} = {}) {
    finite(fraction, 'Split fraction');
    if (fraction <= 0 || fraction >= 1) throw new Error('Split fraction must be between zero and one.');
    if (typeof whole !== 'boolean') throw new Error('Choose whether to split the whole branch.');
    const figure = this.figure, selectedIndex = this.selectedJoint;
    if (!figure?.segments[selectedIndex]) return false;
    const targets = branch(figure, selectedIndex, whole);
    if (figure.segments.length + targets.indices.length > 30000) throw new Error('A native Pivot figure supports at most 30,000 segments.');
    const allocated = newHandles(figure.segments, targets.queue.length), split = new Map(targets.queue.map((index, i) => [index, allocated[i]]));
    const originSplits = targets.queue.map(index => ({handleId: figure.segments[index].segment_id, newId: split.get(index), fraction}));
    const segmentMap = new Map(originSplits.map(({handleId, newId}) => [handleId, [handleId, newId]]));
    return this._topologyEdit(whole ? 'Split segment branch' : 'Split segment', next => {
      const originals = next.segments, segments = [], pieces = new Map(), selectedHandle = split.get(selectedIndex);
      for (let index = 0; index < originals.length; index++) {
        const original = originals[index], id = split.get(index);
        if (id === undefined) {segments.push(original); continue;}
        const bend = original.bend_rad ?? 0, first = {...clone(original), segment_id: id, length: original.length * fraction, bend_rad: bend * fraction};
        const second = {...clone(original), parent_id: id, length: original.length * (1 - fraction), angle_rad: splitAngle(original.angle_rad, bend * fraction), bend_rad: bend * (1 - fraction)};
        segments.push(first, second); pieces.set(original.segment_id, {first, second});
      }
      for (const frame of this._allSourceFrames()) for (const object of frame.objects) if (object.figure_type_id === next.figure_type_id) {
        retainRuntimePose(object, originals);
        const angles = [], lengths = [], bends = [];
        for (let index = 0; index < originals.length; index++) {
          const original = originals[index], angle = object.angles[index], bend = object.bend_flag ? object.bends[index] : original.bend_rad ?? 0;
          if (!split.has(index)) {
            angles.push(angle); if (object.len_flag) lengths.push(object.lengths[index]); if (object.bend_flag) bends.push(bend); continue;
          }
          angles.push(angle, splitAngle(angle, bend * fraction));
          if (object.len_flag) {const length = object.lengths[index]; lengths.push(length * fraction, length * (1 - fraction));}
          if (object.bend_flag) bends.push(bend * fraction, bend * (1 - fraction));
        }
        object.angles = angles; if (object.len_flag) object.lengths = lengths; if (object.bend_flag) object.bends = bends;
        delete object.runtime_segments;
      }
      // Each old undirected polygon connection gains its midpoint exactly once,
      // including a connection crossing the polygon's closing edge.
      for (const polygon of next.polyfills ?? []) {
        const ids = polygon.segment_ids ?? [], expanded = [], inserted = new Set();
        for (let i = 0; i < ids.length; i++) {
          const a = ids[i], b = ids[(i + 1) % ids.length]; expanded.push(a);
          const forward = pieces.get(b), reverse = pieces.get(a), piece = forward?.first.parent_id === a ? forward : reverse?.first.parent_id === b ? reverse : null;
          if (piece && !inserted.has(piece.second.segment_id)) {expanded.push(piece.first.segment_id); inserted.add(piece.second.segment_id);}
        }
        if (expanded.length > 65535) throw new Error('Polygon connection capacity reached.');
        polygon.segment_ids = expanded;
      }
      // Native inserts the second drawable immediately after the first in the
      // combined polygon/segment ordering. Stable imported ties are retained.
      let order = 0;
      for (const entry of builderDrawables(next)) {
        const piece = entry.kind === 'segment' ? pieces.get(entry.item.segment_id) : null;
        for (const item of piece ? [piece.first, piece.second] : [entry.item]) {item.z_order_runtime_raw = order; item.z_order = ++order;}
      }
      next.segments = segments;
      this.selectedJoint = segments.findIndex(segment => segment.segment_id === selectedHandle);
    }, {segmentMap, originSplits});
  },
};
