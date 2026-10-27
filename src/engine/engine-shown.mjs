/**
 * What the interface reads of the frame on show, from the engine's session (docs/engine/evaluation.md,
 * "The interface's frame"): the evaluated frame record (`editor.evaluatedFrame`), the timeline rows
 * (`editor.timeline`) and the geometry (`editor.geometry`) in the shape the canvas, the handles and the
 * pickers read: `{objects: Map<slot, group|null>, orderedObjects, drawables, token, changedSlots, warnings}`
 * with groups `{slot, obj, fig, root, joints, segments, polys, bounds, solvedAngles, solvedLengths}`.
 *
 * The session also samples the frames around the one on show (docs/engine/evaluation.md, "The interface's views"): the
 * motion-path trails and the pose at a trail point, the onion skins the stage draws, and the camera (the shot the frame is
 * seen through, another frame's camera, the samples of a camera-motion clip, the framing that keeps followed figures put).
 *
 * The session evaluates and builds; this module only reads what it sends. A geometry read names the read the
 * interface holds, and the session sends the groups of the figures that changed since: the others are the
 * groups already held, so the objects the canvas keeps by identity (handle descriptors) stay valid.
 */
import {resolveInstanceFigure} from '../animation-style.mjs';
import {isStatic} from '../pivot/read-view.mjs';
import {isMovieclip} from '../movieclips.mjs';
import {sticknodesDrawables, sticknodesSpriteAsset} from '../sticknodes/geometry.mjs';

const point = ([x, y]) => ({x, y});
/** `[x0, y0, x1, y1, …]` as points. */
const pointList = flat => {
  const points = new Array(flat.length >> 1);
  for (let i = 0; i < points.length; i++) points[i] = {x: flat[2 * i], y: flat[2 * i + 1]};
  return points;
};
/** The point before perspective at place `index` of the flat triples the session sent, or `undefined`. */
const rawAt = (triples, index) => triples && triples[3 * index] !== null ? [triples[3 * index], triples[3 * index + 1], triples[3 * index + 2]] : undefined;
/** A number the session wrote as `null` (not finite) is NaN. */
const real = value => value ?? NaN;

const definitionsOf = new WeakMap();
/** The figure definitions of a report by type id (a call the editor runs adds a definition to the table in place). */
function definitions(report) {
  const figures = report.figure_types ?? [];
  let known = definitionsOf.get(figures);
  if (!known || known.count !== figures.length) { known = {count: figures.length, map: new Map(figures.map(figure => [Number(figure.figure_type_id), figure]))}; definitionsOf.set(figures, known); }
  return known.map;
}

/** The image or text asset a segment draws (`segmentAt` in the editor's geometry). */
function assetOf(fig, seg, obj) {
  const assets = seg.segment_type === 'text' ? fig.text_assets : seg.segment_type === 'image' ? fig.image_assets : null;
  if (!assets) return undefined;
  const wanted = Number(seg.extra_u16 ?? seg.extra?.[0] ?? seg.image_asset_index ?? seg.sprite_index ?? 0);
  let asset = assets.find(candidate => Number(candidate.asset_index ?? candidate.table_index ?? candidate.image_index ?? candidate.sprite_index) === wanted);
  if (asset && !asset.anchor_length && asset.pivot && asset.endpoint) {
    asset = {...asset, anchor_start: asset.pivot, anchor_end: asset.endpoint,
      anchor_length: Math.hypot(asset.endpoint.x - asset.pivot.x, asset.endpoint.y - asset.pivot.y),
      anchor_angle_rad: Math.atan2(asset.endpoint.y - asset.pivot.y, asset.endpoint.x - asset.pivot.x)};
  }
  return obj._sticknodesSprite ? sticknodesSpriteAsset(asset, obj) : asset;
}

function spatialFrame(raw) {
  const {motionValue, choiceScale, shape, restLength, ...frame} = raw;
  if (motionValue !== null && motionValue !== undefined) frame.motionValue = motionValue;
  if (choiceScale !== undefined) frame.choiceScale = choiceScale;
  if (shape) { frame.shape = shape; frame.restLength = restLength; }
  return frame;
}

/** The order a figure's joints are worked out in: its roots in the figure's order, then each joint's children, breadth first.
 * The groups list the joints in this order, as the editor's own geometry did, so a pick that breaks a tie between
 * coincident joints by their order picks the same one. */
