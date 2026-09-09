/**
 * Viewport-sized timeline. Its DOM count is proportional to the visible rows,
 * not the document size, and playback repaints only the playhead overlay.
 */
import {keyEasing} from './keyframe-easing.mjs';
import {connectedTimelineGroups} from './connected-timeline.mjs';
import {createTimelineDialog} from './timeline-dialog.mjs';
import {showKeyframeEasingPopover} from './keyframe-easing-popover.mjs';
import {animationChannelId} from './animation-channels.mjs';
const LABEL_WIDTH = 176;
const TOOLBAR_HEIGHT = 32;
const RULER_HEIGHT = 31;
const ROW_HEIGHT = 30;
const LEAD = 12;
const TAIL = 72;
const MAX_SCROLL = 8_000_000;
const ACCENT = '#0d99ff';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rulerInterval = step => {
  const needed = 48 / step, scale = 10 ** Math.floor(Math.log10(needed));
  return Math.max(5, [1, 2, 5, 10].find(value => value * scale >= needed) * scale);
};

const STYLES = `
.styk-timeline{position:relative;width:100%;height:100%;min-height:110px;overflow:hidden;background:#fafafa;font:12px Inter,InterFallback,'Segoe UI',sans-serif;color:#333;contain:layout paint style;container:styk-timeline / inline-size;--timeline-label-width:176px}
.styk-timeline *{box-sizing:border-box}
.styk-timeline [hidden]{display:none!important}
.styk-timeline-editbar{position:absolute;inset:0 0 auto;height:32px;display:flex;align-items:center;gap:10px;padding:0 10px;background:#fff;border-bottom:1px solid #dcdcdc;z-index:1}
.styk-timeline-key-position{display:flex;align-items:baseline;gap:5px;white-space:nowrap;min-width:calc(var(--timeline-label-width) - 20px);font-size:11px;color:#777;font-variant-numeric:tabular-nums}
.styk-timeline-key-position strong{font-size:12px;font-weight:650;color:#262626}
.styk-timeline-range-count{font-size:10px;color:#0877c5;background:#e5f4ff;border-radius:3px;padding:2px 5px;margin-left:5px}
.styk-timeline-tools{display:flex;align-items:center;gap:2px}
.styk-timeline-tools button{display:flex;align-items:center;justify-content:center;gap:5px;height:26px;padding:0 7px;border:1px solid transparent;border-radius:4px;background:transparent;color:#4b4b4b;font:11px Inter,InterFallback,'Segoe UI',sans-serif;cursor:pointer;white-space:nowrap}
.styk-timeline-tools button:hover,.styk-timeline-tools button:focus-visible{background:#f1f1f1;color:#171717;outline:none;border-color:#dedede}
.styk-timeline-tools button:disabled{opacity:.35;cursor:default}
.styk-timeline-tools button[data-action=delete-frame]:hover{background:#fff0f0;color:#d33;border-color:#ffd7d7}
.styk-timeline-tools svg{width:16px;height:16px;display:block;flex-shrink:0}
.styk-timeline-tool-divider{width:1px;height:16px;background:#e2e2e2;margin:0 4px}
.styk-timeline-frame-position{margin-left:auto;white-space:nowrap;color:#666;font-size:11px;font-variant-numeric:tabular-nums}
.styk-timeline-labels{position:absolute;left:0;top:63px;bottom:0;width:var(--timeline-label-width);overflow:hidden;border-right:1px solid #d8d8d8;background:#fafafa}
.styk-timeline-heading{position:absolute;inset:32px auto auto 0;width:var(--timeline-label-width);height:31px;display:flex;align-items:center;gap:8px;padding:0 14px;border-right:1px solid #d8d8d8;border-bottom:1px solid #d8d8d8;background:#f2f2f2;font-size:11px;font-weight:600;color:#555}
.styk-timeline-count{margin-left:auto;font-size:11px;font-weight:400;color:#777;font-variant-numeric:tabular-nums}
.styk-timeline-label{position:absolute;left:0;width:100%;height:30px;border:0;border-bottom:1px solid #dfdfdf;background:#fff;display:flex;align-items:center;gap:9px;padding:0 14px;text-align:left;color:#3d3d3d;font:inherit;cursor:pointer;white-space:nowrap}
.styk-timeline-label:hover{background:#f5f5f5}
.styk-timeline-label[aria-selected=true]{background:#e5f4ff;color:#0877c5;box-shadow:inset 2px 0 #0d99ff}
.styk-timeline-label-icon{width:14px;height:14px;flex-shrink:0;color:#777}
.styk-timeline-label[aria-selected=true] .styk-timeline-label-icon{color:#0d99ff}
.styk-timeline-label-name{overflow:hidden;text-overflow:ellipsis;flex:1}
.styk-timeline-label-id{font-size:10px;color:#999;font-variant-numeric:tabular-nums}
.styk-timeline-scroll{position:absolute;left:var(--timeline-label-width);right:0;top:32px;bottom:0;overflow:auto;overscroll-behavior:contain;touch-action:none;scrollbar-width:thin;scrollbar-color:#bcbcbc #f3f3f3;outline-offset:-2px}
.styk-timeline-scroll::-webkit-scrollbar{width:8px;height:8px}
.styk-timeline-scroll::-webkit-scrollbar-thumb{background:#bcbcbc;border:2px solid #f7f7f7;border-radius:6px}
.styk-timeline-scroll::-webkit-scrollbar-track,.styk-timeline-scroll::-webkit-scrollbar-corner{background:#f7f7f7}
.styk-timeline-spacer{pointer-events:none;min-width:100%;min-height:100%}
.styk-timeline-canvas{position:absolute;left:var(--timeline-label-width);top:32px;pointer-events:none}
.styk-timeline-column-divider{position:absolute;left:calc(var(--timeline-label-width) - 2px);top:32px;bottom:0;width:5px;z-index:2;cursor:col-resize;touch-action:none;outline:none}
.styk-timeline-column-divider:hover,.styk-timeline-column-divider:focus-visible{background:#0d99ff55}
.styk-timeline-live{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.styk-timeline-empty{position:absolute;left:0;right:0;top:0;height:70px;display:flex;align-items:center;padding:0 16px;font-size:10px;line-height:1.6;color:#999}
.styk-timeline-menu{position:fixed;z-index:60;width:224px;max-height:calc(100vh - 16px);overflow:auto;background:#fff;border:1px solid #ddd;border-radius:7px;padding:4px;box-shadow:0 4px 20px #0002;color:#333;font:11px Inter,InterFallback,'Segoe UI',sans-serif;box-sizing:border-box}
.styk-timeline-menu[hidden]{display:none!important}
.styk-timeline-menu-label{padding:5px 8px 6px;font-size:9px;color:#888;border-bottom:1px solid #eee;margin-bottom:3px}
.styk-timeline-menu button{width:100%;height:28px;padding:0 8px;display:flex;align-items:center;justify-content:space-between;border:0;border-radius:3px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}
.styk-timeline-menu button:hover,.styk-timeline-menu button:focus-visible{background:#e5f4ff;outline:none}
.styk-timeline-menu button:disabled{opacity:.4;cursor:default}
.styk-timeline-menu kbd{font:9px inherit;color:#999}
.styk-timeline-menu-separator{height:1px;background:#eee;margin:4px 0}
@container styk-timeline (max-width:760px){.styk-timeline-frame-position{display:none}.styk-timeline-editbar{gap:4px}.styk-timeline-key-position{min-width:calc(var(--timeline-label-width) - 20px)}}
@container styk-timeline (max-width:570px){.styk-timeline-tools button>span{display:none}.styk-timeline-tools button{width:27px;padding:0}.styk-timeline-key-position{min-width:120px}.styk-timeline-range-count{display:none}}
.styk-timeline-channels{background:#f7f8fa}
.styk-timeline-channels .styk-timeline-editbar{gap:6px;background:#fff}
.styk-timeline-channels .styk-timeline-key-position{overflow:hidden;min-width:0;width:calc(var(--timeline-label-width) - 12px);flex-shrink:0;gap:5px}
.styk-timeline-channels .styk-timeline-key-position>span:first-child{display:none}
.styk-timeline-channels .styk-timeline-key-position strong{overflow:hidden;text-overflow:ellipsis;font-size:11px}
.styk-timeline-channels .styk-timeline-key-position>span:not(:first-child){font-size:10px}
.styk-timeline-channels .styk-timeline-heading{background:#f5f6f8;padding:0 10px;color:#4c535e;font-weight:600}
.styk-timeline-add-layer{display:grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:4px;color:#6b7280;background:transparent;cursor:pointer;font-size:17px}
.styk-timeline-add-layer:hover{background:#e5e8ed;color:#252a32}
.styk-timeline-channels .styk-timeline-labels{background:#fff}
.styk-timeline-channels .styk-timeline-label{padding:0 7px 0 5px;gap:5px;border-bottom:1px solid #edf0f3;background:#fff;cursor:default;color:#454b55;font-size:11px}
.styk-timeline-channels .styk-timeline-label[data-kind=scene],.styk-timeline-channels .styk-timeline-label[data-kind=camera]{background:#f6f7f9;font-weight:600}
.styk-timeline-channels .styk-timeline-label[data-kind=layer]{font-weight:600;border-top:1px solid #e4e7ec;background:#fbfcfd}
.styk-timeline-channels .styk-timeline-label[data-kind=channel]{color:#77808c;font-size:10px}
.styk-timeline-channels .styk-timeline-label[aria-selected=true]{background:#e8f4ff;color:#076ab0;box-shadow:inset 2px 0 #0d99ff}
.styk-timeline-label-disclosure,.styk-timeline-label-control,.styk-timeline-label-select{display:flex;align-items:center;justify-content:center;height:24px;border:0;background:transparent;color:inherit;padding:0;cursor:pointer;border-radius:3px;font:inherit}
.styk-timeline-label-disclosure{width:14px;flex-shrink:0;color:#8b929d;font-size:10px}
.styk-timeline-label-control{width:20px;flex-shrink:0;color:#858e9a}
.styk-timeline-label-control:hover,.styk-timeline-label-disclosure:hover{background:#00000009;color:#343c48}
.styk-timeline-label-control[aria-pressed=true]{color:#0d99ff;background:#e5f4ff}
.styk-timeline-label-select{flex:1;min-width:0;justify-content:flex-start;gap:6px;height:29px;overflow:hidden;text-align:left}
.styk-timeline-label-select .styk-timeline-label-name{flex:1}
.styk-timeline-channels .styk-timeline-label-icon{width:13px;height:13px;color:#8c94a0}
.styk-timeline-label-control svg{width:13px;height:13px}
.styk-timeline-channel-tools button[data-primary=true]{color:#087ac6;background:#edf7ff}
.styk-timeline-channel-tools button[data-primary=true]:hover{background:#dcedfc}
.styk-timeline-view-button{font-size:10px!important;padding:0 5px!important;color:#707985!important}
.styk-timeline-drag-status{position:absolute;right:12px;bottom:12px;z-index:3;padding:6px 9px;border-radius:5px;background:#252d3d;color:#fff;box-shadow:0 2px 7px #0002;font-size:11px;font-variant-numeric:tabular-nums;pointer-events:none}
.styk-timeline-drag-status[data-invalid=true]{background:#b53642}
.styk-timeline-scroll,.styk-timeline-column-divider{bottom:32px}
.styk-timeline-editbar{gap:6px}
.styk-timeline-key-position{flex-shrink:0;max-width:calc(var(--timeline-label-width) - 12px);overflow:hidden;min-width:0;width:calc(var(--timeline-label-width) - 12px)}
.styk-timeline-key-position strong{overflow:hidden;text-overflow:ellipsis}
.styk-timeline-key-position>span{flex-shrink:0}
.styk-timeline-nav{position:absolute;inset:auto 0 0;height:32px;display:flex;align-items:center;gap:5px;padding:0 8px;background:#fff;border-top:1px solid #d8dde3;font-size:10px}
.styk-timeline-nav button{height:24px;min-width:24px;border:1px solid transparent;border-radius:4px;padding:0 6px;background:transparent;color:#596271;font:inherit;cursor:pointer;white-space:nowrap}
.styk-timeline-nav button:hover{background:#eef2f6;color:#202630}
.styk-timeline-nav button[aria-pressed=true]{background:#e5f4ff;color:#0877c5}
.styk-timeline-nav button:focus-visible,.styk-timeline-nav input:focus-visible{outline:2px solid #0d99ff;outline-offset:0}
.styk-timeline-nav-modes{display:flex;gap:2px;width:calc(var(--timeline-label-width) - 12px);flex-shrink:0}
.styk-timeline-nav input[type=number]{width:60px;height:23px;border:1px solid #d9dfe5;border-radius:4px;padding:0 5px;color:#333;background:#fff;font:11px 'Segoe UI',sans-serif;font-variant-numeric:tabular-nums}
.styk-timeline-nav label{display:flex;align-items:center;gap:5px;white-space:nowrap}
.styk-timeline-nav-zoom{margin-left:auto;display:flex;align-items:center;gap:3px}
.styk-timeline-nav input[type=range]{width:72px;accent-color:#0d99ff}
.styk-timeline-nav button:disabled{opacity:.35;cursor:default}
.styk-timeline-drag-status{bottom:40px}
@container styk-timeline (max-width:640px){.styk-timeline-nav-zoom input,.styk-timeline-nav-follow{display:none}.styk-timeline-nav{gap:2px}.styk-timeline-nav-modes{width:auto}.styk-timeline-key-total{display:none}}
`;

const TOOL_ICONS = {
  add: '<path d="m6 4 5 6-5 6-5-6 5-6Z"/><path d="M15 2v7m-3.5-3.5h7"/>',
  blank: '<rect x="2.5" y="4.5" width="12" height="12" rx="1.5"/><path d="M15 1.5v6m-3-3h6"/>',
  timing: '<circle cx="10" cy="10" r="7"/><path d="M10 5.5V10l3 2"/>',
  duplicate: '<rect x="6" y="6" width="10" height="11" rx="1.5"/><path d="M12 6V3.5A1.5 1.5 0 0 0 10.5 2h-7A1.5 1.5 0 0 0 2 3.5v8A1.5 1.5 0 0 0 3.5 13H6"/>',
  delete: '<path d="M3.5 5.5h13M8 2.5h4M5 5.5l.7 11h8.6l.7-11M8 8.5v5m4-5v5"/>',
  more: '<circle cx="4" cy="10" r="1" fill="currentColor"/><circle cx="10" cy="10" r="1" fill="currentColor"/><circle cx="16" cy="10" r="1" fill="currentColor"/>',
};

