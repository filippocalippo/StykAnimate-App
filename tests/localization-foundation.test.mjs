import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import english from '../src/locales/en.mjs';
import italian from '../src/locales/messages/it.mjs';
import {parseLanguagePack, validateCatalog, mergeEnglishMessages} from '../src/locales/catalog-validation.mjs';
import {inspectMessageReferences, inspectApplicationMessages} from '../scripts/localization-source.mjs';
import {messageError, restoreMessageError, errorMessageData} from '../src/localized-error.mjs';
import {errorText} from '../src/error-presentation.mjs';
import {interfaceLocalization, Localization, loadLocales} from '../src/localization.mjs';

await loadLocales();
import {messageTuple, tupleMessages} from '../src/localization-bindings.mjs';
import {menuKeyAction} from '../src/ui/ui-menu.mjs';

test('packs reject repeated, escaped duplicate and malformed JSON keys', () => {
  assert.deepEqual(parseLanguagePack('{"locale":{},"messages":{}}'), {locale:{}, messages:{}});
  for (const source of ['{"save":"a","save":"b"}', '{"save":"a","s\\u0061ve":"b"}', '{"a":true,}', '{"a":[1,]}', '{} {}', '[', ' '.repeat(1024 * 1024 + 1)])
    assert.throws(() => parseLanguagePack(source), SyntaxError);
  assert.ok(validateCatalog(null, english).errors.length);
});

test('source validation reports static unknown bindings and produces review context', async () => {
  const source = `interfaceText('common.save');\n({labelKey:'missing.caption'});\n'<span data-i18n="missing.html">Caption</span>';\nlocalizedText(node,'missing.text');\nlocalizedAttribute(node,'title','missing.title')`;
  const report = inspectMessageReferences(source, 'example.mjs', english);
  assert.deepEqual(report.references.map(x => [x.key, x.line]), [['common.save',1]]);
  assert.equal(report.errors.length, 4);
  assert.deepEqual((await inspectApplicationMessages(english)).errors, []);
});

test('errors preserve class, diagnostic numbers, codes and transport metadata', () => {
  const key = Object.keys(english).find(k => k.startsWith('errors.') && typeof english[k] === 'string' && english[k].includes('{'));
  const params = Object.fromEntries([...english[key].matchAll(/\{(\w+)\}/g)].map(m => [m[1], 1234.5]));
  const error = messageError(Object.assign(new RangeError(), {code:'EXAMPLE'}), key, params);
  assert.ok(error instanceof RangeError); assert.equal(error.code, 'EXAMPLE');
  assert.ok(error.message.includes('1234.5')); assert.ok(!error.message.includes('1,234.5'));
  const restored = restoreMessageError(new Error(error.message), structuredClone(errorMessageData(error)));
  assert.equal(restored.message, error.message);
  interfaceLocalization.setPseudo('rtl');
  try { assert.notEqual(errorText(restored), error.message); assert.equal(error.message, restored.message); }
  finally { interfaceLocalization.setPseudo(null); }
  assert.equal(restoreMessageError(new Error('OS detail'), {messageKey:'unknown.key'}).message, 'OS detail');
  const abort = messageError(new DOMException('', 'AbortError'), key, params);
  assert.equal(abort.name, 'AbortError'); assert.equal(abort.code, 20);
});

