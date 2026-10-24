/** Wheel zoom for the editing canvas that glides to its target.
 *
 * A mouse wheel reports whole notches, so applying each one at once makes the view
 * jump. Notches instead move a target zoom, and the view eases toward it over the
 * next few frames, staying anchored at the pointer. Further notches during the glide
 * move the target, so fast scrolling stays continuous and loses nothing.
 *
 * Small deltas come from devices that are already continuous (a trackpad pinch, a
 * free-spinning wheel); they are applied directly so the view tracks the fingers.
 *
 * With smooth zooming off, each notch applies its whole step at once: one repaint
 * per notch instead of one per frame of a glide. The step is the same either way,
 * so turning smoothing off changes how the view moves, never how far a notch zooms.
 *
 * The owner advances the glide from its frame loop and applies each step through
 * `zoomBy(factor, point)`, the same anchored zoom every other control uses.
 */
const PRECISE_GAIN = 0.005;    // zoom (log scale) per pixel of a continuous device
const NOTCH_GAIN = 0.003;      // per pixel of a wheel notch: about 1.35x for a 100 px notch
const PRECISE_DELTA = 30;      // below this an event is continuous input, not a notch
const TIME_CONSTANT_MS = 40;   // the glide covers about 90% of its distance in 90 ms
const FIRST_STEP_MS = 16;      // the wheel event itself moves the view one frame's worth
const LONGEST_STEP_MS = 64;    // a stalled frame does not finish the glide in one jump
const SETTLED = 0.004;         // remaining zoom (log scale) too small to see: land exactly
const INPUT_IDLE_MS = 100;    // continuous input also needs a final detail paint

/** Whether wheel notches glide. `setting` is Settings → Canvas → Smooth zooming;
 * Automatic glides except on the WebGL2 backend (Compatibility mode), whose slower repaints make each
 * extra frame of a glide costly in dense scenes. */
export function smoothWheelZoom(setting, backend) {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return backend !== 'WebGL2';
}

/** The zoom (log scale) one wheel event asks for; monotonic in the delta across both kinds of device. */
export function wheelZoomAmount(deltaY) {
  const size = Math.abs(deltaY);
  return -Math.sign(deltaY) * Math.max(Math.min(size, PRECISE_DELTA) * PRECISE_GAIN, size * NOTCH_GAIN);
}

export function createWheelZoom({getScale, zoomBy, min = 0.001, max = 100, smooth = () => true, reducedMotion = () => false, onSettled = () => {}}) {
  let target = null, point = null, applied = 0, last = 0, idleTimer = null;

  const stop = () => { const active=target!==null;target = null;if(active&&idleTimer===null)onSettled(); };
  const cancel = () => {
    const active=target!==null||idleTimer!==null;
    clearTimeout(idleTimer);idleTimer=null;target=null;
    if(active)onSettled();
  };
  const step = elapsed => {
    const scale = getScale(), remaining = Math.log(target / scale), left = Math.exp(-elapsed / TIME_CONSTANT_MS);
    const settled = Math.abs(remaining) * left < SETTLED;
    zoomBy(settled ? target / scale : Math.exp(remaining * (1 - left)), point);
    applied = getScale();
    if (settled) stop();
  };
  // Fit, the zoom buttons or a pinch changed the zoom since the last step: the glide no longer applies.
  const overridden = () => target !== null && getScale() !== applied;

  return {
    get active() { return target !== null; },
    get interacting() { return target !== null || idleTimer !== null; },
    cancel,
    /** A wheel event at `at` (viewport coordinates); `now` is on the same clock as `advance`. */
    wheel(deltaY, at, now) {
      if (overridden()) cancel();
      clearTimeout(idleTimer);
      idleTimer=setTimeout(()=>{idleTimer=null;if(target===null)onSettled();},INPUT_IDLE_MS);
      const scale = getScale();
      target = Math.min(max, Math.max(min, (target ?? scale) * Math.exp(wheelZoomAmount(deltaY))));
      point = at;
      if (Math.abs(deltaY) < PRECISE_DELTA || !smooth() || reducedMotion()) {
        zoomBy(target / scale, point);
        stop();
        return;
      }
      last = now;
      step(FIRST_STEP_MS);
    },
    /** Moves the view one frame closer to the target. Returns whether the glide continues. */
    advance(now) {
      if (target === null) return false;
      if (overridden()) { cancel(); return false; }
      step(Math.min(LONGEST_STEP_MS, Math.max(0, now - last)));
      last = now;
      return target !== null;
    },
  };
}
