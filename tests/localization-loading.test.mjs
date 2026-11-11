import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Localization, loadLocale, loadLocales, registerLocale, SUPPORTED_LOCALES} from '../src/localization.mjs';

// Each test file runs in its own process, so the registry starts with English only.
test('a language is chosen only after its messages are loaded, and only that language is loaded', async () => {
  assert.throws(() => new Localization({locale: 'it'}), /Load the interface language/);
  const service = new Localization();
  assert.throws(() => service.setLocale('it'), /Load the interface language/);
  assert.equal(service.locale, 'en');
  assert.equal(await loadLocale('it-IT'), 'it');
  assert.equal(service.setLocale('it'), true);
  assert.equal(service.t('common.save'), 'Salva');
  assert.throws(() => service.setLocale('de'), /Load the interface language/, 'loading Italian does not load German');
  assert.equal(service.locale, 'it');
});

test('every shipped language loads, once, and an unknown one cannot be registered', async () => {
  await loadLocales();
  for (const {id} of SUPPORTED_LOCALES) assert.doesNotThrow(() => new Localization({locale: id}), id);
  assert.throws(() => registerLocale('ja', {}), /Unknown interface language/);
  assert.throws(() => registerLocale('en', {}), /Unknown interface language/);
  assert.equal(await loadLocale('ja'), 'en', 'an unsupported tag falls back to English like normalizeLocale');
});

test('the startup graph carries the language index but no language messages', async () => {
  const seen = new Set();
  async function visit(url) {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const contents = await readFile(url, 'utf8');
    for (const match of contents.matchAll(/(?:^|[;\r\n])\s*(?:import|export)\s+(?:[^;'"\r\n]*?\s+from\s*)?['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) await visit(new URL(match[1], url));
    }
  }
  await visit(new URL('../src/app.mjs', import.meta.url));
  const loaded = [...seen].filter(href => href.includes('/locales/messages/'));
  assert.deepEqual(loaded, [], 'a language module joins the startup graph and is fetched by every launch');
  assert.ok(seen.has(new URL('../src/locales/locale-index.mjs', import.meta.url).href));
});
