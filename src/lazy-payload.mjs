/**
 * Payloads of the read view: the pictures and originals the engine holds as bytes (`data_base64`, `data_url`,
 * `styk_tiles`, `source_base64`). The view does not hold their text. The engine names each payload by a token
 * (`S2P:<token>`, styk_doc::payload) and the view defines the field as a getter that asks the engine for the
 * text on first read and keeps it, so a picture nothing reads costs the view nothing. Readers see an ordinary
 * string property; `JSON.stringify` and the spread read it like any other. The field has no setter: the view
 * is changed by the engine's patches, never in place, and a write to it throws.
 */

/** The text of a lazy payload field's marker: `S2P:` and a token. */
export const PAYLOAD_MARKER = 'S2P:';

/** Whether `text` names a payload. */
export const namesPayload = text => typeof text === 'string' && text.startsWith(PAYLOAD_MARKER);

/** Defines `owner[key]` as the text of payload `token`, read through `text(token)` the first time it is asked for. */
export function defineLazyPayload(owner, key, marker, text) {
  const token = Number(marker.slice(PAYLOAD_MARKER.length));
  if (!Number.isSafeInteger(token) || token <= 0) throw new Error('The document names a payload that is not a token.');
  let value;
  Object.defineProperty(owner, key, {enumerable: true, configurable: true, get() { return value ??= text(token); }});
}

/** Sets `target[key]` to `value`, replacing a lazy payload field (which has no setter) instead of writing to it. */
export function putField(target, key, value) {
  if (Object.getOwnPropertyDescriptor(target, key)?.get) Object.defineProperty(target, key, {value, writable: true, enumerable: true, configurable: true});
  else if (key === '__proto__') Object.defineProperty(target, key, {value, writable: true, enumerable: true, configurable: true});
  else target[key] = value;
}

/** Makes `target[key]` what `source[key]` is, a lazy payload field staying unread. */
export function copyField(target, source, key) {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor?.get) Object.defineProperty(target, key, descriptor);
  else putField(target, key, source[key]);
}

/** A shallow copy with the same keys in the same order (integer-like keys lead, as always); lazy payloads stay unread. */
export function copyRecord(object) {
  const copy = {};
  for (const key of Object.keys(object)) copyField(copy, object, key);
  return copy;
}
