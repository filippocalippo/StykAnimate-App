import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.STYK_TEST_URL || 'http://127.0.0.1:47831';
const output = path.resolve('artifacts/localization-settings');
await mkdir(output, {recursive:true});
const browser = await chromium.launch({channel:'chrome',headless:true});
const context = await browser.newContext({viewport:{width:1000,height:740},locale:'it-IT'});
const page = await context.newPage(), checks = [], errors = [];
page.on('pageerror',error => errors.push(error.message));
const check = (name, condition) => { assert.ok(condition,name); checks.push(name); console.log('PASS',name); };
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/src/style.css"><style>#app{display:block}#app>.titlebar{height:48px}#app>input{display:block;margin:12px}</style></head><body>
<div id="app"><header class="titlebar"><button data-action="open"><svg id="open-icon"></svg>Open</button><button data-action="save"><svg></svg>Save</button><button data-action="export">Export<span class="chevron">⌄</span></button></header>
<input id="project-name" value="My animation"><input id="draft-value" value="12.375"><input id="layer-search" placeholder="Search layers"><div class="timeline-title">Timeline</div>
<button id="play-button" aria-label="Play"></button><div id="menu"></div><div id="explicit"><button data-i18n="common.cancel">Cancel</button></div></div></body></html>`;
await page.route('**/localization-fixture',route => route.fulfill({contentType:'text/html',body:fixture}));

async function setup() {
  await page.goto(base + '/localization-fixture');
  await page.evaluate(async () => {
    // Catch a regression to observing every DOM/animation mutation.
    const NativeObserver = window.MutationObserver;
    window.localeObservers = [];
    window.MutationObserver = class extends NativeObserver {
      constructor(callback) {
        super(callback);
        const stack = new Error().stack;
        if (!stack.includes('InjectedScript')) localeObservers.push(stack);
      }
    };
    const {AppLocalization} = await import('/src/localization-bindings.mjs');
    const {EditorSettings,EDITOR_SETTINGS_KEY} = await import('/src/settings.mjs');
    const saved = JSON.parse(localStorage.getItem(EDITOR_SETTINGS_KEY) || 'null');
    window.localeApp = new AppLocalization({locale:saved?.locale});
    localeApp.bindChrome();
    localeApp.apply(document.querySelector('#explicit'));
    window.localePatches = [];
    window.localeSettings = new EditorSettings({
      localization:localeApp.localization,
      onChange:(patch,next) => { localePatches.push({patch,next}); localeApp.setLocale(next.locale); },
      onResetWorkspace:() => {},
    });
    window.originalIcon = document.querySelector('#open-icon');
    window.openClicks = 0;
    document.querySelector('[data-action=open]').onclick = () => openClicks++;
  });
}

try {
  await setup();
  check('Italian OS locale still starts the editor in explicit default English', await page.evaluate(() => navigator.language === 'it-IT' && localeSettings.value.locale === 'en' && document.documentElement.lang === 'en'));
  await page.evaluate(() => localeSettings.open());
  check('Settings exposes all 27 supplied Pivot languages with distinct regional variants', await page.locator('[data-setting=locale] option').evaluateAll(options => options.length === 27 && ['ar','he','zh-Hans','es-419','pt-BR','it','en'].every(id => options.some(option => option.value === id))));
  await page.locator('[data-setting=locale]').focus();
  await page.locator('[data-setting=locale]').selectOption('it');
  check('Selecting Italian updates settings headings, descriptions and mode controls', await page.locator('.styk-settings').evaluate(dialog => dialog.lang === 'it' && dialog.querySelector('h2').textContent === 'Impostazioni' && dialog.textContent.includes('Miniature e intercalazioni') && dialog.textContent.includes('Avanzata')));
  check('Language is a normalized settings patch and not a document operation', await page.evaluate(() => JSON.stringify(localePatches.at(-1).patch) === '{"locale":"it"}'));
  check('Language selector keeps focus through its localized redraw', await page.evaluate(() => document.activeElement.dataset.setting === 'locale' && document.activeElement.value === 'it'));
  check('Partial language coverage is stated in the chosen language', await page.locator('[data-locale-coverage]').textContent() === 'Alcuni comandi sono ancora visualizzati in inglese.');
  check('Static chrome captions and accessible placeholders update without changing inputs', await page.evaluate(() => document.documentElement.lang === 'it' && document.querySelector('[data-action=open]').textContent === 'Apri' && document.querySelector('#layer-search').placeholder === 'Cerca livelli' && document.querySelector('#project-name').value === 'My animation' && document.querySelector('#draft-value').value === '12.375'));
  check('Translated buttons preserve original icons and other child elements', await page.evaluate(() => document.querySelector('#open-icon') === originalIcon && document.querySelector('[data-action=export] .chevron').textContent === '⌄'));
  await page.screenshot({path:path.join(output,'italian-settings.png')});
  await page.getByRole('button',{name:'Chiudi impostazioni',exact:true}).click();
  await page.evaluate(() => localeSettings.flush());
  await page.locator('[data-action=open]').click();
  check('Translating a caption preserves the existing click handler', await page.evaluate(() => openClicks === 1));

  await page.evaluate(() => {
    const menu = document.querySelector('#menu');
    menu.innerHTML = '<button data-action="save"><svg></svg><span>Save</span><kbd>Ctrl S</kbd></button><button data-action="open-recent"><svg></svg><span>Open recent…</span></button><button data-action="not-mapped"><span>Custom command</span></button>';
    localeApp.applyMenu(menu);
  });
  check('Explicit menu lifecycle translates known actions and preserves shortcuts/custom entries', await page.locator('#menu').evaluate(menu => menu.querySelector('[data-action=save] span').textContent === 'Salva' && menu.querySelector('kbd').textContent === 'Ctrl S' && menu.querySelector('[data-action=open-recent] span').textContent === 'Apri recenti…' && menu.querySelector('[data-action=not-mapped] span').textContent === 'Custom command'));
  await page.evaluate(() => { localeApp.updatePlayback(document.querySelector('#play-button'),{playing:true}); localeApp.setLocale('en'); });
  check('A locale change preserves the current playback action instead of resetting it to Play', await page.locator('#play-button').getAttribute('aria-label') === 'Pause');
  await page.evaluate(() => localeApp.setLocale('it'));
  check('Explicit translated subtrees follow later language changes', await page.locator('#explicit button').textContent() === 'Annulla');
  await page.evaluate(() => {
    const menu = document.querySelector('#menu');
    for (let i=0;i<100;i++) { menu.innerHTML = '<button data-action="save"><span>Save</span></button>'; localeApp.applyMenu(menu); }
  });
  check('Repeated menu replacements retain a bounded set of connected label bindings', await page.evaluate(() => localeApp.elements.size < 15 && [...localeApp.elements].every(element => element.isConnected)));

  await setup();
  check('A fresh page restores Italian through the existing settings persistence', await page.evaluate(() => localeSettings.value.locale === 'it' && localeApp.localization.locale === 'it' && document.documentElement.lang === 'it' && document.querySelector('[data-action=save]').textContent === 'Salva'));
  await page.setViewportSize({width:560,height:650});
  await page.evaluate(() => localeSettings.open());
  check('Localized settings fit the compact window without horizontal clipping', await page.locator('.styk-settings').evaluate(dialog => dialog.getBoundingClientRect().width <= innerWidth - 30 && dialog.scrollWidth <= dialog.clientWidth && dialog.querySelector('.styk-settings-content').scrollWidth <= dialog.querySelector('.styk-settings-content').clientWidth));
  await page.screenshot({path:path.join(output,'compact-italian-settings.png')});
  await page.locator('[data-setting=locale]').selectOption('en');
  check('Switching back to English restores captions and removes the partial-language note', await page.evaluate(() => document.querySelector('.styk-settings h2').textContent === 'Settings' && document.querySelector('[data-action=open]').textContent === 'Open' && !document.querySelector('[data-locale-coverage]')));
  await page.evaluate(async () => { await localeSettings.destroy(); localeApp.destroy(); });
  check('Destroy releases settings DOM and locale subscriptions', await page.evaluate(() => !document.querySelector('.styk-settings') && localeApp.elements.size === 0 && localeApp.localization.listeners.size === 0));
  check('Localization causes no uncaught browser errors or MutationObserver use', errors.length === 0 && await page.evaluate(() => localeObservers.length === 0));
  await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors,scope:'Actual Settings component and explicit app-label bindings on the live server; root lifecycle wiring has separate acceptance.'},null,2));
} catch (error) {
  await page.screenshot({path:path.join(output,'failure.png')});
  await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors,failure:error.message},null,2));
  throw error;
} finally { await browser.close(); }
