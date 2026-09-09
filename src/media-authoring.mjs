/** Portable image authoring. Results contain inline PNG bytes, never temporary URLs. */
export const DEFAULT_MEDIA_PIXELS = 16 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

const dimensions = (width, height, maxPixels = DEFAULT_MEDIA_PIXELS) => {
  if (![width, height].every(n => Number.isInteger(n) && n > 0) || width * height > maxPixels)
    throw new Error(`Image dimensions must be positive and contain at most ${maxPixels.toLocaleString()} pixels.`);
};
const pngURL = value => {
  if (typeof value !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error('Image assets require an embedded PNG data URL.');
  return value;
};
// PIV/STK definition and background names use Windows ANSI, unlike text objects.
// Preserve the original file name separately; choose an interchange-safe label.
const legacyName = (value, fallback) => String(value || fallback).replace(/\.[a-z\d]{2,5}$/i, '')
  .replace(/[\x00-\x1f\x7f]|[^\u0020-\u007e\u00a0-\u00ff\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178]/g, '_')
  .trim().slice(0, 180) || fallback;

/** Pure factory; pass the result directly to Editor.importFigure(). */
export function createImageFigure({dataUrl, width, height, name = 'Sprite', figureTypeId = 1, maxPixels} = {}) {
  dimensions(width, height, maxPixels); pngURL(dataUrl);
  if (!Number.isInteger(figureTypeId) || figureTypeId < 1) throw new Error('Figure ID must be positive.');
  const anchor_start = {x: Math.floor(width / 2), y: Math.floor(height / 2)};
  const anchor_length = Math.max(1, Math.ceil(width / 2));
  const asset = {kind: 'image', asset_index: 0, table_index: 0, mime_type: 'image/png',
    width, height, data_url: dataUrl, anchor_start,
    anchor_end: {x: anchor_start.x + anchor_length, y: anchor_start.y},
    anchor_length, anchor_angle_rad: 0};
  return {figure_type_id: figureTypeId, name: legacyName(name, 'Sprite'), segment_count: 1,
    segments: [{segment_id: 1, parent_id: 0, length: anchor_length, angle_rad: 0,
      thickness: 0, bend_rad: 0, primitive_code: 2, aux_code: 0, flags: 2,
      segment_type: 'image', segment_kind: 'image', color_rgb: [0, 0, 0],
      transparency: 0, extra_u16: 0, extra_u8_a: 0, extra_u8_b: 0,
      extra: [0, 0, 0], visible: true, z_order: 1}],
    polyfills: [], image_assets: [asset], text_assets: [], _styk: {sourceName: String(name)}};
}

/** Pure factory; the editor assigns a unique background_id before committing. */
export function createImageBackground({dataUrl, width, height, name = 'Background', backgroundId = 1, maxPixels} = {}) {
  dimensions(width, height, maxPixels); pngURL(dataUrl);
  if (!Number.isInteger(backgroundId) || backgroundId < 1) throw new Error('Background ID must be positive.');
  return {background_id: backgroundId, name: legacyName(name, 'Background'), kind: 1,
    mime_type: 'image/png', width, height, data_url: dataUrl, _styk: {sourceName: String(name)}};
}

/** Native Pivot sprite color-key behavior: existing alpha wins over color key. */
export function applySpriteColorKey(rgba, width, height) {
  dimensions(width, height, Number.MAX_SAFE_INTEGER);
  if (!(rgba instanceof Uint8ClampedArray || rgba instanceof Uint8Array) || rgba.length !== width * height * 4)
    throw new Error('Sprite pixels must contain exactly four bytes per pixel.');
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return false;
  const key = (height - 1) * width * 4, r = rgba[key], g = rgba[key + 1], b = rgba[key + 2];
  let changed = false;
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i] === r && rgba[i + 1] === g && rgba[i + 2] === b) {
    rgba[i + 3] = 0; changed = true;
  }
  return changed;
}

