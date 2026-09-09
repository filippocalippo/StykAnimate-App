import {buildGeometry, mixColor} from './pivot/geometry.mjs';
import {validateScene} from './pivot/model.mjs';
import {frameOrder, normalizeFrame, setOrder} from './pivot/structure.mjs';

const clone = value => structuredClone(value);
const floatBits = bits => new Float32Array(new Uint32Array([bits ?? 0]).buffer)[0];
const alphaByte = alpha => {
  const byte = Math.round((1 - alpha) * 255);
  if (byte < 0 || byte > 255 || Math.abs(1 - byte / 255 - alpha) > 1e-10)
    throw new Error('This opacity cannot be represented exactly in a combined figure.');
  return byte;
};
const sourceAssetIndex = segment => Number(segment.extra_u16 ?? segment.extra?.[0] ?? segment.image_asset_index ?? segment.sprite_index ?? 0);

function joinedGroup(editor, uid) {
  const frame = editor.frame, slot = frame.objects.findIndex(o => o.unique_id === uid);
  if (slot < 0) throw new Error('Select a figure with attached children.');
  const children = new Map(), queue = [slot], selected = new Set(queue);
  frame.objects.forEach((o, i) => { if (o.join) { const list = children.get(o.join.target_object_slot) ?? [];
    list.push(i); children.set(o.join.target_object_slot, list); } });
  for (let q = 0; q < queue.length; q++) for (const child of children.get(queue[q]) ?? [])
    if (!selected.has(child)) { selected.add(child); queue.push(child); }
  return {root: frame.objects[slot], slots: queue, ids: new Set(queue.map(i => frame.objects[i].unique_id))};
}

