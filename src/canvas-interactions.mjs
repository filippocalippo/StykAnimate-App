/** Pivot 5.2 handle rules, verified against the supplied native executable.
 * See artifacts/native-static/{joined-handle-routing,handle-size}.md.
 * Joined origins do not exist as handles: the parent's endpoint owns the joint.
 */
export const PIVOT_HANDLE_COLORS = Object.freeze({
  segment: '#ff0000', origin: '#ff8800', unselected: '#0000ff', unselectedOrigin: '#0080ff',
  joined: '#ffffff', unselectedJoined: '#d3d3d3', static: '#808080', selectedStatic: '#b04040',
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

function topologyInfo(g) {
  const key=g.fig||g,definition=g.fig?.segments;
  let info=topologyMetadata.get(key);
  if(info&&info.definition===definition&&info.count===g.segments.length)return info;
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
  entry={length:Infinity,thickness:Infinity};
  const candidate = segment => {
    const index = segment.index, definition = segment.seg || {}, posedLength = segment.length;
    const length = Number.isFinite(posedLength) && info.scale > 0 ? Math.abs(posedLength) / info.scale
      : Number(g.obj.len_flag ? g.obj.lengths?.[index] ?? definition.length ?? 0
        : g.obj.runtime_segments?.[index]?.length ?? definition.length ?? 0);
    entry.length = Math.min(entry.length, length);
    entry.thickness = Math.min(entry.thickness, Number(definition.thickness ?? 0));
  };
  const topology=info.topology,index=topology.incoming.get(id);
  if(index!==undefined){
    const segment=g.segments[index],parentIndex=topology.incoming.get(Number(segment.seg?.parent_id??0));
    if(parentIndex===undefined||!g.segments[parentIndex].static)candidate(segment);
  }
  for(const child of topology.outgoing.get(id)||[])candidate(g.segments[child]);
  info.incident.set(id,entry);return entry;
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
  const info = figureInfo(g), entry = incidentMinimum(g,Number(id),info);
  const length = entry?.length ?? Infinity, thickness = entry?.thickness ?? Infinity;
  const diameter = (autoSize ? .7 * length : Math.max(.7 * length, 1.4 * thickness)) * info.scale;
  const baseRadius = .5 * clamp(Number.isNaN(diameter) ? maxDiameter : diameter, minDiameter, maxDiameter);
  return clamp(baseRadius * Math.abs(viewScale), minDiameter / 2, maxDiameter / 2);
}

export function pivotHandleColor({ selected = false, origin = false, joined = false, static: isStatic = false } = {}) {
  if (joined) return selected ? PIVOT_HANDLE_COLORS.joined : PIVOT_HANDLE_COLORS.unselectedJoined;
  if (isStatic) return selected ? PIVOT_HANDLE_COLORS.selectedStatic : PIVOT_HANDLE_COLORS.static;
  if (!selected) return origin ? PIVOT_HANDLE_COLORS.unselectedOrigin : PIVOT_HANDLE_COLORS.unselected;
  return origin ? PIVOT_HANDLE_COLORS.origin : PIVOT_HANDLE_COLORS.segment;
}

/** Native painter-order descriptors, shared by drawing and pointer picking.
 * Pass frame for exact ordering even when a figure has no visible artwork.
 * Origins precede their own segments: reverse iteration implements the native
 * priority of reverse figures, reverse segment order, then each free origin.
 */
export function getPivotHandles(geometry, {
  frame, selectedUid = null, selectedUids, selectedJoint = -1, selectedBranch = false, builder = false, hiddenUids, lockedUids,
  showUnselected = true, showStatic = false, attaching = false, allowStaticManipulation = false,
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
  const settingsKey = [topologyEpoch,showUnselected,showStatic,attaching,allowStaticManipulation,viewScale,autoSize,minDiameter,maxDiameter,builder,selectedJoint,selectedBranch].join('|');
  if(descriptorCache && descriptorCache.key!==settingsKey){descriptorCache.key=settingsKey;descriptorCache.objects=new WeakMap();}
  for (const g of objects) {
    if (!g) continue;
    const uid = g.obj.unique_id;
    if (hiddenUids?.has(uid) || lockedUids?.has(uid)) continue;
    const selected = uid === selectedUid || Boolean(selectedUids?.has(uid));
    const allEndpoints = selected || showUnselected || Boolean(g.obj.join) || attaching;
    const joinedVertices = targets.get(g.slot ?? g.obj.object_slot);
    const objectKey = `${selected}|${uid===selectedUid}|${[...(joinedVertices||[])].join(',')}`;
    const cached=descriptorCache?.objects.get(g);
    if(cached?.key===objectKey){groups.push({uid,offset:result.length,handles:cached.handles});for(const handle of cached.handles)result.push(handle);continue;}
    const first=result.length;
    const add = (point, joint, id, kind, isStatic = false, joined = false) => {
      const screenRadius = getPivotHandleRadius(g, id, options);
      result.push({ g, uid, joint, id, kind, point, selected, joined, static: isStatic,
        action: kind === 'origin' ? 'move' : isStatic && !attaching && !allowStaticManipulation ? 'select' : 'pose',
        color: builder && isStatic && !joined ? (builderSelection?.has(joint)?'#cc4444':'#999999') : pivotHandleColor({ selected, origin: kind === 'origin', joined, static: isStatic }),
        radius: screenRadius / scale, screenRadius });
    };
    const topology=figureInfo(g).topology;
    const selectedStatic = uid===selectedUid && selectedJoint>=0 && Boolean(g.segments[selectedJoint]);
    const builderSelection=selectedStatic?new Set([selectedJoint]):null;
    if(selectedStatic&&selectedBranch){
      const queue=[selectedJoint];
      for(let i=0;i<queue.length;i++)for(const child of topology.outgoing.get(segmentId(g.segments[queue[i]]))||[])
        if(!builderSelection.has(child)){builderSelection.add(child);queue.push(child);}
    }
    if (!g.obj.join) add(g.root, -1, 0, 'origin');
    for (const index of showStatic||attaching||selectedStatic?topology.allOrdered:topology.dynamicOrdered) {
      const segment=g.segments[index];
      if(segment.static&&!showStatic&&!attaching&&!builderSelection?.has(index))continue;
      const id = segmentId(segment), joined = Boolean(joinedVertices?.has(id));
      if (allEndpoints || joined) add(segment.end, segment.index, id, 'segment', Boolean(segment.static), joined);
    }
    const ownHandles=result.slice(first);groups.push({uid,offset:first,handles:ownHandles});
    descriptorCache?.objects.set(g,{key:objectKey,handles:ownHandles});
  }
  return result;
}

/** First native open-square hit, without a distance or selected-first pass.
 * point and optional radius override use world coordinates. Reuse descriptors
 * via options.handles for allocation-free scanning of an unchanged scene.
 */
export function pickCanvasHandle(geometry, point, options = {}) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const handles = options.handles || getPivotHandles(geometry, options);
  const projectedPoint = options.project ? options.project(point) : point;
  let best = null;
  for (let index = handles.length - 1; index >= 0; index--) {
    const handle = handles[index], center = options.project ? options.project(handle.point) : handle.point;
    const radius = Math.max(options.minRadius ?? 0, options.radius ?? (options.project ? handle.screenRadius : handle.radius));
    const dx = projectedPoint.x - center.x, dy = projectedPoint.y - center.y;
    const distanceSquared = dx * dx + dy * dy;
    const inside = options.nearest ? distanceSquared < radius * radius : Math.abs(dx) < radius && Math.abs(dy) < radius;
    if (inside) {
      const hit = { ...handle, distanceSquared };
      if (!options.nearest) return hit;
      if (!best || distanceSquared < best.distanceSquared) best = hit;
    }
  }
  return best;
}
