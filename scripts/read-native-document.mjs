/** Test/inspection helper for native container payloads and historical JSON. */
import {readFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';

export async function readNativeDocument(filename) {
  const bytes = await readFile(filename), magic = bytes.subarray(0, 4).toString('ascii');
  if (!['STYK', 'STKZ'].includes(magic)) return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (bytes.length < 56 || bytes[4] !== 1 || bytes[5] !== 1 || bytes.readUInt16LE(6)) throw new Error('Invalid native header.');
  const size = Number(bytes.readBigUInt64LE(8)), packed = Number(bytes.readBigUInt64LE(16));
  if (size <= 0 || size > 256 * 1024 * 1024 || packed !== bytes.length - 56) throw new Error('Invalid native size.');
  const payload = inflateSync(bytes.subarray(56), {maxOutputLength: size});
  if (payload.length !== size || !createHash('sha256').update(payload).digest().equals(bytes.subarray(24, 56))) throw new Error('Invalid native checksum.');
  return JSON.parse(payload.toString('utf8'));
}
