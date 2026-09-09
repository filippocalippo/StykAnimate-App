import { cameraMatrix, SHAPE_BYTES, SHAPE_FLOATS, SHAPE, shapeRecord } from './renderer-geometry.mjs';
import {bitmapKey,bitmapBytes} from './playback-bitmap-pool.mjs';
import {playbackMemoryBudget} from './playback-budget.mjs';
import {EditorRasterCache} from './renderer-raster-cache.mjs';

export function preparedCameraMode(packet, requested) {
  const mode = packet.cameraEnabled === undefined ? true : packet.cameraEnabled;
  if (typeof mode !== 'boolean' || (requested !== undefined && typeof requested !== 'boolean'))
    throw new TypeError('Prepared frame camera mode must be a boolean.');
  if (requested !== undefined && requested !== mode)
    throw new Error('Prepared frame camera mode differs from its cropped artwork. Prepare this view again.');
  return mode;
}

export function combinePreparedCommands(backgrounds, groups, textures) {
  const commands = []; let base = 0;
  const append = (firstInstance, instanceCount, texture = null) => {
    if (!instanceCount) return;
    const previous = commands.at(-1);
    if (!texture && previous && !previous.texture && previous.firstInstance + previous.instanceCount === firstInstance) previous.instanceCount += instanceCount;
    else commands.push({ firstInstance, instanceCount, texture });
  };
  for (const background of backgrounds) { const count = background.data.length / SHAPE_FLOATS; append(base, count, background.texture); base += count; }
  for (const group of groups) append(base + group.firstInstance, group.instanceCount, group.compatibilityIndex === undefined ? null : textures[group.compatibilityIndex]);
  return { commands, backgroundCount: base };
}

