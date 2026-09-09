import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SUPPORTED_LOCALES } from '../src/localization.mjs';

const output = path.resolve('artifacts/localization-native-app');
await mkdir(output,{recursive:true});
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1280,height:850},locale:'ar-EG'});
const checks=[],errors=[];
page.on('pageerror',error=>errors.push(error.message));
const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);console.log('PASS',name);};
async function settings() {
  await page.locator('.brand[data-action=menu]').click();
  await page.locator('#menu [data-action=settings]').click();
}
try {
  await page.goto(process.env.STYK_TEST_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(()=>window.styk?.ready&&styk.localization);
  check('Arabic browser preference still starts in explicit English',await page.evaluate(()=>styk.state.settings.locale==='en'));
  await page.evaluate(()=>styk.editor.newDocument());
  await page.locator('#inspector [data-property=root_x]').fill('325.125');
  await page.locator('#inspector [data-property=root_x]').press('Enter');
  await page.waitForFunction(()=>styk.editor.object.root_x===325.125);
  await page.evaluate(()=>{
    window.nativeLocaleBaseline={report:JSON.stringify(styk.editor.report),undo:styk.editor._undo.length,revision:styk.editor.revision,dirty:styk.editor.dirty,uid:styk.editor.selectedUid,tick:styk.editor.tick};
    window.nativeLocaleSave=document.querySelector('.titlebar [data-action=save]');
    window.nativeLocaleSVG=nativeLocaleSave.querySelector('svg');
  });
  await settings();
  check('Actual Settings has exactly all 27 supplied native language choices',await page.locator('[data-setting=locale] option').evaluateAll((options,ids)=>options.length===ids.length&&ids.every(id=>options.some(option=>option.value===id)),SUPPORTED_LOCALES.map(item=>item.id)));
  for (const item of SUPPORTED_LOCALES) {
    await page.locator('[data-setting=locale]').focus();
    await page.locator('[data-setting=locale]').selectOption(item.id);
    check(`Visible selector activates and retains ${item.name} (${item.id})`,await page.evaluate(id=>styk.state.settings.locale===id&&styk.localization.localization.locale===id&&document.documentElement.lang===id&&document.activeElement.dataset.setting==='locale'&&document.activeElement.value===id,item.id));
  }
  check('All 27 switches preserve exact document/history and original Save/icon nodes',await page.evaluate(()=>{
    const e=styk.editor,b=nativeLocaleBaseline;
    return JSON.stringify(e.report)===b.report&&e._undo.length===b.undo&&e.revision===b.revision&&e.dirty===b.dirty&&e.selectedUid===b.uid&&e.tick===b.tick&&document.querySelector('.titlebar [data-action=save]')===nativeLocaleSave&&nativeLocaleSave.querySelector('svg')===nativeLocaleSVG;
  }));
  await page.locator('[data-setting=locale]').selectOption('ar');
  check('Arabic source captions are readable while shell and timeline remain left-to-right',await page.evaluate(()=>document.querySelector('.titlebar [data-action=save]').textContent.trim()==='حفظ'&&document.querySelector('[data-setting=locale]').getAttribute('aria-label')==='اللغة'&&getComputedStyle(document.documentElement).direction==='ltr'&&getComputedStyle(document.querySelector('.timeline-title')).direction==='ltr'));
  check('Partial modern captions remain explicit English fallback',await page.locator('[data-locale-coverage]').textContent()==='Some controls are still shown in English.');
  await page.screenshot({path:path.join(output,'arabic-root-settings.png')});
  await page.locator('[data-setting=locale]').selectOption('he');
  check('Hebrew uses supplied Unicode Save text without altering document geometry',await page.evaluate(()=>document.querySelector('.titlebar [data-action=save]').textContent.trim()==='שמור'&&styk.editor.object.root_x===325.125));
  await page.locator('[data-setting=locale]').selectOption('zh-Hans');
  check('Chinese project Save/Open use animation captions rather than Builder asset captions',await page.evaluate(()=>document.querySelector('.titlebar [data-action=save]').textContent.trim()==='保存动画'&&document.querySelector('.titlebar [data-action=open]').textContent.trim()==='打开动画'));
  await page.setViewportSize({width:760,height:700});
  check('Native Chinese settings fit a compact window without horizontal overflow',await page.locator('.styk-settings').evaluate(dialog=>dialog.getBoundingClientRect().width<=innerWidth-30&&dialog.scrollWidth<=dialog.clientWidth&&dialog.querySelector('.styk-settings-content').scrollWidth<=dialog.querySelector('.styk-settings-content').clientWidth));
  await page.screenshot({path:path.join(output,'chinese-compact-settings.png')});
  await page.locator('[data-setting=locale]').selectOption('ar');
  await page.evaluate(()=>styk.settingsUI.flush());
  await page.reload();
  await page.waitForFunction(()=>window.styk?.ready&&styk.localization);
  check('Fresh actual app restores Arabic ID and captions from persisted settings',await page.evaluate(()=>styk.state.settings.locale==='ar'&&document.documentElement.lang==='ar'&&document.querySelector('.titlebar [data-action=save]').textContent.trim()==='حفظ'));
  await settings();
  await page.locator('[data-setting=locale]').selectOption('en');
  await page.evaluate(()=>styk.settingsUI.flush());
  check('Native language flow has no uncaught browser errors',errors.length===0);
  await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors,scope:'Actual root editor Settings and chrome with all 27 supplied language IDs; exact model/history preservation, Arabic browser reload, native Unicode captions and compact Chinese layout. Partial app text and LTR shell. Native desktop locale restart is separate.'},null,2));
} catch(error) {
  await page.screenshot({path:path.join(output,'failure.png')});
  await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors,failure:error.message},null,2));
  throw error;
} finally {await browser.close();}
