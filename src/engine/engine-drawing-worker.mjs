/**
 * The pixel worker's operations on the drawing raster engine (engine/crates/styk-drawing):
 * the same requests and replies as drawing-worker-operations.mjs, `prepare-tiles` and the
 * preview of drawing-worker.mjs, answered by the WebAssembly module this worker loaded
 * (src/engine/engine-drawing.mjs). Canvas work (thumbnail scaling, preview bitmaps) and
 * base64 stay here: they are platform services.
 */
import {errorMessageData, messageError} from '../localized-error.mjs';
import {DRAWING_MAX_PIXELS} from '../drawing-model.mjs';
import {TRANSFORM_BYTES} from '../drawing-transform.mjs';
import {TILE_BLOB_PREFIX, tileBlobBytes} from '../drawing-tile-codec.mjs';
import {drawingPNGBytes} from '../drawing-png.mjs';
import {engineCall, tilesIn, maskIn, changesOut, tilesOut, rectOf, bytesOf, releaseDrawingEngineMemory, drawingEngineGeneration} from './engine-drawing.mjs';

const validRect = r => r && [r.x, r.y].every(Number.isSafeInteger) && Number.isInteger(r.width) && Number.isInteger(r.height) && r.width > 0 && r.height > 0 && r.width * r.height <= DRAWING_MAX_PIXELS;
const rectArray = r => r ? Float64Array.of(r.x, r.y, r.width, r.height) : new Float64Array(0);
/** The request's tiles as the module's input (`storeOf(data)`), released after `use`. */
function withTiles(list, use, options) {
  const tiles = tilesIn(list, options);
  try { return use(tiles); } finally { tiles.free(); }
}
const transferOf = changes => changes.flatMap(t => [t.before?.buffer, t.after?.buffer].filter(Boolean));
// Encoded tiles persist across publications, as the JavaScript worker's TileEncodeCache does.
let publisher = null;
// One source cache per preview worker.
let preview = null;
// A publication in bounded batches: the encode cache must survive until its final request.
let publishing = false;
// The instance these caches belong to: a replaced instance (memory released, or a trap) drops them.
let generation = drawingEngineGeneration();

/** Answers one pixel-worker request; `post(message, transfer)` replies. Afterwards an
 * instance grown past its allowance is replaced (dropping the encoded-tile cache, which the
 * publication protocol refills), except between the batches of one publication; a preview
 * worker keeps its source cache instead. */
export async function drawingEngineOperation(data, post = (message, transfer) => self.postMessage(message, transfer)) {
  if (generation !== drawingEngineGeneration()) { publisher = null; preview = null; publishing = false; generation = drawingEngineGeneration(); }
  try { await operation(data, post); }
  finally { if (!preview && !publishing && releaseDrawingEngineMemory()) { publisher = null; generation = drawingEngineGeneration(); } }
}

