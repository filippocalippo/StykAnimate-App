/** Pivot 5.2 handle rules, verified against the supplied native executable.
 * See artifacts/native-static/{joined-handle-routing,handle-size}.md.
 * Joined origins do not exist as handles: the parent's endpoint owns the joint.
 */
import {rigControlIsDetail} from './rig-control-details.mjs';
import {isStatic} from './pivot/read-view.mjs';
export const PIVOT_HANDLE_COLORS = Object.freeze({
  segment: '#ff0000', origin: '#ff8800', unselected: '#0000ff', unselectedOrigin: '#0080ff',
  joined: '#ffffff', unselectedJoined: '#d3d3d3', static: '#808080', selectedStatic: '#b04040',
  activeSegment: '#ff6666', activeJoined: '#ffd6d6', activeStatic: '#cc4444',
});

let figureMetadata = new WeakMap(), topologyMetadata = new WeakMap(), topologyEpoch = 0;
const attachmentMetadata = new WeakMap();
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const segmentId = segment => Number(segment.seg?.segment_id ?? segment.id ?? segment.index + 1);

/** Clear on definition/topology changes and history/load, never ordinary pose,
 * view or selection changes. Definitions can be edited in place by the builder.
 */
export function invalidatePivotHandleTopology(figure) {
  topologyEpoch++;
  if(figure)topologyMetadata.delete(figure);else topologyMetadata=new WeakMap();
  figureMetadata=new WeakMap();
}

// A group read from the engine counts its segments without building them (`segmentCount`, engine-shown.mjs).
const segmentCount = g => g.segmentCount ?? g.segments.length;
function topologyInfo(g) {
  const key=g.fig||g,definition=g.fig?.segments;
  let info=topologyMetadata.get(key);
  if(info&&info.definition===definition&&info.count===segmentCount(g))return info;
  if(g.segmentLength)return lazyTopologyInfo(g,key,definition);
  const incoming=new Map(),outgoing=new Map(),allOrdered=[];
  let previous=-Infinity,ordered=true;
  for(const shape of g.segments){
    const id=segmentId(shape),parent=Number(shape.seg?.parent_id??0),index=shape.index;
    incoming.set(id,index);let children=outgoing.get(parent);
    if(!children)outgoing.set(parent,children=[]);children.push(index);allOrdered.push(index);
    const z=Number(shape.z??shape.seg?.z_order??index+1);if(z<previous)ordered=false;previous=z;
  }
  if(!ordered)allOrdered.sort((a,b)=>Number(g.segments[a].z??g.segments[a].seg?.z_order??a+1)-Number(g.segments[b].z??g.segments[b].seg?.z_order??b+1));
  info={definition,count:g.segments.length,incoming,outgoing,allOrdered,
    dynamicOrdered:allOrdered.filter(index=>!g.segments[index].static)};
  topologyMetadata.set(key,info);return info;
}

/** `topologyInfo` of a group read from the engine, from its definition and its rows' posed order, without building its
 * segments (`segmentIndex`, `segmentZ`, engine-shown.mjs). */
function lazyTopologyInfo(g,key,definition){
  const incoming=new Map(),outgoing=new Map(),allOrdered=[],zs=new Map(),count=g.segmentCount;
  let previous=-Infinity,ordered=true;
  for(let n=0;n<count;n++){
    const index=g.segmentIndex(n),seg=g.fig.segments[index],id=Number(seg?.segment_id??index+1),parent=Number(seg?.parent_id??0);
    incoming.set(id,index);let children=outgoing.get(parent);
    if(!children)outgoing.set(parent,children=[]);children.push(index);allOrdered.push(index);
    const z=g.segmentZ(n);zs.set(index,z);if(z<previous)ordered=false;previous=z;
  }
  if(!ordered)allOrdered.sort((a,b)=>zs.get(a)-zs.get(b));
  const info={definition,count,incoming,outgoing,allOrdered,dynamicOrdered:allOrdered.filter(index=>!isStatic(g.fig.segments[index]))};
  topologyMetadata.set(key,info);return info;
}

