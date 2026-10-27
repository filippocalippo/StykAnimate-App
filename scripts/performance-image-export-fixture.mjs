/** Actual render/encode routes, callable through the collaborative preview. */
import {exportAnimation} from '../src/image-export.mjs';
import {pageExporter} from '../tests/support/page-export.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {crc32} from '../src/image-codecs.mjs';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
async function sourceHashes() {
  const files = ['image-export.mjs', 'image-export-worker.mjs', 'image-codecs.mjs',
    'engine/engine-export.mjs', 'engine/engine-export-worker.mjs'];
  const hashes = {};
  for (const file of files) {
    const response = await fetch(`/src/${file}`, {cache: 'no-store'});
    assert(response.ok, `Could not read ${file}`);
    const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
    hashes[file] = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return hashes;
}
const summary = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return {medianMs: sorted[Math.floor(sorted.length / 2)], samples: values};
};
function zipFrames(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), frames = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + view.getUint16(offset + 28, true), content = bytes.subarray(start, start + size);
    assert(crc32(content) === view.getUint32(offset + 14, true), `ZIP checksum mismatch: ${name}`);
    if (name.endsWith('.png')) frames.push(content);
    offset = start + size;
  }
  return frames;
}
async function pixelFrames(blob, format, width, height, count) {
  const bytes = new Uint8Array(await blob.arrayBuffer()), frames = [];
  const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
  if (format === 'apng') {
    const decoder = new ImageDecoder({data: bytes, type: 'image/png', preferAnimation: true});
    try {
      await decoder.tracks.ready;
      assert(decoder.tracks.selectedTrack.frameCount === count, 'APNG frame count changed');
      for (let frameIndex = 0; frameIndex < count; frameIndex++) {
        const {image} = await decoder.decode({frameIndex});
        try {context.clearRect(0, 0, width, height); context.drawImage(image, 0, 0);
          frames.push(context.getImageData(0, 0, width, height).data);} finally {image.close();}
      }
    } finally {decoder.close();}
  } else {
    const encoded = zipFrames(bytes);
    assert(encoded.length === count, 'PNG sequence frame count changed');
    for (const png of encoded) {
      const bitmap = await createImageBitmap(new Blob([png], {type: 'image/png'}));
      try {context.clearRect(0, 0, width, height); context.drawImage(bitmap, 0, 0);
        frames.push(context.getImageData(0, 0, width, height).data);} finally {bitmap.close();}
    }
  }
  canvas.width = canvas.height = 1;
  return frames;
}

