// Thumbnails and library previews from the engine (src/engine/engine-thumbnails.mjs,
// src/engine/engine-previews.mjs): which renderer draws a thumbnail (the stage, the preview
// worker on the CPU where the stage cannot, nothing where the engine does not draw), and the
// preview worker's queue, cancellation, failure and release.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EngineThumbnails} from '../src/engine/engine-thumbnails.mjs';
import {EnginePreviewWorker, EngineCameraMonitor} from '../src/engine/engine-previews.mjs';

/** An editor as thumbnails see it: a document, its revision, its timeline and change events. */
function editor({frames = 3} = {}) {
  const target = new EventTarget();
  target.report = {keyframes: Array.from({length: frames}, () => ({objects: []})), _styk: {}};
  target.revision = 4;
  target.timeline = Array.from({length: frames}, (_, i) => ({start: i * 10, count: 10}));
  return target;
}

/** The app's stage; `draw` answers the stage's thumbnail requests. */
function app({draw = () => 'drawn', thumbnails, threaded = true, refusal = null} = {}) {
  const calls = [];
  const stage = {
    engineSide: {engine: {threaded, progressSeen: () => 0, whenProgress: async () => {}, handle: {addresses: 0, address() { return 1000 + this.addresses++; }}}, thumbnails},
    prepareExport: (report, revision) => { calls.push(['definitions', revision]); return refusal; },
    renderThumbnail: async (request, canvas) => { calls.push(['thumbnail', request]); return draw(request, canvas); },
  };
  return {stage, calls};
}

/** A 2D canvas as thumbnails draw on it: what was drawn on it is recorded. */
const canvas = () => {
  const drawn = [];
  return {width: 320, height: 192, drawn, getContext: () => ({setTransform() {}, clearRect() {}, drawImage: image => drawn.push(image)})};
};

/** The engine's preview worker as thumbnails use it: `answer(message)` answers a thumbnail request. */
function previewWorker(answer = message => ({bitmap: {closed: false, close() { this.closed = true; }, tick: message.tick}})) {
  const requests = [];
  return {requests, worker: {usable: true, async request(message, {signal} = {}) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const sent = typeof message === 'function' ? message() : message;
    requests.push(sent);
    return answer(sent);
  }}};
}

test('a document the engine draws gets its thumbnails from the stage', async () => {
  const {stage, calls} = app(), target = editor();
  const thumbnails = new EngineThumbnails(target, {stage: () => stage});
  assert.equal(await thumbnails.renderThumbnail(1, canvas(), {tick: 10}), true);
  assert.deepEqual(calls.find(call => call[0] === 'thumbnail')[1], {revision: 4, tick: 10, width: 320, height: 192});
  assert.deepEqual(calls.slice(0, 1), [['definitions', 4]], 'the engine is asked for the revision first');
  // Without a tick the frame's start is drawn.
  assert.equal(await thumbnails.renderThumbnail(2, canvas()), true);
  assert.equal(calls.filter(call => call[0] === 'thumbnail').at(-1)[1].tick, 20);
  assert.equal(thumbnails.stats.engine.renders, 2);
});

test('in-between previews without a worker, refused documents and devices without a second canvas are not drawn', async () => {
  const target = editor();
  // An in-between preview samples a pose that is not in the document.
  const {stage, calls} = app();
  const thumbnails = new EngineThumbnails(target, {stage: () => stage, previews: async () => null});
  assert.equal(await thumbnails.renderThumbnail(0, canvas(), {inbetween: {ratio: .5}}), false);
  assert.equal(calls.length, 0, 'without a worker nothing is asked of the engine');
  assert.equal(thumbnails.stats.engine.refusal, 'the preview worker cannot sample in-betweens (no preview worker)');
  // The engine refuses the document (its stroke waits for publication).
  const refused = app({refusal: 'unpublished drawing strokes'});
  const second = new EngineThumbnails(target, {stage: () => refused.stage});
  assert.equal(await second.renderThumbnail(0, canvas()), false);
  assert.equal(second.stats.engine.refusal, 'unpublished drawing strokes');
  // WebGL2 and no preview worker either: the stage could not give thumbnails a canvas; later
  // requests are refused without asking the stage again.
  const gl = app({draw: () => 'refused'});
  const third = new EngineThumbnails(target, {stage: () => gl.stage, previews: async () => null});
  assert.equal(await third.renderThumbnail(0, canvas()), false);
  gl.stage.engineSide.thumbnails = false;
  const before = gl.calls.length;
  assert.equal(await third.renderThumbnail(1, canvas()), false);
  assert.equal(gl.calls.length, before, 'not asked again');
  assert.match(third.stats.engine.refusal, /no preview worker/);
  // No engine with worker threads.
  const plain = app({threaded: false});
  const fourth = new EngineThumbnails(target, {stage: () => plain.stage});
  assert.equal(await fourth.renderThumbnail(0, canvas()), false);
  assert.equal(plain.calls.length, 0);
  assert.equal(fourth.stats.engine.refusal, 'no engine with worker threads');
  // A frame outside the timeline.
  const fifth = new EngineThumbnails(target, {stage: () => stage});
  assert.equal(await fifth.renderThumbnail(9, canvas()), false);
  assert.equal(fifth.stats.engine.refusal, 'a frame outside the timeline');
});

