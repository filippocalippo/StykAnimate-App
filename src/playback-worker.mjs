import { PlaybackResources } from './playback-resources.mjs';
export { PlaybackResources } from './playback-resources.mjs';
import { evaluatedFrame, timeline, buildGeometry, drawGeometry, invalidateEvaluationCaches } from './pivot/geometry.mjs';
import { compileVectorObject, requiresCompatibilityTexture, objectBounds, cameraMatrix, shapeRecord, SHAPE, SHAPE_FLOATS } from './renderer-geometry.mjs';
import { applyDocumentChunk } from './document-transport.mjs';
import { applyPlaybackPatch } from './playback-patch.mjs';
import {PlaybackPlanningService} from './playback-planning.mjs';
import {storedFrameReport} from './pivot-frame-draft.mjs';
import { RasterSurfacePool } from './raster-surfaces.mjs';
import {ArtworkRegistry} from './render-artwork.mjs';
import {PlaybackGeometryCache} from './playback-geometry-cache.mjs';
import {PlaybackTweenCache} from './playback-tween-cache.mjs';
const fallbackRasterSurfaces = new RasterSurfacePool();

function refreshSampling(snapshot) {
  snapshot.sampleReport = snapshot.storedFrames ? storedFrameReport(snapshot.report) : snapshot.report;
  snapshot.entries = timeline(snapshot.sampleReport); return snapshot;
}

/** Exact native tick lookup, including disabled (zero-duration) keyframes. */
export function playbackLocation(entries, tick) {
  let low = 0, high = entries.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (entries[mid].start <= tick) low = mid; else high = mid - 1; }
  const entry = entries[low];
  return { index: low, t: entry?.count > 1 ? (tick - entry.start) / entry.count : 0 };
}

/** Prepared frames always clip to the native artboard. Invert that rectangle into
 * world space; its AABB conservatively includes every visible rotated-camera pixel. */
export function playbackVisibleBounds(report, frame, cameraEnabled = true) {
  const [a, b, c, d, e, f] = cameraMatrix({ report, frame, cameraEnabled });
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || !determinant) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of [[0, 0], [report.canvas_width, 0], [0, report.canvas_height], [report.canvas_width, report.canvas_height]]) {
    const wx = (d * (x - e) - c * (y - f)) / determinant;
    const wy = (-b * (x - e) + a * (y - f)) / determinant;
    x0 = Math.min(x0, wx); x1 = Math.max(x1, wx); y0 = Math.min(y0, wy); y1 = Math.max(y1, wy);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Retain the original object's pixel grid and resolution while allocating only
 * the visible subset. Two guard pixels preserve bilinear filtering and antialiasing. */
export function playbackRasterBounds(bounds, visible, resolution, maxTextureDimension = 4096) {
  const pixelScale = Math.min(resolution, maxTextureDimension / bounds.width, maxTextureDimension / bounds.height);
  const fullWidth = Math.max(1, Math.ceil(bounds.width * pixelScale)), fullHeight = Math.max(1, Math.ceil(bounds.height * pixelScale));
  const x0 = visible ? Math.max(0, Math.floor((visible.x - bounds.x) * pixelScale) - 2) : 0;
  const y0 = visible ? Math.max(0, Math.floor((visible.y - bounds.y) * pixelScale) - 2) : 0;
  const x1 = visible ? Math.min(fullWidth, Math.ceil((visible.x + visible.width - bounds.x) * pixelScale) + 2) : fullWidth;
  const y1 = visible ? Math.min(fullHeight, Math.ceil((visible.y + visible.height - bounds.y) * pixelScale) + 2) : fullHeight;
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: bounds.x + x0 / pixelScale, y: bounds.y + y0 / pixelScale,
    width: (x1 - x0) / pixelScale, height: (y1 - y0) / pixelScale,
    pixelWidth: x1 - x0, pixelHeight: y1 - y0, pixelScale, fullPixels: fullWidth * fullHeight };
}

