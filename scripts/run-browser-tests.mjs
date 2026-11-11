/**
 * Runs browser tests (tests/*.browser.mjs) against one development server and reports which pass:
 *
 *   npm run test:browser                          every browser test
 *   npm run test:browser -- timeline hotkeys      the tests whose file name contains one of the words
 *   npm run test:browser -- --jobs 2 --timeout 240
 *
 * Each test is its own script that exits with 0 when it passes. They run several at a time, each in its own
 * headless browser, against `scripts/serve.mjs` on STYK_PORT (47831 by default, the address some tests name
 * themselves); with STYK_URL set, that server is used and none is started. The results go to
 * artifacts/browser-tests/results.json (file, status, seconds, the last lines of a failure).
 * Exit code 1 when a test fails or does not finish.
 */
import {spawn} from 'node:child_process';
import {mkdir, readdir, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? Number(args.splice(at, 2)[1]) : fallback; };
const jobs = option('--jobs', Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 3))));
const timeout = option('--timeout', 180) * 1000;
const port = Number(process.env.STYK_PORT || 47831);
const url = process.env.STYK_URL ?? `http://127.0.0.1:${port}`;

const all = (await readdir(path.join(root, 'tests'))).filter(name => name.endsWith('.browser.mjs')).sort();
const files = args.length ? all.filter(name => args.some(word => name.includes(word))) : all;
if (!files.length) { console.error('No browser test matches.'); process.exit(1); }

/** Stops a process this script started, with what it started (a browser, a server). */
const stop = child => {
  if (child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
};
const answers = async () => { try { return (await fetch(url, {signal: AbortSignal.timeout(2000)})).ok; } catch { return false; } };

let server = null;
if (!process.env.STYK_URL) {
  if (await answers()) { console.error(`Something already answers at ${url}. Stop it, or set STYK_URL to use it.`); process.exit(1); }
  server = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port)], {cwd: root, stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32'});
  for (let waited = 0; !(await answers()); waited += 250) {
    if (waited > 30000 || server.exitCode !== null) { stop(server); console.error(`The development server did not start at ${url}.`); process.exit(1); }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

const run = file => new Promise(resolve => {
  const started = Date.now();
  const child = spawn(process.execPath, [path.join('tests', file)], {cwd: root, windowsHide: true, detached: process.platform !== 'win32',
    env: {...process.env, STYK_URL: url}, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '', timedOut = false;
  const keep = chunk => { output = (output + chunk).slice(-6000); };
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  const timer = setTimeout(() => { timedOut = true; stop(child); }, timeout);
  child.on('close', code => {
    clearTimeout(timer);
    const status = timedOut ? 'timeout' : code === 0 ? 'pass' : 'fail';
    const result = {file, status, seconds: Math.round((Date.now() - started) / 100) / 10};
    if (status !== 'pass') result.output = output.trim().split('\n').slice(-12).join('\n');
    console.log(`${status.toUpperCase().padEnd(7)} ${String(result.seconds).padStart(6)}s  ${file}`);
    resolve(result);
  });
});

const results = [];
let next = 0;
try {
  await Promise.all(Array.from({length: Math.min(jobs, files.length)}, async () => { while (next < files.length) results.push(await run(files[next++])); }));
} finally { if (server) stop(server); }
results.sort((a, b) => a.file.localeCompare(b.file));
const count = status => results.filter(result => result.status === status).length;
const out = path.join(root, 'artifacts', 'browser-tests');
await mkdir(out, {recursive: true});
await writeFile(path.join(out, 'results.json'), JSON.stringify({url, jobs, results}, null, 2));
console.log(`\n${count('pass')} passed, ${count('fail')} failed, ${count('timeout')} did not finish, of ${results.length}. Details: artifacts/browser-tests/results.json`);
process.exit(count('pass') === results.length ? 0 : 1);
