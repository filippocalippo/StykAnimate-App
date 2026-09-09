import { Localization } from './localization.mjs';

const ATTRIBUTES = Object.freeze({
  title: 'data-i18n-title',
  'aria-label': 'data-i18n-aria-label',
  placeholder: 'data-i18n-placeholder',
});
const SELECTOR = '[data-i18n],[data-i18n-title],[data-i18n-aria-label],[data-i18n-placeholder]';

function caption(element, text) {
  const slot = [...element.children].find(child => child.hasAttribute('data-i18n-slot'));
  if (slot) { if (slot.textContent !== text) slot.textContent = text; return; }
  const nodes = [...element.childNodes].filter(node => node.nodeType === 3 && node.textContent.trim());
  if (nodes.length) {
    if (nodes[0].textContent !== text) nodes[0].textContent = text;
    for (const extra of nodes.slice(1)) extra.textContent = '';
    return;
  }
  if (!element.children.length) { if (element.textContent !== text) element.textContent = text; return; }
  // Preserve icons, shortcut badges and other child identity. Explicit slots are
  // required when a label already lives inside a child element.
  const label = element.ownerDocument.createElement('span');
  label.dataset.i18nSlot = '';
  label.textContent = text;
  element.append(label);
}

/** Translate only explicit bindings in a newly rendered subtree. No observer. */
export function applyTranslations(root, localization) {
  const elements = [];
  if (root.matches?.(SELECTOR)) elements.push(root);
  elements.push(...root.querySelectorAll(SELECTOR));
  for (const element of elements) translateElement(element, localization);
  return elements;
}

function translateElement(element, localization) {
  const key = element.getAttribute('data-i18n');
  if (key) caption(element, localization.t(key));
  for (const [attribute, binding] of Object.entries(ATTRIBUTES)) {
    const key = element.getAttribute(binding);
    if (key) {
      const text = localization.t(key);
      if (element.getAttribute(attribute) !== text) element.setAttribute(attribute, text);
    }
  }
}

export const APP_CHROME_BINDINGS = Object.freeze([
  ['.titlebar > [data-action="open"]', { text: 'chrome.open', title: 'chrome.openHint' }],
  ['.titlebar > [data-action="save"]', { text: 'common.save', title: 'chrome.saveHint' }],
  ['.titlebar > [data-action="export"]', { text: 'chrome.export' }],
  ['.brand[data-action="menu"]', { 'aria-label': 'chrome.mainMenu' }],
  ['#window-controls [data-action="minimize"]', { 'aria-label': 'chrome.minimize' }],
  ['#window-controls [data-action="maximize"]', { 'aria-label': 'chrome.maximize' }],
  ['#window-controls [data-action="close"]', { 'aria-label': 'chrome.close' }],
  ['.left-panel .panel-tabs [data-tab="layers"]', { text: 'layers.title' }],
  ['.left-panel .panel-tabs [data-tab="assets"]', { text: 'chrome.assets' }],
  ['.right-panel .panel-tabs [data-inspector="design"]', { text: 'chrome.design' }],
  ['.right-panel .panel-tabs [data-inspector="animation"]', { text: 'settings.animation' }],
  ['.panel-bottom [data-action="import"]', { text: 'chrome.importFigures' }],
  ['.panel-bottom [data-action="help"]', { title: 'menu.shortcuts' }],
  ['.timeline-title', { text: 'timeline.title' }],
  ['#layer-search', { placeholder: 'chrome.searchLayers', 'aria-label': 'chrome.findLayer' }],
  ['#layer-list', { 'aria-label': 'chrome.sceneLayers' }],
  ['#fps', { 'aria-label': 'playback.frameRate' }],
  ['#timeline-zoom', { 'aria-label': 'chrome.timelineZoom' }],
  ['#zoom-label', { 'aria-label': 'chrome.canvasZoom', title: 'chrome.zoomOptions' }],
  ['#play-button', { title: 'playback.playPauseHint' }],
  ['#loop-button', { title: 'playback.loop' }],
]);

