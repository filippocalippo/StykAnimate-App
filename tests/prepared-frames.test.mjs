import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreparedFrameCache, combinePreparedCommands } from '../src/prepared-frames.mjs';
import { SHAPE, shapeRecord } from '../src/renderer-geometry.mjs';

globalThis.GPUBufferUsage = { STORAGE: 128, COPY_DST: 8 };
globalThis.GPUTextureUsage={TEXTURE_BINDING:4,COPY_DST:2,RENDER_ATTACHMENT:16};
const report = { canvas_width: 640, canvas_height: 480 };
const packet = (key, revision = 1) => ({ key, revision, frame: {}, shapes: new Float32Array(shapeRecord({ a: [0, 0, 10, 10], b: [0, 0, 3, 0], transform: 1 })), transforms: new Float32Array([0, 0, 1, 1, 20, 30, 1, 1]), uids: new Uint32Array([0, 7]), groups: [{ firstInstance: 0, instanceCount: 1, transformIndex: 1, uid: 7 }], compatibility: [], objectCount: 1, compileMs: 2 });
function fakeRenderer() {
  const buffers = [], writes = [];
  const pass = {setPipeline() {}, setBindGroup() {}, draw() {}, end() {}};
  return { generation: 0, uniform: {}, globalLayout: {}, dpr: 1, buffers, writes, stats: {}, width: 640, height: 480,
    msaa: {createView() {}}, context: {getCurrentTexture() {return {createView() {}};}},
    device: { limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024 },
      createCommandEncoder() {return {beginRenderPass() {return pass;}, finish() {return {};}};},
      createBuffer(spec) { const buffer = { ...spec, destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(buffer); return buffer; },
      createBindGroup(spec) { return spec; }, queue: { writeBuffer(...args) { writes.push(args); }, submit() {} } },
    backgroundsReady: () => true,
    background: () => [{ data: new Float32Array(shapeRecord({ mode: SHAPE.RECT })), texture: null }],
  };
}
test('prepared draw commands retain painter order and merge adjacent vector ranges', () => {
  const texture = { bindGroup: {} }, backgrounds = [{ data: new Float32Array(24), texture: null }];
  const { commands, backgroundCount } = combinePreparedCommands(backgrounds, [{ firstInstance: 0, instanceCount: 2 }, { firstInstance: 2, instanceCount: 1, compatibilityIndex: 0 }, { firstInstance: 3, instanceCount: 4 }, { firstInstance: 7, instanceCount: 2 }], [texture]);
  assert.equal(backgroundCount, 1); assert.deepEqual(commands.map(c => [c.firstInstance, c.instanceCount, Boolean(c.texture)]), [[0, 3, false], [3, 1, true], [4, 6, false]]);
});

test('prepared camera mode defaults to the packet and rejects inconsistent cropped views', () => {
  const renderer = fakeRenderer(), cache = new PreparedFrameCache(renderer), neutral = packet('1:0');
  neutral.cameraEnabled = false; neutral.frame.camera = {x: 100, y: 50, scale: .5, angle_rad: .4};
  let backgroundMode; renderer.background = options => {backgroundMode = options.cameraEnabled; return [];};
  assert.equal(cache.prepare(neutral, {report}), '1:0'); assert.equal(backgroundMode, false);
  assert.equal(cache.render('1:0', {report, view: {scale: 2, x: 3, y: 4}}), true);
  const uniform = renderer.writes.findLast(([buffer]) => buffer === renderer.uniform)[2];
  assert.deepEqual([...uniform.slice(0, 7)], [2, 0, 3, 2, 0, 2, 4]);
  assert.throws(() => cache.prepare(neutral, {report, cameraEnabled: true}), /camera mode/);
  assert.throws(() => cache.render('1:0', {report, cameraEnabled: true}), /camera mode/);
  assert.throws(() => cache.prepare({...neutral, cameraEnabled: true}, {report}), /two camera views/);
  assert.throws(() => cache.prepare({...neutral, key: '1:1', cameraEnabled: 'false'}, {report}), /boolean/);
  const legacy = packet('1:2'); cache.prepare(legacy, {report});
  assert.equal(cache.frames.get('1:2').cameraEnabled, true);
});