// Topology is shared by every pose of a definition. Per-pose minima are lazy:
// a 15,000-segment scene with 1,000 exposed handles resolves only those vertices.
function figureInfo(g) {
  let info = figureMetadata.get(g);
  if (info) return info;
  info={topology:topologyInfo(g),incident:new Map(),scale:Math.abs(Number(g.obj.scale??1))};
  figureMetadata.set(g, info);return info;
}
function incidentMinimum(g,id,info){
  let entry=info.incident.get(id);if(entry)return entry;
  if(g.segmentLengths){entry=lazyIncidentMinimum(g,id,info);info.incident.set(id,entry);return entry;}
  entry={length:Infinity,thickness:Infinity};
  const candidate = index => {
    const definition = g.segments[index].seg || {}, posedLength = g.segments[index].length;
    const length = Number.isFinite(posedLength) && info.scale > 0 ? Math.abs(posedLength) / info.scale
      : Number(g.obj.len_flag ? g.obj.lengths?.[index] ?? definition.length ?? 0
        : g.obj.runtime_segments?.[index]?.length ?? definition.length ?? 0);
    entry.length = Math.min(entry.length, length);
    entry.thickness = Math.min(entry.thickness, Number(definition.thickness ?? 0));
  };
  const topology=info.topology,index=topology.incoming.get(id);
  if(index!==undefined){
    const segment=g.segments[index],parentIndex=topology.incoming.get(Number(segment.seg?.parent_id??0));
    if(parentIndex===undefined||!g.segments[parentIndex].static)candidate(index);
  }
  for(const child of topology.outgoing.get(id)||[]){candidate(child);if(entry.length===0&&entry.thickness===0)break;}
  info.incident.set(id,entry);return entry;
}
/** `incidentMinimum` of a group read from the engine, from its posed lengths alone (`segmentLengths`, engine-shown.mjs): the
 * same candidates in the same order, the definition's part of them kept per definition. An origin can have a hundred. */
function lazyIncidentMinimum(g,id,info){
  const topology=info.topology,segments=g.fig.segments;
  let shape=(topology.incidentShapes??=new Map()).get(id);
  if(!shape){
    const indices=[],index=topology.incoming.get(id);
    if(index!==undefined){
      const parentIndex=topology.incoming.get(Number(segments[index]?.parent_id??0));
      if(parentIndex===undefined||!isStatic(segments[parentIndex]))indices.push(index);
    }
    // 'children': where the children start (the original stops early only after one of them).
    shape={indices,children:indices.length,thickness:null};
    indices.push(...(topology.outgoing.get(id)||[]));
    shape.thickness=indices.map(i=>Number((segments[i]||{}).thickness??0));
    topology.incidentShapes.set(id,shape);
  }
  const lengths=g.segmentLengths(),scale=info.scale,{indices,thickness,children}=shape;
  let length=Infinity,thin=Infinity;
  for(let k=0;k<indices.length;k++){
    const index=indices[k],posed=lengths[index];
    let value;
    if(Number.isFinite(posed)&&scale>0)value=Math.abs(posed)/scale;
    else{const definition=segments[index]||{};value=Number(g.obj.len_flag?g.obj.lengths?.[index]??definition.length??0:g.obj.runtime_segments?.[index]?.length??definition.length??0);}
    length=Math.min(length,value);thin=Math.min(thin,thickness[k]);
    if(length===0&&thin===0&&k>=children)break;
  }
  return {length,thickness:thin};
}

function attachments(geometry) {
  let targets = attachmentMetadata.get(geometry);
  if (targets) return targets;
  targets = new Map();
  for (const g of geometry.objects.values()) {
    const join = g?.obj.join;
    if (!join) continue;
    const slot = Number(join.target_object_slot);
    let vertices = targets.get(slot);
    if (!vertices) targets.set(slot, vertices = new Set());
    vertices.add(Number(join.target_handle_id ?? 0));
  }
  attachmentMetadata.set(geometry, targets);
  return targets;
}

