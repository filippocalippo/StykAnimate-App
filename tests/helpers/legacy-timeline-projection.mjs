// Legacy document projection fixture; never loaded by the application.
import {keyEasing} from '../../src/keyframe-easing.mjs';
import {connectedTimelineGroups,connectedGroupIndex} from '../../src/connected-timeline.mjs';
import {animationChannelId} from '../../src/animation-channels.mjs';
import {ANIMATION_PROPERTIES,AUTHORING_PROPERTIES,ANIMATION_PROPERTY_NAMES} from '../../src/animation-properties.mjs';
const PROPERTY_NAMES = ANIMATION_PROPERTY_NAMES;
const TRACK_PROPERTIES = {...ANIMATION_PROPERTIES, figure: ANIMATION_PROPERTIES.figure.filter(property => property !== 'pose')};
const targetTrackId = target => target.kind === 'polygon' ? `polygon:${target.uid}:${target.polygonId}@${target.figureTypeId}` : target.kind === 'figure' ? `figure:${target.uid}` : target.kind === 'segment' ? `segment:${target.uid}:${target.handleId}${target.figureTypeId === undefined ? '' : `@${target.figureTypeId}`}` : target.kind === 'layer' ? `layer:${target.layerId ?? target.id}` : target.kind;
const TRACK_ICONS = {
  assembly: '<path d="m6 10 4-4M5 9l-1 1a2.8 2.8 0 0 0 4 4l3-3a2.8 2.8 0 0 0 0-4M11 7l1-1a2.8 2.8 0 0 0-4-4L5 5a2.8 2.8 0 0 0 0 4"/>',
  scene: '<rect x="2" y="2" width="12" height="12" rx="2"/><path d="m3 11 3-4 3 3 2-2 3 4"/>',
  camera: '<rect x="1.5" y="4" width="9" height="8" rx="1.5"/><path d="m10.5 6 4-2v8l-4-2"/>',
  layer: '<path d="m8 2 6 3.5-6 3.5-6-3.5L8 2Zm-6 6L8 11.5 14 8M2 11l6 3.5 6-3.5"/>',
  figure: '<circle cx="8" cy="3" r="1.7"/><path d="M8 5v5m-4-3h8m-4 3-3 4m3-4 3 4"/>',
  segment: '<path d="m4 12 8-8"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="4" r="2"/>',
  channel: '<path d="M2 12c4 0 3-8 7-8h5"/><circle cx="3" cy="12" r="1.5"/><circle cx="13" cy="4" r="1.5"/>',
};

/** Project real property channels into the user's layer hierarchy. Summary keys
 * contain references to engine keys; they never stand in for document frames. */
