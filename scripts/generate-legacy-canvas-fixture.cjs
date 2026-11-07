// Measures today's canvas step on every colour and alpha level and writes it as a fixture:
//   node_modules/electron/dist/electron.exe scripts/generate-legacy-canvas-fixture.cjs
//
// The export worker puts each frame's straight RGBA into a willReadFrequently 2d OffscreenCanvas with putImageData and
// encodes it with convertToBlob('image/png') (src/engine/engine-export-worker.mjs, src/export-canvas.mjs). The canvas
// stores premultiplied colour, so a translucent pixel comes out of the PNG with a different colour. The native WebM
// path applies the same mapping to keep today's bytes; this fixture is what it is held to:
//   engine/crates/styk-export/src/legacy_canvas.bin   65,536 bytes, index alpha * 256 + colour -> colour out
// The measurement runs twice (a second image with the three channels spread differently) and fails if the mapping is not
// a function of one channel and the alpha alone. Needs no window: the page is never shown.
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function decodePng(buffer) {
  let at = 8, width = 0, height = 0; const idat = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at), type = buffer.toString('latin1', at + 4, at + 8), body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error('expected 8-bit RGBA, not interlaced'); }
    if (type === 'IDAT') idat.push(body);
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = width * 4, out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = out.subarray(y * stride, (y + 1) * stride), up = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? row[x - 4] : 0, upLeft = x >= 4 ? up[x - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left; else if (filter === 2) predictor = up[x]; else if (filter === 3) predictor = (left + up[x]) >> 1;
      else if (filter === 4) { const p = left + up[x] - upLeft, pa = Math.abs(p - left), pb = Math.abs(p - up[x]), pc = Math.abs(p - upLeft); predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up[x] : upLeft; }
      row[x] = (line[x] + predictor) & 255;
    }
  }
  return {width, height, data: out};
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({show: false});
  await win.loadURL('data:text/html,<html></html>');
  const run = mode => win.webContents.executeJavaScript(`(async () => {
    const w = 256, h = 256, data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4; // x: colour, y: alpha
      const spread = ${mode};
      data[i] = spread ? (x * 3 + y) & 255 : x; data[i + 1] = spread ? (255 - x + 3 * y) & 255 : x; data[i + 2] = spread ? (x * 7 + y * 13) & 255 : x; data[i + 3] = y;
    }
    const canvas = new OffscreenCanvas(w, h), context = canvas.getContext('2d', {willReadFrequently: true});
    context.putImageData(new ImageData(data, w, h), 0, 0);
    const blob = await canvas.convertToBlob({type: 'image/png'}), bytes = new Uint8Array(await blob.arrayBuffer());
    let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return [btoa(text), btoa(String.fromCharCode(...data.subarray(0, 0)))][0];
  })()`);
  const plain = decodePng(Buffer.from(await run(false), 'base64')), spread = decodePng(Buffer.from(await run(true), 'base64'));
  const table = Buffer.alloc(65536);
  for (let a = 0; a < 256; a++) for (let c = 0; c < 256; c++) {
    table[a * 256 + c] = plain.data[(a * 256 + c) * 4];
    for (let channel = 0; channel < 3; channel++) if (plain.data[(a * 256 + c) * 4 + channel] !== table[a * 256 + c]) throw new Error(`channel ${channel} differs at alpha ${a} colour ${c}`);
    if (plain.data[(a * 256 + c) * 4 + 3] !== a) throw new Error(`alpha changed at ${a}`);
  }
  let checked = 0;
  for (let a = 0; a < 256; a++) for (let x = 0; x < 256; x++) {
    const src = [(x * 3 + a) & 255, (255 - x + 3 * a) & 255, (x * 7 + a * 13) & 255];
    for (let channel = 0; channel < 3; channel++, checked++)
      if (spread.data[(a * 256 + x) * 4 + channel] !== table[a * 256 + src[channel]]) throw new Error(`the mapping is not per channel at alpha ${a}`);
  }
  const target = path.resolve(__dirname, '../engine/crates/styk-export/src/legacy_canvas.bin');
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, table);
  console.log(`wrote ${target} (${table.length} bytes); ${checked} channel values of a second image agree`);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
setTimeout(() => app.exit(2), 60000).unref();