/** Screen radius in CSS canvas units, before devicePixelRatio. Both native
 * clamps are intentional: clamping only once changes zoomed node sizing.
 */
export function getPivotHandleRadius(g, id, {
  viewScale = 1, autoSize = true, minDiameter = 4, maxDiameter = 10,
} = {}) {
  return scaledHandleRadius(baseHandleRadius(g, id, {autoSize, minDiameter, maxDiameter}), viewScale, minDiameter, maxDiameter);
}
/** The first clamp of `getPivotHandleRadius`, which the view's scale does not change. */
function baseHandleRadius(g, id, {autoSize, minDiameter, maxDiameter}) {
  const info = figureInfo(g), entry = incidentMinimum(g,Number(id),info);
  const length = entry?.length ?? Infinity, thickness = entry?.thickness ?? Infinity;
  const diameter = (autoSize ? .7 * length : Math.max(.7 * length, 1.4 * thickness)) * info.scale;
  return .5 * clamp(Number.isNaN(diameter) ? maxDiameter : diameter, minDiameter, maxDiameter);
}
const scaledHandleRadius = (baseRadius, viewScale, minDiameter, maxDiameter) =>
  clamp(baseRadius * Math.abs(viewScale), minDiameter / 2, maxDiameter / 2);
/** The screen radius every handle has at `viewScale` whatever its own size, or `undefined`: the first clamp keeps a size
 * between the two diameters, so when the view's scale takes that whole range past one end of the second clamp, the size of
 * the segments around a joint cannot change its radius and need not be read (a dense frame seen whole). */
function pinnedHandleRadius(viewScale, minDiameter, maxDiameter) {
  if (!(minDiameter <= maxDiameter)) return undefined;
  const scale = Math.abs(viewScale);
  if (maxDiameter / 2 * scale <= minDiameter / 2) return scaledHandleRadius(maxDiameter / 2, viewScale, minDiameter, maxDiameter);
  if (minDiameter / 2 * scale >= maxDiameter / 2) return scaledHandleRadius(minDiameter / 2, viewScale, minDiameter, maxDiameter);
  return undefined;
}

/** `handles` (from `getPivotHandles`) as `getPivotHandles` gives them at another view scale, all else the same: only the
 * sizes change, so a zoom resizes the descriptors in one pass instead of building them again. New arrays and descriptors;
 * `baseRadius` (the size before the view's scale, see `pinnedHandleRadius`) is worked out where it was not and now matters. */
export function rescalePivotHandles(handles, {viewScale = 1, autoSize = true, minDiameter = 4, maxDiameter = 10} = {}) {
  const scale = Math.max(1e-9, Math.abs(viewScale)), result = new Array(handles.length), pinned = pinnedHandleRadius(viewScale, minDiameter, maxDiameter);
  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i];
    let baseRadius = handle.baseRadius, screenRadius;
    if (handle.connector) screenRadius = maxDiameter / 2;
    else if (pinned !== undefined) screenRadius = pinned;
    else screenRadius = scaledHandleRadius(baseRadius ??= baseHandleRadius(handle.g, handle.id, {autoSize, minDiameter, maxDiameter}), viewScale, minDiameter, maxDiameter);
    result[i] = {...handle, radius: screenRadius / scale, screenRadius, baseRadius};
  }
  const groups = (handles.groups ?? []).map(group => ({uid: group.uid, offset: group.offset, handles: result.slice(group.offset, group.offset + group.handles.length)}));
  Object.defineProperty(result, 'groups', {value: groups});
  return result;
}

