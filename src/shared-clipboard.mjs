import {messageError} from './localized-error.mjs';
import {clipboardWireChunks, createClipboardWireDecoder} from './clipboard-wire.mjs';
import {createFrame} from './demo.mjs';
import {validateCameraMotion} from './camera-motion.mjs';
import {validateVfxClips} from './vfx-clips.mjs';
import {validatePixelClipboard} from './drawing-clipboard.mjs';
import {drawingBarrier} from './drawing-resources.mjs';

const abort = () => messageError(new DOMException('', 'AbortError'), "errors.sharedClipboard.theDocumentChangedDuringTheClipboardOperation", {});

export function clipboardSnapshot(editor, kind) {
  let data;
  if (kind === 'figures') {
    const value = editor._selectionClipboard;
    if (!value) return null;
    data = {...value, layers: [...value.layers], freshTypes: [...(value.freshTypes ?? [])], documentToken: null, pastes: 0};
  } else if (kind === 'sheet') {
    if (!editor._sheetClipboard) return null;
    data = {...editor._sheetClipboard, document: null,
      layerNames: Object.fromEntries(editor._sheetClipboard.rows.map(row => [row.id, editor.getLayer(row.id)?.name ?? 'Copied layer']))};
  } else if (kind === 'drawing-pixels') data=editor._drawingPixelClipboard;
  else if (kind === 'camera-motion') data = editor._cameraMotionClipboard;
  else throw messageError(new Error(''), "errors.sharedClipboard.unsupportedClipboardType", {});
  return data ? {format: 'StykAnimate clipboard', version: 1, kind, data} : null;
}

export async function restoreClipboard(editor, packet, checkCurrent = () => {}) {
  if (packet?.format !== 'StykAnimate clipboard' || packet.version !== 1 || !packet.data) throw messageError(new Error(''), "errors.sharedClipboard.unsupportedStykanimateClipboard", {});
  const {kind, data} = packet;
  checkCurrent();
  if (kind === 'figures') {
    if (!Array.isArray(data.objects) || !data.objects.length || !Array.isArray(data.figures) || !Array.isArray(data.order) || !Number.isFinite(data.offset)) throw messageError(new Error(''), "errors.sharedClipboard.invalidFigureClipboard", {});
    if (data.vfxClips !== undefined) validateVfxClips({version: 1, clips: data.vfxClips});
    const value = {...data, layers: new Map(data.layers), freshTypes: new Set(data.freshTypes), documentToken: null, pastes: 0};
    editor._selectionClipboard = value; editor._figureClipboard = null;
  } else if (kind === 'sheet') {
    if (data.version !== 1 || !Array.isArray(data.rows) || !data.rows.length || !Number.isInteger(data.duration) || data.duration < 1 || !Array.isArray(data.figures) || !data.rows.every(row => typeof row.id === 'string' && Array.isArray(row.keys))) throw messageError(new Error(''), "errors.sharedClipboard.invalidTimelineClipboard", {});
    editor._sheetClipboard = {...data, document: null};
  } else if (kind === 'drawing-pixels') {
    validatePixelClipboard(data);
    editor._drawingPixelClipboard=data;
  } else if (kind === 'camera-motion') {
    validateCameraMotion({version:1,clips:[data]});editor._cameraMotionClipboard=data;
  } else throw messageError(new Error(''), "errors.sharedClipboard.unsupportedClipboardType", {});
  editor._emit('clipboard-restored', {clipboard: true});
  return kind;
}

