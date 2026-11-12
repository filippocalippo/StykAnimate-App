// The board on disk: board.json for the document, one file per screen version. Every write
// goes to a temporary file and is renamed over the old one, so a crash leaves the last good
// copy. Screens are only ever added, which keeps every version recoverable.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { emptyBoard } from '../shared/board-model.mjs';

const SAFE_ID = /^[a-z0-9-]{1,40}$/;
export const safeId = (id) => typeof id === 'string' && SAFE_ID.test(id);

async function writeAtomic(file, data) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, file);
}

export async function openStore(directory) {
  await mkdir(path.join(directory, 'screens'), { recursive: true });
  const boardFile = path.join(directory, 'board.json');
  let board;
  try { board = JSON.parse(await readFile(boardFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    board = emptyBoard();
  }
  // A run cannot survive the server that started it.
  for (const frame of Object.values(board.frames)) {
    if (frame.status === 'queued' || frame.status === 'thinking' || frame.status === 'streaming') {
      frame.status = frame.versions.length ? 'ready' : 'error';
      if (!frame.versions.length) frame.error = 'The server stopped during this run.';
    }
  }
  for (const run of Object.values(board.runs)) if (run.state === 'running') run.state = 'stopped';

  let timer = null, writing = Promise.resolve();
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    writing = writing.then(() => writeAtomic(boardFile, JSON.stringify(board))).catch((error) => console.error('Could not save the board:', error.message));
    return writing;
  };
  const screenFile = (id, n) => path.join(directory, 'screens', `${id}.${n}.html`);
  return {
    board,
    touch() { timer ??= setTimeout(flush, 250); },
    flush,
    async writeScreen(id, n, html) { await writeAtomic(screenFile(id, n), html); },
    async readScreen(id, n) {
      if (!safeId(id) || !Number.isInteger(n)) return null;
      try { return await readFile(screenFile(id, n), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
  };
}