export function pivotHandleColor({ selected = false, nodeSelected = false, origin = false, joined = false, static: isStatic = false } = {}) {
  if (selected && nodeSelected && !origin) return joined ? PIVOT_HANDLE_COLORS.activeJoined
    : isStatic ? PIVOT_HANDLE_COLORS.activeStatic : PIVOT_HANDLE_COLORS.activeSegment;
  if (joined) return selected ? PIVOT_HANDLE_COLORS.joined : PIVOT_HANDLE_COLORS.unselectedJoined;
  if (isStatic) return selected ? PIVOT_HANDLE_COLORS.selectedStatic : PIVOT_HANDLE_COLORS.static;
  if (!selected) return origin ? PIVOT_HANDLE_COLORS.unselectedOrigin : PIVOT_HANDLE_COLORS.unselected;
  return origin ? PIVOT_HANDLE_COLORS.origin : PIVOT_HANDLE_COLORS.segment;
}

/** Joints in a frame on show above which figures that are not selected show their origin only (docs/SCENE-EDITING.md,
 * "Joints in dense frames"): at about half a microsecond a joint to paint and a fifth to describe, a frame of this many
 * redraws in under ten milliseconds when the view zooms. Above it the canvas's own cost per joint climbs steeply. */
export const DENSE_HANDLE_BUDGET = 12000;
/** Once in force the rule holds until the frame has fewer joints than this share of the budget, so a scene near the
 * budget does not switch it on and off from one frame to the next. */
export const DENSE_HANDLE_RELEASE = .75;
const definitionHandleCounts = new WeakMap();
/** The joints a figure of `figure`'s definition shows with all of them shown: its moving joints, from the definition alone. */
export function definitionHandleCount(figure) {
  const segments = figure?.segments;
  if (!segments) return 0;
  let count = definitionHandleCounts.get(segments);
  if (count === undefined) {
    count = 0;
    for (const segment of segments) if (!isStatic(segment)) count++;
    definitionHandleCounts.set(segments, count);
  }
  return count;
}
/** The joints `frame` would show with every figure's shown (`figureOf(object)` gives an object's definition): a free
 * origin each and the moving joints of its definition, for the figures neither hidden nor locked. No geometry is read. */
export function frameHandleCount(frame, figureOf, {hiddenUids, lockedUids} = {}) {
  let count = 0;
  for (const object of frame?.objects ?? []) {
    if (!object || hiddenUids?.has(object.unique_id) || lockedUids?.has(object.unique_id)) continue;
    count += (object.join ? 0 : 1) + definitionHandleCount(figureOf(object));
  }
  return count;
}
/** Whether a frame of `count` joints is dense, given whether the frame shown before was. */
export function denseHandles(count, wasDense = false, budget = DENSE_HANDLE_BUDGET) {
  return count > (wasDense ? budget * DENSE_HANDLE_RELEASE : budget);
}

/** Native painter-order descriptors, shared by drawing and pointer picking.
 * Pass frame for exact ordering even when a figure has no visible artwork.
 * Origins precede their own segments: reverse iteration implements the native
 * priority of reverse figures, reverse segment order, then each free origin.
 */
