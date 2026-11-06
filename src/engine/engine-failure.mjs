/**
 * When the engine refuses a document, the refusal belongs to that revision of that document
 * (docs/engine/rendering.md): the next revision, or another document, is tried afresh. The
 * stage and the playback adapter share it through the engine side (`side.failed` is the reason
 * while it stands).
 */

/** The engine refused `report` at `revision` for `reason`. */
export function failEngine(side, reason, report, revision = 0) {
  side.failed = reason;
  side.failure = {report, revision};
}

/**
 * The refusal standing for `report` at `revision`, or null. A refusal of another revision or
 * document ends here: the engine is asked again.
 */
export function engineRefusal(side, report, revision = 0) {
  if (!side.failed) return null;
  const failure = side.failure;
  if (failure && failure.report === report && failure.revision === revision) return side.failed;
  side.failed = null;
  side.failure = null;
  return null;
}
