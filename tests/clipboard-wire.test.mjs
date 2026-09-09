import test from 'node:test';
import assert from 'node:assert/strict';
import {clipboardWireChunks, createClipboardWireDecoder, CLIPBOARD_WIRE_CHUNK_BYTES} from '../src/clipboard-wire.mjs';
import {documentChunks} from '../src/document-transport.mjs';
import {createDemo} from '../src/demo.mjs';

async function roundTrip(value, options = {}) {
  const decoder = createClipboardWireDecoder(options.decoder), packets = []; let packed;
  for await (const packet of clipboardWireChunks(value, {...options.encoder, onTimings:stats => {packed = stats;}})) {
    packets.push(packet.slice(0));
    // A real transfer detaches the sender's allocation and cannot alter its source.
    const transferred = structuredClone(packet, {transfer:[packet]});
    assert.equal(packet.byteLength, 0); await decoder.push(transferred);
  }
  const result = decoder.finish();
  assert.equal(decoder.stats.encodedBytes, packed.encodedBytes);
  assert.equal(decoder.stats.residentBytes, packed.residentBytes);
  return {result, packets, packed, decoded:decoder.stats};
}
const prefix = [83,84,89,75,67,66,87,49];
const packet = (...bytes) => Uint8Array.from([...prefix,...bytes]).buffer;
const n32 = value => [value & 255,(value >>> 8) & 255,(value >>> 16) & 255,value >>> 24];

test('full native and opaque fields, numbers, key order, UTF16 and own __proto__ are exact', async () => {
  const original = createDemo();
  original.opaque = JSON.parse('{"__proto__":{"safe":true},"constructor":"data","z":1,"a":2}');
  original.opaque.values = [undefined,null,false,true,-0,NaN,Infinity,-Infinity,Number.MIN_VALUE,Number.MAX_VALUE,1/3,1/7,0xffffffff];
  original.opaque.unpaired = 'A\ud800B\udfffC😀é\u0000'; original.opaque.absentValue = undefined;
  original.opaque.nullRecord = Object.assign(Object.create(null), {x:1});
  const before = structuredClone(original), {result, packed, decoded} = await roundTrip(original);
  assert.deepEqual(result, original); assert.equal(Object.is(result.opaque.values[4], -0), true);
  assert.deepEqual(Object.keys(result.opaque), Object.keys(original.opaque));
  assert.equal(Object.getPrototypeOf(result.opaque), Object.prototype); assert.equal({}.safe, undefined);
  assert.equal(Object.getPrototypeOf(result.opaque.nullRecord), null);
  // Native fields and their ownness are unchanged; only the null prototype differs from structuredClone.
  assert.deepEqual(structuredClone(original), before);
  assert.equal(packed.completed, true); assert.equal(decoded.completed, true);
});

test('numeric runs and long strings cross owned packets with bounded packing and decoding', async () => {
  const values = Array.from({length:65535}, (_, i) => i % 13 ? i / 7 : -0), text = '0123456789abcdef'.repeat(20000) + '\ud800';
  const input = {values, text}, {result, packets, packed} = await roundTrip(input, {encoder:{maxBytes:32768}});
  assert.deepEqual(result, input); assert.ok(packets.length > 10);
  assert.ok(packets.every(value => value.byteLength <= 32768));
  assert.ok(packed.encodedBytes < values.length * 8 + text.length + 4000, 'Float runs use eight bytes and ASCII runs one byte per value.');
  assert.ok(Number.isFinite(packed.maxSliceMs)); assert.ok(Number.isFinite(packed.workMs));
});

test('sparse arrays retain holes, explicit undefined and enumerable nonindex properties', async () => {
  const array = new Array(4099); array[2] = undefined; array[2047] = -0; array[4098] = 9;
  array.extra = 'kept'; array['00'] = 3; array['4294967295'] = 5;
  Object.defineProperty(array, '__proto__', {value:'array data', enumerable:true});
  const {result} = await roundTrip({array}); assert.deepEqual(result.array, array);
  assert.equal(0 in result.array, false); assert.equal(2 in result.array, true);
  assert.equal(result.array.length, 4099); assert.equal(Object.getPrototypeOf(result.array), Array.prototype);
});