const jointOrders = new WeakMap();
function jointOrder(fig) {
  let order = jointOrders.get(fig.segments);
  if (order) return order;
  const ids = new Set(fig.segments.map(segment => Number(segment.segment_id))), children = new Map();
  order = [];
  fig.segments.forEach((segment, index) => {
    const parent = Number(segment.parent_id);
    if (!ids.has(parent)) order.push(index);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(index);
  });
  for (let q = 0; q < order.length; q++) order.push(...children.get(Number(fig.segments[order[q]].segment_id)) ?? []);
  jointOrders.set(fig.segments, order);
  return order;
}

/** The `flags` of a segment row (styk_eval::geometry::interface). */
const START = 1, END = 2, POINTS = 4, CONNECTOR = 8, SPATIAL = 16;

/** A group the session sent, as the interface reads it. */
function hydrate(raw, slot, frame, report, defs) {
  const obj = frame.objects[slot];
  const fig = obj && resolveInstanceFigure(defs.get(Number(obj.figure_type_id)), obj);
  if (!obj || !fig) return null;
  const root = point(raw.root);
  const joints = new Map([[0, root]]);
  const {ends, raws, startRaws} = raw;
  for (const i of jointOrder(fig)) {
    if (2 * i >= ends.length || ends[2 * i] === null) continue;
    const joint = {x: ends[2 * i], y: ends[2 * i + 1]}, rawPoint = rawAt(raws, i);
    if (rawPoint) joint.rawPoint = rawPoint;
    joints.set(Number(fig.segments[i].segment_id), joint);
  }
  if (isMovieclip(fig)) {
    // A movieclip instance is its handle: forty units from the root along its angle (what it draws is the engine's).
    const [row] = raw.segs, end = joints.get(Number(fig.segments[0].segment_id));
    const handle = {seg: fig.segments[0], obj, fig, slot, index: 0, start: root, end, points: [root, end], angle: real(row[1]), length: real(row[3]),
      bend: 0, thickness: 0, opacity: 1, alpha: 1, rgb: [0, 0, 0]};
    const group = {slot, obj, fig, root, joints, segments: [handle], polys: [], drawables: []};
    if (raw.bounds) group.bounds = {minX: raw.bounds[0], minY: raw.bounds[1], maxX: raw.bounds[2], maxY: raw.bounds[3]};
    if (raw.drawn) group.drawn = true;
    return group;
  }
  const segments = raw.segs.map(row => {
    const index = row[0], flags = row[11], seg = fig.segments[index];
    let at = 12;
    // A segment starts where its parent ends, unless it says otherwise.
    let start = flags & START ? {x: row[at++], y: row[at++]} : joints.get(Number(seg.parent_id)) ?? root;
    // A 3D bone's start before perspective: its own, unless it is its parent's joint as it stands.
    const startRaw = rawAt(startRaws, index);
    if (startRaw) {
      if (flags & START) start.rawPoint = startRaw;
      else if (start.rawPoint?.some((value, axis) => value !== startRaw[axis]) ?? true) start = {x: start.x, y: start.y, rawPoint: startRaw};
    }
    const joint = joints.get(Number(seg.segment_id));
    const end = flags & END ? {x: row[at++], y: row[at++]} : joint;
    const points = flags & POINTS ? pointList(row[at++]) : [start, end];
    if (flags & POINTS) points[points.length - 1] = end;
    const result = {
      type: seg.segment_type === 'circle' || seg.segment_type === 'image' || seg.segment_type === 'text' ? seg.segment_type : 'line',
      seg, obj, fig, asset: assetOf(fig, seg, obj), version: report.version, slot, index, start, end, points,
      angle: real(row[1]), bend: row[2] ?? 0, length: real(row[3]), z: Number(row[5] ?? seg.z_order ?? index + 1),
      thickness: row[4] ?? 0, rgb: [row[6], row[7], row[8]], alpha: row[9] ?? 1, opacity: row[10] ?? 1, static: isStatic(seg),
    };
    if (flags & CONNECTOR) { result.handle = joint; result.connector = true; }
    if (flags & SPATIAL) result.spatialFrame = spatialFrame(row[at++]);
    return result;
  });
  const polys = raw.polys.map(shape => {
    const poly = {type: 'poly', poly: fig.polyfills[shape.index], obj, fig, slot, index: shape.index, points: pointList(shape.points),
      z: shape.z, rgb: shape.rgb, alpha: shape.alpha, opacity: shape.opacity};
    // A one-sided face says whether it looks away (`culled: false` when it does not), as the editor's own geometry does.
    if (shape.culled) poly.culled = true;
    else if (poly.poly?._stykSurface) poly.culled = false;
    if (shape.depthValues) poly.depthValues = shape.depthValues;
    return poly;
  });
  const group = {slot, obj, fig, root, joints, segments, polys};
  if (raw.solved) { group.solvedAngles = raw.solved.angles; if (raw.solved.lengths) group.solvedLengths = raw.solved.lengths; }
  if (raw.bounds) group.bounds = {minX: raw.bounds[0], minY: raw.bounds[1], maxX: raw.bounds[2], maxY: raw.bounds[3]};
  if (raw.drawn) group.drawn = true;
  let drawables;
  // What paints, in painter order: the faces, then the visible segments (Stick Nodes shapes expanded).
  Object.defineProperty(group, 'drawables', {enumerable: true, get() {
    if (!drawables) {
      drawables = [];
      for (const poly of polys) if (!poly.culled) drawables.push(poly);
      for (const shape of segments) {
        if (shape.seg.visible === false) continue;
        const expanded = sticknodesDrawables(shape);
        if (expanded) drawables.push(...expanded); else drawables.push(shape);
      }
      drawables.sort((a, b) => a.z - b.z);
    }
    return drawables;
  }});
  return group;
}

