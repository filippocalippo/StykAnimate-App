import { interfaceLocalization } from './localization.mjs';

const ATTRIBUTES = Object.freeze({
  title: 'data-i18n-title',
  'aria-label': 'data-i18n-aria-label',
  placeholder: 'data-i18n-placeholder',
  alt: 'data-i18n-alt',
  'aria-valuetext': 'data-i18n-aria-valuetext',
  'aria-description': 'data-i18n-aria-description',
  'data-tooltip': 'data-i18n-tooltip',
  'data-hotkey-title': 'data-i18n-hotkey-title',
  'validation-message': 'data-i18n-validation-message',
});
const SELECTOR = ['data-i18n', ...Object.values(ATTRIBUTES)].map(name => `[${name}]`).join(',');
let application = null;
const textBindings = new WeakMap();
const runtimeParameters = new WeakMap();
const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'})[character]);

function bindingAttribute(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/** Clear a caption when its owner starts showing a user name or raw value. */
export function clearTranslation(element, attribute = 'text') {
  if (!element) return;
  if (element.nodeType === 3) { textBindings.delete(element); application?.textNodes.delete(element); return; }
  const binding = attribute === 'text' ? 'data-i18n' : ATTRIBUTES[attribute];
  if (binding) {
    runtimeParameters.get(element)?.delete(binding);
    if (element.hasAttribute?.(binding)) element.removeAttribute(binding);
    if (element.hasAttribute?.(`${binding}-params`)) element.removeAttribute(`${binding}-params`);
  }
}

/** Bind a factory's returned caption without changing the factory's arguments. */
export function translatedElement(element, key, params = {}, attribute = 'text') {
  if (attribute === 'text') localizedText(element, key, params);
  else localizedAttribute(element, attribute, key, params);
  return element;
}

/** Explicit bindings at text owners; parameters are presentation data only. */
export function messageAttributes(key, params = {}, attribute = 'text') {
  const binding = attribute === 'text' ? 'data-i18n' : ATTRIBUTES[attribute];
  return `${binding}="${escape(key)}" ${binding}-params="${escape(JSON.stringify(params))}"`;
}
export function messageHTML(key, params) {
  return `<span ${messageAttributes(key, params)}>${escape(interfaceLocalization.t(key, params))}</span>`;
}
export function connectTranslations(root) {
  if (root?.localName === 'template') root = root.content;
  if (root?.isConnected) {
    const visit = node => {
      const binding = textBindings.get(node);
      if (binding) application?.textNodes.set(node, binding);
      for (const child of node.childNodes ?? []) visit(child);
    };
    visit(root);
  }
  if (!root?.querySelectorAll) return;
  if (application && (root.isConnected || root.nodeType === 9)) application.apply(root);
  else applyTranslations(root, interfaceLocalization);
}
export function localizedText(element, key, params = {}) {
  if (!element) return;
  const previous = element.textContent;
  if (element.nodeType === 3) {
    const binding = {key, params};
    textBindings.set(element, binding);
    const text = interfaceLocalization.t(key, params);
    if (element.data !== text) element.data = text;
    if (element.isConnected) application?.textNodes.set(element, binding);
    return previous !== text;
  }
  bindingAttribute(element, 'data-i18n', key);
  if (!runtimeParameters.has(element)) runtimeParameters.set(element, new Map());
  runtimeParameters.get(element).set('data-i18n', params);
  if (element.hasAttribute('data-i18n-params')) element.removeAttribute('data-i18n-params');
  translateElement(element, interfaceLocalization);
  if (element.isConnected) application?.elements.add(element);
  return previous !== element.textContent;
}
export function localizedAttribute(element, attribute, key, params = {}) {
  if (!element) return;
  if (typeof element.setAttribute !== 'function') throw new TypeError(`Translation ${key} requires an element (${attribute}, ${element.nodeName ?? typeof element}).`);
  const previous = attribute==='validation-message'?element.validationMessage:element.getAttribute(attribute);
  bindingAttribute(element, ATTRIBUTES[attribute], key);
  if (!runtimeParameters.has(element)) runtimeParameters.set(element, new Map());
  runtimeParameters.get(element).set(ATTRIBUTES[attribute], params);
  if (element.hasAttribute(`${ATTRIBUTES[attribute]}-params`)) element.removeAttribute(`${ATTRIBUTES[attribute]}-params`);
  translateElement(element, interfaceLocalization);
  if (element.isConnected) application?.elements.add(element);
  return previous !== (attribute==='validation-message'?element.validationMessage:element.getAttribute(attribute));
}
export function localizedMarkup(element, html) {
  clearTranslation(element);
  element.innerHTML = html;
  connectTranslations(element);
  return html;
}
export function appendLocalized(parent, ...nodes) {
  parent.append(...nodes);
  for (const node of nodes) if (typeof node !== 'string') connectTranslations(node);
}

/** Descriptor keys belong to the feature; renderers only attach the binding. */
export function descriptorAttributes(descriptor, property = 'label', attribute = 'text') {
  const key = descriptor?.[`${property}Key`];
  return key ? ' ' + messageAttributes(key, descriptor[`${property}Params`], attribute) : '';
}

function caption(element, text) {
  const slot = [...element.children].find(child => child.hasAttribute('data-i18n-slot') || child.classList.contains('ui-label') || child.hasAttribute('data-i18n'));
  if (slot) {
    // The parent owns this caption. Retain its slot after removing the child's
    // redundant binding so the next language change updates the same node.
    bindingAttribute(slot, 'data-i18n-slot', '');
    clearTranslation(slot); if (slot.textContent !== text) slot.textContent = text; return;
  }
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
  let params = {};
  try { params = JSON.parse(element.getAttribute('data-i18n-params') || '{}'); } catch { /* invalid authored parameters remain diagnosable */ }
  params = runtimeParameters.get(element)?.get('data-i18n') ?? params;
  const key = element.getAttribute('data-i18n');
  if (key) caption(element, localization.t(key, params));
  for (const [attribute, binding] of Object.entries(ATTRIBUTES)) {
    const key = element.getAttribute(binding);
    if (key) {
      let attributeParams = params;
      try { const authored = element.getAttribute(`${binding}-params`); if (authored) attributeParams = JSON.parse(authored); } catch { /* leave invalid parameters visible */ }
      attributeParams = runtimeParameters.get(element)?.get(binding) ?? attributeParams;
      const text = localization.t(key, attributeParams);
      if(attribute==='validation-message'){
        if(element.validationMessage!==text)element.setCustomValidity?.(text);
        continue;
      }
      if (attribute === 'aria-label' && element.dataset.hotkeyHint !== undefined && element.dataset.hotkeyTitle === element.getAttribute('aria-label'))
        element.dataset.hotkeyTitle = text;
      if (attribute === 'title' && element.dataset.hotkeyHint !== undefined) {
        // A shortcut control (hotkey-hints.mjs): the tooltip shows this name and
        // the shortcut, so no native title. A name derived from it follows it.
        const base = text.replace(/\s*·.*$/, ''), previous = element.dataset.hotkeyTitle;
        element.dataset.hotkeyTitle = base;
        element.removeAttribute('title');
        if (!element.hasAttribute('data-i18n-aria-label') && previous !== undefined && element.getAttribute('aria-label') === previous)
          element.setAttribute('aria-label', base);
        continue;
      }
      if (element.getAttribute(attribute) !== text) element.setAttribute(attribute, text);
    }
  }
}

export const APP_CHROME_BINDINGS = Object.freeze([
  ['.titlebar [data-action="open"]', { text: 'chrome.open', title: 'chrome.openHint' }],
  ['.titlebar [data-action="save"]', { 'aria-label': 'common.save', title: 'chrome.saveHint' }],
  ['.titlebar [data-action="export"]', { text: 'chrome.export' }],
  ['.brand[data-action="menu"]', { 'aria-label': 'chrome.mainMenu' }],
  ['#window-controls [data-action="minimize"]', { 'aria-label': 'chrome.minimize' }],
  ['#window-controls [data-action="maximize"]', { 'aria-label': 'chrome.maximize' }],
  ['#window-controls [data-action="close"]', { 'aria-label': 'chrome.close' }],
  ['.left-panel .panel-tabs [data-tab="layers"]', { text: 'layers.title' }],
  ['.left-panel .panel-tabs [data-tab="assets"]', { text: 'chrome.assets' }],
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

/** The catalog key that translates a menu row for `action`, or undefined (the row keeps its English label). */
export function menuLabelKey(action) {
  return Object.hasOwn(MENU_KEYS, action) ? MENU_KEYS[action] : undefined;
}

/**
 * Root lifecycle bridge. Bind stable chrome once; call applyMenu only after that
 * menu's HTML is replaced. Other owners can mark semantic data-i18n attributes
 * and call apply(subtree). Language changes update retained connected elements
 * without rescanning the document or touching figures, frames, drafts or workers.
 */
export class AppLocalization {
  constructor({ locale = 'en', localization, document: documentRoot = globalThis.document } = {}) {
    this.localization = localization || interfaceLocalization;
    this.localization.setLocale(locale);
    this.document = documentRoot;
    this.elements = new Set();
    this.textNodes = new Map();
    this.stats = { applications: 0, registrations: 0, localeChanges: 0 };
    this.unsubscribe = this.localization.subscribe(() => {
      this.stats.localeChanges++;
      this.updateLanguage();
      for (const element of this.elements) {
        if (!element.isConnected || !element.matches(SELECTOR)) { this.elements.delete(element); continue; }
        translateElement(element, this.localization);
      }
      for (const [node, binding] of this.textNodes) {
        if (!node.isConnected) { this.textNodes.delete(node); continue; }
        const text = this.localization.t(binding.key, binding.params);
        if (node.data !== text) node.data = text;
      }
    });
    this.updateLanguage();
    application = this;
  }

  updateLanguage() {
    if (this.document?.documentElement) {
      this.document.documentElement.lang = this.localization.locale;
      this.document.documentElement.dir = this.localization.direction;
    }
  }

  t(key, params) { return this.localization.t(key, params); }
  setLocale(locale) { return this.localization.setLocale(locale); }

  prune() {
    for (const element of this.elements) if (!element.isConnected || !element.matches(SELECTOR)) this.elements.delete(element);
    for (const node of this.textNodes.keys()) if (!node.isConnected) this.textNodes.delete(node);
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
        if (property === 'text') for (const child of element.children) if (child.hasAttribute('data-i18n-slot')) clearTranslation(child);
      }
      translateElement(element, this.localization);
      if (!this.elements.has(element)) this.stats.registrations++;
      this.elements.add(element);
      count++;
    }
    return count;
  }

  bindChrome(root = this.document) { const count = this.bind(root, APP_CHROME_BINDINGS); this.apply(root); return count; }

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

  destroy() { this.unsubscribe(); this.elements.clear(); this.textNodes.clear(); if (application === this) application = null; }
}

// Existing feature tables also use tuples. Attach key metadata without adding
// fields to their array/data contract; the renderer reads it explicitly.
const tupleBindings = new WeakMap();
export function messageTuple(values, bindings) { tupleBindings.set(values, bindings); return values; }
export function tupleMessages(values) { return tupleBindings.get(values) ?? {}; }

export function replaceLocalized(parent, ...nodes) {
  parent.replaceChildren(...nodes);
  connectTranslations(parent);
}
