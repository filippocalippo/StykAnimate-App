/**
 * Waits for the engine's document to be the editor's, for work the engine does away from the
 * stage: exports (engine-export.mjs) and thumbnails (engine-thumbnails.mjs).
 */

/** How long the engine may take to follow an edit before the caller draws without it. */
const FOLLOW_MS = 2000;

/**
 * Why the engine cannot work on `report` at `revision`, or null once it holds it. The session publishes
 * every change at the editor's revision as it makes it, so this answers at once unless an edit is still on
 * its way; then it waits briefly. `check()` throws to abandon the wait (an AbortError passes through).
 * @param {{stage: object, report: object, revision: number, check?: () => void}} options
 * @returns {Promise<string|null>}
 */
export async function engineDocument({stage, report, revision, check = () => {}}) {
  const started = performance.now();
  try {
    for (;;) {
      check();
      const reason = stage.prepareExport(report, revision);
      if (reason === null) return null;
      if (!/does not hold this revision/.test(reason) || performance.now() - started > FOLLOW_MS) return reason;
      await new Promise(resolve => setTimeout(resolve, 16));
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return String(error?.message ?? error);
  }
}