test('in-between thumbnails sample an explicit interval in the existing engine worker without copying the document', async () => {
  const {stage, calls} = app(), target = editor();
  const worker = previewWorker();
  const thumbnails = new EngineThumbnails(target, {stage: () => stage, previews: async () => worker.worker});
  const inbetween = {ratio: .37, onionMode: 'settings', onionCount: 3, onionOpacity: .18, onionAhead: false};
  const picture = canvas();
  assert.equal(await thumbnails.renderThumbnail(1, picture, {inbetween}), true);
  assert.deepEqual(calls, [['definitions', 4]]);
  assert.deepEqual({...worker.requests[0], address: undefined}, {operation: 'inbetween', address: undefined, revision: 4, index: 1, ratio: .37, mode: 1, count: 3, opacity: .18, ahead: false, width: 320, height: 192});
  assert.equal(picture.drawn[0].closed, true);
  assert.equal(thumbnails.stats.engine.inbetweens, 1);
});

test('thumbnails the stage cannot draw are drawn by the preview worker on the CPU, from the engine\'s document', async () => {
  const target = editor();
  // A WebGL2 stage: it refuses thumbnails and says it never will.
  const {stage, calls} = app({draw: () => { stage.engineSide.thumbnails = false; return 'refused'; }});
  const cpu = previewWorker();
  const thumbnails = new EngineThumbnails(target, {stage: () => stage, previews: async () => cpu.worker});
  const card = canvas();
  assert.equal(await thumbnails.renderThumbnail(1, card, {tick: 10}), true);
  assert.deepEqual(calls.slice(0, 1), [['definitions', 4]], 'the engine is asked for the revision first');
  assert.equal(cpu.requests.length, 1);
  assert.deepEqual({...cpu.requests[0], address: undefined}, {operation: 'thumbnail', address: undefined, revision: 4, tick: 10, width: 320, height: 192});
  assert.equal(typeof cpu.requests[0].address, 'number', 'an engine address, made when the request is sent');
  assert.equal(card.drawn.length, 1);
  assert.equal(card.drawn[0].closed, true, 'the picture is copied onto the card and let go');
  // Later thumbnails go straight to the worker: the stage is not asked again.
  const asked = calls.filter(call => call[0] === 'thumbnail').length;
  assert.equal(await thumbnails.renderThumbnail(2, canvas()), true);
  assert.equal(calls.filter(call => call[0] === 'thumbnail').length, asked);
  assert.equal(cpu.requests.at(-1).tick, 20);
  assert.equal(cpu.requests[1].address !== cpu.requests[0].address, true, 'each request gets an address of its own');
  assert.equal(thumbnails.stats.engine.cpu, 2);
  // Another revision in the engine: not drawn, asked again later.
  const stale = previewWorker(() => ({refused: 'stale'}));
  const later = new EngineThumbnails(target, {stage: () => stage, previews: async () => stale.worker});
  assert.equal(await later.renderThumbnail(0, canvas()), false);
  assert.equal(later.stats.engine.stale, 1);
  // A frame the worker could not draw is not drawn.
  const timeout = previewWorker(() => ({refused: 'timeout', message: 'the frame was not prepared in time'}));
  const slow = new EngineThumbnails(target, {stage: () => stage, previews: async () => timeout.worker});
  assert.equal(await slow.renderThumbnail(0, canvas()), false);
  assert.equal(slow.stats.engine.refused, 1);
  // A cancelled thumbnail is not drawn and makes no address.
  const never = previewWorker();
  const cancelled = new EngineThumbnails(target, {stage: () => stage, previews: async () => never.worker});
  const controller = new AbortController();
  controller.abort();
  assert.equal(await cancelled.renderThumbnail(0, canvas(), {signal: controller.signal}), false);
  assert.equal(never.requests.length, 0);
});