/** A compact immutable render packet. No scene graph is sent for vector figures. */
export async function compilePlaybackPacket(report, tick, { revision = 1, scale = 1, entries, sampleReport, resources, maxTextureDimension = 4096, maxPacketBytes = 128 * 1024 * 1024, cameraEnabled = true, storedFrames = false, sharedArtwork = true, artworkRegistry, geometryCache, tweenCache, cancelled = () => false } = {}) {
  if (typeof cameraEnabled !== 'boolean') throw new TypeError('Playback camera mode must be a boolean.');
  if (typeof storedFrames !== 'boolean') throw new TypeError('Playback stored-frame mode must be a boolean.');
  report = sampleReport || (storedFrames ? storedFrameReport(report) : report); entries ??= timeline(report);
  const started = performance.now(), location = playbackLocation(entries, tick);
  const native = evaluatedFrame(report, location.index, location.t, tick, {tweenCache}), evaluated = performance.now();
  if (!native) throw new Error('The playback tick has no native frame.');
  const geometry = geometryCache?geometryCache.get(report,native,revision):buildGeometry(report, native), geometrized = performance.now();
  const frame = { camera: native.camera, background_id: native.background_id, background_id_b: native.background_id_b, background_mix: native.background_mix, duration_raw: native.duration_raw,
    ...(native._stykBackgroundColor !== undefined ? {_stykBackgroundColor: native._stykBackgroundColor} : {}) };
  const groups = [], compatibility = [], chunks = [], transforms = [0, 0, 1, 1], uids = [0];
  const matrix = cameraMatrix({ report, frame, cameraEnabled, view: { scale } });
  const resolution = Math.max(.5, Math.min(8, 2 ** Math.ceil(Math.log2(Math.hypot(matrix[0], matrix[1]) || 1))));
  const visibleBounds = playbackVisibleBounds(report, frame, cameraEnabled);
  const clipping = { culledObjects: 0, originalPixels: 0, retainedPixels: 0 };
  // Each unique bitmap has one packet owner and one transferable, even when
  // several ordered instances draw it. Camera crops are part of its identity.
  const artworks=sharedArtwork?(artworkRegistry||new ArtworkRegistry()):null,rasters=new Map();
  artworks?.begin();
  const sharing={reusedInstances:0,savedBitmapBytes:0,rasterCacheHits:0,rasterCacheMisses:0};
  const initialRasterHits=resources?.artworkBitmaps?.hits||0,initialRasterMisses=resources?.artworkBitmaps?.misses||0;
  let shapeCount = 0, bitmapBytes = 0;
  const requireBudget = bytes => { if (bytes > maxPacketBytes) { const error = new Error('A playback frame exceeds its preparation memory budget.'); error.code = 'playback_frame_budget'; throw error; } };
  // buildGeometry emits every object's primitives contiguously in native painter order.
  let priorSlot, items = [];
  const append = async () => {
    if (!items.length) return;
    if (cancelled()) throw new DOMException('Playback preparation was superseded.', 'AbortError');
    const g = geometry.objects.get(priorSlot), transformIndex = uids.length;
    if (!g) return;
    // Native object groups are contiguous. Keep the object's immutable array
    // identity so unchanged geometry also retains its exact artwork signature.
    items=g.drawables;
    const uid = g.obj.unique_id ?? g.slot;
    const group = { firstInstance: shapeCount, instanceCount: 0, transformIndex, uid, slot: priorSlot };
    let data;
    let descriptor=resources?.geometryDescriptors?.get(g);
    if(!descriptor){descriptor={compatibility:requiresCompatibilityTexture(items),hasImages:items.some(item=>item.type==='image')};resources?.geometryDescriptors?.set(g,descriptor);}
    if (descriptor.compatibility) {
      if (items.every(item => item.opacity <= 0)) { clipping.culledObjects++; return; }
      group.compatibilityIndex = compatibility.length;
      if (typeof OffscreenCanvas !== 'undefined') {
        if(descriptor.hasImages)await resources?.preload(items);
        if(!descriptor.bounds)descriptor.bounds=objectBounds(items,resources);
        const bounds = playbackRasterBounds(descriptor.bounds, visibleBounds, resolution, maxTextureDimension);
        if (!bounds) { clipping.culledObjects++; return; }
        const { pixelScale, pixelWidth: width, pixelHeight: height } = bounds;
        clipping.originalPixels += bounds.fullPixels; clipping.retainedPixels += width * height;
        const artwork=artworks?.get(g,items),cropKey=JSON.stringify([bounds.x-g.root.x,bounds.y-g.root.y,width,height,pixelScale]);
        const variants=artwork&&rasters.get(artwork),shared=variants?.get(cropKey);
        if(shared!==undefined){
          group.compatibilityIndex=shared;sharing.reusedInstances++;sharing.savedBitmapBytes+=width*height*4;
        }else{
        requireBudget(bitmapBytes + width * height * 4 + (shapeCount + 1) * SHAPE_FLOATS * 4 + (groups.length + 1) * 84);
        const rasterKey=artwork?`${await artworks.contentKey(artwork)}:${cropKey}`:undefined;
        if(cancelled())throw new DOMException('Playback preparation was superseded.', 'AbortError');
        const pool = resources?.rasterSurfaces || fallbackRasterSurfaces;
        const rasterize=()=>{
        const {surface, context: ctx} = pool.acquire(width, height);
        try {
          ctx.setTransform(pixelScale, 0, 0, pixelScale, -bounds.x * pixelScale, -bounds.y * pixelScale);
          drawGeometry(ctx, { drawables: items }, resources);
          return surface.transferToImageBitmap();
        } finally { pool.release(); }
        };
        const bitmap=resources?.artworkBitmaps?await resources.artworkBitmaps.packetBitmap(rasterKey,rasterize):rasterize();
        const actualBounds = { x: bounds.x, y: bounds.y, width: width / pixelScale, height: height / pixelScale };
        bitmapBytes += bitmap.width * bitmap.height * 4;
        // Ownership supplies its epoch in bitmapKey(); this key describes pixels
        // alone so unchanged artwork can share across retained frame revisions.
        const artworkKey=rasterKey||undefined;
        compatibility.push({ bitmap, bounds: actualBounds, root: g.root, resolution, pixelScale, uid, artworkKey });
        if(artwork){const next=variants||new Map();next.set(cropKey,group.compatibilityIndex);rasters.set(artwork,next);}
        }
        const raster=compatibility[group.compatibilityIndex],b=raster.bounds,origin=raster.root;
        data = new Float32Array(shapeRecord({ a: [b.x-origin.x,b.y-origin.y,b.x+b.width-origin.x,b.y+b.height-origin.y], mode: SHAPE.TEXTURE, color: [1, 1, 1, 1], transform: transformIndex }));
      } else {
        // Explicit compatibility path for runtimes without worker OffscreenCanvas.
        compatibility.push({ g, items, root: g.root, resolution, uid });
        data = new Float32Array(shapeRecord({ mode: SHAPE.TEXTURE, color: [1, 1, 1, 1], transform: transformIndex }));
      }
    } else data = compileVectorObject(items, g.root, transformIndex);
    group.instanceCount = data.length / SHAPE_FLOATS; shapeCount += group.instanceCount;
    requireBudget(bitmapBytes + shapeCount * SHAPE_FLOATS * 4 + (groups.length + 1) * 84);
    chunks.push(data); groups.push(group); transforms.push(g.root.x, g.root.y, 1, 1); uids.push(uid);
  };
  try {
    for (const s of geometry.drawables) {
      if (priorSlot !== s.slot) { await append(); items = []; priorSlot = s.slot; }
      items.push(s);
    }
    await append();
    const shapes = new Float32Array(shapeCount * SHAPE_FLOATS); let offset = 0;
    for (const chunk of chunks) { shapes.set(chunk, offset); offset += chunk.length; }
    const transformData = new Float32Array(transforms), uidData = new Uint32Array(uids);
    const fallbackBytes = compatibility.some(entry => !entry.bitmap) ? JSON.stringify(compatibility).length * 2 : 0;
    const ended = performance.now();
    sharing.rasterCacheHits=(resources?.artworkBitmaps?.hits||0)-initialRasterHits;
    sharing.rasterCacheMisses=(resources?.artworkBitmaps?.misses||0)-initialRasterMisses;
    return { key: `${revision}:${tick}`, revision, tick, frameIndex: location.index, frame, shapes, transforms: transformData, uids: uidData, groups, compatibility,
      objectCount: geometry.objects.size, shapeCount, warnings: geometry.warnings, scale, resolution, clipping, sharing, reusedGeometryObjects:geometryCache?.reusedObjects||0, cameraEnabled, storedFrames,
      workerCache: {rasterBytes:resources?.artworkBitmaps?.bytes||0,rasterEntries:resources?.artworkBitmaps?.entries.size||0,
        alternateDrawables:geometryCache?.alternateDrawables||0,tweenEntries:tweenCache?.entries.size||0},
      byteLength: shapes.byteLength + transformData.byteLength + uidData.byteLength + bitmapBytes + fallbackBytes + groups.length * 64,
      compileMs: ended - started, timings: { evaluateMs: evaluated - started, geometryMs: geometrized - evaluated, compileMs: ended - geometrized } };
  } catch (error) { for (const entry of compatibility) entry.bitmap?.close(); throw error; }
}

