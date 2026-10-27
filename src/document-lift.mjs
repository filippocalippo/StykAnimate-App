import {messageError} from './localized-error.mjs';
import {base64ToBytes, bytesToBase64} from './base64.mjs';

/** Lifting: a document leaves the editor's object model as a JSON skeleton whose large
 * number arrays and images are markers into two byte sections (docs/native-file-format.md).
 * The engine mirror stages records in this form, and a save hands it to the Rust container
 * writer (native-file-codec.mjs). Markers in the skeleton:
 *   "S2B:<t>:<s>:<o>:<n>"  numeric array, n elements of type t at offset o of section s
 *   "S2S:<s>:<o>:<n>"      string = base64 of the raw byte range
 *   "S2D:<s>:<o>:<n> <p>"  string = literal prefix p + base64 of the range
 *   "S2E:<rest>"           escape for a literal string that starts like a marker
 * Identical arrays (the same instance) are stored once and named by one marker, so shared
 * pose and key sequences keep their identity through a save and an open.
 */
const MAX_BYTES = 256 * 1024 * 1024;
const LIFT_MIN_ARRAY = 32, LIFT_MIN_STRING = 64 * 1024;
// Binary64's shortest decimal has at most 17 significant digits. JSON uses
// fixed notation only from 1e-6 to below 1e21, or a signed exponent with at
// most three digits. Including sign and punctuation, 32 bytes bounds either.
const MAX_JSON_NUMBER_BYTES = 32;
const B64_FIELDS = new Set(['data_base64', 'source_base64']);
const TYPES = {u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, i32: Int32Array, f32: Float32Array, f64: Float64Array};
const TYPE_BYTES = {u8: 1, u16: 2, u32: 4, i32: 4, f32: 4, f64: 8};
const ESCAPABLE = /^S2[BSED]:/;
const MARKER_ARRAY = /^S2B:(u8|u16|u32|i32|f32|f64):(\d+):(\d+):(\d+)$/;
const MARKER_B64 = /^S2S:(\d+):(\d+):(\d+)$/;
const MARKER_DATA = /^S2D:(\d+):(\d+):(\d+):(.*)$/s;

/** Drain the same lifted owner for synchronous container/worker callers. */
function drainLift(steps) {
  let step;
  do { step = steps.next(); } while (!step.done);
  return step.value;
}

/** UTF-8 length of a JSON string, with a checkpoint within long strings. */
function* jsonStringBytesSteps(value) {
  let bytes = 2, checkpoint = 2047;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
    else if (code < 32) bytes += 6;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
    if (i >= checkpoint) { yield null; checkpoint = i + 2048; }
  }
  return bytes;
}
function jsonStringBytes(value) { return drainLift(jsonStringBytesSteps(value)); }

/** The one exact numeric-array type selection, shared by both callers. */
function* arrayTypeSteps(values) {
  let ints = true, min = Infinity, max = -Infinity, f32 = true;
  for (let index = 0; index < values.length; index++) {
    const v = values[index];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    if (Number.isInteger(v)) {
      if (Math.abs(v) >= 2 ** 53) return null;
      if (v < min) min = v; if (v > max) max = v;
    } else ints = false;
    if (f32 && Math.fround(v) !== v) f32 = false;
    if ((index & 2047) === 2047) yield null;
  }
  if (ints) {
    if (min >= 0) {
      if (max <= 0xff) return 'u8';
      if (max <= 0xffff) return 'u16';
      if (max <= 0xffffffff) return 'u32';
    } else if (min >= -0x80000000 && max <= 0x7fffffff) return 'i32';
    return 'f64';
  }
  return f32 ? 'f32' : 'f64';
}

/** Canonical base64 validation never decodes or hashes a whole payload at once. */
function* canonicalBase64LengthSteps(value) {
  if (value.length % 4) return null;
  const end = value.length - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
  let last = 0;
  for (let i = 0; i < end; i++) {
    const code = value.charCodeAt(i);
    if (code >= 65 && code <= 90) last = code - 65;
    else if (code >= 97 && code <= 122) last = code - 71;
    else if (code >= 48 && code <= 57) last = code + 4;
    else if (code === 43) last = 62;
    else if (code === 47) last = 63;
    else return null;
    if ((i & 2047) === 2047) yield null;
  }
  const padding = value.length - end;
  if ((padding === 2 && (last & 15)) || (padding === 1 && (last & 3))) return null;
  return value.length / 4 * 3 - padding;
}