test('a thumbnail waits for the stage, and one superseded by an edit is not drawn', async () => {
  const target = editor();
  let current = null;
  const {stage} = app({draw: () => 'stale'});
  const thumbnails = new EngineThumbnails(target, {stage: () => current});
  // The app is still creating its stage: the filmstrip asks again later.
  assert.equal(await thumbnails.renderThumbnail(0, canvas()), false);
  current = stage;
  // The engine holds another revision: not drawn, asked again later.
  assert.equal(await thumbnails.renderThumbnail(0, canvas()), false);
  assert.equal(thumbnails.stats.engine.stale, 1);
  // An edit while the engine catches up: the thumbnail is dropped.
  const slow = app({draw: () => 'drawn'});
  slow.stage.prepareExport = () => { target.revision++; target.dispatchEvent(Object.assign(new Event('change'), {detail: {kind: 'edit'}})); return null; };
  const edited = new EngineThumbnails(target, {stage: () => slow.stage});
  assert.equal(await edited.renderThumbnail(0, canvas()), false);
  assert.equal(slow.calls.filter(call => call[0] === 'thumbnail').length, 0);
  // Paused (playback, a gesture) and destroyed renderers draw nothing.
  const {stage: idle} = app();
  const paused = new EngineThumbnails(target, {stage: () => idle});
  paused.setPaused(true);
  assert.equal(await paused.renderThumbnail(0, canvas()), false);
  paused.destroy();
  assert.equal(await paused.renderThumbnail(0, canvas()), false);
});

/** A fake preview worker: `respond(message)` answers, `null` never does. */
function fakeWorker(respond) {
  const workers = [];
  const spawn = () => {
    const worker = new EventTarget();
    worker.messages = [];
    worker.postMessage = message => {
      worker.messages.push(message);
      const data = message.operation === 'release' ? {released: true} : respond(message);
      if (data) queueMicrotask(() => worker.dispatchEvent(Object.assign(new Event('message'), {data})));
    };
    worker.terminate = () => { worker.terminated = true; };
    workers.push(worker);
    return worker;
  };
  return {workers, spawn};
}
const engine = {join: {module: 'module', memory: 'memory', stack: 1, progress: 2}};

test('the preview worker answers requests in order, drops cancelled ones and is released when idle', async () => {
  const held = [];
  const {workers, spawn} = fakeWorker(message => message.operation === 'start' ? {id: 0, ok: true} : message.operation === 'slow' ? (held.push(message), null) : {id: message.id, ok: true, echo: message.operation});
  const previews = new EnginePreviewWorker(engine, {spawn, idleMs: 20});
  assert.equal((await previews.request({operation: 'library-poster'})).echo, 'library-poster');
  assert.equal(workers.length, 1, 'started with the first request');
  assert.equal(workers[0].messages[0].operation, 'start');
  // One request at a time: a later one waits; cancelled before it is sent, it never is.
  const controller = new AbortController();
  const slow = previews.request({operation: 'slow'});
  const queued = previews.request({operation: 'library-frame'}, {signal: controller.signal});
  controller.abort();
  await assert.rejects(queued, {name: 'AbortError'});
  assert.equal(workers[0].messages.filter(m => m.operation === 'library-frame').length, 0);
  workers[0].dispatchEvent(Object.assign(new Event('message'), {data: {id: held[0].id, ok: true, echo: 'slow'}}));
  assert.equal((await slow).echo, 'slow');
  // Idle: released (the worker frees what it holds, then ends).
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(workers[0].messages.at(-1).operation, 'release');
  assert.equal(workers[0].terminated, true);
  assert.equal(previews.worker, null);
  // The next request starts a new worker.
  await previews.request({operation: 'library-poster'});
  assert.equal(workers.length, 2);
  previews.release();
});

