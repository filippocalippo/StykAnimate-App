import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, Localization, normalizeLocale, isSupportedLocale } from '../src/localization.mjs';
import english from '../src/locales/en.mjs';
import italian from '../src/locales/it.mjs';

test('English is the default and invalid persisted locales fall back without guessing from the machine', () => {
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.equal(new Localization().t('common.save'), 'Save');
  for (const value of [undefined, null, 12, {}, '', '../it', 'it_IT', 'ja', 'zh-Hant', 'pt-PT', 'a'.repeat(65)]) {
    assert.equal(normalizeLocale(value), 'en');
    assert.equal(isSupportedLocale(value), false);
    assert.equal(new Localization({ locale: value }).locale, 'en');
  }
});

test('supported regional language tags normalize while unsupported locales cannot change an active session', () => {
  for (const value of ['it', 'IT', 'it-IT', 'it-CH']) {
    assert.equal(normalizeLocale(value), 'it');
    assert.equal(isSupportedLocale(value), true);
  }
  const locale = new Localization({ locale: 'it-IT' });
  assert.equal(locale.t('common.save'), 'Salva');
  assert.equal(locale.direction, 'ltr');
  assert.throws(() => locale.setLocale('ja'), /supported interface language/);
  assert.equal(locale.locale, 'it');
  assert.equal(locale.setLocale('en-US'), true);
  assert.equal(locale.locale, 'en');
});

test('missing translations fall back to English and missing keys remain diagnosable', () => {
  const locale = new Localization({ locale: 'it' });
  assert.equal(locale.t('diagnostics.renderer'), 'Renderer');
  assert.equal(locale.t('untranslated.newControl'), 'untranslated.newControl');
  for (const key of ['constructor', 'toString', '__proto__']) assert.equal(locale.t(key), key);
  assert.throws(() => locale.t(null), /translation key/);
});

test('named placeholders format real values without evaluating code or inherited data', () => {
  const locale = new Localization({ locale: 'it' });
  assert.equal(locale.t('timeline.frameOf', { frame: 12, total: 12345 }), 'Fotogramma 12 di 12.345');
  assert.equal(locale.t('timeline.frameOf', { frame: 12 }), 'Fotogramma 12 di {total}');
  assert.equal(locale.t('timeline.frameOf', Object.create({ frame: 12, total: 20 })), 'Fotogramma {frame} di {total}');
  const literal = '<img src=x onerror=alert(1)>{total}';
  assert.equal(locale.t('timeline.frameOf', { frame: literal, total: 4 }), `Fotogramma ${literal} di 4`);
  assert.equal(locale.t('timeline.frameOf', { frame: NaN, total: {} }), 'Fotogramma {frame} di {total}');
});

test('plural text uses the selected language and localized counts', () => {
  const locale = new Localization();
  assert.equal(locale.t('timeline.selectedFrames', { count: 1 }), '1 selected frame');
  assert.equal(locale.t('timeline.selectedFrames', { count: 0 }), '0 selected frames');
  locale.setLocale('it');
  assert.equal(locale.t('timeline.selectedFrames', { count: 1 }), '1 fotogramma selezionato');
  assert.equal(locale.t('timeline.selectedFrames', { count: 12345 }), '12.345 fotogrammi selezionati');
});

test('locale changes notify subscribers once and can be unsubscribed without timers or a DOM', () => {
  const locale = new Localization(), changes = [];
  const unsubscribe = locale.subscribe(change => changes.push(change));
  assert.equal(locale.setLocale('en-GB'), false);
  assert.equal(changes.length, 0);
  locale.setLocale('it');
  assert.deepEqual(changes, [{ locale: 'it', previousLocale: 'en', direction: 'ltr' }]);
  assert.ok(Object.isFrozen(changes[0]));
  unsubscribe();
  locale.setLocale('en');
  assert.equal(changes.length, 1);
});

test('number/date formatting follows the UI language without changing source values', () => {
  const locale = new Localization({ locale: 'it' });
  const number = 12345.5, time = Date.UTC(2026, 8, 8);
  assert.equal(locale.formatNumber(number), '12.345,5');
  assert.equal(locale.formatNumber(0.25, { style: 'percent' }), '25%');
  assert.equal(locale.formatDate(time, { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }), '08/09/2026');
  assert.equal(number, 12345.5);
  assert.equal(time, Date.UTC(2026, 8, 8));
  for (const value of [NaN, Infinity, '1.2']) assert.throws(() => locale.formatNumber(value), /finite/);
  assert.throws(() => locale.formatDate('not a date'), /valid/);
});

test('formatter work is cached, bounded and invalidated only when language changes', () => {
  const locale = new Localization();
  locale.formatNumber(1.2, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const first = [...locale.formatters.values()][0];
  locale.formatNumber(3.4, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  assert.equal([...locale.formatters.values()][0], first);
  assert.equal(locale.formatters.size, 1);
  for (let digits = 0; digits < 20; digits++) locale.formatNumber(1.2, { minimumFractionDigits: digits });
  assert.equal(locale.formatters.size, 16);
  locale.setLocale('it');
  assert.equal(locale.formatters.size, 0);
});

test('partial catalogs are immutable and preserve every translated placeholder', () => {
  assert.ok(Object.isFrozen(SUPPORTED_LOCALES));
  assert.equal(SUPPORTED_LOCALES.length, 27);
  assert.ok(SUPPORTED_LOCALES.every(item => ['common-controls','native-captions'].includes(item.coverage) && Object.isFrozen(item)));
  assert.ok(Object.isFrozen(english) && Object.isFrozen(italian));
  const placeholders = value => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort();
  for (const [key, translated] of Object.entries(italian)) {
    const source = english[key];
    assert.notEqual(source, undefined, key);
    if (typeof source === 'string') assert.deepEqual(placeholders(translated), placeholders(source), key);
    else for (const [category, text] of Object.entries(translated)) {
      assert.ok(Object.isFrozen(translated), key);
      assert.deepEqual(placeholders(text), placeholders(source[category]), `${key}.${category}`);
    }
  }
});
