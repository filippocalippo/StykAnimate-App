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
process.exitCode = failures || css.status !== 0 || locales.status !== 0 ? 1 : 0;