const PROPERTY_NAMES = {pose: 'Pose', x: 'Position X', y: 'Position Y', scale: 'Scale', rotation: 'Rotation', opacity: 'Opacity', outlineOpacity: 'Outline opacity', gradientOpacity: 'Gradient opacity', backgroundId: 'Background', color: 'Color'};
const TRACK_PROPERTIES = {figure: ['x', 'y', 'scale', 'rotation', 'opacity', 'outlineOpacity'], segment: ['opacity', 'gradientOpacity'], camera: ['pose', 'x', 'y', 'scale', 'rotation'], scene: ['pose', 'backgroundId', 'color'], layer: ['pose']};
const targetTrackId = target => target.kind === 'figure' ? `figure:${target.uid}` : target.kind === 'segment' ? `segment:${target.uid}:${target.handleId}${target.figureTypeId === undefined ? '' : `@${target.figureTypeId}`}` : target.kind === 'layer' ? `layer:${target.layerId ?? target.id}` : target.kind;
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
export function buildChannelTimelineTracks(layers, channels, report, expanded = new Set(), {nativePoseChannel, figureNames, figurePoses = false, connectedGroups} = {}) {
  const definitions = new Map((report?.figure_types ?? []).map(item => [item.figure_type_id, item]));
  const figures = figureNames ?? new Map();
  if (!figureNames) for (const frame of report?.keyframes ?? []) for (const object of frame.objects ?? []) {
    if (!figures.has(object.unique_id)) figures.set(object.unique_id, {
      name: object._styk?.name || definitions.get(object.figure_type_id)?.name || `Figure ${object.unique_id}`,
      figureTypeId: object.figure_type_id,
    });
  }
  const byTarget = new Map();
  for (const channel of channels ?? []) {
    const targetId = targetTrackId(channel.target);
    if (!byTarget.has(targetId)) byTarget.set(targetId, []);
    byTarget.get(targetId).push(channel);
  }
  const summaries = sources => {
    const ticks = new Map();
    for (const channel of sources) for (const key of channel.keys) {
      let summary = ticks.get(key.tick);
      if (!summary) { summary = {id: `tick:${key.tick}`, tick: key.tick, refs: []}; ticks.set(key.tick, summary); }
      summary.refs.push({channelId: channel.id, keyId: key.id});
      if (key.blank || key.value?.frameId === null) summary.blank = true;
    }
    return [...ticks.values()].sort((a, b) => a.tick - b.tick);
  };
  const sourceChannels = (target, placeholders = false) => {
    const targetId = targetTrackId(target);
    const sources = [...(byTarget.get(targetId) ?? [])];
    if (nativePoseChannel && (['scene', 'camera', 'layer'].includes(target.kind) || figurePoses && target.kind === 'figure') && !sources.some(channel => channel.property === 'pose')) {
      const id = animationChannelId(target, 'pose');
      sources.unshift({id, target, property: 'pose', get keys() { return nativePoseChannel(target).keys; }});
    }
    for (const property of placeholders ? TRACK_PROPERTIES[target.kind] ?? [] : []) {
      if (target.kind === 'segment' && property === 'gradientOpacity' && !segmentDefinition(target.uid, target.handleId, target.figureTypeId)?.secondary) continue;
      if (!sources.some(channel => channel.property === property)) sources.push({id: animationChannelId(target, property), target, property, keys: []});
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
        get keys() { return keys ??= channel.keys.map(key => ({...key, refs: [{channelId: channel.id, keyId: key.id}]})); },
      };
    });
  // Hidden descendants remain addressable for selection/clipboard commands,
  // without allocating their figure and property rows during every pose edit.
  let uidLayers;
  const layerForUid = uid => {
    if (!uidLayers) {
      uidLayers = new Map();
      for (const layer of layers) for (const id of layer.figureUids ?? []) uidLayers.set(id, layer);
    }
    return uidLayers.get(uid);
  };
  const figureChannelsByLayer = new Map(), segmentChannelsByFigure = new Map();
  for (const channel of channels ?? []) if (channel.target.kind === 'figure' || channel.target.kind === 'segment') {
    const layer = layerForUid(channel.target.uid); if (!layer) continue;
    const list = figureChannelsByLayer.get(layer.id) ?? []; list.push(channel); figureChannelsByLayer.set(layer.id, list);
    if (channel.target.kind === 'segment') {
      const segments = segmentChannelsByFigure.get(channel.target.uid) ?? []; segments.push(channel); segmentChannelsByFigure.set(channel.target.uid, segments);
    }
  }
  class TrackIndex extends Map {
    get(id) {
      const existing = super.get(id); if (existing) return existing;
      if (typeof id !== 'string') return undefined;
      if (id.startsWith('figure:')) {
        const uid = Number(id.slice(7)), layer = layerForUid(uid); return layer ? figureRow(uid, layer) : undefined;
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
        const parentId = parent.startsWith('layer:') ? parent.slice(6) : parent.startsWith('segment:') ? `segment:${decodeURIComponent(parent.slice(8)).replace('/', ':')}` : parent;
        const owner = this.get(parentId); return owner?.channelChildren?.find(child => child.id === id);
      }
      return undefined;
    }
    has(id) { return Boolean(this.get(id)); }
  }
  const byId = new TrackIndex();
  const assemblyByUid = new Map();
  const registerChildren = children => { for (const child of children) byId.set(child.id, child); return children; };
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
    const target = {kind: 'figure', uid}; let children, channels, keys;
    const row = {id, kind: 'figure', uid, target, parentId: layer.id, layerId: layer.id, depth: 1,
      name: figures.get(uid)?.name || `Figure ${uid}`, locked: layer.locked, hasChildren: true,
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
          children = [...this.channelChildren, ...[...targets.values()].map(target => segmentRow(uid,target.handleId,layer,target.figureTypeId)).filter(Boolean)];
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
  for (const group of connectedGroups ?? connectedTimelineGroups(report)) {
    const uids = group.figureUids.filter(uid => layerForUid(uid));
    if (uids.length < 2) continue;
    let children, keys;
    const row = {...group, figureUids: uids, kind: 'assembly', depth: 0, hasChildren: true,
      name: `${figures.get(group.rootUid)?.name || 'Figure'} · Connected (${uids.length})`,
      locked: uids.some(uid => layerForUid(uid).locked),
      get children() { return children ??= uids.map(uid => figureRow(uid, layerForUid(uid))); },
      get keys() { return keys ??= summaries(uids.flatMap(uid => {
        const target = {kind:'figure', uid}, sources = sourceChannels(target);
        if (nativePoseChannel && !sources.some(channel => channel.property === 'pose')) sources.unshift(nativePoseChannel(target));
        return [...sources, ...(segmentChannelsByFigure.get(uid) ?? [])];
      })); },
    };
    byId.set(row.id, row);
    for (const uid of uids) assemblyByUid.set(uid, row);
  }
  const roots = [];
  const inserted = new Set();
  for (const layer of layerRoots) {
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

function element(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.append(node);
  return node;
}

/** Index document tracks once, with only a frame index stored per appearance. */
export function buildTimelineTracks(report) {
  const definitions = new Map((report?.figure_types ?? []).map(figure => [figure.figure_type_id, figure]));
  const tracks = [], byUid = new Map();
  const frames = report?.keyframes ?? [];
  for (let index = 0; index < frames.length; index++) {
    for (const object of frames[index].objects ?? []) {
      const uid = object.unique_id;
      let track = byUid.get(uid);
      if (!track) {
        const definition = definitions.get(object.figure_type_id);
        track = {uid, name: object._styk?.name || definition?.name || `Figure ${uid}`,
          typeId: object.figure_type_id, frames: []};
        byUid.set(uid, track);
        tracks.push(track);
      }
      // A malformed duplicate UID in one keyframe must not double-paint a cell.
      if (track.frames.at(-1) !== index) track.frames.push(index);
    }
  }
  return tracks;
}

function firstVisibleKey(keys, exposures, start) {
  let low = 0, high = keys.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const exposure = exposures[keys[middle]];
    if (!exposure || exposure.start + exposure.count <= start) low = middle + 1;
    else high = middle;
  }
  return low;
}

function diamond(context, x, y, size) {
  context.beginPath();
  context.moveTo(x, y - size); context.lineTo(x + size, y);
  context.lineTo(x, y + size); context.lineTo(x - size, y);
  context.closePath(); context.fill();
}

export class Timeline {
  constructor(container, editor, {onSeek, onSelect, onRangeChange, onLoopRangeChange, onScrubStart, onScrub, onScrubEnd, onError, onTrackSelect, onKeysChange, onInsertInbetween, runClipboardOperation, mode = 'action'} = {}) {
    this.container = container;
    this.editor = editor;
    this.onSeek = onSeek;
    this.onSelect = onSelect;
    this.onRangeChange = onRangeChange;
    this.onLoopRangeChange = onLoopRangeChange;
    this.onScrubStart = onScrubStart;
    this.onScrub = onScrub;
    this.onScrubEnd = onScrubEnd;
    this.onError = onError;
    this.onTrackSelect = onTrackSelect;
    this.onKeysChange = onKeysChange;
    this.onInsertInbetween = onInsertInbetween;
    this.runClipboardOperation = runClipboardOperation;
    this.mode = mode;
    this.actionMode = mode === 'action';
    this.collapsedActions = new Set();
    this.expandedTracks = new Set();
    this._animationSelection = new Map();
    this._rangeAnchor = this._rangeFocus = null;
    this._selectionSet = this._selectionList = this._selectionRuns = null;
    this._loopFrames = null;
    this._lastLoopSignature = '';
    this.pxPerTick = 18;
    this.followPlayhead = true;
    this.tracks = [];
    this.labels = [];
    this._listeners = [];
    this._fullDirty = true;
    this._headDirty = true;
    this._destroyed = false;
    this._dragging = false;
    this._lastHead = null;
    this.root = element('div', 'styk-timeline', container);
    const style = element('style', '', this.root); style.textContent = STYLES;
    this._buildToolbar();
    this.heading = element('div', 'styk-timeline-heading', this.root);
    const headingText = element('span', '', this.heading); headingText.textContent = this.actionMode ? 'Selected channels' : 'Layers';
    this.count = element('span', 'styk-timeline-count', this.heading);
    this.labelViewport = element('div', 'styk-timeline-labels', this.root);
    this.labelViewport.setAttribute('role', 'listbox');
    this.labelViewport.setAttribute('aria-label', 'Animation layers');
    this.scroll = element('div', 'styk-timeline-scroll', this.root);
    this.scroll.tabIndex = 0;
    this.scroll.setAttribute('role', 'slider');
    this.scroll.setAttribute('aria-label', 'Animation timeline. Arrows seek and select layers. Page Up and Page Down visit every keyframe, including hidden keys. Shift-click selects a range; Control or Command-click toggles keys.');
    this.scroll.setAttribute('aria-orientation', 'horizontal');
    this.scroll.setAttribute('aria-valuemin', '1');
    this.spacer = element('div', 'styk-timeline-spacer', this.scroll);
    this.gridCanvas = element('canvas', 'styk-timeline-canvas', this.root);
    this.headCanvas = element('canvas', 'styk-timeline-canvas', this.root);
    this.gridCanvas.setAttribute('aria-hidden', 'true');
    this.headCanvas.setAttribute('aria-hidden', 'true');
    this.gridContext = this.gridCanvas.getContext('2d', {alpha: false});
    this.headContext = this.headCanvas.getContext('2d');
    this.columnDivider = element('div', 'styk-timeline-column-divider', this.root);
    this.columnDivider.tabIndex = 0;
    this.columnDivider.setAttribute('role', 'separator');
    this.columnDivider.setAttribute('aria-label', 'Layer column width');
    this.columnDivider.setAttribute('aria-orientation', 'vertical');
    this.columnDivider.setAttribute('aria-valuemin', '128');
    this.columnDivider.title = 'Resize layer column · Double-click to reset';
    this._on(this.columnDivider, 'pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      this._columnDrag = {x: event.clientX, width: this.labelWidth};
      this.columnDivider.setPointerCapture(event.pointerId);
    });
    this._on(this.columnDivider, 'pointermove', event => {
      if (this._columnDrag) this.setLabelWidth(this._columnDrag.width + event.clientX - this._columnDrag.x);
    });
    const endColumnDrag = () => { this._columnDrag = null; };
    this._on(this.columnDivider, 'pointerup', endColumnDrag);
    this._on(this.columnDivider, 'pointercancel', endColumnDrag);
    this._on(this.columnDivider, 'lostpointercapture', endColumnDrag);
    this._on(this.columnDivider, 'dblclick', event => {
      event.preventDefault(); event.stopPropagation(); this._labelWidthOverride = null; this.resize();
    });
    this._on(this.columnDivider, 'keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      this.setLabelWidth(event.key === 'Home' ? LABEL_WIDTH : this.labelWidth + (event.key === 'ArrowLeft' ? -8 : 8));
    });
    this.live = element('div', 'styk-timeline-live', this.root);
    this.live.setAttribute('aria-live', 'polite');
    this.live.setAttribute('aria-atomic', 'true');
    this._buildNavigator();
    this._on(this.scroll, 'scroll', () => {
      const offset = this._offsetX();
      if (this.channelMode && offset > 0 && offset + this.width >= this.logicalWidth - 40) this._scrollToX(offset);
      this._fullDirty = this._headDirty = true; this._schedule();
    }, {passive: true});
    this._on(this.scroll, 'pointerdown', event => this._pointerDown(event));
    this._on(this.scroll, 'pointermove', event => this._pointerMove(event));
    this._on(this.scroll, 'pointerup', event => this._pointerUp(event));
    this._on(this.scroll, 'pointercancel', event => this._pointerUp(event));
    this._on(this.scroll, 'lostpointercapture', () => { this._finishChannelGesture(true); this._finishScrub(true); });
    this._on(window, 'blur', () => { this._finishChannelGesture(true); this._finishScrub(true); });
    this._on(this.scroll, 'keydown', event => this._keyDown(event));
    this._on(this.scroll, 'contextmenu', event => this._contextMenu(event));
    this._on(this.scroll, 'dblclick', event => {
      if (!this.channelMode) {
        const rect = this.scroll.getBoundingClientRect();
        if (event.clientY - rect.top < RULER_HEIGHT || event.clientX - rect.left >= this.width || event.clientY - rect.top >= this.height) return;
        event.preventDefault(); event.stopPropagation(); this._runCommand('showEasingPopover'); return;
      }
      const hit = this._channelHit(event);
      if (hit.y < RULER_HEIGHT || !hit.track || hit.track.locked || hit.x >= this.width || hit.y >= this.height) return;
      event.preventDefault(); event.stopPropagation();
      this._selectTrack(hit.track);
      if (hit.key) { this._setAnimationSelection(hit.key.refs); this._runCommand('showEasingPopover'); }
      else this._runCommand('addTrackKey');
    });
    this._on(document, 'pointerdown', event => { if (this.menu && !this.menu.contains(event.target)) this.menu.hidden = true; });
    this._on(this.scroll, 'wheel', event => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault(); event.stopPropagation();
        this.setZoom(this.pxPerTick * Math.exp(-event.deltaY * 0.005), event.clientX - this.scroll.getBoundingClientRect().left);
      } else if (event.shiftKey || event.deltaX || this.logicalHeight <= this.height) {
        event.preventDefault(); event.stopPropagation();
        const units = event.deltaMode === 1 ? ROW_HEIGHT : event.deltaMode === 2 ? this.width : 1;
        this._scrollToX(this._offsetX() + (event.deltaX || event.deltaY) * units);
      }
    }, {passive: false});
    this._on(this.labelViewport, 'wheel', event => {
      event.preventDefault(); this._scrollToY(this._offsetY() + event.deltaY * (event.deltaMode === 1 ? ROW_HEIGHT : 1));
    }, {passive: false});
    this._on(editor, 'change', event => {
      const {kind, structural, timing, layers, animation, layerSelection} = event.detail ?? {};
      if (kind === 'document' || kind === 'history' || structural) this._connectedGroups = null;
      if (structural && !layers && !animation) this._figureNameIndex = null;
      if (layerSelection && this.channelMode) { this.selectedTrackId = this.editor.activeLayerId; this._fullDirty = true; }
      if (kind === 'document' || structural || layers || (timing && this.channelMode) || (animation && this.mode !== 'frames')) { this._reindex(); this.resize(); }
      else if (timing) { this.exposures = editor.timeline; this.resize(); this._fullDirty = true; this._notifyLoopRange(); }
      if (event.detail?.insertedFrameIndices?.length) this._setSelectedFrames(event.detail.insertedFrameIndices, editor.frameIndex);
      this.update();
    });
    this._observer = new ResizeObserver(() => this.resize());
    this._observer.observe(this.root);
    this._reindex();
    this.resize();
    this.update();
  }

  _on(target, name, listener, options) {
    target.addEventListener(name, listener, options);
    this._listeners.push(() => target.removeEventListener(name, listener, options));
  }

  _buildNavigator() {
    this.nav = element('div', 'styk-timeline-nav', this.root);
    this.nav.setAttribute('aria-label', 'Timeline navigation');
    this.navModes = element('div', 'styk-timeline-nav-modes', this.nav);
    this.modeButtons = new Map();
    const button = (parent, text, title, action, className = '') => {
      const node = element('button', className, parent); node.type = 'button'; node.textContent = text;
      node.title = title; node.setAttribute('aria-label', title);
      this._on(node, 'click', event => { event.stopPropagation(); action(); this.scroll.focus({preventScroll: true}); });
      return node;
    };
    for (const [mode, label] of this.actionMode ? [] : [['tracks', 'Layers'], ['frames', 'Frames']]) {
      const node = button(this.navModes, label, mode === 'tracks' ? 'Edit layer and property keys' : 'Edit whole animation frames', () => this.setMode(mode));
      node.setAttribute('aria-label', label); this.modeButtons.set(mode, node);
    }
    if (this.actionMode) { this.navModes.textContent = 'Drag keys to move'; this.navModes.title = 'Drag keys to move or replace · Drag empty space to box select · Alt+drag to copy · Shift+wheel to pan · Ctrl+wheel to zoom'; }
    button(this.nav, '‹', 'Previous keyframe · Alt+,', () => this._keyDown({key:'PageUp',preventDefault(){},stopPropagation(){}}));
    const position = element('label', '', this.nav); position.append('Frame');
    this.frameInput = element('input', '', position); this.frameInput.type = 'number'; this.frameInput.min = '1'; this.frameInput.step = '1';
    this.frameInput.setAttribute('aria-label', 'Go to frame');
    this._on(this.frameInput, 'change', () => {
      const frame = Number(this.frameInput.value);
      if (Number.isInteger(frame) && frame >= 1) { this.onSeek?.(); this.editor.seek(frame - 1, {allowBeyondEnd: this.channelMode}); this.revealPlayhead(); }
      this.frameInput.value = String(Math.floor(this.editor.tick) + 1);
    });
    this._on(this.frameInput, 'keydown', event => { event.stopPropagation(); if (event.key === 'Enter') { this.frameInput.blur(); this.scroll.focus(); } });
    button(this.nav, '›', 'Next keyframe · Alt+.', () => this._keyDown({key:'PageDown',preventDefault(){},stopPropagation(){}}));
    this.followButton = button(this.nav, 'Follow', 'Follow playhead', () => { this.followPlayhead = !this.followPlayhead; this.followButton.setAttribute('aria-pressed', String(this.followPlayhead)); if (this.followPlayhead) this.revealPlayhead(); }, 'styk-timeline-nav-follow');
    this.followButton.hidden = this.actionMode;
    this.followButton.setAttribute('aria-pressed', 'true');
    const zoom = element('div', 'styk-timeline-nav-zoom', this.nav);
    if (!this.actionMode) button(zoom, '−', 'Zoom out', () => this.setZoom(this.pxPerTick / 1.25));
    this.zoomInput = element('input', '', zoom); this.zoomInput.type = 'range'; this.zoomInput.min = '1'; this.zoomInput.max = '64'; this.zoomInput.value = '18';
    this.zoomInput.setAttribute('aria-label', 'Frame cell width');
    this._on(this.zoomInput, 'input', () => this.setZoom(Number(this.zoomInput.value)));
    this._on(this.zoomInput, 'keydown', event => event.stopPropagation());
    if (!this.actionMode) button(zoom, '+', 'Zoom in', () => this.setZoom(this.pxPerTick * 1.25));
    button(zoom, 'Fit', 'Fit entire animation', () => { this.setZoom((this.width - LEAD - 16) / Math.max(1, this.editor.totalTicks)); this._scrollToX(0); });
  }

  revealPlayhead() {
    this._scrollToX(Math.max(0, LEAD + (this.editor.tick + .5) * this.pxPerTick - this.width / 2));
  }

  _buildToolbar() {
    this.editbar = element('div', 'styk-timeline-editbar', this.root);
    const position = element('div', 'styk-timeline-key-position', this.editbar);
    const title = element('span', '', position); title.textContent = 'Key';
    this.keyCounter = element('strong', '', position);
    this.keyTotal = element('span', '', position);
    this.rangeCounter = element('span', 'styk-timeline-range-count', position);
    this.tools = element('div', 'styk-timeline-tools', this.editbar);
    this.tools.setAttribute('role', 'toolbar'); this.tools.setAttribute('aria-label', 'Keyframe editing');
    this.actionButtons = new Map();
    for (const [command, action, icon, label, tooltip, method] of [
      ['addKeyframe', 'add-frame', 'add', 'Keyframe', 'Add keyframe · F6', 'addFrame'],
      ['extendFrame', 'extend-frame', 'timing', 'Extend', 'Extend selected frames · F5', 'setFramesDuration'],
      ['insertBlankKeyframe', 'blank-frame', 'blank', 'Blank', 'Insert blank keyframe · F7', 'insertBlankFrame'],
      ['showTimingDialog', 'frame-timing', 'timing', 'Timing', 'Edit selected keyframe timing', 'setFramesDuration'],
      ['duplicateSelection', 'duplicate-frames', 'duplicate', '', 'Duplicate selected keyframes · Ctrl/Cmd+D', 'duplicateFrames'],
      ['deleteSelection', 'delete-frame', 'delete', '', 'Delete selected keyframes · Delete', 'deleteFrames'],
      ['menu', 'keyframe-menu', 'more', '', 'More keyframe actions', null],
    ]) {
      if (command === 'duplicateSelection') element('div', 'styk-timeline-tool-divider', this.tools);
      const button = element('button', '', this.tools);
      button.type = 'button'; button.dataset.action = action; button.title = tooltip;
      button.setAttribute('aria-label', tooltip.split(' · ')[0]);
      button.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOOL_ICONS[icon]}</svg>`;
      if (label) { const text = element('span', '', button); text.textContent = label; }
      if (command === 'menu') { button.setAttribute('aria-haspopup', 'menu'); this.moreButton = button; }
      this.actionButtons.set(command, {button, method});
      this._on(button, 'click', event => {
        event.preventDefault(); event.stopPropagation();
        if (command === 'menu') {
          const bounds = button.getBoundingClientRect();
          this._contextMenu({clientX: bounds.left, clientY: bounds.bottom + 3, preventDefault() {}, stopPropagation() {}}, true);
        } else {
          this.onSeek?.(this.editor.tick, this.editor.frameIndex);
          this._runCommand(command);
          if (!this.dialog?.open) this.scroll.focus({preventScroll: true});
        }
      });
    }
    this.framePosition = element('span', 'styk-timeline-frame-position', this.editbar);
  }

  _updateToolbar() {
    if (this.frameInput) {
      if (document.activeElement !== this.frameInput) this.frameInput.value = String(Math.floor(this.editor.tick) + 1);
      this.frameInput.max = String(this.channelMode ? 10000001 : Math.max(1, this.editor.totalTicks));
      for (const [mode, button] of this.modeButtons) button.setAttribute('aria-pressed', String((mode === 'tracks') === this.channelMode));
    }
    if (this.channelMode) return this._updateChannelToolbar();
    const selected = this._selectionCount();
    const hidden = this.editor.timeline[this.editor.frameIndex]?.count === 0;
    const key = String(this.editor.frameIndex + 1), total = `/ ${this.editor.timeline.length}${hidden ? ' · hidden' : ''}`;
    const frame = `${Math.floor(this.editor.tick) + 1} / ${this.editor.totalTicks} fr`;
    if (this.keyCounter.textContent !== key) this.keyCounter.textContent = key;
    if (this.keyTotal.textContent !== total) this.keyTotal.textContent = total;
    if (this.framePosition.textContent !== frame) this.framePosition.textContent = frame;
    this.rangeCounter.hidden = selected === 1;
    const selection = `${selected} selected`;
    if (this.rangeCounter.textContent !== selection) this.rangeCounter.textContent = selection;
    for (const [command, {button, method}] of this.actionButtons) {
      const needsSelection = ['extendFrame', 'showTimingDialog', 'duplicateSelection', 'deleteSelection'].includes(command);
      button.disabled = Boolean(method && typeof this.editor[method] !== 'function') || (needsSelection && selected === 0);
    }
  }

  _reindex() {
    const documentChanged = this.report !== this.editor.report;
    const frameCountChanged = this.exposures?.length !== this.editor.timeline.length;
    this.report = this.editor.report;
    this.exposures = this.editor.timeline;
    this.channelMode = this.mode !== 'frames' && Array.isArray(this.editor.layers) && Array.isArray(this.editor.animationChannels);
    this.root.classList.toggle('styk-timeline-channels', this.channelMode);
    if (this.channelMode) {
      if (documentChanged) this._figureNameIndex = this.editor._loadedFigureNames ?? null;
      const sourceCount = Object.keys(this.report._styk?.frameSources ?? {}).length;
      if (documentChanged || !this._connectedGroups || sourceCount !== this._connectedSourceCount) {
        this._connectedGroups = connectedTimelineGroups(this.report); this._connectedSourceCount = sourceCount;
      }
      this._channelDescriptors = new Map(this.editor.animationChannels.map(channel => [channel.id, channel]));
      const layers = [...this.editor.layers.filter(layer => layer.kind !== 'layer'), ...this.editor.layers.filter(layer => layer.kind === 'layer').reverse()];
      const projection = buildChannelTimelineTracks(layers, this.editor.animationChannels, this.report, this.expandedTracks, {
        figurePoses: this.actionMode,
        connectedGroups: this._connectedGroups,
        figureNames: this._figureNameIndex,
        nativePoseChannel: this.editor.nativePoseChannel ? target => { const channel = this.editor.nativePoseChannel(target); this._channelDescriptors.set(channel.id, channel); return channel; } : null,
      });
      this._figureNameIndex = projection.figureNames;
      this.tracks = projection.tracks; this.trackById = projection.byId;
      this.assemblyByUid = projection.assemblyByUid;
      if (this.actionMode) this._filterActionTracks();
      if (documentChanged) this._animationSelection.clear();
      if (this.actionMode) { if (!this.tracks.some(track=>track.id===this.selectedTrackId)) this.selectedTrackId=this.tracks[0]?.id; }
      else if (!this.trackById.has(this.selectedTrackId)) this.selectedTrackId = this.editor.activeLayerId ?? this.tracks.find(track => track.kind === 'layer')?.id ?? 'scene';
      this._buildChannelToolbar();
    } else {
      this.tracks = documentChanged && this.editor._loadedTimelineTracks ? this.editor._loadedTimelineTracks : buildTimelineTracks(this.report);
      if (this.channelTools) { this.channelTools.hidden = true; this.tools.hidden = false; this.addLayerButton.hidden = true; }
    }
    this.trackIndices = new Map(this.tracks.map((track, index) => [track.uid, index]));
    this.count.textContent = String(this.actionMode ? this.tracks.filter(track=>track.depth===0).length : this.channelMode ? this.editor.layers.filter(layer => layer.kind === 'layer').length : this.tracks.length).padStart(2, '0');
    if (documentChanged || frameCountChanged) {
      this._rangeAnchor = this._rangeFocus = null;
      this._selectionSet = this._selectionList = this._selectionRuns = null;
    }
    if (documentChanged || frameCountChanged) this._loopFrames = null;
    if (documentChanged) { this.scroll.scrollLeft = 0; this.scroll.scrollTop = 0; }
    this._extent();
    this._fullDirty = this._headDirty = true;
    this._notifyLoopRange();
  }

  _filterActionTracks() {
    const fixed = ['camera','scene'].includes(this.externalTrack) ? this.externalTrack : null;
    const ids = fixed ? [fixed] : [...new Set([...(this.editor.selectedUids ?? [])].map(uid => this.assemblyByUid?.get(uid)?.id ?? `figure:${uid}`))];
    const signature=ids.join('|');
    if (signature !== this._actionSignature) { this._animationSelection.clear(); this._focusedTrackKey=null; this._keyAnchor=null; this._actionSignature=signature; }
    const tracks=[];
    const visit = (root, depth = 0, parentId = null) => {
      root.depth=depth;root.parentId=parentId;tracks.push(root);
      if(root.kind==='assembly') {
        if(this.expandedTracks.has(root.id))for(const child of root.children)visit(child,depth+1,root.id);
        return;
      }
      if(this.collapsedActions.has(root.id))return;
      for(const child of root.channelChildren ?? [])if(child.property==='pose'||child.keys.length){child.depth=depth+1;tracks.push(child);}
      if(root.kind==='figure'){
        const segments=new Set(this.editor.animationChannels.filter(c=>c.target.kind==='segment'&&c.target.uid===root.uid).map(c=>targetTrackId(c.target)));
        for(const sid of segments){const segment=this.trackById.get(sid);if(!segment)continue;segment.depth=depth+1;tracks.push(segment);
          if(!this.collapsedActions.has(sid))for(const child of segment.channelChildren)if(child.keys.length){child.depth=depth+2;tracks.push(child);}}
      }
    };
    for(const id of ids){const root=this.trackById.get(id);if(root)visit(root);}
    this.tracks=tracks;
    this.count.textContent=String(tracks.filter(track=>track.depth===0).length).padStart(2,'0');
    if(!tracks.some(track=>track.id===this.selectedTrackId))this.selectedTrackId=tracks[0]?.id;
  }

  _rangeBounds() {
    if (this._selectionList?.length) return [this._selectionList[0], this._selectionList.at(-1)];
    const last = Math.max(0, this.editor.timeline.length - 1);
    const anchor = clamp(this._rangeAnchor ?? this.editor.frameIndex, 0, last);
    const focus = clamp(this._rangeFocus ?? this.editor.frameIndex, 0, last);
    return [Math.min(anchor, focus), Math.max(anchor, focus)];
  }

  /** Stored keyframe indices: exposure holds are deliberately selected as a unit. */
  get selectedFrameIndices() {
    if (this._selectionList !== null) return this._selectionList.slice();
    const [first, last] = this._rangeBounds();
    return Array.from({length: last - first + 1}, (_, index) => first + index);
  }

  _selectionCount() {
    if (this._selectionList !== null) return this._selectionList.length;
    const [first, last] = this._rangeBounds();
    return last - first + 1;
  }

  _hasSelectedFrame(index) {
    if (this._selectionSet !== null) return this._selectionSet.has(index);
    const [first, last] = this._rangeBounds();
    return index >= first && index <= last;
  }

  _selectionChanged() {
    this._fullDirty = true; this._updateToolbar();
    const count = this._selectionCount();
    if (this._dragging) this._rangeNotificationPending = true;
    else this.onRangeChange?.(this.selectedFrameIndices);
    this.live.textContent = count === 0 ? 'No keyframes selected' : count > 1 ? `${count} keyframes selected` : `Keyframe ${this.selectedFrameIndices[0] + 1} selected`;
    this._schedule();
  }

  _toggleFrame(index, base = this.selectedFrameIndices) {
    const selected = new Set(base);
    if (selected.has(index)) selected.delete(index); else selected.add(index);
    this._setSelectedFrames(selected, index);
  }

  _setSelectedFrames(indices, focus) {
    this._selectionSet = new Set(indices);
    this._selectionList = [...this._selectionSet].sort((a, b) => a - b);
    this._selectionRuns = [];
    for (const key of this._selectionList) {
      const previous = this._selectionRuns.at(-1);
      if (previous && key === previous.last + 1) previous.last = key;
      else this._selectionRuns.push({first: key, last: key});
    }
    this._rangeAnchor = this._rangeFocus = focus ?? this._selectionList.at(-1) ?? this.editor.frameIndex;
    this._selectionChanged();
  }

  _visibleSelectionSpans(firstTick, lastTick, sx, step) {
    if (this._rangeAnchor === null && this._selectionList === null) return [];
    const bounds = this._rangeBounds();
    const runs = this._selectionRuns ?? [{first: bounds[0], last: bounds[1]}];
    let low = 0, high = runs.length;
    while (low < high) {
      const middle = (low + high) >>> 1, end = this.exposures[runs[middle].last];
      if (!end || end.start + end.count <= firstTick) low = middle + 1; else high = middle;
    }
    const spans = [];
    for (let i = low; i < runs.length; i++) {
      const start = this.exposures[runs[i].first], end = this.exposures[runs[i].last];
      if (!start || !end || start.start > lastTick) break;
      if (end.start + end.count <= start.start) continue;
      spans.push({start: LEAD + start.start * step - sx, end: LEAD + (end.start + end.count) * step - sx});
    }
    return spans;
  }

  selectAll() {
    this._selectionSet = this._selectionList = this._selectionRuns = null;
    this._rangeAnchor = 0; this._rangeFocus = this.exposures.length - 1;
    this._selectionChanged();
  }

  /** Playback end is exclusive; markers follow duration edits to their keyframes. */
  get loopRange() {
    if (!this._loopFrames) return null;
    const first = this.editor.timeline[this._loopFrames.first], last = this.editor.timeline[this._loopFrames.last];
    if (!first || !last || last.start + last.count <= first.start) return null;
    return {startTick: first.start, endTick: last.start + last.count};
  }

  _notifyLoopRange() {
    const range = this.loopRange;
    const signature = range ? `${range.startTick}:${range.endTick}` : '';
    if (signature === this._lastLoopSignature) return;
    this._lastLoopSignature = signature;
    this.onLoopRangeChange?.(range);
  }

  setLoopToSelection() {
    if (!this._selectionCount()) throw new Error('Select a keyframe range to loop.');
    if (this._selectionRuns?.length > 1) throw new Error('Select one continuous keyframe range to loop.');
    const [first, last] = this._rangeBounds();
    const start = this.exposures[first]?.start ?? 0, end = this.exposures[last];
    if (!end || end.start + end.count <= start) throw new Error('Select at least one visible frame to loop.');
    this._loopFrames = {first, last};
    this._fullDirty = true;
    this._updateToolbar();
    this._notifyLoopRange(); this._schedule();
    this.live.textContent = `Loop from frame ${start + 1} to ${end.start + end.count}`;
    return this.loopRange;
  }

  clearLoopRange() {
    this._loopFrames = null;
    this._fullDirty = true;
    this._notifyLoopRange(); this._schedule();
    this.live.textContent = 'Playback range cleared';
  }

  _setRange(index, extend = false, anchor = this.editor.frameIndex) {
    const last = Math.max(0, this.editor.timeline.length - 1);
    const focus = clamp(index, 0, last);
    const nextAnchor = extend ? (this._rangeAnchor ?? clamp(anchor, 0, last)) : focus;
    if (nextAnchor === this._rangeAnchor && focus === this._rangeFocus && this._selectionList === null) return;
    this._rangeAnchor = nextAnchor;
    this._rangeFocus = focus;
    this._selectionSet = this._selectionList = this._selectionRuns = null;
    this._selectionChanged();
  }

  _clipboardOperation(kind,execute) {return this.runClipboardOperation?this.runClipboardOperation(kind,execute):execute({});}
  copySelection() {
    if(!this._selectionCount())return 0;
    const indices=this.selectedFrameIndices;
    return this.editor._frameClipboardWorker?this._clipboardOperation('copy',options=>this.editor.copyFramesAsync(indices,options)):this.editor.copyFrames?.(indices)??0;
  }

  addKeyframe() {
    const result = this.editor.addFrame();
    this._setRange(this.editor.frameIndex);
    this.onSeek?.(this.editor.tick, this.editor.frameIndex);
    return result;
  }

  extendFrame() {
    const indices = this.selectedFrameIndices;
    if (!indices.length) return false;
    const changes=indices.filter(index=>this.report.keyframes[index].duration_raw<65535)
      .map(index=>({index,ticks:(this.report.keyframes[index].duration_raw??1)+1}));
    return Boolean(this.editor._setFrameDurations(changes,{label:'Extend frames',retainSelection:true}));
  }

  cutSelection() {
    if (!this._selectionCount()) return 0;
    if(this.editor._frameClipboardWorker){const indices=this.selectedFrameIndices,token=this.editor._documentToken;
      return Promise.resolve(this._clipboardOperation('cut',options=>this.editor.cutFramesAsync(indices,options))).then(count=>{
        if(!this.disposed&&token===this.editor._documentToken)this._setRange(this.editor.frameIndex);return count;
      });}
    const result = this.editor.cutFrames?.(this.selectedFrameIndices) ?? 0;
    this._setRange(this.editor.frameIndex);
    return result;
  }

  pasteSelection() {
    const after = this.editor.frameIndex + 1;
    if(this.editor._frameClipboardWorker){const token=this.editor._documentToken;
      return Promise.resolve(this._clipboardOperation('paste',options=>this.editor.pasteFramesAsync(after,options))).then(count=>{
        if(count>0&&!this.disposed&&token===this.editor._documentToken){const first=this.editor.frameIndex;this._setRange(first);this._setRange(first+count-1,true);}return count;
      });}
    const result = this.editor.pasteFrames?.(after) ?? 0;
    // Legacy destination conversion can expand existing held keys. Select only
    // the actual pasted range, whose first key is now the editor's current frame.
    if (result > 0) { const first = this.editor.frameIndex; this._setRange(first); this._setRange(first + result - 1, true); }
    return result;
  }

  reverseSelection() { return this.editor.reverseFrames?.(this.selectedFrameIndices) ?? false; }

  requestInsertInbetween() {
    const indices = this.channelMode ? [this.editor.frameIndex] : this.selectedFrameIndices;
    if (!indices.some(index => index > 0) || !this.onInsertInbetween) return false;
    this.onSeek?.(this.editor.tick, this.editor.frameIndex);
    return this.onInsertInbetween(indices);
  }

  setSelectionDuration(ticks) {
    if (!Number.isInteger(ticks) || ticks < 0 || ticks > 65535) throw new Error('Duration must be a whole number from 0 to 65,535.');
    if (!this._selectionCount()) return 0;
    const result = this.editor.setFramesDuration(this.selectedFrameIndices, ticks);
    this.live.textContent = `Selected keyframes now last ${ticks} frame${ticks === 1 ? '' : 's'} each`;
    return result;
  }

  duplicateSelection() {
    if (!this._selectionCount()) return 0;
    const [, last] = this._rangeBounds(), after = last + 1;
    const count = this.editor.duplicateFrames(this.selectedFrameIndices);
    if (count > 0) { this._setRange(after); this._setRange(after + count - 1, true); }
    return count;
  }

  insertBlankKeyframe() {
    const index = this.editor.insertBlankFrame(this.editor.frameIndex + 1);
    this._setRange(index);
    this.onSeek?.(this.editor.tick, this.editor.frameIndex);
    return index;
  }

  bakeSelection() {
    if (!this._selectionCount()) return 0;
    return this._bakeIndices(this.selectedFrameIndices);
  }

  _bakeIndices(indices) {
    const planned = indices.map(index => ({index,
      count: this.editor.report.keyframes[index].duration_raw !== 1 && this.exposures[index].count > 0 ? this.exposures[index].count : 1}));
    const count = this.editor.bakeFrames(indices);
    if (count > 0) {
      // Allocate output selection only after the model validates baking limits.
      const output = [];
      let offset = 0;
      for (const item of planned) {
        for (let key = 0; key < item.count; key++) output.push(item.index + offset + key);
        offset += item.count - 1;
      }
      this._setSelectedFrames(output);
    }
    return count;
  }

  deleteSelection() {
    if (!this._selectionCount()) return 0;
    const result = this.editor.deleteFrames?.(this.selectedFrameIndices) ?? false;
    this._setRange(this.editor.frameIndex);
    return result;
  }

  _runCommand(name) {
    const failed=error=>{if(error.name==='AbortError')return false;this.live.textContent=error.message;this.onError?.(error);return false;};
    try {
      const result = this[name]();
      if(result?.then)return result.then(value=>{if(name==='copySelection')this.live.textContent=`${value} keyframes copied`;return value;},failed);
      if (name === 'copySelection') this.live.textContent = `${result} keyframes copied`;
      return result;
    } catch (error) {
      return failed(error);
    }
  }

  _extent() {
    const ticks = this.channelMode ? Math.max(this.editor.totalTicks + 120, this.editor.tick + 120, this._navigationEnd || 0) : this.editor.totalTicks;
    this.logicalWidth = Math.max(this.width || 0, LEAD + Math.max(1, ticks) * this.pxPerTick + TAIL);
    this.logicalHeight = Math.max(this.height || 0, RULER_HEIGHT + Math.max(1, this.tracks.length) * ROW_HEIGHT);
    this.spacer.style.width = `${Math.min(MAX_SCROLL, this.logicalWidth)}px`;
    this.spacer.style.height = `${Math.min(MAX_SCROLL, this.logicalHeight)}px`;
    this.scroll.setAttribute('aria-valuemax', String(Math.max(1, this.editor.totalTicks)));
  }

  _offsetX() {
    const actual = this.scroll.scrollWidth - this.scroll.clientWidth;
    return actual > 0 ? this.scroll.scrollLeft / actual * Math.max(0, this.logicalWidth - this.width) : 0;
  }

  _offsetY() {
    const actual = this.scroll.scrollHeight - this.scroll.clientHeight;
    return actual > 0 ? this.scroll.scrollTop / actual * Math.max(0, this.logicalHeight - this.height) : 0;
  }

  _scrollToX(logical) {
    if (this.channelMode && logical + this.width >= this.logicalWidth - this.width / 2) {
      this._navigationEnd = Math.min(10000001, Math.ceil((logical + this.width * 2) / this.pxPerTick));
      this._extent();
    }
    const maximum = Math.max(0, this.logicalWidth - this.width);
    this.scroll.scrollLeft = maximum > 0 ? clamp(logical, 0, maximum) / maximum * (this.scroll.scrollWidth - this.scroll.clientWidth) : 0;
  }

  _scrollToY(logical) {
    const maximum = Math.max(0, this.logicalHeight - this.height);
    this.scroll.scrollTop = maximum > 0 ? clamp(logical, 0, maximum) / maximum * (this.scroll.scrollHeight - this.scroll.clientHeight) : 0;
  }

  resize() {
    if (this._destroyed) return;
    const available = this.root.clientWidth;
    const maximumLabelWidth = Math.max(112, Math.min(360, available - 160));
    this.labelWidth = clamp(this._labelWidthOverride ?? LABEL_WIDTH, Math.min(128, maximumLabelWidth), maximumLabelWidth);
    this.root.style.setProperty('--timeline-label-width', `${this.labelWidth}px`);
    this.columnDivider.setAttribute('aria-valuemin', String(Math.min(128, maximumLabelWidth)));
    this.columnDivider.setAttribute('aria-valuenow', String(Math.round(this.labelWidth)));
    this.columnDivider.setAttribute('aria-valuemax', String(maximumLabelWidth));
    this.width = this.scroll.clientWidth;
    this.height = this.scroll.clientHeight;
    this._extent();
    // Adding a scrollbar can change the viewport; read its final inner size.
    this.width = this.scroll.clientWidth;
    this.height = this.scroll.clientHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (const canvas of [this.gridCanvas, this.headCanvas]) {
      const width = Math.max(1, Math.round(this.width * this.dpr)), height = Math.max(1, Math.round(this.height * this.dpr));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      canvas.style.width = `${this.width}px`; canvas.style.height = `${this.height}px`;
    }
    this.labelViewport.style.bottom = `${Math.max(0, this.root.clientHeight - TOOLBAR_HEIGHT - this.height)}px`;
    this._fullDirty = this._headDirty = true;
    this._schedule();
  }

  setLabelWidth(pixels) {
    if (!Number.isFinite(pixels) || this._destroyed) return;
    this._labelWidthOverride = pixels;
    this.resize();
  }

  /** Safe to call after every editor update; posing and playback reuse the grid. */
  update() {
    if (this._destroyed) return;
    if (this.report !== this.editor.report) this._reindex();
    else if (this.exposures !== this.editor.timeline) {
      this.exposures = this.editor.timeline; this.resize(); this._fullDirty = true;
    }
    if (this.actionMode && this.channelMode) {
      const ids = ['camera','scene'].includes(this.externalTrack) ? this.externalTrack : [...new Set([...(this.editor.selectedUids ?? [])].map(uid=>this.assemblyByUid?.get(uid)?.id ?? `figure:${uid}`))].join('|');
      if(ids!==this._actionSignature){this._filterActionTracks();this.resize();this._fullDirty=true;}
    }
    if (this.selectedUid !== this.editor.selectedUid) {
      this.selectedUid = this.editor.selectedUid;
      this._fullDirty = true;
    }
    if (this.tick !== this.editor.tick) {
      this.tick = this.editor.tick;
      this._headDirty = true;
      this.scroll.setAttribute('aria-valuenow', String(this.tick + 1));
      this.scroll.setAttribute('aria-valuetext', `Frame ${this.tick + 1} of ${Math.max(1, this.editor.totalTicks)}`);
      // Page along with playback or keyboard seeks, without disturbing a scrub.
      if (this.followPlayhead && !this._dragging && this.width > 0) {
        const x = LEAD + (this.tick + 0.5) * this.pxPerTick;
        const offset = this._offsetX();
        if (x < offset + 5 || x > offset + this.width - 12) this._scrollToX(Math.max(0, x - this.width * 0.2));
      }
    }
    this._updateToolbar();
    this._schedule();
  }

  setZoom(pxPerTick, pointerX) {
    if (!Number.isFinite(pxPerTick) || this._destroyed) return;
    const next = clamp(pxPerTick, 1e-12, 64);
    if (next === this.pxPerTick) return;
    const old = this.pxPerTick, offset = this._offsetX();
    const anchor = pointerX ?? LEAD + (this.editor.tick + 0.5) * old - offset;
    const anchorTick = (anchor + offset - LEAD) / old;
    this.pxPerTick = next;
    this.zoomInput.value = String(next);
    this.resize();
    this._scrollToX(LEAD + anchorTick * next - anchor);
    this._fullDirty = this._headDirty = true;
    this._schedule();
  }

  _schedule() {
    if (this._raf || this._destroyed || (!this._fullDirty && !this._headDirty)) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      if (this._destroyed || this.width < 1 || this.height < 1) return;
      if (this._fullDirty) { this._drawGrid(); this._drawLabels(); }
      if (this._headDirty || this._fullDirty) this._drawHead();
      this._fullDirty = this._headDirty = false;
    });
  }

  _drawGrid() {
    if (this.channelMode) return this._drawChannelGrid();
    const ctx = this.gridContext, w = this.width, h = this.height;
    const sx = this._offsetX(), sy = this._offsetY(), step = this.pxPerTick;
    const firstTick = Math.max(0, Math.floor((sx - LEAD) / step));
    const lastTick = Math.min(this.editor.totalTicks, Math.ceil((sx + w - LEAD) / step));
    const firstRow = Math.max(0, Math.floor(sy / ROW_HEIGHT));
    const lastRow = Math.min(this.tracks.length, Math.ceil((sy + h - RULER_HEIGHT) / ROW_HEIGHT));
    const hasSelection = this._rangeAnchor !== null || this._selectionList !== null;
    const selectionSpans = this._visibleSelectionSpans(firstTick, lastTick, sx, step);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#fafafa'; ctx.fillRect(0, 0, w, h);
    ctx.save(); ctx.beginPath(); ctx.rect(0, RULER_HEIGHT, w, h - RULER_HEIGHT); ctx.clip();
    const endX = LEAD + this.editor.totalTicks * step - sx;
    const bodyBottom = Math.min(h, Math.max(RULER_HEIGHT, RULER_HEIGHT + this.tracks.length * ROW_HEIGHT - sy));
    ctx.fillStyle = '#fff'; ctx.fillRect(0, RULER_HEIGHT, Math.max(0, endX), bodyBottom - RULER_HEIGHT);
    for (let row = firstRow; row < lastRow; row++) {
      const track = this.tracks[row], y = RULER_HEIGHT + row * ROW_HEIGHT - sy;
      const selected = track.uid === this.editor.selectedUid;
      if (row % 2) { ctx.fillStyle = '#fcfcfc'; ctx.fillRect(0, y, w, ROW_HEIGHT); }
      if (selected) { ctx.fillStyle = '#f2f9ff'; ctx.fillRect(0, y, w, ROW_HEIGHT); }
      for (const span of selectionSpans) {
        ctx.fillStyle = '#e5f4ff'; ctx.fillRect(Math.max(0, span.start), y, Math.min(w, span.end) - Math.max(0, span.start), ROW_HEIGHT);
      }
      let key = firstVisibleKey(track.frames, this.exposures, firstTick);
      for (; key < track.frames.length; key++) {
        const entry = this.exposures[track.frames[key]];
        if (!entry || !entry.count) continue;
        if (entry.start > lastTick) break;
        const start = LEAD + entry.start * step - sx, length = entry.count * step;
        const left = Math.max(-1, start), right = Math.min(w + 1, start + length);
        if (right <= left) continue;
        const inRange = hasSelection && this._hasSelectedFrame(entry.index);
        ctx.fillStyle = inRange ? '#b8dfff' : selected ? '#dfedfa' : '#e6e6e6';
        ctx.fillRect(left + 1, y + 3, right - left - 2, ROW_HEIGHT - 6);
        const mark = start + step * 0.5;
        ctx.fillStyle = selected || inRange ? '#087ed2' : '#666';
        if (mark >= -5 && mark <= w + 5) diamond(ctx, mark, y + ROW_HEIGHT / 2, step < 9 ? 2.3 : 3.3);
        if (entry.count > 1 && step >= 8) {
          ctx.fillStyle = selected || inRange ? '#82b4d8' : '#aaa';
          const lineLeft = Math.max(0, mark + 6), lineRight = Math.min(w, start + length - 6);
          if (lineRight > lineLeft) ctx.fillRect(lineLeft, y + ROW_HEIGHT / 2, lineRight - lineLeft, 1);
        }
      }
      ctx.fillStyle = '#dcdcdc'; ctx.fillRect(0, y + ROW_HEIGHT - 1, w, 1);
    }
    const major = rulerInterval(step), minor = step >= 4 ? 1 : major;
    // Major time divisions organize the rows without a dense empty-cell grid.
    for (let tick = Math.max(0, Math.floor(firstTick / major) * major); tick <= Math.ceil((sx + w - LEAD) / step); tick += major) {
      const x = Math.round(LEAD + tick * step - sx) + 0.5;
      ctx.fillStyle = '#d7d7d7';
      ctx.fillRect(x, RULER_HEIGHT, 1, bodyBottom - RULER_HEIGHT);
    }
    if (endX >= 0 && endX <= w) { ctx.fillStyle = '#aaa'; ctx.fillRect(Math.round(endX) + 0.5, RULER_HEIGHT, 1, bodyBottom - RULER_HEIGHT); }
    ctx.restore();
    ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0, 0, w, RULER_HEIGHT);
    ctx.fillStyle = '#d8d8d8'; ctx.fillRect(0, RULER_HEIGHT - 1, w, 1);
    for (const span of selectionSpans) {
      ctx.fillStyle = '#e5f4ff'; ctx.fillRect(Math.max(0, span.start), 0, Math.min(w, span.end) - Math.max(0, span.start), RULER_HEIGHT - 1);
      ctx.fillStyle = ACCENT; ctx.fillRect(Math.max(0, span.start), RULER_HEIGHT - 2, Math.min(w, span.end) - Math.max(0, span.start), 2);
    }
    ctx.font = "11px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let tick = Math.floor(firstTick / minor) * minor + (minor > 1 ? minor - 1 : 0); tick <= Math.ceil((sx + w - LEAD) / step); tick += minor) {
      const x = LEAD + (tick + 0.5) * step - sx;
      const numbered = tick === 0 || (tick + 1) % major === 0;
      ctx.fillStyle = numbered ? '#aaa' : '#ccc'; ctx.fillRect(Math.round(x), RULER_HEIGHT - (numbered ? 6 : 3), 1, numbered ? 5 : 2);
      if (numbered) { ctx.fillStyle = tick < this.editor.totalTicks ? '#555' : '#aaa'; ctx.fillText(String(tick + 1), x, 12); }
    }
    const loop = this.loopRange;
    if (loop) {
      const start = LEAD + loop.startTick * step - sx, end = LEAD + loop.endTick * step - sx;
      if (end > 0 && start < w) {
        ctx.fillStyle = '#7ac7ff'; ctx.fillRect(Math.max(0, start), 2, Math.min(w, end) - Math.max(0, start), 2);
        ctx.fillStyle = ACCENT;
        for (const [x, direction] of [[start, 1], [end, -1]]) {
          if (x < -7 || x > w + 7) continue;
          ctx.beginPath(); ctx.moveTo(x, 1); ctx.lineTo(x + direction * 7, 1); ctx.lineTo(x, 9); ctx.closePath(); ctx.fill();
        }
      }
    }
  }

  _drawLabels() {
    if (this.channelMode) return this._drawChannelLabels();
    if (this._labelMode !== 'frames') {
      for (const node of this.labels) node.remove(); this.labels = []; this._labelMode = 'frames';
      this.labelViewport.setAttribute('role', 'listbox'); this.labelViewport.setAttribute('aria-label', 'Animation layers');
    }
    const sy = this._offsetY();
    const first = Math.max(0, Math.floor(sy / ROW_HEIGHT));
    const visible = Math.max(0, Math.min(this.tracks.length - first, Math.ceil((this.height - RULER_HEIGHT) / ROW_HEIGHT) + 1));
    for (let slot = 0; slot < visible; slot++) {
      let node = this.labels[slot];
      if (!node) {
        node = element('button', 'styk-timeline-label', this.labelViewport);
        node.type = 'button'; node.tabIndex = -1; node.setAttribute('role', 'option');
        node.innerHTML = '<svg class="styk-timeline-label-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m8 2 6 3.5-6 3.5-6-3.5L8 2Zm-6 6L8 11.5 14 8M2 11l6 3.5 6-3.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="styk-timeline-label-name"></span><span class="styk-timeline-label-id"></span>';
        this._on(node, 'click', () => {
          const track = this.tracks[node._trackIndex];
          if (!track) return;
          // A layer absent at this time opens at its first appearance.
          const current = this.editor.frame?.objects?.some(object => object.unique_id === track.uid);
          if (!current) {
            this.editor.selectFrame(track.frames[0]);
            this.onSeek?.(this.editor.tick, this.editor.frameIndex);
          }
          this._selectTrack(track);
          this.scroll.focus({preventScroll: true});
        });
        this.labels.push(node);
      }
      const index = first + slot, track = this.tracks[index];
      node.hidden = false; node._trackIndex = index;
      node.style.transform = `translateY(${index * ROW_HEIGHT - sy}px)`;
      node.setAttribute('aria-selected', String(track.uid === this.editor.selectedUid));
      node.setAttribute('aria-posinset', String(index + 1));
      node.setAttribute('aria-setsize', String(this.tracks.length));
      node.setAttribute('aria-label', `Select ${track.name}, layer ${index + 1}`);
      node.title = `${track.name} · figure ${track.uid}`;
      node.children[1].textContent = track.name;
      node.children[2].textContent = String(index + 1).padStart(2, '0');
    }
    for (let i = visible; i < this.labels.length; i++) this.labels[i].hidden = true;
    if (!this.tracks.length && !this.empty) {
      this.empty = element('div', 'styk-timeline-empty', this.labelViewport);
      this.empty.textContent = 'No layers';
    }
    if (this.empty) this.empty.hidden = Boolean(this.tracks.length);
  }

  _drawHead() {
    const ctx = this.headContext, x = LEAD + (this.editor.tick + 0.5) * this.pxPerTick - this._offsetX();
    const label = String(Math.floor(this.editor.tick) + 1);
    const tagWidth = Math.max(24, label.length * 6.5 + 10);
    const half = Math.max(this.pxPerTick / 2, tagWidth / 2) + 3;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this._lastHead !== null) ctx.clearRect(this._lastHead.left, 0, this._lastHead.width, this.height);
    this._lastHead = {left: x - half, width: half * 2};
    if (x < -half || x > this.width + half) return;
    ctx.fillStyle = '#0d99ff1b';
    ctx.fillRect(x - this.pxPerTick / 2, RULER_HEIGHT, this.pxPerTick, this.height - RULER_HEIGHT);
    ctx.fillStyle = ACCENT;
    ctx.fillRect(Math.round(x) - 1, 25, 2, this.height - 25);
    ctx.beginPath(); ctx.roundRect(x - tagWidth / 2, 2, tagWidth, 22, 3); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 4, 23); ctx.lineTo(x, 29); ctx.lineTo(x + 4, 23); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = "600 11px Inter, 'Segoe UI', sans-serif";
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, x, 13);
  }

  _selectTrack(track) {
    if (this.channelMode) {
      let owner = track;
      while (owner.parentId && this.trackById.has(owner.parentId)) owner = this.trackById.get(owner.parentId);
      const layerId = owner.uid !== undefined ? this.editor.layerForUid?.(owner.uid) : owner.id;
      if (layerId && this.editor.layers?.some(layer => layer.id === layerId)) this.editor.setActiveLayer?.(layerId);
      if (track.uid !== undefined && (!this.actionMode || !this.editor.selectedUids.has(track.uid))) { this.editor.select(track.uid); this.onSelect?.(track.uid); }
      this.selectedTrackId = track.id;
      if(!this.actionMode || this.editor.selectedUids.size<=1)this.onTrackSelect?.(track);
      this._fullDirty = true; this._updateToolbar(); this._schedule();
      this.live.textContent = `${track.name}, ${track.keys.length} keys`;
      return;
    }
    this.editor.select(track.uid);
    this.onSelect?.(track.uid);
    this.live.textContent = `${track.name}, frame ${this.editor.tick + 1}`;
  }

  _seekPointer(event, chooseTrack = false) {
    const rect = this.scroll.getBoundingClientRect();
    let x = event.clientX - rect.left, y = event.clientY - rect.top;
    if (x < 0 || x > this.width) {
      this._scrollToX(this._offsetX() + (x < 0 ? x : x - this.width));
      x = clamp(x, 0, this.width);
    }
    const tick = clamp(Math.floor((x + this._offsetX() - LEAD) / this.pxPerTick), 0, this.channelMode ? 10000000 : Math.max(0, this.editor.totalTicks - 1));
    if (!this._scrubStarted) {
      this._scrubStarted = true;
      this._lastScrubTick = null;
      // Let the host suppress scene evaluation before any editor event fires.
      this.onScrubStart?.(tick);
      this.onSeek?.(this.editor.tick, this.editor.frameIndex);
    }
    const previousFrame = this.editor.frameIndex;
    if (this.editor.tick !== tick) this.editor.seek(tick, {evaluate: false, allowBeyondEnd: this.channelMode});
    if (this.channelMode) {
      // The ruler moves time without replacing the selected layer keys.
    } else if (this._toggleGesture) {
      if (!this._toggleApplied) {
        this._toggleApplied = true;
        this._toggleFrame(this.editor.frameIndex, this._toggleBase);
      }
    } else this._setRange(this.editor.frameIndex, this._rangeExtending, previousFrame);
    if (chooseTrack && y >= RULER_HEIGHT) {
      const index = Math.floor((y - RULER_HEIGHT + this._offsetY()) / ROW_HEIGHT);
      const track = this.tracks[index];
      if (track) this._selectTrack(track);
    }
    if (tick !== this._lastScrubTick) {
      this._lastScrubTick = tick;
      this.onScrub?.(tick, this.editor.frameIndex);
    }
    this.update();
  }

  _pointerDown(event) {
    if(this._channelGesture?.keyboard){event.preventDefault();this._finishChannelGesture(event.button!==0);return;}
    if(event.button===1){event.preventDefault();this._pan={x:event.clientX,y:event.clientY,sx:this._offsetX(),sy:this._offsetY(),id:event.pointerId};this.scroll.setPointerCapture(event.pointerId);return;}
    if (this.channelMode && this._channelPointerDown(event)) return;
    if (event.button !== 0) return;
    const rect = this.scroll.getBoundingClientRect();
    // Keep native scrollbar thumbs draggable.
    if (event.clientX - rect.left >= this.width || event.clientY - rect.top >= this.height) return;
    event.preventDefault();
    this.scroll.focus({preventScroll: true});
    this._dragging = true;
    this._scrubPointerId = event.pointerId;
    this._rangeNotificationPending = false;
    this._rangeExtending = event.shiftKey;
    this._toggleGesture = Boolean((event.ctrlKey || event.metaKey) && !event.shiftKey);
    this._toggleApplied = false;
    this._toggleBase = this._toggleGesture ? this.selectedFrameIndices : null;
    this.scroll.setPointerCapture(event.pointerId);
    this._seekPointer(event, true);
  }

  _pointerMove(event) {
    this._lastPointer={clientX:event.clientX,clientY:event.clientY};
    if(this._pan){this._scrollToX(this._pan.sx+this._pan.x-event.clientX);this._scrollToY(this._pan.sy+this._pan.y-event.clientY);return;}
    if (this._channelGesture) { this._channelPointerMove(event); return; }
    if (this.channelMode && !this._dragging) {
      const hit = this._channelHit(event);
      const heldPose = hit.exposureKey && hit.tick < this.editor.totalTicks && (['scene','camera','layer'].includes(hit.track?.kind) || hit.track?.property === 'pose');
      this.scroll.style.cursor = hit.y < RULER_HEIGHT ? 'ew-resize' : hit.track?.locked ? 'not-allowed' : hit.key || heldPose ? 'grab' : 'crosshair';
    }
    if (!this._dragging) return;
    this._pendingPointer = {clientX: event.clientX, clientY: event.clientY};
    if (this._pointerRaf) return;
    this._pointerRaf = requestAnimationFrame(() => {
      this._pointerRaf = 0;
      const latest = this._pendingPointer;
      this._pendingPointer = null;
      if (this._dragging && latest) this._seekPointer(latest);
    });
  }

  _pointerUp(event) {
    if(this._pan){this.scroll.releasePointerCapture(this._pan.id);this._pan=null;return;}
    if(this._channelGesture?.keyboard)return;
    if (this._channelGesture) { this._channelPointerMove(event, true); this._finishChannelGesture(event.type === 'pointercancel'); return; }
    if (!this._dragging) return;
    // Release wins over a scheduled older move, including between RAF callbacks.
    if (this._pointerRaf) { cancelAnimationFrame(this._pointerRaf); this._pointerRaf = 0; }
    this._pendingPointer = null;
    if (event.type !== 'pointercancel') this._seekPointer(event);
    this._finishScrub(event.type === 'pointercancel');
  }

  _finishScrub(cancelled = false) {
    if (!this._dragging) return;
    this._dragging = false;
    this._pendingPointer = null;
    if (this._pointerRaf) { cancelAnimationFrame(this._pointerRaf); this._pointerRaf = 0; }
    if (this._rangeNotificationPending) {
      this._rangeNotificationPending = false;
      this.onRangeChange?.(this.selectedFrameIndices);
    }
    if (this._scrubStarted) {
      this._scrubStarted = false;
      // Always settle, even when pointerup did not change the current tick.
      this.onScrubEnd?.(this.editor.tick, {cancelled, frameIndex: this.editor.frameIndex});
      this.onSeek?.(this.editor.tick, this.editor.frameIndex);
    }
    if (this._scrubPointerId !== undefined && this.scroll.hasPointerCapture(this._scrubPointerId))
      this.scroll.releasePointerCapture(this._scrubPointerId);
    this._scrubPointerId = undefined;
    this._toggleBase = null;
    const count = this._selectionCount();
    this.live.textContent = count === 0 ? 'No keyframes selected' : count > 1 ? `${count} keyframes selected` : `Frame ${this.editor.tick + 1} of ${Math.max(1, this.editor.totalTicks)}`;
  }

  _keyDown(event) {
    if (this.channelMode && this._channelKeyDown(event)) return;
    if (event.altKey && ![',', '.', '<', '>'].includes(event.key)) return;
    if (event.ctrlKey || event.metaKey) {
      if ([',', '<', '.', '>'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const base = this.selectedFrameIndices;
        const index = clamp(this.editor.frameIndex + ([',', '<'].includes(event.key) ? -1 : 1), 0, this.exposures.length - 1);
        this.editor.selectFrame(index); this._toggleFrame(index, base);
        this.onSeek?.(this.editor.tick, index); this.update();
        return;
      }
      const command = {c: 'copySelection', x: 'cutSelection', v: 'pasteSelection', d: 'duplicateSelection'}[event.key.toLowerCase()];
      if (command) {
        event.preventDefault(); event.stopPropagation();
        this._runCommand(command);
      } else if (event.key.toLowerCase() === 'a') {
        event.preventDefault(); event.stopPropagation();
        this.selectAll();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      this._finishScrub(true);
      if (this.menu) this.menu.hidden = true;
      this._setRange(this.editor.frameIndex);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault(); event.stopPropagation();
      this._runCommand('deleteSelection');
      return;
    }
    if (event.key === 'F7') {
      event.preventDefault(); event.stopPropagation();
      this._runCommand('insertBlankKeyframe');
      return;
    }
    if (!this.channelMode && ['F5', 'F6'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      this._runCommand(event.key === 'F5' ? 'extendFrame' : 'addKeyframe'); return;
    }
    let tick = this.editor.tick;
    let keyIndex = null;
    const previousFrame = this.editor.frameIndex;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || (!event.altKey && [',','.','<','>'].includes(event.key))) {
      const direction = ['ArrowLeft', ',', '<'].includes(event.key) ? -1 : 1;
      if (event.shiftKey) keyIndex = clamp(this.editor.frameIndex + direction, 0, this.exposures.length - 1);
      else tick += direction;
    }
    else if (event.key === 'Home') tick = 0;
    else if (event.key === 'End') tick = this.editor.totalTicks - 1;
    else if (['PageUp', 'PageDown', ',', '.', '<', '>'].includes(event.key)) {
      keyIndex = clamp(this.editor.frameIndex + (['PageUp', ',', '<'].includes(event.key) ? -1 : 1), 0, this.exposures.length - 1);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const current = this.trackIndices.get(this.editor.selectedUid) ?? -1;
      const index = clamp(current + (event.key === 'ArrowUp' ? -1 : 1), 0, this.tracks.length - 1);
      const track = this.tracks[index];
      if (track) {
        if (!this.editor.frame.objects.some(object => object.unique_id === track.uid)) {
          this.editor.selectFrame(track.frames[0]); this.onSeek?.(this.editor.tick, this.editor.frameIndex);
        }
        this._selectTrack(track);
        const top = index * ROW_HEIGHT, offset = this._offsetY();
        if (top < offset) this._scrollToY(top);
        else if (top + ROW_HEIGHT > offset + this.height - RULER_HEIGHT) this._scrollToY(top + ROW_HEIGHT - this.height + RULER_HEIGHT);
      }
      event.preventDefault(); event.stopPropagation(); return;
    } else if (event.key === '+' || event.key === '=') {
      this.setZoom(this.pxPerTick * 1.2); event.preventDefault(); event.stopPropagation(); return;
    } else if (event.key === '-') {
      this.setZoom(this.pxPerTick / 1.2); event.preventDefault(); event.stopPropagation(); return;
    } else return;
    event.preventDefault(); event.stopPropagation();
    // Stored keys can share a tick when hidden. Seeking that tick would skip them.
    if (keyIndex !== null) this.editor.selectFrame(keyIndex);
    else this.editor.seek(tick, {allowBeyondEnd: this.channelMode});
    this._setRange(this.editor.frameIndex, event.shiftKey, previousFrame);
    this.onSeek?.(this.editor.tick, this.editor.frameIndex);
    this.live.textContent = `Frame ${this.editor.tick + 1} of ${Math.max(1, this.editor.totalTicks)}`;
    this.update();
  }

  setMode(mode) {
    if (this.actionMode) return;
    this._finishChannelGesture(true); this._finishScrub(true);
    this.mode = mode === 'frames' ? 'frames' : 'tracks';
    this.menu?.remove(); this.menu = null;
    this._reindex(); this.resize(); this.update();
  }

  selectTrack(id, {notify = false} = {}) {
    if (this.actionMode && id?.startsWith('figure:')) {
      const assembly = this.assemblyByUid?.get(Number(id.slice(7)));
      if (assembly && !this.expandedTracks.has(assembly.id)) id = assembly.id;
    }
    if(this.actionMode && this.externalTrack!==id){this.externalTrack=id;this._filterActionTracks();this.resize();}
    if(this.actionMode&&!this.tracks.some(track=>track.id===id)){this.update();return false;}
    const track = this.trackById?.get(id);
    if (!track) return false;
    if (notify) this._selectTrack(track);
    else if (this.selectedTrackId !== id) { this.selectedTrackId = id; this._fullDirty = true; this._updateToolbar(); this._schedule(); }
    return true;
  }

  get selectedAnimationKeys() {
    return [...this._animationSelection].filter(([, ids]) => ids.size).map(([channelId, ids]) => ({channelId, keyIds: [...ids]}));
  }

  _buildChannelToolbar() {
    this.tools.hidden = true;
    if (this.channelTools) { this.channelTools.hidden = false; this.addLayerButton.hidden = this.actionMode; return; }
    this.channelTools = element('div', 'styk-timeline-tools styk-timeline-channel-tools');
    this.channelTools.setAttribute('role', 'toolbar'); this.channelTools.setAttribute('aria-label', 'Layer and property keys');
    this.editbar.insertBefore(this.channelTools, this.framePosition);
    this.channelButtons = new Map();
    for (const [command, label, icon, title] of [
      ['addTrackKey', 'Keyframe', 'add', 'Insert key at playhead · F6'],
      ['insertBlankTrackKey', 'Blank', 'blank', 'Insert blank pose key · F7'],
      ['showKeyMoveDialog', 'Retime…', 'timing', 'Move selected keys to a frame'],
      ['duplicateTrackKeys', '', 'duplicate', 'Duplicate selected keys · Ctrl/Cmd+D'],
      ['deleteTrackKeys', '', 'delete', 'Delete selected keys · Delete'],
      ['trackMenu', '', 'more', 'More track actions'],
    ].filter(([command])=>!this.actionMode||['addTrackKey','trackMenu'].includes(command))) {
      const button = element('button', '', this.channelTools);
      button.type = 'button'; button.title = title; button.dataset.trackAction = command;
      button.setAttribute('aria-label', title.split(' · ')[0]);
      if (command === 'addTrackKey') button.dataset.primary = 'true';
      button.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOOL_ICONS[icon]}</svg>`;
      if (label) element('span', '', button).textContent = label;
      this.channelButtons.set(command, button);
      this._on(button, 'click', event => {
        event.preventDefault(); event.stopPropagation();
        if (command === 'trackMenu') {
          const rect = button.getBoundingClientRect();
          this._channelContextMenu({clientX: rect.left, clientY: rect.bottom + 3, preventDefault() {}, stopPropagation() {}}, true);
        } else { this._runCommand(command); if(!this.dialog?.open)this.scroll.focus({preventScroll:true}); }
      });
    }
    this.addLayerButton = element('button', 'styk-timeline-add-layer', this.navModes);
    this.addLayerButton.hidden = this.actionMode;
    this.addLayerButton.type = 'button'; this.addLayerButton.textContent = '+';
    this.addLayerButton.title = 'Create animation layer'; this.addLayerButton.setAttribute('aria-label', 'Create animation layer');
    this._on(this.addLayerButton, 'click', event => {
      event.preventDefault(); event.stopPropagation();
      try { this.editor.createLayer(); } catch (error) { this.onError?.(error); }
    });
    this.dragStatus = element('div', 'styk-timeline-drag-status', this.root); this.dragStatus.hidden = true;
  }

  _updateChannelToolbar() {
    const track = this.trackById?.get(this.selectedTrackId), count = [...this._animationSelection.values()].reduce((sum, ids) => sum + ids.size, 0);
    const name = track?.name ?? (this.actionMode ? 'Select a figure' : 'Timeline'), total = track ? `${track.keys.length} keys` : '', selection = `${count} selected`;
    if (this.keyCounter.textContent !== name) this.keyCounter.textContent = name;
    if (this.keyTotal.textContent !== total) this.keyTotal.textContent = total;
    this.rangeCounter.hidden = !count;
    if (this.rangeCounter.textContent !== selection) this.rangeCounter.textContent = selection;
    const fps = Number(this.editor.report?.fps ?? this.editor.report?.frames_per_second ?? 24);
    const seconds = Math.floor(this.editor.tick / fps), frame = Math.floor(this.editor.tick % fps);
    const position = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}:${String(frame).padStart(2, '0')}  ·  ${Math.floor(this.editor.tick) + 1} / ${this.editor.totalTicks}`;
    if (this.framePosition.textContent !== position) this.framePosition.textContent = position;
    for (const [command, button] of this.channelButtons ?? []) {
      button.disabled = command === 'addTrackKey' ? !this._canInsertTrackKey(track) : command === 'insertBlankTrackKey' ? !this._blankPoseTarget(track) || Boolean(track?.locked) : command === 'trackMenu' ? false : !count || Boolean(track?.locked);
      if (command === 'insertBlankTrackKey') button.title = this._blankPoseTarget(track) ? 'Insert blank pose key · F7' : 'Blank keys require a Scene, Camera, layer, or Pose track';
    }
    if (this.addLayerButton) this.addLayerButton.disabled = typeof this.editor.createLayer !== 'function';
  }

  _animationKeySelected(key) {
    return key.refs.some(ref => this._animationSelection.get(ref.channelId)?.has(ref.keyId));
  }

  _setAnimationSelection(refs, {toggle = false, additive = false} = {}) {
    const selected = toggle || additive ? new Map([...this._animationSelection].map(([id, keys]) => [id, new Set(keys)])) : new Map();
    const unique = new Map(refs.map(ref => [`${ref.channelId}\0${ref.keyId}`, ref]));
    for (const ref of unique.values()) {
      let ids = selected.get(ref.channelId);
      if (!ids) { ids = new Set(); selected.set(ref.channelId, ids); }
      if (toggle && ids.has(ref.keyId)) ids.delete(ref.keyId); else ids.add(ref.keyId);
      if (!ids.size) selected.delete(ref.channelId);
    }
    this._animationSelection = selected;
    this._fullDirty = true; this._headDirty = true; this._updateToolbar(); this._schedule();
    this.onKeysChange?.(this.selectedAnimationKeys);
  }

  _channelSelectionRecords() {
    const result = [];
    for (const channelId of this._animationSelection.keys()) this.trackById?.get(`channel:${channelId}`)?.keys;
    for (const channel of this._channelDescriptors?.values() ?? []) {
      const selected = this._animationSelection.get(channel.id);
      if (selected) for (const key of channel.keys) if (selected.has(key.id)) result.push({channel, key});
    }
    return result;
  }

  _assertKeysEditable(records = this._channelSelectionRecords()) {
    if (this._selectedTrack()?.kind === 'assembly' && this._selectedTrack().locked) throw new Error('Unlock every connected figure before editing this group.');
    for (const {channel} of records) {
      const target = channel.target;
      const id = ['figure', 'segment'].includes(target.kind) ? this.editor.layerForUid?.(target.uid) : target.kind === 'layer' ? target.id : target.kind;
      if (this.editor.getLayer?.(id)?.locked) throw new Error('Unlock the selected layer before editing its keys.');
    }
  }

  _selectedTrack() { return this.trackById?.get(this.selectedTrackId); }

  _canInsertTrackKey(track=this._selectedTrack()) {
    if(!track||track.locked)return false;
    const target=track.target;
    if(target?.kind==='segment'&&target.figureTypeId!==undefined){
      const frame=this.editor.selectionFrame??this.editor.frame;
      return frame?.objects.some(object=>object.unique_id===target.uid&&object.figure_type_id===target.figureTypeId)??false;
    }
    return true;
  }

  addTrackKey() {
    const track = this._selectedTrack();
    if (!this._canInsertTrackKey(track)) return false;
    this.onSeek?.(this.editor.tick, this.editor.frameIndex);
    if (track.kind === 'assembly') {
      const entries = track.figureUids.map(uid => ({target:{kind:'figure',uid},property:'pose',tick:this.editor.tick}));
      for (const entry of entries) this.editor.nativePoseChannel(entry.target);
      this.editor.addAnimationKeys(entries);
    }
    else if (track.kind === 'channel') this.editor.addAnimationKey(track.target, track.property, this.editor.tick, undefined, {exactTarget:true});
    else if (track.kind === 'figure' && this.actionMode) { this.editor.nativePoseChannel(track.target); this.editor.addAnimationKey(track.target,'pose',this.editor.tick); }
    else if (track.kind === 'figure') this.editor.addAnimationKeys(['x', 'y', 'scale', 'rotation', 'opacity'].map(property => ({target: track.target, property, tick: this.editor.tick})));
    else if (track.kind === 'segment') this.editor.addAnimationKeys(track.channelChildren.map(channel => ({target: track.target, property: channel.property, tick: this.editor.tick,exactTarget:true})));
    else this.editor.addAnimationKey(track.target, 'pose', this.editor.tick);
    this.update();
    const current = this.trackById.get(track.id), key = current?.keys.find(item => item.tick === this.editor.tick);
    if (key) this._setAnimationSelection(key.refs);
    return true;
  }

  _blankPoseTarget(track = this._selectedTrack()) {
    if (!track) return null;
    if (track.kind === 'channel') return track.property === 'pose' ? track.target : null;
    return ['scene', 'camera', 'layer', ...(this.actionMode ? ['figure'] : [])].includes(track.kind) ? track.target : null;
  }

  insertBlankTrackKey() {
    const track = this._selectedTrack(), target = this._blankPoseTarget(track);
    if (!target) { this.live.textContent = 'Select a Scene, Camera, layer, or Pose track to insert a blank pose key.'; return false; }
    if (track.locked) { this.live.textContent = 'Unlock this layer before inserting a blank pose key.'; return false; }
    this.onSeek?.(this.editor.tick, this.editor.frameIndex);
    // Registration is read-only. The subsequent key edit adopts native poses in
    // its own history command, retaining every earlier pose and hidden key.
    this.editor.nativePoseChannel?.(target);
    const key = this.editor.addAnimationKey(target, 'pose', this.editor.tick, {frameId: null});
    this.update();
    const channelId = animationChannelId(target, 'pose');
    this._setAnimationSelection([{channelId, keyId: key.id}]);
    this._focusedTrackKey = {id: track.kind === 'channel' ? key.id : `tick:${key.tick}`, trackId: track.id};
    this.live.textContent = `Blank pose key inserted on ${track.name} at frame ${key.tick + 1}`;
    return key;
  }

  deleteTrackKeys() {
    if (!this.selectedAnimationKeys.length) return false;
    this._assertKeysEditable();
    this.editor.deleteAnimationKeys(this.selectedAnimationKeys);
    this._setAnimationSelection([]); return true;
  }

  _moveTrackKeys(delta, duplicate = false) {
    if (!Number.isInteger(delta) || (!delta && !duplicate)) return false;
    const records = this._channelSelectionRecords();
    if (!records.length) return false;
    this._assertKeysEditable(records);
    this.onSeek?.(this.editor.tick, this.editor.frameIndex);
    const replace = !this._usesConnectedTiming(records);
    if (duplicate) this.editor.duplicateAnimationKeys(this.selectedAnimationKeys, delta, {replace});
    else this.editor.moveAnimationKeys(this.selectedAnimationKeys, delta, {replace});
    if (duplicate) {
      const channels = new Map(this.editor.animationChannels.map(channel => [channel.id, channel]));
      this._setAnimationSelection(records.flatMap(({channel, key}) => {
        const next = channels.get(channel.id)?.keys.find(item => item.tick === key.tick + delta);
        return next ? [{channelId: channel.id, keyId: next.id}] : [];
      }));
    }
    const target = Math.max(0, records.reduce((minimum,item)=>Math.min(minimum,item.key.tick),Infinity) + delta);
    this.editor.seek(target); this.onSeek?.(this.editor.tick, this.editor.frameIndex); this.update();
    return true;
  }

  duplicateTrackKeys() {
    const records = this._channelSelectionRecords();
    if (!records.length) return false;
    const bounds = records.reduce(([min,max],item)=>[Math.min(min,item.key.tick),Math.max(max,item.key.tick)],[Infinity,-Infinity]);
    return this._moveTrackKeys(bounds[1] - bounds[0] + 1, true);
  }

  copyTrackKeys() {
    const records = this._channelSelectionRecords();
    if (!records.length) return false;
    this._keyClipboard = {report: this.editor.report, connected: this._usesConnectedTiming(records), entries: records.map(({channel, key}) => ({target: structuredClone(channel.target), property: channel.property, tick: key.tick, value: structuredClone(key.value), ...(key.interpolation === undefined ? {} : keyEasing(key))}))};
    return true;
  }

  pasteTrackKeys() {
    if (!this._keyClipboard?.entries.length) return false;
    if (this._keyClipboard.report !== this.editor.report) throw new Error('Property keys can be pasted within their source animation.');
    const start = Math.min(...this._keyClipboard.entries.map(entry => entry.tick));
    this._assertKeysEditable(this._keyClipboard.entries.map(entry => ({channel:entry})));
    if (this._keyClipboard.connected) for (const entry of this._keyClipboard.entries) {
      const id = animationChannelId(entry.target, entry.property);
      const channel = this._channelDescriptors.get(id) ?? (entry.property === 'pose' ? this.editor.nativePoseChannel?.(entry.target) : null);
      if (channel?.keys.some(key => !key.hidden && key.tick === entry.tick - start + this.editor.tick))
        throw new Error('Destination occupied in a connected part. Paste the group into empty frames.');
    }
    this.editor.addAnimationKeys(this._keyClipboard.entries.map(entry => ({...structuredClone(entry), tick: entry.tick - start + this.editor.tick,exactTarget:true})));
    return true;
  }

  showKeyScaleDialog() {
    const records = this._channelSelectionRecords(); if (!records.length) return;
    this._assertKeysEditable(records);
    const anchor = Math.min(...records.map(item => item.key.tick));
    const ui = this._createDialog('Scale timing', 'The first selected key stays fixed. All selected parts use the same timing scale, rounded to whole frames.', 'Apply timing');
    const label = element('label', '', ui.content); label.textContent = 'Duration (%)';
    const input = element('input', '', label); input.type = 'number'; input.min = '1'; input.step = '1'; input.value = '100'; input.required = true;
    ui.form.addEventListener('submit', event => {
      event.preventDefault();
      try {
        this._assertKeysEditable();
        this.editor.scaleAnimationKeys(this.selectedAnimationKeys, input.valueAsNumber / 100, anchor);
        ui.dialog.close(); this.update();
      } catch (error) { ui.error.textContent = error.message; }
    });
    ui.dialog.showModal(); input.focus(); input.select();
  }

  showKeyMoveDialog() {
    const records = this._channelSelectionRecords();
    if (!records.length) return;
    const start = Math.min(...records.map(item => item.key.tick));
    const ui = this._createDialog('Move keys', `${records.length} property key${records.length === 1 ? '' : 's'} selected`, 'Move keys');
    const label = element('label', '', ui.content); label.textContent = 'First selected key at frame';
    const input = element('input', '', label); input.type = 'number'; input.min = '1'; input.step = '1'; input.value = String(start + 1); input.required = true;
    ui.form.addEventListener('submit', event => {
      event.preventDefault();
      try { this._moveTrackKeys(input.valueAsNumber - 1 - start); ui.dialog.close(); }
      catch (error) { ui.error.textContent = error.message; }
    });
    ui.dialog.showModal(); input.focus(); input.select();
  }

  _channelHit(event) {
    const rect = this.scroll.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    const row = Math.floor((y - RULER_HEIGHT + this._offsetY()) / ROW_HEIGHT), track = y >= RULER_HEIGHT ? this.tracks[row] : null;
    const tick = Math.max(0, Math.round((x + this._offsetX() - LEAD) / this.pxPerTick - .5));
    let key = null, exposureKey = null;
    if (track) {
      let low = 0, high = track.keys.length;
      while (low < high) { const mid = (low + high) >>> 1; if (track.keys[mid].tick < tick) low = mid + 1; else high = mid; }
      exposureKey = track.keys[low]?.tick === tick ? track.keys[low] : track.keys[low - 1];
      for (const index of [low - 1, low]) {
        const candidate = track.keys[index];
        const distance = candidate ? Math.abs(LEAD + (candidate.tick + .5) * this.pxPerTick - this._offsetX() - x) : Infinity;
        const previousDistance = key ? Math.abs(LEAD + (key.tick + .5) * this.pxPerTick - this._offsetX() - x) : Infinity;
        if (distance <= Math.max(9, this.pxPerTick * .4) && distance < previousDistance) key = candidate;
      }
    }
    return {x, y, row, track, tick, key, exposureKey};
  }

  _channelPointerDown(event) {
    if (event.button !== 0) return false;
    const hit = this._channelHit(event);
    if(this._boxSelectArmed){hit.key=null;hit.exposureKey=null;this._boxSelectArmed=false;}
    if (hit.y < RULER_HEIGHT || hit.x >= this.width || hit.y >= this.height) return false;
    event.preventDefault(); this.scroll.focus({preventScroll: true});
    if (hit.track) this._selectTrack(hit.track);
    if (hit.track?.locked) return true;
    const selectedKey = hit.key ?? (hit.track && (['scene', 'camera', 'layer'].includes(hit.track.kind) || hit.track.property === 'pose')
      && hit.tick < this.editor.totalTicks ? hit.exposureKey : null);
    if (selectedKey) {
      this._focusedTrackKey = {id: selectedKey.id, trackId: hit.track.id};
      if (event.shiftKey && this._keyAnchor?.trackId === hit.track.id) {
        const start = Math.min(this._keyAnchor.tick, selectedKey.tick), end = Math.max(this._keyAnchor.tick, selectedKey.tick);
        this._setAnimationSelection(hit.track.keys.filter(key => key.tick >= start && key.tick <= end).flatMap(key => key.refs));
      } else if (event.ctrlKey || event.metaKey) this._setAnimationSelection(selectedKey.refs, {toggle: true});
      else if (!this._animationKeySelected(selectedKey)) this._setAnimationSelection(selectedKey.refs);
      this._keyAnchor = {trackId: hit.track.id, tick: selectedKey.tick};
    } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey) this._setAnimationSelection([]);
    const dragKey = selectedKey && this._animationKeySelected(selectedKey);
    this._channelGesture = {pointerId: event.pointerId, kind: dragKey ? 'keys' : 'marquee', startX: event.clientX, startY: event.clientY,
      startTick: hit.tick, row: hit.row, logicalX: hit.x + this._offsetX(), logicalY: hit.y - RULER_HEIGHT + this._offsetY(),
      lastEvent: {clientX: event.clientX, clientY: event.clientY}, delta: 0, moved: false, duplicate: event.altKey,
      additive: event.shiftKey || event.ctrlKey || event.metaKey, base: this.selectedAnimationKeys, records: dragKey ? this._channelSelectionRecords() : []};
    this._channelGesture.collisionPlan = dragKey ? this._keyMovePlan(event.altKey) : [];
    this._channelGesture.minimum = this._channelGesture.records.reduce((value, item) => Math.min(value, item.key.tick), Infinity);
    this.scroll.setPointerCapture(event.pointerId);
    return true;
  }

  _channelPointerMove(event, immediate = false) {
    const gesture = this._channelGesture;
    if (!gesture) return;
    if(gesture.keyboard && gesture.numeric)return;
    gesture.lastEvent = {clientX: event.clientX, clientY: event.clientY};
    if (this._channelRaf) { if (!immediate) return; cancelAnimationFrame(this._channelRaf); this._channelRaf = 0; }
    const apply = () => {
      this._channelRaf = 0;
      if (!this._channelGesture) return;
      const latest = gesture.lastEvent;
      const distance = Math.hypot(latest.clientX - gesture.startX, latest.clientY - gesture.startY);
      if (distance < 4 && !gesture.moved) return;
      gesture.moved = true;
      const rect = this.scroll.getBoundingClientRect(), localX = latest.clientX - rect.left;
      const edge = localX < 12 ? Math.max(-24, localX - 12) : localX > this.width - 12 ? Math.min(24, localX - this.width + 12) : 0;
      if (edge) this._scrollToX(this._offsetX() + edge);
      const localY = latest.clientY - rect.top;
      const verticalEdge = localY < RULER_HEIGHT + 12 ? -12 : localY > this.height - 12 ? 12 : 0;
      if (verticalEdge && gesture.kind === 'marquee') this._scrollToY(this._offsetY() + verticalEdge);
      const hit = this._channelHit(latest);
      if (gesture.kind === 'keys') {
        this.scroll.style.cursor = 'grabbing';
        const minimum = Number.isFinite(gesture.minimum) ? gesture.minimum : 0;
        gesture.delta = Math.max(-minimum, hit.tick - gesture.startTick);
        gesture.invalid = this._keyMoveConflict(gesture.delta, gesture.duplicate);
        this.dragStatus.hidden = false; this.dragStatus.dataset.invalid = String(Boolean(gesture.invalid));
        const replacements = this._keyReplacementCount(gesture.delta, gesture.duplicate);
        this.dragStatus.textContent = gesture.invalid || `${gesture.duplicate ? 'Copy' : 'Move'} ${gesture.delta >= 0 ? '+' : ''}${gesture.delta} fr${replacements ? ` · Replace ${replacements} key${replacements === 1 ? '' : 's'}` : ''}`;
      } else {
        gesture.rectangle = {left: Math.min(gesture.logicalX, hit.x + this._offsetX()), right: Math.max(gesture.logicalX, hit.x + this._offsetX()),
          top: Math.min(gesture.logicalY, hit.y - RULER_HEIGHT + this._offsetY()), bottom: Math.max(gesture.logicalY, hit.y - RULER_HEIGHT + this._offsetY())};
      }
      this._fullDirty = this._headDirty = true; this._schedule();
      if ((edge || verticalEdge && gesture.kind === 'marquee') && !immediate) this._channelRaf = requestAnimationFrame(apply);
    };
    if (immediate) apply(); else this._channelRaf = requestAnimationFrame(apply);
  }

  _keyMoveConflict(delta, duplicate = false) {
    if (this._channelGesture?.records.some(({key}) => key.tick + delta > 10000000)) return 'Maximum frame reached';
    if (this._usesConnectedTiming() && this._keyReplacementCount(delta, duplicate)) return 'Destination occupied in a connected part. Move the group to empty frames.';
    return null;
  }

  _usesConnectedTiming(records = this._channelGesture?.records ?? this._channelSelectionRecords()) {
    if (this._selectedTrack()?.kind === 'assembly') return true;
    const seen = new Map();
    for (const {channel} of records) {
      const uid = channel.target.uid, group = this.assemblyByUid?.get(uid);
      if (!group) continue;
      if (seen.has(group.id) && seen.get(group.id) !== uid) return true;
      seen.set(group.id, uid);
    }
    return false;
  }

  _keyReplacementCount(delta, duplicate = false) {
    if (!delta) return 0;
    let count = 0;
    for (const {occupied, selected} of this._channelGesture?.collisionPlan ?? this._keyMovePlan(duplicate)) {
      for (const tick of selected) if (occupied.has(tick + delta)) count++;
    }
    return count;
  }

  _keyMovePlan(duplicate = false) {
    const plan = [];
    for (const channel of this._channelDescriptors.values()) {
      const ids = this._animationSelection.get(channel.id);
      if (!ids) continue;
      const occupied = new Set(), selected = new Set();
      for (const key of channel.keys) if (!key.hidden) {
        if (ids.has(key.id)) selected.add(key.tick);
        if (duplicate || !ids.has(key.id)) occupied.add(key.tick);
      }
      if (occupied.size && selected.size) plan.push({occupied, selected});
    }
    return plan;
  }

  _finishChannelGesture(cancelled = false) {
    const gesture = this._channelGesture;
    if (!gesture) return;
    this._channelGesture = null;
    if (this._channelRaf) { cancelAnimationFrame(this._channelRaf); this._channelRaf = 0; }
    if (this.dragStatus) this.dragStatus.hidden = true;
    this.scroll.style.cursor = '';
    if (!cancelled) {
      try {
        if (gesture.kind === 'keys' && gesture.moved && gesture.delta) {
          if (gesture.invalid) throw new Error(gesture.invalid);
          this._moveTrackKeys(gesture.delta, gesture.duplicate);
        } else if (gesture.kind === 'marquee' && gesture.rectangle) {
          const rect = gesture.rectangle, refs = [];
          for (let row = Math.max(0, Math.floor(rect.top / ROW_HEIGHT)); row <= Math.min(this.tracks.length - 1, Math.floor(rect.bottom / ROW_HEIGHT)); row++) {
            const track = this.tracks[row]; if (track.locked) continue;
            for (const key of track.keys) { const x = LEAD + (key.tick + .5) * this.pxPerTick; if (x >= rect.left && x <= rect.right) refs.push(...key.refs); }
          }
          this._setAnimationSelection(refs, {additive: gesture.additive});
        } else if (!gesture.moved) {
          this.editor.seek(gesture.startTick, {allowBeyondEnd: true});
          this.onSeek?.(this.editor.tick, this.editor.frameIndex);
        }
      } catch (error) { this.live.textContent = error.message; this.onError?.(error); }
    }
    if (gesture.pointerId !== undefined && this.scroll.hasPointerCapture(gesture.pointerId)) this.scroll.releasePointerCapture(gesture.pointerId);
    this._fullDirty = this._headDirty = true; this.update();
  }

  _channelKeyDown(event) {
    const control = event.ctrlKey || event.metaKey;
    if(this._channelGesture?.keyboard){
      event.preventDefault();event.stopPropagation();const gesture=this._channelGesture;
      if(event.key==='Escape'){this._finishChannelGesture(true);return true;}
      if(event.key==='Enter'){this._finishChannelGesture(false);return true;}
      if(/^[0-9-]$/.test(event.key)||event.key==='Backspace'){
        gesture.numeric=event.key==='Backspace'?(gesture.numeric||'').slice(0,-1):(gesture.numeric||'')+event.key;
        const delta=Number(gesture.numeric);if(Number.isInteger(delta))this._previewKeyDelta(Math.max(-gesture.minimum,delta));
      }else if(['ArrowLeft','ArrowRight'].includes(event.key))this._previewKeyDelta(gesture.delta+(event.key==='ArrowLeft'?-1:1));
      return true;
    }
    if(!control && (event.key.toLowerCase()==='g'||event.shiftKey&&event.key.toLowerCase()==='d')){
      this._startKeyMove(event.shiftKey&&event.key.toLowerCase()==='d');event.preventDefault();event.stopPropagation();return true;
    }
    if(!control&&event.key.toLowerCase()==='b'){this._boxSelectArmed=true;this.scroll.style.cursor='crosshair';this.live.textContent='Drag a box to select keys';event.preventDefault();event.stopPropagation();return true;}
    if(!control&&event.key.toLowerCase()==='a'){
      this._setAnimationSelection(event.altKey?[]:this.tracks.filter(track=>!track.locked).flatMap(track=>track.keys.flatMap(key=>key.refs)));event.preventDefault();event.stopPropagation();return true;
    }
    let command = null;
    if (event.key === 'Escape') { this._boxSelectArmed=false;this._finishChannelGesture(true); this._setAnimationSelection([]); }
    else if (control && event.key.toLowerCase() === 'a') {
      this._setAnimationSelection(this._selectedTrack()?.keys.flatMap(key => key.refs) ?? []);
    } else if (control && ['c', 'x', 'v', 'd'].includes(event.key.toLowerCase())) {
      command = {c: 'copyTrackKeys', v: 'pasteTrackKeys', d: 'duplicateTrackKeys'}[event.key.toLowerCase()];
      if (event.key.toLowerCase() === 'x') { this.copyTrackKeys(); command = 'deleteTrackKeys'; }
    } else if (event.key === 'Delete' || event.key === 'Backspace' || !control && event.key.toLowerCase()==='x') command = 'deleteTrackKeys';
    else if (event.key === 'F6') command = 'addTrackKey';
    else if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      try { this._moveTrackKeys((event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1)); }
      catch (error) { this.onError?.(error); }
    } else if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
      const current = this.tracks.findIndex(track => track.id === this.selectedTrackId);
      const index = clamp(current + (event.key === 'ArrowUp' ? -1 : 1), 0, this.tracks.length - 1);
      const track = this.tracks[index];
      if (track) { this._selectTrack(track); const top = index * ROW_HEIGHT, offset = this._offsetY();
        if (top < offset) this._scrollToY(top); else if (top + ROW_HEIGHT > offset + this.height - RULER_HEIGHT) this._scrollToY(top + ROW_HEIGHT - this.height + RULER_HEIGHT); }
    } else if (event.key === 'Enter') {
      const track = this._selectedTrack(); if (track?.children?.length) this._toggleTrackExpanded(track.id);
    } else if (['PageUp', 'PageDown'].includes(event.key) || event.altKey && [',', '.', '<', '>'].includes(event.key)) {
      const keys = this._selectedTrack()?.keys ?? [], previous = ['PageUp', ',', '<'].includes(event.key);
      const current = keys.findIndex(key => key.id === this._focusedTrackKey?.id && this._focusedTrackKey.trackId === this.selectedTrackId);
      const key = current >= 0 ? keys[current + (previous ? -1 : 1)] : previous ? keys.findLast(item => item.tick < this.editor.tick) : keys.find(item => item.tick > this.editor.tick);
      if (key) {
        this._focusedTrackKey = {id: key.id, trackId: this.selectedTrackId};
        this.editor.seek(key.tick); this._setAnimationSelection(key.refs, {additive: event.shiftKey}); this.onSeek?.(this.editor.tick, this.editor.frameIndex);
        if (key.hidden) this.live.textContent = `Hidden pose key at frame ${key.tick + 1}. Use Restore hidden key from the key menu.`;
      }
    } else if (event.key === 'F7') command = 'insertBlankTrackKey';
    else return false;
    event.preventDefault(); event.stopPropagation();
    if (command) this._runCommand(command);
    return true;
  }

  _previewKeyDelta(delta) {
    const gesture=this._channelGesture;if(!gesture)return;
    gesture.delta=Math.max(-gesture.minimum,delta);gesture.moved=true;
    gesture.invalid=this._keyMoveConflict(gesture.delta,gesture.duplicate);
    this.dragStatus.hidden=false;this.dragStatus.dataset.invalid=String(Boolean(gesture.invalid));
    this.dragStatus.textContent=gesture.invalid||`${gesture.duplicate?'Duplicate':'Move'} ${gesture.delta>=0?'+':''}${gesture.delta} frames · Enter to confirm · Esc to cancel`;
    this._fullDirty=this._headDirty=true;this._schedule();
  }

  _startKeyMove(duplicate=false) {
    const records=this._channelSelectionRecords();if(!records.length)return;
    try{this._assertKeysEditable(records);}catch(error){this.onError?.(error);return;}
    const rect=this.scroll.getBoundingClientRect(),pointer=this._lastPointer??{clientX:rect.left+this.width/2,clientY:rect.top+RULER_HEIGHT+15};
    const hit=this._channelHit(pointer);
    this._channelGesture={kind:'keys',keyboard:true,startX:pointer.clientX,startY:pointer.clientY,startTick:hit.tick,lastEvent:pointer,
      records,minimum:records.reduce((minimum,item)=>Math.min(minimum,item.key.tick),Infinity),delta:0,moved:false,duplicate,collisionPlan:this._keyMovePlan(duplicate)};
    this._previewKeyDelta(0);
  }
  moveKeys() { this._startKeyMove(); }
  duplicateAndMoveKeys() { this._startKeyMove(true); }

  _toggleTrackExpanded(id) {
    if(this.actionMode && this.trackById.get(id)?.kind==='assembly'){
      this.expandedTracks.has(id)?this.expandedTracks.delete(id):this.expandedTracks.add(id);
      this._filterActionTracks();this.resize();this.update();return;
    }
    if(this.actionMode){this.collapsedActions.has(id)?this.collapsedActions.delete(id):this.collapsedActions.add(id);this._filterActionTracks();this.resize();this.update();return;}
    if (this.expandedTracks.has(id)) this.expandedTracks.delete(id); else this.expandedTracks.add(id);
    this._reindex(); this.resize(); this.update();
  }

  restoreHiddenTrackKeys() {
    const hidden = this._channelSelectionRecords().filter(item => item.key.hidden);
    if (hidden.length !== 1) throw new Error('Select one hidden pose key to restore.');
    this.editor.revealAnimationKey(hidden[0].channel.id, hidden[0].key.id, 1);
    return true;
  }

  _drawChannelGrid() {
    const ctx = this.gridContext, w = this.width, h = this.height, sx = this._offsetX(), sy = this._offsetY(), step = this.pxPerTick;
    const firstTick = Math.max(0, Math.floor((sx - LEAD) / step)), lastTick = Math.ceil((sx + w - LEAD) / step);
    const firstRow = Math.max(0, Math.floor(sy / ROW_HEIGHT)), lastRow = Math.min(this.tracks.length, Math.ceil((sy + h - RULER_HEIGHT) / ROW_HEIGHT));
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#f9fafc'; ctx.fillRect(0, 0, w, h);
    ctx.save(); ctx.beginPath(); ctx.rect(0, RULER_HEIGHT, w, h - RULER_HEIGHT); ctx.clip();
    for (let row = firstRow; row < lastRow; row++) {
      const track = this.tracks[row], y = RULER_HEIGHT + row * ROW_HEIGHT - sy, selected = track.id === this.selectedTrackId;
      const group = track.kind !== 'channel';
      const pose = !this.actionMode && (['scene', 'camera', 'layer'].includes(track.kind) || track.property === 'pose');
      ctx.fillStyle = selected ? '#f0f7ff' : track.depth === 0 ? '#f3f5f8' : track.kind === 'channel' ? '#fff' : '#fbfcfe';
      ctx.fillRect(0, y, w, ROW_HEIGHT);
      ctx.fillStyle = track.kind === 'layer' ? '#dce1e8' : '#e9edf2'; ctx.fillRect(0, y + ROW_HEIGHT - 1, w, 1);
      if (track.kind === 'layer') ctx.fillRect(0, y, w, 1);
      let low = 0, high = track.keys.length;
      while (low < high) { const middle = (low + high) >>> 1; if (track.keys[middle].tick < firstTick) low = middle + 1; else high = middle; }
      for (let index = Math.max(0, low - 1); index < track.keys.length; index++) {
        const key = track.keys[index]; if (key.tick > lastTick) break;
        const x = LEAD + (key.tick + .5) * step - sx, next = track.keys[index + 1];
        const active = this._animationKeySelected(key), moving = active && this._channelGesture?.kind === 'keys' && this._channelGesture.moved;
        ctx.globalAlpha = track.locked || track.visible === false ? .4 : 1;
        if (pose) {
          const left = Math.max(0, LEAD + key.tick * step - sx), right = Math.min(w, LEAD + (next?.tick ?? this.editor.totalTicks) * step - sx);
          if (right > left) {
            ctx.fillStyle = active ? '#b9ddfa' : selected ? '#d9e8f5' : '#e0e4e9';
            ctx.fillRect(left, y + 4, right - left, ROW_HEIGHT - 8);
          }
        } else if (next) {
          const end = Math.min(w, LEAD + (next.tick + .5) * step - sx), left = Math.max(0, x + 6);
          if (end > left) {
            ctx.fillStyle = active ? '#9fcdf2' : group ? '#c9d1dd' : '#dfe4ec';
            ctx.fillRect(left, y + ROW_HEIGHT / 2 - (group ? 2 : .5), end - left - 6, group ? 4 : 1);
          }
        }
        if (x >= -7 && x <= w + 7) {
          if (active) { ctx.fillStyle = '#dceeff'; ctx.fillRect(x - Math.max(7, step * .42), y + 3, Math.max(14, step * .84), ROW_HEIGHT - 6); }
          ctx.fillStyle = active ? '#087ed2' : group ? '#78889e' : '#7f8b9e';
          if (moving) ctx.globalAlpha *= .3;
          if (key.blank || key.value?.frameId === null) {
            ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1.6;
            ctx.beginPath(); ctx.arc(x, y + ROW_HEIGHT / 2, group ? 4 : 3.5, 0, Math.PI * 2);
            ctx.fillStyle = active ? '#dceeff' : track.depth === 0 ? '#f3f5f8' : '#fff'; ctx.fill(); ctx.stroke();
          } else if (pose) {
            ctx.beginPath(); ctx.arc(x, y + ROW_HEIGHT / 2, 3.6, 0, Math.PI * 2); ctx.fill();
          } else {
            diamond(ctx, x, y + ROW_HEIGHT / 2, group ? 4.5 : 3.8);
            if (!active) { ctx.fillStyle = track.depth === 0 ? '#f3f5f8' : '#fff'; diamond(ctx, x, y + ROW_HEIGHT / 2, group ? 2.2 : 1.8); }
          }
          if (key.hidden) { ctx.strokeStyle = '#b37836'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(x - 5, y + ROW_HEIGHT / 2 + 5); ctx.lineTo(x + 5, y + ROW_HEIGHT / 2 - 5); ctx.stroke(); }
        }
        ctx.globalAlpha = 1;
      }
      if (this._channelGesture?.kind === 'keys' && this._channelGesture.moved) {
        const delta = this._channelGesture.delta;
        let low = 0, high = track.keys.length;
        while (low < high) { const mid = (low + high) >>> 1; if (track.keys[mid].tick + delta < firstTick - 1) low = mid + 1; else high = mid; }
        for (let index = low; index < track.keys.length; index++) {
          const key = track.keys[index]; if (key.tick + delta > lastTick + 1) break;
          if (!this._animationKeySelected(key)) continue;
          const x = LEAD + (key.tick + delta + .5) * step - sx;
          if (x < -7 || x > w + 7) continue;
          ctx.fillStyle = this._channelGesture.invalid ? '#fff0f0' : '#dceeff'; ctx.fillRect(x - 8, y + 3, 16, ROW_HEIGHT - 6);
          ctx.fillStyle = this._channelGesture.invalid ? '#c44051' : ACCENT; diamond(ctx, x, y + ROW_HEIGHT / 2, 5);
        }
      }
    }
    const major = rulerInterval(step), minor = step >= 8 ? 1 : major;
    for (let tick = Math.floor(firstTick / minor) * minor; tick <= lastTick; tick += minor) {
      const x = Math.round(LEAD + tick * step - sx);
      ctx.fillStyle = tick % major === 0 ? '#76859933' : '#76859914'; ctx.fillRect(x, RULER_HEIGHT, 1, h - RULER_HEIGHT);
    }
    const endX = LEAD + this.editor.totalTicks * step - sx;
    if (endX < w) { ctx.fillStyle = '#edf0f455'; ctx.fillRect(Math.max(0, endX), RULER_HEIGHT, w - endX, h - RULER_HEIGHT); }
    if (this._channelGesture?.rectangle) {
      const rect = this._channelGesture.rectangle, x = rect.left - sx, y = rect.top + RULER_HEIGHT - sy;
      ctx.fillStyle = '#0d99ff18'; ctx.fillRect(x, y, rect.right - rect.left, rect.bottom - rect.top);
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + .5, rect.right - rect.left, rect.bottom - rect.top);
    }
    ctx.restore();
    ctx.fillStyle = '#f5f6f8'; ctx.fillRect(0, 0, w, RULER_HEIGHT);
    ctx.fillStyle = '#dce1e8'; ctx.fillRect(0, RULER_HEIGHT - 1, w, 1);
    ctx.font = "10px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let tick = Math.floor(firstTick / minor) * minor + (minor > 1 ? minor - 1 : 0); tick <= lastTick; tick += minor) {
      const x = LEAD + (tick + .5) * step - sx, numbered = tick === 0 || (tick + 1) % major === 0;
      ctx.fillStyle = numbered ? '#aab2bf' : '#d2d8e1'; ctx.fillRect(Math.round(x), RULER_HEIGHT - (numbered ? 7 : 4), 1, numbered ? 6 : 3);
      if (numbered) { ctx.fillStyle = tick < this.editor.totalTicks ? '#657083' : '#a8afb9'; ctx.fillText(String(tick + 1), x, 11); }
    }
    const loop = this.loopRange;
    if (loop) {
      const left = LEAD + loop.startTick * step - sx, right = LEAD + loop.endTick * step - sx;
      ctx.fillStyle = ACCENT; ctx.fillRect(Math.max(0, left), 0, Math.min(w, right) - Math.max(0, left), 2);
    }
  }

  _drawChannelLabels() {
    if (this._labelMode !== 'channels') {
      for (const node of this.labels) node.remove(); this.labels = []; this._labelMode = 'channels';
      this.labelViewport.setAttribute('role', 'tree'); this.labelViewport.setAttribute('aria-label', 'Animation track hierarchy');
    }
    const sy = this._offsetY(), first = Math.max(0, Math.floor(sy / ROW_HEIGHT));
    const visible = Math.max(0, Math.min(this.tracks.length - first, Math.ceil((this.height - RULER_HEIGHT) / ROW_HEIGHT) + 1));
    for (let slot = 0; slot < visible; slot++) {
      let node = this.labels[slot];
      if (!node) {
        node = element('div', 'styk-timeline-label', this.labelViewport); node.setAttribute('role', 'treeitem');
        const disclosure = element('button', 'styk-timeline-label-disclosure', node); disclosure.type = 'button'; disclosure.tabIndex = -1;
        const select = element('button', 'styk-timeline-label-select', node); select.type = 'button'; select.tabIndex = -1;
        select.innerHTML = '<svg class="styk-timeline-label-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"></svg><span class="styk-timeline-label-name"></span>';
        const visibility = element('button', 'styk-timeline-label-control', node); visibility.type = 'button'; visibility.tabIndex = -1;
        visibility.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M1 8s2-4 7-4 7 4 7 4-2 4-7 4-7-4-7-4Z"/><circle cx="8" cy="8" r="2"/></svg>';
        const lock = element('button', 'styk-timeline-label-control', node); lock.type = 'button'; lock.tabIndex = -1;
        lock.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5"/><path d="M5.5 7V4.5a2.5 2.5 0 0 1 5 0V7"/></svg>';
        this._on(disclosure, 'click', event => { event.stopPropagation(); const track = this.tracks[node._trackIndex]; if (track) this._toggleTrackExpanded(track.id); this.scroll.focus({preventScroll: true}); });
        this._on(select, 'click', event => { event.stopPropagation(); const track = this.tracks[node._trackIndex]; if (track) this._selectTrack(track); this.scroll.focus({preventScroll: true}); });
        this._on(visibility, 'click', event => { event.stopPropagation(); const track = this.tracks[node._trackIndex]; if (track) this.editor.setLayerVisible?.(track.id, track.visible === false); });
        this._on(lock, 'click', event => { event.stopPropagation(); const track = this.tracks[node._trackIndex]; if (track) this.editor.setLayerLocked?.(track.id, !track.locked); });
        this.labels.push(node);
      }
      const index = first + slot, track = this.tracks[index], [disclosure, select, visibility, lock] = node.children;
      node.hidden = false; node._trackIndex = index; node.dataset.trackId = track.id; node.dataset.kind = track.kind;
      node.style.transform = `translateY(${index * ROW_HEIGHT - sy}px)`;
      node.style.paddingLeft = `${5 + (track.depth ?? 0) * 14}px`;
      node.setAttribute('aria-selected', String(track.id === this.selectedTrackId)); node.setAttribute('aria-level', String((track.depth ?? 0) + 1));
      node.setAttribute('aria-label', `${track.name}, ${track.keys.length} keys${track.locked ? ', locked' : ''}`);
      const hasChildren = track.hasChildren ?? Boolean(track.children?.length);
      const expanded=this.actionMode&&track.kind!=='assembly'?!this.collapsedActions.has(track.id):this.expandedTracks.has(track.id);
      if (hasChildren) node.setAttribute('aria-expanded', String(expanded)); else node.removeAttribute('aria-expanded');
      disclosure.style.visibility = hasChildren ? 'visible' : 'hidden'; disclosure.textContent = expanded ? '▾' : '▸';
      disclosure.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${track.name}`);
      if (node._iconKind !== track.kind) { select.children[0].innerHTML = TRACK_ICONS[track.kind] ?? TRACK_ICONS.channel; node._iconKind = track.kind; }
      if (select.children[1].textContent !== track.name) select.children[1].textContent = track.name;
      select.title = track.kind === 'channel' ? `${track.name} · ${track.keys.length} keys` : `${track.name} · ${track.keys.length} keys${track.figureUids ? ` · ${track.figureUids.length} figures` : ''}`;
      const userLayer = track.kind === 'layer'; visibility.hidden = lock.hidden = !userLayer;
      visibility.setAttribute('aria-label', `${track.visible === false ? 'Show' : 'Hide'} ${track.name}`); visibility.setAttribute('aria-pressed', String(track.visible === false));
      lock.setAttribute('aria-label', `${track.locked ? 'Unlock' : 'Lock'} ${track.name}`); lock.setAttribute('aria-pressed', String(Boolean(track.locked)));
    }
    for (let i = visible; i < this.labels.length; i++) this.labels[i].hidden = true;
    if(this.actionMode&&!this.tracks.length){this.empty??=element('div','styk-timeline-empty',this.labelViewport);this.empty.textContent='Select a figure to edit its keys';this.empty.hidden=false;}
    else if (this.empty) this.empty.hidden = true;
  }

  _channelContextMenu(event, preserveSelection = false) {
    event.preventDefault(); event.stopPropagation();
    if (!preserveSelection) {
      const hit = this._channelHit(event);
      if (hit.track) this._selectTrack(hit.track);
      if (hit.key && !this._animationKeySelected(hit.key)) this._setAnimationSelection(hit.key.refs);
    }
    this.menu?.remove();
    this.menu = element('div', 'styk-timeline-menu', document.body); this.menu.setAttribute('role', 'menu'); this.menu.setAttribute('aria-label', 'Track key actions');
    const track = this._selectedTrack(), selected = this.selectedAnimationKeys.length > 0;
    const hiddenCount = this._channelSelectionRecords().filter(item => item.key.hidden).length;
    element('div', 'styk-timeline-menu-label', this.menu).textContent = track?.name ?? 'Timeline';
    for (const [command, name, shortcut, enabled] of [
      ['addTrackKey', 'Insert key at playhead', 'F6', this._canInsertTrackKey(track)],
      ['insertBlankTrackKey', 'Insert blank pose key', 'F7', this._blankPoseTarget(track) && !track?.locked],
      ['requestInsertInbetween', 'Insert document inbetween…', '', Boolean(this.onInsertInbetween) && this.editor.frameIndex > 0],
      ['moveKeys', 'Move keys', 'G', selected && !track?.locked],
      ['showEasingPopover', 'Keyframe easing…', '', selected && !track?.locked],
      ['showKeyMoveDialog', 'Move selected keys…', '', selected && !track?.locked],
      ['showKeyScaleDialog', 'Scale timing…', '', selected && !track?.locked],
      [this.actionMode?'duplicateAndMoveKeys':'duplicateTrackKeys', 'Duplicate selected keys', this.actionMode?'Shift+D':'Ctrl+D', selected && !track?.locked],
      ['deleteTrackKeys', 'Delete selected keys', 'Delete', selected && !track?.locked],
      ['restoreHiddenTrackKeys', 'Restore hidden key', '', hiddenCount === 1 && !track?.locked],
      ['', '', '', true],
      ['copyTrackKeys', 'Copy property keys', 'Ctrl+C', selected],
      ['pasteTrackKeys', 'Paste property keys at playhead', 'Ctrl+V', Boolean(this._keyClipboard?.entries.length)],
      ['', '', '', true],
      ['frames', 'Edit document frames', '', true],
    ].filter(([command])=>!this.actionMode||!['frames','requestInsertInbetween'].includes(command))) {
      if (!command) { element('div', 'styk-timeline-menu-separator', this.menu).setAttribute('role', 'separator'); continue; }
      const button = element('button', '', this.menu); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.setAttribute('aria-label', name); button.disabled = !enabled;
      element('span', '', button).textContent = name; element('kbd', '', button).textContent = shortcut;
      button.addEventListener('click', () => { this.menu.hidden = true; if (command === 'frames') this.setMode('frames'); else this._runCommand(command); if (!this.dialog?.open) this.scroll.focus({preventScroll: true}); });
    }
    this.menu.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); this.menu.hidden = true; this.scroll.focus(); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); const buttons = [...this.menu.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    });
    this.menu.style.left = `${clamp(event.clientX, 8, window.innerWidth - 232)}px`;
    this.menu.style.top = `${clamp(event.clientY, 8, window.innerHeight - this.menu.offsetHeight - 8)}px`;
    this.menu.querySelector('button:not(:disabled)')?.focus();
  }

  _createDialog(...args) { return createTimelineDialog.call(this, ...args); }

  showEasingPopover() { return showKeyframeEasingPopover.call(this); }

  showTimingDialog() {
    const indices = this.selectedFrameIndices;
    if (!indices.length) return;
    const firstDuration = Number(this.editor.report.keyframes[indices[0]].duration_raw ?? 1);
    const mixed = indices.some(index => Number(this.editor.report.keyframes[index].duration_raw ?? 1) !== firstDuration);
    const ui = this._createDialog('Keyframe timing', `${indices.length} keyframe${indices.length === 1 ? '' : 's'} selected`, 'Apply timing');
    const fields = element('div', 'styk-timeline-fields', ui.content);
    const durationLabel = element('label', '', fields); durationLabel.textContent = 'Exposure frames';
    const duration = element('input', '', durationLabel);
    duration.type = 'number'; duration.min = '0'; duration.max = '65535'; duration.step = '1';
    duration.required = true; duration.placeholder = mixed ? 'Mixed' : ''; duration.value = mixed ? '' : String(firstDuration);
    const inbetweenLabel = element('label', '', fields); inbetweenLabel.textContent = 'Inbetweens';
    const inbetweens = element('input', '', inbetweenLabel);
    inbetweens.type = 'number'; inbetweens.min = '-1'; inbetweens.max = '65534'; inbetweens.step = '1';
    inbetweens.placeholder = mixed ? 'Mixed' : ''; inbetweens.value = mixed ? '' : String(firstDuration - 1);
    const setValue = ticks => {
      duration.value = String(ticks); inbetweens.value = String(ticks - 1);
      ui.apply.disabled = !Number.isInteger(ticks) || ticks < 0 || ticks > 65535;
      ui.error.textContent = '';
    };
    duration.addEventListener('input', () => {
      const value = duration.valueAsNumber;
      inbetweens.value = Number.isFinite(value) ? String(value - 1) : '';
      ui.apply.disabled = !Number.isInteger(value) || value < 0 || value > 65535;
    });
    inbetweens.addEventListener('input', () => {
      const value = inbetweens.valueAsNumber;
      duration.value = Number.isFinite(value) ? String(value + 1) : '';
      ui.apply.disabled = !Number.isInteger(value) || value < -1 || value > 65534;
    });
    const presets = element('div', 'styk-timeline-presets', ui.content);
    presets.setAttribute('aria-label', 'Duration presets');
    for (const ticks of [1, 2, 4, 8, 12, 24]) {
      const button = element('button', '', presets); button.type = 'button'; button.textContent = String(ticks);
      button.setAttribute('aria-label', `${ticks} exposure frames`); button.addEventListener('click', () => setValue(ticks));
    }
    duration.title = 'Duration includes the starting pose and its inbetweens. Set 0 to skip playback.' +
      (this.editor.report.version >= 5 ? ' Pivot plays the final keyframe for one frame.' : '');
    inbetweens.title = 'The frames between keyframes. Set −1 to skip playback.';
    ui.apply.disabled = mixed;
    ui.form.addEventListener('submit', event => {
      event.preventDefault();
      try {
        const value = duration.valueAsNumber;
        if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('Use a whole number from 0 to 65,535.');
        this.editor.setFramesDuration(indices, value);
        ui.dialog.close();
        this.live.textContent = `${indices.length} keyframes set to ${value} exposure frames`;
      } catch (error) { ui.error.textContent = error.message; }
    });
    ui.dialog.showModal(); duration.focus(); duration.select();
  }

  showBakeDialog() {
    const indices = this.selectedFrameIndices;
    if (!indices.length) return;
    const generated = indices.reduce((sum, index) => sum + Math.max(1, this.exposures[index]?.count ?? 0), 0);
    const ui = this._createDialog('Bake inbetweens', `${indices.length} keyframes → ${generated.toLocaleString()} keyframes`, 'Bake keyframes');
    ui.apply.title = 'Make generated poses editable. Preserve figures, cameras, backgrounds, and hidden frames.';
    if (this.editor.report.auto_easing && indices.length !== this.editor.report.keyframes.length) {
      const note = element('p', 'styk-timeline-dialog-note', ui.content);
      note.textContent = 'Automatic easing: select a complete tween run.';
    }
    let busy = false;
    ui.dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    ui.form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      ui.apply.disabled = ui.cancel.disabled = true; ui.apply.textContent = 'Baking…';
      try {
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        if (this._destroyed || !ui.dialog.open) return;
        const count = this._bakeIndices(indices);
        ui.dialog.close();
        this.live.textContent = `${count} baked keyframes ready to edit`;
      } catch (error) {
        busy = false;
        ui.error.textContent = error.message;
        ui.apply.disabled = ui.cancel.disabled = false; ui.apply.textContent = 'Bake keyframes';
      }
    });
    ui.dialog.showModal(); ui.apply.focus();
  }

  _contextMenu(event, preserveSelection = false) {
    if (this.channelMode) return this._channelContextMenu(event, preserveSelection);
    event.preventDefault(); event.stopPropagation();
    const rect = this.scroll.getBoundingClientRect();
    const tick = clamp(Math.floor((event.clientX - rect.left + this._offsetX() - LEAD) / this.pxPerTick), 0, Math.max(0, this.editor.totalTicks - 1));
    let low = 0, high = Math.max(0, this.exposures.length - 1);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.exposures[middle].start <= tick) low = middle;
      else high = middle - 1;
    }
    if (!preserveSelection && !this._hasSelectedFrame(low)) {
      this.editor.seek(tick); this.onSeek?.(tick, this.editor.frameIndex);
      this._setRange(this.editor.frameIndex);
    }
    if (!this.menu) {
      this.menu = element('div', 'styk-timeline-menu', document.body);
      this.menu.setAttribute('role', 'menu');
      this.menu.setAttribute('aria-label', 'Keyframe actions');
      this.menuHeading = element('div', 'styk-timeline-menu-label', this.menu);
      const modifier = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+';
      for (const [name, label, shortcut] of [
        ['insertBlankKeyframe', 'Insert blank keyframe', 'F7'],
        ['requestInsertInbetween', 'Insert inbetween…', ''],
        ['duplicateSelection', 'Duplicate keyframes', `${modifier}D`],
        ['showEasingPopover', 'Keyframe easing…', ''],
        ['showTimingDialog', 'Keyframe timing…', ''],
        ['showBakeDialog', 'Bake inbetweens…', ''],
        ['', '', ''],
        ['copySelection', 'Copy keyframes', `${modifier}C`],
        ['cutSelection', 'Cut keyframes', `${modifier}X`],
        ['pasteSelection', 'Paste after playhead', `${modifier}V`],
        ['reverseSelection', 'Reverse keyframes', ''],
        ['deleteSelection', 'Delete keyframes', 'Del'],
        ['', '', ''],
        ['setLoopToSelection', 'Loop selected range', ''],
        ['clearLoopRange', 'Clear playback range', ''],
      ]) {
        if (!name) { const separator = element('div', 'styk-timeline-menu-separator', this.menu); separator.setAttribute('role', 'separator'); continue; }
        const button = element('button', '', this.menu);
        button.type = 'button'; button.dataset.command = name; button.setAttribute('role', 'menuitem');
        const text = element('span', '', button); text.textContent = label;
        const key = element('kbd', '', button); key.textContent = shortcut;
        this._on(button, 'click', () => {
          this.menu.hidden = true;
          this._runCommand(name);
          if (!this.dialog?.open) this.scroll.focus({preventScroll: true});
        });
      }
      this._on(this.menu, 'keydown', event => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault(); this.menu.hidden = true; this.scroll.focus({preventScroll: true});
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const buttons = [...this.menu.querySelectorAll('button:not(:disabled)')];
          const current = buttons.indexOf(document.activeElement);
          const next = (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      });
    }
    const [selectedFirst, selectedLast] = this._rangeBounds(), count = this._selectionCount();
    this.menuHeading.textContent = `${count} KEYFRAME${count === 1 ? '' : 'S'} SELECTED`;
    let hasInbetweens = false;
    for (let index = selectedFirst; index <= selectedLast; index++) {
      if (this._hasSelectedFrame(index) && this.exposures[index]?.count > 1) { hasInbetweens = true; break; }
    }
    const required = {insertBlankKeyframe: 'insertBlankFrame', duplicateSelection: 'duplicateFrames',
      showTimingDialog: 'setFramesDuration', showBakeDialog: 'bakeFrames', copySelection: 'copyFrames',
      cutSelection: 'cutFrames', pasteSelection: 'pasteFrames', reverseSelection: 'reverseFrames', deleteSelection: 'deleteFrames'};
    for (const button of this.menu.querySelectorAll('button')) {
      const command = button.dataset.command;
      button.disabled = Boolean(required[command] && typeof this.editor[required[command]] !== 'function') ||
        (command === 'pasteSelection' && !this.editor.hasFrameClipboard) ||
        (count === 0 && ['copySelection', 'cutSelection', 'reverseSelection', 'deleteSelection', 'duplicateSelection', 'showTimingDialog', 'showBakeDialog', 'setLoopToSelection'].includes(command)) ||
        (command === 'reverseSelection' && count < 2) ||
        (command === 'showBakeDialog' && !hasInbetweens) ||
        (command === 'requestInsertInbetween' && (!this.onInsertInbetween || !this.selectedFrameIndices.some(index => index > 0))) ||
        (command === 'clearLoopRange' && !this.loopRange) ||
        (command === 'setLoopToSelection' && (this._selectionRuns?.length > 1 || this.exposures[selectedLast].start + this.exposures[selectedLast].count <= this.exposures[selectedFirst].start));
    }
    this.menu.hidden = false;
    this.menu.style.left = `${clamp(event.clientX, 8, window.innerWidth - 232)}px`;
    this.menu.style.top = `${clamp(event.clientY, 8, window.innerHeight - this.menu.offsetHeight - 8)}px`;
    this.menu.querySelector('button:not(:disabled)')?.focus();
  }

  destroy() {
    if (this._destroyed) return;
    this._finishChannelGesture(true); this._finishScrub(true);
    this._destroyed = true;
    this._observer.disconnect();
    this._listeners.forEach(remove => remove());
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._pointerRaf) cancelAnimationFrame(this._pointerRaf);
    this.menu?.remove();
    this.dialog?.close(); this.easingPopover?.hidePopover();
    this.root.remove();
    this.labels = []; this.tracks = [];
  }
}
