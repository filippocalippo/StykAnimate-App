// The board document and the only way it changes. The server and the browser both apply
// these operations, so an edit made in one place replays identically in the other.

export const DEFAULT_TAGS = Object.freeze([
  { id: 'keep', name: 'Keep', hue: 'library' },
  { id: 'maybe', name: 'Maybe', hue: 'time' },
  { id: 'reject', name: 'Reject', hue: 'fx' },
]);

export function emptyBoard() {
  return { version: 1, tags: DEFAULT_TAGS.map((tag) => ({ ...tag })), frames: {}, runs: {} };
}

const number = (value) => typeof value === 'number' && Number.isFinite(value);
const USER_PATCH = new Set(['title', 'theme', 'w', 'h']);

// Operations the browser may send. The rest come from the runner, which owns generation.
export const USER_OPS = new Set(['moveFrames', 'patchFrame', 'deleteFrames', 'restoreFrames', 'setVersion', 'addTag', 'setFrameTags', 'clearCritique']);

export function applyOp(board, op) {
  const frame = op.id ? board.frames[op.id] : null;
  switch (op.op) {
    case 'addFrame': board.frames[op.frame.id] = op.frame; return true;
    case 'patchRunnerFrame': if (frame) Object.assign(frame, op.patch); return Boolean(frame);
    case 'upsertRun': board.runs[op.run.id] = { ...board.runs[op.run.id], ...op.run }; return true;
    case 'addVersion':
      if (!frame) return false;
      frame.versions.push(op.meta);
      frame.version = op.meta.n;
      frame.status = 'ready';
      frame.error = null;
      if (op.patch) Object.assign(frame, op.patch);
      return true;
    case 'setCritique': if (frame) frame.critique = op.critique; return Boolean(frame);
    case 'clearCritique': if (frame) frame.critique = null; return Boolean(frame);
    case 'moveFrames':
      for (const move of op.moves ?? []) {
        const target = board.frames[move.id];
        if (target && number(move.x) && number(move.y)) { target.x = move.x; target.y = move.y; }
      }
      return true;
    case 'patchFrame':
      if (!frame) return false;
      for (const [key, value] of Object.entries(op.patch ?? {})) {
        if (!USER_PATCH.has(key)) continue;
        if ((key === 'w' || key === 'h') && (!number(value) || value < 240 || value > 4000)) continue;
        if (key === 'theme' && value !== 'light' && value !== 'dark') continue;
        if (key === 'title' && typeof value !== 'string') continue;
        frame[key] = key === 'title' ? value.slice(0, 80) : value;
      }
      return true;
    case 'deleteFrames':
      for (const id of op.ids ?? []) if (board.frames[id]) board.frames[id].deleted = true;
      return true;
    case 'restoreFrames':
      for (const id of op.ids ?? []) if (board.frames[id]) delete board.frames[id].deleted;
      return true;
    case 'setVersion':
      if (!frame || !frame.versions.some((version) => version.n === op.n)) return false;
      frame.version = op.n;
      return true;
    case 'addTag':
      if (!op.tag?.id || board.tags.some((tag) => tag.id === op.tag.id)) return false;
      board.tags.push({ id: String(op.tag.id).slice(0, 40), name: String(op.tag.name).slice(0, 24), hue: String(op.tag.hue ?? 'select') });
      return true;
    case 'setFrameTags':
      if (!frame || !Array.isArray(op.tags)) return false;
      frame.tags = op.tags.filter((id) => board.tags.some((tag) => tag.id === id));
      return true;
    default: return false;
  }
}

export const liveFrames = (board) => Object.values(board.frames).filter((frame) => !frame.deleted);

export function bounds(frames) {
  if (!frames.length) return null;
  const left = Math.min(...frames.map((f) => f.x)), top = Math.min(...frames.map((f) => f.y));
  const right = Math.max(...frames.map((f) => f.x + f.w)), bottom = Math.max(...frames.map((f) => f.y + f.h));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}
