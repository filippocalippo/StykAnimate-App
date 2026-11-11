// The control channel's client (docs/DEVTOOLS.md "Control channel"): talks to a running developer build over its
// local named pipe, one JSON request per line.
//
//   node scripts/styk-dev.mjs list                              running developer builds (their pipes)
//   node scripts/styk-dev.mjs [--pid <pid>] <op> [json args] [--full]
//   node scripts/styk-dev.mjs state
//   node scripts/styk-dev.mjs logs '{"level":"warn","module":"engine"}'
//   node scripts/styk-dev.mjs params.set '{"name":"playback.lookaheadFrames","value":96}'
//   node scripts/styk-dev.mjs trace.start; ...; node scripts/styk-dev.mjs trace.save '{"path":"trace.json"}'
//
// Prints the answer's result as JSON (or the error with what failed, where, the input and a hint) and exits 0 or 1.
// `trace.save` is the client's own: it stops the capture, reads every page and writes the Perfetto file. With several
// developer builds running, name one with --pid. The pipe only accepts this user's local connections.
// This client never starts the app, so it never chooses a data folder: an agent starts a developer build with
// STYK_USER_DATA_DIR set to a scratch folder (scripts/styk-profile.mjs --app does), never on the owner's data.
import net from 'node:net';
import {readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const PIPE_PREFIX = 'stykanimate-dev-';
export const pipePath = pid => `\\\\.\\pipe\\${PIPE_PREFIX}${pid}`;

/** The process ids of the running developer builds, from the pipes they serve. */
export function runningBuilds() {
  try { return readdirSync('\\\\.\\pipe\\').filter(name => name.startsWith(PIPE_PREFIX)).map(name => Number(name.slice(PIPE_PREFIX.length))).filter(Number.isInteger); }
  catch { return []; }
}

/** A connection that sends requests in order and resolves each with its answer. */
export function connect(pid) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath(pid));
    let buffer = '', nextId = 1;
    const waiting = [];
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const pending = waiting.shift();
        try { pending?.resolve(JSON.parse(line)); } catch (error) { pending?.reject(error); }
      }
    });
    socket.on('error', error => { reject(error); for (const pending of waiting.splice(0)) pending.reject(error); });
    socket.on('close', () => { for (const pending of waiting.splice(0)) pending.reject(new Error('The app closed the control channel.')); });
    socket.on('connect', () => resolve({
      request(op, args = {}, detail) {
        return new Promise((done, fail) => { waiting.push({resolve: done, reject: fail}); socket.write(`${JSON.stringify({id: nextId++, op, args, ...(detail ? {detail} : {})})}\n`); });
      },
      close: () => socket.end(),
    }));
  });
}

async function main(argv) {
  let pid = null, full = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pid') pid = Number(argv[++i]);
    else if (argv[i] === '--full') full = true;
    else rest.push(argv[i]);
  }
  const [op, json] = rest;
  if (!op) { console.error('Usage: node scripts/styk-dev.mjs [--pid <pid>] <op|list> [json args] [--full]'); return 2; }
  const builds = runningBuilds();
  if (op === 'list') { console.log(JSON.stringify(builds)); return 0; }
  if (pid === null) {
    if (builds.length !== 1) { console.error(builds.length ? `Several developer builds are running (${builds.join(', ')}): name one with --pid.` : 'No developer build is running (start it, then try again).'); return 2; }
    pid = builds[0];
  }
  let args = {};
  try { args = json ? JSON.parse(json) : {}; } catch (error) { console.error(`The arguments are not JSON: ${error.message}`); return 2; }
  const channel = await connect(pid);
  try {
    if (op === 'trace.save') {
      const stopped = await channel.request('trace.stop', {}, full ? 'full' : undefined);
      if (!stopped.ok) { console.log(JSON.stringify(stopped.error, null, 1)); return 1; }
      let text = '';
      for (let page = 0; page < stopped.result.pages; page++) {
        const answer = await channel.request('trace.read', {page});
        if (!answer.ok) { console.log(JSON.stringify(answer.error, null, 1)); return 1; }
        text += answer.result.text;
      }
      const file = path.resolve(args.path ?? `StykAnimate-trace-${Date.now()}.json`);
      writeFileSync(file, text);
      console.log(JSON.stringify({...stopped.result, written: file}, null, 1));
      return 0;
    }
    const answer = await channel.request(op, args, full ? 'full' : undefined);
    console.log(JSON.stringify(answer.ok ? answer.result : answer.error, null, 1));
    return answer.ok ? 0 : 1;
  } finally { channel.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
