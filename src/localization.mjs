import english from './locales/en.mjs';
import italian from './locales/it.mjs';
import nativeCatalogs, { NATIVE_LOCALES } from './locales/native-catalogs.mjs';

export const DEFAULT_LOCALE = 'en';
export const SUPPORTED_LOCALES = NATIVE_LOCALES;
const catalogs = Object.freeze({ ...nativeCatalogs, en: english, it: italian });
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const MAX_FORMATTERS = 16;

function supportedLocale(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return null;
  try {
    const canonical = Intl.getCanonicalLocales(value)[0];
    if (owns(catalogs, canonical)) return canonical;
    const parsed = new Intl.Locale(canonical);
    const language = parsed.language;
    // Only the supplied script/regional catalogs are supported. Regional
    // Spanish remains distinct; Traditional Chinese never silently becomes
    // Simplified Chinese. The native Norwegian vocabulary is Bokmål.
    if (language === 'zh') {
      if (parsed.script) return parsed.script === 'Hans' ? 'zh-Hans' : null;
      return ['TW','HK','MO'].includes(parsed.region) ? null : 'zh-Hans';
    }
    if (language === 'pt') return !parsed.region || parsed.region === 'BR' ? 'pt-BR' : null;
    if (language === 'no') return 'nb';
    if (language === 'es' && ['419','AR','BO','CL','CO','CR','CU','DO','EC','GT','HN','MX','NI','PA','PE','PR','PY','SV','US','UY','VE'].includes(parsed.region)) return 'es-419';
    return owns(catalogs, language) ? language : null;
  } catch { return null; }
}

/** Persist a supported language ID; invalid or unimplemented preferences use English. */
export function normalizeLocale(value) { return supportedLocale(value) ?? DEFAULT_LOCALE; }
export function isSupportedLocale(value) { return supportedLocale(value) !== null; }

/**
 * Plain-text, DOM-free catalog service. It schedules no work and touches no
 * animation/model state. UI owners subscribe once and refresh labels only when
 * the user changes language. Rendered templates must still escape returned text.
 */
export class Localization {
  constructor({ locale = DEFAULT_LOCALE } = {}) {
    this.locale = normalizeLocale(locale);
    this.listeners = new Set();
    this.formatters = new Map();
  }

  get direction() { return SUPPORTED_LOCALES.find(item => item.id === this.locale).direction; }

  setLocale(value) {
    const locale = supportedLocale(value);
    if (!locale) throw new RangeError('Choose a supported interface language.');
    if (locale === this.locale) return false;
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
      const Constructor = kind === 'number' ? Intl.NumberFormat : kind === 'date' ? Intl.DateTimeFormat : Intl.PluralRules;
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

  t(key, params = {}) {
    if (typeof key !== 'string' || !key || key.length > 160) throw new TypeError('A translation key must be a short nonempty string.');
    const localized = catalogs[this.locale];
    let message = owns(localized, key) ? localized[key] : owns(english, key) ? english[key] : key;
    if (typeof message !== 'string') {
      const category = typeof params.count === 'number' && Number.isFinite(params.count)
        ? this.formatter('plural').select(params.count) : 'other';
      message = message[category] ?? message.other;
    }
    return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name) => {
      if (!owns(params, name)) return token;
      const value = params[name];
      if (typeof value === 'string') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return this.formatNumber(value);
      return token;
    });
  }
}