/** Bounded exact comparison: string-key hashing/equality must not flatten big blobs. */
function* blobFingerprint(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    if ((i & 2047) === 2047) yield null;
  }
  return `${value.length}:${hash >>> 0}`;
}
function* sameBlob(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) return false;
    if ((i & 2047) === 2047) yield null;
  }
  return true;
}

/** Existing numeric encoding, in fragments small enough to copy through a binding. */
function* numberFragments(type, value, offset) {
  for (let at = 0; at < value.length; at += 2048) {
    const typed = new TYPES[type](value.slice(at, at + 2048));
    yield {kind: 'section', section: 0, offset: offset + at * TYPE_BYTES[type], bytes: new Uint8Array(typed.buffer)};
  }
}
function* byteFragments(bytes, section, offset) {
  for (let at = 0; at < bytes.byteLength; at += 16384)
    yield {kind: 'section', section, offset: offset + at, bytes: bytes.subarray(at, at + 16384)};
}

/** JSON.stringify's scalar escaping, subdivided before a large escaped allocation. */
function* scalarFragments(value, array = false, prefix = '') {
  if (typeof value !== 'string') {
    const text = JSON.stringify(value);
    yield text ?? (array ? 'null' : '');
    return;
  }
  yield '"';
  if (prefix) yield JSON.stringify(prefix).slice(1, -1);
  for (let at = 0; at < value.length;) {
    let end = Math.min(value.length, at + 512);
    // Preserve a paired surrogate across the escape chunks exactly as JSON.stringify.
    if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff && value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff) end--;
    yield JSON.stringify(value.slice(at, end)).slice(1, -1);
    at = end;
  }
  yield '"';
}

/**
 * The one lifted document walk. Null yields are work checkpoints; stream mode yields
 * UTF-8-compatible skeleton text and offset binary fragments, then section lengths.
 * A stream caller supplies a worker/canonical key manifest for every object: this
 * owner never discovers cold own keys on the interface thread. Incomplete streams
 * are discarded atomically by their transport, and parsed/validated only on a worker.
 */
