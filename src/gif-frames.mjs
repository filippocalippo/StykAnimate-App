import {restoreMessageError} from './localized-error.mjs';
import {changedRect, mapGIFPixels, pixelWords} from './gif-quantize.mjs';
import {lzw} from './image-codecs.mjs';
/**
 * The second pass of an animated GIF spread over helper workers (gif-encode-worker.mjs), written in order into one
 * GIFEncoder (docs/gif-export.md "Encoding on several threads").
 *
 * Without dithering a pixel's palette index is a function of the pixel alone, so the index a pixel outside a frame's
 * changed rectangle keeps from the frame before is the one it would get anew: every frame is mapped and compressed
 * whole by whichever helper is free, and the bytes are those of the encoder going frame by frame. With dithering, the
 * error spread inside a changed rectangle depends on nothing outside it: a helper dithers the rectangle alone, and
 * the frames are then put together in order here (the rectangle over the indices of the frame before) and compressed.
 *
 * At most two frames per helper are in flight; `push` waits for room. A helper's failure fails the next call.
 */
export class GIFFrames {
  constructor(encoder, plan, {width, height, dither, helpers}) {
    Object.assign(this, {encoder, width, height, plan});
    // An exact palette maps without dithering (mapGIFPixels).
    this.whole = !dither || Boolean(plan.exact);
    this.helpers = helpers;
    this.capacity = helpers.length * 2;
    this.sequence = 0;
    this.next = 0;
    this.done = new Map();
    this.waiting = new Map();
    this.busy = new Map(helpers.map((helper) => [helper, 0]));
    this.room = null;
    this.failure = null;
    const clean = {palette: plan.palette, colors: plan.colors, exact: plan.exact};
    for (const helper of helpers) {
      helper.onmessage = ({data}) => this._answer(helper, data);
      helper.onerror = (event) => { event.preventDefault?.(); this._fail(new Error(event.message || 'A GIF encoding helper stopped.')); };
      helper.postMessage({operation: 'plan', plan: clean, dither: !this.whole});
    }
    this.indices = null;
    this.previous = null;
  }
  get inFlight() {
    return this.sequence - this.next;
  }
  _check() {
    if (this.failure) throw this.failure;
  }
  _fail(error) {
    this.failure ??= error;
    this.room?.();
  }
  _answer(helper, data) {
    this.busy.set(helper, this.busy.get(helper) - 1);
    if (!data.ok) return this._fail(restoreMessageError(new Error(data.error || 'GIF encoding failed.'), data));
    const job = this.waiting.get(data.id);
    this.waiting.delete(data.id);
    this.done.set(job.index, {...job, ...data});
    try {
      for (let ready; (ready = this.done.get(this.next)); this.next++) {
        this.done.delete(this.next);
        this._write(ready);
      }
    } catch (error) {
      return this._fail(error);
    }
    this.room?.();
  }
  /** Frame `job.index`, the frames before it written. */
  _write(job) {
    if (this.whole) return this.encoder.addCompressed(job.data);
    const {width} = this;
    if (job.rect) {
      const {left, top, right, bottom} = job.rect, span = right - left + 1;
      for (let y = top; y <= bottom; y++) this.indices.set(job.pixels.subarray((y - top) * span, (y - top + 1) * span), y * width + left);
    }
    this.encoder.addCompressed(lzw(this.indices));
  }
  _helper() {
    let best = this.helpers[0];
    for (const helper of this.helpers) if (this.busy.get(helper) < this.busy.get(best)) best = helper;
    return best;
  }
  /** Queues `rgba`, the next frame (the queue owns it), and resolves once another frame may be pushed. */
  async push(rgba) {
    this._check();
    const index = this.sequence++, id = index, helper = this._helper();
    let message, transfer;
    if (this.whole) {
      message = {id, operation: 'frame', rgba, width: this.width, compress: true};
      transfer = [rgba.buffer];
    } else {
      // The rectangle that changed from the frame before (all of the first frame), cut out and dithered alone.
      const {width, height} = this, words = pixelWords(rgba);
      const rect = this.previous ? changedRect(words, this.previous, width, height) : {left: 0, top: 0, right: width - 1, bottom: height - 1};
      this.previous = words;
      this.indices ??= new Uint8Array(width * height);
      if (!rect) {
        this.waiting.set(id, {index, rect: null});
        this.busy.set(helper, this.busy.get(helper) + 1);
        // Nothing changed: the frame is the one before, written in its turn.
        queueMicrotask(() => this._answer(helper, {id, ok: true}));
        return this._room();
      }
      const span = rect.right - rect.left + 1, region = new Uint8ClampedArray(span * (rect.bottom - rect.top + 1) * 4);
      for (let y = rect.top; y <= rect.bottom; y++) region.set(rgba.subarray((y * width + rect.left) * 4, (y * width + rect.right + 1) * 4), (y - rect.top) * span * 4);
      message = {id, operation: 'frame', rgba: region, width: span, compress: false};
      transfer = [region.buffer];
      this.waiting.set(id, {index, rect});
      this.busy.set(helper, this.busy.get(helper) + 1);
      helper.postMessage(message, transfer);
      return this._room();
    }
    this.waiting.set(id, {index});
    this.busy.set(helper, this.busy.get(helper) + 1);
    helper.postMessage(message, transfer);
    return this._room();
  }
  async _room() {
    while (!this.failure && this.inFlight >= this.capacity) await new Promise((resolve) => { this.room = resolve; });
    this.room = null;
    this._check();
  }
  /** Resolves once every pushed frame is written. */
  async flush() {
    while (!this.failure && this.inFlight > 0) await new Promise((resolve) => { this.room = resolve; });
    this.room = null;
    this._check();
  }
  /** Ends the helpers. */
  close() {
    for (const helper of this.helpers) helper.terminate();
    this.helpers = [];
  }
}

/** Starts `count` helper workers for an animated GIF's second pass. */
export function gifHelpers(count) {
  return Array.from({length: count}, () => new Worker(new URL('./gif-encode-worker.mjs', import.meta.url), {type: 'module', name: 'StykAnimate GIF encoding'}));
}


/** What a helper answers for `message` (a frame or a changed rectangle): {data}, its compressed indices, or {pixels}. */
export function helperFrame(plan, dither, message) {
  if (!plan) throw new Error('The GIF palette was not sent.');
  const {pixels} = mapGIFPixels(message.rgba, message.width, plan, {dither});
  return message.compress ? {data: lzw(pixels)} : {pixels};
}
