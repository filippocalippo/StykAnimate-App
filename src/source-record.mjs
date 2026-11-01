import {messageError} from './localized-error.mjs';

/** The local codec's bounded original-source envelope, shared by both workers. `metadataOnly`: the record of `?meta=1`, which carries no bytes. */
export function decodeSourceRecord(buffer, {metadataOnly = false} = {}) {
  const invalid = () => messageError(new Error(''), 'errors.documentExportWorker.theFileServiceReturnedAnInvalidSourceRecord', {});
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 12) throw invalid();
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (new TextDecoder().decode(bytes.subarray(0,8)) !== 'STYKSRC1') throw invalid();
  const metadataLength = view.getUint32(8,true), start = 12 + metadataLength;
  if (!metadataLength || metadataLength > 4096 || start > bytes.byteLength || (!metadataOnly && start === bytes.byteLength) || bytes.byteLength - start > 256 * 1024 * 1024) throw invalid();
  let metadata;
  try { metadata = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(12,start))); } catch { throw invalid(); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
      !['piv','stk'].includes(metadata.kind) || !Number.isInteger(metadata.version) ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256) || !/^[a-f0-9]{64}$/.test(metadata.document_sha256) ||
      metadata.document_digest_version !== 3) throw invalid();
  return {metadata,bytes:bytes.subarray(start)};
}