test('prepared visibility accepts a stable membership provider without a size field', () => {
  const renderer = fakeRenderer(), cache = new PreparedFrameCache(renderer), hidden = new Set([7]);
  cache.prepare(packet('1:0'), {report}); const frame = cache.frames.get('1:0');
  const visibility = {has: uid => hidden.has(uid)};
  cache.render('1:0', {report, hiddenUids: visibility});
  assert.equal(frame.liveTransforms[7], 0);
  hidden.clear(); cache.render('1:0', {report, hiddenUids: visibility});
  assert.equal(frame.liveTransforms[7], 1);
  hidden.add(7); cache.render('1:0', {report, hiddenUids: visibility});
  cache.render('1:0', {report}); assert.equal(frame.transformed, false);
  assert.equal(renderer.writes.findLast(([buffer]) => buffer === frame.transformBuffer)[2][7], 1);
});
test('default GPU packet budget matches the worker 128 MiB frame contract', () => {
  const cache = new PreparedFrameCache(fakeRenderer());
  assert.equal(cache.maxBytes, 128 * 1024 * 1024); assert.equal(cache.maxFrames, 120);
});
test('GPU frame LRU releases evicted buffers and never reuploads a cache hit', () => {
  const renderer = fakeRenderer(), cache = new PreparedFrameCache(renderer, { maxFrames: 2, maxBytes: 1024 });
  cache.prepare(packet('1:0'), { report }); cache.prepare(packet('1:1'), { report }); const writes = renderer.writes.length;
  cache.prepare(packet('1:0'), { report }); assert.equal(renderer.writes.length, writes);
  cache.prepare(packet('1:2'), { report }); assert.equal(cache.has('1:1'), false); assert.equal(cache.has('1:0'), true);
  assert.ok(renderer.buffers[2].destroyed && renderer.buffers[3].destroyed); assert.equal(cache.stats.evictions, 1);
  assert.ok(cache.bytes <= cache.maxBytes); cache.clear(); assert.equal(cache.bytes, 0); assert.ok(renderer.buffers.every(buffer => buffer.destroyed));
});
test('resource loading and document revisions invalidate stale prepared frames', () => {
  const renderer = fakeRenderer(), cache = new PreparedFrameCache(renderer);
  cache.prepare(packet('1:0'), { report }); renderer.generation++; assert.equal(cache.has('1:0'), false);
  cache.prepare(packet('1:0'), { report }); assert.equal(cache.has('1:0'), true);
  cache.prepare(packet('2:0', 2), { report }); assert.equal(cache.has('1:0'), false); assert.equal(cache.stats.frames, 1);
  renderer.backgroundsReady = () => false; assert.equal(cache.prepare(packet('2:1', 2), { report }), null); assert.equal(cache.has('2:1'), false);
});
test('a single frame larger than the GPU budget is rejected before buffer allocation', () => {
  const renderer = fakeRenderer(), cache = new PreparedFrameCache(renderer, { maxBytes: 100 });
  assert.throws(() => cache.prepare(packet('1:0'), { report }), /budget/); assert.equal(renderer.buffers.length, 0); assert.equal(cache.bytes, 0);
  const imagePacket = packet('1:1'); imagePacket.compatibility = [{bitmap: {width: 1000, height: 1000}}];
  let allocatedTexture = false; renderer.device.createTexture = () => { allocatedTexture = true; };
  assert.throws(() => cache.prepare(imagePacket, { report }), /budget/); assert.equal(allocatedTexture, false, 'oversized image packets must be rejected before transient GPU allocation');
});

