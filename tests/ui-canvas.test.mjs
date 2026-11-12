import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { childEnvironment, cliArguments, createLimiter } from '../labs/ui-canvas/lib/claude-cli.mjs';
import { applyEdits, createScreenParser, goTargets, parseFindings } from '../labs/ui-canvas/lib/screen-stream.mjs';
import { applyOp, emptyBoard, USER_OPS } from '../labs/ui-canvas/shared/board-model.mjs';
import { startServer } from '../labs/ui-canvas/server.mjs';

const fake = fileURLToPath(new URL('../labs/ui-canvas/test/fake-claude.mjs', import.meta.url));

function parse(chunks) {
  const screens = [];
  let current = null;
  const parser = createScreenParser({
    onOpen(attributes) { current = { attributes, html: '' }; },
    onDelta(text) { current.html += text; },
    onClose() { screens.push(current); },
  });
  chunks.forEach((chunk) => parser.feed(chunk));
  return { screens, parser, get current() { return current; } };
}

test('screens parse the same however the stream is chunked', () => {
  const text = 'noise <screen id="a" title="A > B" idea=\'x\'><b>1</b></screen>\n```\n<screen id="b"><i>2 < 3</i></screen> tail';
  const whole = parse([text]).screens;
  const single = parse([...text]).screens;
  assert.deepEqual(single, whole);
  assert.equal(whole.length, 2);
  assert.equal(whole[0].attributes.title, 'A > B');
  assert.equal(whole[1].html, '<i>2 < 3</i>');
});

test('a stream cut short still yields the partial screen', () => {
  const result = parse(['<screen id="a"><div>half']);
  assert.equal(result.parser.end(), true);
  assert.equal(result.screens[0].html, '<div>half');
});

test('edits apply all together or not at all', () => {
  assert.equal(applyEdits('one two', '<edit><find>one</find><replace>1</replace></edit><edit><find>two</find><replace>2</replace></edit>').html, '1 2');
  assert.equal(applyEdits('one two', '<edit><find>one</find><replace>1</replace></edit><edit><find>nope</find><replace>2</replace></edit>').html, null);
  assert.equal(applyEdits('one', 'no edits here').html, null);
});

test('links and findings are read from model text', () => {
  assert.deepEqual(goTargets(`<a data-go="x"></a><b data-go='y'></b><i data-go="x"></i>`), ['x', 'y']);
  const [finding] = parseFindings('<finding sev="high" title="Unclear > step" why="Why" fix="Fix"/>');
  assert.deepEqual(finding, { sev: 'high', title: 'Unclear > step', why: 'Why', fix: 'Fix' });
});

test('every call uses Opus at high effort and no tools', () => {
  const args = cliArguments('brief.md');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
});

test('the child does not inherit the parent Claude Code session', () => {
  const env = childEnvironment({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_MESSAGING_TOKEN: 'x', CLAUDE_EFFORT: 'low', PATH: 'p', CLAUDE_CONFIG_DIR: 'c' });
  assert.deepEqual(env, { PATH: 'p', CLAUDE_CONFIG_DIR: 'c' });
});

test('the limiter never exceeds its limit and frees slots after a failure', async () => {
  const limit = createLimiter(2);
  let active = 0, peak = 0;
  const task = (fail) => limit(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    if (fail) throw new Error('x');
  });
  await Promise.allSettled([task(true), task(), task(true), task(), task()]);
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test('board operations replay, ignore bad values and keep deletes reversible', () => {
  const board = emptyBoard();
  applyOp(board, { op: 'addFrame', frame: { id: 'a', x: 0, y: 0, w: 100, h: 100, tags: [], versions: [{ n: 1 }, { n: 2 }], version: 2 } });
  applyOp(board, { op: 'moveFrames', moves: [{ id: 'a', x: 'no', y: 5 }] });
  assert.equal(board.frames.a.x, 0);
  applyOp(board, { op: 'patchFrame', id: 'a', patch: { w: 10, status: 'ready', theme: 'dark' } });
  assert.equal(board.frames.a.w, 100);
  assert.equal(board.frames.a.status, undefined);
  assert.equal(board.frames.a.theme, 'dark');
  assert.equal(applyOp(board, { op: 'setVersion', id: 'a', n: 9 }), false);
  applyOp(board, { op: 'setFrameTags', id: 'a', tags: ['keep', 'unknown'] });
  assert.deepEqual(board.frames.a.tags, ['keep']);
  applyOp(board, { op: 'deleteFrames', ids: ['a'] });
  applyOp(board, { op: 'restoreFrames', ids: ['a'] });
  assert.equal(board.frames.a.deleted, undefined);
  assert.equal(USER_OPS.has('addFrame') || USER_OPS.has('addVersion') || USER_OPS.has('patchRunnerFrame'), false);
});

test('every name the brief promises exists in the kit', async () => {
  const brief = await readFile(new URL('../labs/ui-canvas/brief/design-brief.md', import.meta.url), 'utf8');
  const kit = async (file) => readFile(new URL(`../labs/ui-canvas/kit/${file}`, import.meta.url), 'utf8');
  const list = (pattern) => pattern.exec(brief)[1].trim().split(/\s+/);
  const [icons, figure, data] = await Promise.all([kit('icons.js'), kit('figure.js'), kit('data.js')]);
  for (const name of list(/Names: (.+)/)) assert.ok(icons.includes(`"${name}":`), `icon ${name}`);
  for (const name of list(/Poses: (.+)/)) assert.match(figure, new RegExp(`\\b${name}: P\\(`), `pose ${name}`);
  for (const name of list(/Scenes: (.+)/)) assert.match(data, new RegExp(`\\b${name}: \\{`), `scene ${name}`);
});

let server, directory;
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'ui-canvas-'));
  server = await startServer({ port: 0, dataDirectory: directory, command: [process.execPath, fake] });
});
after(async () => {
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

const post = (url, body, headers = {}) => fetch(`${server.origin}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function settled(run) {
  for (let i = 0; i < 400; i++) {
    const state = (await (await fetch(`${server.origin}/api/board`)).json()).runs[run]?.state;
    if (state && state !== 'running') return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('run did not settle');
}

test('the server refuses other origins, the sandbox and tampered operations', async () => {
  assert.equal((await post('/api/generate', { intent: 'create', prompt: 'x' }, { origin: 'https://example.com' })).status, 403);
  assert.equal((await post('/api/generate', { intent: 'create', prompt: 'x' }, { origin: 'null' })).status, 403);
  assert.equal((await post('/api/ops', { ops: [{ op: 'addFrame', frame: { id: 'x' } }] })).status, 400);
  assert.equal((await fetch(`${server.origin}/api/ops`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${server.origin}/frame/app/%2e%2e%2f%2e%2e%2fserver.mjs`)).status, 404);
  assert.equal((await fetch(`${server.origin}/api/screen/..%2f..%2fx/1`)).status, 404);
});