const MENU_KEYS = Object.freeze({
  new: 'menu.newAnimation', open: 'menu.openProject', 'open-recent': 'menu.openRecent',
  save: 'common.save', 'save-as': 'common.saveAs', undo: 'common.undo', redo: 'common.redo',
  import: 'menu.importFigures', 'import-sprite': 'menu.importSprite',
  'import-background': 'menu.importBackground', 'add-text': 'menu.createText',
  export: 'common.export', settings: 'menu.settings', help: 'menu.shortcuts',
  performance: 'menu.performance', copy: 'common.copy', cut: 'common.cut',
  paste: 'common.paste', duplicate: 'common.duplicate', delete: 'common.delete',
});

/**
 * Root lifecycle bridge. Bind stable chrome once; call applyMenu only after that
 * menu's HTML is replaced. Other owners can mark semantic data-i18n attributes
 * and call apply(subtree). Language changes update retained connected elements
 * without rescanning the document or touching figures, frames, drafts or workers.
 */
export class AppLocalization {
  constructor({ locale = 'en', localization, document: documentRoot = globalThis.document } = {}) {
    this.localization = localization || new Localization({locale});
    this.document = documentRoot;
    this.elements = new Set();
    this.stats = { applications: 0, registrations: 0, localeChanges: 0 };
    this.unsubscribe = this.localization.subscribe(() => {
      this.stats.localeChanges++;
      this.updateLanguage();
      for (const element of this.elements) {
        if (!element.isConnected) { this.elements.delete(element); continue; }
        translateElement(element, this.localization);
      }
    });
    this.updateLanguage();
  }

  updateLanguage() {
    if (this.document?.documentElement) this.document.documentElement.lang = this.localization.locale;
    // RTL catalog support requires a separate layout audit. Never mirror the
    // document canvas/timeline or user-authored text as a side effect of language.
  }

  t(key, params) { return this.localization.t(key, params); }
  setLocale(locale) { return this.localization.setLocale(locale); }

  prune() {
    for (const element of this.elements) if (!element.isConnected) this.elements.delete(element);
  }

  apply(root) {
    this.prune();
    const elements = applyTranslations(root, this.localization);
    for (const element of elements) {
      if (!this.elements.has(element)) this.stats.registrations++;
      this.elements.add(element);
    }
    this.stats.applications++;
    return elements.length;
  }

  bind(root, bindings) {
    this.prune();
    let count = 0;
    for (const [selector, properties] of bindings) for (const element of root.querySelectorAll(selector)) {
      for (const [property, key] of Object.entries(properties)) {
        const attribute = property === 'text' ? 'data-i18n' : ATTRIBUTES[property];
        if (!attribute) throw new Error(`Unsupported translation attribute: ${property}`);
        element.setAttribute(attribute, key);
      }
      translateElement(element, this.localization);
      if (!this.elements.has(element)) this.stats.registrations++;
      this.elements.add(element);
      count++;
    }
    return count;
  }

  bindChrome(root = this.document) { return this.bind(root, APP_CHROME_BINDINGS); }

  applyMenu(menu) {
    for (const button of menu.querySelectorAll('[data-action]')) {
      const key = Object.hasOwn(MENU_KEYS, button.dataset.action) ? MENU_KEYS[button.dataset.action] : null;
      if (!key) continue;
      const slot = [...button.children].find(child => child.tagName === 'SPAN' && !child.classList.contains('icon'));
      if (slot) slot.dataset.i18n = key;
    }
    return this.apply(menu);
  }

  updatePlayback(button, { playing = false, previewing = false } = {}) {
    const key = previewing ? 'playback.stop' : playing ? 'playback.pause' : 'playback.play';
    button.setAttribute('data-i18n-aria-label', key);
    return this.apply(button);
  }

  destroy() { this.unsubscribe(); this.elements.clear(); }
}
