import english from './locales/en.mjs';
import locales from './locales/locale-index.mjs';

export const DEFAULT_LOCALE = 'en';
export const SUPPORTED_LOCALES = Object.freeze([...locales].sort((a, b) => a.id === 'en' ? -1 : b.id === 'en' ? 1 : a.name.localeCompare(b.name, 'en')));
const known = Object.freeze(Object.fromEntries(locales.map(locale => [locale.id, true])));
const aliases = Object.freeze(Object.fromEntries(locales.flatMap(locale => (locale.aliases ?? []).map(alias => [alias, locale.id]))));
/** The messages of every language loaded so far. English is always there; the others are separate modules
 * (locales/messages/<id>.mjs) that `loadLocale` brings in, so a session carries one language, not all of them. */
const catalogs = {en: english};
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const MAX_FORMATTERS = 16;
const LOADING = 'Load the interface language before choosing it.';

function supportedLocale(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return null;
  try {
    const canonical = Intl.getCanonicalLocales(value)[0];
    if (owns(known, canonical)) return canonical;
    const parsed = new Intl.Locale(canonical), base = parsed.baseName;
    if (owns(known, base)) return base;
    if (owns(aliases, base)) return aliases[base];
    // A script request never crosses scripts. A language-only pack may serve
    // regional preferences; region-specific packs need explicit aliases.
    if (parsed.script) {
      const script = `${parsed.language}-${parsed.script}`;
      return owns(known, script) ? script : null;
    }
    return owns(known, parsed.language) ? parsed.language : null;
  } catch { return null; }
}

/** Persist a supported language ID; invalid or unimplemented preferences use English. */
export function normalizeLocale(value) { return supportedLocale(value) ?? DEFAULT_LOCALE; }
export function isSupportedLocale(value) { return supportedLocale(value) !== null; }

/** Hands the messages of language `id` to the service (the desktop main process requires its module itself; see `loadLocale`). */
export function registerLocale(id, messages) {
  if (!owns(known, id) || id === DEFAULT_LOCALE) throw new RangeError('Unknown interface language.');
  catalogs[id] = messages;
}

/**
 * Loads the messages of the language `value` names (a tag as `normalizeLocale` takes), once; resolves to its ID.
 * `Localization` switches only to languages loaded here, so the owner of a language choice (the saved setting at
 * startup, the language picker) awaits this before it chooses.
 */
export async function loadLocale(value) {
  const id = normalizeLocale(value);
  if (!owns(catalogs, id)) registerLocale(id, (await import(`./locales/messages/${id}.mjs`)).default);
  return id;
}

/** Loads the given languages, by default all of them (tools and tests that switch between languages). */
export async function loadLocales(ids = SUPPORTED_LOCALES.map(locale => locale.id)) {
  await Promise.all(ids.map(loadLocale));
}

/**
 * Plain-text, DOM-free catalog service. It schedules no work and touches no
 * animation/model state. UI owners subscribe once and refresh labels only when
 * the user changes language. Rendered templates must still escape returned text.
 */
export class Localization {
  constructor({ locale = DEFAULT_LOCALE, pseudo = null } = {}) {
    this.locale = normalizeLocale(locale);
    if (!owns(catalogs, this.locale)) throw new RangeError(LOADING);
    this.listeners = new Set();
    this.formatters = new Map();
    this.pseudo = pseudo;
  }

  get direction() { return this.pseudo === 'rtl' ? 'rtl' : SUPPORTED_LOCALES.find(item => item.id === this.locale).direction; }

  /** Coverage describes missing messages/forms, not translation quality. */
  get hasFallback() {
    if (this.locale === DEFAULT_LOCALE) return false;
    const catalog = catalogs[this.locale];
    const categories = this.formatter('plural').resolvedOptions().pluralCategories;
    for (const key in english) {
      if (!owns(catalog, key)) return true;
      if (typeof english[key] !== 'string' && categories.some(category => !owns(catalog[key], category))) return true;
    }
    return false;
  }

  /** Development-only layout stress, never a persisted production language. */
  setPseudo(pseudo = null) {
    if (![null, 'long', 'rtl'].includes(pseudo)) throw new RangeError('Unknown pseudolocalization mode.');
    if (pseudo === this.pseudo) return false;
    this.pseudo = pseudo;
    for (const listener of this.listeners) listener(Object.freeze({locale: this.locale, previousLocale: this.locale, direction: this.direction}));
    return true;
  }