function* liftSteps(document, {preBlobs = [], maxBytes = MAX_BYTES, stream = false, keyManifest} = {}) {
  const arrays = [], blobs = [], seenArrays = new Map(), seenBlobs = new Map(), preBlobRanges = new Map();
  const stringSizes = new Map();
  const stringSize = function*(value) {
    if (value.length > 128) return yield* jsonStringBytesSteps(value);
    const cached = stringSizes.get(value);
    if (cached !== undefined) return cached;
    const length = yield* jsonStringBytesSteps(value);
    if (stringSizes.size < 512) stringSizes.set(value, length);
    return length;
  };
  let arraysLength = 0, blobsLength = 0, jsonUpperBytes = 0, knownJSONBytes = 0, allocationBytes = 0;
  const maxMaterializedBytes = maxBytes * 4;
  const admit = (length, estimated = false) => {
    if (!Number.isSafeInteger(length)) throw documentTooLarge();
    if (!estimated) {
      if (length > maxMaterializedBytes - knownJSONBytes) throw documentTooLarge();
      knownJSONBytes += length;
    }
    jsonUpperBytes += length;
  };
  const checkAllocation = () => {
    if (allocationBytes + arraysLength + blobsLength > maxMaterializedBytes) throw documentTooLarge();
  };
  const admitPayload = function*(prefix, encodedLength) {
    admit((yield* stringSize(prefix)) + encodedLength);
    allocationBytes += encodedLength; checkAllocation();
  };
  const blobOffsets = [];
  for (const bytes of preBlobs) {
    if (bytes.byteLength > maxBytes - blobsLength) throw documentTooLarge();
    if (!preBlobRanges.has(bytes)) preBlobRanges.set(bytes, {s: 1, o: blobsLength, n: bytes.byteLength});
    blobOffsets.push(blobsLength);
    if (stream) yield* byteFragments(bytes, 1, blobsLength); else blobs.push(bytes);
    blobsLength += bytes.byteLength;
    yield null;
  }
  const align = (length, type) => length + ((TYPE_BYTES[type] - (length % TYPE_BYTES[type])) % TYPE_BYTES[type]);
  // Reuse one small frame per nesting depth. Dense records must not allocate a
  // generator/closure/temporary frame for every scalar on the interface.
  const frames = [], frameAt = depth => frames[depth] ??= {kind: 0, source: null, out: null, keys: null, index: 0, key: '', slot: '', present: true, array: false, emitted: false};
  const root = frameAt(0); root.source = document;
  let depth = 0, skeleton;
  const finish = lifted => {
    const child = frames[depth--];
    if (stream) return;
    if (depth < 0) { skeleton = lifted; return; }
    const parent = frames[depth];
    if (child.present) {
      if (child.slot === '__proto__') Object.defineProperty(parent.out, child.slot, {value: lifted, writable: true, configurable: true, enumerable: true});
      else parent.out[child.slot] = lifted;
    }
  };
  while (depth >= 0) {
    const frame = frames[depth], value = frame.source;
    if (frame.kind !== 0) {
      const count = frame.kind === 1 ? value.length : frame.keys.length;
      if (frame.index >= count) {
        if (stream) yield frame.kind === 1 ? ']' : '}';
        finish(frame.out); continue;
      }
      const key = frame.kind === 1 ? frame.index++ : frame.keys[frame.index++];
      if (frame.kind === 2) admit((stringSizes.get(key) ?? (yield* stringSize(key))) + 1);
      const next = value[key];
      if (stream && frame.kind === 2 && (next === undefined || typeof next === 'function' || typeof next === 'symbol')) continue;
      if (stream) {
        if (frame.emitted) yield ',';
        if (frame.kind === 2) { if (key.length <= 512) yield JSON.stringify(key); else yield* scalarFragments(key); yield ':'; }
        frame.emitted = true;
      }
      const child = frameAt(++depth);
      child.kind = 0; child.source = next; child.key = frame.kind === 1 ? '' : key; child.slot = key;
      child.present = frame.kind !== 1 || key in value; child.array = frame.kind === 1;
      if (stream) yield null;
      continue;
    }
    const preBlob = B64_FIELDS.has(frame.key) && preBlobRanges.get(value);
    if (preBlob) {
      yield* admitPayload('', 4 * Math.ceil(preBlob.n / 3));
      const marker = `S2S:${preBlob.s}:${preBlob.o}:${preBlob.n}`;
      if (stream) yield JSON.stringify(marker);
      finish(marker); continue;
    }
    if (typeof value === 'string') {
      let payload = false;
      if (value.length >= LIFT_MIN_STRING) {
        let base64 = null, prefix = '';
        if (B64_FIELDS.has(frame.key)) base64 = value;
        else if ((frame.key === 'data_url' || frame.key === 'styk_tiles') && value.startsWith('data:')) {
          let comma = -1;
          for (let at = 0; at < value.length; at += 2048) {
            const found = value.slice(at, at + 2048).indexOf(',');
            if (found >= 0) { comma = at + found; break; }
            yield null;
          }
          if (comma > 5 && value.slice(0, comma).endsWith(';base64')) { base64 = value.slice(comma + 1); prefix = value.slice(0, comma + 1); }
        }
        if (base64 !== null) {
          const decodedLength = yield* canonicalBase64LengthSteps(base64);
          if (decodedLength !== null) {
            const fingerprint = yield* blobFingerprint(base64), candidates = seenBlobs.get(fingerprint) ?? [];
            let hit;
            for (const candidate of candidates) if (yield* sameBlob(candidate.value, base64)) { hit = candidate; break; }
            if (hit) {
              yield* admitPayload(prefix, base64.length);
              const lead = prefix ? `S2D:${hit.s}:${hit.o}:${hit.n}:` : `S2S:${hit.s}:${hit.o}:${hit.n}`;
              if (stream) yield* scalarFragments(prefix, false, lead);
              finish(stream ? null : lead + prefix); payload = true;
            } else {
              if (decodedLength > maxBytes - blobsLength) throw documentTooLarge();
              yield* admitPayload(prefix, base64.length);
              const s = 1, o = blobsLength, n = decodedLength;
              const owned = stream ? null : new Uint8Array(n);
              let offset = 0;
              for (let at = 0; at < base64.length; at += 16384) {
                const bytes = base64ToBytes(base64.slice(at, at + 16384));
                if (stream) yield {kind: 'section', section: 1, offset: o + offset, bytes};
                else { owned.set(bytes, offset); yield null; }
                offset += bytes.byteLength;
              }
              if (!stream) blobs.push(owned);
              blobsLength += n; candidates.push({value: base64, s, o, n}); seenBlobs.set(fingerprint, candidates);
              checkAllocation();
              const lead = prefix ? `S2D:${s}:${o}:${n}:` : `S2S:${s}:${o}:${n}`;
              if (stream) yield* scalarFragments(prefix, false, lead);
              finish(stream ? null : lead + prefix); payload = true;
            }
          }
        }
      }
      if (payload) continue;
      admit((value.length <= 128 ? stringSizes.get(value) : undefined) ?? (yield* stringSize(value)));
      const escaped = ESCAPABLE.test(value);
      if (stream) {
        if (value.length <= 512) yield JSON.stringify(escaped ? 'S2E:' + value : value);
        else yield* scalarFragments(value, frame.array, escaped ? 'S2E:' : '');
      }
      finish(stream ? null : escaped ? 'S2E:' + value : value); continue;
    }
    if (Array.isArray(value)) {
      const hit = seenArrays.get(value);
      if (hit) { admit(hit.jsonUpperBytes, true); if (stream) yield JSON.stringify(hit.marker); finish(hit.marker); continue; }
      const type = value.length >= LIFT_MIN_ARRAY ? yield* arrayTypeSteps(value) : null;
      if (type) {
        const jsonUpperBytes = 2 + Math.max(0, value.length - 1) + value.length * MAX_JSON_NUMBER_BYTES;
        admit(jsonUpperBytes, true);
        const offset = align(arraysLength, type);
        if (value.length > Math.floor((maxBytes - offset) / TYPE_BYTES[type])) throw documentTooLarge();
        if (stream && offset > arraysLength) yield {kind: 'section', section: 0, offset: arraysLength, bytes: new Uint8Array(offset - arraysLength)};
        arraysLength = offset + value.length * TYPE_BYTES[type];
        allocationBytes += value.length * 48; checkAllocation();
        const marker = `S2B:${type}:0:${offset}:${value.length}`;
        if (stream) yield* numberFragments(type, value, offset); else arrays.push({type, value, offset});
        seenArrays.set(value, {marker, jsonUpperBytes});
        if (stream) yield JSON.stringify(marker);
        finish(marker); continue;
      }
      admit(2 + Math.max(0, value.length - 1));
      frame.kind = 1; frame.out = stream ? null : new Array(value.length); frame.keys = null; frame.index = 0; frame.emitted = false;
      if (stream) yield '[';
      continue;
    }
    if (value && typeof value === 'object') {
      const keys = stream ? keyManifest?.get(value) : Object.keys(value);
      if (!keys) throw Object.assign(new Error('The canonical record keys are not ready.'), {code: 'engine_keys_not_ready'});
      admit(2 + Math.max(0, keys.length - 1));
      frame.kind = 2; frame.out = stream ? null : {}; frame.keys = keys; frame.index = 0; frame.emitted = false;
      if (stream) yield '{';
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) admit(MAX_JSON_NUMBER_BYTES, true);
    else admit(value == null || typeof value === 'number' ? 4 : String(value).length);
    if (stream) yield JSON.stringify(value) ?? (frame.array ? 'null' : '');
    finish(value);
  }
  if (stream) return {sectionLengths: [arraysLength, blobsLength], blobOffsets, materializedUpperBytes: jsonUpperBytes, materializationLimit: maxMaterializedBytes};
  const arraysBytes = new Uint8Array(arraysLength);
  for (const entry of arrays) for (const fragment of numberFragments(entry.type, entry.value, entry.offset)) { arraysBytes.set(fragment.bytes, fragment.offset); yield null; }
  const blobsBytes = new Uint8Array(blobsLength);
  let offset = 0;
  for (const bytes of blobs) {
    for (const fragment of byteFragments(bytes, 1, offset)) { blobsBytes.set(fragment.bytes, fragment.offset); yield null; }
    offset += bytes.byteLength;
  }
  const sections = [{kind: 1, bytes: arraysBytes}, {kind: 2, bytes: blobsBytes}];
  // The finite-number bound above is generous; only a document that exceeds the limit by it is measured exactly.
  if (jsonUpperBytes > maxMaterializedBytes && liftedJSONBytes(skeleton, sections) > maxMaterializedBytes) throw documentTooLarge();
  return {skeleton, sections, blobOffsets};
}