test('a run makes parallel variants, then refine, element and restyle add versions', async () => {
  const run = (await (await post('/api/generate', { intent: 'create', prompt: '3 homes' })).json()).run;
  assert.equal(await settled(run), 'done');
  let board = await (await fetch(`${server.origin}/api/board`)).json();
  const frames = Object.values(board.frames);
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((frame) => frame.status), ['ready', 'ready', 'ready']);
  assert.equal(new Set(frames.map((frame) => frame.x)).size, 3);
  assert.equal(board.runs[run].tokens, 50 + 3 * 3702); // the plan, then three designs

  const [frame] = frames;
  await settled((await (await post('/api/generate', { intent: 'refine', prompt: 'Rename it', frames: [frame.id] })).json()).run);
  const refined = await (await fetch(`${server.origin}/api/screen/${frame.id}/2`)).text();
  assert.match(refined, /Keep going/);
  const original = await (await fetch(`${server.origin}/api/screen/${frame.id}/1`)).text();
  assert.match(original, /Continue/);

  await settled((await (await post('/api/generate', { intent: 'element', prompt: 'x', frames: [frame.id], element: { before: 'A', after: 'B', html: '<h1></h1>' } })).json()).run);
  assert.equal(await (await fetch(`${server.origin}/api/screen/${frame.id}/3`)).text(), 'A<h1 data-part="heading">Picked and changed</h1>B');

  for (let i = 0; i < 2; i++) await settled((await (await post('/api/generate', { intent: 'restyle', prompt: 'x', frames: [frame.id] })).json()).run);
  const restyled = await (await fetch(`${server.origin}/api/screen/${frame.id}/5`)).text();
  assert.equal(restyled.match(/data-restyle/g).length, 1);

  await settled((await (await post('/api/generate', { intent: 'critique', frames: [frame.id] })).json()).run);
  board = await (await fetch(`${server.origin}/api/board`)).json();
  assert.equal(board.frames[frame.id].critique[0].sev, 'high');
  assert.equal(board.frames[frame.id].status, 'ready');
});

test('a flow becomes linked frames, and a failure lands on the frame', async () => {
  const flow = (await (await post('/api/generate', { intent: 'create', prompt: 'A first-run flow' })).json()).run;
  await settled(flow);
  let board = await (await fetch(`${server.origin}/api/board`)).json();
  const frames = Object.values(board.frames).filter((frame) => frame.run === flow);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0].links, [frames[1].id]);
  assert.deepEqual(frames[1].links, [frames[0].id]);

  const failed = (await (await post('/api/generate', { intent: 'create', prompt: 'FAIL' })).json()).run;
  assert.equal(await settled(failed), 'failed');
  board = await (await fetch(`${server.origin}/api/board`)).json();
  const frame = Object.values(board.frames).find((item) => item.run === failed);
  assert.equal(frame.status, 'error');
  assert.equal(frame.error, 'Rate limited.');
});

test('the board survives a restart on disk', async () => {
  await server.close();
  const saved = JSON.parse(await readFile(path.join(directory, 'board.json'), 'utf8'));
  assert.ok(Object.keys(saved.frames).length >= 5);
  server = await startServer({ port: 0, dataDirectory: directory, command: [process.execPath, fake] });
  const board = await (await fetch(`${server.origin}/api/board`)).json();
  assert.equal(Object.keys(board.frames).length, Object.keys(saved.frames).length);
});