  setLocale(value) {
    const locale = supportedLocale(value);
    if (!locale) throw new RangeError('Choose a supported interface language.');
    if (locale === this.locale) return false;
    if (!owns(catalogs, locale)) throw new RangeError(LOADING);
    const previousLocale = this.locale;
    this.locale = locale;
    this.formatters.clear();
    const change = Object.freeze({ locale, previousLocale, direction: this.direction });
    for (const listener of this.listeners) listener(change);
    return true;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('A language listener must be a function.');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  formatter(kind, options = {}) {
    // Only presentation calls format values; numeric editor inputs keep their
    // existing unambiguous parser and native model units.
    const normalized = Object.fromEntries(Object.entries(options).sort(([a], [b]) => a.localeCompare(b)));
    const key = `${kind}:${JSON.stringify(normalized)}`;
    let formatter = this.formatters.get(key);
    if (!formatter) {
      const Constructor = kind === 'number' ? Intl.NumberFormat : kind === 'date' ? Intl.DateTimeFormat : kind === 'list' ? Intl.ListFormat : Intl.PluralRules;
      formatter = new Constructor(this.locale, normalized);
      if (this.formatters.size >= MAX_FORMATTERS) this.formatters.delete(this.formatters.keys().next().value);
      this.formatters.set(key, formatter);
    }
    return formatter;
  }

  formatNumber(value, options) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError('A displayed number must be finite.');
    return this.formatter('number', options).format(value);
  }

  formatDate(value, options) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new RangeError('A displayed date must be valid.');
    return this.formatter('date', options).format(date);
  }

  t(key, params = {}, depth = 0) {
    if (typeof key !== 'string' || !key || key.length > 160) throw new TypeError('A translation key must be a short nonempty string.');
    const localized = catalogs[this.locale];
    const translated = owns(localized, key);
    let message = translated ? localized[key] : owns(english, key) ? english[key] : key;
    if (typeof message !== 'string') {
      const category = typeof params.count === 'number' && Number.isFinite(params.count)
        ? (translated ? this.formatter('plural') : ENGLISH_PLURALS).select(params.count) : 'other';
      message = message[category] ?? (owns(english, key) && typeof english[key] === 'object'
        ? english[key][ENGLISH_PLURALS.select(params.count)] ?? english[key].other : message.other);
    }
    if (this.pseudo && owns(english, key)) message = pseudolocalize(message, this.pseudo);
    return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name) => {
      if (!owns(params, name)) return token;
      const value = params[name];
      if (typeof value === 'string') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return this.formatNumber(value);
      if (value && typeof value === 'object' && depth < 8) {
        if (owns(value, 'messageKey') && typeof value.messageKey === 'string') return this.t(value.messageKey, value.messageParams, depth + 1);
        if (value.format === 'number' && Number.isFinite(value.value)) return this.formatNumber(value.value, value.options);
        if (value.format === 'date') return this.formatDate(value.value, value.options);
        if (value.format === 'list' && Array.isArray(value.value) && value.value.length <= 256 && value.value.every(item => typeof item === 'string' || item && typeof item.messageKey === 'string'))
          return this.formatter('list', value.options).format(value.value.map(item => typeof item === 'string' ? item : this.t(item.messageKey,item.messageParams,depth + 1)));
      }
      return token;
    });
  }
}

const ENGLISH_PLURALS = new Intl.PluralRules('en');
export function pseudolocalize(message, mode = 'long') {
  const parts = message.split(/(\{[A-Za-z][A-Za-z0-9_]*\})/g);
  return `［${parts.map(part => /^\{/.test(part) ? part : mode === 'rtl' ? `\u2067اختبار ${part}\u2069` : part.replace(/[aeiouAEIOU]/g, letter => ({a:'á',e:'ë',i:'ï',o:'ô',u:'ü',A:'Á',E:'Ë',I:'Ï',O:'Ô',U:'Ü'})[letter]) + ' '.repeat(part ? 1 : 0) + '—'.repeat(Math.ceil(part.length * .4))).join('')}］`;
}

/** One presentation service per JS realm. Workers keep English; app startup
 * selects the saved preference before connecting chrome. */
export const interfaceLocalization = new Localization();
export const t = (key, params) => interfaceLocalization.t(key, params);
export function messageText(translator, key, params = {}) {
  if (typeof translator === 'function') {
    try {
      const text = translator(key, params);
      if (typeof text === 'string' && text && text !== key) return text;
    } catch { /* Optional component translators use the same English fallback. */ }
  }
  return t(key, params);
}
