import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {SUPPORTED_LOCALES} from '../src/localization.mjs';

const output = path.resolve('artifacts/localization-packs');
await mkdir(output, {recursive:true});
const browser = await chromium.launch({channel:'chrome', headless:true});
const page = await browser.newPage({viewport:{width:760, height:740}});
const checks = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
const check = (name, condition) => {assert.ok(condition, name); checks.push(name); console.log('PASS', name);};
const representatives = new Set(['ar', 'he', 'de', 'fr', 'fi', 'ru', 'vi', 'zh-Hans', 'el', 'tr', 'kk', 'id']);
const localeIndex = process.argv.indexOf('--locale');
const requested = localeIndex < 0 ? null : process.argv[localeIndex + 1];
const locales = SUPPORTED_LOCALES.filter(locale => locale.id !== 'en' && (!requested || locale.id === requested));
if (!locales.length) throw new Error('Choose a supplied non-English locale after --locale.');
const fits = element => {
  const bounds = element.getBoundingClientRect();
  return bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth + 1;
};
try {
  await page.goto(process.env.STYK_TEST_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready && styk.localization);
  await page.locator('.brand[data-action=menu]').click();
  await page.locator('#menu [data-action=settings]').click();
  for (const locale of locales) {
    await page.locator('[data-setting=locale]').selectOption(locale.id);
    await page.waitForFunction(id=>styk.localization.localization.locale===id,locale.id);
    check(`${locale.id}: selected language and interface direction are active`, await page.evaluate(locale =>
      styk.localization.localization.locale===locale.id&&document.documentElement.lang===locale.id&&document.documentElement.dir===locale.direction
      &&getComputedStyle(document.querySelector('.styk-settings')).direction===locale.direction,locale));
    check(`${locale.id}: complete messages and plurals do not show a fallback notice`, await page.evaluate(() =>
      !styk.localization.localization.hasFallback && !document.querySelector('[data-locale-coverage]')));
    for (const tab of ['interface', 'canvas', 'animation', 'shortcuts']) {
      await page.locator(`button[data-tab=${tab}]`).click();
      check(`${locale.id}: ${tab} settings fit a compact window`, await page.locator('.styk-settings-content').evaluate(fits));
    }
    await page.locator('button[data-tab=interface]').click();
    if (representatives.has(locale.id)) {
      await page.setViewportSize({width:390, height:740});
      for (const tab of ['interface','canvas','animation','shortcuts']) {
        await page.locator(`button[data-tab=${tab}]`).click();
        check(`${locale.id}: ${tab} captions fit narrow Settings`, await page.locator('.styk-settings').evaluate(element =>
          [element,element.querySelector('.styk-settings-head'),element.querySelector('.styk-settings-content')].every(node=>{
            const bounds=node.getBoundingClientRect();return bounds.left>=0&&bounds.right<=innerWidth&&node.scrollWidth<=node.clientWidth+1;
          })));
      }
      await page.locator('button[data-tab=interface]').click();
      await page.screenshot({animations:'disabled',path:path.join(output, `${locale.id}-narrow-settings.png`)});
    }
    await page.locator('.styk-settings-close').click();
    await page.locator('.titlebar [data-action=export]').click();
    await page.locator('#export-dialog[open]').waitFor();
    check(`${locale.id}: export dialog fits and preserves physical numeric direction`, await page.locator('#export-dialog').evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const numbers = [...element.querySelectorAll('input[inputmode=numeric], input[inputmode=decimal]')];
      const body = element.querySelector('.ui-dialog-body'), strip = element.querySelector('.ui-range-strip');
      return bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth + 1
        && body.scrollWidth <= body.clientWidth + 1 && getComputedStyle(strip).direction === 'ltr'
        && numbers.length >= 6 && numbers.every(input => getComputedStyle(input).direction === 'ltr');
    }));
    check(`${locale.id}: export actions wrap without clipped text`, await page.locator('#export-dialog .ui-dialog-foot button').evaluateAll(buttons =>
      buttons.length >= 2 && buttons.every(button => button.scrollWidth <= button.clientWidth + 1 && button.scrollHeight <= button.clientHeight + 1)));
    if (representatives.has(locale.id)) await page.screenshot({animations:'disabled',path:path.join(output, `${locale.id}-narrow-export.png`)});
    await page.locator('#export-dialog .ui-dialog-close').click();
    check(`${locale.id}: translated timeline actions remain inside the window`, await page.locator('.tl-head button').evaluateAll(buttons => {
      const visible=buttons.filter(button=>button.offsetParent!==null);
      return visible.length>0&&visible.every(button=>{const bounds=button.getBoundingClientRect();return bounds.left>=0&&bounds.right<=innerWidth;});
    }));
    await page.setViewportSize({width:760, height:740});
    await page.locator('.brand[data-action=menu]').click();
    await page.locator('#menu [data-action=settings]').click();
  }
  check('Completed packs produce no uncaught browser errors', errors.length === 0);
  await writeFile(path.join(output, requested ? `${requested}-report.json` : 'report.json'), JSON.stringify({checks, errors, locales:locales.map(locale => locale.id), scope:'All 26 translated Settings tabs at 760px; twelve representatives also at 390px. Export/timeline bounds at 390px for those twelve and at 760px for the other fourteen. Linux browser fonts only.'}, null, 2));
} catch (error) {
  await page.screenshot({animations:'disabled',path:path.join(output, 'failure.png')});
  await writeFile(path.join(output, 'report.json'), JSON.stringify({checks, errors, failure:error.message}, null, 2));
  throw error;
} finally {await browser.close();}
