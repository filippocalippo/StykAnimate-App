import {canvasPaint} from './paint.mjs';
import { buildGeometry, buildGeometrySteps, drawGeometry, releaseGeometryResources } from './pivot/geometry.mjs';
import { drawBackground, backgroundBounds, sceneBackgroundColor, effectiveCamera } from './pivot/background.mjs';
import { SHAPE, SHAPE_BYTES, SHAPE_FLOATS, shapeRecord, compileVectorObjectSteps, requiresCompatibilityTexture, adoptPreparedVectors, objectBounds, cameraMatrix, argbFloats } from './renderer-geometry.mjs';
import { PreparedFrameCache } from './prepared-frames.mjs';
import { RasterSurfacePool } from './raster-surfaces.mjs';
import { EditorRasterCache } from './renderer-raster-cache.mjs';
import { composeSceneGroups } from './scene-order.mjs';
import { HandleRenderer } from './renderer-handles.mjs';
import { ArtworkRegistry } from './render-artwork.mjs';
import { uploadShapeLayoutSteps, SHAPE_UPLOAD_RECORDS } from './renderer-upload.mjs';
import { backgroundImageAssets, frameImageAssets, createSceneImages, consumeSceneSteps } from './scene-preparation.mjs';
export { cameraMatrix, worldToScreen, screenToWorld } from './renderer-geometry.mjs';
function editorBackgroundColor(options) {
  const color=options.editorBackgroundColor;
  if(color===undefined||color===null)return undefined;
  if(!Number.isInteger(color)||color<0||color>0xffffffff)throw new Error('Editor background must be an ARGB color.');
  return color;
}

const SHADER = /* wgsl */ `
struct Globals { row0: vec4f, row1: vec4f, viewport: vec4f, clip: vec4f }
struct Shape { a: vec4f, b: vec4f, color: vec4f, color2: vec4f, gradient: vec4f, info: vec4f }
@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var<storage, read> shapes: array<Shape>;
@group(0) @binding(2) var<storage, read> transforms: array<vec4f>;
@group(1) @binding(0) var imageSampler: sampler;
@group(1) @binding(1) var imageTexture: texture_2d<f32>;
struct VertexOut { @builtin(position) position: vec4f, @location(0) local: vec2f, @location(1) uv: vec2f, @location(2) @interpolate(flat) shapeIndex: u32 }
@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  let shape = shapes[instance];
  let transform = transforms[u32(shape.info.y)];
  var corners = array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
  let uv = corners[vertex];
  let kind = i32(shape.info.x);
  var p = vec2f(0);
  let aa = 1.1 / max(globals.row0.w * globals.viewport.z, 0.0001);
  if (kind == 0 || kind == 2) {
    let delta = shape.a.zw - shape.a.xy;
    let len = length(delta);
    let direction = select(vec2f(1,0), delta / max(len, 0.0001), len > 0.0001);
    let normal = vec2f(-direction.y, direction.x);
    let radius = shape.b.z + aa;
    p = shape.a.xy + direction * (uv.x * (len + 2.0 * radius) - radius) + normal * ((uv.y * 2.0 - 1.0) * radius);
  } else if (kind == 1) {
    p = shape.a.xy + (uv * 2.0 - 1.0) * (shape.b.z + aa);
  } else if (kind == 3) {
    p = shape.b.xy;
    if (vertex == 0u) { p = shape.a.xy; }
    if (vertex == 1u) { p = shape.a.zw; }
  } else {
    p = mix(shape.a.xy, shape.a.zw, uv);
  }
  let world = p + transform.xy;
  let screen = vec2f(dot(globals.row0.xyz, vec3f(world,1)), dot(globals.row1.xyz, vec3f(world,1)));
  var output: VertexOut;
  output.position = vec4f(screen.x / globals.viewport.x * 2.0 - 1.0, 1.0 - screen.y / globals.viewport.y * 2.0, 0, 1);
  output.local = p;
  output.uv = uv;
  output.shapeIndex = instance;
  return output;
}
@fragment fn fs(input: VertexOut) -> @location(0) vec4f {
  let shape = shapes[input.shapeIndex];
  let transform = transforms[u32(shape.info.y)];
  let kind = i32(shape.info.x);
  let screen = input.position.xy / globals.viewport.z;
  let outsideCanvas = screen.x < globals.clip.x || screen.y < globals.clip.y || screen.x > globals.clip.z || screen.y > globals.clip.w;
  // Backgrounds stay on the artboard; editor figures can extend into the workspace.
  if (kind < 0 || transform.w < 0.5 || (outsideCanvas && (globals.viewport.w > 0.5 || shape.info.w > 0.5))) { discard; }
  var coverage = 1.0;
  var distance = -1.0;
  if (kind == 0) {
    let delta = shape.a.zw - shape.a.xy;
    let norm = dot(delta, delta);
    let t = clamp(dot(input.local - shape.a.xy, delta) / max(norm, 0.000001), 0.0, 1.0);
    distance = length(input.local - shape.a.xy - delta * t) - shape.b.z;
  } else if (kind == 2) {
    let delta = shape.a.zw - shape.a.xy;
    let len = length(delta);
    let direction = select(vec2f(1,0), delta / max(len, 0.0001), len > 0.0001);
    let p = input.local - (shape.a.xy + shape.a.zw) * 0.5;
    let q = abs(vec2f(dot(p, direction), dot(p, vec2f(-direction.y, direction.x)))) - vec2f(len * 0.5 + shape.b.z, shape.b.z);
    distance = length(max(q, vec2f(0))) + min(max(q.x,q.y),0.0);
  } else if (kind == 1) {
    let radius = length(input.local - shape.a.xy);
    distance = radius - shape.b.z;
    if (shape.b.w > 0.0) { distance = max(distance, shape.b.w - radius); }
  }
  let edge = max(fwidth(distance), 0.00001);
  if (kind <= 2) { coverage = clamp(0.5 - distance / edge, 0.0, 1.0); }
  var t = clamp(dot(input.local - shape.gradient.xy, shape.gradient.zw), 0.0, 1.0);
  if (kind == 6) { t = clamp((length(input.local - shape.gradient.xy) - shape.gradient.z) / max(shape.gradient.w - shape.gradient.z, 0.0001), 0.0, 1.0); }
  var color = mix(shape.color, shape.color2, t);
  if (kind == 4) {
    let texel = textureSampleLevel(imageTexture, imageSampler, input.uv, 0.0);
    // copyExternalImageToTexture uses premultiplied textures; preserve that convention.
    return texel * (color.a * transform.z);
  }
  let alpha = color.a * coverage * transform.z;
  return vec4f(color.rgb * alpha, alpha);
}`;