test('runtime omission is opt-in and limited to nested native poses and retained source poses', async () => {
  const pose = {angles:[1/3], runtime_segments:[{length:99}], extra:{runtime_segments:'opaque'}};
  const report = {keyframes:[{objects:[pose]}], _styk:{frameSources:{source:{objects:[pose]}}},
    figure_types:[{runtime_segments:'definition field'}], runtime_segments:'document field'};
  const input = {report, clipboard:{...report}, arbitrary:{objects:[pose]}, runtime_segments:'wire field'};
  assert.deepEqual((await roundTrip(input)).result, input);
  const expected = structuredClone(input);
  // structuredClone preserves aliases, so build the expected projection independently.
  for (const name of ['report','clipboard']) {
    expected[name].keyframes = [{objects:[{angles:[1/3],extra:{runtime_segments:'opaque'}}]}];
    expected[name]._styk = {frameSources:{source:{objects:[{angles:[1/3],extra:{runtime_segments:'opaque'}}]}}};
  }
  const {result} = await roundTrip(input, {encoder:{omitRuntimeSegments:true}});
  assert.deepEqual(result, expected); assert.equal(input.report.keyframes[0].objects[0].runtime_segments[0].length, 99);
});

test('repeated poses compact both numeric storage and repeated key names', async () => {
  const objects = Array.from({length:300}, (_, i) => ({unique_id:i,figure_type_id:1,object_slot:i,
    angles:Array.from({length:32}, (_, j) => j/7),lengths:[0,1/3,9],bends:[],root_x:i/3,root_y:-0,
    scale:1,color_override_raw:0xffaabbcc,color_override_rgb:[204,187,170],color_override_mix:255,
    field28:0,transparency:0,opacity:1,len_flag:1,bend_flag:0,join:null,record_offset:i*10,record_end:i*10+9}));
  const report = {keyframes:[{objects}],figure_types:[]};
  let estimate = 0; for (const chunk of documentChunks(report,{maxBytes:65536,omitRuntimeSegments:true})) estimate += chunk.header ? 64 : chunk.estimatedBytes;
  const {result,packed} = await roundTrip(report); assert.deepEqual(result,report);
  assert.ok(packed.encodedBytes < estimate / 3, `${packed.encodedBytes} must be less than a third of ${estimate}`);
  assert.ok(packed.residentBytes > packed.encodedBytes, 'Resident allocation and encoded transfer are separate quantities.');
});

test('malformed, truncated, over-budget and trailing input never produces a root', async () => {
  const invalid = [packet(99),packet(6,...n32(4),13,5,0),packet(7,10,0,0),packet(7,8,0,16),
    packet(5,...n32(1),14,2,0,65,66),packet(4,1),packet(7,9,1,0),packet(6,...n32(0),4,0,0,0,0,0,0,0,0),
    packet(0,16,0),Uint8Array.from([1,2,3]).buffer];
  for (const bytes of invalid) {
    const decoder = createClipboardWireDecoder();
    await assert.rejects(decoder.push(bytes), /Invalid clipboard wire/); assert.throws(() => decoder.finish());
  }
  for (const bytes of [packet(7),packet(5,...n32(3)),packet(0),packet(7,9,0,0)]) {
    const decoder = createClipboardWireDecoder(); await decoder.push(bytes); assert.throws(() => decoder.finish(), /truncated/);
  }
  const encoded = createClipboardWireDecoder({maxBytes:8}); await assert.rejects(encoded.push(packet(0,16)), /encoded byte budget/);
  const resident = createClipboardWireDecoder({maxResidentBytes:100});
  await assert.rejects(resident.push(packet(6,...n32(0xffffffff))), /array length|resident/);
  const string = createClipboardWireDecoder({maxResidentBytes:100}); await assert.rejects(string.push(packet(5,...n32(100))), /resident/);
  const finished = createClipboardWireDecoder(); await finished.push(packet(0,16)); assert.equal(finished.finish(), null);
  await assert.rejects(finished.push(packet(0,16)), /trailing/);
  await assert.rejects(createClipboardWireDecoder().push(new ArrayBuffer(CLIPBOARD_WIRE_CHUNK_BYTES+1)), /packet size/);
});

