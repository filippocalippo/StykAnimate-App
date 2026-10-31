import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';

// On Windows `new URL('../x', import.meta.url).pathname` is "/C:/..." with "%20" for spaces,
// which no filesystem call accepts. A file URL becomes a path with `fileURLToPath`; a path
// becomes something `import()` takes with `pathToFileURL`. The repository lives in a folder
// with a space on this project's Windows machines, so the tools and tests must run there.
const root = path.resolve(import.meta.dirname, '..');
const here = path.basename(import.meta.filename);

function* sources(directory) {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(file);
    else if (/\.(mjs|cjs|js)$/.test(entry.name) && entry.name !== here) yield file;
  }
}

test('Node tools, scripts and tests never turn a file URL into a path with .pathname', () => {
  const offenders = [];
  for (const directory of ['engine/tools', 'scripts', 'tests']) {
    for (const file of sources(path.join(root, directory))) {
      const text = readFileSync(file, 'utf8');
      if (/import\.meta\.url\s*\)\s*\.pathname/.test(text) || /`file:\/\/\$\{process\.argv\[1\]\}`/.test(text)) offenders.push(path.relative(root, file));
    }
  }
  assert.deepEqual(offenders, [], 'use fileURLToPath / pathToFileURL');
});
