import {createHash} from 'node:crypto';
import {zstdCompressSync} from 'node:zlib';

/** A version 2 container around a skeleton and sections exactly as given, however damaged, for the tests of what the reader
 * refuses (the app never writes one: the engine's writer lifts a document, `styk_formats::container::lift`).
 * `skeleton` is an object (written as JSON); `arrays` and `payloads` are the two sections' bytes. */
export function forgeContainerV2({skeleton, arrays = new Uint8Array(), payloads = new Uint8Array(), kind = 'styk'}) {
  const sha = bytes => createHash('sha256').update(bytes).digest();
  const text = Buffer.from(JSON.stringify(skeleton)), sections = [[1, Buffer.from(arrays)], [2, Buffer.from(payloads)]];
  const stored = [text, ...sections.map(([, raw]) => raw)].map(raw => zstdCompressSync(raw));
  const out = Buffer.alloc(60 + stored[0].length + sections.length * 64);
  out.write({styk: 'STYK', stkz: 'STKZ', stykmov: 'STMV'}[kind], 0, 'ascii');
  out[4] = 2; out[5] = 2;
  out.writeBigUInt64LE(BigInt(text.length), 8); out.writeBigUInt64LE(BigInt(stored[0].length), 16);
  sha(text).copy(out, 24);
  out.writeUInt32LE(sections.length, 56);
  stored[0].copy(out, 60);
  let at = 60 + stored[0].length;
  sections.forEach(([sectionKind, raw], index) => {
    out[at] = sectionKind; out[at + 1] = 2;
    out.writeBigUInt64LE(BigInt(raw.length), at + 8); out.writeBigUInt64LE(BigInt(stored[index + 1].length), at + 16);
    sha(raw).copy(out, at + 24);
    at += 64;
  });
  return new Uint8Array(Buffer.concat([out, ...stored.slice(1)]));
}