test('sandboxed preload uses the same generated diagnostic constructor without Node imports', async () => {
  const preload = await readFile('desktop/preload.cjs', 'utf8');
  const bundle = preload.match(/\/\/ BEGIN generated localization diagnostics([\s\S]+?)\/\/ END generated localization diagnostics/)[1];
  const context = vm.createContext({});
  const message = vm.runInContext(`${bundle}\nmessageError(new RangeError(), 'desktop.preload.errors.uiScaleMustBe75200InStepsOf5').message`, context);
  assert.equal(message, english['desktop.preload.errors.uiScaleMustBe75200InStepsOf5']);
  const nested=vm.runInContext(`diagnosticError(new RangeError(), '{label} must be finite.', 'field.check', {label:{messageKey:'errors.editorCamera.cameraValueLabel',messageParams:{field:'angle_rad'},diagnosticValue:'Camera angle_rad'}})`,context);
  assert.equal(nested.message,'Camera angle_rad must be finite.');
  assert.equal(nested.messageParams.label.messageParams.field,'angle_rad');
  assert.doesNotMatch(preload, /require\(['"]\.\/localization/);
});

test('presentation references and precise numbers resolve in the selected language', () => {
  const localization = new Localization({locale:'it'});
  assert.equal(localization.t('quick.unavailable', {label:{messageKey:'common.save'},reason:'Example'}), 'Salva (Example)');
  const source = italian['app.savedAt'] ?? english['app.savedAt'];
  const result = localization.t('app.savedAt', {time:{format:'date',value:Date.UTC(2026,0,1,12,5),options:{hour:'numeric',minute:'2-digit',timeZone:'UTC'}}});
  assert.equal(result, source.replace('{time}', new Intl.DateTimeFormat('it',{hour:'numeric',minute:'2-digit',timeZone:'UTC'}).format(Date.UTC(2026,0,1,12,5))));
});

test('Build part captions follow language changes while icon IDs and authored names stay intact', async () => {
  interfaceLocalization.setPseudo('long');
  try {
    const {partName, partNameMessage, partGlyph} = await import('../src/builder-outliner.mjs?locale-review');
    const segment = {primitive_code:5, segment_id:12};
    assert.equal(partGlyph(segment), 'text', 'localized text is never an icon identifier');
    const reference=partNameMessage(segment);
    assert.equal(reference.messageKey,'builderOutliner.partNumber');
    assert.deepEqual(reference.messageParams,{kind:{messageKey:'builderOutliner.text'},id:12});
    assert.equal(partName(segment), interfaceLocalization.t(reference.messageKey,reference.messageParams));
    interfaceLocalization.setPseudo(null);
    assert.equal(partName(segment), 'Text 12', 'the caption resolves again after a language change');
    assert.equal(partName({...segment, name:'My authored text'}), 'My authored text');
  } finally { interfaceLocalization.setPseudo(null); }
});

test('tuple bindings do not change arrays or serialized action and shortcut values', () => {
  const row = ['delete','trash','Delete','Delete',false];
  const bytes = JSON.stringify(row);
  assert.equal(messageTuple(row,{2:{key:'common.delete'}}),row);
  assert.deepEqual(Object.keys(row),['0','1','2','3','4']);
  assert.equal(JSON.stringify(row),bytes); assert.equal(tupleMessages(row)[2].key,'common.delete');
});

test('RTL menus reverse submenu navigation without reversing vertical or chronological arrows', () => {
  const state = {index:0,count:3,submenu:true,direction:'rtl'};
  assert.deepEqual(menuKeyAction({key:'ArrowLeft'},state),{type:'open-submenu'});
  assert.deepEqual(menuKeyAction({key:'ArrowRight'},{...state,nested:true}),{type:'close-submenu'});
  assert.deepEqual(menuKeyAction({key:'ArrowDown'},state),{type:'move',index:1});
});

test('English ownership and locale plural categories are validated', () => {
  assert.throws(() => mergeEnglishMessages({'common.save':'Save'}, {'common.save':'Save'}), /defined twice/);
  const locale = {id:'en',name:'English',nativeName:'English',direction:'ltr'};
  const plural = Object.keys(english).find(key => typeof english[key] === 'object');
  const report = validateCatalog({locale, messages:{[plural]: {...english[plural], few:english[plural].other}}},english);
  assert.ok(report.errors.some(error => error.includes('invalid plural form few')));
});

test('brush and effect presentation never enter machine definitions', async () => {
  const {BRUSH_PRESETS, presetGrid} = await import('../src/drawing-view.mjs');
  const {VFX_REGISTRY} = await import('../src/vfx-registry.mjs');
  const before = JSON.stringify({BRUSH_PRESETS,VFX_REGISTRY});
  assert.ok(BRUSH_PRESETS.every(preset => !Object.keys(preset).some(key => key.endsWith('Key'))));
  interfaceLocalization.setPseudo('long');
  try {
    assert.equal(JSON.stringify({BRUSH_PRESETS,VFX_REGISTRY}),before);
    const markup = presetGrid({settings:{preset:'ink'},library:{presets:[]}});
    assert.ok(markup.includes('data-i18n-title="drawingView.crispPressureSensitiveLines"'));
  } finally { interfaceLocalization.setPseudo(null); }
});


test('support vocabulary localizes presentation while shared service codes remain unchanged', async () => {
  const shared=await import('../src/support-contract.mjs');
  const {SUPPORT_CATEGORIES,supportErrorMessage}=await import('../src/support-localization.mjs');
  const before=JSON.stringify([shared.SUPPORT_CATEGORIES,shared.SUPPORT_STATUSES,shared.SUPPORT_PRIORITIES]);
  assert.equal(interfaceLocalization.t(SUPPORT_CATEGORIES.bug.messageKey),shared.SUPPORT_CATEGORIES.bug);
  assert.equal(errorText(supportErrorMessage({code:'invalid_message'})),shared.supportError({code:'invalid_message'}));
  interfaceLocalization.setPseudo('rtl');
  try {
    assert.ok(errorText(supportErrorMessage({code:'invalid_message'})).includes('اختبار'));
    assert.equal(JSON.stringify([shared.SUPPORT_CATEGORIES,shared.SUPPORT_STATUSES,shared.SUPPORT_PRIORITIES]),before);
  } finally {interfaceLocalization.setPseudo(null);}
});

test('import notice presentation leaves stored warnings and recovery records untouched', async () => {
  const {importWarningMessage}=await import('../src/import-notes-localization.mjs');
  const warning={code:'piv_missing_image_data',message:'Original diagnostic'},report={piv_missing_images:[{figure_name:'My figure'}]};
  const before=JSON.stringify({warning,report});
  const caption=importWarningMessage(warning,report);
  assert.equal(caption.messageParams.count,1);
  assert.ok(errorText(caption).includes('My figure'));
  assert.equal(JSON.stringify({warning,report}),before);
  assert.equal(importWarningMessage({code:'external',message:'External detail'}).message,'External detail');
});