export function getPivotHandles(geometry, {
  frame, selectedUid = null, selectedUids, selectedJoint = -1, selectedHandleIds, selectedBranch = false, builder = false, hiddenUids, lockedUids,
  showUnselected = true, showStatic = false, attaching = false, allowStaticManipulation = false,
  selectStatic = false, joinTargetUids, spatialMode = 'pose', showDetailed = false,
  viewScale = 1, autoSize = true, minDiameter = 4, maxDiameter = 10, descriptorCache,
} = {}) {
  if (!geometry?.objects) return [];
  const order = frame?.object_draw_order
    ? frame.object_draw_order.map(slot => geometry.objects.get(Number(slot)))
    : geometry.orderedObjects || [...geometry.objects.values()].sort((a, b) => (a?.slot ?? 0) - (b?.slot ?? 0));
  // Empty artwork is absent from geometry.orderedObjects but retains handles.
  // A frame argument places these at their authoritative native draw position.
  const objects = order.slice(), seen = new Set(order);
  for (const g of geometry.objects.values()) if (g && !seen.has(g)) objects.push(g);
  const targets = attachments(geometry), result = [], groups = [];
  Object.defineProperty(result,'groups',{value:groups});
  const options = { viewScale, autoSize, minDiameter, maxDiameter }, scale = Math.max(1e-9, Math.abs(viewScale));
  const pinned = pinnedHandleRadius(viewScale, minDiameter, maxDiameter);
  const settingsKey = [topologyEpoch,spatialMode,showUnselected,showStatic,showDetailed,attaching,allowStaticManipulation,selectStatic,viewScale,autoSize,minDiameter,maxDiameter,builder,selectedJoint,selectedBranch,[...(selectedHandleIds??[])].join(',')].join('|');
  if(descriptorCache && descriptorCache.key!==settingsKey){descriptorCache.key=settingsKey;descriptorCache.objects=new WeakMap();}
  for (const g of objects) {
    if (!g) continue;
    const uid = g.obj.unique_id;
    if (hiddenUids?.has(uid) || lockedUids?.has(uid)) continue;
    if (attaching && joinTargetUids && !joinTargetUids.has(uid)) continue;
    const selected = uid === selectedUid || Boolean(selectedUids?.has(uid));
    const allEndpoints = selected || showUnselected || Boolean(g.obj.join) || attaching;
    const joinedVertices = targets.get(g.slot ?? g.obj.object_slot);
    const objectKey = joinedVertices ? `${selected}|${uid===selectedUid}|${[...joinedVertices].join(',')}` : selected ? uid === selectedUid ? 'true|true|' : 'true|false|' : 'false|false|';
    const cached=descriptorCache?.objects.get(g);
    if(cached?.key===objectKey){groups.push({uid,offset:result.length,handles:cached.handles});for(const handle of cached.handles)result.push(handle);continue;}
    const first=result.length;
    // A figure showing its origin only reads none of its segments (in a dense frame, most of them): its descriptor is the one
    // `add` below makes for an origin of a figure not selected, made without the closure and, at a pinned size, the topology.
    if (!allEndpoints && !joinedVertices?.size && !selectStatic) {
      const ownHandles = [];
      if (!g.obj.join) {
        const baseRadius = pinned !== undefined ? undefined : baseHandleRadius(g, 0, options), screenRadius = pinned ?? scaledHandleRadius(baseRadius, viewScale, minDiameter, maxDiameter);
        const ik = !builder && Boolean(g.obj._stykIK?.[0]?.enabled);
        ownHandles.push({ g, uid, joint: -1, id: 0, kind: 'origin', point: g.root, selected, joined: false, static: false, ik, connector: false, action: 'move',
          color: pivotHandleColor({ selected, nodeSelected: false, origin: true, joined: false, static: false }),
          radius: screenRadius / scale, screenRadius, baseRadius });
        result.push(ownHandles[0]);
      }
      groups.push({uid, offset: first, handles: ownHandles});
      descriptorCache?.objects.set(g, {key: objectKey, handles: ownHandles});
      continue;
    }
    const rotateSpatial = !builder && selected && (spatialMode === 'rotate' || spatialMode === 'figure');
    const add = (point, joint, id, kind, isStatic = false, joined = false) => {
      const spatial = rotateSpatial && Boolean(g.segments[joint]?.spatialFrame);
      if(spatial)point=g.segments[joint].start;
      const connector=joint>=0&&Boolean(g.segments[joint]?.connector);
      // A slider's stored length is a fraction, not a physical segment length.
      const baseRadius = connector || pinned !== undefined ? undefined : baseHandleRadius(g, id, options);
      const screenRadius = connector ? (options.maxDiameter??10)/2 : pinned ?? scaledHandleRadius(baseRadius, viewScale, minDiameter, maxDiameter);
      const ik = !builder && Boolean(g.obj._stykIK?.[id]?.enabled);
      result.push({ g, uid, joint, id, kind, point, selected, joined, static: isStatic, ik,
        connector,
        action: spatial ? 'select' : kind === 'origin' ? 'move' : isStatic && !ik && !attaching && !allowStaticManipulation ? 'select' : 'pose',
        // Join targets: dynamic nodes keep their pose colours, static nodes are white.
        color: attaching ? isStatic ? PIVOT_HANDLE_COLORS.joined : kind === 'origin' ? PIVOT_HANDLE_COLORS.origin : PIVOT_HANDLE_COLORS.segment : builder && isStatic && !joined && !builderSelection?.has(joint) ? '#999999'
          : pivotHandleColor({ selected, nodeSelected: Boolean(builderSelection?.has(joint)), origin: kind === 'origin', joined, static: isStatic }),
        radius: screenRadius / scale, screenRadius, baseRadius });
    };
    const topology=figureInfo(g).topology;
    const selectedStatic = uid===selectedUid && selectedJoint>=0 && Boolean(g.segments[selectedJoint]);
    const builderSelection=selectedStatic?new Set(selectedHandleIds?.size ? g.segments.flatMap((segment,index)=>selectedHandleIds.has(segmentId(segment))?[index]:[]) : [selectedJoint]):null;
    if(selectedStatic&&selectedBranch){
      const queue=[selectedJoint];
      for(let i=0;i<queue.length;i++)for(const child of topology.outgoing.get(segmentId(g.segments[queue[i]]))||[])
        if(!builderSelection.has(child)){builderSelection.add(child);queue.push(child);}
    }
    if (!g.obj.join) add(g.root, -1, 0, 'origin');
    for (const index of showStatic||selectStatic||attaching||selectedStatic||g.obj._stykIK?topology.allOrdered:topology.dynamicOrdered) {
      const segment=g.segments[index];
      if(segment.static&&!showStatic&&!selectStatic&&!attaching&&!builderSelection?.has(index)&&!g.obj._stykIK?.[segmentId(segment)]?.enabled)continue;
      const id = segmentId(segment), joined = Boolean(joinedVertices?.has(id));
      if (rigControlIsDetail(segment.seg) && !showDetailed && !builder && !attaching &&
          !joined && !(uid === selectedUid && index === selectedJoint)) continue;
      if (allEndpoints || joined || (selectStatic && segment.static)) add(segment.handle ?? segment.end, segment.index, id, 'segment', Boolean(segment.static), joined);
    }
    const ownHandles=result.slice(first);groups.push({uid,offset:first,handles:ownHandles});
    descriptorCache?.objects.set(g,{key:objectKey,handles:ownHandles});
  }
  return result;
}

