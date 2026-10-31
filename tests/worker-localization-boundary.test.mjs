import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const sourceCache = new Map();
const source = async url => {
  if (!sourceCache.has(url.href)) sourceCache.set(url.href, readFile(url, 'utf8'));
  return sourceCache.get(url.href);
};

// These workers consume numerical/model modules. Follow static module edges
// and literal dynamic imports so a presentation dependency cannot eagerly load
// every language pack in each worker realm.
async function dependencies(entry) {
  const found = new Set();
  async function visit(url) {
    if (found.has(url.href)) return;
    found.add(url.href);
    const contents = await source(url);
    const imports = /(?:^|[;\r\n])\s*(?:import|export)\s+(?:[^;'"\r\n]*(?:[\r\n][^;'"\r\n]*)*?\s+from\s*)?['"]([^'"]+)['"]/g;
    const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const specifier of [...contents.matchAll(imports), ...contents.matchAll(dynamic)].map(match => match[1])) {
      if (specifier.startsWith('.')) await visit(new URL(specifier, url));
    }
  }
  await visit(entry);
  return found;
}

for (const entry of ['document-export-worker', 'image-export-worker', 'import-worker']) {
  test(`${entry} excludes interface localization and multilingual packs`, async () => {
    const found = await dependencies(new URL(`../src/${entry}.mjs`, import.meta.url));
    for (const module of ['localization.mjs', 'localization-bindings.mjs', 'locales/locale-index.mjs', 'movieclip-drawings-view.mjs']) {
      const forbidden = new URL(`../src/${module}`, import.meta.url);
      assert.equal(found.has(forbidden.href), false, `${entry} imports ${fileURLToPath(forbidden)}`);
    }
    assert.ok(found.has(new URL('../src/localized-error.mjs', import.meta.url).href), 'English diagnostics remain available');
  });
}