/** Owns only uploaded GPU resources. The playback controller owns packet/bitmap lifetime. */
export class PreparedFrameCache {
  constructor(renderer, { maxBytes = playbackMemoryBudget(), maxFrames = 120 } = {}) {
    this.renderer = renderer; this.maxBytes = maxBytes; this.maxFrames = maxFrames;
    this.frames = new Map(); this.bytes = 0; this.report = null; this.revision = null;
    this.textures=new Map();this.generation=null;
    // The no-OffscreenCanvas path has the same owner and budget as uploaded
    // bitmaps. Editable layout eviction must never destroy a prepared texture.
    this.fallbackRasters = new EditorRasterCache();
    this.stats = { frames: 0, bytes: 0, maxBytes, maxFrames, hits: 0, misses: 0, evictions: 0, uploads: 0,textureUploads:0,reusedTextures:0,uniqueTextures:0 };
  }
  has(key) {
    const frame = this.frames.get(String(key));
    return Boolean(frame && frame.generation === this.renderer.generation);
  }
  _remove(key, eviction = false) {
    const frame = this.frames.get(key); if (!frame) return;
    this.frames.delete(key); this.bytes -= frame.bufferBytes;
    frame.shapeBuffer.destroy(); frame.transformBuffer.destroy();
    this._releaseTextures(frame.ownedTextures);
    if (eviction) this.stats.evictions++;
    this.stats.frames = this.frames.size; this.stats.bytes = this.bytes;this.stats.uniqueTextures=this.textures.size;
    if (this.renderer.stats) Object.assign(this.renderer.stats, { preparedBytes: this.bytes, preparedFrames: this.frames.size });
  }
  _releaseTextures(resources){
    for(const resource of resources)if(!--resource.refs){
      if (resource.raster) this.fallbackRasters.delete(resource.raster);
      else resource.texture.destroy();
      this.textures.delete(resource.key);this.bytes-=resource.bytes;
    }
  }
  clear() { for (const key of this.frames.keys()) this._remove(key); this.report = null; this.revision = null; }
  retainPackets(report, packets) {
    if (report !== this.report || this.generation !== this.renderer.generation) {this.clear(); return;}
    const keep = new Set(Array.from(packets, packet => String(packet.key)));
    for (const key of this.frames.keys()) if (!keep.has(key)) this._remove(key);
    this.stats.retainedFrames = this.frames.size;
  }
  prepare(packet, { report, view = { scale: 1 }, cameraEnabled } = {}) {
    const start = performance.now(), renderer = this.renderer, device = renderer.device, key = String(packet.key);
    cameraEnabled = preparedCameraMode(packet, cameraEnabled);
    if (!report) throw new TypeError('Preparing a frame requires its report.');
    const epoch = packet.cacheEpoch ?? packet.revision;
    if (this.report !== report || this.generation!==renderer.generation || (this.revision !== null && this.revision !== epoch)) this.clear();
    this.report = report; this.revision = epoch;this.generation=renderer.generation;
    if (!renderer.backgroundsReady(report, packet.frame)) return null;
    const prior = this.frames.get(key);
    if (prior && prior.cameraEnabled !== cameraEnabled) throw new Error('A prepared frame key cannot identify two camera views.');
    if (prior?.generation === renderer.generation) { this.frames.delete(key); this.frames.set(key, prior); this.stats.hits++; return key; }
    if (prior) this._remove(key);
    if (!(packet.shapes instanceof Float32Array) || packet.shapes.length % SHAPE_FLOATS || !(packet.transforms instanceof Float32Array) || packet.transforms.length < 4 || packet.transforms.length % 4) throw new TypeError('Invalid prepared-frame buffers.');
    const backgrounds = renderer.background({ report, frame: packet.frame, view, cameraEnabled }), textures = [], ownedTextures = [];
    const backgroundCountEstimate = backgrounds.reduce((sum, entry) => sum + entry.data.length / SHAPE_FLOATS, 0);
    const shapeBytesEstimate = Math.max(SHAPE_BYTES, packet.shapes.byteLength + backgroundCountEstimate * SHAPE_BYTES);
    const textureBytesEstimate = (packet.compatibility || []).reduce((sum, entry) => sum + (entry.bitmap ? entry.bitmap.width * entry.bitmap.height * 4 : 0), 0);
    const reservedBytes = shapeBytesEstimate + packet.transforms.byteLength + textureBytesEstimate;
    if (reservedBytes > this.maxBytes || this.maxFrames < 1) throw new Error(`Prepared frame exceeds the ${Math.round(this.maxBytes / 1024 / 1024)} MB GPU cache budget.`);
    if (shapeBytesEstimate > device.limits.maxStorageBufferBindingSize || packet.transforms.byteLength > device.limits.maxStorageBufferBindingSize) throw new Error('Prepared frame exceeds this GPU’s storage-buffer limit.');
    // Evict before allocating textures so an upload does not temporarily double
    // the cache's GPU residency while an old frame is still retained.
    const incrementalBytes=()=>shapeBytesEstimate+packet.transforms.byteLength+(packet.compatibility||[]).reduce((sum,entry)=>sum+(this.textures.has(bitmapKey(packet,entry))?0:bitmapBytes(entry)),0);
    while (this.frames.size && (this.frames.size >= this.maxFrames || this.bytes + incrementalBytes() > this.maxBytes)) this._remove(this.frames.keys().next().value, true);
    let shapeData = packet.shapes, textureBytes = 0,shapeBuffer,transformBuffer;
    try {
      for (const [i, compatibility] of (packet.compatibility || []).entries()) {
        if (compatibility.bitmap) {
          const source = compatibility.bitmap;
          const resourceKey=bitmapKey(packet,compatibility);
          let resource=this.textures.get(resourceKey);
          if(!resource){
            if (!source.width || !source.height) throw new Error('Prepared-frame image was released before GPU upload.');
            const texture = device.createTexture({ label: `Prepared ${key} object ${compatibility.uid}`, size: [source.width, source.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
            try{
              device.queue.copyExternalImageToTexture({ source }, { texture, premultipliedAlpha: true }, [source.width, source.height]);
              resource = { key:resourceKey,refs:0,width:source.width,height:source.height,texture, bindGroup: renderer.textureBindGroup(texture), bytes: source.width * source.height * 4 };
            }catch(error){texture.destroy();throw error;}
            this.textures.set(resourceKey,resource);this.bytes+=resource.bytes;this.stats.textureUploads++;
          }else{
            if(source.width&&(resource.width!==source.width||resource.height!==source.height))throw new Error('Shared GPU artwork has inconsistent dimensions.');
            this.stats.reusedTextures++;
          }
          resource.refs++;
          textures.push(resource); ownedTextures.push(resource); textureBytes += resource.bytes;
        } else {
          // Runtimes without worker OffscreenCanvas use the established object-level renderer.
          const matrix = cameraMatrix({ report, frame: packet.frame, view, cameraEnabled });
          const raster = renderer.rasterObject(compatibility.g, compatibility.items, Math.hypot(matrix[0], matrix[1]) * renderer.dpr, compatibility.g, this.fallbackRasters);
          let resource = this.textures.get(raster);
          if (!resource) {
            resource = {...raster, raster, key: raster, refs: 0};
            this.textures.set(raster, resource); this.bytes += resource.bytes; this.stats.textureUploads++;
          } else this.stats.reusedTextures++;
          resource.refs++; textures.push(resource); ownedTextures.push(resource); textureBytes += resource.bytes;
          if (shapeData === packet.shapes) shapeData = packet.shapes.slice();
          const group = packet.groups.find(group => group.compatibilityIndex === i), b = resource.bounds, root = compatibility.root || compatibility.g.root;
          shapeData.set(shapeRecord({ mode: SHAPE.TEXTURE, color: [1, 1, 1, 1], transform: group.transformIndex, a: [b.x - root.x, b.y - root.y, b.x + b.width - root.x, b.y + b.height - root.y] }), group.firstInstance * SHAPE_FLOATS);
        }
      }
      const { commands, backgroundCount } = combinePreparedCommands(backgrounds, packet.groups, textures);
      const shapeBytes = Math.max(SHAPE_BYTES, shapeData.byteLength + backgroundCount * SHAPE_BYTES), transformBytes = packet.transforms.byteLength, bytes = shapeBytes + transformBytes + textureBytes;
      // Fallback raster dimensions are known only after object rasterization.
      // References acquired above protect shared textures during this eviction.
      while (this.frames.size && this.bytes + shapeBytes + transformBytes > this.maxBytes) this._remove(this.frames.keys().next().value, true);
      if (this.bytes + shapeBytes + transformBytes > this.maxBytes) throw new Error('Prepared frame exceeds the GPU cache budget.');
      shapeBuffer = device.createBuffer({ label: `Prepared shape packet ${key}`, size: shapeBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      transformBuffer = device.createBuffer({ label: `Prepared transforms ${key}`, size: transformBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      let offset = 0;
      for (const background of backgrounds) { device.queue.writeBuffer(shapeBuffer, offset, background.data); offset += background.data.byteLength; }
      if (shapeData.byteLength) device.queue.writeBuffer(shapeBuffer, offset, shapeData);
      device.queue.writeBuffer(transformBuffer, 0, packet.transforms);
      const bindGroup = device.createBindGroup({ layout: renderer.globalLayout, entries: [{ binding: 0, resource: { buffer: renderer.uniform } }, { binding: 1, resource: { buffer: shapeBuffer } }, { binding: 2, resource: { buffer: transformBuffer } }] });
      const frame = { key, cameraEnabled, nativeFrame: packet.frame, shapeBuffer, transformBuffer, bindGroup, commands, ownedTextures,
        transforms: packet.transforms.slice(), liveTransforms: null, transformed: false, uids: packet.uids.slice(), bytes,bufferBytes:shapeBytes+transformBytes,
        objectCount: packet.objectCount, shapeCount: shapeData.length / SHAPE_FLOATS + backgroundCount,
        textureObjects: packet.compatibility?.length || 0, warnings: packet.warnings || [], generation: renderer.generation,
        compileMs: packet.compileMs, prepareMs: performance.now() - start, uploadedBytes: shapeBytes + transformBytes, scale: packet.scale };
      this.frames.set(key, frame); this.bytes += frame.bufferBytes; this.stats.uploads++;
      Object.assign(this.stats, { frames: this.frames.size, bytes: this.bytes,uniqueTextures:this.textures.size });
      Object.assign(renderer.stats || {}, { preparedBytes: this.bytes, preparedFrames: this.frames.size });
      return key;
    } catch (error) { this._releaseTextures(ownedTextures);shapeBuffer?.destroy();transformBuffer?.destroy();throw error; }
  }
  render(key, { report = this.report, view = {}, hiddenUids, dragTranslations, cameraEnabled } = {}) {
    const start = performance.now(), frame = this.frames.get(String(key)), renderer = this.renderer;
    if (!frame || frame.generation !== renderer.generation || report !== this.report) { this.stats.misses++; return false; }
    cameraEnabled = preparedCameraMode(frame, cameraEnabled);
    this.frames.delete(frame.key); this.frames.set(frame.key, frame); this.stats.hits++;
    const matrix = cameraMatrix({ report, frame: frame.nativeFrame, view, cameraEnabled }), zoom = Number(view.scale ?? 1), x = Number(view.x ?? 0), y = Number(view.y ?? 0);
    renderer.device.queue.writeBuffer(renderer.uniform, 0, new Float32Array([matrix[0], matrix[2], matrix[4], Math.hypot(matrix[0], matrix[1]), matrix[1], matrix[3], matrix[5], 0,
      renderer.width, renderer.height, renderer.dpr, 1, x, y, x + report.canvas_width * zoom, y + report.canvas_height * zoom]));
    let transformBytes = 0;
    if ((typeof hiddenUids?.has === 'function' && hiddenUids.size !== 0) || dragTranslations?.size) {
      frame.liveTransforms ??= new Float32Array(frame.transforms.length); frame.liveTransforms.set(frame.transforms);
      for (let i = 1; i < frame.uids.length; i++) { const uid = frame.uids[i], delta = dragTranslations?.get(uid), offset = i * 4;
        if (delta) { frame.liveTransforms[offset] += delta.x; frame.liveTransforms[offset + 1] += delta.y; }
        if (hiddenUids?.has(uid)) frame.liveTransforms[offset + 3] = 0;
      }
      renderer.device.queue.writeBuffer(frame.transformBuffer, 0, frame.liveTransforms); frame.transformed = true; transformBytes = frame.liveTransforms.byteLength;
    } else if (frame.transformed) { renderer.device.queue.writeBuffer(frame.transformBuffer, 0, frame.transforms); frame.transformed = false; transformBytes = frame.transforms.byteLength; }
    const encoder = renderer.device.createCommandEncoder({ label: `Prepared playback ${frame.key}` });
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: renderer.msaa.createView(), resolveTarget: renderer.context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'discard' }] });
    pass.setPipeline(renderer.pipeline); pass.setBindGroup(0, frame.bindGroup);
    for (const command of frame.commands) { pass.setBindGroup(1, command.texture?.bindGroup || renderer.blankBindGroup); pass.draw(6, command.instanceCount, 0, command.firstInstance); }
    pass.end(); renderer.device.queue.submit([encoder.finish()]);
    Object.assign(renderer.stats, { mode: 'prepared playback', preparation: 'prepared', compiledObjects: 0, rasterizedObjects: 0, updatedObjects: 0, frameMs: performance.now() - start, drawCalls: frame.commands.length, primitives: frame.shapeCount, objects: frame.objectCount,
      textureObjects: frame.textureObjects, uploadBytes: 0, transformUploadBytes: transformBytes, gpuBytes: frame.bytes, preparedBytes: this.bytes, preparedFrames: this.frames.size,
      workerCompileMs: frame.compileMs, packetUploadMs: frame.prepareMs, warnings: frame.warnings });
    return true;
  }
}
