/** Snapshot and PNG-compress one video frame off the UI thread. */
let canvas, context, preserveAlpha;
self.addEventListener('message', async ({data}) => {
  try {
    if (data.operation === 'start') {
      preserveAlpha = data.preserveAlpha === true;
      canvas = new OffscreenCanvas(data.width, data.height); context = canvas.getContext('2d');
      if (!context) throw new Error('The video frame canvas is unavailable.');
      self.postMessage({id: data.id, ok: true}); return;
    }
    if (data.operation !== 'frame' || !context) throw new Error('The video frame encoder was not initialized.');
    try {
      if (data.bitmap.width !== canvas.width || data.bitmap.height !== canvas.height) throw new Error('The video frame dimensions changed.');
      // Pivot uses black behind transparent areas in video formats without alpha.
      // Native WebM keeps the original RGBA pixels for its separate alpha plane.
      context.clearRect(0,0,canvas.width,canvas.height);
      if (!preserveAlpha) { context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height); }
      context.drawImage(data.bitmap, 0, 0);
    } finally { data.bitmap?.close(); }
    const blob = await canvas.convertToBlob({type: 'image/png'});
    if (blob.type !== 'image/png') throw new Error('Lossless video frame encoding is unavailable.');
    self.postMessage({id: data.id, ok: true, blob});
  } catch (error) { self.postMessage({id: data.id, ok: false, error: error?.message || String(error)}); }
});
