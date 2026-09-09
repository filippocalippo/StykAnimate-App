/** Lossless worker snapshots. Packets contain complete tokens and own their bytes. */
export const CLIPBOARD_WIRE_CHUNK_BYTES = 256 * 1024;
const MAGIC = Uint8Array.of(83, 84, 89, 75, 67, 66, 87, 49); // STYKCBW1
const T = {NULL:0, UNDEFINED:1, FALSE:2, TRUE:3, NUMBER:4, STRING:5, ARRAY:6, OBJECT:7,
  END:8, KEY_DEF:9, KEY:10, KEY_LITERAL:11, NUMBERS:12, HOLES:13, LATIN:14, UTF16:15, FINISH:16, NULL_OBJECT:17};
const MAX_DEPTH = 256, MAX_KEYS = 16384, MAX_KEY_BYTES = 1024 * 1024, RUN = 2048;
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const abort = () => new DOMException('Clipboard transfer cancelled or superseded.', 'AbortError');
const yieldTask = () => globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise(resolve => {
  const channel = new MessageChannel(); channel.port1.onmessage = () => {channel.port1.close(); channel.port2.close(); resolve();}; channel.port2.postMessage(null);
});
const checkOptions = (options, defaultMs) => {
  const timeBudgetMs = options.timeBudgetMs ?? defaultMs;
  if (!Number.isFinite(timeBudgetMs) || timeBudgetMs < 0 || timeBudgetMs > 16) throw new RangeError('Clipboard time slices must be between zero and 16 ms.');
  return timeBudgetMs;
};
const checkCurrent = options => {if (options.signal?.aborted || options.checkCurrent?.() === false) throw abort();};
const isIndex = key => key !== '4294967295' && String(Number(key) >>> 0) === key;
/** Key batches bound enumeration without routing every property through a generator. */
function* propertyBatches(value, array) {
  let batch = [], scanned = 0;
  for (const key in value) {
    if (!own(value, key)) continue;
    if (!(array && isIndex(key))) batch.push(key);
    if (batch.length >= 64 || ++scanned >= RUN) {yield batch; batch = []; scanned = 0;}
  }
  if (batch.length) yield batch;
}

/** One flat cursor writes directly to owned packets; the caller ACK supplies the
 * event boundary. No per-value generator, token allocation or recursive walk. */