function readDataURL(blob, signal) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(), abort = () => reader.abort();
    const finish = (error, result) => {
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    reader.onload = () => finish(null, reader.result);
    reader.onerror = () => finish(reader.error || new Error('The image bytes could not be read.'));
    reader.onabort = () => finish(new DOMException('Image import cancelled.', 'AbortError'));
    if (signal?.aborted) return finish(new DOMException('Image import cancelled.', 'AbortError'));
    signal?.addEventListener('abort', abort, {once: true});
    reader.readAsDataURL(blob);
  });
}

/** Classify source bytes, not a user-controlled extension or MIME label. */
export function mediaImageFormat(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('Image signature must be bytes.');
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((value,index) => bytes[index] === value)) return 'png';
  if (bytes.length >= 6 && [71,73,70,56].every((value,index) => bytes[index] === value) && [55,57].includes(bytes[4]) && bytes[5] === 97) return 'gif';
  if (bytes.length >= 2 && bytes[0] === 66 && bytes[1] === 77) return 'bmp';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0,4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8,12)) === 'WEBP') return 'webp';
  return null;
}

/** Native sprite formats use bottom-left color only when source alpha is absent.
 * Extra JPEG/WebP support preserves the image unless callers explicitly opt in.
 */
export function preserveMediaBackground(format, explicit) {
  if (explicit !== undefined && typeof explicit !== 'boolean') throw new Error('Image transparency option must be true or false.');
  return explicit ?? !['png', 'gif', 'bmp'].includes(format);
}

async function decodeImage(file, {maxPixels = DEFAULT_MEDIA_PIXELS, preserveOpaqueBackground, signal} = {}) {
  if (!file || typeof file.arrayBuffer !== 'function' || !Number.isFinite(file.size))
    throw new Error('Choose an image file.');
  if (!file.size || file.size > MAX_MEDIA_BYTES) throw new Error('Image files must contain 1 byte to 64 MB.');
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1) throw new Error('Image pixel limit must be a positive whole number.');
  preserveMediaBackground(null, preserveOpaqueBackground);
  const extension = /\.(png|jpe?g|gif|bmp|webp)$/i.test(file.name || '');
  if (!/^image\/(png|jpeg|gif|bmp|x-ms-bmp|webp)$/i.test(file.type || '') && !extension)
    throw new Error('Choose a PNG, JPEG, GIF, BMP, or WebP image.');
  if (signal?.aborted) throw new DOMException('Image import cancelled.', 'AbortError');
  if (typeof Worker === 'undefined') throw new Error('Image decoding workers are unavailable in this app.');
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./media-image-worker.mjs', import.meta.url), {type: 'module', name: 'StykAnimate image import'});
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); worker.terminate(); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(new DOMException('Image import cancelled.', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Image decoding timed out.')), 120000);
    worker.addEventListener('message', ({data}) => {
      if (!data.ok) return finish(new Error(data.error || 'The image could not be decoded.'));
      if (!(data.png instanceof Blob) || data.png.type !== 'image/png' || data.png.size > MAX_MEDIA_BYTES)
        return finish(new Error('The decoded image exceeds the embedded asset limit.'));
      try { dimensions(data.width, data.height, maxPixels); }
      catch (error) { return finish(error); }
      finish(null, data);
    });
    worker.addEventListener('error', event => { event.preventDefault(); finish(new Error(event.message || 'The image decoding worker stopped.')); });
    worker.addEventListener('messageerror', () => finish(new Error('The decoded image could not be transferred.')));
    signal?.addEventListener('abort', abort, {once: true});
    try { worker.postMessage({file, maxPixels, preserveOpaqueBackground}); }
    catch (error) { finish(error); }
  });
  return {dataUrl: await readDataURL(result.png, signal), width: result.width, height: result.height, maxPixels};
}

/** PNG/JPEG/GIF/BMP/WebP import. Animated image inputs become a single still sprite. */
export async function imageFileToFigure(file, options = {}) {
  const image = await decodeImage(file, options);
  return createImageFigure({...image, name: options.name || file.name || 'Sprite', figureTypeId: options.figureTypeId || 1});
}

export async function imageFileToBackground(file, options = {}) {
  const image = await decodeImage(file, {...options, preserveOpaqueBackground: true});
  return createImageBackground({...image, name: options.name || file.name || 'Background', backgroundId: options.backgroundId || 1});
}
