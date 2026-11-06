import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import english from '../src/locales/en.mjs';
import { validateCatalog } from '../src/locales/catalog-validation.mjs';
import { Localization, messageText, pseudolocalize } from '../src/localization.mjs';

const locale = {id: 'ar', name: 'Arabic', nativeName: 'العربية', direction: 'rtl'};
test('catalog validation rejects unknown keys, malformed messages and changed placeholders', () => {
  for (const messages of [
    {'unknown.caption': 'Unknown'}, {'common.save': '<b>Save</b>'},
    {'common.save': 'Save {bad'}, {'timeline.frameOf': 'Frame {wrong} of {total}'},
    {'timeline.selectedFrames': {one: '{count} frame'}},
    {'timeline.selectedFrames': {other: '{count} frames', banana: '{count} frames'}},
    {'common.save': '\u0000Save'}, {'common.save': ''},
  ]) assert.ok(validateCatalog({locale, messages}, english).errors.length, JSON.stringify(messages));
});
test('intentional fallback reports missing messages and language-specific plural forms', () => {
  const report = validateCatalog({locale, messages: {'timeline.selectedFrames': {other: '{count} frames'}}}, english);
  assert.deepEqual(report.errors, []);
  assert.ok(report.missing.includes('common.save'));
  assert.deepEqual(report.incompletePlurals, [{key:'timeline.selectedFrames', forms:['zero','one','two','few','many']}]);
});
test('fallback lookup and coverage stay accurate for incomplete and complete catalogs', async () => {
  // Exercise the real service with a deliberately partial registry, independently
  // of the supplied packs becoming complete or changing their wording.
  const messages = {'common.save': 'حفظ', 'timeline.selectedFrames': {other: '{count} إطار محدد'}};
  const forms = new Intl.PluralRules('ar').resolvedOptions().pluralCategories;
  const complete = Object.fromEntries(Object.entries(english).map(([key, value]) => [key,
    typeof value === 'string' ? value : Object.fromEntries(forms.map(form => [form, value.other]))]));
  const missingForm = structuredClone(complete);
  delete missingForm['timeline.selectedFrames'].few;
  const fixturePacks = [
    {locale: {id:'en', name:'English', nativeName:'English', direction:'ltr'}, messages:{}},
    {locale, messages},
    {locale: {...locale, id:'ar-EG'}, messages:complete},
    {locale: {...locale, id:'ar-SA'}, messages:missingForm},
  ];
  const fixtureLocales = fixturePacks.map(pack => pack.locale);
  const source = (await readFile(new URL('../src/localization.mjs', import.meta.url), 'utf8'))
    .replace("'./locales/en.mjs'", JSON.stringify(new URL('../src/locales/en.mjs', import.meta.url).href))
    .replace(/import locales from '[^']+';/, `const locales = ${JSON.stringify(fixtureLocales)};`);
  const {Localization: FixtureLocalization, registerLocale} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  for (const pack of fixturePacks) if (pack.locale.id !== 'en') registerLocale(pack.locale.id, pack.messages);
  const service = new FixtureLocalization({locale:'ar'});
  assert.equal(service.hasFallback, true);
  assert.equal(service.t('common.save'), 'حفظ');
  assert.equal(service.t('common.open'), english['common.open']);
  assert.equal(service.t('timeline.selectedFrames', {count:1}), `${new Intl.NumberFormat('ar').format(1)} selected frame`);
  assert.equal(service.t('timeline.selectedFrames', {count:3}), `${new Intl.NumberFormat('ar').format(3)} selected frames`);
  assert.equal(service.t('timeline.selectedFrames', {count:101}), `${new Intl.NumberFormat('ar').format(101)} إطار محدد`);
  service.setLocale('ar-EG');
  assert.equal(service.hasFallback, false);
  service.setLocale('ar-SA');
  assert.equal(service.hasFallback, true, 'a missing plural category also needs the notice');
  assert.equal(service.t('timeline.selectedFrames', {count:3}), `${new Intl.NumberFormat('ar-SA').format(3)} selected frames`);
  service.setLocale('en');
  assert.equal(service.hasFallback, false);
});
test('all independent packs validate against one authoritative English catalog', async () => {
  assert.deepEqual(validateCatalog({locale: {...locale, id:'en'}, messages: english}, english).errors, []);
  for (const file of await readdir('src/locales/packs')) {
    const pack = JSON.parse(await readFile(`src/locales/packs/${file}`, 'utf8'));
    assert.deepEqual(validateCatalog(pack, english).errors, [], file);
    for (const key of [
      'appDialogs.uiDialogDescPerformanceNote', 'settings.settingsFeedbackNote',
      'settings.message1pxSolid000', 'settings.message0pxSolidTransparent',
      'stageHead.handlesButton', 'stageHead.pathsButton', 'stageHead.vfxPreview',
      'stageHead.dataActionBuilderStaticHandles', 'stageHead.dataActionBuilderHighlight',
      'stageHead.dataActionToggleIsolate',
      'builderOutliner.text2',
      'tweenerControls.m12320121221412z',
    ]) if (Object.hasOwn(pack.messages, key)) assert.equal(pack.messages[key], english[key], `${file}:${key} is a machine value`);
  }
  assert.equal(messageText(null, 'settings.touchInterface'), 'Touch interface');
  assert.equal(messageText(null, 'inspector.mixed'), 'Mixed');
});
test('pseudo modes expand literal copy while preserving placeholders and locale preferences', () => {
  assert.ok(pseudolocalize('Save').length > 'Save'.length * 1.5);
  assert.ok(pseudolocalize('Frame {frame}', 'rtl').includes('{frame}'));
  const localization = new Localization();
  let calls = 0; localization.subscribe(() => calls++);
  localization.setPseudo('rtl');
  assert.equal(localization.direction, 'rtl'); assert.equal(localization.locale, 'en');
  assert.ok(localization.t('timeline.frameOf', {frame: 2, total: 10}).includes('2'));
  assert.equal(calls, 1);
  localization.setPseudo(null); assert.equal(localization.direction, 'ltr');
});