export const editorCombineMethods = {
  joinedFigureIds(uid = this.selectedUid) { return [...joinedGroup(this, uid).ids]; },

  /** Collapse a connected subtree into one native figure in the active keyframe. */
  combineJoinedFigure(uid = this.selectedUid, {name, authored = false} = {}) {
    if (!authored && this.dragging) this.commitDrag();
    if (!authored && this.animationChannels.length) {
      const figureIndex = this.report.figure_types.length, beforeSelection = this._selectionState();
      const sources = this.report._styk.frameSources, sourceIds = new Set(Object.keys(sources ?? {}));
      this._authoredTransaction('Combine connected figures', () => {
        this.combineJoinedFigure(uid, {name, authored: true});
      }, {structural: true});
      const command = this._undo.at(-1);
      command.figureDefinitionSplice = {index: figureIndex, figures: clone(this.report.figure_types.slice(figureIndex))};
      command.frameSourceChanges = Object.entries(this.report._styk.frameSources ?? {}).filter(([id]) => !sourceIds.has(id))
        .map(([id,value]) => ({id,before:{exists:false},after:{exists:true,value:clone(value)}}));
      command.hadFrameSourceTable = sources !== undefined;
      command.structural = true;
      const extraBytes = JSON.stringify([command.figureDefinitionSplice,command.frameSourceChanges]).length * 2;
      command.bytes += extraBytes; this._historySize += extraBytes;
      command.beforeSelection = beforeSelection;
      this._selectIds([uid]); this.selectedJoint = -1;
      command.afterSelection = this._selectionState();
      this._invalidate(); this._emit('edit', {label:'Combine connected figures', structural:true, definition:true, animation:true});
      return this.object;
    }
    const group = joinedGroup(this, uid); if (group.slots.length < 2) throw new Error('Join at least two figures before combining.');
    if ([...group.ids].some(id => this.getLayer(this.layerForUid(id))?.locked)) throw new Error('Unlock every connected figure before combining.');
    const frame = this.frame, geometry = buildGeometry(this.report, frame), order = frameOrder(frame);
    const positions = order.flatMap((id, i) => group.ids.has(id) ? [i] : []);
    if (positions.at(-1) - positions[0] + 1 !== positions.length)
      throw new Error('Move the joined figures to adjacent layers before combining, so their paint order can be preserved.');
    let totalSegments = 0, totalPolygons = 0, scale = null;
    for (const slot of group.slots) {
      const g = geometry.objects.get(slot), style = g.fig.segment_decode?.global_style;
      if (Number(g.obj.field28 ?? g.obj.transparency ?? 0) !== 0)
        throw new Error('Reset figure opacity to 100% before combining. Per-figure compositing cannot be flattened exactly.');
      if (Number(style?.outline_thickness ?? floatBits(style?.u28)) > 0)
        throw new Error('Remove figure outlines before combining. Separate outline passes cannot be flattened exactly.');
      totalSegments += g.fig.segments.length; totalPolygons += g.fig.polyfills?.length ?? 0;
      if (g.segments.some(s => s.seg.segment_type === 'text') && g.obj.scale > 0) {
        if (scale !== null && Math.abs(scale - g.obj.scale) > 1e-10)
          throw new Error('Text figures must have the same scale before combining, to preserve their vertical glyph scale.');
        scale = g.obj.scale;
      }
    }
    if (totalSegments > 30000 || totalPolygons > 20000) throw new Error('The combined figure exceeds the supported 30,000-segment or 20,000-polygon capacity.');
    scale ??= 1;
    const typeId = Math.max(0, ...this.report.figure_types.map(f => f.figure_type_id)) + 1;
    const figure = {figure_type_id: typeId, name: String(name ?? `${geometry.objects.get(group.slots[0]).fig.name || 'Figure'} combined`).slice(0, 255),
      segments: [], polyfills: [], image_assets: [], text_assets: [], segment_count: totalSegments,
      // Authoring semantics belong to the figure, regardless of the imported
      // file's version. Keep legacy playback timing and unrelated figures intact.
      _styk: {colorMode: 'segments'}};
    const handles = new Map(), records = new Map(), assets = new Map();
    let nextHandle = 1;
    for (const slot of group.slots) {
      const g = geometry.objects.get(slot), map = new Map(); handles.set(g.obj.unique_id, map);
      for (const segment of g.fig.segments) map.set(segment.segment_id, nextHandle++);
    }
    // The traversal is parent-first, so joined origins map to an existing handle.
    for (const slot of group.slots) {
      const object = frame.objects[slot], map = handles.get(object.unique_id);
      map.set(0, object.unique_id === uid ? 0 : handles.get(frame.objects[object.join.target_object_slot].unique_id).get(object.join.target_handle_id));
    }
    const installAsset = (g, render) => {
      const kind = render.seg.segment_type, index = sourceAssetIndex(render.seg), key = `${g.obj.unique_id}:${kind}:${index}`;
      if (assets.has(key)) return assets.get(key);
      if (!render.asset) throw new Error('An attached media segment is missing its decoded asset.');
      const list = kind === 'image' ? figure.image_assets : figure.text_assets, asset = clone(render.asset), next = list.length;
      Object.assign(asset, {kind, asset_index: next, table_index: next});
      for (const alias of ['image_index', 'sprite_index']) if (alias in asset) asset[alias] = next;
      list.push(asset); assets.set(key, next); return next;
    };
    for (const slot of group.slots) {
      const g = geometry.objects.get(slot), map = handles.get(g.obj.unique_id), raw = Number(g.obj.color_override_raw) >>> 0;
      for (const render of g.segments) {
        const segment = clone(render.seg);
        for (const key of ['_logical_segment_id', 'z_order_runtime_raw']) delete segment[key];
        Object.assign(segment, {segment_id: map.get(render.seg.segment_id), parent_id: map.get(render.seg.parent_id),
          length: render.length / scale, thickness: render.thickness / scale, angle_rad: render.angle, bend_rad: render.bend,
          color_rgb: [...render.rgb], transparency: alphaByte(render.alpha), color_alpha: render.alpha, z_order: 0});
        if (segment.secondary) {
          if (raw >>> 24 === 255) segment.secondary = null;
          else if (segment.segment_type !== 'text') segment.secondary.rgb = mixColor(segment.secondary.rgb, raw);
        }
        if (['image', 'text'].includes(segment.segment_type)) {
          segment.extra_u16 = installAsset(g, render);
          segment.extra_u8_a = Number(Boolean(segment.extra_u8_a ?? segment.extra?.[1]));
          segment.extra_u8_b = Number(Boolean(segment.extra_u8_b ?? segment.extra?.[2]) !== Boolean(g.obj.image_text_flags));
          segment.extra = [segment.extra_u16, segment.extra_u8_a, segment.extra_u8_b];
        }
        records.set(`${slot}:segment:${render.index}`, segment); figure.segments.push(segment);
      }
      for (const render of g.polys) {
        const polygon = clone(render.poly); polygon.polyfill_id = figure.polyfills.length + 1;
        polygon.segment_ids = polygon.segment_ids.map(id => map.get(id)); polygon.segment_ids_raw = [...polygon.segment_ids];
        Object.assign(polygon, {color_rgb: [...render.rgb], alpha_raw: alphaByte(render.alpha), color_alpha: render.alpha, z_order: 0});
        delete polygon.z_order_runtime_raw; records.set(`${slot}:poly:${render.index}`, polygon); figure.polyfills.push(polygon);
      }
    }
    let rank = 1;
    for (const drawable of geometry.drawables) if (group.ids.has(drawable.obj.unique_id)) {
      const record = records.get(`${drawable.slot}:${drawable.type === 'poly' ? 'poly' : 'segment'}:${drawable.index}`);
      record.z_order = rank; record.z_order_runtime_raw = rank - 1; rank++;
    }
    const beforeSelection = this._selectionState(), beforeFrame = clone(frame), afterFrame = clone(frame), figureIndex = this.report.figure_types.length;
    const rootGeometry = geometry.objects.get(group.slots[0]), combined = {...clone(group.root), scale,
      figure_type_id: typeId, root_x: rootGeometry.root.x, root_y: rootGeometry.root.y,
      color_override_raw: 0, field28: 0, image_text_flags: 0, angles: figure.segments.map(s => s.angle_rad),
      len_flag: 0, lengths: [], bend_flag: 0, bends: []};
    delete combined.runtime_segments;
    // Retain all joins by UID while removing the now-internal object slots.
    for (const object of afterFrame.objects) if (object.join) object.join.target_unique_id = afterFrame.objects[object.join.target_object_slot].unique_id;
    if (combined.join) combined.join.target_unique_id = frame.objects[combined.join.target_object_slot].unique_id;
    afterFrame.objects = afterFrame.objects.filter(o => !group.ids.has(o.unique_id)); afterFrame.objects.push(combined);
    const slots = new Map(afterFrame.objects.map((o, i) => [o.unique_id, i]));
    afterFrame.objects.forEach((o, i) => { o.object_slot = i; if (o.join) o.join.target_object_slot = slots.get(o.join.target_unique_id); });
    const nextOrder = order.filter(id => !group.ids.has(id)); nextOrder.splice(positions[0], 0, uid);
    setOrder(afterFrame, nextOrder); normalizeFrame(afterFrame);
    validateScene({...this.report, figure_types: [...this.report.figure_types, figure], keyframes: [afterFrame]});
    if (authored) {
      this.report.figure_types.push(figure);
      Object.assign(this.frame, afterFrame);
      return combined;
    }
    this.report.figure_types.push(figure); this.report.keyframes[this.frameIndex] = afterFrame; this._selectIds([uid]);
    this._record({kind: 'figure-splice', label: 'Combine joined figures', index: this.frameIndex, figureIndex,
      before: {figures: [], frame: beforeFrame}, after: {figures: [clone(figure)], frame: clone(afterFrame)},
      beforeSelection, afterSelection: this._selectionState(), structural: true, timing: false});
    this._invalidate(); this._emit('edit', {label: 'Combine joined figures', structural: true, definition: true});
    return this.object;
  },
};