/**
 * @param {{ask(kind: string, args: object): (string|null), source(motion: boolean): (object|null), report(): object}} owner
 *   `ask` reads the session (flushing the editor's pending edits first) and answers JSON text, `null` where the
 *   engine does not hold the document (no session runs it); `source` gives
 *   the stage what it draws from.
 */
export function createShown(owner) {
  /** The geometry the interface holds, per kind of frame (the frame on show, the motion-path display). */
  const held = [null, null];
  const read = (kind, args = {}) => {
    const text = owner.ask(kind, args);
    return text === null ? null : JSON.parse(text);
  };
  /** A read of the frame on show, which the interface cannot go without: the session answers or the document is not open. */
  const required = (kind, args = {}) => {
    const text = owner.ask(kind, args);
    if (text === null) throw Object.assign(new Error('The engine does not hold this document.'), {name: 'EngineUnavailable'});
    return JSON.parse(text);
  };
  return {
    /** Whether the engine answers (the session holds the open document). */
    get active() { return owner.ask('active', {}) !== null; },
    frame: () => required('frame'),
    documentFrame: () => required('document'),
    /** The motion-path edit's display frame, or `null` where it shows the document. */
    motionFrame: () => read('motion'),
    /** `editor.timeline`: one `{index, start, count}` per row. */
    timeline() {
      return required('timeline').map(([start, count], index) => ({index, start, count}));
    },
    /**
     * The geometry of `frame` (what `frame` is on show, or the motion-path display with `motion`): the groups the
     * session sent over the ones held. `null` for the motion display where it shows nothing.
     */
    geometry(frame, {motion = false} = {}) {
      const previous = held[+motion];
      const answer = (motion ? read : required)('geometry', {since: previous?.read ?? null, motion});
      if (!answer) return null;
      const report = owner.report(), defs = definitions(report);
      const groups = answer.full || !previous ? new Map() : new Map(previous.geometry.objects);
      const changed = new Set();
      for (const [slot, raw] of answer.slots) { groups.set(slot, raw && hydrate(raw, slot, frame, report, defs)); changed.add(slot); }
      for (const slot of [...groups.keys()]) if (slot >= answer.count) groups.delete(slot);
      const order = frame.object_draw_order ?? Array.from({length: answer.count}, (_, slot) => slot);
      const orderedObjects = [];
      for (const slot of order) { const group = groups.get(Number(slot)); if (group?.drawn) orderedObjects.push(group); }
      if (previous && !answer.full && !changed.size && previous.geometry.orderedObjects.length === orderedObjects.length
          && orderedObjects.every((group, index) => group === previous.geometry.orderedObjects[index])) {
        held[+motion] = {read: answer.token, geometry: previous.geometry};
        return previous.geometry;
      }
      let flat;
      const geometry = {objects: groups, orderedObjects, token: {}, previousToken: previous?.geometry.token, changedSlots: answer.full || !previous ? null : changed,
        get drawables() { return flat ??= orderedObjects.flatMap(group => group.drawables); }, warnings: answer.warnings};
      held[+motion] = {read: answer.token, geometry};
      return geometry;
    },
    /**
     * The geometry of `frame` as a drawing's first stroke previews it: the frame on show with the new cel's figure (`figure`, on layer
     * `layerId`) and its object added, which the document does not hold yet. Read once, whole; `null` where the engine does not answer.
     */
    previewGeometry(frame, figure, layerId, uid) {
      const answer = read('previewGeometry', {frame, figure, uid, layerId});
      if (!answer) return null;
      const report = owner.report(), defs = new Map(definitions(report));
      defs.set(Number(figure.figure_type_id), figure);
      const objects = new Map();
      for (const [slot, raw] of answer.slots) objects.set(slot, raw && hydrate(raw, slot, frame, report, defs));
      const order = frame.object_draw_order ?? Array.from({length: answer.count}, (_, slot) => slot);
      const orderedObjects = [];
      for (const slot of order) { const group = objects.get(Number(slot)); if (group?.drawn) orderedObjects.push(group); }
      let flat;
      return {objects, orderedObjects, token: {}, previousToken: undefined, changedSlots: null,
        get drawables() { return flat ??= orderedObjects.flatMap(group => group.drawables); }, warnings: answer.warnings};
    },
    /**
     * A figure, a set of figures or a movieclip with the pose on show as a document of its own, as a library file, the rig test
     * and the builder save it: `{figureUid | figureUids | figureTypeId, tick}`.
     */
    figureDocument(request) {
      const document = read('figureDocument', request);
      if (!document) throw Object.assign(new Error('The engine does not hold this document.'), {name: 'EngineUnavailable'});
      return document;
    },
    /** What the stage draws from: the session and the view it is at, or `null`. */
    source: motion => owner.source(motion),
    /**
     * The onion skins the stage draws for `request` (the settings and the figures hidden and selected, see
     * onion_skins.rs) behind the frame on show: the session, the view it is at and the request as text; `null` where the
     * engine does not hold the document.
     */
    onions(request) {
      const source = owner.source(false);
      return source && {session: source.session, view: source.view, request: JSON.stringify(request)};
    },
    /** The onion skins for `request` as the session plans them: `{ghosts: [{tick, opacity, tint, showOnTop, hidden, roots}]}`, far to near (`roots`: `uid, x, y` of every figure). */
    skins: request => read('onions', request),
    /**
     * The motion-path trails of `request.targets` as far as the session has sampled them: `{entries: [{key, version, complete,
     * ticks?, points?}]}` (trails.rs), or `null` where the engine does not hold the document.
     */
    trails: request => read('trails', request),
    /** The pose of the figures joined with `target` at `tick`, `{rx, ry, lines, circles}`, or `null`. */
    trailGhost: (target, tick) => read('ghost', {target, tick}),
    /** The camera the frame on show is seen through at the playhead (follow travel, then the presets' impulse), `null` for none. */
    shot: () => read('shot'),
    /** The camera an evaluated frame of the document holds at `tick`, `null` for the default one. */
    frameCamera: tick => read('frameCamera', {tick}),
    /** What `clip` alone does to the shot at each of `ticks`: `[x, y, rotation, zoom, …]`, a clip being edited included. */
    cameraSamples: (clip, ticks) => read('cameraSamples', {clip, ticks}),
    /** The framing offset that keeps these followed figures (`[{uid, weight}]`) where they stand in the frame on show. */
    framing: targets => read('framing', {targets}),
    /**
     * What the effects timeline reads of effect clips the interface holds (the document's, or a gesture's preview of one) at `tick`:
     * `[{tail, active, plays} | null, …]`, one per clip. `tail` is the ticks after a timed clip's end that its particles stay visible,
     * `active` whether it is on at `tick`, `plays` whether the inspector lists it there (it is on, or generated effects are still
     * showing). `null` where the engine does not hold the document.
     */
    vfxClips: (clips, tick) => read('vfxClips', {clips, tick}),
    /** The uids of the figures that the connected effects of figure `uid` filter together at the playhead (the owner first), `null` for none. */
    vfxGroup: uid => read('vfxGroup', {uid})?.members ?? null,
    /**
     * The rectangle the figures `uids` paint at the playhead without the reach of their effects, a movieclip instance's content
     * included (its geometry here is its handle alone): `{x, y, width, height}`, or `null` for nothing painted or no session.
     */
    vfxExtent(uids) {
      const rect = read('vfxExtent', {uids});
      return rect && {x: rect[0], y: rect[1], width: rect[2], height: rect[3]};
    },
    /** Forgets the geometry held (another document is open). */
    release() { held[0] = held[1] = null; },
  };
}
