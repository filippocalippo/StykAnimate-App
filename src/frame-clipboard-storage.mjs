import {DocumentExporter} from './document-export.mjs';
import {ImportClient} from './import-client.mjs';
import {readNativeClipboard, writeNativeBlob} from './native-files.mjs';

/** Persist the app-owned clipboard separately from the OS clipboard and project.
 * Worker serialization plus bounded native chunks keep media off the UI JSON
 * path. A newer copy always wins over startup restore or an older pending save. */
export function installNativeFrameClipboard(editor, desktop, {onError = () => {}, onRestored = () => {}, baseURL} = {}) {
  let generation = 0, intentGeneration = 0, controller = null, pending = Promise.resolve(), disposed = false, error = null;
  const exporter = new DocumentExporter({baseURL});
  const fail = failure => { if (failure.name !== 'AbortError' && !disposed) { error = failure; onError(failure); } };
  const persist = () => {
    generation++; intentGeneration++; controller?.abort(); controller = new AbortController();
    const report = editor.frameClipboardDocumentView?.() ?? editor.frameClipboardDocument(), current = generation, signal = controller.signal;
    if (!report) return;
    pending = pending.catch(() => {}).then(async () => {
      if (disposed || signal.aborted || current !== generation) return;
      const blob = await exporter.export(report, {format: 'styk', name: 'Copied keyframes', signal});
      if (current !== generation) return;
      await writeNativeBlob(desktop, blob, {clipboard: true, signal}); error = null;
    });
    pending.catch(fail);
  };
  const listener = event => {
    if (event.detail?.kind === 'clipboard') persist();
    else if (event.detail?.kind === 'clipboard-pending') {
      // An asynchronous copy owns the intent immediately, before its bounded
      // capture completes. Startup restoration must not win that race.
      intentGeneration++;
    }
  };
  editor.addEventListener('change', listener);
  const ready = (async () => {
    const initial = intentGeneration, saved = await readNativeClipboard(desktop);
    if (!saved || disposed || initial !== intentGeneration || editor.hasFrameClipboard) return false;
    const importer = new ImportClient({baseURL});
    try {
      const result = await importer.importFile(new File([saved.blob], 'Copied keyframes.styk'));
      if (disposed || initial !== intentGeneration || editor.hasFrameClipboard) return false;
      if (editor.restoreFrameClipboardAsync) await editor.restoreFrameClipboardAsync(result.document,{checkCurrent:()=>{
        if(disposed||initial!==intentGeneration||editor.hasFrameClipboard)throw new DOMException('Clipboard restoration superseded.','AbortError');
      }});
      else editor.restoreFrameClipboard(result.document);
      onRestored(editor.clipboardFrameCount);
      editor._emit('clipboard-restored', {clipboard: true}); return true;
    } finally { importer.dispose(); }
  })().catch(failure => { fail(failure); return false; });
  return {
    ready,
    get error() { return error; },
    async flush() { await ready; await pending; if (error) throw error; },
    save: persist,
    dispose() { disposed = true; controller?.abort(); exporter.dispose(); editor.removeEventListener('change', listener); },
  };
}
