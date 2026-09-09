import {applySpriteColorKey, mediaImageFormat, preserveMediaBackground, MAX_MEDIA_BYTES} from './media-authoring.mjs';

const validateDimensions = (width, height, maxPixels) => {
  if (![width, height].every(value => Number.isInteger(value) && value > 0) || width * height > maxPixels)
    throw new Error(`Image dimensions must be positive and contain at most ${maxPixels.toLocaleString()} pixels.`);
};

// Native formats expose dimensions before decompression; reject oversized inputs
// before asking the browser to allocate their decoded image surfaces.
function validateHeaderDimensions(header, format, maxPixels) {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (format === 'png' && header.length >= 24)
    validateDimensions(view.getUint32(16), view.getUint32(20), maxPixels);
  else if (format === 'gif' && header.length >= 10)
    validateDimensions(view.getUint16(6, true), view.getUint16(8, true), maxPixels);
  else if (format === 'bmp' && header.length >= 26) {
    const core = view.getUint32(14, true) === 12;
    validateDimensions(core ? view.getUint16(18, true) : view.getInt32(18, true),
      core ? view.getUint16(20, true) : Math.abs(view.getInt32(22, true)), maxPixels);
  }
}

let started = false;
self.onmessage = async ({data}) => {
  if (started) return;
  started = true;
  let bitmap, surface;
  try {
    const {file, maxPixels, preserveOpaqueBackground} = data;
    if (!(file instanceof Blob) || !file.size || file.size > MAX_MEDIA_BYTES)
      throw new Error('Image files must contain 1 byte to 64 MB.');
    const header = new Uint8Array(await file.slice(0,32).arrayBuffer()), format = mediaImageFormat(header);
    if (!format) throw new Error('Choose a PNG, JPEG, GIF, BMP, or WebP image.');
    validateHeaderDimensions(header, format, maxPixels);
    try { bitmap = await createImageBitmap(file); }
    catch { throw new Error('The image could not be decoded. It may be damaged or unsupported.'); }
    const width = bitmap.width, height = bitmap.height;
    validateDimensions(width, height, maxPixels);
    const preserve = preserveMediaBackground(format, preserveOpaqueBackground);
    surface = new OffscreenCanvas(width, height);
    const context = surface.getContext('2d', {willReadFrequently: !preserve});
    if (!context) throw new Error('The image decoding canvas is unavailable.');
    context.drawImage(bitmap, 0, 0); bitmap.close(); bitmap = null;
    if (!preserve) {
      const pixels = context.getImageData(0, 0, width, height);
      if (applySpriteColorKey(pixels.data, width, height)) context.putImageData(pixels, 0, 0);
    }
    const png = await surface.convertToBlob({type: 'image/png'});
    if (png.size > MAX_MEDIA_BYTES) throw new Error('The decoded image exceeds the 64 MB embedded asset limit.');
    self.postMessage({ok: true, png, width, height});
  } catch (error) {
    self.postMessage({ok: false, error: error.message});
  } finally {
    bitmap?.close();
    if (surface) surface.width = surface.height = 1;
  }
};