test('decoder cooperatively cancels, rejects stale work and closes on scheduler failure', async () => {
  const buffers = []; for await (const b of clipboardWireChunks({values:Array.from({length:10000},(_,i)=>i)})) buffers.push(b);
  const controller = new AbortController(); let yields = 0;
  const decoder = createClipboardWireDecoder({timeBudgetMs:0,signal:controller.signal,yieldControl:async()=>{if (++yields === 3) controller.abort();}});
  await assert.rejects(decoder.push(buffers[0]), {name:'AbortError'}); assert.throws(()=>decoder.finish(), {name:'AbortError'});
  assert.equal(yields,3);
  await assert.rejects(createClipboardWireDecoder({checkCurrent:()=>false}).push(buffers[0]), {name:'AbortError'});
  const failed = createClipboardWireDecoder({timeBudgetMs:0,yieldControl:async()=>{throw new Error('scheduler failed');}});
  await assert.rejects(failed.push(buffers[0]), /scheduler failed/); assert.throws(()=>failed.finish(), {name:'AbortError'});
  const active = createClipboardWireDecoder({timeBudgetMs:0,yieldControl:()=>new Promise(()=>{})});
  const pending = active.push(buffers[0]); await assert.rejects(active.push(buffers[0]), /concurrent/); active.dispose();
  // A never-resolving injected scheduler owns no event-loop handle.
  void pending;
});

test('encoder cancels before reading, closes on return and rejects cycles or unsupported types', async () => {
  const controller = new AbortController(); controller.abort(); let read = 0;
  const source = new Proxy({}, {getPrototypeOf(){read++; return Object.prototype;}});
  await assert.rejects(async()=>{for await (const _ of clipboardWireChunks(source,{signal:controller.signal})) {}}, {name:'AbortError'});
  assert.equal(read,0);
  let timing; const iterator = clipboardWireChunks({a:Array.from({length:10000},(_,i)=>i)},{timeBudgetMs:0,onTimings:value=>{timing=value;}});
  await iterator.next(); await iterator.return(); assert.equal(timing.completed,false);
  for (const value of [new Map(),new Date(),()=>{},Symbol('x'),1n])
    await assert.rejects(async()=>{for await (const _ of clipboardWireChunks(value)) {}}, /plain data|primitive/);
  const cyclic={};cyclic.self=cyclic;
  await assert.rejects(async()=>{for await (const _ of clipboardWireChunks(cyclic)) {}}, /cyclic/);
  await assert.rejects(async()=>{for await (const _ of clipboardWireChunks(new Array(100),{maxResidentBytes:100})) {}}, /resident/);
});

test('nesting boundary is symmetric and independently packed buffers cannot be overwritten', async () => {
  let value = 1; for (let i = 0; i < 256; i++) value = {a:value};
  assert.deepEqual((await roundTrip(value)).result, value);
  await assert.rejects(async()=>{for await (const _ of clipboardWireChunks({a:value})) {}}, /nesting/);
  // The first byte of each object is tag 7; a literal property name is tag 11
  // followed by STRING(5), length, and LATIN(14), run length and its code unit.
  const nested = [];
  for (let i = 0; i < 257; i++) nested.push(7,11,5,1,0,0,0,14,1,0,97);
  await assert.rejects(createClipboardWireDecoder().push(packet(...nested)), /nesting/);
  const a = clipboardWireChunks({a:Array.from({length:5000},(_,i)=>i)}, {timeBudgetMs:0});
  const b = clipboardWireChunks({other:'b'.repeat(8000)}, {timeBudgetMs:0});
  const packetsA = [], packetsB = [], saved = []; let doneA=false, doneB=false;
  while (!doneA || !doneB) {
    if (!doneA) {const next=await a.next();doneA=next.done;if(!doneA){packetsA.push(next.value);saved.push(new Uint8Array(next.value).slice());}}
    if (!doneB) {const next=await b.next();doneB=next.done;if(!doneB)packetsB.push(next.value);}
  }
  for (let i=0;i<packetsA.length;i++)assert.deepEqual(new Uint8Array(packetsA[i]),saved[i]);
  const first=createClipboardWireDecoder(),second=createClipboardWireDecoder();
  for (const bytes of packetsA) await first.push(bytes); for (const bytes of packetsB) await second.push(bytes);
  assert.equal(first.finish().a[4999],4999); assert.equal(second.finish().other.length,8000);
});

test('key dictionary falls back to literal names at its bound and rejects oversized definitions early', async () => {
  const value = {}; for (let i=0;i<16500;i++) value[`opaque-${i}`] = i;
  value['long'+ 'x'.repeat(530000)] = 'literal';
  assert.deepEqual((await roundTrip(value)).result,value);
  const decoder=createClipboardWireDecoder();
  await assert.rejects(decoder.push(packet(7,9,0,0,5,...n32(524289))), /dictionary budget/);
});