/**
 * Incremental lifted owner. Skeleton tokens are joined within 8192 UTF-16 code
 * units; binary chunks are at most 16384 bytes. Stream completion is not validation:
 * its receiver validates materialization limits atomically on a worker before ACK.
 */
export function* liftDocumentSteps(document, options = {}) {
  const steps = liftSteps(document, options);
  let text = '', step;
  try {
    for (;;) {
      step = steps.next();
      if (step.done) { if (text) yield {kind: 'skeleton', text}; return step.value; }
      const item = step.value;
      if (typeof item === 'string') {
        if (text.length + item.length > 8192) { yield {kind: 'skeleton', text}; text = ''; }
        text += item;
      } else if (item === null) {
        // A work checkpoint need not turn every small property into a packet.
        yield null;
      } else {
        if (text) { yield {kind: 'skeleton', text}; text = ''; }
        yield item;
      }
    }
  } finally {
    steps.return();
  }
}

/** Synchronous container callers share all marker/packing/escaping decisions. */
export function liftDocument(document, options = {}) {
  return drainLift(liftDocumentSteps(document, {preBlobs: options.preBlobs, maxBytes: options.maxBytes}));
}

/** The elements a numeric-array marker names, as a typed view of its section. A section holds the bytes
 * from `base` on when only part of it is at hand (the engine hands a document over in pieces). */
