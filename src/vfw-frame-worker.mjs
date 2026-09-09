import {rgbaToVfwBgr24} from './vfw-pixels.mjs';
let canvas, context;
self.addEventListener('message', ({data}) => {
  try {
    if (data.operation === 'start') {
      canvas = new OffscreenCanvas(data.width, data.height); context = canvas.getContext('2d', {willReadFrequently: true});
      if (!context) throw new Error('The Windows video frame canvas is unavailable.');
      self.postMessage({id: data.id, ok: true}); return;
    }
    if (data.operation !== 'frame' || !context) throw new Error('The Windows video frame converter was not initialized.');
    try {
      if (data.bitmap.width !== canvas.width || data.bitmap.height !== canvas.height) throw new Error('The Windows video frame size changed.');
      context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(data.bitmap, 0, 0);
    } finally { data.bitmap?.close(); }
    const {bytes} = rgbaToVfwBgr24(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    self.postMessage({id: data.id, ok: true, blob: new Blob([bytes], {type: 'application/octet-stream'})});
  } catch (error) { self.postMessage({id: data.id, ok: false, error: error?.message || String(error)}); }
});