export async function* clipboardWireChunks(value, options = {}) {
  const maxBytes = options.maxBytes ?? CLIPBOARD_WIRE_CHUNK_BYTES, timeBudgetMs = checkOptions(options, 2);
  const maxResidentBytes = options.maxResidentBytes ?? 4 * 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 32768 || maxBytes > CLIPBOARD_WIRE_CHUNK_BYTES)
    throw new RangeError('Clipboard packets must be between 32 and 256 KiB.');
  if (!Number.isSafeInteger(maxResidentBytes) || maxResidentBytes < 1) throw new RangeError('Clipboard resident budget must be a positive safe integer.');
  const stats = {encodedBytes:0, residentBytes:0, logicalBytes:0, maxSliceMs:0, workMs:0, chunks:0, completed:false};
  const frames = [], active = new WeakSet(), keys = new Map();
  let depth = 0, hasValue = true, incomingKey = null, text = null, textOffset = 0, keyBytes = 0, header = false, done = false;
  const reserve = bytes => {
    if (stats.residentBytes + bytes > maxResidentBytes) throw new Error('Clipboard resident data budget exceeded.');
    stats.residentBytes += bytes; stats.logicalBytes = stats.residentBytes;
  };
  try {
    while (!done) {
      checkCurrent(options); const started = performance.now(), packet = new Uint8Array(maxBytes), view = new DataView(packet.buffer);
      let used = 0, units = 0;
      if (!header) {packet.set(MAGIC); used = MAGIC.length; header = true;}
      for (;;) {
        let large = false;
        if (text !== null) {
          const length = Math.min(RUN, text.length - textOffset); let latin = true;
          for (let i = 0; i < length; i++) if (text.charCodeAt(textOffset + i) > 255) {latin = false; break;}
          const bytes = 3 + length * (latin ? 1 : 2);
          if (used + bytes > maxBytes) break;
          packet[used++] = latin ? T.LATIN : T.UTF16; view.setUint16(used, length, true); used += 2;
          if (latin) for (let i = 0; i < length; i++) packet[used++] = text.charCodeAt(textOffset + i);
          else for (let i = 0; i < length; i++) {view.setUint16(used, text.charCodeAt(textOffset + i), true); used += 2;}
          textOffset += length; if (textOffset === text.length) text = null;
          large = true;
        } else if (hasValue) {
          const type = typeof value;
          if (value === null || type === 'undefined' || type === 'boolean') {
            if (used === maxBytes) break;
            reserve(8); packet[used++] = value === null ? T.NULL : type === 'undefined' ? T.UNDEFINED : value ? T.TRUE : T.FALSE;
            hasValue = false;
          } else if (type === 'number') {
            if (used + 9 > maxBytes) break;
            reserve(8); packet[used++] = T.NUMBER; view.setFloat64(used, value, true); used += 8; hasValue = false;
          } else if (type === 'string') {
            if (used + 5 > maxBytes) break;
            reserve(16 + value.length * 2); packet[used++] = T.STRING; view.setUint32(used, value.length, true); used += 4;
            if (value.length) {text = value; textOffset = 0;} hasValue = false;
          } else {
            if (type !== 'object') throw new TypeError('Clipboard snapshots support only data records, arrays and primitive values.');
            const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
            if (!array && prototype !== Object.prototype && prototype !== null) throw new TypeError('Clipboard snapshots require plain data records.');
            if (depth >= MAX_DEPTH) throw new Error('Clipboard value nesting exceeds 256 levels.');
            if (active.has(value)) throw new Error('Clipboard snapshots cannot contain cyclic data.');
            if (used + (array ? 5 : 1) > maxBytes) break;
            reserve(array ? 32 + value.length * 8 : 64); active.add(value);
            packet[used++] = array ? T.ARRAY : prototype === null ? T.NULL_OBJECT : T.OBJECT;
            if (array) {view.setUint32(used, value.length, true); used += 4;}
            const omitPose = options.omitRuntimeSegments && depth >= 3 && frames[depth - 1].edge === 'objects' &&
              (frames[depth - 3].edge === 'keyframes' || (depth >= 4 && frames[depth - 3].edge === 'frameSources' && frames[depth - 4].edge === '_styk'));
            const frame = frames[depth] ??= {};
            frame.value = value; frame.array = array; frame.length = array ? value.length : 0; frame.index = 0;
            frame.edge = incomingKey; frame.omitPose = omitPose; frame.iterator = null; frame.batch = null; frame.keyIndex = 0;
            depth++; hasValue = false;
          }
        } else if (depth) {
          const frame = frames[depth - 1];
          if (frame.array && frame.index < frame.length) {
            const array = frame.value, index = frame.index;
            if (!own(array, index)) {
              if (used + 3 > maxBytes) break;
              let count = 1; while (count < RUN && index + count < frame.length && !own(array, index + count)) count++;
              packet[used++] = T.HOLES; view.setUint16(used, count, true); used += 2; frame.index += count; large = count === RUN;
            } else if (typeof array[index] === 'number') {
              const maximum = Math.min(RUN, frame.length - index);
              if (used + 3 + maximum * 8 > maxBytes) break;
              const begin = used; used += 3; let count = 0;
              while (count < maximum && own(array, index + count)) {
                const number = array[index + count]; if (typeof number !== 'number') break;
                view.setFloat64(used, number, true); used += 8; count++;
              }
              reserve(count * 8); packet[begin] = T.NUMBERS; view.setUint16(begin + 1, count, true);
              frame.index += count; large = count === RUN;
            } else {value = array[index]; incomingKey = index; frame.index++; hasValue = true;}
          } else {
            if (!frame.batch || frame.keyIndex === frame.batch.length) {
              frame.iterator ??= propertyBatches(frame.value, frame.array);
              const next = frame.iterator.next();
              if (next.done) {
                if (used === maxBytes) break;
                packet[used++] = T.END; active.delete(frame.value); frame.value = frame.batch = frame.iterator = null; depth--;
              } else {frame.batch = next.value; frame.keyIndex = 0; large = true;}
            } else {
              const key = frame.batch[frame.keyIndex];
              if (frame.omitPose && key === 'runtime_segments') {frame.keyIndex++; continue;}
              const id = keys.get(key);
              const child = frame.value[key], type = typeof child;
              if (id !== undefined && (type === 'number' || child === null || type === 'boolean' || type === 'undefined')) {
                if (used + (type === 'number' ? 12 : 4) > maxBytes) break;
                reserve(32); packet[used++] = T.KEY; view.setUint16(used, id, true); used += 2;
                if (type === 'number') {packet[used++] = T.NUMBER; view.setFloat64(used, child, true); used += 8;}
                else packet[used++] = child === null ? T.NULL : type === 'undefined' ? T.UNDEFINED : child ? T.TRUE : T.FALSE;
                frame.keyIndex++;
              } else {
                if (used + (id === undefined ? 8 : 3) > maxBytes) break;
                reserve(24);
                if (id !== undefined) {packet[used++] = T.KEY; view.setUint16(used, id, true); used += 2;}
                else {
                if (keys.size < MAX_KEYS && keyBytes + key.length * 2 <= MAX_KEY_BYTES) {
                  const next = keys.size; keys.set(key, next); keyBytes += key.length * 2;
                  packet[used++] = T.KEY_DEF; view.setUint16(used, next, true); used += 2;
                } else packet[used++] = T.KEY_LITERAL;
                reserve(key.length * 2); packet[used++] = T.STRING; view.setUint32(used, key.length, true); used += 4;
                if (key.length) {text = key; textOffset = 0;}
                }
                incomingKey = key; value = child; hasValue = true; frame.keyIndex++;
              }
            }
          }
        } else {
          if (used === maxBytes) break;
          packet[used++] = T.FINISH; done = true; break;
        }
        if (large || ++units >= 128 || timeBudgetMs === 0) {
          units = 0; if (performance.now() - started >= timeBudgetMs) break;
        }
      }
      const elapsed = performance.now() - started; stats.workMs += elapsed; stats.maxSliceMs = Math.max(stats.maxSliceMs, elapsed);
      checkCurrent(options);
      if (used) {stats.encodedBytes += used; stats.chunks++; yield used === maxBytes ? packet.buffer : packet.buffer.slice(0, used);}
      else if (!done) {await (options.yieldControl ?? yieldTask)(); checkCurrent(options);}
    }
    stats.completed = true;
  } finally {
    for (const frame of frames) {frame.iterator?.return?.(); frame.value = frame.batch = frame.iterator = null;}
    value = text = null; keys.clear(); options.onTimings?.({...stats});
  }
}

