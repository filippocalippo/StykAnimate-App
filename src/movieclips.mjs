/** Movieclip assets are immutable figure definitions. Scene poses contain only
 * a small playback descriptor; sampled scenes and geometry never enter history. */
export const MOVIECLIP_VERSION = 1;
export const isMovieclip = figure => Boolean(figure?._styk?.movieclip);
export const movieclipAsset = figure => figure?._styk?.movieclip;
const typeIndices = new WeakMap();
const sourceDocuments=new WeakMap();
export function movieclipSourceDocument(report){
  const descriptor=report._styk?.movieclipSource;
  if(!descriptor)return null;
  if(!descriptor.inheritFigures)return descriptor.document;
  let cached=sourceDocuments.get(descriptor);
  if(!cached||cached.figures!==report.figure_types){cached={figures:report.figure_types,document:{...descriptor.document,figure_types:report.figure_types}};sourceDocuments.set(descriptor,cached);}
  return cached.document;
}
export function movieclipTypes(report) {
  const figures = report.figure_types ?? [];
  let index = typeIndices.get(figures);
  if (!index || index.length !== figures.length || index.entries.some(([i, figure]) => figures[i] !== figure)) {
    const entries = [];
    figures.forEach((figure, i) => { if (isMovieclip(figure)) entries.push([i, figure]); });
    index = {length: figures.length, entries, types: new Map(entries.map(([, figure]) => [figure.figure_type_id, figure]))};
    typeIndices.set(figures, index);
  }
  return index.types;
}
export function invalidateMovieclipTypes(report) { typeIndices.delete(report.figure_types); }
export function* movieclipSourceFrames(report){
  let source=report._styk?.movieclipSource?.document,sourceDepth=1;
  while(source){
    for(let index=0;index<source.keyframes.length;index++)yield {frame:source.keyframes[index],index,sourceDepth};
    for(const [sourceId,frame] of Object.entries(source._styk?.frameSources??{}))yield {frame,index:-1,sourceId,sourceDepth};
    source=source._styk?.movieclipSource?.document;sourceDepth++;
  }
}
export function movieclipAssetFigures(figure){
  const figures=[],documents=new Set(),queue=[figure];
  for(let i=0;i<queue.length;i++){
    const f=queue[i];figures.push(f);const document=movieclipAsset(f)?.document;
    if(document&&!documents.has(document)){documents.add(document);queue.push(...document.figure_types);}
  }
  return figures;
}
/** Upgrade the early placement descriptors once on load. Legacy restart poses
 * changed `start`; reconstruct phase keys without moving the container. */
