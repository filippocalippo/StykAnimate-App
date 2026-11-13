/**
 * How long one action of a person takes to show (an operation scenario's `duration`): from the page receiving the
 * input to the frame that shows its result.
 *
 * A capture's `input.p95` ends at the frame after the input's handler, which is the answer only when the handler
 * itself changes what is shown. A menu that opens, a panel that closes or an edit the stage repaints for may show a
 * frame or more later, so an operation waits for its own sign: `shown`, a test of the page that turns true when the
 * result is there. Both times are the page's clock, so the round trips to the runner do not count.
 */

/** The page side: waits on animation frames until `shown(argument)` holds, then for the frame after (when the change reached the screen). */
const WAITER = async (shown, argument, timeoutMs) => {
  const box = globalThis.__stykPerfResponse, frame = () => new Promise(resolve => requestAnimationFrame(resolve)), deadline = performance.now() + timeoutMs;
  try {
    for (;;) {
      await frame();
      if (shown(argument)) break;
      if (performance.now() > deadline) return {timedOut: true, inputAt: box?.at ?? null};
    }
    // A test that turns true in a frame's callbacks is painted in that frame: the next frame's start is when it was on screen.
    const painted = await frame();
    return {inputAt: box?.at ?? null, shownAt: painted};
  } finally { box?.stop.abort(); }
};

/**
 * Runs `act()` (real input through `context.input`) and resolves with the milliseconds from the page's first pointer
 * press or key press after this call to the frame that shows `shown(argument)` true. `shown` runs in the page, so it
 * can only use its argument and the page's globals. Throws, naming `what`, when the input never reached the page or the
 * result did not show within `timeoutMs`. The wait is checked once a frame, so it is exact to one display frame.
 */
export async function respond(context, act, shown, {argument = null, timeoutMs = 10000, what = 'the result'} = {}) {
  // The input's own time stamp (the page's clock): the first press of the action, whatever element it reaches.
  await context.evaluate(() => {
    globalThis.__stykPerfResponse?.stop.abort();
    const box = globalThis.__stykPerfResponse = {at: null, stop: new AbortController()};
    for (const type of ['pointerdown', 'keydown']) addEventListener(type, event => { if (event.isTrusted) box.at ??= event.timeStamp; }, {capture: true, signal: box.stop.signal});
  });
  await act();
  const answer = await context.evaluate(`(${WAITER})(${shown}, ${JSON.stringify(argument)}, ${Number(timeoutMs)})`);
  if (answer.inputAt === null) throw new Error(`The input for ${what} never reached the page.`);
  if (answer.timedOut) throw new Error(`${what[0].toUpperCase()}${what.slice(1)} did not show within ${Math.round(timeoutMs / 1000)} s of the input.`);
  return answer.shownAt - answer.inputAt;
}