const pow2 = n => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
const uidOf = g => g?.obj?.unique_id ?? g?.slot;
function createResources(options, invalidate) {
  const images = new Map(), watched = new WeakSet();
  const watch = image => {
    if (image && !image.complete && !watched.has(image)) {
      watched.add(image); image.addEventListener('load', invalidate, { once: true }); image.addEventListener('error', invalidate, { once: true });
    }
    return image;
  };
  const resources = {
    url: options.resources?.url ?? (asset => asset?.asset_url || asset?.data_url || asset?.asset_path_relative || asset?.asset_path || null),
    image: options.resources?.image ? (url => watch(options.resources.image(url))) : (url => {
      if (!url) return null;
      if (images.has(url)) return images.get(url);
      const image = new Image(); image.decoding = 'async';
      images.set(url, image); image.src = url; return watch(image);
    }),
    clear: () => images.clear(),
  };
  return resources;
}

/** A Canvas fallback is explicit and never advertised as hardware WebGPU rendering. */
class CanvasFallback {
  constructor(canvas, options, reason) {
    this.canvas = canvas; this.context = canvas.getContext('2d'); this.options = options;
    this.stats = { backend: 'Canvas 2D fallback', reason, drawCalls: 0, primitives: 0, frameMs: 0, objects: 0, textureObjects: 0 };
    this.onionArtwork = new Map(); this.onionArtworkBytes = 0;
    this.resources = createResources(options, () => { this.clearOnionArtwork(); if (this.last) this.render(this.last); options.onInvalidate?.(); });
    this.resize(canvas.clientWidth || 1, canvas.clientHeight || 1, globalThis.devicePixelRatio || 1);
  }
  resize(width, height, dpr = 1) { this.width = Math.max(1, width); this.height = Math.max(1, height); this.dpr = dpr; this.canvas.width = Math.round(this.width * dpr); this.canvas.height = Math.round(this.height * dpr); }
  prepareInitialScene(options) { return prepareInitialScene(this, options); }
  activatePreparedScene(prepared, options) { return activatePreparedScene(this, prepared, options); }
  clearOnionArtwork() {
    for (const item of this.onionArtwork.values()) { item.canvas.width = 1; item.canvas.height = 1; }
    this.onionArtwork.clear(); this.onionArtworkBytes = 0;
  }
  drawOnion(ctx, group, scale) {
    const resolution = Math.max(.5, Math.min(8, 2 ** Math.ceil(Math.log2(scale || 1))));
    let cached = this.onionArtwork.get(group.g);
    if (cached?.resolution !== resolution) {
      if (cached) { this.onionArtwork.delete(group.g); this.onionArtworkBytes -= cached.bytes; cached.canvas.width = 1; cached.canvas.height = 1; }
      const bounds = objectBounds(group.items, this.resources);
      const pixelScale = Math.min(resolution, 4096 / bounds.width, 4096 / bounds.height);
      const width = Math.max(1, Math.ceil(bounds.width * pixelScale)), height = Math.max(1, Math.ceil(bounds.height * pixelScale));
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : this.canvas.ownerDocument.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const temp = canvas.getContext('2d');
      temp.setTransform(pixelScale, 0, 0, pixelScale, -bounds.x * pixelScale, -bounds.y * pixelScale);
      drawGeometry(temp, {drawables: group.items}, this.resources);
      releaseGeometryResources(temp);
      cached = {canvas, resolution, bounds, width: width / pixelScale, height: height / pixelScale, bytes: width * height * 4};
      this.onionArtworkBytes += cached.bytes;
      this.stats.onionRasterizedObjects++;
    }
    this.onionArtwork.delete(group.g); this.onionArtwork.set(group.g, cached);
    ctx.drawImage(cached.canvas, cached.bounds.x, cached.bounds.y, cached.width, cached.height);
    // Bound raster memory independently of animation length and viewport size.
    while (this.onionArtwork.size > 4096 || this.onionArtworkBytes > 64 * 1024 * 1024) {
      const key = this.onionArtwork.keys().next().value, item = this.onionArtwork.get(key);
      this.onionArtwork.delete(key); this.onionArtworkBytes -= item.bytes;
      item.canvas.width = 1; item.canvas.height = 1;
    }
  }
  render(options) {
    this.last = options; const start = performance.now(), ctx = this.context;
    const { report, frame, view = {}, geometry = frame && buildGeometry(report, frame), hiddenUids, dragTranslations } = options;
    if (this.onionReport !== report) { this.clearOnionArtwork(); this.onionReport = report; }
    this.stats.onionRasterizedObjects = 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!frame || !report) return;
    ctx.save(); ctx.scale(this.dpr, this.dpr);
    const clipArtboard = () => { ctx.beginPath(); ctx.rect(view.x || 0, view.y || 0, report.canvas_width * (view.scale || 1), report.canvas_height * (view.scale || 1)); ctx.clip(); };
    ctx.save(); clipArtboard(); ctx.transform(...cameraMatrix(options));
    const bounds=backgroundBounds(frame, report.canvas_width, report.canvas_height, options.cameraEnabled !== false, report),editorColor=editorBackgroundColor(options);
    if(editorColor===undefined)drawBackground(ctx, report, frame, report.canvas_width, report.canvas_height, { ...this.resources, bounds });
    else {const [r,g,b,a]=argbFloats(editorColor);ctx.fillStyle=`rgba(${r*255},${g*255},${b*255},${a})`;ctx.fillRect(bounds.x,bounds.y,bounds.width,bounds.height);}
    ctx.restore();
    if (options.clipToCanvas !== false) clipArtboard();
    ctx.transform(...cameraMatrix(options));
    const onions = (options.onionFrames || []).map(onion => ({geometry: onion.geometry || buildGeometry(report, onion.frame || onion), opacity: onion.opacity, beforeUid: onion.beforeUid, showOnTop: onion.showOnTop}));
    const matrix = cameraMatrix(options), scale = Math.hypot(matrix[0], matrix[1]) * this.dpr;
    let primitives = 0;
    for (const group of composeSceneGroups(geometry, onions, frame)) {
      const uid = group.g.obj.unique_id; if (hiddenUids?.has(uid)) continue;
      const move = !group.isOnion && dragTranslations?.get(uid);
      ctx.save(); ctx.globalAlpha = group.opacity; if (move) ctx.translate(move.x, move.y);
      if (group.isOnion) this.drawOnion(ctx, group, scale);
      else drawGeometry(ctx, {drawables: group.items}, this.resources);
      ctx.restore(); primitives += group.items.length;
    }
    ctx.restore(); Object.assign(this.stats, { objects: geometry.objects.size, primitives, drawCalls: primitives, frameMs: performance.now() - start });
    return geometry;
  }
  destroy() { this.last = null; this.clearOnionArtwork(); releaseGeometryResources(this.context); }
}