test('a request\'s message can be made when it is sent', async () => {
  const {workers, spawn} = fakeWorker(message => message.operation === 'start' ? {id: 0, ok: true} : {id: message.id, ok: true, address: message.address});
  const previews = new EnginePreviewWorker(engine, {spawn});
  let made = 0;
  const controller = new AbortController();
  const first = previews.request(() => ({operation: 'thumbnail', address: ++made}));
  const dropped = previews.request(() => ({operation: 'thumbnail', address: ++made}), {signal: controller.signal});
  controller.abort();
  await assert.rejects(dropped, {name: 'AbortError'});
  assert.equal((await first).address, 1);
  assert.equal(made, 1, 'a request cancelled before it was sent made nothing');
  assert.equal(workers[0].messages.filter(m => m.operation === 'thumbnail').length, 1);
  previews.release();
});

test('a settled preview request cannot send a late cancellation to the shared worker', async () => {
  const {workers, spawn} = fakeWorker(message => ({id: message.id, ok: true}));
  const previews = new EnginePreviewWorker(engine, {spawn});
  const controller = new AbortController();
  await previews.request({operation: 'monitor', address: 10}, {signal: controller.signal});
  controller.abort();
  assert.equal(workers[0].messages.some(message => message.operation === 'cancel'), false);
  previews.release();
});

test('a preview worker that cannot start fails every request', async () => {
  const {workers, spawn} = fakeWorker(message => message.operation === 'start' ? {id: 0, ok: false, error: 'the GPU canvas gives no pixels in this worker'} : null);
  const previews = new EnginePreviewWorker(engine, {spawn});
  await assert.rejects(previews.request({operation: 'library-poster'}), /could not start/);
  assert.equal(previews.usable, false);
  await assert.rejects(previews.request({operation: 'library-poster'}), /could not start/);
  // It answered, so it is asked to free its thread's memory before it ends (not just terminated).
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(workers[0].messages.at(-1).operation, 'release');
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 1, 'no second worker is started');
});

test('the camera monitor shares the displayed pose, keeps one pending request and never draws a stale answer', async () => {
  let version = 1, addresses = 0, invalidations = 0;
  const requests = [], bitmaps = [];
  const worker = {usable: true, request(message, options) {
    const sent = message();
    return new Promise(resolve => requests.push({sent, options, resolve}));
  }};
  const stage = {monitor_version: () => version, monitor_address: () => ++addresses, forget_monitor() { assert.fail('a transferred ticket belongs to the worker'); }};
  const monitor = new EngineCameraMonitor(stage, {previews: async () => worker, invalidate: () => invalidations++});
  const target = {save() {}, restore() {}, setTransform() {}, drawImage: bitmap => bitmaps.push(bitmap)};
  const view = {width: 320, height: 180, zoom: .5, panX: 0, panY: 0};
  assert.equal(monitor.draw(target, view), true, 'accepted without preparing or drawing JavaScript artwork');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(addresses, 1);
  assert.deepEqual(requests[0].sent, {operation: 'monitor', address: 1, ...view});
  version = 2;
  for (let i = 0; i < 40; i++) monitor.draw(target, view);
  assert.equal(requests.length, 1, 'the latest frame waits in one slot, never a queue of monitor captures');
  assert.equal(requests[0].options.signal.aborted, true);
  const stale = {closed: 0, close() { this.closed++; }};
  requests[0].resolve({bitmap: stale});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stale.closed, 1);
  assert.equal(bitmaps.length, 0);
  assert.equal(invalidations, 1, 'the app asks for the latest frame once the old one finishes');
  monitor.draw(target, view);
  await new Promise(resolve => setImmediate(resolve));
  const current = {closed: 0, close() { this.closed++; }};
  requests[1].resolve({bitmap: current});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(monitor.draw(target, view), true);
  assert.deepEqual(bitmaps, [current]);
  assert.equal(addresses, 2, 'a settled unchanged frame reuses its one bitmap');
  monitor.destroy();
  assert.equal(current.closed, 1);
  assert.equal(monitor.draw(target, view), false);
});

