import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Localization, normalizeLocale, SUPPORTED_LOCALES } from '../src/localization.mjs';
import catalogs from '../src/locales/native-catalogs.mjs';
import english from '../src/locales/en.mjs';
import { parsePivotLanguage, mapPivotCaptions, MAX_LANGUAGE_BYTES } from '../src/locales/pivot-language.mjs';

test('all 27 native languages resolve, are distinct and preserve readable source captions', () => {
  assert.equal(SUPPORTED_LOCALES.length,27);
  assert.equal(new Set(SUPPORTED_LOCALES.map(item=>item.id)).size,27);
  for (const item of SUPPORTED_LOCALES) {
    const locale = new Localization({locale:item.id});
    assert.equal(locale.locale,item.id);
    assert.equal(locale.direction,['ar','he'].includes(item.id)?'rtl':'ltr');
    assert.ok(locale.t('common.save').length);
    assert.equal(locale.t('diagnostics.renderer'),'Renderer');
    assert.ok(Object.isFrozen(catalogs[item.id]));
    for (const [key,value] of Object.entries(catalogs[item.id])) {
      assert.ok(Object.hasOwn(english,key),`${item.id}:${key}`);
      assert.ok(!/[\uFFFD\u0000-\u001F]/.test(value),`${item.id}:${key}`);
    }
  }
  assert.equal(new Localization({locale:'ar'}).t('common.save'),'حفظ');
  assert.equal(new Localization({locale:'zh-Hans'}).t('common.save'),'保存动画');
  assert.equal(new Localization({locale:'cs'}).t('common.save'),'Uložit');
  assert.equal(new Localization({locale:'tr'}).t('common.cancel'),'İptal');
  assert.equal(new Localization({locale:'vi'}).t('common.save'),'Lưu');
});

test('regional language normalization preserves supplied variants without claiming unsupported scripts', () => {
  for (const [input,expected] of Object.entries({'es-MX':'es-419','es-419':'es-419','es-ES':'es','pt-br':'pt-BR','pt':'pt-BR','zh':'zh-Hans','zh-CN':'zh-Hans','zh-Hans-SG':'zh-Hans','zh-Hans-TW':'zh-Hans','no-NO':'nb','nb-NO':'nb','he-IL':'he','de-DE':'de'})) assert.equal(normalizeLocale(input),expected,input);
  for (const input of ['zh-Hant','zh-TW','zh-HK','zh-Latn','pt-PT','nn-NO','ja']) assert.equal(normalizeLocale(input),'en',input);
});

test('known native translation defects fall back instead of showing a false command', () => {
  assert.equal(new Localization({locale:'pt-BR'}).t('common.cancel'),'Cancel');
  assert.equal(new Localization({locale:'it'}).t('common.cancel'),'Annulla');
  assert.equal(new Localization({locale:'zh-Hans'}).t('chrome.open'),'打开动画');
});

test('native parser decodes BOM Unicode and deliberate ANSI code pages', () => {
  const utf16 = Buffer.concat([Buffer.from([255,254]),Buffer.from('[Language]\r\nBSave=حفظ\r\n','utf16le')]);
  assert.equal(parsePivotLanguage(utf16).BSave,'حفظ');
  const utf8 = Buffer.concat([Buffer.from([239,187,191]),Buffer.from('BSave=Lưu')]);
  assert.equal(parsePivotLanguage(utf8).BSave,'Lưu');
  assert.equal(parsePivotLanguage(Buffer.from([66,83,97,118,101,61,85,108,111,0x9e,105,116]),{legacyEncoding:'windows-1250'}).BSave,'Uložit');
  assert.throws(()=>parsePivotLanguage(Buffer.from([255,254,65])),/encoded data/);
  assert.throws(()=>parsePivotLanguage(Buffer.from('x'),{legacyEncoding:'utf-7'}),/encoding/);
});

test('native parser is bounded plain data and cannot create prototype properties or execute captions', () => {
  const parsed = parsePivotLanguage(';comment\n[Language]\nBSave=<img src=x onerror=evil()>\nconstructor=evil\n__proto__=evil\nprototype=evil\nBOpen=Open=literal');
  assert.equal(Object.getPrototypeOf(parsed),null);
  assert.ok(Object.isFrozen(parsed));
  assert.equal(parsed.BSave,'<img src=x onerror=evil()>');
  assert.equal(parsed.BOpen,'Open=literal');
  assert.equal(Object.hasOwn(parsed,'constructor'),false);
  assert.throws(()=>parsePivotLanguage(new Uint8Array(MAX_LANGUAGE_BYTES+1)),/too large/);
  assert.throws(()=>parsePivotLanguage('BSave='+ 'x'.repeat(4097)),/invalid text/);
  assert.throws(()=>parsePivotLanguage('BSave=bad\0text'),/invalid text/);
  assert.throws(()=>parsePivotLanguage(Array.from({length:2049},(_,i)=>`K${i}=x`).join('\n')),/too many/);
});

test('semantic mapping excludes hints, absent values and app placeholder substitutions', () => {
  const baseline = parsePivotLanguage('BSave=Save\nBOpen=Open');
  const mapped = mapPivotCaptions(parsePivotLanguage('BSave=Salva\nBOpen=Open\nMPlayHint=Wrong shortcut\nMFNew={frame}'),baseline);
  assert.equal(mapped['common.save'],'Salva');
  assert.equal(Object.hasOwn(mapped,'common.open'),false);
  assert.equal(Object.hasOwn(mapped,'menu.newAnimation'),false);
  assert.ok(!Object.values(mapped).includes('Wrong shortcut'));
});

test('generated catalogs match the exact supplied bytes, explicit encodings and semantic map', async () => {
  const inventory = JSON.parse(await readFile(new URL('../artifacts/localization-native-inventory.json',import.meta.url),'utf8'));
  const baseline = parsePivotLanguage(await readFile(new URL('../../Pivot Animator v5/languages/English.ini',import.meta.url)));
  for (const item of inventory.files) {
    const bytes = await readFile(new URL(`../../Pivot Animator v5/languages/${item.file}`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256,item.file);
    const options = item.encoding.startsWith('windows-')?{legacyEncoding:item.encoding}:{};
    assert.deepEqual({...mapPivotCaptions(parsePivotLanguage(bytes,options),baseline,{locale:item.locale})},{...catalogs[item.locale]},item.file);
  }
});
