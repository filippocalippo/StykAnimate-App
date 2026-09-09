import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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
let failures = 0;
for (const source of sources) {
  const result = spawnSync(process.execPath, ['--check', source], { cwd: appRoot, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) { failures++; console.error(result.stderr || result.error?.message || `${source}: check failed.`); }
}
console.log(`${sources.length} JavaScript files checked; ${failures} syntax errors.`);
process.exitCode = failures ? 1 : 0;