function textureRenderer(){
  const renderer=fakeRenderer();renderer.textures=[];renderer.copies=[];
  renderer.textureBindGroup=texture=>({texture});
  renderer.device.createTexture=spec=>{const texture={...spec,destroyed:false,destroy(){this.destroyed=true;}};renderer.textures.push(texture);return texture;};
  renderer.device.queue.copyExternalImageToTexture=(...args)=>renderer.copies.push(args);
  return renderer;
}
const imagePacket=(tick,artworkKey='shared')=>{const p=packet(`1:${tick}`);p.compatibility=[{artworkKey,bitmap:{width:10,height:10}}];p.groups[0].compatibilityIndex=0;return p;};

test('GPU frames share textures across packets and retain them until the last frame is evicted',()=>{
  const renderer=textureRenderer(),cache=new PreparedFrameCache(renderer,{maxBytes:1200,maxFrames:2});
  cache.prepare(imagePacket(0),{report});cache.prepare(imagePacket(1),{report});
  assert.equal(renderer.copies.length,1);assert.equal(cache.bytes,848);
  cache.prepare(imagePacket(2),{report});assert.equal(renderer.copies.length,1);assert.equal(renderer.textures[0].destroyed,false);
  assert.equal(cache.frames.size,2);assert.equal(cache.bytes,848);
  cache.prepare(imagePacket(3,'different'),{report});assert.equal(renderer.textures[0].destroyed,true);assert.equal(cache.frames.size,1);assert.equal(cache.bytes,624);
  cache.clear();assert.equal(cache.bytes,0);assert.equal(cache.textures.size,0);assert.ok(renderer.textures.every(t=>t.destroyed));
});

test('failed GPU frame allocation releases only newly acquired references and buffers',()=>{
  const renderer=textureRenderer(),cache=new PreparedFrameCache(renderer);
  cache.prepare(imagePacket(0),{report});const bytes=cache.bytes,create=renderer.device.createBuffer;let calls=0;
  renderer.device.createBuffer=spec=>{if(++calls===2)throw new Error('allocation failed');return create(spec);};
  assert.throws(()=>cache.prepare(imagePacket(1),{report}),/allocation failed/);
  assert.equal(cache.bytes,bytes);assert.equal(renderer.textures[0].destroyed,false);assert.equal(renderer.buffers.at(-1).destroyed,true);
  cache.clear();assert.equal(renderer.textures[0].destroyed,true);assert.equal(cache.bytes,0);
});

test('fallback rasters belong to prepared frames, survive sibling eviction, and obey the GPU budget', () => {
  const renderer = textureRenderer(), cache = new PreparedFrameCache(renderer, {maxFrames: 2, maxBytes: 1200});
  const geometry = {root: {x: 0, y: 0}};
  renderer.rasterObject = (g, items, scale, artwork, owner) => {
    assert.equal(owner, cache.fallbackRasters);
    let raster = owner.get(artwork, 1, 0);
    if (!raster) {
      const texture = renderer.device.createTexture({});
      raster = {texture, bindGroup: {}, resolution: 1, generation: 0, bytes: g.bytes || 400, bounds: {x: 0, y: 0, width: 10, height: 10}};
      owner.set(artwork, raster);
    }
    return raster;
  };
  const fallback = (tick, g = geometry) => {
    const value = packet(`1:${tick}`); value.compatibility = [{g, items: []}]; value.groups[0].compatibilityIndex = 0; return value;
  };
  cache.prepare(fallback(0), {report}); cache.prepare(fallback(1), {report});
  assert.equal(cache.bytes, 848); assert.equal(cache.fallbackRasters.bytes, 400);
  cache.prepare(fallback(2), {report});
  assert.equal(renderer.textures.length, 1); assert.equal(renderer.textures[0].destroyed, false);
  assert.equal(cache.render('1:2', {report}), true);
  assert.throws(() => cache.prepare(fallback(3, {root: geometry.root, bytes: 1400}), {report}), /budget/);
  assert.equal(cache.bytes, 0); assert.equal(cache.fallbackRasters.bytes, 0);
  assert.ok(renderer.textures.every(texture => texture.destroyed));
  cache.prepare(fallback(4), {report}); cache.clear();
  assert.equal(cache.bytes, 0); assert.equal(cache.fallbackRasters.lru.size, 0);
});