const handleSpatialIndices=new WeakMap();
function nearbyHandles(handles,point,options){
  // The caller supplies the scale only for a uniform affine projection. Other
  // projections retain the exact general scan. Published handle arrays are immutable.
  if(!options.handles||!options.project&&!options.spatial)return null;
  const scale=options.project?Math.abs(options.projectionScale):1;
  if(handles.length<512||!Number.isFinite(scale)||scale<=0)return null;
  let index=handleSpatialIndices.get(handles);
  if(!index){
    const cells=new Map();let screenRadius=0,worldRadius=0;
    handles.forEach((handle,i)=>{
      const key=`${Math.floor(handle.point.x/32)},${Math.floor(handle.point.y/32)}`;
      let cell=cells.get(key);if(!cell)cells.set(key,cell=[]);cell.push(i);
      screenRadius=Math.max(screenRadius,handle.screenRadius??0);worldRadius=Math.max(worldRadius,handle.radius??0);
    });
    handleSpatialIndices.set(handles,index={cells,screenRadius,worldRadius});
  }
  const radius=Math.max(options.minRadius??0,options.radius??(options.project?index.screenRadius:index.worldRadius))/scale*(options.nearest?1:Math.SQRT2);
  if(!Number.isFinite(radius))return null;
  const x0=Math.floor((point.x-radius)/32),x1=Math.floor((point.x+radius)/32),y0=Math.floor((point.y-radius)/32),y1=Math.floor((point.y+radius)/32);
  if((x1-x0+1)*(y1-y0+1)>256)return null;
  const candidates=[];
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)for(const i of index.cells.get(`${x},${y}`)??[])candidates.push(i);
  return candidates.sort((a,b)=>b-a);
}

