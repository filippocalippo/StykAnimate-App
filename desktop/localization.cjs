'use strict';
// Electron and browser use the same DOM-free catalog service and data packs.
const path = require('node:path');
const { existsSync } = require('node:fs');
const source = existsSync(path.join(__dirname, '..', 'src', 'localization.mjs'))
  ? path.join(__dirname, '..', 'src') : path.join(process.resourcesPath, 'web', 'src');
const { Localization, normalizeLocale, registerLocale } = require(path.join(source, 'localization.mjs'));
const { messageError } = require(path.join(source, 'localized-error.mjs'));
const { validationLabel } = require(path.join(source, 'validation-labels.mjs'));
const localization = new Localization();
/** Switches to the language `value` names, loading only that language's messages; true when the language changed. */
function useLocale(value) {
  const id = normalizeLocale(value);
  if (id !== 'en') registerLocale(id, require(path.join(source, 'locales', 'messages', `${id}.mjs`)).default);
  return localization.setLocale(id);
}
module.exports = { validationLabel, localization, useLocale, messageError, t: (key, params) => localization.t(key, params) };
