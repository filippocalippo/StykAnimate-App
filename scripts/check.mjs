import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { execFile, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = [];
async function discover(directory) {
  let entries;
  try { entries = await readdir(path.join(appRoot, directory), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) await discover(relative);
    else if (/\.(mjs|cjs|js)$/.test(entry.name)) sources.push(relative);
  }
}
for (const directory of ['src', 'desktop', 'scripts', 'tests']) await discover(directory);
// One `node --check` per file, several at a time: starting the processes is what takes the time.
const errors = new Array(sources.length);
const check = (index) => new Promise((resolve) => {
  execFile(process.execPath, ['--check', sources[index]], { cwd: appRoot, encoding: 'utf8', windowsHide: true }, (error, _stdout, stderr) => {
    if (error) errors[index] = stderr || error.message || `${sources[index]}: check failed.`;
    resolve();
  });
});
let next = 0;
await Promise.all(Array.from({ length: Math.min(os.availableParallelism(), 16) }, async () => { while (next < sources.length) await check(next++); }));
// Reported in the order the files were found, whichever check finished first.
const failures = errors.filter(Boolean).length;
for (const error of errors) if (error) console.error(error);
console.log(`${sources.length} JavaScript files checked; ${failures} syntax errors.`);
// Stylesheet lint (layers, tokens, specificity) and its legacy ratchet: scripts/check-css.mjs.
const css = spawnSync(process.execPath, ['scripts/check-css.mjs'], { cwd: appRoot, encoding: 'utf8', windowsHide: true });
process.stdout.write(css.stdout ?? '');
process.stderr.write(css.stderr || (css.error ? `${css.error.message}\n` : ''));
const locales = spawnSync(process.execPath, ['scripts/build-locales.mjs', '--check'], { cwd: appRoot, encoding: 'utf8', windowsHide: true });
process.stdout.write(locales.stdout ?? '');
process.stderr.write(locales.stderr ?? '');
// Every source module has a row in engine/inventory.tsv (scripts/engine-inventory.mjs): only its problems are printed here.
const inventory = spawnSync(process.execPath, ['scripts/engine-inventory.mjs'], { cwd: appRoot, encoding: 'utf8', windowsHide: true });
if (inventory.status !== 0) process.stderr.write(`${inventory.stdout ?? ''}${inventory.stderr || (inventory.error ? `${inventory.error.message}\n` : '')}`);
else console.log('Engine inventory: every source module has a row.');
// src/app.mjs wires the application together and has grown far past what one module should hold. It may shrink, not grow:
// a feature goes in a module of its own that app.mjs calls, and this number goes down when code moves out.
const APP_MODULE_LINES = 6500;
const appLines = readFileSync(path.join(appRoot, 'src/app.mjs'), 'utf8').split('\n').length;
const appGrew = appLines > APP_MODULE_LINES;
if (appGrew) console.error(`src/app.mjs has ${appLines} lines; its limit is ${APP_MODULE_LINES}. Put the new code in its own module (see AGENTS.md) instead of raising the limit.`);
process.exitCode = failures || css.status !== 0 || locales.status !== 0 || inventory.status !== 0 || appGrew ? 1 : 0;
