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
import {findFigureType} from '../figure-types.mjs';
import {sticknodesDrawables, sticknodesSpriteAsset} from '../sticknodes/geometry.mjs';

/** A number the session wrote, as JSON text gave it: not finite is `null`, and `-0` is `0` (`+ 0`), so the sign of a zero never reaches the interface's arithmetic. */
const fin = value => Number.isFinite(value) ? value + 0 : null;
/** `n` words of the packet from `at` as numbers (`null` where not finite). */
const numbers = (w, at, n) => { const out = new Array(n); for (let k = 0; k < n; k++) out[k] = fin(w[at + k]); return out; };
/** `[x0, y0, x1, y1, …]` (`n` numbers from `at`) as points. */
const pointList = (w, at, n) => {
  const points = new Array(n >> 1);
  for (let k = 0; k < points.length; k++) points[k] = {x: fin(w[at + 2 * k]), y: fin(w[at + 2 * k + 1])};
  return points;
};
/** The point before perspective at place `index` of the `n` words of triples from `at`, or `undefined`. */
const rawAt = (w, at, n, index) => 3 * index + 2 < n && fin(w[at + 3 * index]) !== null ? [fin(w[at + 3 * index]), fin(w[at + 3 * index + 1]), fin(w[at + 3 * index + 2])] : undefined;
/** A number as `fin` gives it, but not finite is NaN. */
const real = value => Number.isFinite(value) ? value + 0 : NaN;

/** The figure definitions of a report by type id: the ones the objects drawn use are the ones fetched. */
const definitions = report => ({get: id => findFigureType(report.figure_types ?? [], id)});

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