/** Native hit order, or nearest hit when requested. An optional preferred UID
 * resolves overlapping handles for explicit figure transforms.
 * point and optional radius override use world coordinates. Reuse descriptors
 * via options.handles for allocation-free scanning of an unchanged scene.
 */
export function pickCanvasHandle(geometry, point, options = {}) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const handles = options.handles || getPivotHandles(geometry, options);
  const projectedPoint = options.project ? options.project(point) : point;
  const candidates=nearbyHandles(handles,point,options);
  let best = null;
  for (let position=0;position<(candidates?.length??handles.length);position++) {
    const index=candidates?candidates[position]:handles.length-1-position;
    const handle = handles[index], center = options.project ? options.project(handle.point) : handle.point;
    const radius = Math.max(options.minRadius ?? 0, options.radius ?? (options.project ? handle.screenRadius : handle.radius));
    const dx = projectedPoint.x - center.x, dy = projectedPoint.y - center.y;
    const distanceSquared = dx * dx + dy * dy;
    const inside = options.nearest ? distanceSquared < radius * radius : Math.abs(dx) < radius && Math.abs(dy) < radius;
    if (inside) {
      const hit = { ...handle, distanceSquared };
      if (!options.nearest && options.preferredUid === undefined) return hit;
      const preferred = options.preferredUid !== undefined && handle.uid === options.preferredUid;
      const bestPreferred = options.preferredUid !== undefined && best?.uid === options.preferredUid;
      if (!best || (preferred && !bestPreferred) || (preferred === bestPreferred && options.nearest && distanceSquared < best.distanceSquared)) best = hit;
    }
  }
  return best;
}

/** Click-only expansion of movable line targets. Reuse evaluated curves and
 * handle permissions; the endpoint remains the pose target even at mid-segment.
 * A painted body can restrict the search to its owner to avoid picking through it.
 */
export function pickCanvasSegment(geometry, point, {handles = getPivotHandles(geometry), uid, scale = 1, padding = 8} = {}) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const pad = padding / Math.max(.01, Math.abs(scale));
  for (let i = handles.length - 1; i >= 0; i--) {
    const handle = handles[i];
    if (uid !== undefined && handle.uid !== uid || handle.action !== 'pose') continue;
    const shape = handle.g.segments[handle.joint];
    if (!shape || shape.type !== 'line' || shape.seg.visible === false ||
        !(shape.thickness > 0) || !(shape.alpha > 0) || !(shape.opacity > 0)) continue;
    const points = shape.points, radius = shape.thickness / 2 + pad;
    for (let j = 1; j < points.length; j++) {
      const a = points[j - 1], b = points[j], dx = b.x - a.x, dy = b.y - a.y;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1) : 0;
      const distanceSquared = (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2;
      if (distanceSquared <= radius * radius) return {...handle, kind: 'segment-body', distanceSquared};
    }
  }
  return null;
}

/** Canvas-space selection; origin mode never traverses artwork or its bounds.
 * Use evaluated roots so attachments and projected figures select where shown.
 */
export function figureIntersectsMarquee(figure, rect, {mode = 'bounds', project, boundsOf}) {
  if (mode === 'origins') {
    const point = project(figure.root);
    return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  }
  const box = boundsOf(figure);
  const a = project({x: box.minX, y: box.minY}), b = project({x: box.maxX, y: box.minY});
  const c = project({x: box.maxX, y: box.maxY}), d = project({x: box.minX, y: box.maxY});
  return Math.max(a.x, b.x, c.x, d.x) >= rect.left && Math.min(a.x, b.x, c.x, d.x) <= rect.right &&
    Math.max(a.y, b.y, c.y, d.y) >= rect.top && Math.min(a.y, b.y, c.y, d.y) <= rect.bottom;
}