export function packetTransferables(packet) {
  return [packet.shapes.buffer, packet.transforms.buffer, packet.uids.buffer, ...packet.compatibility.map(entry => entry.bitmap).filter(Boolean)];
}

/** Shared endpoint is also exercised with a real Node worker in regression tests. */
export function createPlaybackWorkerEndpoint(postMessage) {
  let current = null, incoming = null, incomingFrames = null, incomingPatch = null, serial = 0, latestRevision = 0, running = false;
  const queue = [];
  const artworkRegistry=new ArtworkRegistry();
  const geometryCache=new PlaybackGeometryCache();
  const tweenCache=new PlaybackTweenCache();
  const planning = new PlaybackPlanningService({snapshot: () => current, postMessage, onIdle: () => {void drain();}});
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length && !planning.busy) {
        const request = queue.shift(), snapshot = current, generation = serial;
        if (!snapshot || request.revision !== snapshot.revision) continue;
        try {
          const packet = await compilePlaybackPacket(snapshot.report, request.tick, { ...snapshot, artworkRegistry, geometryCache, tweenCache, cancelled: () => serial !== generation });
          if (serial === generation) postMessage({ type: 'packet', revision: snapshot.revision, tick: request.tick, packet }, packetTransferables(packet));
          else for (const entry of packet.compatibility) entry.bitmap?.close();
        } catch (error) {
          if (serial === generation) postMessage({ type: 'error', revision: snapshot.revision, tick: request.tick, message: error.message, code: error.code });
        }
        // Let load/invalidate/cancel messages interrupt between ticks, never halfway through a native pose.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally { running = false; }
  }
  return message => {
    if (planning.receive(message)) return;
    if (message.type === 'patch-chunk') {
      if (message.revision < latestRevision) return;
      try {
        if (current?.revision !== message.revision) throw new Error('Playback patches require a complete document snapshot.');
        if (message.chunk.header) incomingPatch = {revision: message.revision, patch: applyDocumentChunk(null, message.chunk)};
        else {
          if (incomingPatch?.revision !== message.revision) throw new Error('Playback patch chunks arrived before their header.');
          applyDocumentChunk(incomingPatch.patch, message.chunk);
        }
        postMessage({type: 'load-ack', revision: message.revision, sequence: message.sequence});
      } catch (error) { postMessage({type: 'load-error', revision: message.revision, message: error.message}); }
    } else if (message.type === 'patch-complete') {
      if (incomingPatch?.revision !== message.revision || current?.revision !== message.revision) return;
      try {
        applyPlaybackPatch(current.report, incomingPatch.patch);
        invalidateEvaluationCaches(current.report); refreshSampling(current); incomingPatch = null;
        postMessage({type: 'loaded', revision: message.revision, sequence: message.sequence});
      } catch (error) { postMessage({type: 'load-error', revision: message.revision, message: error.message}); }
    } else if (message.type === 'frame-chunk') {
      if (message.revision < latestRevision) return;
      try {
        if (current?.revision !== message.revision) throw new Error('Playback frame updates require a complete document snapshot.');
        if (message.chunk.header) incomingFrames = { revision: message.revision, report: applyDocumentChunk(null, message.chunk) };
        else {
          if (incomingFrames?.revision !== message.revision) throw new Error('Playback frame chunks arrived before their header.');
          applyDocumentChunk(incomingFrames.report, message.chunk);
        }
        postMessage({ type: 'load-ack', revision: message.revision, sequence: message.sequence });
      } catch (error) { postMessage({ type: 'load-error', revision: message.revision, message: error.message }); }
    } else if (message.type === 'frame-complete') {
      if (incomingFrames?.revision !== message.revision || current?.revision !== message.revision) return;
      try {
        const updates = incomingFrames.report.frames;
        if (!Array.isArray(updates) || updates.some(entry => !Number.isInteger(entry.index) || entry.index < 0 || entry.index >= current.report.keyframes.length || !Array.isArray(entry.frame?.objects)))
          throw new Error('Playback frame update targets are invalid.');
        for (const { index, frame } of updates) current.report.keyframes[index] = frame;
        invalidateEvaluationCaches(current.report);
        refreshSampling(current); incomingFrames = null;
        postMessage({ type: 'loaded', revision: message.revision, sequence: message.sequence });
      } catch (error) { postMessage({ type: 'load-error', revision: message.revision, message: error.message }); }
    } else if (message.type === 'load-chunk') {
      if (message.revision < latestRevision) return;
      latestRevision = message.revision;
      try {
        if (message.chunk.header) {
          planning.cancel();
          tweenCache.clear();
          serial++; queue.length = 0; current?.resources.dispose(); current = null;
          incoming = { ...message.options, revision: message.revision, report: applyDocumentChunk(null, message.chunk) };
        } else {
          if (incoming?.revision !== message.revision) throw new Error('Playback snapshot chunks arrived before their header.');
          applyDocumentChunk(incoming.report, message.chunk);
        }
        postMessage({ type: 'load-ack', revision: message.revision, sequence: message.sequence });
      } catch (error) { postMessage({ type: 'load-error', revision: message.revision, message: error.message }); }
    } else if (message.type === 'load-complete') {
      if (message.revision !== incoming?.revision || message.revision < latestRevision) return;
      current = refreshSampling({ ...incoming, resources: new PlaybackResources(incoming) }); incoming = null;
      postMessage({ type: 'loaded', revision: message.revision, sequence: message.sequence });
    } else if (message.type === 'load') {
      planning.cancel();
      tweenCache.clear();
      serial++; queue.length = 0; current?.resources.dispose();
      latestRevision = message.revision; incoming = null;
      current = refreshSampling({ ...message, resources: new PlaybackResources(message) });
      postMessage({ type: 'loaded', revision: message.revision });
    } else if (message.type === 'invalidate') {
      planning.cancel();
      serial++; latestRevision = message.revision; queue.length = 0; incoming = null; incomingFrames = null; incomingPatch = null;
      tweenCache.clear();
      if (message.retainDocument && current) { geometryCache.retainRevision(message.revision);invalidateEvaluationCaches(current.report); current = refreshSampling({ ...current, ...message.options, revision: message.revision }); }
      else { geometryCache.clear();artworkRegistry.clear();current?.resources.dispose(); current = null; }
    } else if (message.type === 'retain' && message.revision === current?.revision) {
      const keep = new Set(message.ticks);
      for (let i = queue.length - 1; i >= 0; i--) if (!keep.has(queue[i].tick)) queue.splice(i, 1);
    } else if (message.type === 'prepare' && message.revision === current?.revision) {
      for (const tick of message.ticks) if (!queue.some(entry => entry.tick === tick)) queue.push({ revision: message.revision, tick });
      void drain();
    }
  };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && !globalThis.document) {
  const receive = createPlaybackWorkerEndpoint((message, transfer) => self.postMessage(message, transfer));
  self.addEventListener('message', event => receive(event.data));
}