/** No root is published until finish(). push() must be awaited before ACK. */
export function createClipboardWireDecoder(options = {}) {
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024, maxResidentBytes = options.maxResidentBytes ?? maxBytes * 8;
  const timeBudgetMs = checkOptions(options, 4), yieldControl = options.yieldControl ?? yieldTask;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 8 || !Number.isSafeInteger(maxResidentBytes) || maxResidentBytes < 1)
    throw new RangeError('Clipboard byte and resident budgets must be positive safe integers.');
  const stats = {encodedBytes:0, residentBytes:0, logicalBytes:0, maxSliceMs:0, workMs:0, chunks:0, slices:0, completed:false};
  const stack = [], keys = []; let root, hasRoot = false, started = false, finished = false, disposed = false, pushing = false, string = null, keyMode = null, keyBytes = 0;
  const bad = message => new Error(`Invalid clipboard wire: ${message}.`);
  const check = () => {if (disposed) throw abort(); checkCurrent(options);};
  const reserve = bytes => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || stats.residentBytes + bytes > maxResidentBytes) throw bad('resident data budget exceeded');
    stats.residentBytes += bytes; stats.logicalBytes = stats.residentBytes;
  };
  const expectingKey = frame => frame && (frame.array ? frame.index === frame.length : true) && frame.key === null;
  const set = (object, key, value) => {
    if (key === '__proto__') Object.defineProperty(object, key, {value, writable:true, enumerable:true, configurable:true});
    else object[key] = value;
  };
  const append = value => {
    const frame = stack.at(-1);
    if (!frame) {if (hasRoot) throw bad('multiple roots'); root = value; hasRoot = true; return;}
    if (frame.array && frame.index < frame.length) {frame.value[frame.index++] = value; return;}
    if (frame.key === null) throw bad('value without property key');
    set(frame.value, frame.key, value); frame.key = null;
  };
  const property = key => {
    const frame = stack.at(-1);
    if (!expectingKey(frame) || own(frame.value, key) || (frame.array && (key === 'length' || isIndex(key)))) throw bad('duplicate or misplaced property key');
    reserve(24); frame.key = key;
  };
  const completeString = () => {
    const value = string.value; string = null;
    if (keyMode) {
      if (keyMode.define) {
        if (keys.length >= MAX_KEYS || keyBytes + value.length * 2 > MAX_KEY_BYTES) throw bad('key dictionary budget exceeded');
        keys.push(value); keyBytes += value.length * 2;
      }
      keyMode = null; property(value);
    } else append(value);
  };
  const dispose = () => {disposed = true; root = undefined; stack.length = 0; keys.length = 0; string = keyMode = null;};
  return {stats, dispose,
    async push(buffer) {
      check(); if (pushing) throw bad('concurrent packet decoding');
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 1 || buffer.byteLength > CLIPBOARD_WIRE_CHUNK_BYTES || finished)
        throw bad('packet size or trailing packet');
      if (stats.encodedBytes + buffer.byteLength > maxBytes) throw bad('encoded byte budget exceeded');
      pushing = true; const view = new DataView(buffer); let pos = 0, sliceStart = performance.now(), units = 0;
      const ensure = count => {if (pos + count > view.byteLength) throw bad('truncated packet token');};
      const u16 = () => {ensure(2); const n = view.getUint16(pos, true); pos += 2; return n;};
      const u32 = () => {ensure(4); const n = view.getUint32(pos, true); pos += 4; return n;};
      const elapsed = () => {const ms = performance.now() - sliceStart; stats.workMs += ms; stats.maxSliceMs = Math.max(stats.maxSliceMs, ms); stats.slices++;};
      try {
        stats.encodedBytes += buffer.byteLength; stats.chunks++;
        if (!started) {ensure(8); for (const byte of MAGIC) if (view.getUint8(pos++) !== byte) throw bad('signature or version'); started = true;}
        while (pos < view.byteLength) {
          const tag = view.getUint8(pos++), frame = stack.at(-1);
          if (finished) throw bad('trailing data');
          if (string) {
            if (tag !== T.LATIN && tag !== T.UTF16) throw bad('expected string code units');
            const length = u16(), width = tag === T.LATIN ? 1 : 2;
            if (!length || length > RUN || string.received + length > string.length) throw bad('string run length');
            ensure(length * width); const chars = new Uint16Array(length);
            for (let i = 0; i < length; i++) chars[i] = width === 1 ? view.getUint8(pos++) : (pos += 2, view.getUint16(pos - 2, true));
            string.value += String.fromCharCode(...chars); string.received += length;
            if (string.received === string.length) completeString();
            units += length;
          } else if (keyMode && tag !== T.STRING) throw bad('expected property name');
          else if (tag === T.STRING) {
            const length = u32();
            if (length > maxBytes) throw bad('string length exceeds transfer budget');
            if (keyMode?.define && (keys.length >= MAX_KEYS || keyBytes + length * 2 > MAX_KEY_BYTES)) throw bad('key dictionary budget exceeded');
            reserve(keyMode ? length * 2 : 16 + length * 2); string = {length, received:0, value:''};
            if (!length) completeString();
          } else if (tag === T.KEY || tag === T.KEY_DEF || tag === T.KEY_LITERAL) {
            if (!expectingKey(frame)) throw bad('misplaced property key');
            if (tag === T.KEY) {const id = u16(); if (id >= keys.length) throw bad('unknown property key'); property(keys[id]);}
            else {
              if (tag === T.KEY_DEF && (u16() !== keys.length || keys.length >= MAX_KEYS)) throw bad('property dictionary order or limit');
              keyMode = {define:tag === T.KEY_DEF};
            }
          } else if (tag === T.END) {
            if (!expectingKey(frame)) throw bad('unfinished container');
            if (frame.array) frame.value.length = frame.length; stack.pop();
          } else if (tag === T.FINISH) {
            if (!hasRoot || stack.length) throw bad('unfinished root'); finished = true;
          } else if (tag === T.NUMBERS || tag === T.HOLES) {
            const length = u16();
            if (!frame?.array || !length || length > RUN || frame.index + length > frame.length) throw bad('array run length or position');
            if (tag === T.NUMBERS) {
              ensure(length * 8); reserve(length * 8);
              for (let i = 0; i < length; i++) {frame.value[frame.index++] = view.getFloat64(pos, true); pos += 8;}
            } else frame.index += length;
            units += length;
          } else {
            if (expectingKey(frame)) throw bad('expected a property key');
            if (tag === T.NULL || tag === T.UNDEFINED || tag === T.FALSE || tag === T.TRUE) {
              reserve(8); append(tag === T.NULL ? null : tag === T.UNDEFINED ? undefined : tag === T.TRUE);
            } else if (tag === T.NUMBER) {ensure(8); reserve(8); append(view.getFloat64(pos, true)); pos += 8;}
            else if (tag === T.ARRAY || tag === T.OBJECT || tag === T.NULL_OBJECT) {
              if (stack.length >= MAX_DEPTH) throw bad('nesting exceeds 256 levels');
              const array = tag === T.ARRAY, length = array ? u32() : 0;
              if (array && length > maxBytes) throw bad('array length exceeds transfer budget');
              reserve(array ? 32 + length * 8 : 64);
              const value = array ? [] : tag === T.NULL_OBJECT ? Object.create(null) : {};
              append(value); stack.push({value, array, length, index:0, key:null});
            } else throw bad('unknown token');
          }
          if (++units >= 128 || timeBudgetMs === 0) {
            units = 0; check();
            if (performance.now() - sliceStart >= timeBudgetMs && pos < view.byteLength) {elapsed(); check(); await yieldControl(); check(); sliceStart = performance.now();}
          }
        }
        check();
      } catch (error) {dispose(); throw error;}
      finally {elapsed(); pushing = false;}
    },
    finish() {check(); if (pushing || !started || !finished || string || keyMode || stack.length) throw bad('truncated stream'); stats.completed = true; return root;},
  };
}
