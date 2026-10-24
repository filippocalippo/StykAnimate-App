/** Bounded cache of immutable compressed blocks, owned by an export worker.
 *
 * A save compresses three blocks (skeleton, numeric arrays, payloads); the Rust container
 * writer (native-file-codec.mjs) asks this cache for each by a key that names the codec, level,
 * length and SHA-256 of its raw bytes, so a hit is the same bytes and an unchanged block of
 * an autosaved project is not compressed again. It retains no editable document data.
 *
 * Entries are Uint8Arrays that own their buffer. take() hands them over, buffers
 * transferable, so a retiring worker passes them to the page without copying, and
 * restore() checks what comes back. */
const KEY = /^2:3:(0|[1-9]\d{0,8}):[a-f0-9]{64}$/;
const MAX_KEY_LENGTH = 128;
const MAX_BLOCK_LENGTH = 384 * 1024 * 1024;

export function createContainerCompressionCache({maxBytes = 64 * 1024 * 1024, maxEntries = 8} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 0)
    throw new RangeError('Invalid compression cache capacity.');
  const entries = new Map();
  let byteLength = 0;
  const insert = (key, bytes) => {
    if (bytes.byteLength > maxBytes || !maxEntries) return;
    const previous = entries.get(key);
    if (previous) { byteLength -= previous.byteLength; entries.delete(key); }
    while (entries.size >= maxEntries || byteLength + bytes.byteLength > maxBytes) {
      const oldest = entries.keys().next().value;
      byteLength -= entries.get(oldest).byteLength; entries.delete(oldest);
    }
    entries.set(key, bytes); byteLength += bytes.byteLength;
  };
  return {
    get byteLength() { return byteLength; },
    get size() { return entries.size; },
    /** The stored block, kept as the most recently used; callers must not change it. */
    get(key) {
      const value = entries.get(key);
      if (value) { entries.delete(key); entries.set(key, value); }
      return value;
    },
    /** Stores a copy of bytes: the caller may be handing over a view it will reuse. */
    put(key, bytes) {
      if (bytes.byteLength > maxBytes || !maxEntries) return;
      insert(key, bytes.slice());
    },
    /** Every entry, oldest first, emptying the cache: the buffers move to whoever receives them. */
    take() {
      const taken = [...entries].map(([key, bytes]) => ({key, bytes}));
      entries.clear(); byteLength = 0;
      return taken;
    },
    /** Replaces the contents with what take() returned elsewhere, keeping the newest entries that fit. */
    restore(taken) {
      entries.clear(); byteLength = 0;
      if (!Array.isArray(taken) || !maxEntries) return;
      for (const entry of taken.slice(-maxEntries)) {
        if (!entry || typeof entry.key !== 'string' || entry.key.length > MAX_KEY_LENGTH || !(entry.bytes instanceof Uint8Array)) continue;
        const match = KEY.exec(entry.key);
        if (!match || Number(match[1]) > MAX_BLOCK_LENGTH) continue;
        insert(entry.key, entry.bytes);
      }
    },
    clear() { entries.clear(); byteLength = 0; },
  };
}
