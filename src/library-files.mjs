import {nativeFigureDocument} from './native-figure.mjs';

export function librarySnapshot(editor) {
  return structuredClone(nativeFigureDocument(editor.report, {figureUids: [...editor.selectedUids], sourceFrame: editor.selectionFrame, tick: editor.tick}));
}
export function libraryPreview(report) {
  return new Promise((resolve,reject) => {
    const worker = new Worker(new URL('./library-preview-worker.mjs', import.meta.url), {type:'module'});
    const finish = (error, result) => { clearTimeout(timer); worker.terminate(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(new Error('The library preview timed out.')), 60000);
    worker.onerror = event => finish(new Error(event.message));
    worker.onmessage = async ({data}) => {
      if (data.error) return finish(new Error(data.error));
      const reader = new FileReader(); reader.onerror = () => finish(new Error('Could not encode the preview.'));
      reader.onload = () => finish(null, reader.result); reader.readAsDataURL(data.blob);
    };
    worker.postMessage({report, baseURL: location.href});
  });
}
export async function saveLibraryFile(desktop, blob, options) {
  const transfer = await desktop.beginLibrarySave({...options, size:blob.size});
  try {
    for (let offset = 0; offset < blob.size; offset += transfer.maxChunkBytes)
      await desktop.writeLibraryChunk(transfer.token, await blob.slice(offset, offset + transfer.maxChunkBytes).arrayBuffer());
    return await desktop.finishLibrarySave(transfer.token);
  } catch (error) { await desktop.cancelLibraryTransfer(transfer.token).catch(() => {}); throw error; }
}
export async function readLibraryFile(desktop, path) {
  const transfer = await desktop.beginLibraryRead(path), parts = []; let size = 0;
  try {
    for (;;) { const part = await desktop.readLibraryChunk(transfer.token); parts.push(part.bytes); size += part.bytes.byteLength; if (part.done) break; }
    if (size !== transfer.size) throw new Error('The library file changed while reading.');
    return new File(parts, transfer.name);
  } finally { await desktop.cancelLibraryTransfer(transfer.token).catch(() => {}); }
}
