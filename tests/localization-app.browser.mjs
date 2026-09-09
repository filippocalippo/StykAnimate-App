import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('artifacts/localization-app');
await mkdir(output,{recursive:true});
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1280,height:850},locale:'it-IT'});
const checks = [], errors = [];
page.on('pageerror',error => errors.push(error.message));
page.on('dialog',dialog => dialog.accept());
const check = (name,condition) => { assert.ok(condition,name); checks.push(name); console.log('PASS',name); };
async function settings() {
  await page.locator('.brand[data-action=menu]').click();
  await page.locator('#menu [data-action=settings]').click();
}
try {
  await page.goto(process.env.STYK_TEST_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready && styk.localization && styk.settingsUI);
  check('Actual app starts in English despite Italian browser preferences',await page.evaluate(() => styk.state.settings.locale === 'en' && styk.localization.localization.locale === 'en' && document.documentElement.lang === 'en'));
  // Arrange a small real native document; the edit itself uses the visible field.
  await page.evaluate(() => styk.editor.newDocument());
  const input = page.locator('#inspector [data-property=root_x]');
  await input.waitFor({state:'visible'});
  const originalX = await page.evaluate(() => styk.editor.object.root_x);
  await input.fill('350.123456');
  await input.press('Enter');
  await page.waitForFunction(() => styk.editor.object.root_x === 350.123456 && styk.editor._undo.length > 0);
  await page.evaluate(() => {
    window.localeBaseline = {report:JSON.stringify(styk.editor.report),undo:styk.editor._undo.length,revision:styk.editor.revision,dirty:styk.editor.dirty,uid:styk.editor.selectedUid,tick:styk.editor.tick};
    window.savedButton = document.querySelector('.titlebar [data-action=save]');
    window.savedIcon = savedButton.querySelector('svg');
  });
  await settings();
  await page.locator('.styk-settings [data-setting=locale]').focus();
  await page.locator('.styk-settings [data-setting=locale]').selectOption('it');
  check('Actual Settings selector switches the shared app language and retains focus',await page.evaluate(() => styk.state.settings.locale === 'it' && styk.localization.localization.locale === 'it' && document.documentElement.lang === 'it' && document.activeElement.dataset.setting === 'locale'));
  check('Language changes preserve exact document bytes, undo count, revision, selection and tick',await page.evaluate(() => {
    const e=styk.editor,b=localeBaseline;
    return JSON.stringify(e.report)===b.report && e._undo.length===b.undo && e.revision===b.revision && e.dirty===b.dirty && e.selectedUid===b.uid && e.tick===b.tick;
  }));
  check('Root chrome translation preserves the same Save button and icon nodes',await page.evaluate(() => document.querySelector('.titlebar [data-action=save]')===savedButton && savedButton.querySelector('svg')===savedIcon && savedButton.textContent.trim()==='Salva'));
  await page.screenshot({path:path.join(output,'italian-root-settings.png')});
  await page.getByRole('button',{name:'Chiudi impostazioni',exact:true}).click();
  await page.evaluate(() => styk.settingsUI.flush());
  await page.locator('.brand[data-action=menu]').click();
  check('Actual menu lifecycle translates commands while retaining keyboard hints',await page.locator('#menu').evaluate(menu => menu.querySelector('[data-action=new] span').textContent==='Nuova animazione' && menu.querySelector('[data-action=save] span').textContent==='Salva' && menu.querySelector('[data-action=save] kbd').textContent==='Ctrl S'));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(value => styk.editor.object.root_x===value,originalX);
  check('The existing actual Undo command still restores the pre-language numeric edit',await page.evaluate(() => styk.editor._undo.length===localeBaseline.undo-1));
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(() => styk.editor.object.root_x===350.123456);
  check('Redo remains available after changing the interface language',await page.evaluate(() => styk.editor._undo.length===localeBaseline.undo));

  await page.keyboard.down('Control');
  await page.locator('#play-button').click();
  await page.keyboard.up('Control');
  check('Root preview updates the localized stop action',await page.evaluate(() => styk.state.previewing && document.querySelector('#play-button').getAttribute('aria-label')==='Ferma'));
  await page.locator('#play-button').click();
  check('Stopping preview restores the localized Play action',await page.locator('#play-button').getAttribute('aria-label')==='Riproduci');
  await page.reload();
  await page.waitForFunction(() => window.styk?.ready && styk.localization);
  check('Actual app reload restores Italian settings and translated chrome',await page.evaluate(() => styk.state.settings.locale==='it' && styk.localization.localization.locale==='it' && document.documentElement.lang==='it' && document.querySelector('.titlebar [data-action=open]').textContent.trim()==='Apri'));
  await settings();
  await page.locator('.styk-settings [data-setting=locale]').selectOption('en');
  await page.getByRole('button',{name:'Close settings',exact:true}).click();
  await page.evaluate(() => styk.settingsUI.flush());
  check('Actual app can return to English through the same visible control',await page.evaluate(() => styk.state.settings.locale==='en' && document.querySelector('.titlebar [data-action=save]').textContent.trim()==='Save'));
  check('Root language workflows have no uncaught browser errors',errors.length===0);
  await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors,scope:'Actual running browser app, visible field/settings/menu/undo/preview, and browser preference reload. Native desktop language restart is separate.'},null,2));
} catch(error) {
  await page.screenshot({path:path.join(output,'failure.png')});
  await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors,failure:error.message},null,2));
  throw error;
} finally { await browser.close(); }