async function operation(data, post) {
  const {id, kind} = data;
  try {
    if (kind === 'prepare-tiles') {
      const output = withTiles(data.tiles, tiles => engineCall(g => g.prepareTiles(tiles)));
      const tiles = [];
      for (let i = 0; i < output.length; i++) {
        // A full tile stays the buffer it arrived in; uniform colours come back expanded.
        const pixels = output.flag(i) ? data.tiles[i].pixels : output.a(i)?.buffer ?? null;
        tiles.push({tx: output.tx(i), ty: output.ty(i), pixels, alphaBounds: pixels ? rectOf(output.alpha(i)) : null});
      }
      output.free();
      post({id, tiles}, tiles.flatMap(t => t.pixels ? [t.pixels] : []));
      return;
    }
    if (kind === 'preview') {
      const {rect, level} = data;
      if (!rect || ![rect.x, rect.y].every(Number.isSafeInteger) || ![rect.width, rect.height].every(n => Number.isInteger(n) && n > 0 && n <= 4096) || !Number.isInteger(level) || level < 0 || level > 8)
        throw messageError(new Error(''), 'errors.drawingWorkerPreview.invalidDrawingPreviewBounds', {});
      preview ??= engineCall(g => new g.Preview());
      const keep = Float64Array.from((data.keep ?? []).flatMap(key => key.split(',').map(Number)));
      const output = withTiles(data.tiles, tiles => engineCall(() => preview.update(Boolean(data.reset), keep, tiles, level)));
      const canvas = new OffscreenCanvas(rect.width, rect.height), ctx = canvas.getContext('2d', {willReadFrequently: true});
      for (const tile of tilesOut(output)) ctx.putImageData(new ImageData(tile.pixels, 64, 64), tile.tx * 64 - rect.x, tile.ty * 64 - rect.y);
      output.free();
      const bitmap = canvas.transferToImageBitmap();
      post({id, bitmap}, [bitmap]);
      return;
    }
    if (kind === 'decode-legacy') {
      const crop = data.crop ?? {x: 0, y: 0};
      if (![crop.x, crop.y].every(Number.isInteger)) throw messageError(new Error(''), 'errors.drawingWorkerOperations.invalidDrawingCrop', {});
      const output = engineCall(g => g.decodeLegacy(drawingPNGBytes(data.url), crop.x, crop.y));
      const tiles = tilesOut(output).map(t => ({tx: t.tx, ty: t.ty, pixels: t.pixels.buffer}));
      output.free();
      post({id, tiles}, tiles.map(t => t.pixels));
      return;
    }
    if (kind === 'encode-pngs') {
      const output = withTiles(data.tiles, tiles => engineCall(g => g.encodePngs(tiles)));
      const out = [];
      for (let i = 0; i < output.length; i++) out.push({tx: output.tx(i), ty: output.ty(i), png: output.a(i).buffer});
      output.free();
      post({id, tiles: out}, out.map(t => t.png));
      return;
    }
    if (kind === 'decode-tiles') {
      const shard = data.shard;
      const output = engineCall(g => g.decodeTiles(tileBlobBytes(data.url), shard ? shard[0] : 0, shard ? shard[1] : 0, data.levels > 0 ? data.levels : 0));
      const tiles = [], levels = [];
      for (let i = 0; i < output.length; i++) {
        const level = output.level(i), entry = {tx: output.tx(i), ty: output.ty(i), pixels: output.a(i).buffer};
        if (level === 0) { entry.png = output.b(i).buffer; tiles.push(entry); }
        else (levels[level - 1] ??= []).push(entry);
      }
      output.free();
      post({id, tiles, levels}, [...tiles.flatMap(t => [t.pixels, t.png]), ...levels.flat().map(t => t.pixels)]);
      return;
    }
    if (kind === 'encode-tiles') {
      publisher ??= engineCall(g => new g.Publisher(64 * 1024 * 1024));
      publishing = Boolean(data.partial);
      if (data.pngs?.length) withTiles(data.pngs, pngs => engineCall(() => publisher.adopt(data.celId, pngs)), {png: true});
      const keep = data.keep == null ? undefined : Float64Array.from(data.keep.flatMap(key => key.split(',').map(Number)));
      const output = withTiles(data.tiles, tiles => engineCall(() => publisher.encode(data.celId, keep, tiles, Boolean(data.partial))), {png: true});
      const out = [], missing = [];
      for (let i = 0; i < output.length; i++) {
        if (output.flag(i)) missing.push(`${output.tx(i)},${output.ty(i)}`);
        else out.push({tx: output.tx(i), ty: output.ty(i), png: output.a(i).buffer});
      }
      const encoded = output.number(0), reused = output.number(1), assembled = output.number(2) === 1, bytes = assembled ? output.takeBytes() : null;
      output.free();
      if (missing.length) { post({id, missing, tiles: out, encoded}, out.map(t => t.png)); return; }
      if (data.partial) { post({id, tiles: out, encoded}, out.map(t => t.png)); return; }
      let text = ''; for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384));
      post({id, tiles: out, blobUrl: TILE_BLOB_PREFIX + btoa(text), encoded, reused}, out.map(t => t.png));
      return;
    }
    if (kind === 'fill') {
      const o = data.options ?? {}, b = data.bounds;
      const bounds = b ? Float64Array.of(b.x, b.y, b.width, b.height) : new Float64Array(0);
      const output = withTiles(data.tiles, tiles => engineCall(g => g.fill(tiles, bounds, o.x, o.y, Float64Array.from(o.color ?? [0, 0, 0, 255]), o.tolerance ?? 16, o.expansion ?? 0, o.gap ?? 0,
        o.maxBytes ?? 768 * 1024 * 1024, maskIn(o.clip), data.source ? bytesOf(data.source) : undefined)));
      const tiles = changesOut(output);
      post({id, tiles}, transferOf(tiles));
      return;
    }
    if (kind === 'flood-mask') {
      if (!validRect(data.bounds)) throw messageError(new Error(''), 'errors.drawingWorkerOperations.invalidSelectionBounds', {});
      const o = data.options ?? {};
      const output = withTiles(data.tiles, tiles => engineCall(g => g.floodMask(tiles, rectArray(data.bounds), o.x, o.y, o.tolerance ?? 16, o.gap ?? 0, data.source ? bytesOf(data.source) : undefined)));
      const state = output.number(0), r = rectOf(output.rect), mask = state === 2 ? {...r, mask: output.takeBytes()} : state === 1 ? null : undefined;
      output.free();
      post({id, mask}, mask ? [mask.mask.buffer] : []);
      return;
    }
    if (kind === 'filter') {
      const o = data.options ?? {}, blur = o.kind === 'blur';
      if (blur && !validRect(data.bounds)) throw messageError(new Error(''), 'errors.drawingPixels.invalidFilterBounds', {});
      const output = withTiles(data.tiles, tiles => engineCall(g => g.filter(tiles, rectArray(data.bounds), String(o.kind), o.radius ?? 4, o.hue ?? 0, o.saturation ?? 0, o.lightness ?? 0, o.brightness ?? 0, o.contrast ?? 0, maskIn(o.mask))));
      const tiles = changesOut(output);
      post({id, tiles}, transferOf(tiles));
      return;
    }
    if (kind === 'fill-mask') {
      const m = data.mask;
      if (!m || !validRect(m) || !(m.mask instanceof Uint8Array) || m.mask.length !== m.width * m.height) throw messageError(new Error(''), 'errors.drawingLasso.invalidSelectionMask', {});
      const output = withTiles(data.tiles, tiles => engineCall(g => g.fillMask(tiles, maskIn(m), Float64Array.from(data.color ?? []))));
      const tiles = changesOut(output);
      post({id, tiles}, transferOf(tiles));
      return;
    }
    if (kind === 'select') {
      const output = withTiles(data.tiles, tiles => engineCall(g => g.select(tiles, data.mask ? undefined : Float64Array.from((data.points ?? []).flatMap(p => [p.x, p.y])), maskIn(data.mask), data.maxBytes ?? TRANSFORM_BYTES)));
      const tiles = [];
      for (let i = 0; i < output.length; i++) {
        const full = output.flag(i), pixels = output.a(i), remaining = output.b(i);
        tiles.push({tx: output.tx(i), ty: output.ty(i), pixels: full ? null : pixels.buffer, alphaBounds: rectOf(output.alpha(i)) ?? null, full,
          remaining: remaining ? remaining.buffer : null, remainingBounds: rectOf(output.alpha2(i))});
      }
      output.free();
      post({id, tiles}, tiles.flatMap(t => [t.pixels, t.remaining].filter(Boolean)));
      return;
    }
    if (kind === 'copy-selection') {
      const output = withTiles(data.tiles, tiles => engineCall(g => g.copySelection(tiles, data.maxBytes ?? TRANSFORM_BYTES)), {png: true});
      const tiles = [];
      for (let i = 0; i < output.length; i++) tiles.push({tx: output.tx(i), ty: output.ty(i), png: output.text(i)});
      output.free();
      post({id, tiles});
      return;
    }
    if (kind === 'selection') {
      const s = data.selection ?? {};
      const output = withTiles(data.tiles, tiles => withTiles(s.tiles, source => engineCall(g => g.transformSelection(tiles, source, Float64Array.from(s.matrix ?? []), Boolean(s.remove), s.filter ?? 'smooth', s.maxBytes ?? TRANSFORM_BYTES))));
      const tiles = changesOut(output);
      post({id, tiles}, transferOf(tiles));
      return;
    }
    if (kind === 'paste') {
      const clip = JSON.stringify(data.clip ?? null);
      const output = withTiles(data.tiles, tiles => engineCall(g => g.paste(tiles, clip, Float64Array.from(data.matrix ?? []), data.filter ?? 'smooth', data.maxBytes ?? TRANSFORM_BYTES)));
      const tiles = changesOut(output);
      post({id, tiles}, transferOf(tiles));
      return;
    }
    if (kind === 'resample') {
      const output = withTiles(data.tiles, tiles => engineCall(g => g.resample(tiles, data.ratio, data.filter ?? 'smooth', data.maxBytes ?? TRANSFORM_BYTES)));
      const bounds = rectOf(output.rect), tiles = tilesOut(output).map(t => ({tx: t.tx, ty: t.ty, pixels: t.pixels.buffer, alphaBounds: t.alphaBounds}));
      output.free();
      post({id, tiles, bounds}, tiles.map(t => t.pixels));
      return;
    }
    if (kind === 'thumbnail') {
      const legacy = data.legacy ? drawingPNGBytes(data.legacy.url) : undefined, crop = data.legacy?.crop ?? {x: 0, y: 0};
      const blob = !legacy && data.url ? tileBlobBytes(data.url) : undefined;
      const source = !legacy && !blob ? tilesIn(data.tiles) : undefined;
      const output = engineCall(g => g.thumbnail(source, blob, legacy, crop.x, crop.y, data.bounds ? rectArray(data.bounds) : undefined));
      const bounds = rectOf(output.rect);
      if (!bounds) { output.free(); post({id, width: 1, height: 1, pixels: new Uint8ClampedArray(4).buffer}); return; }
      const pixels = new Uint8ClampedArray(output.takeBytes().buffer);
      output.free();
      const canvas = new OffscreenCanvas(bounds.width, bounds.height);
      canvas.getContext('2d').putImageData(new ImageData(pixels, bounds.width, bounds.height), 0, 0);
      const ratio = Math.min(64 / bounds.width, 32 / bounds.height), w = Math.max(1, Math.round(bounds.width * ratio)), h = Math.max(1, Math.round(bounds.height * ratio));
      const out = new OffscreenCanvas(w, h), ctx = out.getContext('2d');
      ctx.drawImage(canvas, 0, 0, w, h);
      const rgba = ctx.getImageData(0, 0, w, h).data;
      post({id, width: w, height: h, pixels: rgba.buffer}, [rgba.buffer]);
      return;
    }
    throw messageError(new Error(''), 'errors.drawingWorkerOperations.unknownDrawingWorkerOperation', {});
  } catch (error) { post({id, error: error.message, ...errorMessageData(error)}); }
}
