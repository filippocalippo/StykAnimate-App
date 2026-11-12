/**
 * Runs browser tests (tests/*.browser.mjs) against one development server and reports which pass:
 *
 *   npm run test:browser                          every browser test
 *   npm run test:browser -- timeline hotkeys      the tests whose file name contains one of the words
 *   npm run test:browser -- --jobs 2 --timeout 240
 *   npm run test:browser -- --script test:web --no-server   the tests a package.json script names, which start
 *                                                           their own server
 *
 * Each test is its own script that exits with 0 when it passes. A test that cannot run on this machine, because
 * local sample files it reads are missing (tests/helpers/local-fixtures.mjs), prints a first line `SKIP <reason>`
 * and exits with 0 before it opens a browser: it is reported as skipped, which is not a failure
 * (STYK_REQUIRE_FIXTURES=1 makes those tests run, and fail on the missing file, instead). A `SKIP` line with any
 * other exit code is a failure. They run several at a time, each in its own
 * headless browser, against `scripts/serve.mjs` on STYK_PORT (47831 by default, the address some tests name
 * themselves); with STYK_URL set, that server is used and none is started. The results go to
 * artifacts/browser-tests/results.json (file; status pass, skip, fail or timeout; seconds; the reason for a skip;
 * the last lines of a failure). Exit code 1 when a test fails or does not finish.
 *
 * A machine without a GPU draws with a software renderer, which sometimes stops offering an adapter while several
 * editors are open: the page then says "No available adapters". A test that fails saying so is run once more, and
 * the result notes it; any other failure stands.
 */
import {spawn} from 'node:child_process';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? Number(args.splice(at, 2)[1]) : fallback; };
const jobs = option('--jobs', Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 3))));
const timeout = option('--timeout', 180) * 1000;
const flag = name => { const at = args.indexOf(name); if (at >= 0) args.splice(at, 1); return at >= 0; };
const ownServers = flag('--no-server');
// `--script <name>`, any number of times: the browser tests that package.json script runs.
const scripts = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).scripts;
const named = [];
for (let at = args.indexOf('--script'); at >= 0; at = args.indexOf('--script')) {
  const [, name] = args.splice(at, 2);
  if (!scripts[name]) { console.error(`package.json has no script "${name}".`); process.exit(1); }
  named.push(...scripts[name].matchAll(/tests\/([\w.-]+\.browser\.mjs)/g).map(match => match[1]));
}
const port = Number(process.env.STYK_PORT || 47831);
const url = process.env.STYK_URL ?? `http://127.0.0.1:${port}`;

const all = (await readdir(path.join(root, 'tests'))).filter(name => name.endsWith('.browser.mjs')).sort();
const files = named.length || args.length ? all.filter(name => named.includes(name) || args.some(word => name.includes(word))) : all;
if (!files.length || named.some(name => !all.includes(name))) { console.error('No browser test matches, or a script names a test that does not exist.'); process.exit(1); }

/** Stops a process this script started, with what it started (a browser, a server). */
const stop = child => {
  if (child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
};
const answers = async () => { try { return (await fetch(url, {signal: AbortSignal.timeout(2000)})).ok; } catch { return false; } };

let server = null;
if (!process.env.STYK_URL && !ownServers) {
  if (await answers()) { console.error(`Something already answers at ${url}. Stop it, or set STYK_URL to use it.`); process.exit(1); }
  server = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port)], {cwd: root, stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32'});
  for (let waited = 0; !(await answers()); waited += 250) {
    if (waited > 30000 || server.exitCode !== null) { stop(server); console.error(`The development server did not start at ${url}.`); process.exit(1); }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

const once = file => new Promise(resolve => {
  const started = Date.now();
  // A test that starts its own server is not handed the address of one that was not started.
  const child = spawn(process.execPath, [path.join('tests', file)], {cwd: root, windowsHide: true, detached: process.platform !== 'win32',
    env: ownServers && !process.env.STYK_URL ? process.env : {...process.env, STYK_URL: url}, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '', head = '', timedOut = false;
  const keep = chunk => { output = (output + chunk).slice(-6000); };
  child.stdout.on('data', chunk => { if (head.length < 2000) head += chunk; keep(chunk); });
  child.stderr.on('data', keep);
  const timer = setTimeout(() => { timedOut = true; stop(child); }, timeout);
  child.on('close', code => {
    clearTimeout(timer);
    const skip = /^SKIP (.*)$/.exec(head.split(/\r?\n/)[0]);
    const status = timedOut ? 'timeout' : code !== 0 ? 'fail' : skip ? 'skip' : 'pass';
    const result = {file, status, seconds: Math.round((Date.now() - started) / 100) / 10};
    if (status === 'skip') result.reason = skip[1].trim();
    else if (status !== 'pass') { result.output = output.trim().split('\n').slice(-12).join('\n'); result.lostAdapter = output.includes('No available adapters'); }
    resolve(result);
  });
});
const run = async file => {
  let result = await once(file);
  if (result.lostAdapter) {
    console.log(`RETRY   ${String(result.seconds).padStart(6)}s  ${file}  the software renderer stopped offering an adapter`);
    result = {...await once(file), retried: 'No available adapters'};
  }
  delete result.lostAdapter;
  console.log(`${result.status.toUpperCase().padEnd(7)} ${String(result.seconds).padStart(6)}s  ${file}${result.reason ? `  ${result.reason}` : ''}`);
  return result;
};

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
// What each failure said, so a log of this run is enough to read it.
for (const result of results) if (result.output !== undefined) console.log(`\n--- ${result.file} (${result.status})\n${result.output}`);
console.log(`\n${count('pass')} passed, ${count('skip')} skipped, ${count('fail')} failed, ${count('timeout')} did not finish, of ${results.length}. Details: artifacts/browser-tests/results.json`);
process.exit(count('fail') + count('timeout') ? 1 : 0);