function arrayView(match, sections) {
  const type = match[1], held = sections[+match[2]], section = held?.bytes, base = held?.base ?? 0, width = TYPE_BYTES[type];
  const offset = +match[3] - base, count = +match[4];
  if (!section || ![offset, count].every(Number.isSafeInteger) || offset < 0 || (offset + base) % width || offset > section.byteLength || count > Math.floor((section.byteLength - offset) / width))
    throw messageError(new Error(''), "errors.nativeContainer.theStykanimateFileIsDamagedInvalidArraySection", {});
  const absolute = section.byteOffset + offset;
  // A section can begin at an unaligned offset of its buffer; typed views cannot.
  return absolute % width === 0 ? new TYPES[type](section.buffer, absolute, count)
    : new TYPES[type](section.slice(offset, offset + count * width).buffer);
}

/** The raw bytes a payload marker names. */
function payloadBytes(held, offset, count) {
  const bytes = held?.bytes;
  offset -= held?.base ?? 0;
  if (!bytes || ![offset, count].every(Number.isSafeInteger) || offset < 0 || offset > bytes.byteLength || count > bytes.byteLength - offset)
    throw messageError(new Error(''), "errors.nativeContainer.theStykanimateFileIsDamagedInvalidPayloadSection", {});
  return bytes.subarray(offset, offset + count);
}

/** The JSON length of the document a lifted skeleton stands for, markers expanded:
 * what a reader will materialize, counted exactly rather than bounded. */
