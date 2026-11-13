import {errorMessageData} from './localized-error.mjs';
import {helperFrame} from './gif-frames.mjs';
/**
 * A helper of an animated GIF's second pass (gif-frames.mjs): maps frames to the animation's palette and, for a frame
 * mapped whole, compresses it. One request at a time, in the order they come.
 */
let plan = null, dither = false;
self.addEventListener('message', ({data: message}) => {
  if (message.operation === 'plan') {
    ({plan, dither} = message);
    return;
  }
  try {
    const answer = helperFrame(plan, dither, message);
    self.postMessage({id: message.id, ok: true, ...answer}, [(answer.data ?? answer.pixels).buffer]);
  } catch (error) {
    self.postMessage({id: message.id, ok: false, error: error?.message || String(error), ...errorMessageData(error)});
  }
});