/** The 3D frame of a bone from its `SPATIAL_WORDS` words at `at` (styk_eval::geometry::interface). */
function spatialFrame(w, at) {
  const frame = {q: numbers(w, at, 4), t: numbers(w, at + 4, 3), dual: numbers(w, at + 7, 4), nativeBend: fin(w[at + 11]), authoredBend: fin(w[at + 12]),
    origin: numbers(w, at + 14, 3), axis: numbers(w, at + 17, 3), stretch: fin(w[at + 20])};
  const motionValue = fin(w[at + 13]);
  if (motionValue !== null) frame.motionValue = motionValue;
  if (w[at + 21] === 1) frame.choiceScale = fin(w[at + 22]);
  if (w[at + 23] === 1) { frame.shape = {width: fin(w[at + 24]), taper: fin(w[at + 25])}; frame.restLength = fin(w[at + 26]); }
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

/** The `flags` of a group, of a segment row and of a polygon (styk_eval::geometry::interface). */
const DRAWN = 1, BOUNDS = 2, SOLVED = 4, SOLVED_LENGTHS = 8;
const START = 1, END = 2, POINTS = 4, CONNECTOR = 8, SPATIAL = 16, SPATIAL_WORDS = 27;
const CULLED_POLY = 1, DEPTH_POLY = 2;

/**
 * A geometry record. Its `drawables` getter lives here, outside `geometry()`: V8 gives all the closures of a function one
 * context holding every variable any of them captures, so a getter made inside `geometry()` kept `previous` alive, and with it
 * the geometry before that, and so on: every geometry the interface had read stayed in memory (about 1.5 MiB a tick on a dense scene).
 */
function geometryRecord({objects, orderedObjects, token, previousToken, changedSlots, warnings}) {
  let flat;
  return {objects, orderedObjects, token, previousToken, changedSlots,
    get drawables() { return flat ??= orderedObjects.flatMap(group => group.drawables); }, warnings};
}

/** Gives `group` its `drawables` (what paints, in painter order: the faces, then the visible segments, Stick Nodes shapes expanded). Outside
 * `hydrate` for the reason `geometryRecord` gives: the getter keeps only the faces and segments. */
function defineDrawables(group, polys, segments) {
  let drawables;
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
}

/** The segments up to which a geometry packet's groups are built at once rather than on first read (`EngineGroup`): about the
 * joints up to which every figure's are shown (docs/SCENE-EDITING.md, "Joints in dense frames"), where every group is read
 * anyway and building it later would only add to the work. An object, so a test can read a small packet lazily. */
export const shownLimits = {eagerSegments: 12000};
/** The segment rows of the group whose words start at `start` (the layout of `hydrate`). */
function rowsOf(w, start) {
  let at = start + 3;
  at += 1 + w[at];
  at += 1 + w[at];
  at += 1 + w[at];
  return w[at];
}
/** What a group holds that is built on first read (`EngineGroup`). */
const BUILT = ['joints', 'segments', 'polys', 'drawables', 'solvedAngles', 'solvedLengths'];
/** The packet each group not yet built reads its words from (`EngineGroup`), so a read can bound the packets kept. */
const unbuilt = new WeakMap();

/**
 * A group the session sent, as the interface reads it: the `length` words of the packet `w` from `start` (the layout is that of
 * styk_eval::geometry::interface). `null` where the group has no figure here.
 *
 * Its root, bounds and flags are read at once. Its joints, segments, faces, solved values and drawables are built on first read
 * of any of them (`EngineGroup`): in a dense frame the joints show each figure's origin only and the picture is the engine's, so
 * most groups are never built. `segmentCount`, `segmentLength(n)`, `segmentIndex(n)` and `segmentZ(n)` answer what the handles need without building it.
 */
function hydrate(w, start, length, slot, frame, report, defs, eager) {
  const obj = frame.objects[slot];
  const fig = obj && resolveInstanceFigure(defs.get(Number(obj.figure_type_id)), obj);
  if (!obj || !fig) return null;
  let at = start;
  const flags = w[at++];
  const root = {x: fin(w[at]), y: fin(w[at + 1])};
  at += 2;
  const endsAt = at + 1, endsLength = w[at];
  at = endsAt + endsLength;
  const rawsAt = at + 1, rawsLength = w[at];
  at = rawsAt + rawsLength;
  const startRawsAt = at + 1, startRawsLength = w[at];
  at = startRawsAt + startRawsLength;
  const layout = {endsAt, endsLength, rawsAt, rawsLength, startRawsAt, startRawsLength, rowsAt: at, from: start, to: start + length};
  let group;
  if (isMovieclip(fig)) {
    // A movieclip instance is its handle: forty units from the root along its angle (what it draws is the engine's).
    const joints = jointsOf(w, layout, fig, root);
    const end = joints.get(Number(fig.segments[0].segment_id));
    const handle = {seg: fig.segments[0], obj, fig, slot, index: 0, start: root, end, points: [root, end], angle: real(w[at + 2]), length: real(w[at + 4]),
      bend: 0, thickness: 0, opacity: 1, alpha: 1, rgb: [0, 0, 0]};
    group = {slot, obj, fig, root, joints, segments: [handle], polys: [], drawables: []};
  } else if (eager) {
    group = buildGroup({slot, obj, fig, root}, w, flags, layout, report.version);
    defineDrawables(group, group.polys, group.segments);
  } else group = new EngineGroup(slot, obj, fig, root, w, flags, layout, report.version);
  if (flags & BOUNDS) {
    const [minX, minY, maxX, maxY] = numbers(w, start + length - 4, 4);
    group.bounds = {minX, minY, maxX, maxY};
  }
  if (flags & DRAWN) group.drawn = true;
  return group;
}

/** Groups not yet built keep the packet they came in (`EngineGroup`), and a group a later read did not replace stays: past two
 * packets kept, the groups of the older ones take words of their own, so no more than two packets are kept however the groups
 * are read. */
function boundPackets(groups, current) {
  const packets = new Set();
  for (const group of groups) { const words = group && unbuilt.get(group); if (words) packets.add(words); }
  if (packets.size <= 2) return;
  for (const group of groups) if (group && unbuilt.has(group) && unbuilt.get(group) !== current) group.ownWords();
}

/** A group's joints by id: the root, then each segment's end, in the order they are worked out. */
function jointsOf(w, {endsAt, endsLength, rawsAt, rawsLength}, fig, root) {
  const joints = new Map([[0, root]]);
  for (const i of jointOrder(fig)) {
    if (2 * i >= endsLength) continue;
    const x = fin(w[endsAt + 2 * i]);
    if (x === null) continue;
    const joint = {x, y: fin(w[endsAt + 2 * i + 1])}, rawPoint = rawAt(w, rawsAt, rawsLength, i);
    if (rawPoint) joint.rawPoint = rawPoint;
    joints.set(Number(fig.segments[i].segment_id), joint);
  }
  return joints;
}

/**
 * A group of the engine's geometry, with what is built on first read (see `hydrate`) kept as words of the packet until then:
 * `slot, obj, fig, root` (and `bounds`, `drawn`) are its own from the start; reading any of `BUILT` builds them all as its own
 * values, as the eager group had them. A class, so groups keep one shape: thousands are read per frame in a dense scene.
 * Outside `hydrate` and `geometry()` for the reason `geometryRecord` gives: a group keeps the packet and nothing else, and drops
 * it once built.
 */
class EngineGroup {
  #words; #flags; #layout; #version; #rows;
  // Where each row starts, found as far as a read needed: rows have no fixed length.
  #rowStarts = null; #scanned = 0; #next; #lengths = null;
  constructor(slot, obj, fig, root, words, flags, layout, version) {
    this.slot = slot; this.obj = obj; this.fig = fig; this.root = root;
    this.#words = words; this.#flags = flags; this.#layout = layout; this.#version = version;
    this.#rows = words[layout.rowsAt]; this.#next = layout.rowsAt + 1;
    unbuilt.set(this, words);
  }
  #build() {
    const words = this.#words;
    if (!words) return;
    const built = buildGroup(this, words, this.#flags, this.#layout, this.#version);
    unbuilt.delete(this);
    this.#words = null; this.#rowStarts = null;
    for (const name of BUILT) if (name in built) Object.defineProperty(this, name, {value: built[name], writable: true, enumerable: true, configurable: true});
    defineDrawables(this, this.polys, this.segments);
  }
  /** What a read of `name` answers: the group built, its own value (none for solved values it does not have). */
  #read(name) { this.#build(); return Object.hasOwn(this, name) ? this[name] : undefined; }
  #write(name, value) { this.#build(); Object.defineProperty(this, name, {value, writable: true, enumerable: true, configurable: true}); }
  get joints() { return this.#read('joints'); }
  set joints(value) { this.#write('joints', value); }
  get segments() { return this.#read('segments'); }
  set segments(value) { this.#write('segments', value); }
  get polys() { return this.#read('polys'); }
  set polys(value) { this.#write('polys', value); }
  get drawables() { return this.#read('drawables'); }
  set drawables(value) { this.#write('drawables', value); }
  get solvedAngles() { return this.#read('solvedAngles'); }
  set solvedAngles(value) { this.#write('solvedAngles', value); }
  get solvedLengths() { return this.#read('solvedLengths'); }
  set solvedLengths(value) { this.#write('solvedLengths', value); }
  /** `segments.length`, without building the group. */
  get segmentCount() { return this.#rows; }
  /** Where row `n` starts in the words (-1 once built). */
  #rowAt(n) {
    if (!(n >= 0 && n < this.#rows)) return undefined;
    const words = this.#words;
    if (!words) return -1;
    const starts = this.#rowStarts ??= new Float64Array(this.#rows);
    let next = this.#next;
    while (this.#scanned <= n) {
      starts[this.#scanned++] = next;
      const rowFlags = words[next + 11];
      next += 12;
      if (rowFlags & START) next += 2;
      if (rowFlags & END) next += 2;
      if (rowFlags & POINTS) next += 1 + words[next];
      if (rowFlags & SPATIAL) next += SPATIAL_WORDS;
    }
    this.#next = next;
    return starts[n];
  }
  /** Every `segments[n].length` in one pass over the rows (a figure's origin can have a hundred segments hanging from it). */
  segmentLengths() {
    if (this.#lengths) return this.#lengths;
    const lengths = this.#lengths = new Float64Array(this.#rows), words = this.#words;
    if (!words) { this.segments.forEach((shape, n) => { lengths[n] = shape.length; }); return lengths; }
    let at = this.#layout.rowsAt + 1;
    for (let n = 0; n < lengths.length; n++) {
      lengths[n] = real(words[at + 3]);
      const rowFlags = words[at + 11];
      at += 12;
      if (rowFlags & START) at += 2;
      if (rowFlags & END) at += 2;
      if (rowFlags & POINTS) at += 1 + words[at];
      if (rowFlags & SPATIAL) at += SPATIAL_WORDS;
    }
    return lengths;
  }
  /** `segments[n].length`, `.index` and `.z`, read where the row lies until the group is built. */
  segmentLength(n) {
    const at = this.#rowAt(n);
    return at === undefined ? undefined : this.#words ? real(this.#words[at + 3]) : this.segments[n].length;
  }
  segmentIndex(n) {
    const at = this.#rowAt(n);
    return at === undefined ? undefined : this.#words ? this.#words[at] : this.segments[n].index;
  }
  segmentZ(n) {
    const at = this.#rowAt(n);
    if (at === undefined) return undefined;
    if (!this.#words) return this.segments[n].z;
    const index = this.#words[at], z = fin(this.#words[at + 5]);
    return Number(z ?? this.fig.segments[index].z_order ?? index + 1);
  }
  /** Gives the group words of its own, so it no longer keeps the packet it came in (`boundPackets`). */
  ownWords() {
    if (!this.#words) return;
    const layout = this.#layout, {from, to} = layout;
    this.#words = this.#words.slice(from, to);
    this.#layout = {...layout, endsAt: layout.endsAt - from, rawsAt: layout.rawsAt - from, startRawsAt: layout.startRawsAt - from,
      rowsAt: layout.rowsAt - from, from: 0, to: to - from};
    this.#rowStarts = null; this.#scanned = 0; this.#next = this.#layout.rowsAt + 1;
    unbuilt.delete(this);
  }
}

/** What `EngineGroup` builds of a group on first read, and what a small packet builds at once: `{slot, obj, fig, root}` with its
 * joints, segments, faces and solved values, as one object (the group built at once is it). */
function buildGroup({slot, obj, fig, root}, w, flags, layout, version) {
  const {startRawsAt, startRawsLength} = layout;
  const joints = jointsOf(w, layout, fig, root);
  let at = layout.rowsAt;
  const rows = w[at++];
  const segments = new Array(rows);
  for (let n = 0; n < rows; n++) {
    const index = w[at], rowFlags = w[at + 11], seg = fig.segments[index];
    const angle = real(w[at + 1]), bend = fin(w[at + 2]), rowLength = real(w[at + 3]), thickness = fin(w[at + 4]), z = fin(w[at + 5]);
    const rgb = [w[at + 6], w[at + 7], w[at + 8]], alpha = fin(w[at + 9]), opacity = fin(w[at + 10]);
    at += 12;
    // A segment starts where its parent ends, unless it says otherwise.
    let segStart;
    if (rowFlags & START) { segStart = {x: fin(w[at]), y: fin(w[at + 1])}; at += 2; } else segStart = joints.get(Number(seg.parent_id)) ?? root;
    // A 3D bone's start before perspective: its own, unless it is its parent's joint as it stands.
    const startRaw = rawAt(w, startRawsAt, startRawsLength, index);
    if (startRaw) {
      if (rowFlags & START) segStart.rawPoint = startRaw;
      else if (segStart.rawPoint?.some((value, axis) => value !== startRaw[axis]) ?? true) segStart = {x: segStart.x, y: segStart.y, rawPoint: startRaw};
    }
    const joint = joints.get(Number(seg.segment_id));
    let end;
    if (rowFlags & END) { end = {x: fin(w[at]), y: fin(w[at + 1])}; at += 2; } else end = joint;
    let points;
    if (rowFlags & POINTS) {
      const count = w[at++];
      points = pointList(w, at, count);
      at += count;
      points[points.length - 1] = end;
    } else points = [segStart, end];
    const result = {
      type: seg.segment_type === 'circle' || seg.segment_type === 'image' || seg.segment_type === 'text' ? seg.segment_type : 'line',
      seg, obj, fig, asset: assetOf(fig, seg, obj), version, slot, index, start: segStart, end, points,
      angle, bend: bend ?? 0, length: rowLength, z: Number(z ?? seg.z_order ?? index + 1),
      thickness: thickness ?? 0, rgb, alpha: alpha ?? 1, opacity: opacity ?? 1, static: isStatic(seg),
    };
    if (rowFlags & CONNECTOR) { result.handle = joint; result.connector = true; }
    if (rowFlags & SPATIAL) { result.spatialFrame = spatialFrame(w, at); at += SPATIAL_WORDS; }
    segments[n] = result;
  }
  const count = w[at++];
  const polys = new Array(count);
  for (let n = 0; n < count; n++) {
    const index = w[at], points = w[at + 1];
    const shape = {index, points: pointList(w, at + 2, points)};
    at += 2 + points;
    const poly = {type: 'poly', poly: fig.polyfills[index], obj, fig, slot, index, points: shape.points,
      z: fin(w[at]), rgb: [w[at + 1], w[at + 2], w[at + 3]], alpha: fin(w[at + 4]), opacity: fin(w[at + 5])};
    const polyFlags = w[at + 6];
    at += 7;
    // A one-sided face says whether it looks away (`culled: false` when it does not), as the editor's own geometry does.
    if (polyFlags & CULLED_POLY) poly.culled = true;
    else if (poly.poly?._stykSurface) poly.culled = false;
    if (polyFlags & DEPTH_POLY) { const depths = w[at++]; poly.depthValues = numbers(w, at, depths); at += depths; }
    polys[n] = poly;
  }
  const built = {slot, obj, fig, root, joints, segments, polys};
  if (flags & SOLVED) {
    const angles = w[at++];
    built.solvedAngles = numbers(w, at, angles);
    at += angles;
    if (flags & SOLVED_LENGTHS) { const lengths = w[at++]; built.solvedLengths = numbers(w, at, lengths); at += lengths; }
  }
  return built;
}

/**
 * @param {{ask(kind: string, args: object): (string|null), packet(kind: string, args: object): (Float64Array|null), source(motion: boolean): (object|null), report(): object}} owner
 *   `ask` reads the session (flushing the editor's pending edits first) and answers JSON text, `null` where the
 *   engine does not hold the document (no session runs it); `packet` is the same for the geometry, which comes as words
 *   (styk_eval::geometry::interface) and is read where it lies; `source` gives the stage what it draws from.
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
  /** A geometry packet: the header, then the groups of the slots the session sent, each made into the group the interface reads. `null` for an empty packet. */
  const groupsOf = (words, frame, report, defs) => {
    if (!words || words.length === 0) return null;
    const warnings = [];
    let at = 5;
    for (let n = 0; n < words[4]; n++) {
      const length = words[at++];
      warnings.push(String.fromCharCode(...words.subarray(at, at + length)));
      at += length;
    }
    // A packet of a few segments is built at once: with every joint shown, every group is read.
    let segments = 0;
    for (let n = 0, scan = at; n < words[3] && segments <= shownLimits.eagerSegments; n++) {
      if (words[scan + 1] > 0) segments += rowsOf(words, scan + 2);
      scan += 2 + words[scan + 1];
    }
    const eager = segments <= shownLimits.eagerSegments, slots = [];
    for (let n = 0; n < words[3]; n++) {
      const slot = words[at], length = words[at + 1];
      slots.push([slot, length === 0 ? null : hydrate(words, at + 2, length, slot, frame, report, defs, eager)]);
      at += 2 + length;
    }
    return {token: words[0], full: words[1] === 1, count: words[2], slots, warnings};
  };
  /** A read of the geometry, which the interface cannot go without unless it is of the motion display. */
  const packet = (kind, args, motion) => {
    const words = owner.packet(kind, args);
    if (words === null && !motion) throw Object.assign(new Error('The engine does not hold this document.'), {name: 'EngineUnavailable'});
    return words;
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
      const report = owner.report(), defs = definitions(report);
      const words = packet('geometry', {since: previous?.read ?? null, motion}, motion);
      const answer = groupsOf(words, frame, report, defs);
      if (!answer) return null;
      const groups = answer.full || !previous ? new Map() : new Map(previous.geometry.objects);
      const changed = new Set();
      for (const [slot, group] of answer.slots) { groups.set(slot, group); changed.add(slot); }
      for (const slot of [...groups.keys()]) if (slot >= answer.count) groups.delete(slot);
      boundPackets(groups.values(), words);
      const order = frame.object_draw_order ?? Array.from({length: answer.count}, (_, slot) => slot);
      const orderedObjects = [];
      for (const slot of order) { const group = groups.get(Number(slot)); if (group?.drawn) orderedObjects.push(group); }
      if (previous && !answer.full && !changed.size && previous.geometry.orderedObjects.length === orderedObjects.length
          && orderedObjects.every((group, index) => group === previous.geometry.orderedObjects[index])) {
        held[+motion] = {read: answer.token, geometry: previous.geometry};
        return previous.geometry;
      }
      const geometry = geometryRecord({objects: groups, orderedObjects, token: {}, previousToken: previous?.geometry.token,
        changedSlots: answer.full || !previous ? null : changed, warnings: answer.warnings});
      held[+motion] = {read: answer.token, geometry};
      return geometry;
    },
    /**
     * The geometry of `frame` as a drawing's first stroke previews it: the frame on show with the new cel's figure (`figure`, on layer
     * `layerId`) and its object added, which the document does not hold yet. Read once, whole; `null` where the engine does not answer.
     */
    previewGeometry(frame, figure, layerId, uid) {
      const words = owner.packet('previewGeometry', {frame, figure, uid, layerId});
      const report = owner.report(), held = definitions(report), added = Number(figure.figure_type_id);
      const defs = {get: id => id === added ? figure : held.get(id)};
      const answer = groupsOf(words, frame, report, defs);
      if (!answer) return null;
      const objects = new Map();
      for (const [slot, group] of answer.slots) objects.set(slot, group);
      const order = frame.object_draw_order ?? Array.from({length: answer.count}, (_, slot) => slot);
      const orderedObjects = [];
      for (const slot of order) { const group = objects.get(Number(slot)); if (group?.drawn) orderedObjects.push(group); }
      return geometryRecord({objects, orderedObjects, token: {}, previousToken: undefined, changedSlots: null, warnings: answer.warnings});
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
