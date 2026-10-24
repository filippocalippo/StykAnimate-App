/**
 * Pages (64 KiB) of the memory a WebAssembly module imports, read from its import
 * section: the least a memory handed to it may start with.
 */
export function declaredMemoryPages(bytes) {
  const data = new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
  let at = 8; // magic and version
  const number = () => { let value = 0, scale = 1, byte; do { byte = data[at++]; value += (byte & 127) * scale; scale *= 128; } while (byte & 128); return value; };
  const limits = () => { const flags = number(), minimum = number(); if (flags & 1) number(); return minimum; };
  const name = () => { const length = number(); at += length; };
  while (at < data.length) {
    const id = data[at++], size = number(), end = at + size;
    if (id === 2) {
      for (let count = number(); count > 0; count--) {
        name(); name(); // module and field
        const kind = data[at++];
        if (kind === 2) return limits();
        if (kind === 0) number();                  // function: type index
        else if (kind === 1) { at++; limits(); }   // table: element type, limits
        else if (kind === 3) at += 2;              // global: value type, mutability
        else if (kind === 4) { at++; number(); }   // tag: attribute, type index
        else break;
      }
    }
    at = end;
  }
  throw new Error('The engine module does not import its memory.');
}