test('camera monitor cancellation before sending creates no ticket and disposal closes late bitmaps', async () => {
  let resolveWorker, addresses = 0;
  const stage = {monitor_version: () => 1, monitor_address: () => ++addresses};
  const loading = new EngineCameraMonitor(stage, {previews: () => new Promise(resolve => { resolveWorker = resolve; })});
  const target = {save() {}, restore() {}, setTransform() {}, drawImage() { assert.fail('disposed'); }};
  const view = {width: 160, height: 90, zoom: .25, panX: 0, panY: 0};
  loading.draw(target, view); loading.destroy();
  resolveWorker({usable: true, request() { assert.fail('cancelled before sending'); }});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(addresses, 0);
  let finish;
  const drawing = new EngineCameraMonitor(stage, {previews: async () => ({usable: true, request(message) { message(); return new Promise(resolve => { finish = resolve; }); }})});
  drawing.draw(target, view);
  await new Promise(resolve => setImmediate(resolve));
  drawing.destroy();
  const bitmap = {closed: 0, close() { this.closed++; }};
  finish({bitmap});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bitmap.closed, 1);
});

test('a monitor ticket which cannot transfer is released exactly once', async () => {
  const {workers, spawn} = fakeWorker(message => message.operation === 'start' ? {id: 0, ok: true} : null);
  const previews = new EnginePreviewWorker(engine, {spawn});
  // Start the worker first; its next message throws before consuming the ticket.
  const started = previews.request({operation: 'first'});
  workers[0].dispatchEvent(Object.assign(new Event('message'), {data: {id: workers[0].messages.at(-1).id, ok: true}}));
  await started;
  const original = workers[0].postMessage;
  workers[0].postMessage = message => { if (message.operation === 'monitor') throw new Error('cannot transfer'); return original(message); };
  const discarded = [];
  await assert.rejects(previews.request(() => ({operation: 'monitor', address: 19}), {discard: message => discarded.push(message.address)}), /cannot transfer/);
  assert.deepEqual(discarded, [19]);
  previews.release();
});

test('a threaded monitor keeps ownership while its first followed stage pose is pending', async () => {
  let version = 0, addresses = 0;
  const stage = {monitor_version: () => version, monitor_address: () => ++addresses, forget_monitor() {}};
  const worker = previewWorker(() => ({bitmap: {close() {}}}));
  const monitor = new EngineCameraMonitor(stage, {previews: async () => worker.worker});
  const target = {save() {}, restore() {}, setTransform() {}, drawImage() {}};
  const view = {width: 320, height: 180, zoom: .5, panX: 0, panY: 0};
  assert.equal(monitor.draw(target, view), true, 'no JavaScript camera evaluation on the cold path');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.requests.length, 0);
  assert.equal(addresses, 0, 'there is no displayed pose to capture yet');
  version = 1;
  assert.equal(monitor.draw(target, view), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.requests.length, 1);
  assert.equal(monitor.stats.drawn, 1);
  monitor.destroy();
});

test('a cold shown epoch retains its accepted monitor picture and rejects late newer work', async () => {
  let version = 1, addresses = 0, finish;
  const accepted = {closed: 0, close() { this.closed++; }}, late = {closed: 0, close() { this.closed++; }};
  const stage = {monitor_version: () => version, monitor_address: () => ++addresses, forget_monitor() {}};
  const worker = {usable: true, request(message) { message(); return addresses === 1 ? Promise.resolve({bitmap: accepted}) : new Promise(resolve => { finish = resolve; }); }};
  const monitor = new EngineCameraMonitor(stage, {previews: async () => worker});
  const painted = [], target = {save() {}, restore() {}, setTransform() {}, drawImage(image) { painted.push(image); }};
  const view = {width: 320, height: 180, zoom: .5, panX: 2, panY: 3};
  monitor.draw(target, view);
  await new Promise(resolve => setImmediate(resolve));
  monitor.draw(target, view);
  assert.deepEqual(painted, [accepted]);
  version = 2;
  monitor.draw(target, view);
  await new Promise(resolve => setImmediate(resolve));
  version = 0;
  monitor.draw(target, view);
  assert.deepEqual(painted, [accepted, accepted], 'the cleared canvas keeps its actual accepted picture');
  finish({bitmap: late});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(late.closed, 1);
  assert.equal(accepted.closed, 0, 'superseded work never replaces the prior picture');
  monitor.draw(target, {...view, width: 321});
  assert.equal(painted.length, 2, 'a cold picture is not stretched into a different view');
  assert.equal(addresses, 2, 'cold paths request no pose or ticket');
  monitor.destroy();
  assert.equal(accepted.closed, 1);
});