class WebGPURenderer {
  constructor(canvas, device, context, format, options) {
    Object.assign(this, { canvas, device, context, format, options });
    this.stats = { backend: 'WebGPU', adapter: options.adapterName || 'Hardware accelerated', drawCalls: 0, primitives: 0, objects: 0, textureObjects: 0, frameMs: 0, uploadBytes: 0, cachedObjects: 0, gpuBytes: 0, warnings: [] };
    this.entries = new Map(); this.rasterCache = new EditorRasterCache(options.editorRasterCache); this.vectorCache = new WeakMap(); this.compatibilityCache = new WeakMap(); this.generation = 0; this.lastGeometry = null; this.backgroundKey = ''; this.last = null;
    this.artworks = new ArtworkRegistry();
    this.artworkAliases = new WeakMap();
    this.preparedFrames = new PreparedFrameCache(this, options.preparedCache);
    this.rasterSurfaces = new RasterSurfacePool();
    this.stats.preparedCache = this.preparedFrames.stats;
    this.resources = createResources(options, () => { this.generation++; this.lastGeometry = null; if (this.last) this.render(this.last); options.onInvalidate?.(); });
  }
  async initialize() {
    const d = this.device;
    const module = d.createShaderModule({ code: SHADER, label: 'StykAnimate signed-distance vector shader' });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter(m => m.type === 'error');
    if (errors.length) throw new Error(errors.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
    this.globalLayout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ] });
    this.textureLayout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ] });
    this.pipeline = await d.createRenderPipelineAsync({ label: 'StykAnimate vector + asset compositor', layout: d.createPipelineLayout({ bindGroupLayouts: [this.globalLayout, this.textureLayout] }),
      vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }] },
      primitive: { topology: 'triangle-list' }, multisample: { count: 4 },
    });
    this.uniform = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.handleRenderer = new HandleRenderer(d,this.uniform);
    await this.handleRenderer.initialize(this.format);
    this.sampler = d.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.nearestSampler = d.createSampler({ minFilter: 'nearest', magFilter: 'nearest' });
    this.blankTexture = d.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: this.blankTexture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    this.blankBindGroup = this.textureBindGroup(this.blankTexture);
    this.ensureBuffers(1, 1);
    this.resize(this.canvas.clientWidth || 1, this.canvas.clientHeight || 1, globalThis.devicePixelRatio || 1);
    this.device.lost.then(info => { if (!this.destroyed) { this.stats.reason = info.message; this.stats.message = `Graphics device disconnected: ${info.message || info.reason}. Reinitialize the renderer to continue.`; this.stats.backend = 'WebGPU device lost'; this.options.onStatus?.(this.stats); } });
    this.device.addEventListener('uncapturederror', event => { this.stats.warnings.push(event.error.message); this.options.onStatus?.(this.stats); });
  }
  textureBindGroup(texture, sampler = this.sampler) { return this.device.createBindGroup({ layout: this.textureLayout, entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: texture.createView() }] }); }
  prepareInitialScene(options) { return prepareInitialScene(this, options); }
  activatePreparedScene(prepared, options) { return activatePreparedScene(this, prepared, options); }
  useReport(report) {
    if (this.activeReport === report) return;
    if (this.activeReport) {
      for (const entry of this.backgroundImages?.values() || []) entry.texture.destroy();
      this.backgroundImages?.clear(); this.resources.clear(); this.preparedFrames.clear();
      this.rasterCache.clear();
      this.layout = []; this.entries.clear(); this.vectorCache = new WeakMap(); this.compatibilityCache = new WeakMap();
      this.artworks.clear();
      this.artworkAliases=new WeakMap();
      this.lastGeometry = null; this.lastReport = null; this.onionScenes = [];
    }
    this.activeReport = report;
  }
  hasPreparedFrame(key) { return this.preparedFrames.has(key); }
  prepareSceneUpdate(options) { return prepareSceneUpdate(this, options); }
  backgroundAssets(report, frame) {
    return backgroundImageAssets(report, frame);
  }
  backgroundsReady(report, frame) {
    return this.backgroundAssets(report, frame).every(asset => {
      const image = this.resources.image(this.resources.url(asset));
      if (image?.complete && !image.naturalWidth) throw new Error('An animation background image could not be decoded.');
      return Boolean(image?.complete && image.naturalWidth);
    });
  }
  async prepareBackgrounds(report, frame) {
    await Promise.all(this.backgroundAssets(report, frame).map(async asset => {
      const image = this.resources.image(this.resources.url(asset));
      if (!image) throw new Error('An animation background image has no readable asset.');
      if (!image.complete) await image.decode();
      if (!image.naturalWidth) throw new Error('An animation background image could not be decoded.');
    }));
  }
  prepareFrame(packet, options) { this.useReport(options.report); return this.preparedFrames.prepare(packet, options); }
  renderPrepared(key, options) {
    const rendered = this.preparedFrames.render(key, options);
    if (rendered) { this.last = null; this.stats.primitiveUploadCalls = 0; }
    return rendered;
  }
  clearPreparedFrames() { this.preparedFrames.clear(); }
  retainPreparedFrames(report, packets) { this.preparedFrames.retainPackets(report, packets); }
  ensureBuffers(shapeCount, transformCount) {
    const shapeSize = pow2(shapeCount) * SHAPE_BYTES, transformSize = pow2(transformCount) * 16;
    let changed = false;
    if (!this.shapeBuffer || this.shapeBuffer.size < shapeSize) { this.shapeBuffer?.destroy(); this.shapeBuffer = this.device.createBuffer({ label: 'Retained figure primitives', size: shapeSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); changed = true; }
    if (!this.transformBuffer || this.transformBuffer.size < transformSize) { this.transformBuffer?.destroy(); this.transformBuffer = this.device.createBuffer({ label: 'Figure translations + visibility', size: transformSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); changed = true; }
    if (changed) this.globalBindGroup = this.device.createBindGroup({ layout: this.globalLayout, entries: [{ binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: { buffer: this.shapeBuffer } }, { binding: 2, resource: { buffer: this.transformBuffer } }] });
    return changed;
  }
  resize(width, height, dpr = 1) {
    width = Math.max(1, width); height = Math.max(1, height); dpr = Math.max(.5, Math.min(3, dpr));
    const pw = Math.max(1, Math.round(width * dpr)), ph = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width === pw && this.canvas.height === ph && this.msaa) { this.width = width; this.height = height; this.dpr = dpr; return; }
    this.width = width; this.height = height; this.dpr = dpr; this.canvas.width = pw; this.canvas.height = ph;
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
    this.msaa?.destroy(); this.msaa = this.device.createTexture({ label: '4× antialias canvas', size: [pw, ph], sampleCount: 4, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }
  rasterObject(g, items, scale, artwork = g, cache = this.rasterCache) {
    const resolution = Math.max(.5, Math.min(8, 2 ** Math.ceil(Math.log2(scale || 1))));
    const cached = cache.get(artwork, resolution, this.generation);
    if (cached) return cached;
    const previous = cache.previous(artwork);
    const reason=!previous?'uncached':previous.destroyed?'released':previous.generation!==this.generation?'generation':'resolution';
    const misses=this.stats.rasterCacheMisses??={};misses[reason]=(misses[reason]||0)+1;
    const samples=this.stats.rasterCacheMissSamples??=[];
    if(samples.length<4)samples.push({reason,resolution,previousResolution:previous?.resolution,scale});
    this.stats.rasterizedObjects = (this.stats.rasterizedObjects || 0) + 1;
    const bounds = objectBounds(items, this.resources), max = Math.min(4096, this.device.limits.maxTextureDimension2D);
    const pixelScale = Math.min(resolution, max / bounds.width, max / bounds.height);
    const width = Math.max(1, Math.ceil(bounds.width * pixelScale)), height = Math.max(1, Math.ceil(bounds.height * pixelScale));
    const {surface, context: ctx} = this.rasterSurfaces.acquire(width, height); let texture;
    try {
      ctx.setTransform(pixelScale, 0, 0, pixelScale, -bounds.x * pixelScale, -bounds.y * pixelScale);
      drawGeometry(ctx, { drawables: items }, this.resources);
      texture = this.device.createTexture({ label: `Compatibility object ${uidOf(g)}`, size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      this.device.queue.copyExternalImageToTexture({ source: surface }, { texture, premultipliedAlpha: true }, [width, height]);
      // Include the final partially used pixel rather than squeezing its raster.
      const rasterBounds = { ...bounds, width: width / pixelScale, height: height / pixelScale };
      const result = { bounds: rasterBounds, origin: {...g.root}, texture, bindGroup: this.textureBindGroup(texture), generation: this.generation, resolution, bytes: width * height * 4 };
      cache.set(artwork, result); return result;
    } catch (error) { texture?.destroy(); throw error; }
    finally { this.rasterSurfaces.release(); }
  }
  background(options) {
    const { report, frame } = options, w = report.canvas_width, h = report.canvas_height;
    const bounds = backgroundBounds(frame, w, h, options.cameraEnabled !== false, report), output = [];
    const override = editorBackgroundColor(options) ?? sceneBackgroundColor(report, frame);
    if (override !== undefined) return [{data: new Float32Array(shapeRecord({
      a: [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height],
      color: argbFloats(override), mode: SHAPE.RECT, clipToCanvas: true,
    })), texture: null}];
    const layer = (id, alpha = 1) => {
      const bg = report.backgrounds?.find(b => Number(b.background_id) === Number(id));
      const a = [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height];
      let color = argbFloats(bg?.color ?? 0xffffffff), color2 = color, gradient = [0, 0, 0, 0], mode = SHAPE.RECT;
      if (bg?.paint) {
        this.backgroundImages ??= new Map();
        const signature=JSON.stringify([bg.paint,bounds]), prior=this.backgroundImages.get(bg);
        let cached=prior;
        if(!cached || cached.signature!==signature){
          const scale=Math.min(2,2048/Math.max(bounds.width,bounds.height)),cw=Math.max(1,Math.ceil(bounds.width*scale)),ch=Math.max(1,Math.ceil(bounds.height*scale));
          const canvas=new OffscreenCanvas(cw,ch),ctx=canvas.getContext('2d');ctx.scale(scale,scale);ctx.translate(-bounds.x,-bounds.y);
          ctx.fillStyle=canvasPaint(ctx,bg.paint,{x:0,y:h/2},{x:w,y:h/2},c=>c,bounds);ctx.fillRect(bounds.x,bounds.y,bounds.width,bounds.height);
          const texture=this.device.createTexture({label:'Background paint',size:[cw,ch],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
          this.stagingTextures?.add(texture);this.device.queue.copyExternalImageToTexture({source:canvas},{texture,premultipliedAlpha:true},[cw,ch]);
          cached={texture,signature,bindGroup:this.textureBindGroup(texture,this.nearestSampler)};this.backgroundImages.set(bg,cached);prior?.texture.destroy();
        }
        output.push({data:new Float32Array(shapeRecord({a,mode:SHAPE.TEXTURE,color:[1,1,1,alpha],clipToCanvas:true})),texture:cached});return;
      }
      if (bg?.kind === 3) {
        color = argbFloats(bg.color_a); color2 = argbFloats(bg.color_b);
        const dx = (bg.x2 - bg.x1) * w, dy = (bg.y2 - bg.y1) * h, norm = dx * dx + dy * dy || 1;
        gradient = [bg.x1 * w, bg.y1 * h, dx / norm, dy / norm];
      } else if (bg?.kind === 4) {
        color = argbFloats(bg.color_b); color2 = argbFloats(bg.color_a); mode = SHAPE.RADIAL_RECT;
        const outer = bg.y2 * h; gradient = [bg.x1 * w, bg.y1 * h, Math.min(Math.max(0, bg.x2 * h), .99 * outer), Math.max(.0001, outer)];
        if (outer <= 0) { color = color2; mode = SHAPE.RECT; }
      } else if (bg && bg.kind !== 2 && bg.color === undefined) {
        const image = this.resources.image(this.resources.url(bg));
        if (!image?.complete || !image.naturalWidth) return;
        let cached = this.backgroundImages?.get(image);
        if (!cached) {
          this.backgroundImages ??= new Map();
          const texture = this.device.createTexture({ label: 'Imported background asset', size: [image.naturalWidth, image.naturalHeight], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
          this.stagingTextures?.add(texture);
          this.device.queue.copyExternalImageToTexture({ source: image }, { texture, premultipliedAlpha: true }, [image.naturalWidth, image.naturalHeight]);
          cached = { texture, bindGroup: this.textureBindGroup(texture, this.nearestSampler) }; this.backgroundImages.set(image, cached);
        }
        if (alpha === 1 && bounds.clearRaster) {
          // Native opaque image backgrounds expose black around the camera viewport.
          // Transparent PNGs keep the artboard clear instead of covering its margins.
          const opaque = bg.mime_type === 'image/jpeg';
          if (opaque) output.push({ data: new Float32Array(shapeRecord({ a, mode: SHAPE.RECT, color: [0, 0, 0, 1], clipToCanvas: true })), texture: null });
        }
        const ratio = Math.max(w / image.naturalWidth, h / image.naturalHeight);
        output.push({ data: new Float32Array(shapeRecord({ a: [0, 0, image.naturalWidth * ratio, image.naturalHeight * ratio], mode: SHAPE.TEXTURE, color: [1, 1, 1, alpha], clipToCanvas: true })), texture: cached }); return;
      }
      color = [...color]; color2 = [...color2]; color[3] *= alpha; color2[3] *= alpha;
      output.push({ data: new Float32Array(shapeRecord({ a, mode, color, color2, gradient, clipToCanvas: true })), texture: null });
    };
    layer(frame.background_id); if (frame.background_mix) layer(frame.background_id_b, frame.background_mix / 255);
    return output;
  }
  objectEntry(g, items, opacity, key, index, scale, isOnion = false) {
    const steps=this.objectEntrySteps(g,items,opacity,key,index,scale,isOnion);
    for(;;){const step=steps.next();if(step.done)return step.value;}
  }
  *objectEntrySteps(g, items, opacity, key, index, scale, isOnion = false) {
    const uid = uidOf(g), prior = this.entries.get(key),source=g.renderSource||g,sourceItems=g.renderSource?source.drawables:items; let data, texture;
    let compatibility = this.compatibilityCache.get(source);
    if (compatibility === undefined) { compatibility = requiresCompatibilityTexture(sourceItems); this.compatibilityCache.set(source, compatibility); }
    if (compatibility) {
      const artwork=this.artworkAliases.get(source) ?? (this.options.sharedArtwork===false||this.liveEditing?source:yield* this.artworks.getSteps(source,sourceItems));
      this.artworkAliases.set(g,artwork);
      texture = this.rasterObject(source, sourceItems, scale, artwork);
      this.rasterLease?.add(texture);
      if (prior?.transform === index && prior.texture === texture) data = prior.data;
      else { const b = texture.bounds, origin=texture.origin; data = new Float32Array(shapeRecord({ a: [b.x - origin.x, b.y - origin.y, b.x + b.width - origin.x, b.y + b.height - origin.y], color: [1, 1, 1, 1], mode: SHAPE.TEXTURE, transform: index })); }
    } else {
      let compiled = this.vectorCache.get(source);
      if (!compiled) { compiled = yield* compileVectorObjectSteps(sourceItems, source.root); this.vectorCache.set(source, compiled); this.stats.compiledObjects++; }
      if (prior?.source === source && prior.transform === index) data = prior.data;
      else { data = compiled.slice(); for (let j = 21; j < data.length; j += SHAPE_FLOATS) data[j] = index; }
    }
    return { key, uid, g, source, opacity, isOnion, root: g.root, transform: index, data, count: data.length / SHAPE_FLOATS, texture };
  }
  uploadEntry(entry) {
    const padded = new Float32Array(entry.capacity * SHAPE_FLOATS); padded.set(entry.data);
    for (let j = entry.count; j < entry.capacity; j++) padded[j * SHAPE_FLOATS + 20] = SHAPE.DISABLED;
    this.device.queue.writeBuffer(this.shapeBuffer, entry.offset * SHAPE_BYTES, padded);
    return padded.byteLength;
  }
  updateGeometry(options, geometry) {
    const old = this.lastGeometry;
    if (!geometry.changedSlots || !old?.token || geometry.previousToken !== old.token || !this.entriesBySlot) return false;
    const ordered = geometry.orderedObjects, before = old.orderedObjects;
    if (!ordered || ordered.length !== before?.length || ordered.some((g, i) => g.slot !== before[i].slot || uidOf(g) !== uidOf(before[i]))) return false;
    const matrix = cameraMatrix(options), scale = Math.hypot(matrix[0], matrix[1]) * this.dpr, updates = [];
    this.artworks.begin(options.artworkRevision);
    this.stats.compiledObjects = 0; this.stats.rasterizedObjects = 0;
    for (const slot of geometry.changedSlots) {
      const g = geometry.objects.get(slot), previous = this.entriesBySlot.get(slot);
      if (!g?.drawables?.length && !previous) continue;
      if (!g || !previous) return false;
      const entry = this.objectEntry(g, g.drawables, previous.opacity, previous.key, previous.transform, scale);
      if (entry.count > previous.capacity) return false;
      entry.capacity = previous.capacity; entry.offset = previous.offset;
      updates.push({ previous, entry });
    }
    let uploadBytes = 0, primitiveUploadCalls = 0;
    for (const { previous, entry } of updates) {
      if (entry.data !== previous.data) { uploadBytes += this.uploadEntry(entry); primitiveUploadCalls++; }
      this.stats.primitives += entry.count - previous.count;
      this.stats.textureObjects += Number(!!entry.texture) - Number(!!previous.texture);
      this.stats.gpuBytes += (entry.texture?.bytes || 0) - (previous.texture?.bytes || 0);
      // Retain layout/command references, replacing only the changed object's fields.
      Object.assign(previous, entry);
    }
    this.lastGeometry = geometry;
    this.artworkStats();
    Object.assign(this.stats, { uploadBytes, primitiveUploadCalls, updatedObjects: updates.length, cachedObjects: ordered.length - updates.length,
      preparation: 'incremental', warnings: geometry.warnings || [] });
    return true;
  }
  prepare(options, geometry) {
    const steps = this.prepareSteps(options, geometry);
    for (;;) { const step = steps.next(); if (step.done) return step.value; }
  }
  *prepareSteps(options, geometry) {
    this.artworks.begin(options.artworkRevision);
    const matrix = cameraMatrix(options), scale = Math.hypot(matrix[0], matrix[1]) * this.dpr, next = [];
    this.stats.compiledObjects = 0; this.stats.rasterizedObjects = 0;
    const reuseOnions = this.lastGeneration === this.generation && (this.lastGeometry === geometry || geometry.previousToken === this.lastGeometry?.token);
    const previousOnions = reuseOnions ? this.onionScenes || [] : [], onionScenes = [];
    for (const [i, onion] of (options.onionFrames || []).entries()) {
      const frame = onion.frame || onion;
      const scene = onion.geometry || previousOnions.find(cached => cached.frame === frame)?.geometry || (yield* buildGeometrySteps(options.report, frame));
      onionScenes.push({frame, geometry: scene, opacity: onion.opacity, beforeUid: onion.beforeUid, showOnTop: onion.showOnTop});
    }
    this.onionScenes = onionScenes;
    const groups = composeSceneGroups(geometry, onionScenes, options.frame);
    let index = 1, shapeCount = 0, compatibilityCount = 0, cached = 0;
    for (const bg of this.background(options)) { next.push({ key: `background-${next.length}`, transform: 0, root: { x: 0, y: 0 }, count: bg.data.length / SHAPE_FLOATS, data: bg.data, texture: bg.texture }); }
    for (const { g, items, opacity, key, isOnion } of groups) {
      if (this.vectorCache.has(g)) cached++;
      const entry = yield* this.objectEntrySteps(g, items, opacity, key, index++, scale, isOnion);
      if (entry.texture) compatibilityCount++;
      next.push(entry);
      yield {phase: 'GPU primitives', completed: index - 1, total: groups.length};
    }
    let relayout = this.layout?.length !== next.length;
    for (let i = 0; i < next.length; i++) {
      const entry = next[i], previous = this.layout?.[i];
      entry.capacity = previous?.key === entry.key && previous.capacity >= entry.count ? previous.capacity : pow2(entry.count);
      entry.offset = shapeCount; shapeCount += entry.capacity;
      if (previous?.key !== entry.key || previous.capacity !== entry.capacity || previous.offset !== entry.offset) relayout = true;
    }
    if (this.ensureBuffers(shapeCount, index)) relayout = true;
    let uploadBytes = 0, primitiveUploadCalls = 0;
    if (relayout) {
      this.uploadStaging ??= new Float32Array(SHAPE_UPLOAD_RECORDS * SHAPE_FLOATS);
      const uploaded = yield* uploadShapeLayoutSteps(this.device.queue, this.shapeBuffer, next, this.uploadStaging);
      uploadBytes = uploaded.bytes; primitiveUploadCalls = uploaded.calls;
    } else {
      for (let i = 0; i < next.length; i++) {
        const entry = next[i], previous = this.layout?.[i];
        if (previous?.data !== entry.data) { uploadBytes += this.uploadEntry(entry); primitiveUploadCalls++; yield {phase: 'GPU upload', completed: i + 1, total: next.length}; }
      }
    }
    this.layout = next; this.entries = new Map(next.filter(e => e.g).map(e => [e.key, e])); this.transformData = new Float32Array(index * 4);
    this.entriesBySlot = new Map(next.filter(e => e.g && e.key === e.uid).map(e => [e.g.slot, e]));
    this.transformData.set([0, 0, 1, 1]);
    this.shapeCount = shapeCount; this.lastGeometry = geometry; this.lastGeneration = this.generation;
    this.stats.uploadBytes = uploadBytes; this.stats.primitiveUploadCalls = primitiveUploadCalls; this.stats.primitives = next.reduce((n, e) => n + e.count, 0); this.stats.objects = geometry.objects.size; this.stats.textureObjects = compatibilityCount; this.stats.cachedObjects = cached;
    this.artworkStats();
    this.stats.warnings = geometry.warnings || [];
    this.stats.preparation = 'layout'; this.stats.updatedObjects = groups.length;
  }
  artworkStats(){
    this.rasterCache.retain(new Set(this.layout?.filter(entry=>entry.g).map(entry=>entry.texture).filter(Boolean)), this.generation);
    this.stats.editorRasterCache={...this.rasterCache.stats};
    const textures=new Set(this.layout?.map(entry=>entry.texture).filter(Boolean));
    this.stats.gpuBytes=(this.shapeBuffer?.size||0)+(this.transformBuffer?.size||0)+this.rasterCache.bytes;
    this.stats.uniqueTextures=textures.size;
    this.stats.sharedArtwork={...this.artworks.stats,entries:this.artworks.lru.size,bytes:this.artworks.bytes,definitionBytes:this.artworks.definitionBytes};
  }
  render(options) {
    if (this.destroyed) return;
    this.stats.rasterCacheMisses={};this.stats.rasterCacheMissSamples=[];
    this.liveEditing=Boolean(options.liveEditing);
    this.last = options.preparedPacket ? {...options, preparedPacket: undefined} : options; const start = performance.now();
    const { report, frame, view = {}, hiddenUids, dragTranslations } = options;
    if (!report || !frame) return;
    this.useReport(report);
    const geometry = options.geometry || buildGeometry(report, frame);
    this.stats.adoptedObjects = 0; this.stats.adoptedVectorBytes = 0;
    if (options.preparedPacket && (this.lastAdoptionToken !== geometry.token || this.lastAdoptionKey !== options.preparedPacket.key)) {
      const adopted = adoptPreparedVectors(options.preparedPacket, geometry, this.vectorCache, this.compatibilityCache);
      this.stats.adoptedObjects = adopted.objects; this.stats.adoptedVectorBytes = adopted.bytes;
      this.lastAdoptionToken = geometry.token; this.lastAdoptionKey = options.preparedPacket.key;
    }
    // Geometry identity is stable during view changes and direct object translation.
    const backgroundKey = JSON.stringify([frame.background_id, frame.background_id_b, frame.background_mix, editorBackgroundColor(options) ?? sceneBackgroundColor(report, frame), effectiveCamera(report, frame, options.cameraEnabled !== false)]);
    const onionFrames = options.onionFrames || [], onionChanged = this.onionFrameRefs?.length !== onionFrames.length || onionFrames.some((frame, i) => frame !== this.onionFrameRefs?.[i]);
    const camera = cameraMatrix(options), rasterResolution = Math.max(.5, Math.min(8, 2 ** Math.ceil(Math.log2(Math.hypot(camera[0], camera[1]) * this.dpr))));
    if (this.lastGeometry !== geometry || this.lastReport !== report || this.lastGeneration !== this.generation || this.backgroundKey !== backgroundKey || onionChanged || (this.stats.textureObjects && this.lastRasterResolution !== rasterResolution)) {
      const canUpdate = this.lastReport === report && this.lastGeneration === this.generation && this.backgroundKey === backgroundKey && !onionChanged && (!this.stats.textureObjects || this.lastRasterResolution === rasterResolution);
      if (!canUpdate || !this.updateGeometry(options, geometry)) this.prepare(options, geometry);
      this.lastReport = report; this.backgroundKey = backgroundKey; this.onionFrameRefs = [...onionFrames]; this.lastRasterResolution = rasterResolution;
    } else { this.stats.uploadBytes = 0; this.stats.primitiveUploadCalls = 0; this.stats.updatedObjects = 0; this.stats.compiledObjects = 0; this.stats.rasterizedObjects = 0; this.stats.preparation = 'retained'; }
    const matrix = cameraMatrix(options), zoom = Number(view.scale ?? 1), x = Number(view.x ?? 0), y = Number(view.y ?? 0);
    const uniform = new Float32Array([matrix[0], matrix[2], matrix[4], Math.hypot(matrix[0], matrix[1]), matrix[1], matrix[3], matrix[5], 0, this.width, this.height, this.dpr, options.clipToCanvas === false ? 0 : 1, x, y, x + report.canvas_width * zoom, y + report.canvas_height * zoom]);
    this.device.queue.writeBuffer(this.uniform, 0, uniform);
    for (const entry of this.layout) {
      if (!entry.g) continue;
      const delta = entry.isOnion ? null : dragTranslations?.get?.(entry.uid) || dragTranslations?.[entry.uid];
      this.transformData.set([entry.root.x + (delta?.x || 0), entry.root.y + (delta?.y || 0), entry.opacity, hiddenUids?.has(entry.uid) ? 0 : 1], entry.transform * 4);
    }
    this.device.queue.writeBuffer(this.transformBuffer, 0, this.transformData);
    const encoder = this.device.createCommandEncoder({ label: 'StykAnimate viewport frame' });
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.msaa.createView(), resolveTarget: this.context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'discard' }] });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.globalBindGroup);
    let calls = 0, begin = -1, count = 0;
    const flush = () => { if (!count) return; pass.setBindGroup(1, this.blankBindGroup); pass.draw(6, count, 0, begin); calls++; begin = -1; count = 0; };
    for (const entry of this.layout) {
      if (entry.texture) { flush(); pass.setBindGroup(1, entry.texture.bindGroup); pass.draw(6, entry.count, 0, entry.offset); calls++; }
      else { if (begin < 0) begin = entry.offset; count += entry.capacity; }
    }
    flush();
    this.stats.handleCount=options.canvasHandles?.length||0;
    this.stats.handleUploadBytes=options.canvasHandles ? this.handleRenderer.update(options.canvasHandles,dragTranslations,options.outlineHandles) : 0;
    this.stats.handleDrawCalls=options.canvasHandles ? this.handleRenderer.draw(pass) : 0;
    calls+=this.stats.handleDrawCalls;
    pass.end(); this.device.queue.submit([encoder.finish()]);
    Object.assign(this.stats, { frameMs: performance.now() - start, drawCalls: calls, mode: 'retained editor', transformUploadBytes: this.transformData.byteLength,
      preparedBytes: this.preparedFrames.bytes, preparedFrames: this.preparedFrames.frames.size, workerCompileMs: null, packetUploadMs: null });
    return geometry;
  }
  destroy() {
    this.artworks.clear();
    this.destroyed = true; this.last = null; this.uploadStaging = null; this.onionScenes = []; this.preparedFrames.clear(); this.handleRenderer?.destroy(); this.msaa?.destroy(); this.shapeBuffer?.destroy(); this.transformBuffer?.destroy(); this.uniform?.destroy(); this.blankTexture?.destroy();
    this.rasterCache.clear();
    for (const entry of this.backgroundImages?.values() || []) entry.texture.destroy();
    this.rasterSurfaces.dispose(); this.context.unconfigure(); this.device.destroy();
  }
}

function preparedSceneKeys(options, dpr) {
  const {report, frame} = options, camera = cameraMatrix(options);
  return {
    backgroundKey: JSON.stringify([frame.background_id, frame.background_id_b, frame.background_mix, editorBackgroundColor(options) ?? sceneBackgroundColor(report, frame), effectiveCamera(report, frame, options.cameraEnabled !== false)]),
    rasterResolution: Math.max(.5, Math.min(8, 2 ** Math.ceil(Math.log2(Math.hypot(camera[0], camera[1]) * dpr)))),
  };
}

/** Build a replacement editor layout without changing live buffers. Existing
 * artwork stays owned by the renderer; leases protect both layouts until the
 * caller atomically publishes or cancels this preparation. */
async function prepareSceneUpdate(renderer, request) {
  const {report, frame, geometry, signal, sliceMs=4, yieldControl, getView}=request;
  if(renderer.activeReport!==report||!geometry)throw new Error('An editable scene update requires the active document and its geometry.');
  const generation=renderer.generation, liveGeometry=renderer.lastGeometry, started=performance.now();
  let stage, disposed=false, activated=false;
  const lease=renderer.rasterCache.lease(renderer.layout?.map(entry=>entry.texture).filter(Boolean));
  const check=()=>{
    if(disposed||signal?.aborted||renderer.destroyed||renderer.activeReport!==report||renderer.generation!==generation||renderer.lastGeometry!==liveGeometry||request.checkCurrent?.()===false)
      throw new DOMException('Editable scene preparation was superseded.', 'AbortError');
  };
  const dispose=()=>{
    if(disposed||activated)return;disposed=true;
    stage?.shapeBuffer?.destroy();stage?.transformBuffer?.destroy();stage?.rasterSurfaces.dispose();
    for(const texture of stage?.stagingTextures||[])texture.destroy();
    lease.release();
    if(!renderer.destroyed)renderer.artworkStats();
  };
  try {
    check();
    stage=new WebGPURenderer(renderer.canvas,renderer.device,renderer.context,renderer.format,{...renderer.options,onInvalidate:undefined,onStatus:undefined});
    for(const key of ['pipeline','globalLayout','textureLayout','uniform','sampler','nearestSampler','blankBindGroup','resources','rasterCache','vectorCache','compatibilityCache','artworks','artworkAliases'])stage[key]=renderer[key];
    stage.activeReport=report;stage.generation=generation;stage.stagingTextures=new Set();stage.rasterLease=lease;
    const timings={};let view={...(getView?.()||request.view||{})}, keys;
    for(;;){
      check();stage.dpr=renderer.dpr;
      const options={...request,report,frame,geometry,view};
      const built=await consumeSceneSteps(stage.prepareSteps(options,geometry),{signal,sliceMs,yieldControl,checkCurrent:check,onProgress:request.onProgress});
      timings.gpu=built.timings;check();
      await renderer.device.queue.onSubmittedWorkDone();check();
      keys=preparedSceneKeys(options,stage.dpr);
      view={...(getView?.()||view)};
      const fresh=preparedSceneKeys({...options,view},renderer.dpr);
      if(stage.stats.textureObjects&&keys.rasterResolution!==fresh.rasterResolution)continue;
      stage.lastReport=report;stage.backgroundKey=keys.backgroundKey;stage.onionFrameRefs=[...(request.onionFrames||[])];
      stage.lastRasterResolution=fresh.rasterResolution;break;
    }
    timings.elapsedMs=performance.now()-started;
    return {report,frame,geometry,view,timings,dispose,
      activate(){
        check();if(activated)throw new Error('The editable scene was already published.');
        const fresh=preparedSceneKeys({...request,view:getView?.()||view},renderer.dpr);
        if(fresh.backgroundKey!==keys.backgroundKey||(stage.stats.textureObjects&&fresh.rasterResolution!==stage.lastRasterResolution))
          throw new DOMException('The editable scene view changed before publication.', 'AbortError');
        renderer.shapeBuffer?.destroy();renderer.transformBuffer?.destroy();renderer.rasterSurfaces.dispose();
        for(const entry of renderer.backgroundImages?.values()||[])entry.texture.destroy();
        for(const key of ['entries','layout','lastGeometry','lastGeneration','lastReport','backgroundKey','backgroundImages','onionScenes','onionFrameRefs','lastRasterResolution','shapeBuffer','transformBuffer','globalBindGroup','transformData','shapeCount','entriesBySlot','uploadStaging','rasterSurfaces'])renderer[key]=stage[key];
        Object.assign(renderer.stats,stage.stats,{preparedCache:renderer.preparedFrames.stats,editablePreparation:timings});
        stage.stagingTextures.clear();activated=true;lease.release();renderer.artworkStats();
        renderer.last=null;return geometry;
      }};
  }catch(error){dispose();throw error;}
}

/** Build an incoming scene without touching the live canvas, caches or buffers. */
async function prepareInitialScene(renderer, request) {
  const {report, frame, signal, sliceMs = 4, yieldControl, onProgress, getView} = request;
  const constructionColor = editorBackgroundColor(request);
  if (!report || !frame) throw new Error('An initial scene requires its report and evaluated frame.');
  if (renderer.activeReport === report || renderer.last?.report === report) throw new Error('Initial scene preparation requires a separate incoming document.');
  const started = performance.now(); let stage, transferred = false, imageFailure;
  const checkCurrent = () => {
    if (renderer.destroyed || signal?.aborted) throw new DOMException('Scene preparation cancelled.', 'AbortError');
    if (renderer.device && renderer.stats.backend !== 'WebGPU') throw new Error('The graphics device is unavailable.');
    request.checkCurrent?.(); if (imageFailure) throw imageFailure;
  };
  const media = createSceneImages({url: renderer.resources.url, signal, checkCurrent, imageFactory: request.imageFactory});
  const discard = () => {
    if (transferred) return;
    if (stage) {
      stage.destroyed = true; stage.shapeBuffer?.destroy(); stage.transformBuffer?.destroy();
      for (const texture of stage.stagingTextures) texture.destroy();
      stage.stagingTextures.clear(); stage.rasterCache.clear(); stage.rasterSurfaces.dispose(); stage.layout = []; stage.entries.clear();
    }
    media.dispose();
  };
  const backgroundLoad = media.load(backgroundImageAssets(report, frame)).catch(error => {imageFailure = error;});
  try {
    checkCurrent();
    const timings = {}, geometry = request.geometry || await (await import('./pivot/geometry.mjs')).buildGeometryAsync(report, frame, null, {
      signal, sliceMs, yieldControl, checkCurrent, onProgress, onTiming: value => {timings.geometry = value;},
    });
    await backgroundLoad; checkCurrent();
    await media.load(frameImageAssets(geometry)); checkCurrent(); timings.mediaReadyMs = performance.now() - started;
    let view = {...(getView?.() || request.view || {})};
    if (renderer instanceof WebGPURenderer) {
      stage = new WebGPURenderer(renderer.canvas, renderer.device, renderer.context, renderer.format, {
        ...renderer.options, resources: media.resources, onInvalidate: undefined, onStatus: undefined,
      });
      for (const key of ['pipeline', 'globalLayout', 'textureLayout', 'uniform', 'sampler', 'nearestSampler', 'blankBindGroup']) stage[key] = renderer[key];
      stage.stagingTextures = new Set(); stage.activeReport = report;
      for (;;) {
        stage.dpr = renderer.dpr;
        const options = {report, frame, geometry, view, cameraEnabled: request.cameraEnabled !== false, editorBackgroundColor: constructionColor, onionFrames: []};
        const prepared = await consumeSceneSteps(stage.prepareSteps(options, geometry), {signal, sliceMs, yieldControl, checkCurrent, onProgress});
        timings.gpu = prepared.timings; checkCurrent();
        const queueStart = performance.now(); await renderer.device.queue.onSubmittedWorkDone();
        timings.gpuReadyMs = (timings.gpuReadyMs || 0) + performance.now() - queueStart; checkCurrent();
        const freshView = {...(getView?.() || view)}, keys = preparedSceneKeys(options, stage.dpr);
        const freshKeys = preparedSceneKeys({...options, view: freshView}, renderer.dpr);
        view = freshView;
        if (stage.stats.textureObjects && keys.rasterResolution !== freshKeys.rasterResolution) continue;
        stage.lastReport = report; stage.backgroundKey = keys.backgroundKey; stage.onionFrameRefs = [];
        stage.lastRasterResolution = freshKeys.rasterResolution; break;
      }
    }
    checkCurrent(); timings.elapsedMs = performance.now() - started;
    const prepared = {report, frame, geometry, images: media.images, view, timings, cameraEnabled: request.cameraEnabled !== false, editorBackgroundColor: constructionColor,
      renderer, stage, activated: false, disposed: false,
      dispose() {if (!this.activated && !this.disposed) {this.disposed = true; discard();}},
      transfer() {transferred = true; this.activated = true;},
    };
    return prepared;
  } catch (error) {discard(); throw error;}
}

/** Publication is synchronous: all decoding, geometry and GPU allocation is done. */
function activatePreparedScene(renderer, prepared, options = {}) {
  const {report = prepared?.report, frame = prepared?.frame, geometry = prepared?.geometry, view = prepared?.view} = options;
  const constructionColor = Object.hasOwn(options, 'editorBackgroundColor') ? options.editorBackgroundColor : prepared?.editorBackgroundColor;
  if (!prepared || prepared.renderer !== renderer || prepared.activated || prepared.disposed || renderer.destroyed ||
      prepared.report !== report || prepared.frame !== frame || prepared.geometry !== geometry)
    throw new Error('The prepared initial scene no longer matches this document.');
  const stage = prepared.stage;
  if (stage) {
    const keys = preparedSceneKeys({report, frame, view, cameraEnabled: prepared.cameraEnabled, editorBackgroundColor: constructionColor}, renderer.dpr);
    if (keys.backgroundKey !== stage.backgroundKey)
      throw new Error('The construction background changed after scene preparation; prepare its background again.');
    if (stage.stats.textureObjects && keys.rasterResolution !== stage.lastRasterResolution)
      throw new Error('The viewport changed after scene preparation; prepare its raster scale again.');
    renderer.useReport(report);
    renderer.shapeBuffer?.destroy(); renderer.transformBuffer?.destroy(); renderer.rasterSurfaces.dispose();
    for (const key of ['entries', 'layout', 'rasterCache', 'vectorCache', 'compatibilityCache', 'artworks', 'artworkAliases', 'generation', 'lastGeometry', 'lastGeneration',
      'lastReport', 'backgroundKey', 'backgroundImages', 'onionScenes', 'onionFrameRefs', 'lastRasterResolution', 'shapeBuffer', 'transformBuffer',
      'globalBindGroup', 'transformData', 'shapeCount', 'entriesBySlot', 'uploadStaging', 'rasterSurfaces']) renderer[key] = stage[key];
    Object.assign(renderer.stats, stage.stats, {preparedCache: renderer.preparedFrames.stats, initialPreparation: prepared.timings});
    stage.stagingTextures.clear(); prepared.stage = null;
  }
  renderer.last = null; prepared.view = {...view}; prepared.transfer(); return geometry;
}

/** WebGPU is preferred. Unsupported systems get a clearly labeled compatibility renderer. */
export async function createRenderer(canvas, options = {}) {
  let reason = 'WebGPU is unavailable in this browser or graphics driver.';
  if (globalThis.navigator?.gpu) {
    let context, device;
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('No compatible WebGPU adapter was found.');
      device = await adapter.requestDevice();
      context = canvas.getContext('webgpu');
      if (!context) throw new Error('The canvas could not create a WebGPU context.');
      const info = adapter.info;
      const renderer = new WebGPURenderer(canvas, device, context, navigator.gpu.getPreferredCanvasFormat(), { ...options, adapterName: [info?.vendor, info?.architecture, info?.device].filter(Boolean).join(' · ') });
      await renderer.initialize(); options.onStatus?.(renderer.stats); return renderer;
    } catch (error) {
      reason = error.message; device?.destroy();
      // A canvas cannot change its context type after WebGPU has been acquired.
      if (context) { context.unconfigure(); throw new Error(`WebGPU initialization failed: ${reason}`); }
    }
  }
  const fallback = new CanvasFallback(canvas, options, reason); options.onStatus?.(fallback.stats); return fallback;
}
