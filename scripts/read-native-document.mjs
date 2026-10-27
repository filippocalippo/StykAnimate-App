/** Test/inspection helper for native container payloads and historical JSON. */
import {readFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';

export async function readNativeDocument(filename) {
  const bytes = await readFile(filename), magic = bytes.subarray(0, 4).toString('ascii');
  if (!['STYK', 'STKZ', 'STMV'].includes(magic)) return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  const kind = magic === 'STYK' ? 'styk' : magic === 'STKZ' ? 'stkz' : 'stykmov';
  const {decodeDocument} = await import('../tests/support/native-files.mjs');
  return (await decodeDocument(bytes, kind)).document;
}