test('root descriptor and source bitmap are accepted together and painted in the owning order', async () => {
  let version=1,finish;
  const monitor=new EngineCameraMonitor({monitor_version:()=>version,monitor_address:()=>1}, {previews:async()=>({usable:true,request(message){message();return new Promise(resolve=>finish=resolve);}})});
  const calls=[];
  const target={save(){calls.push('save');},restore(){calls.push('restore');},setTransform(...v){calls.push(['base',...v]);},
    beginPath(){calls.push('path');},rect(...v){calls.push(['clip-rect',...v]);},clip(){calls.push('clip');},
    transform(...v){calls.push(['camera',...v]);},fillRect(...v){calls.push(['solid',...v]);},drawImage(v){calls.push(['foreground',v]);}};
  const view={width:278,height:139,zoom:.2574074074074074,panX:15.444444444444443,panY:0,dpr:1};
  const bitmap={close(){this.closed=true;}},background={rect:[0,0,960,540],style:'rgba(16,16,24,1)',matrix:[.2574074074074074,0,0,.2574074074074074,15.444444444444443,0],clip:[15.444444444444443,0,247.1111111111111,139],dpr:1};
  monitor.draw(target,view);await new Promise(resolve=>setImmediate(resolve));finish({bitmap,rootBackground:background,gpuSource:true});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,0,'answer acceptance never paints an extra frame');
  monitor.draw(target,view);
  assert.deepEqual(calls,['save',['base',1,0,0,1,0,0],'path',['clip-rect',...background.clip],'clip',['camera',...background.matrix],['solid',...background.rect],'restore','save',['base',1,0,0,1,0,0],['foreground',bitmap],'restore']);
  assert.equal(target.fillStyle,background.style);assert.equal(monitor.stats.drawn,1);
  calls.length=0;version=0;monitor.draw(target,view);assert.equal(calls.filter(v=>Array.isArray(v)&&v[0]==='solid').length,1,'compatible cold surface repeats both paired operations once');
  calls.length=0;monitor.draw(target,{...view,dpr:2});assert.equal(calls.length,0,'cold DPR change cannot reuse the previous paint descriptor');
  monitor.destroy();assert.equal(bitmap.closed,true);
});

test('DPR replacement refuses a late descriptor without advancing the accepted head', async () => {
  const requests=[];
  const monitor=new EngineCameraMonitor({monitor_version:()=>1,monitor_address:()=>1},{previews:async()=>({usable:true,request(message){message();return new Promise(resolve=>requests.push(resolve));}})});
  const target={save(){},restore(){},setTransform(){},drawImage(){assert.fail('a stale paint must not be presented');}};
  const view={width:278,height:139,zoom:.25,panX:0,panY:0,dpr:1};
  monitor.draw(target,view);await new Promise(resolve=>setImmediate(resolve));monitor.draw(target,{...view,dpr:2});
  const stale={closed:0,close(){this.closed++;}};requests[0]({bitmap:stale,rootBackground:{dpr:1}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stale.closed,1);assert.equal(monitor.picture,null);assert.equal(monitor.stats.drawn,0);monitor.destroy();
});


test('only a successfully painted accepted GPU source notifies the destination owner',()=>{
  let version=1,notified=0,fail=false;
  const monitor=new EngineCameraMonitor({monitor_version:()=>version});
  const view={width:278,height:139,zoom:.25,panX:0,panY:0,dpr:1};
  monitor.picture={key:JSON.stringify([1,278,139,.25,0,0,1]),bitmap:{close(){}},gpuSource:true};
  const target={save(){},restore(){},setTransform(){},drawImage(){if(fail)throw Error('lost destination');}};
  const notify=gpu=>{if(gpu)notified++;};
  monitor.draw(target,view,notify);assert.equal(notified,1);
  monitor.picture.gpuSource=false;monitor.draw(target,view,notify);assert.equal(notified,1);
  monitor.picture.gpuSource=true;fail=true;assert.throws(()=>monitor.draw(target,view,notify),/lost destination/);assert.equal(notified,1);
  fail=false;version=0;monitor.draw(target,{...view,dpr:2},notify);assert.equal(notified,1,'incompatible cold picture never notifies');
  monitor.destroy();monitor.draw(target,view,notify);assert.equal(notified,1,'disposed work cannot notify');
});