export async function imageExportCase({format = 'apng', width = 960, height = 540, count = 6, passes = 4} = {}) {
  const sourceHashesBefore = await sourceHashes();
  const report = emptyDocument(); report.canvas_width = width; report.canvas_height = height;
  const objects = Array.from({length: 80}, (_, i) => createObject(report.figure_types[0], i + 1,
    20 + (i % 16) * width / 16, 50 + Math.floor(i / 16) * height / 5, {scale: .4}));
  assert(count >= 2, 'The measured animation needs at least two ticks');
  report.keyframes = [createFrame(objects, count - 1), createFrame(structuredClone(objects), 1)];
  const renderer = pageExporter({width, height});
  const rows = [], output = new Map();
  try {
    await renderer.load(report);
    for (let pass = 0; pass < passes; pass++) {
      for (const mode of pass % 2 ? ['direct-png', 'canvas'] : ['canvas', 'direct-png']) {
        const start = performance.now();
        const blob = await exportAnimation({format, width, height, fps: 24, totalFrames: count,
          renderFrame: index => renderer.renderTick(index),
          ...(mode === 'direct-png' ? {renderPNGFrame: index => renderer.renderNativeTick(index, {preserveAlpha: true})} : {})});
        rows.push({pass, mode, elapsedMs: performance.now() - start, bytes: blob.size,
          presentationSize: [renderer.canvas.width, renderer.canvas.height]});
        output.set(mode, blob);
      }
    }
    const before = await pixelFrames(output.get('canvas'), format, width, height, count);
    const after = await pixelFrames(output.get('direct-png'), format, width, height, count);
    let differingChannels = 0, maxChannelDifference = 0;
    for (let f = 0; f < count; f++) for (let i = 0; i < before[f].length; i++) {
      const difference = Math.abs(before[f][i] - after[f][i]);
      if (difference) differingChannels++;
      maxChannelDifference = Math.max(maxChannelDifference, difference);
    }
    assert(!differingChannels, `Pixel mismatch: ${differingChannels} channels, max ${maxChannelDifference}`);
    const fresh = pageExporter({width, height});
    let freshPresentationSize;
    try {
      await fresh.load(report);
      await exportAnimation({format, width, height, fps: 24, totalFrames: count,
        renderPNGFrame: index => fresh.renderNativeTick(index, {preserveAlpha: true})});
      freshPresentationSize = [fresh.canvas.width, fresh.canvas.height];
      assert(freshPresentationSize.every(value => value === 1), 'Direct PNG export allocated a presentation surface');
    } finally {fresh.dispose();}
    const sourceHashesAfter = await sourceHashes();
    assert(JSON.stringify(sourceHashesBefore) === JSON.stringify(sourceHashesAfter), 'Export source changed during timing');
    return {format, width, height, count, rows, exactPixels: true, freshPresentationSize, sourceHashesBefore, sourceHashesAfter,
      summary: Object.fromEntries(['canvas', 'direct-png'].map(mode => [mode, summary(rows.filter(r => r.mode === mode && r.pass > 0).map(r => r.elapsedMs))])),
      userAgent: navigator.userAgent,
      limitations: ['80 synthetic vector figures; warmed render session, fresh encoding worker per export.',
        'Includes rendering, worker PNG/bitmap transfers and container encoding; excludes document load and file writing.',
        'First pair discarded; remaining pairs counterbalanced. No claim for GIF/JPEG/video or other GPUs.']};
  } finally {renderer.dispose();}
}

export async function imageExportPNGChecks() {
  const width = 8, height = 8, canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
  const renderPNGFrame = async index => {
    context.clearRect(0, 0, width, height); context.fillStyle = index ? '#0000ff80' : '#ff0000'; context.fillRect(1, 1, 6, 6);
    return {width, height, blob: await canvas.convertToBlob({type: 'image/png'})};
  };
  const options = {width, height, fps: 24, totalFrames: 2, renderPNGFrame};
  const reports = [];
  for (const format of ['apng', 'png-sequence']) {
    const parts = [], sink = {streamed: true, async write(blob) {parts.push(blob);},
      async finish() {return new Blob(parts);}, async abort() {this.aborted = true;}};
    const blob = await exportAnimation({...options, format, sink});
    const frames = await pixelFrames(blob, format, width, height, 2);
    assert(frames[0][0] === 0 && frames[0][3] === 0 && frames[1][3] === 0, 'Transparent corners lost');
    const pixel = (2 * width + 2) * 4;
    assert(frames[0][pixel] === 255 && frames[0][pixel + 3] === 255, 'First frame pixels changed');
    assert(frames[1][pixel + 2] === 255 && frames[1][pixel + 3] === 128, 'Partial alpha changed');
    const controller = new AbortController(); let cancelled = false;
    try {await exportAnimation({...options, format, signal: controller.signal,
      onProgress() {controller.abort();}});} catch (error) {cancelled = error.name === 'AbortError';}
    assert(cancelled, 'Direct PNG cancellation failed');
    let malformedRejected = false;
    try {await exportAnimation({...options, format, renderPNGFrame: () => ({width, height, blob: new Blob(['invalid PNG'], {type: 'image/png'})})});}
    catch {malformedRejected = true;}
    assert(malformedRejected, 'Malformed PNG reached finished export');
    reports.push({format, streamedPixelAlphaParity: true, cancelled, malformedRejected, outputBytes: blob.size});
  }
  canvas.width = canvas.height = 1;
  return reports;
}
