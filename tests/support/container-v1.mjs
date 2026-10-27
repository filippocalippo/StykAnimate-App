import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';

/** Version 1 (zlib around one JSON payload), which the app no longer writes, for the compatibility tests. */
export function buildContainerV1(payload, kind) {
  const bytes = typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload), stored = deflateSync(bytes);
  const out = Buffer.alloc(56 + stored.length);
  out.write({styk: 'STYK', stkz: 'STKZ', stykmov: 'STMV'}[kind], 0, 'ascii');
  out[4] = 1; out[5] = 1;
  out.writeBigUInt64LE(BigInt(bytes.length), 8); out.writeBigUInt64LE(BigInt(stored.length), 16);
  createHash('sha256').update(bytes).digest().copy(out, 24);
  stored.copy(out, 56);
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}