export function buildChannelTimelineTracks(layers, channels, report, expanded = new Set(), {nativePoseChannel, nativePropertyChannel, figureNames, figurePoses = false, connectedGroups, focused = false, resolveLayerId} = {}) {
  const connections=connectedGroups ?? connectedTimelineGroups(report),connectionIndex=connectedGroupIndex(connections);
  const definitions = new Map((report?.figure_types ?? []).map(item => [item.figure_type_id, item]));
  const figures = figureNames ?? new Map();
  if (!figureNames) for (const frame of [...(report?.keyframes ?? []),...Object.values(report?._styk?.frameSources??{})]) for (const object of frame.objects ?? []) {
    if (!figures.has(object.unique_id)) figures.set(object.unique_id, {
      name: object._styk?.name || definitions.get(object.figure_type_id)?.name || `Figure ${object.unique_id}`,
      figureTypeId: object.figure_type_id,
    });
  }
  const names = new Map();
  for (const {name} of figures.values()) names.set(name, (names.get(name) ?? 0) + 1);
  const figureName = uid => {
    const name = figures.get(uid)?.name || `Figure ${uid}`;
    return names.get(name) > 1 ? `${name} · #${uid}` : name;
  };
  const byTarget = new Map();
  for (const channel of channels ?? []) {
    const targetId = targetTrackId(channel.target);
    if (!byTarget.has(targetId)) byTarget.set(targetId, []);
    byTarget.get(targetId).push(channel);
  }
  const summaries = sources => {
    const ticks = new Map(), groups = new Map();
    // Native members share one marker sequence. Keep group references compact
    // until a key is actually selected instead of allocating members × frames.
    for (const channel of sources) {
      const keys = channel.markerKeys ?? channel.keys;
      let group = groups.get(keys); if (!group) groups.set(keys, group = []);
      group.push(channel);
    }
    for (const [keys, channels] of groups) for (const key of keys) {
      let summary = ticks.get(key.tick);
      if (!summary) {
        const blocks = []; let refs;
        summary = {id:`tick:${key.tick}`, tick:key.tick, get refs() {
          return refs ??= blocks.flatMap(({channels,key}) => channels.map(channel => ({channelId:channel.id,keyId:channel.markerKeyId?.(key) ?? key.id})));
        }};
        Object.defineProperty(summary,'_blocks',{value:blocks});
        Object.defineProperty(summary,'blank',{get() {
          const poses = blocks.filter(block => block.channels[0].property === 'pose');
          return poses.length > 0 && poses.every(block => block.key.blank || block.key.value?.frameId === null);
        }});
        ticks.set(key.tick, summary);
      }
      summary._blocks.push({channels,key});
    }
    return [...ticks.values()].sort((a, b) => a.tick - b.tick);
  };
  const sourceChannels = (target, placeholders = false) => {
    const targetId = targetTrackId(target);
    const fixedProperties = nativePropertyChannel && ['scene','camera'].includes(target.kind);
    const sources = [...(byTarget.get(targetId) ?? [])].filter(channel => !fixedProperties || channel.property !== 'pose');
    if (!fixedProperties && nativePoseChannel && (['scene', 'camera', 'layer'].includes(target.kind) || figurePoses && target.kind === 'figure') && !sources.some(channel => channel.property === 'pose')) {
      const id = animationChannelId(target, 'pose');
      let descriptor;
      const native = () => descriptor ??= nativePoseChannel(target);
      sources.unshift({id, target, property: 'pose', get keys() { return native().keys; },
        get markerKeys() { return native().markerKeys; },
        markerKeyId(key) { return native().markerKeyId?.(key) ?? key.id; }});
    }
    for (const property of placeholders || fixedProperties ? TRACK_PROPERTIES[target.kind] ?? [] : []) {
      if(nativePropertyChannel && !AUTHORING_PROPERTIES[target.kind]?.includes(property))continue;
      if (fixedProperties && property === 'pose') continue;
      if (target.kind === 'segment' && ['gradientOpacity','gradientColor'].includes(property) && !segmentDefinition(target.uid, target.handleId, target.figureTypeId)?.secondary) continue;
      if (!sources.some(channel => channel.property === property)) {
        const id = animationChannelId(target, property);
        sources.push(nativePropertyChannel && property !== 'pose' ? {id, target, property, get keys() {return nativePropertyChannel(target, property).keys;}} : {id, target, property, keys:[]});
      }
    }
    const properties = TRACK_PROPERTIES[target.kind] ?? [];
    sources.sort((a, b) => properties.indexOf(a.property) - properties.indexOf(b.property));
    return sources;
  };
  const channelRows = (target, parentId, depth, locked) => sourceChannels(target, true).map(channel => {
      let keys;
      return {id: `channel:${channel.id}`, channelId: channel.id, kind: 'channel', target,
        property: channel.property, name: PROPERTY_NAMES[channel.property] ?? channel.property,
        parentId, depth, locked,
        // Rows contain marker metadata only. Editing resolves refs against the
        // original channel, so rendering never copies or samples key payloads.
        get keys() { return keys ??= channel.keys.map(key => ({id:key.id,tick:key.tick,
          interpolation:key.interpolation,bezier:key.bezier,hidden:key.hidden,
          blank:key.blank || channel.property==='pose' && key.value?.frameId===null,
          refs:[{channelId:channel.id,keyId:key.id}]})); },
      };
    });
  // Hidden descendants remain addressable for selection/clipboard commands,
  // without allocating their figure and property rows during every pose edit.
  let uidLayers;
  const layersById=new Map(layers.map(layer=>[layer.id,layer]));
  const layerForUid = uid => {
    if(resolveLayerId)return layersById.get(resolveLayerId(uid));
    if (!uidLayers) {
      uidLayers = new Map();
      for (const layer of layers) for (const id of layer.figureUids ?? []) uidLayers.set(id, layer);
    }
    return uidLayers.get(uid);
  };
  const figureChannelsByLayer = new Map(), segmentChannelsByFigure = new Map();
  for (const channel of channels ?? []) if (['figure','segment','polygon'].includes(channel.target.kind)) {
    const layer = layerForUid(channel.target.uid); if (!layer) continue;
    const list = figureChannelsByLayer.get(layer.id) ?? []; list.push(channel); figureChannelsByLayer.set(layer.id, list);
    if (['segment','polygon'].includes(channel.target.kind)) {
      const segments = segmentChannelsByFigure.get(channel.target.uid) ?? []; segments.push(channel); segmentChannelsByFigure.set(channel.target.uid, segments);
    }
  }
  class TrackIndex extends Map {
    get(id) {
      const existing = super.get(id); if (existing) return existing;
      if (typeof id !== 'string') return undefined;
      if (id.startsWith('assembly:')) {
        const groupId=id.split(':').slice(0,2).join(':'),group=connectionIndex.byId.get(groupId);
        const row=group?assemblyRow(group):undefined;
        return id===groupId?row:row?.children.find(child=>child.id===id);
      }
      if (id.startsWith('figure:')) {
        const uid = Number(id.slice(7)), layer = layerForUid(uid); return layer ? figureRow(uid, layer) : undefined;
      }
      if (id.startsWith('polygon:')) {
        const match=/^polygon:(\d+):(\d+)@(\d+)$/.exec(id);if(!match)return undefined;
        const target={kind:'polygon',uid:Number(match[1]),polygonId:Number(match[2]),figureTypeId:Number(match[3])},layer=layerForUid(target.uid);
        return layer ? polygonRow(target,layer) : undefined;
      }
      if (id.startsWith('segment:')) {
        const parts = id.slice(8).split(':'), scope = parts[1]?.split('@'), uid = Number(parts[0]), handleId = Number(scope?.[0]), layer = layerForUid(uid);
        const figureTypeId = scope?.length === 2 ? Number(scope[1]) : undefined;
        if (parts.length !== 2 || !scope || scope.length > 2 || !Number.isInteger(handleId) || handleId < 1 || handleId > 65535 || !layer ||
          (figureTypeId !== undefined && (!Number.isSafeInteger(figureTypeId) || figureTypeId < 1))) return undefined;
        const target = {kind:'segment',uid,handleId,...(figureTypeId === undefined ? {} : {figureTypeId})};
        return targetTrackId(target) === id ? segmentRow(uid, handleId, layer, figureTypeId) : undefined;
      }
      if (id.startsWith('channel:')) {
        const channelId = id.slice(8), propertyAt = channelId.lastIndexOf(':'), parent = channelId.slice(0, propertyAt);
        const parentId = parent.startsWith('layer:') ? parent.slice(6) : /^(segment|polygon):/.test(parent) ? `${parent.slice(0,8)}${decodeURIComponent(parent.slice(8)).replace('/', ':')}` : parent;
        const owner = this.get(parentId); return owner?.channelChildren?.find(child => child.id === id);
      }
      return undefined;
    }
    has(id) { return Boolean(this.get(id)); }
  }
  const byId = new TrackIndex();
  class AssemblyIndex extends Map {
    get(uid){const row=super.get(uid);if(row)return row;const group=connectionIndex.byUid.get(uid);return group?assemblyRow(group):undefined;}
  }
  const assemblyByUid = new AssemblyIndex();
  const registerChildren = children => { for (const child of children) byId.set(child.id, child); return children; };
  const polygonRow = (target,layer) => {
    const id=targetTrackId(target),existing=Map.prototype.get.call(byId,id);if(existing)return existing;
    let children,keys;
    const row={id,kind:'polygon',uid:target.uid,target,parentId:`figure:${target.uid}`,layerId:layer.id,depth:2,
      name:`Polygon ${target.polygonId}`,locked:layer.locked,hasChildren:true,
      get channelChildren(){return children ??= registerChildren(channelRows(target,id,3,layer.locked));},
      get children(){return this.channelChildren;},get keys(){return keys ??= summaries(sourceChannels(target));}};
    byId.set(id,row);return row;
  };
  const figureSegments = uid => definitions.get(figures.get(uid)?.figureTypeId)?.segments ?? [];
  const segmentIndices = new Map();
  const segmentDefinition = (uid, handleId, figureTypeId = figures.get(uid)?.figureTypeId) => {
    let index = segmentIndices.get(figureTypeId);
    if (!index) { index = new Map((definitions.get(figureTypeId)?.segments ?? []).map(segment => [segment.segment_id, segment])); segmentIndices.set(figureTypeId, index); }
    return index.get(handleId);
  };
  const segmentRow = (uid, handleId, layer, figureTypeId) => {
    const target = {kind:'segment',uid,handleId,...(figureTypeId === undefined ? {} : {figureTypeId})};
    const id = targetTrackId(target), previous = Map.prototype.get.call(byId, id); if (previous) return previous;
    const definition = segmentDefinition(uid, handleId, figureTypeId);
    if (!definition && !byTarget.has(targetTrackId(target))) return undefined;
    let children, keys;
    const row = {id, kind: 'segment', uid, handleId, target, parentId: `figure:${uid}`, layerId: layer.id, depth: 2,
      name: `${definition?._styk?.name || `Segment ${handleId}`}${figureTypeId === undefined ? '' : ` · ${definitions.get(figureTypeId)?.name || `Rig ${figureTypeId}`}`}`, locked: layer.locked, hasChildren: true,
      get channelChildren() { return children ??= registerChildren(channelRows(target, id, 3, layer.locked)); },
      get children() { return this.channelChildren; },
      get keys() { return keys ??= summaries(sourceChannels(target)); },
    };
    byId.set(id, row); return row;
  };
  const figureRow = (uid, layer) => {
    const id = `figure:${uid}`, previous = Map.prototype.get.call(byId, id); if (previous) return previous;
    if(!figures.has(uid)){
      // A newly imported/authored owner can exist only in a retained pose.
      // Resolve its metadata lazily without rebuilding all native names.
      const sources=Object.values(report?._styk?.frameSources??{});
      for(let i=sources.length-1;i>=0;i--){const object=sources[i].objects.find(o=>o.unique_id===uid);if(object){figures.set(uid,{name:object._styk?.name||definitions.get(object.figure_type_id)?.name||`Figure ${uid}`,figureTypeId:object.figure_type_id});break;}}
    }
    const target = {kind: 'figure', uid}; let children, channels, keys;
    const row = {id, kind: 'figure', uid, target, parentId: layer.id, layerId: layer.id, depth: 1,
      name: figureName(uid), locked: layer.locked, hasChildren: true,
      get channelChildren() { return channels ??= registerChildren(channelRows(target, id, 2, layer.locked)); },
      get children() {
        if (!children) {
          const authoredTargets = new Map((segmentChannelsByFigure.get(uid) ?? []).map(channel => [targetTrackId(channel.target), channel.target]));
          const targets = new Map(), figureTypeId = figures.get(uid)?.figureTypeId;
          for (const segment of figureSegments(uid)) {
            const target = {kind:'segment',uid,handleId:segment.segment_id}, id = targetTrackId(target);
            // A scoped base-rig row already supplies its empty properties. Keep
            // an explicit legacy curve, but do not add a duplicate blank row.
            if (authoredTargets.has(id) || !authoredTargets.has(targetTrackId({...target,figureTypeId}))) targets.set(id,target);
          }
          for (const [id,target] of authoredTargets) targets.set(id,target);
          children = [...this.channelChildren, ...[...targets.values()].map(target => target.kind === 'polygon' ? polygonRow(target,layer) : segmentRow(uid,target.handleId,layer,target.figureTypeId)).filter(Boolean)];
        }
        return children;
      },
      get keys() { return keys ??= summaries([...sourceChannels(target), ...(segmentChannelsByFigure.get(uid) ?? [])]); },
    };
    byId.set(id, row); return row;
  };
  const layerRoots = layers.map(layer => {
    const target = layer.kind === 'layer' ? {kind: 'layer', id: layer.id} : {kind: layer.kind};
    let children, channels, keys;
    const root = {...layer, depth: 0, target, hasChildren: true,
      get channelChildren() { return channels ??= registerChildren(channelRows(target, layer.id, 1, layer.locked)); },
      get children() { return children ??= registerChildren([...this.channelChildren,
        ...(layer.kind === 'layer' ? (layer.figureUids ?? []).map(uid => figureRow(uid, layer)) : [])]); },
      get keys() { return keys ??= summaries([...sourceChannels(target), ...(figureChannelsByLayer.get(layer.id) ?? [])]); },
    };
    byId.set(root.id, root);
    return root;
  });
  const assemblyRow = group => {
    const existing=Map.prototype.get.call(byId,group.id);if(existing)return existing;
    const uids = group.figureUids.filter(uid => layerForUid(uid));
    if (uids.length < 2) return undefined;
    let children, keys, sources;
    const memberSources = () => sources ??= uids.flatMap(uid => {
      const target = {kind:'figure', uid}, own = sourceChannels(target);
      if (nativePoseChannel && !own.some(channel => channel.property === 'pose')) own.unshift(nativePoseChannel(target));
      return [...own, ...(segmentChannelsByFigure.get(uid) ?? [])];
    });
    const row = {...group, figureUids: uids, kind: 'assembly', depth: 0, hasChildren: true,
      name: figureName(group.rootUid),
      locked: uids.some(uid => layerForUid(uid).locked),
      get children() {
        if (!children) {
          const properties = new Map();
          for (const channel of memberSources()) {
            const list = properties.get(channel.property) ?? []; list.push(channel); properties.set(channel.property,list);
          }
          children = registerChildren([...properties].map(([property, channels]) => {
            let markers;
            return {id:`${group.id}:${property}`,kind:'assembly-property',property,figureUids:uids,parentId:group.id,
              depth:1,locked:row.locked,name:PROPERTY_NAMES[property] ?? property,hasChildren:false,
              targets:channels.map(channel=>channel.target),get keys(){return markers ??= summaries(channels);}};
          }));
        }
        return children;
      },
      get keys() { return keys ??= summaries(memberSources()); },
    };
    byId.set(row.id, row);
    for (const uid of uids) assemblyByUid.set(uid, row);
    return row;
  };
  if(!focused)for(const group of connections)assemblyRow(group);
  const roots = [];
  const inserted = new Set();
  for (const layer of layerRoots) {
    if(focused){if(layer.kind!=='layer')roots.push(layer);continue;}
    for (const uid of layer.figureUids ?? []) {
      const assembly = assemblyByUid.get(uid);
      if (assembly && !inserted.has(assembly.id)) { roots.push(assembly); inserted.add(assembly.id); }
    }
    // Preserve user layers containing unrelated figures, and empty user layers.
    if (!layer.figureUids?.length || layer.figureUids.some(uid => !assemblyByUid.has(uid))) roots.push(layer);
  }
  const tracks = [];
  const visit = (track, parent = null) => {
    if (parent?.kind === 'layer' && track.kind === 'figure' && assemblyByUid.has(track.uid)) return;
    if (parent) { track.depth = parent.depth + 1; track.parentId = parent.id; }
    tracks.push(track);
    if (expanded.has(track.id)) for (const child of track.children ?? []) visit(child, track);
  };
  for (const root of roots) visit(root);
  return {tracks, roots, byId, figureNames: figures, assemblyByUid};
}

