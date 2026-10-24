import {readFileSync, readdirSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {planEngineLayerMigration, planEngineInbetweens, planOnInterface, isUnported} from '../src/engine/engine-planning.mjs';
import {createStagePlayback} from '../src/engine/engine-playback.mjs';
import {documentChunks} from '../src/document-transport.mjs';
import {Editor} from '../src/editor.mjs';
import {adoptLayerSheet} from '../src/editor-layer-sheet.mjs';
const fixture = name => JSON.parse(readFileSync(new URL(`../engine/tests/layer-migration/${name}.json`, import.meta.url),'utf8'));
const nativeJson = value => JSON.stringify(value, (key,value) => key === 'runtime_segments' ? undefined : value);
function transport(payload, onTake = () => {}) {
  const chunks = documentChunks(payload, {maxBytes: 64*1024,maxRecords:128,timeBudgetMs:2});
  let sequence = 0, awaiting, stopped = false, freed = false, reads = 0;
  const job = {
    take() {
      reads++; onTake(reads);
      if (awaiting !== undefined || stopped) return undefined;
      const next = chunks.next();
      if (next.done) return JSON.stringify({done:true});
      awaiting = sequence++; return JSON.stringify({sequence:awaiting,chunk:next.value,progress:{phase:'sampling',completed:1,total:1}});
    },
    ack(seq) { assert.equal(seq,awaiting); awaiting=undefined; return true; },
    cancel() { stopped=true; }, free() { freed=true; },
  };
  const engine = {threaded:true,workers:1,progressSeen:()=>0,whenProgress:async()=>{},handle:{plan_layers:(revision,request)=>{assert.equal(typeof revision,'number');const ids=JSON.parse(request);assert.deepEqual(Object.keys(ids).sort(),Object.hasOwn(ids,'deletedLayerId')?['deletedLayerId','nextFrameIdentity','targetLayerId','uids']:['nextFrameIdentity','targetLayerId','uids']);return job;}}};
  return {engine, get stopped(){return stopped;}, get freed(){return freed;}};
}
for (const name of ['native-only','independent','joined-scalars','delete-default','dense-single-figure']) test(`worker adapter preserves actual async editor publication and history: ${name}`,async()=>{
  const reference=fixture(name),editor=new Editor({demo:false}).load(JSON.parse(reference.document));
  // Loading already complete IDs preserves the report bytes; revision is host state.
  editor._revision=editor._revisionSerial=reference.revision;
  editor._restoreSelection(reference.initialState.selection);editor._layerRevision=reference.initialState.layerRevision;
  const state=transport(reference.payload);
  // This boundary test uses captured worker packets. Native Rust tests separately
  // compare the actual worker planner and sliced packets to these editor bytes.
  state.engine.handle.plan_layers=(revision,request)=>{
    assert.equal(revision,editor.revision);assert.deepEqual(JSON.parse(request),reference.request);
    const iterator=documentChunks(reference.payload,{maxBytes:64*1024,maxRecords:128,timeBudgetMs:2});let sequence=0,awaiting;
    return {take(){if(awaiting!==undefined)return undefined;const next=iterator.next();if(next.done)return JSON.stringify({done:true});awaiting=sequence++;return JSON.stringify({sequence:awaiting,chunk:next.value});},ack(seq){assert.equal(seq,awaiting);awaiting=undefined;return true;},cancel(){},free(){}};
  };
  const events=[];editor.addEventListener('change',event=>events.push(event.detail));
  const revision=editor.revision,report=editor.report,identity=editor._nextFrameIdentity;
  const planMigration=(request,options)=>planEngineLayerMigration(state.engine,revision,request,{...options,isCurrent:()=>editor.report===report&&editor.revision===revision&&editor._nextFrameIdentity===identity});
  const result=reference.command.name==='deleteLayerAsync'?await editor.deleteLayerAsync(reference.request.deletedLayerId,{targetLayerId:reference.request.targetLayerId,planMigration})
    :await editor.assignFiguresToLayerAsync(reference.request.uids,reference.request.targetLayerId,{planMigration});
  assert.deepEqual(result,reference.command.result);assert.equal(nativeJson(editor.report),reference.command.after);assert.deepEqual(events,reference.command.events);
  assert.equal(editor.undoLabel,reference.command.state.undoLabel);editor.undo();assert.equal(nativeJson(editor.report),reference.command.undone);editor.redo();assert.equal(nativeJson(editor.report),reference.command.redone);
});
test('adapter requires real workers before queueing any planning',async()=>{
  let called=false;await assert.rejects(planEngineLayerMigration({threaded:false,workers:0,handle:{plan_layers(){called=true;}}},1,{}),/background engine workers/);assert.equal(called,false);
});
for(const reason of ['cancel','stale','invalid'])test(`adapter rejects ${reason} packets and disposes its small handle`,async()=>{
  const reference=fixture('independent'),editor=new Editor({demo:false}).load(JSON.parse(reference.document)),before=nativeJson(editor.report),controller=new AbortController();let current=true;
  const state=transport(reference.payload,reads=>{if(reads===2){if(reason==='cancel')controller.abort();else if(reason==='stale')current=false;}});
  if(reason==='invalid')state.engine.handle.plan_layers=()=>({take:()=>JSON.stringify({done:true}),cancel(){},free(){}});
  await assert.rejects(planEngineLayerMigration(state.engine,1,{uids:[1],targetLayerId:'layer-2',nextFrameIdentity:3},{signal:controller.signal,isCurrent:()=>current}),reason==='cancel'?{name:'AbortError'}:reason==='stale'?/document changed/:/invalid layer planning payload/);
  if(reason!=='invalid'){assert.equal(state.stopped,true);assert.equal(state.freed,true);}assert.equal(nativeJson(editor.report),before);assert.equal(editor.canUndo,false);
});
test('actual async editor rolls back if cancelled after a bounded packet',async()=>{
  const reference=fixture('independent'),editor=new Editor({demo:false}).load(JSON.parse(reference.document)),before=nativeJson(editor.report),controller=new AbortController();
  const state=transport(reference.payload,reads=>{if(reads===2)controller.abort();});
  const planMigration=(request,options)=>planEngineLayerMigration(state.engine,editor.revision,request,options);
  await assert.rejects(editor.assignFiguresToLayerAsync([1],'layer-2',{signal:controller.signal,planMigration}),{name:'AbortError'});
  assert.equal(nativeJson(editor.report),before);assert.equal(editor.canUndo,false);assert.equal(state.freed,true);
});
test('actual async editor preserves a concurrent edit when a plan becomes stale',async()=>{
  const reference=fixture('independent'),editor=new Editor({demo:false}).load(JSON.parse(reference.document)),revision=editor.revision;let expected;
  const state=transport(reference.payload,reads=>{if(reads===2){editor.select(1);editor.moveSelection(5,0);expected=nativeJson(editor.report);}});
  const planMigration=(request,options)=>planEngineLayerMigration(state.engine,revision,request,{...options,isCurrent:()=>editor.revision===revision});
  await assert.rejects(editor.assignFiguresToLayerAsync([1],'layer-2',{planMigration}),/document changed/);
  assert.equal(nativeJson(editor.report),expected);assert.equal(editor.layerForUid(1),'layer-1');assert.equal(editor.canUndo,true);assert.equal(state.freed,true);
});

for(const name of ['shared','vacant','vacant-tail','combined','absence','delete-unused','delete-native','delete-joined','dense','noop','movieclip','delete-movieclip','view-changed'])test(`bounded sheet adapter payload reaches actual publication/history owner: ${name}`,async()=>{
  const reference=JSON.parse(readFileSync(new URL(`../engine/tests/layer-sheet-migration/${name}.json`,import.meta.url),'utf8'));
  const editor=new Editor({demo:false,layerTimeline:true,propertyChannels:false}).load(JSON.parse(reference.document));
  editor._restoreSelection(reference.initialState.selection);editor._layerRevision=reference.initialState.layerRevision;
  const before=editor.report,revision=editor.revision,identity=editor._nextFrameIdentity,state=transport(reference.payload);
  let advanced=false;const onProgress=name==='view-changed'?()=>{if(!advanced){advanced=true;editor.seek(3);editor.select(2);}}:undefined;
  const events=[];editor.addEventListener('change',event=>events.push(event.detail));
  const plan=await planEngineLayerMigration(state.engine,revision,reference.request,{onProgress,isCurrent:()=>editor.report===before&&editor.revision===revision&&editor._nextFrameIdentity===identity});
  assert.equal(nativeJson(editor.report),name==='view-changed'?reference.command.undone:reference.document,'streaming a plan never changes document content; permitted live view survives');
  // The existing JS owner remains the publication oracle in this boundary test.
  // Application adoption awaits the Rust worker publication/history protocol;
  // this test makes no claim that the existing synchronous oracle is D7-ready.
  const result=plan?adoptLayerSheet(editor,plan,name.startsWith('delete-')?'Delete layer':'Move figures to layer'):false;
  assert.equal(result,reference.command.result);assert.equal(nativeJson(editor.report),reference.command.after);
  assert.deepEqual(events,reference.command.events);assert.equal(editor.canUndo,reference.command.state.canUndo);
  editor.undo();assert.equal(nativeJson(editor.report),reference.command.undone);editor.redo();assert.equal(nativeJson(editor.report),reference.command.redone);
  assert.equal(state.stopped,true);assert.equal(state.freed,true);
});

// ---- In-between plans, errors and the routing between the engine and the interface ----
const inbetweenFolder = new URL('../engine/tests/inbetween/', import.meta.url);
const inbetween = name => JSON.parse(readFileSync(new URL(`${name}.json`, inbetweenFolder), 'utf8'));
const inbetweenNames = readdirSync(inbetweenFolder).map(file => file.replace(/\.json$/, '')).sort();
const inbetweenPlans = inbetweenNames.filter(name => inbetween(name).payload), inbetweenRefusals = inbetweenNames.filter(name => inbetween(name).failure);
const loaded = reference => new Editor({demo: false}).load(JSON.parse(reference.document));
/** An engine whose in-between job sends `payload` the way the worker does: one packet per ACK. */
function inbetweenEngine(payload, requests = []) {
  const chunks = documentChunks(payload, {maxBytes: 64 * 1024, maxRecords: 128, timeBudgetMs: 2});
  const engine = {threaded: true, workers: 1, progressSeen: () => 0, whenProgress: async () => {}, handle: {plan_inbetweens(revision, request) {
    assert.equal(typeof revision, 'number'); requests.push(JSON.parse(request));
    let sequence = 0, awaiting;
    return {take() {
      if (awaiting !== undefined) return undefined;
      const next = chunks.next();
      if (next.done) return JSON.stringify({done: true});
      awaiting = sequence++; return JSON.stringify({sequence: awaiting, chunk: next.value, progress: {phase: 'sampling', completed: 1, total: 1}});
    }, ack(seq) { assert.equal(seq, awaiting); awaiting = undefined; return true; }, cancel() {}, free() {}};
  }}};
  return engine;
}

test('the in-between fixtures cover native, authored and refused plans', () => {
  assert.ok(inbetweenPlans.length >= 18); assert.equal(inbetweenRefusals.length, 4);
});
for (const name of inbetweenPlans) test(`engine in-between plan reaches the actual async editor publication and history: ${name}`, async () => {
  const reference = inbetween(name), editor = loaded(reference), requests = [];
  editor._restoreSelection(reference.initialState.selection); editor._layerRevision = reference.initialState.layerRevision;
  const engine = inbetweenEngine(reference.payload, requests), progress = [], events = [];
  editor.addEventListener('change', event => events.push(event.detail));
  const planInbetweens = (request, options) => planEngineInbetweens(engine, editor.revision, request, options);
  const {ratio, indices} = reference.command.args;
  const result = await editor.insertInbetweenFramesAsync(ratio, indices, {planInbetweens, onProgress: value => progress.push(value)});
  assert.deepEqual(requests, [reference.request], 'only the ratio, the ordered keys and the identity cross');
  assert.ok(progress.some(value => value.phase === 'sampling'));
  assert.deepEqual(result, reference.command.result); assert.equal(nativeJson(editor.report), reference.command.after);
  assert.deepEqual(events, reference.command.events); assert.equal(editor.undoLabel, reference.command.state.undoLabel);
  editor.undo(); assert.equal(nativeJson(editor.report), reference.command.undone);
  editor.redo(); assert.equal(nativeJson(editor.report), reference.command.redone);
});
for (const name of inbetweenPlans) test(`the interface plans the same in-between wire as the recorded engine plan: ${name}`, async () => {
  const reference = inbetween(name), editor = loaded(reference), progress = [];
  const wire = await planOnInterface('inbetweens', editor.report, reference.request, {onProgress: value => progress.push(value)});
  assert.equal(nativeJson(wire), nativeJson(reference.payload.plan)); assert.ok(progress.some(value => value.phase === 'sampling'));
});
for (const name of inbetweenRefusals) test(`the interface and the engine adapter refuse an in-between as the editor words it: ${name}`, async () => {
  const reference = inbetween(name), editor = loaded(reference), key = reference.failure.messageKey;
  await assert.rejects(planOnInterface('inbetweens', editor.report, reference.request), error => error.messageKey === key && error.message === reference.failure.message);
  const engine = {threaded: true, workers: 1, progressSeen: () => 0, whenProgress: async () => {}, handle: {plan_inbetweens: () => ({
    take() { throw new Error(key); }, cancel() {}, free() {}})}};
  await assert.rejects(planEngineInbetweens(engine, 1, reference.request), error => error.messageKey === key && error.message === reference.failure.message);
});
for (const name of ['native-only', 'independent', 'joined-scalars', 'delete-default']) test(`the interface plans the same layer-move wire as the recorded engine plan: ${name}`, async () => {
  const reference = fixture(name), editor = new Editor({demo: false}).load(JSON.parse(reference.document));
  const wire = await planOnInterface('layers', editor.report, reference.request, {});
  assert.equal(nativeJson(wire), nativeJson(reference.payload.plan));
});

test('a retired in-between job reads as the editor words it, and an engine that cannot plan says so', async () => {
  const request = {ratio: .5, indices: [1], nextFrameIdentity: 4};
  const engineOf = (take, extra = {}) => ({threaded: true, workers: 1, progressSeen: () => 0, whenProgress: async () => {}, handle: {plan_inbetweens: () => ({take, cancel() {}, free() {}}), ...extra}});
  const retired = Object.assign(new Error('The document changed while the plan was prepared.'), {name: 'AbortError'});
  await assert.rejects(planEngineInbetweens(engineOf(() => { throw retired; }), 1, request), error => error.name === 'AbortError' && /animation changed while inbetweens/.test(error.message));
  const controller = new AbortController();
  await assert.rejects(planEngineInbetweens(engineOf(() => { controller.abort(); throw retired; }), 1, request, {signal: controller.signal}), error => error.name === 'AbortError' && /cancelled/.test(error.message));
  await assert.rejects(planEngineInbetweens(engineOf(() => { throw Object.assign(new Error('a layer sheet is not ported'), {name: 'EngineUnported'}); }), 1, request), isUnported);
  await assert.rejects(planEngineInbetweens({...engineOf(() => undefined), threaded: false}, 1, request), isUnported);
  // A refusal that names a value carries it after the key; the editor's error holds both.
  await assert.rejects(planEngineInbetweens(engineOf(() => { throw new Error('errors.editorLayerSheet.unlockBeforeEditingIt\u001f{"name":"Destination"}'); }), 1, request),
    error => error.messageKey === 'errors.editorLayerSheet.unlockBeforeEditingIt' && error.messageParams.name === 'Destination' && error.message === 'Unlock Destination before editing it.');
  await assert.rejects(planEngineInbetweens(engineOf(() => undefined), 1, {...request, ratio: 2}), error => error.messageKey === 'errors.editorInbetweenAsync.chooseAnInterpolationRatioFromZeroToOne');
  await assert.rejects(planEngineInbetweens(engineOf(() => undefined), 1, {...request, indices: [-1]}), /Invalid inbetween planning request/);
  // The worker that still disposes the previous job answers busy: the job starts once it has.
  let attempts = 0;
  const busy = engineOf(() => JSON.stringify({done: true}), {plan_inbetweens() { if (++attempts < 3) throw new Error('a planner is busy; wait for worker disposal'); return {take: () => JSON.stringify({done: true}), cancel() {}, free() {}}; }});
  await assert.rejects(planEngineInbetweens(busy, 1, request), /invalid inbetween planning payload/);
  assert.equal(attempts, 3);
});

function routedPlayback({threaded = true, plan = null, refuse = null} = {}) {
  let published = 0; const calls = [];
  const engine = {threaded, workers: 1, progressSeen: () => 0, whenProgress: async () => {}, pump() {}, handle: {
    try_set_hidden: () => 1, try_set_effects: () => 1, generation: () => 1, try_document_identity: () => [1, 1, published],
    plan_inbetweens(revision, request) { calls.push({revision, request: JSON.parse(request)}); if (refuse) throw refuse; return plan(); },
    plan_layers(revision, request) { calls.push({revision, request: JSON.parse(request)}); if (refuse) throw refuse; return plan(); }}};
  const side = {engine};
  const playback = createStagePlayback({stage: () => ({engineSide: side})}), load = playback.load;
  // The engine's session has published the revision the playback is loaded at.
  playback.load = (next, options) => { published = options?.revision ?? published; return load(next, options); };
  return {playback, calls};
}
const planJob = payload => () => {
  const chunks = documentChunks(payload, {maxBytes: 64 * 1024, maxRecords: 128, timeBudgetMs: 2}); let sequence = 0, awaiting;
  return {take() { if (awaiting !== undefined) return undefined; const next = chunks.next(); if (next.done) return JSON.stringify({done: true}); awaiting = sequence++; return JSON.stringify({sequence: awaiting, chunk: next.value}); },
    ack() { awaiting = undefined; return true; }, cancel() {}, free() {}};
};

test('the stage playback plans on the engine for the document it holds', async () => {
  const reference = inbetween('authored-independent'), editor = loaded(reference);
  const {playback, calls} = routedPlayback({plan: planJob(reference.payload)});
  playback.load(editor.report, {revision: 7});
  const wire = await playback.planInsertInbetweens(reference.request, {isCurrent: () => true});
  assert.equal(nativeJson(wire), nativeJson(reference.payload.plan));
  assert.deepEqual(calls, [{revision: 7, request: reference.request}]);
  const layers = fixture('independent'), layerEditor = new Editor({demo: false}).load(JSON.parse(layers.document));
  const second = routedPlayback({plan: planJob(layers.payload)});
  second.playback.load(layerEditor.report, {revision: 3});
  assert.equal(nativeJson(await second.playback.planLayerMigration(layers.request, {})), nativeJson(layers.payload.plan));
  assert.deepEqual(second.calls, [{revision: 3, request: layers.request}]);
});
test('what the engine does not plan, a host without worker threads and a stale document are planned or refused on the interface', async () => {
  const reference = inbetween('authored-easing'), editor = loaded(reference);
  const unported = routedPlayback({refuse: Object.assign(new Error('a layer sheet is not ported'), {name: 'EngineUnported'})});
  unported.playback.load(editor.report, {revision: 1});
  assert.equal(nativeJson(await unported.playback.planInsertInbetweens(reference.request, {})), nativeJson(reference.payload.plan));
  assert.equal(unported.calls.length, 1, 'the engine was asked first');
  const plain = routedPlayback({threaded: false});
  plain.playback.load(editor.report, {revision: 1});
  assert.equal(nativeJson(await plain.playback.planInsertInbetweens(reference.request, {})), nativeJson(reference.payload.plan));
  assert.equal(plain.calls.length, 0);
  const stale = routedPlayback({threaded: false});
  stale.playback.load(editor.report, {revision: 1});
  await assert.rejects(stale.playback.planInsertInbetweens(reference.request, {isCurrent: () => false}), {name: 'AbortError'});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(stale.playback.planInsertInbetweens(reference.request, {signal: controller.signal}), {name: 'AbortError'});
  // A refusal is the user's, not a reason to plan again.
  const refused = routedPlayback({refuse: new Error('errors.editorInbetween.thisInbetweenNeedsMoreThanTwoBackgroundImages')});
  refused.playback.load(editor.report, {revision: 1});
  await assert.rejects(refused.playback.planInsertInbetweens(reference.request, {}), error => error.messageKey === 'errors.editorInbetween.thisInbetweenNeedsMoreThanTwoBackgroundImages');
});