export class SharedClipboard {
  constructor(editor, desktop) { this.editor = editor; this.desktop = desktop; this.pending = Promise.resolve(); this.id = null; this.kind = null; }
  run(operation) {
    const document = this.editor._documentToken;
    const result = this.pending.catch(() => {}).then(() => {
      if (document !== this.editor._documentToken) throw abort();
      return operation(() => { if (document !== this.editor._documentToken) throw abort(); });
    });
    this.pending = result; return result;
  }
  copy(kind, operation, {signal,checkCurrent=()=>{}}={}) {
    return this.run(async checkDocument => {
      const check=()=>{checkDocument();if(signal?.aborted)throw abort();checkCurrent();};
      check();const revision=this.editor.revision;await drawingBarrier(this.editor.report);check();if(revision!==this.editor.revision)throw abort();
      const result = await operation();
      check();
      if (!result) return result;
      const packet = clipboardSnapshot(this.editor, kind);
      if (!packet) return result;
      this.kind = kind;
      if (!this.desktop?.beginSharedClipboardWrite) return result;
      // If publication fails, the next Paste must re-read the last complete OS
      // copy instead of treating this new local selection as that old snapshot.
      this.id = null;
      const transfer = await this.desktop.beginSharedClipboardWrite();
      try {
        check();
        for await (const bytes of clipboardWireChunks(packet, {maxResidentBytes: 512 * 1024 * 1024,signal,checkCurrent:check})){
          check();await this.desktop.writeSharedClipboardChunk(transfer.token, bytes);check();
        }
        check();
        const saved = await this.desktop.finishSharedClipboardWrite(transfer.token);check();this.id = saved.id;
      } catch (error) { await this.desktop.cancelSharedClipboardTransfer(transfer.token); throw error; }
      return result;
    });
  }
  async read(checkCurrent) {
    if (!this.desktop?.beginSharedClipboardRead) return this.kind;
    const transfer = await this.desktop.beginSharedClipboardRead(this.id);
    if (!transfer) { checkCurrent(); return null; }
    if (transfer.unchanged) { checkCurrent(); return this.kind; }
    const decoder = createClipboardWireDecoder({maxBytes: 256 * 1024 * 1024, maxResidentBytes: 512 * 1024 * 1024, checkCurrent});
    try {
      checkCurrent();
      for (;;) {
        const part = await this.desktop.readSharedClipboardChunk(transfer.token);
        checkCurrent(); await decoder.push(part.bytes); if (part.done) break;
      }
      this.kind = await restoreClipboard(this.editor, decoder.finish(), checkCurrent); this.id = transfer.id;
      return this.kind;
    } finally { decoder.dispose(); await this.desktop.cancelSharedClipboardTransfer(transfer.token); }
  }
  paste(kind, operation, {signal,checkCurrent=()=>{}}={}) {
    return this.run(async checkDocument => {
      const check=()=>{checkDocument();if(signal?.aborted)throw abort();checkCurrent();};
      check();const current = await this.read(check);check();
      if (this.desktop?.beginSharedClipboardRead && !current) throw messageError(new Error(''), "errors.sharedClipboard.copyFiguresOrFramesInStykanimateFirst", {});
      if (kind && current && current !== kind) throw messageError(new Error(''), current === 'figures' ? 'errors.layerTimeline.pasteTheCopiedFiguresOnTheCanvas' : current === 'drawing-pixels' ? 'errors.sharedClipboard.pastePixelsInDraw' : 'errors.sharedClipboard.pasteFramesInTimeline');
      return operation(current);
    });
  }
}

/** Match fixed rows by kind and create missing artwork layers in the same undo. */
export function pasteSheetClipboard(editor, ids, tick, {insert = false, wholeScene = false} = {}) {
  const clipboard = editor._sheetClipboard;
  if (!clipboard) throw messageError(new Error(''), "errors.editorLayerSheet.copyTimelineFramesFirst", {});
  if (clipboard.document === editor._documentToken && !wholeScene) return editor.sheetPasteFrames(ids, tick, {insert});
  const fixed = id => id === 'scene' || id === 'camera';
  const selected = ids.filter(id => !fixed(id));
  const order = wholeScene ? editor.report._styk.layers.order : [...editor.report._styk.layers.order].reverse();
  const start = Math.max(0, order.indexOf(selected[0] ?? editor.activeLayerId));
  const available = wholeScene ? [...order] : selected.length > 1 ? selected : order.slice(start);
  return editor.movieclipBatch('Paste frames', () => {
    let index = 0;
    const destinations = clipboard.rows.map(row => {
      if (fixed(row.id)) return row.id;
      if (wholeScene && clipboard.document === editor._documentToken && editor.getLayer(row.id)) return row.id;
      if (wholeScene) {
        const match=available.findIndex(id=>Boolean(editor.getLayer(id)?.drawing)===Boolean(row.drawing));
        return match>=0?available.splice(match,1)[0]:editor.createLayer(clipboard.layerNames?.[row.id]??'Copied layer',{drawing:row.drawing}).id;
      }
      return available[index++] ?? editor.createLayer(clipboard.layerNames?.[row.id] ?? 'Copied layer',{drawing:row.drawing}).id;
    });
    const extra = wholeScene && clipboard.rows.some(row => row.id === 'scene') && clipboard.rows.some(row => row.id === 'camera')
      ? editor.report._styk.layers.order.filter(id => !destinations.includes(id)) : [];
    // A whole-scene insertion also shifts surplus destination layers. Empty
    // copied exposures keep their existing figures out of the inserted scene.
    if (extra.length) editor._sheetClipboard = {...clipboard, rows: [...clipboard.rows, ...extra.map(id => ({id,drawing:Boolean(editor.getLayer(id)?.drawing),
      keys: [{offset: 0, frame: createFrame([]), easing: {interpolation: 'constant'}}]}))]};
    try { return editor.sheetPasteFrames([...destinations, ...extra], tick, {insert}); }
    finally { editor._sheetClipboard = clipboard; }
  });
}