function liftedJSONBytes(skeleton, sections) {
  const arrays = new Map();
  let total = 0;
  const visit = value => {
    if (typeof value === 'string') {
      let match = MARKER_ARRAY.exec(value);
      if (match) {
        let bytes = arrays.get(value);
        if (bytes === undefined) {
          const view = arrayView(match, sections);
          bytes = 2 + Math.max(0, view.length - 1);
          for (let i = 0; i < view.length; i++) bytes += String(view[i]).length;
          arrays.set(value, bytes);
        }
        total += bytes; return;
      }
      if ((match = MARKER_B64.exec(value)) || (match = MARKER_DATA.exec(value))) { total += jsonStringBytes(match[4] || '') + 4 * Math.ceil(+match[3] / 3); return; }
      total += jsonStringBytes(value.startsWith('S2E:') ? value.slice(4) : value);
    } else if (Array.isArray(value)) {
      total += 2 + Math.max(0, value.length - 1);
      for (const item of value) visit(item);
    } else if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      total += 2 + Math.max(0, keys.length - 1);
      for (const key of keys) { total += jsonStringBytes(key) + 1; visit(value[key]); }
    } else total += value == null || typeof value === 'number' && !Number.isFinite(value) ? 4 : String(value).length;
  };
  visit(skeleton);
  return total;
}

/** The inverse of lifting: replaces the markers of a parsed skeleton, in place, with the
 * arrays and strings they stand for. The sections are `[{bytes}]` (numeric arrays, then
 * payloads), as `liftDocument` returns them. Markers with identical text give the *same*
 * array instance, so shared pose and key sequences keep their identity through a save and
 * an open. The Rust container reader has already admitted the file (native-file-codec.mjs), so
 * nothing is measured here. `shared` remembers what the markers named: a document restored piece by piece
 * (src/engine/engine-open.mjs) passes the same one to every piece, and a section may then hold only the
 * bytes from its `base` on. */
export function restoreLifted(document, sections, shared = new Map()) {
  const resolve = value => {
    let match = MARKER_ARRAY.exec(value);
    if (match) {
      let array = shared.get(value);
      if (!array) {
        const view = arrayView(match, sections);
        array = new Array(view.length);
        for (let i = 0; i < view.length; i++) array[i] = view[i];
        shared.set(value, array);
      }
      return array;
    }
    if ((match = MARKER_B64.exec(value)) || (match = MARKER_DATA.exec(value))) {
      let text = shared.get(value);
      if (text === undefined) {
        const encoded = bytesToBase64(payloadBytes(sections[+match[1]], +match[2], +match[3]));
        text = match[0][2] === 'S' ? encoded : match[4] + encoded;
        shared.set(value, text);
      }
      return text;
    }
    if (value.startsWith('S2E:')) return value.slice(4);
    if (value.startsWith('S2R:')) {
      // A pose key sequence several channels share, restored by the piece that first held it.
      const sequence = shared.get(value);
      if (!sequence) throw messageError(new Error(''), "errors.nativeContainer.theStykanimateFileIsDamagedMalformedSectionMarker", {});
      return sequence;
    }
    if (value.startsWith('S2B:') || value.startsWith('S2S:') || value.startsWith('S2D:'))
      throw messageError(new Error(''), "errors.nativeContainer.theStykanimateFileIsDamagedMalformedSectionMarker", {});
    return value;
  };
  const walk = value => {
    if (typeof value === 'string') return value.length > 3 && value.charCodeAt(0) === 83 ? resolve(value) : value;
    if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) value[i] = walk(value[i]); return value; }
    if (value && typeof value === 'object')
      for (const key of Object.keys(value)) {
        const walked = walk(value[key]);
        if (walked === value[key]) continue;
        if (key === '__proto__') Object.defineProperty(value, key, {value: walked, writable: true, configurable: true, enumerable: true});
        else value[key] = walked;
      }
    return value;
  };
  return walk(document);
}

function documentTooLarge() {
  return Object.assign(messageError(new Error(''), "errors.nativeContainer.theStykanimateDocumentExceedsTheUncompressedSizeLimit", {}), {code: 'document_too_large'});
}
