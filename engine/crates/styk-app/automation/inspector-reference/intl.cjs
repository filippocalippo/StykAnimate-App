// What the presentation's numbers and plural forms are compared with (engine/crates/styk-core/tests/presentation.rs):
// Intl.NumberFormat(locale).format and Intl.PluralRules(locale).select in today's app's own runtime, an Electron
// renderer (its ICU data is Chromium's, not Node's or another Chromium build's), for every catalogue locale.
//
//   node_modules/electron/dist/electron.exe engine/crates/styk-app/automation/inspector-reference/intl.cjs
//
// Writes engine/crates/styk-core/tests/support/intl_electron.json. The window is never shown.
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../../../..');
const locales = JSON.parse(fs.readFileSync(path.join(root, 'engine/crates/styk-core/locales/index.json'), 'utf8')).map(locale => locale.id);
const numbers = [0, 1, 2, 3, 5, 11, 21, 101, 1.5, 0.25, 12.5, -12.25, 1234, 12345.678, 1000000, 0.0005, 2.0004];

app.whenReady().then(async () => {
  const window = new BrowserWindow({show: false, webPreferences: {sandbox: true, contextIsolation: true}});
  await window.loadURL('about:blank');
  const intl = await window.webContents.executeJavaScript(`(${(locales, numbers) => Object.fromEntries(locales.map(locale => [locale, {
    // The locale and digits the number format resolved to: a locale Electron's ICU has no number data for resolves to
    // the system's default locale.
    numberLocale: new Intl.NumberFormat(locale).resolvedOptions().locale,
    numberingSystem: new Intl.NumberFormat(locale).resolvedOptions().numberingSystem,
    numbers: numbers.map(n => new Intl.NumberFormat(locale).format(n)),
    plurals: numbers.map(n => new Intl.PluralRules(locale).select(n)),
  }]))})(${JSON.stringify(locales)}, ${JSON.stringify(numbers)})`);
  const out = {electron: process.versions.electron, chrome: process.versions.chrome, icu: process.versions.icu, cldr: process.versions.cldr, numbers, locales: intl};
  fs.writeFileSync(path.join(root, 'engine/crates/styk-core/tests/support/intl_electron.json'), JSON.stringify(out, null, 1) + '\n');
  app.quit();
});
