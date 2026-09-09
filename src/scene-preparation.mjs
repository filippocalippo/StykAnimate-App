import {sceneBackgroundColor} from './pivot/background.mjs';

export function backgroundImageAssets(report, frame) {
  if (frame && sceneBackgroundColor(report, frame) !== undefined) return [];
  const ids = frame ? new Set([Number(frame.background_id || 0), ...(frame.background_mix ? [Number(frame.background_id_b || 0)] : [])]) : null;
  return (report.backgrounds || []).filter(asset => (!ids || ids.has(Number(asset.background_id))) && ![2, 3, 4].includes(asset.kind) && asset.color === undefined);
}

export function frameImageAssets(geometry) {
  const assets = new Set();
  for (const group of geometry.orderedObjects || []) for (const item of group.drawables) {
    if (item.type === 'image' && item.asset) assets.add(item.asset);
  }
  return [...assets];
}

/** A private image set. Incoming loads cannot clear or invalidate the live scene. */
export function createSceneImages({url, signal, checkCurrent = () => {}, imageFactory = () => new Image()} = {}) {
  const images = new Map(), pending = new Map(), cancelWaits = new Set(); let disposed = false;
  const check = () => {
    if (disposed || signal?.aborted) throw new DOMException('Scene preparation cancelled.', 'AbortError');
    checkCurrent();
  };
  // A model revision guard can change without an AbortSignal. Keep a stalled
  // decode cancellable in that path too; settled loads leave no timer/listener.
  const waitForDecode = decoded => new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); cancelWaits.delete(cancel);
      signal?.removeEventListener('abort', cancel); callback(value);
    };
    const cancel = () => finish(reject, new DOMException('Scene preparation cancelled.', 'AbortError'));
    const poll = () => {
      try {check(); timer = setTimeout(poll, 50);}
      catch (error) {finish(reject, error);}
    };
    cancelWaits.add(cancel); signal?.addEventListener('abort', cancel, {once: true});
    Promise.resolve(decoded).then(value => finish(resolve, value), error => finish(reject, error));
    poll();
  });
  const loadOne = asset => {
    check(); const address = url(asset);
    if (!address) return Promise.reject(new Error('An initial-frame image has no readable asset.'));
    if (pending.has(address)) return pending.get(address);
    const image = imageFactory(); image.decoding = 'async'; images.set(address, image);
    const promise = (async () => {
      image.src = address;
      await waitForDecode(image.complete ? Promise.resolve() : image.decode());
      check();
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('An initial-frame image could not be decoded.');
    })();
    pending.set(address, promise); return promise;
  };
  return {images, check,
    resources: {url, image: address => images.get(address) || null},
    async load(assets) {
      let next = 0;
      await Promise.all(Array.from({length: Math.min(4, assets.length)}, async () => {
        while (next < assets.length) {check(); await loadOne(assets[next++]);}
      }));
    },
    dispose() {
      disposed = true;
      for (const cancel of cancelWaits) cancel();
      for (const image of images.values()) if (!image.complete) image.src = '';
      images.clear(); pending.clear();
    },
  };
}

export const yieldSceneTask = globalThis.scheduler?.yield ? () => scheduler.yield() : () => new Promise(resolve => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {channel.port1.close(); channel.port2.close(); resolve();};
  channel.port2.postMessage(null);
});

export async function consumeSceneSteps(iterator, {sliceMs = 4, signal, checkCurrent = () => {}, yieldControl = yieldSceneTask, onProgress} = {}) {
  if (!Number.isFinite(sliceMs) || sliceMs <= 0 || sliceMs > 16) throw new RangeError('Scene preparation slices must be greater than zero and at most 16 ms.');
  const check = () => {if (signal?.aborted) throw new DOMException('Scene preparation cancelled.', 'AbortError'); checkCurrent();};
  const timings = {slices: 0, workMs: 0, maxSliceMs: 0};
  try {
    for (;;) {
      check(); const started = performance.now(); let step;
      do {step = iterator.next();} while (!step.done && performance.now() - started < sliceMs);
      const elapsed = performance.now() - started;
      timings.slices++; timings.workMs += elapsed; timings.maxSliceMs = Math.max(timings.maxSliceMs, elapsed);
      check(); if (step.done) return {value: step.value, timings};
      onProgress?.(step.value); check(); await yieldControl();
    }
  } finally {iterator.return?.();}
}