export function normalizeLegacyMovieclips(report,rows,total){
  const types=movieclipTypes(report);if(!types.size)return;
  const frames=[...report.keyframes,...Object.values(report._styk?.frameSources??{})],byFrame=new Map(frames.map(frame=>[frame._styk?.frameId,frame]));
  const objects=new Map();
  for(const frame of frames)for(const object of frame.objects)if(types.has(object.figure_type_id)){
    const list=objects.get(object.unique_id)??[];list.push(object);objects.set(object.unique_id,list);
  }
  const poses=new Map((report._styk?.animation?.channels??[]).filter(c=>c.property==='pose'&&c.target.kind==='figure').map(c=>[c.target.uid,c]));
  for(const [uid,instances] of objects){
    const owner=poses.get(uid),keys=(owner?.keys??[]).flatMap(key=>{const object=byFrame.get(key.value?.frameId)?.objects.find(o=>o.unique_id===uid);return object?[{key,object}]:[];});
    const base=playbackSettings(keys[0]?.object??instances[0]);
    let end=base.end;
    if(end===null){
      end=owner?.keys.find(k=>k.tick>base.start&&k.value?.frameId===null)?.tick;
      if(end===undefined&&!owner){
        let index=rows.findLastIndex(row=>row.start<=base.start);
        for(let i=Math.max(0,index);i<rows.length;i++){if(!report.keyframes[i].objects.some(o=>o.unique_id===uid))break;end=rows[i].start+rows[i].count;}
      }
      end=Math.max(base.start+1,end??total);
    }
    const phases=new Map((base.restarts??[]).map(key=>[key.tick,key]));
    for(const {key,object} of keys){const p=playbackSettings(object);if(!p.restarts&&p.start>base.start&&p.start===key.tick)phases.set(key.tick,{tick:key.tick,offset:p.offset});}
    const legacyRestart=phases.size>(base.restarts?.length??0);
    if(base.end===null||legacyRestart)for(const object of instances)object._stykMovieclip=legacyRestart?
      {...base,end,restarts:[...phases.values()].sort((a,b)=>a.tick-b.tick)}:{...playbackSettings(object),end};
  }
}
export function playbackSettings(object, defaults = {}) {
  return {start: 0, end: null, offset: 0, speed: 1, mode: 'loop', ...defaults, ...object?._stykMovieclip};
}
export function validatePlayback(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid movieclip playback.');
  const value = playbackSettings({_stykMovieclip: settings});
  if (!['loop','once','hold','single'].includes(value.mode)) throw new Error('Invalid movieclip playback mode.');
  if (!Number.isInteger(value.start) || value.start < 0 || value.start > 10000000 ||
      value.end !== null && (!Number.isInteger(value.end) || value.end <= value.start || value.end > 10000001))
    throw new Error('Movieclip placement must have a valid start and end.');
  if (!Number.isFinite(value.offset) || value.offset < 0 || value.offset > 10000000 ||
      !Number.isFinite(value.speed) || value.speed <= 0 || value.speed > 100)
    throw new Error('Movieclip offset or speed is outside the supported range.');
  if (value.restarts !== undefined && (!Array.isArray(value.restarts) || value.restarts.length > 100000 || value.restarts.some((key,i) =>
    !Number.isInteger(key.tick) || key.tick < 0 || key.tick > 10000000 || !Number.isFinite(key.offset) || key.offset < 0 || key.offset > 10000000 || i > 0 && key.tick <= value.restarts[i-1].tick)))
    throw new Error('Invalid movieclip restart keys.');
  return value;
}
export function movieclipSourceTime(asset, settings, tick, fps) {
  const keys=settings.restarts??[];let low=0,high=keys.length;
  while(low<high){const mid=(low+high)>>>1;if(keys[mid].tick<=tick)low=mid+1;else high=mid;}
  const phase=low?keys[low-1]:{tick:settings.start,offset:settings.offset};
  return settings.mode==='single'?phase.offset:phase.offset+(tick-phase.tick)*settings.speed*asset.document.fps/fps;
}
export function movieclipTime(asset, settings, tick, fps) {
  if (tick < settings.start || settings.end !== null && tick >= settings.end) return null;
  const duration = asset.duration;
  const raw = movieclipSourceTime(asset, settings, tick, fps);
  if (settings.mode === 'loop') return ((raw % duration) + duration) % duration;
  if (settings.mode === 'once' && raw >= duration) return null;
  return Math.max(0, Math.min(duration - 1, raw));
}
export function sampleMovieclipObjects(report, frame, tick, resolveGeometry) {
  const types = movieclipTypes(report);
  if (!types.size) return frame;
  let changed = false;
  const objects = frame.objects.map(object => {
    const figure = types.get(object.figure_type_id); if (!figure) return object;
    changed = true;
    const local = movieclipTime(movieclipAsset(figure), playbackSettings(object), tick, report.fps);
    return {...object, _movieclipSample: local};
  });
  if(!changed)return frame;
  const hidden=objects.some(object=>object._movieclipSample===null);
  if(!hidden)return {...frame,objects};
  const slots=new Map();objects.forEach((object,slot)=>{if(object._movieclipSample!==null)slots.set(slot,slots.size);});
  let geometry;
  const visible=objects.flatMap((object,slot)=>{
    if(!slots.has(slot))return [];
    const next={...object,object_slot:slots.get(slot)};
    if(object.join){
      const parent=slots.get(object.join.target_object_slot);
      if(parent!==undefined)next.join={...object.join,target_object_slot:parent};
      else{geometry??=resolveGeometry?.(report,{...frame,objects});const root=geometry?.objects.get(slot)?.root;
        if(root){next.root_x=root.x;next.root_y=root.y;}next.join=null;delete next.runtime_segments;}
    }
    return [next];
  });
  const order=(frame.object_draw_order??objects.map((_,i)=>i)).filter(slot=>slots.has(slot)).map(slot=>slots.get(slot));
  return {...frame,objects:visible,object_count:visible.length,object_draw_order:order,object_draw_order_unique_ids:order.map(slot=>visible[slot].unique_id)};
}
export function movieclipFigure(id, name, document, {duration, sourceStart = 0, pivot = {x: 0, y: 0}} = {}) {
  return {figure_type_id: id, name, segment_count: 1,
    segments: [{segment_id: 1, parent_id: 0, length: 40, angle_rad: 0, thickness: 0,
      bend_rad: 0, primitive_code: 0, aux_code: 0, flags: 0, segment_type: 'line',
      segment_kind: 'line', color_rgb: [0,0,0], transparency: 0, visible: false, z_order: 1}],
    polyfills: [], image_assets: [], text_assets: [],
    _styk: {movieclip: {version: MOVIECLIP_VERSION, document, duration, sourceStart, pivot}}};
}
/** Reject graph cycles and oversized nesting before recursive scene validation. */
export function validateMovieclipGraph(report) {
  const visiting = new Set(), visited = new Set(); let assets = 0;
  function visit(document, depth) {
    if(!document || typeof document!=='object' || !Array.isArray(document.figure_types))throw new Error('Invalid movieclip document.');
    if (visiting.has(document) || depth > 8) throw new Error('Movieclips contain a cycle or exceed eight nested levels.');
    if (visited.has(document)) return;
    visiting.add(document);
    if (document._styk?.movieclipSource?.document) visit(document._styk.movieclipSource.document, depth + 1);
    for (const figure of document.figure_types ?? []) {
      const asset = movieclipAsset(figure); if (!asset) continue;
      if (++assets > 4096) throw new Error('Movieclip asset limit exceeded.');
      if (asset.version !== MOVIECLIP_VERSION || !asset.document || !Number.isInteger(asset.duration) || asset.duration < 1 || asset.duration > 10000000 ||
          !Number.isInteger(asset.sourceStart) || asset.sourceStart < 0 || !Number.isFinite(asset.pivot?.x) || !Number.isFinite(asset.pivot?.y))
        throw new Error('Invalid movieclip asset.');
      if (figure.segments?.length !== 1) throw new Error('Movieclip containers require one transform handle.');
      visit(asset.document, depth + 1);
    }
    visiting.delete(document); visited.add(document);
  }
  visit(report, 0);
}
