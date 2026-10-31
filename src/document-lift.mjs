import {messageError} from './localized-error.mjs';
import {base64ToBytes, bytesToBase64} from './base64.mjs';

/** The lifted form of a document, as the Rust container reader hands it over (docs/native-file-format.md): a JSON skeleton
 * whose large number arrays and images are markers into two byte sections. The engine writes this form
 * (`styk_formats::container::lift`, which a save and the interface's read view both use); this module restores a skeleton
 * into the editor's object model. Markers in the skeleton:
 *   "S2B:<t>:<s>:<o>:<n>"  numeric array, n elements of type t at offset o of section s
 *   "S2S:<s>:<o>:<n>"      string = base64 of the raw byte range
 *   "S2D:<s>:<o>:<n> <p>"  string = literal prefix p + base64 of the range
 *   "S2E:<rest>"           escape for a literal string that starts like a marker
 *   "S2R:<n>"              a pose key sequence several channels share (the read view's pieces)
 * Identical arrays (the same instance) are stored once and named by one marker, so shared
 * pose and key sequences keep their identity through a save and an open.
 */
const TYPES = {u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, i32: Int32Array, f32: Float32Array, f64: Float64Array};
const TYPE_BYTES = {u8: 1, u16: 2, u32: 4, i32: 4, f32: 4, f64: 8};
const MARKER_ARRAY = /^S2B:(u8|u16|u32|i32|f32|f64):(\d+):(\d+):(\d+)$/;
const MARKER_B64 = /^S2S:(\d+):(\d+):(\d+)$/;
const MARKER_DATA = /^S2D:(\d+):(\d+):(\d+):(.*)$/s;

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
