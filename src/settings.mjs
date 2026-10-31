import {tupleMessages, messageTuple, localizedAttribute, messageAttributes, localizedText, localizedMarkup, appendLocalized} from './localization-bindings.mjs';

import {updateInspectorDOM} from './inspector-dom.mjs';

import {t as interfaceText, Localization, loadLocale, normalizeLocale, SUPPORTED_LOCALES, messageText as sayDialog} from './localization.mjs';

import { icon } from "./icons.mjs";
import { PIVOT_HANDLE_COLORS } from "./canvas-interactions.mjs";

import { DEFAULT_HOTKEYS, normalizeHotkeys } from './hotkeys.mjs';
import { HotkeySettings } from './hotkey-settings.mjs';
import { applyUIScale, autoUIScale, effectiveUIScale, normalizeUIScale, normalizeUIScaleMode, UI_SCALE } from './ui-scale.mjs';
import { applyEditorTheme, normalizeTheme } from './theme.mjs';
import {normalizePlaybackQuality, playbackQualityOptions} from './preview-quality.mjs';
import { normalizeSectionMemory } from './inspector-kit.mjs';
import {normalizeExportPreferences} from './export-request.mjs';

import { normalizeFingerDraw, normalizeTouchSetting } from './touch/touch-mode.mjs';

export const EDITOR_SETTINGS_KEY = "stykanimate.editor.settings.v1";
export const DEFAULT_EDITOR_SETTINGS = Object.freeze({
  locale: "en",
  theme: "system",
  uiScale: 100,
  // Automatic follows the screen (ui-scale.mjs autoUIScale); moving the slider makes it Custom.
  uiScaleMode: "auto",
  // The touch interface (docs/TOUCH.md): Automatic follows the primary pointer; On and Off force it.
  touchInterface: "auto",
  // Draw with a finger: until a pen is used (auto), always, or never (a finger pans).
  fingerDraw: "auto",
  hotkeys: DEFAULT_HOTKEYS,
  timelineMode: "advanced",
  replaceKeyframesOnDrop: true,
  showHandles: true,
  showCamera: false,
  showUnselectedHandles: true,
  canvasGrid: false,
  canvasZoomGesture: "ctrl-scroll",
  // Wheel zoom glides between levels. Automatic glides except on the WebGL2 backend (canvas-wheel-zoom.mjs).
  smoothZoom: "auto",
  marqueeSelection: "origins",
  pasteDepth: "same",
  altDragDuplicate: "instance",
  canvasGuideVertical: false,
  canvasGuideHorizontal: false,
  canvasGuidesLocked: false,
  canvasGridSpacing: 40,
  canvasGridOpacity: 0.18,
  canvasGuideX: 0.5,
  canvasGuideY: 0.75,
  motionPaths: false,
  motionPathRange: 0,
  motionPathLabels: true,
  motionPathDots: true,
  motionPathAllTargets: false,
  motionPathJoints: "selected",
  motionPathSpeed: false,
  motionPathRelative: false,
  motionPathFalloffRadius: 8,
  motionPathFalloffShape: "smooth",
  autoSizeHandles: true,
  outlineHandles: true,
  builderShowStaticHandles: true,
  builderSmartSnapping: true,
  builderHighlightSegment: false,
  builderCanvasColor: '#ffffff',
  useBuilderCanvasColor: false,
  builderOutlinerWidth: 236,
  handleSize: 5,
  onionCount: 0,
  onionAhead: true,
  onionJoined: true,
  onionOpacity: 0.14,
  onionBefore: 2,
  onionRangeBefore: null,
  onionRangeAfter: null,
  onionAfter: 1,
  onionStep: 1,
  onionFade: true,
  onionTint: true,
  onionBeforeColor: '#e76b70',
  onionAfterColor: '#549de7',
  onionScope: 'all',
  onionMode: 'keyframes',
  onionCamera: false,
  onionShowOnTop: false,
  onionTimelineMarkers: true,
  autoKey: false,
  loopPlayback: true,
  fitViewOnPlayback: true,
  playbackQuality: 'normal',
  autosaveSeconds: 2.5,
  // The inspector's titled sections a person left open, per kind of selection: {figure: {colours: true}}.
  inspectorSections: Object.freeze({}),
  // The export dialog's remembered choices (export-request.mjs); null until the first export.
  exportPreferences: null,
  // Home (docs/HOME.md): whether the app starts on it, and how its project list is shown and ordered.
  showHomeOnStartup: true,
  homeLayout: "grid",
  homeSort: "recent",
  // The tutorials a person finished (docs/TUTORIALS.md), by id.
  tutorialsDone: Object.freeze([]),
});
const TUTORIAL_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** The finished tutorials as a short list of well-formed ids, each once. */
export function normalizeTutorialsDone(value) {
  if (!Array.isArray(value)) return DEFAULT_EDITOR_SETTINGS.tutorialsDone;
  const ids = [...new Set(value.filter(id => typeof id === "string" && TUTORIAL_ID.test(id)))].slice(0, 64);
  return Object.freeze(ids);
}
export function normalizeEditorSettings(value = {}) {
  const result = { ...DEFAULT_EDITOR_SETTINGS };
  result.locale = normalizeLocale(value?.locale);
  result.theme = normalizeTheme(value?.theme);
  result.uiScale = normalizeUIScale(value?.uiScale);
  result.uiScaleMode = normalizeUIScaleMode(value?.uiScaleMode, value?.uiScale);
  result.touchInterface = normalizeTouchSetting(value?.touchInterface);
  // Earlier builds stored an on/off "fingerDrawing"; on meant a finger always draws.
  result.fingerDraw = normalizeFingerDraw(value?.fingerDraw ?? (value?.fingerDrawing === true ? 'always' : undefined));
  result.hotkeys = normalizeHotkeys(value?.hotkeys);
  result.playbackQuality = normalizePlaybackQuality(value?.playbackQuality);
  if (['scroll', 'ctrl-scroll'].includes(value?.canvasZoomGesture))
    result.canvasZoomGesture = value.canvasZoomGesture;
  if (['auto', 'on', 'off'].includes(value?.smoothZoom)) result.smoothZoom = value.smoothZoom;
  if (['bounds', 'origins'].includes(value?.marqueeSelection))
    result.marqueeSelection = value.marqueeSelection;
  if (['same', 'front'].includes(value?.pasteDepth)) result.pasteDepth = value.pasteDepth;
  if (['instance', 'unique'].includes(value?.altDragDuplicate))
    result.altDragDuplicate = value.altDragDuplicate;
  if (value?.timelineMode === "simple" || value?.timelineMode === "advanced")
    result.timelineMode = value.timelineMode;
  for (const key of [
    "replaceKeyframesOnDrop",
    "showHandles",
    "showCamera",
    "showUnselectedHandles",
    "canvasGrid", "canvasGuideVertical", "canvasGuideHorizontal", "canvasGuidesLocked",
    "motionPaths",
    "motionPathLabels",
    "motionPathDots",
    "motionPathAllTargets",
    "motionPathSpeed",
    "motionPathRelative",
    "autoSizeHandles",
    "outlineHandles",
    "builderShowStaticHandles",
    "builderSmartSnapping",
    "builderHighlightSegment",
    "useBuilderCanvasColor",
    "onionAhead",
    "onionJoined",
    "onionFade",
    "onionTint",
    "onionCamera",
    "onionShowOnTop",
    "onionTimelineMarkers",
    "autoKey",
    "loopPlayback",
    "fitViewOnPlayback",
    "showHomeOnStartup",
  ])
    if (typeof value?.[key] === "boolean") result[key] = value[key];
  if (typeof value?.builderCanvasColor === 'string' && /^#[0-9a-f]{6}$/i.test(value.builderCanvasColor))
    result.builderCanvasColor = value.builderCanvasColor.toLowerCase();
  for (const [key, min, max] of [
    ["canvasGridSpacing", 4, 1000], ["canvasGridOpacity", 0.05, 0.6],
    ["canvasGuideX", 0, 1], ["canvasGuideY", 0, 1],
    ["handleSize", 3, 10],
    ["onionCount", 0, 9],
    ["onionOpacity", 0, 1],
    ["onionBefore", 0, Number.MAX_SAFE_INTEGER],
    ["onionAfter", 0, Number.MAX_SAFE_INTEGER],
    ["onionStep", 1, 20],
    ["autosaveSeconds", 0, 300],
    ["builderOutlinerWidth", 160, 520],
    ["motionPathRange", 0, 4000],
    ["motionPathFalloffRadius", 1, 240],
  ])
    if (Number.isFinite(value?.[key]))
      result[key] = Math.max(min, Math.min(max, value[key]));
  for(const key of ['onionRangeBefore','onionRangeAfter'])
    if(Number.isFinite(value?.[key]))result[key]=Math.max(0,Math.min(10000000,Math.round(value[key])));
  result.onionCount = Math.round(result.onionCount);
  result.motionPathRange = Math.round(result.motionPathRange);
  result.motionPathFalloffRadius = Math.round(result.motionPathFalloffRadius);
  for (const key of ['onionBefore','onionAfter','onionStep']) result[key] = Math.round(result[key]);
  for (const key of ['onionBeforeColor','onionAfterColor'])
    if (typeof value?.[key] === 'string' && /^#[0-9a-f]{6}$/i.test(value[key])) result[key] = value[key].toLowerCase();
  if (['selected','tips'].includes(value?.motionPathJoints)) result.motionPathJoints = value.motionPathJoints;
  if (['smooth','linear','sharp','flat'].includes(value?.motionPathFalloffShape)) result.motionPathFalloffShape = value.motionPathFalloffShape;
  if (['all','selected'].includes(value?.onionScope)) result.onionScope = value.onionScope;
  if (['keyframes','frames'].includes(value?.onionMode)) result.onionMode = value.onionMode;
  result.inspectorSections = normalizeSectionMemory(value?.inspectorSections);
  if (value?.exportPreferences && typeof value.exportPreferences === 'object') result.exportPreferences = normalizeExportPreferences(value.exportPreferences);
  if (['grid', 'list'].includes(value?.homeLayout)) result.homeLayout = value.homeLayout;
  if (['recent', 'name', 'modified'].includes(value?.homeSort)) result.homeSort = value.homeSort;
  result.tutorialsDone = normalizeTutorialsDone(value?.tutorialsDone);
  return result;
}
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** The sections of the sidebar: id, glyph and the concept tint of its tile (tokens.css --tint-*). */
const TABS = [
  ["interface", "sliders", "select"],
  ["canvas", "frame", "library"],
  ["animation", "play", "time"],
  ["shortcuts", "keyboard", "camera"],
];
const FEEDBACK_TAB = ["feedback", "message", "draw"];
/** The tabs the sidebar search looks through (Shortcuts has its own search). */
const SEARCH_TABS = ["interface", "canvas", "animation"];
const SYMBOL_URL = new URL("../symbol.svg", import.meta.url).href;
const sliderPercent = (value, min, max) => Math.round(((value - min) / (max - min || 1)) * 1000) / 10;
/** Paints a .ui-slider's fill up to its value (components/slider.css reads --_p). */
const fillSlider = (input) => input.style.setProperty("--_p", `${sliderPercent(Number(input.value), Number(input.min), Number(input.max))}%`);

/** A small editor window, drawn in the light or dark theme's colours (the Theme tiles). */
const MINI_WINDOW = `<svg viewBox="0 0 120 76" aria-hidden="true" focusable="false"><rect class="m-field" width="120" height="76"/><rect class="m-panel" width="120" height="11"/><rect class="m-accent" x="5" y="4" width="4" height="4" rx="1"/><rect class="m-panel" x="5" y="16" width="10" height="55" rx="3"/><rect class="m-stage" x="20" y="16" width="68" height="55" rx="3"/><rect class="m-panel" x="93" y="16" width="22" height="55" rx="3"/><rect class="m-line" x="97" y="21" width="14" height="3" rx="1.5"/><rect class="m-line" x="97" y="28" width="10" height="3" rx="1.5"/><circle class="m-figure" cx="54" cy="29" r="4"/><path class="m-limb" d="M54 33v13m0 0-7 12m7-12 7 12M54 37l-8 5m8-5 8-5"/></svg>`;
const themeArt = (theme) =>
  theme === "system"
    ? `<span class="styk-settings-mini" data-mini="light">${MINI_WINDOW}</span><span class="styk-settings-mini" data-mini="dark" data-half>${MINI_WINDOW}</span>`
    : `<span class="styk-settings-mini" data-mini="${theme}">${MINI_WINDOW}</span>`;

/** Three layer rows with keys and a playhead (Advanced), or a strip of poses (Simple). */
const TIMELINE_ART = {
  advanced: `<svg viewBox="0 0 160 64" aria-hidden="true" focusable="false">${[6, 25, 44]
    .map(
      (y, row) =>
        `<rect class="t-track" x="0" y="${y}" width="160" height="14" rx="4"/>${[
          [18, 62, 118],
          [30, 92, 140],
          [18, 78],
        ][row]
          .map((x) => `<path class="t-key" d="M${x} ${y + 2}l5 5-5 5-5-5z"/>`)
          .join("")}`,
    )
    .join("")}<path class="t-head" d="M70 2v60"/><rect class="t-head-cap" x="66" y="0" width="8" height="5" rx="1.5"/></svg>`,
  simple: `<svg viewBox="0 0 160 64" aria-hidden="true" focusable="false">${[
    "M17 27l-6 10m6-10 6 10M17 19l-7 3m7-3 7-3",
    "M17 27l-8 8m8-8 3 11M17 19l-8-2m8 2 7 4",
    "M17 27l-2 11m2-11 8 7M17 19l-6 6m6-6 5-7",
    "M17 27l-6 10m6-10 6 10M17 19l-7-5m7 5 7-5",
  ]
    .map(
      (limbs, index) =>
        `<g transform="translate(${4 + index * 39} 8)"><rect class="t-frame${index === 1 ? " is-current" : ""}" width="34" height="48" rx="5"/><circle class="t-figure" cx="17" cy="12" r="3.2"/><path class="t-limb" d="M17 15v12${limbs}"/></g>`,
    )
    .join("")}</svg>`,
};

export class EditorSettings {
  constructor({
    value,
    getValue,
    onChange = () => {},
    onPersist,
    onResetWorkspace,
    localization,
    onPrivacy,
    onFeedback,
    onDonate,
  } = {}) {
    if (value === undefined) {
      try {
        value = JSON.parse(localStorage.getItem(EDITOR_SETTINGS_KEY) || "null");
      } catch {
        value = {};
      }
    }
    this.value = normalizeEditorSettings(value);
    // Motion-path visibility is session-only; keep saved display options.
    this.value.motionPaths = false;
    applyEditorTheme(this.value.theme);
    this.appliedScale = applyUIScale(effectiveUIScale(this.value));
    // Automatic follows the screen: a window moved to another display takes that display's scale.
    window.addEventListener('resize', () => this.followScreen());
    this.localization = localization || new Localization({locale: this.value.locale});
    this.localization.setLocale(this.value.locale);
    this.getValue = getValue;
    this.onChange = onChange;
    this.onPersist =
      onPersist ||
      ((next) =>
        localStorage.setItem(EDITOR_SETTINGS_KEY, JSON.stringify(next)));
    this.onResetWorkspace = onResetWorkspace;
    this.onPrivacy = onPrivacy;
    this.onFeedback = onFeedback;
    this.onDonate = onDonate;
    this.tab = "interface";
    this.query = "";
    this.chain = Promise.resolve();
    this.pending = null;
    this.timer = null;
    this.error = null;
    this.tabs = onFeedback ? [...TABS, FEEDBACK_TAB] : TABS;
    this.dialog = document.createElement("dialog");
    this.dialog.className = "styk-settings";
    localizedAttribute(this.dialog, "aria-label", "settings.editorLabel", {});
    localizedMarkup(this.dialog, `<header class="styk-settings-head"><img class="styk-settings-mark" src="${SYMBOL_URL}" alt=""><h2 ${messageAttributes("settings.title", {})}>${escape(this.t("settings.title"))}</h2><label class="styk-settings-search">${icon("search")}<input type="search" data-settings-search autocomplete="off" spellcheck="false"></label><button type="button" class="styk-settings-close" aria-label="${escape(this.t("settings.close"))}" ${messageAttributes("settings.close", {}, "aria-label")}>${icon("x")}</button></header><div class="styk-settings-layout"><aside class="styk-settings-sidebar"><nav class="styk-settings-tabs" role="tablist" aria-orientation="vertical" aria-label="${escape(this.t("settings.sections"))}" ${messageAttributes("settings.sections", {}, "aria-label")}>${this.tabs
      .map(
        ([id, symbol, tint]) =>
          `<button type="button" role="tab" id="styk-settings-tab-${id}" data-tab="${id}" aria-controls="styk-settings-content"><span class="styk-settings-tab-icon" data-tint="${tint}">${icon(symbol)}</span><span data-settings-tab-label ${messageAttributes('settings.' + id, {})}>${escape(this.t('settings.' + id))}</span></button>`,
      )
      .join("")}</nav><div class="styk-settings-actions"></div></aside><section id="styk-settings-content" class="styk-settings-content" role="tabpanel"></section></div>`);
    appendLocalized(document.body, this.dialog);
    this.content = this.dialog.querySelector(".styk-settings-content");
    this.search = this.dialog.querySelector("[data-settings-search]");
    this.labelSearch();
    this.compactLayout = window.matchMedia('(max-width:620px)');
    this.syncTabOrientation = () => this.dialog.querySelector('[role=tablist]').setAttribute('aria-orientation', this.compactLayout.matches ? 'horizontal' : 'vertical');
    this.compactLayout.addEventListener('change', this.syncTabOrientation);
    this.syncTabOrientation();
    this.hotkeySettings = new HotkeySettings(this);
    const actions = this.dialog.querySelector('.styk-settings-actions');
    if (onPrivacy) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'styk-settings-privacy'; button.dataset.settingsPrivacy = '';
      localizedMarkup(button, `${icon('lock')}<span ${messageAttributes('settings.privacy', {})}>${escape(this.say('settings.privacy'))}</span>`);
      localizedAttribute(button, "title", 'settings.privacy', {}); button.setAttribute('aria-label', button.title);
      button.onclick = () => { this.close(); void this.onPrivacy(); };
      appendLocalized(actions, button);
    }
    if (onDonate) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'styk-settings-donate'; button.dataset.settingsDonate = '';
      localizedMarkup(button, `<span class="styk-settings-donate-badge">${icon('heart')}</span><span class="styk-settings-donate-text"><strong ${messageAttributes('settings.donate', {})}>${escape(this.t('settings.donate'))}</strong><small ${messageAttributes('settings.donateNote', {})}>${escape(this.say('settings.donateNote'))}</small></span>${icon('externalLink')}`);
      localizedAttribute(button, 'aria-label', 'settings.donate', {});
      button.onclick = () => Promise.resolve().then(() => this.onDonate()).catch(error => this.showError(error));
      appendLocalized(actions, button);
    }
    this.unsubscribeLocale = this.localization.subscribe(() => this.refreshLanguage());
    this.dialog.querySelector(".styk-settings-close").onclick = () =>
      this.close();
    this.dialog.addEventListener("close", () => void this.flush());
    this.dialog.addEventListener("keydown", (event) => {
      event.stopPropagation();
      // Escape in the search clears it first; the next one closes Settings.
      if (event.key === "Escape" && event.target === this.search && this.search.value) {
        event.preventDefault();
        this.setQuery("");
        return;
      }
      const tab = event.target.closest("[role=tab]");
      if (
        tab &&
        [
          "ArrowDown",
          "ArrowUp",
          "ArrowLeft",
          "ArrowRight",
          "Home",
          "End",
        ].includes(event.key)
      ) {
        event.preventDefault();
        const tabs = [...this.dialog.querySelectorAll("[role=tab]")],
          index = tabs.indexOf(tab);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : (index +
                  (["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1) +
                  tabs.length) %
                tabs.length;
        this.selectTab(tabs[next].dataset.tab);
        tabs[next].focus();
      }
    });
    this.dialog.addEventListener("click", (event) => {
      event.stopPropagation();
      const tab = event.target.closest("[role=tab]");
      if (tab) this.selectTab(tab.dataset.tab);
      const feedback = event.target.closest('[data-settings-feedback]');
      if (feedback) { this.close(); this.onFeedback?.(feedback.dataset.settingsFeedback === 'inbox' ? {view: 'inbox'} : {category: feedback.dataset.settingsFeedback}); }
      if (event.target.closest("[data-scale-reset]")) {
        this.commit({uiScaleMode: 'auto', uiScale: 100});
        this.syncScaleControl();
      }
      const mode = event.target.closest("[data-scale-mode]");
      if (mode) {
        // Custom starts from the scale shown now, so choosing it changes nothing until the slider moves.
        this.commit(mode.dataset.scaleMode === 'auto' ? {uiScaleMode: 'auto'} : {uiScaleMode: 'manual', uiScale: effectiveUIScale(this.value)});
        this.syncScaleControl();
      }
      if (event.target.closest("[data-settings-reset]"))
        Promise.resolve(this.onResetWorkspace?.()).catch((error) =>
          this.showError(error),
        );
    });
    this.dialog.addEventListener("change", async (event) => {
      const input = event.target.closest("[data-setting]");
      if (!input) return;
      let value =
        input.type === "checkbox"
          ? input.checked
          : input.type === "number" || input.type === "range"
            ? Number(input.value)
            : input.value;
      if (input.dataset.setting === "onionOpacity") value /= 100;
      // A language is chosen once its messages are in.
      if (input.dataset.setting === "locale") {
        try { await loadLocale(value); } catch (error) { this.showError(error); return; }
      }
      this.commit({ [input.dataset.setting]: value });
    });
    this.dialog.addEventListener("input", (event) => {
      if (event.target === this.search) {
        this.setQuery(this.search.value);
        return;
      }
      if (event.target.dataset.setting === "uiScale") {
        this.commit({uiScale: Number(event.target.value)});
        this.syncScaleControl();
      }
      if (event.target.dataset.setting === "handleSize") {
        const size = Number(event.target.value);
        this.content
          .querySelector(".styk-settings-preview")
          ?.style.setProperty("--size", size);
        localizedText(this.content.querySelector("[data-handle-value]"), 'settings.sizePx', {size: size});
        fillSlider(event.target);
      }
    });
  }
  t(key, params) { return this.localization.t(key, params); }
  /** Dialog words that not every catalog has yet: the localization's text, else English (en-dialogs.mjs). */
  say(key, params) { return sayDialog((name, values) => this.t(name, values), key, params); }
  labelSearch() {
    const label = this.say('settings.search');
    this.search.placeholder = `${label}…`;
    this.search.setAttribute('aria-label', label);
  }
  refreshLanguage() {
    this.value.locale = this.localization.locale;
    this.dialog.lang = this.localization.locale;
    localizedAttribute(this.dialog, 'aria-label', 'settings.editorLabel', {});
    localizedText(this.dialog.querySelector('.styk-settings-head h2'), 'settings.title', {});
    localizedAttribute(this.dialog.querySelector('.styk-settings-close'), 'aria-label', 'settings.close', {});
    localizedAttribute(this.dialog.querySelector('[role=tablist]'), 'aria-label', 'settings.sections', {});
    this.labelSearch();
    for (const button of this.dialog.querySelectorAll('[data-tab]'))
      localizedText(button.querySelector('[data-settings-tab-label]'), 'settings.' + button.dataset.tab, {});
    const privacy = this.dialog.querySelector('[data-settings-privacy]');
    if (privacy) {
      privacy.querySelector('span').textContent = localizedAttribute(privacy, "title", 'settings.privacy', {});
      privacy.setAttribute('aria-label', privacy.title);
    }
    const donate = this.dialog.querySelector('[data-settings-donate]');
    if (donate) {
      localizedText(donate.querySelector('strong'), 'settings.donate', {});
      localizedAttribute(donate, 'aria-label', 'settings.donate', {});
      localizedText(donate.querySelector('small'), 'settings.donateNote', {});
    }
    if (!this.dialog.open) return;
    const active = document.activeElement, setting = active?.dataset.setting;
    const draft = active?.value;
    const scrollTop = this.content.scrollTop;
    this.render({retain: true});
    this.content.scrollTop = scrollTop;
    if (setting) {
      const candidates = [...this.content.querySelectorAll(`[data-setting="${setting}"]`)];
      const target = active.type === 'radio' ? candidates.find(input => input.value === draft) : candidates[0];
      if (target) {
        if (['number','range','text'].includes(target.type)) target.value = draft;
        target.focus({preventScroll:true});
      }
    }
  }
  /** Automatic's scale for the window's current screen, applied only when it changes. */
  followScreen() {
    if (this.value.uiScaleMode !== 'auto') return;
    const next = effectiveUIScale(this.value);
    if (next !== this.appliedScale) { this.appliedScale = applyUIScale(next); this.syncScaleControl(); }
  }
  setValue(value) {
    this.value = normalizeEditorSettings(value);
    applyEditorTheme(this.value.theme);
    this.appliedScale = applyUIScale(effectiveUIScale(this.value));
    const changed = this.localization.setLocale(this.value.locale);
    if (!changed && this.dialog.open) this.render();
  }
  /** Opens Settings on `tab`; with `setting`, focused on that field (the command palette's Settings rows). */
  open(tab = this.tab, {setting} = {}) {
    if (this.getValue) this.value = normalizeEditorSettings(this.getValue());
    applyEditorTheme(this.value.theme);
    this.appliedScale = applyUIScale(effectiveUIScale(this.value));
    this.localization.setLocale(this.value.locale);
    this.dialog.lang = this.localization.locale;
    this.selectTab(tab);
    if (!this.dialog.open) this.dialog.showModal();
    const field = setting && (this.content.querySelector(`[data-setting="${setting}"]:checked`) ?? this.content.querySelector(`[data-setting="${setting}"]`));
    if (field) { field.focus(); field.scrollIntoView?.({block: 'nearest'}); }
    else this.dialog.querySelector(`[data-tab="${this.tab}"]`).focus();
  }
  close() {
    this.dialog.close();
    void this.flush();
  }
  selectTab(tab) {
    this.tab = this.tabs.some(([id]) => id === tab) ? tab : "interface";
    this.query = "";
    this.search.value = "";
    this.dialog.removeAttribute("data-searching");
    for (const button of this.dialog.querySelectorAll("[role=tab]")) {
      const selected = button.dataset.tab === this.tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    this.hotkeySettings.cancel();
    this.hotkeySettings.conflict = null;
    this.dialog.dataset.tab = this.tab;
    this.content.setAttribute("aria-labelledby", `styk-settings-tab-${this.tab}`);
    this.render();
    this.content.scrollTop = 0;
  }
  /** Searches Interface, Canvas and Animation together; an empty query shows the selected tab again. */
  setQuery(query) {
    this.query = query;
    if (this.search.value !== query) this.search.value = query;
    this.hotkeySettings.cancel();
    this.dialog.toggleAttribute("data-searching", Boolean(query.trim()));
    this.render();
    this.content.scrollTop = 0;
  }

  /* ---- Row builders: one pattern in every tab ---- */

  /** A setting's words: its label and, below it, an optional hint. */
  text(label, hint, hintId) {
    return `<span class="styk-settings-text"><span class="styk-settings-label">${escape(label)}</span>${hint ? `<small class="styk-settings-hint"${hintId ? ` id="${hintId}"` : ""}>${escape(hint)}</small>` : ""}</span>`;
  }
  checkbox(label, key, hint) {
    return `<label class="styk-settings-row">${this.text(label, hint)}<input type="checkbox" role="switch" class="ui-switch" data-setting="${key}" aria-label="${escape(label)}" ${this.value[key] ? "checked" : ""}></label>`;
  }
  select(label, key, options, hint) {
    const hintId = hint ? `styk-settings-hint-${key}` : "";
    return `<label class="styk-settings-row">${this.text(label, hint, hintId)}<span class="ui-select" data-size="sm"><select data-setting="${key}" aria-label="${escape(label)}"${hintId ? ` aria-describedby="${hintId}"` : ""}>${options.map((_tuple) => {const [id, name] = _tuple; const _messages = tupleMessages(_tuple); return `<option value="${escape(id)}" ${String(this.value[key]) === String(id) ? "selected" : ""}${_messages[1] ? ' ' + messageAttributes(_messages[1].key, _messages[1].params) : ''}>${escape(name)}</option>`;}).join("")}</select>${icon("chevronDown")}</span></label>`;
  }
  /** A titled card of rows. */
  group(title, rows, className = "") {
    return `<section class="styk-settings-group${className ? " " + className : ""}"><h4>${escape(title)}</h4><div class="styk-settings-card">${rows}</div></section>`;
  }
  page(tab) {
    return `<header class="styk-settings-page"><h3 ${messageAttributes("settings." + tab, {})}>${escape(this.t("settings." + tab))}</h3><p ${messageAttributes(`settings.${tab}Lede`, {})}>${escape(this.say(`settings.${tab}Lede`))}</p></header>`;
  }
  syncScaleControl() {
    const input = this.content.querySelector('[data-setting="uiScale"]');
    if (!input) return;
    const shown = effectiveUIScale(this.value), auto = this.value.uiScaleMode === 'auto';
    input.value = shown;
    input.setAttribute('aria-valuetext', `${shown}%`);
    fillSlider(input);
    this.content.querySelector('[data-scale-value]').value = `${shown}%`;
    this.content.querySelector('[data-scale-reset]').disabled = auto || !window.stykDesktop?.setUIScale;
    for (const button of this.content.querySelectorAll('[data-scale-mode]'))
      button.setAttribute('aria-pressed', String((button.dataset.scaleMode === 'auto') === auto));
    const note = this.content.querySelector('[data-scale-auto-note]');
    if (note) { note.hidden = !auto; note.textContent = this.t('settings.autoScaleNote').replace('{scale}', `${autoUIScale()}%`); }
  }
  /**
   * UI scale: Automatic (the screen's size picks 100–150%) or Custom (the slider, 75–200%). The slider shows the
   * scale in use and moving it makes the scale Custom; Reset returns to Automatic.
   */
  scaleControl() {
    const available = typeof window.stykDesktop?.setUIScale === 'function';
    const shown = effectiveUIScale(this.value), auto = this.value.uiScaleMode === 'auto';
    const mode = (value, label, _messages = {}) => `<button type="button" class="ui-segmented-item" data-scale-mode="${value}" aria-pressed="${(value === 'auto') === auto}" ${available ? '' : 'disabled'} ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params) : ''}>${escape(label)}</button>`;
    const note = available
      ? `<small class="styk-settings-hint" data-scale-auto-note ${auto ? '' : 'hidden'}>${escape(this.t('settings.autoScaleNote').replace('{scale}', `${autoUIScale()}%`))}</small>`
      : `<small class="styk-settings-hint" ${messageAttributes('settings.browserScale', {})}>${escape(this.t('settings.browserScale'))}</small>`;
    return `<div class="styk-settings-row styk-settings-scale"><span class="styk-settings-text"><label class="styk-settings-label" for="styk-ui-scale" ${messageAttributes('settings.uiScale', {})}>${escape(this.t('settings.uiScale'))}</label>${note}</span><div class="ui-segmented" data-size="sm" role="group" aria-label="${escape(this.t('settings.uiScale'))}" ${messageAttributes('settings.uiScale', {}, "aria-label")}>${mode('auto', this.t('settings.autoScale'), {label: {key: 'settings.autoScale', params: {}}})}${mode('manual', this.t('settings.customScale'), {label: {key: 'settings.customScale', params: {}}})}</div><div class="styk-settings-slider"><input id="styk-ui-scale" class="ui-slider" type="range" data-setting="uiScale" min="${UI_SCALE.min}" max="${UI_SCALE.max}" step="${UI_SCALE.step}" value="${shown}" aria-valuetext="${shown}%" style="--_p:${sliderPercent(shown, UI_SCALE.min, UI_SCALE.max)}%" ${available ? '' : 'disabled'}><output for="styk-ui-scale" data-scale-value>${shown}%</output><button type="button" class="styk-settings-icon-button" data-scale-reset title="${escape(this.t('settings.resetScale'))}" aria-label="${escape(this.t('settings.resetScale'))}" ${auto || !available ? 'disabled' : ''} ${messageAttributes('settings.resetScale', {}, "title")} ${messageAttributes('settings.resetScale', {}, "aria-label")}>${icon('undo')}</button></div></div>`;
  }
  render({retain = false} = {}) {
    const html = this.query.trim() ? this.resultsHTML(this.query) : this.page(this.tab) + this.tabHTML(this.tab);
    const markup = `${this.error ? `<div class="styk-settings-error" role="alert">${icon('alert')}<span>${escape(this.error)}</span></div>` : ""}${html}`;
    if (retain) updateInspectorDOM(this.content, markup, {preserveDisclosure: true});
    else localizedMarkup(this.content, markup);
    if (!this.query.trim() && this.tab === 'shortcuts') this.hotkeySettings.filter();
  }
  /**
   * Every searchable tab at once, keeping only the rows whose words match `query` (a section's title matches all
   * of its rows). The rows are the tabs' own markup, so they change settings exactly as in their tab.
   */
  resultsHTML(query) {
    const needle = query.trim().toLocaleLowerCase(), template = document.createElement('template');
    const words = node => node.textContent.replace(/\s+/g, ' ').toLocaleLowerCase();
    localizedMarkup(template, SEARCH_TABS.map(tab => `<div class="styk-settings-results" data-results-tab="${tab}"><p class="styk-settings-eyebrow" ${messageAttributes('settings.' + tab, {})}>${escape(this.t('settings.' + tab))}</p>${this.tabHTML(tab)}</div>`).join(''));
    for (const group of template.content.querySelectorAll('.styk-settings-group')) {
      if (words(group.querySelector('h4')).includes(needle)) continue;
      for (const row of group.querySelectorAll('.styk-settings-card > *'))
        if (!words(row).includes(needle)) row.remove();
      if (!group.querySelector('.styk-settings-card > *')) group.remove();
    }
    for (const tab of template.content.querySelectorAll('[data-results-tab]'))
      if (!tab.querySelector('.styk-settings-group')) tab.remove();
    const found = template.content.querySelector('.styk-settings-group');
    const heading = `<header class="styk-settings-page"><h3 ${messageAttributes('settings.searchResults', {query: query.trim()})}>${escape(this.say('settings.searchResults', {query: query.trim()}))}</h3></header>`;
    if (!found) return `${heading}<div class="styk-settings-empty">${icon('search')}<p ${messageAttributes('settings.noResults', {query: query.trim()})}>${escape(this.say('settings.noResults', {query: query.trim()}))}</p></div>`;
    const holder = document.createElement('div'); appendLocalized(holder, template.content);
    return heading + holder.innerHTML;
  }
  /** The markup of one tab's sections (render() adds its title). */
  tabHTML(tab) {
    const value = this.value, say = (key, params) => this.say(key, params);
    if (tab === "interface") {
      const themes = `<div class="styk-settings-row styk-settings-block"><span class="styk-settings-label" ${messageAttributes('settings.theme', {})}>${escape(this.t('settings.theme'))}</span><div class="styk-settings-tiles" data-columns="3" role="radiogroup" aria-label="${escape(this.t('settings.theme'))}" ${messageAttributes('settings.theme', {}, "aria-label")}>${['system', 'light', 'dark'].map(theme => `<label class="styk-settings-tile"><input type="radio" name="editor-theme" data-setting="theme" value="${theme}" ${value.theme === theme ? 'checked' : ''}><span class="styk-settings-art styk-settings-theme-art">${themeArt(theme)}</span><span class="styk-settings-tile-name" ${messageAttributes('settings.' + theme, {})}>${escape(this.t('settings.' + theme))}</span></label>`).join('')}</div></div>`;
      const language = this.select(this.t('settings.language'), 'locale', SUPPORTED_LOCALES.map(locale => [locale.id, locale.nativeName]));
      const coverage = this.localization.hasFallback ? `<p class="styk-settings-note">${icon('alert')}<span data-locale-coverage ${messageAttributes('settings.partialLanguage', {})}>${escape(this.t('settings.partialLanguage'))}</span></p>` : '';
      const timeline = `<div class="styk-settings-row styk-settings-block"><div class="styk-settings-tiles" data-columns="2" role="radiogroup" aria-label="${escape(this.t('settings.timelineMode'))}" ${messageAttributes('settings.timelineMode', {}, "aria-label")}>${[
        ["advanced", this.t("timeline.advanced"), this.t("settings.advancedDescription")],
        ["simple", this.t("timeline.simple"), this.t("settings.simpleDescription")],
      ].map((_tuple) => {const [id, label, description] = _tuple; const _messages = tupleMessages(_tuple); return `<label class="styk-settings-tile styk-settings-mode"><input type="radio" name="timeline-mode" data-setting="timelineMode" value="${id}" ${value.timelineMode === id ? "checked" : ""}><span class="styk-settings-art styk-settings-timeline-art" data-art="${id}">${TIMELINE_ART[id]}</span><strong class="styk-settings-tile-name"${_messages[1] ? ' ' + messageAttributes(_messages[1].key, _messages[1].params) : ''}>${escape(label)}</strong><small class="styk-settings-hint"${_messages[2] ? ' ' + messageAttributes(_messages[2].key, _messages[2].params) : ''}>${escape(description)}</small></label>`;}).join("")}</div></div>`;
      const workspace = this.onResetWorkspace
        ? this.group(this.t('settings.workspace'), `<div class="styk-settings-row">${this.text(say("settings.panelLayouts"), say("settings.panelLayoutsNote"))}<button type="button" class="ui-button" data-size="sm" data-settings-reset>${icon("undo")}${escape(this.t('settings.resetPanels'))}</button></div>`)
        : "";
      const touch = this.group(say("settings.touch"),
        this.select(say("settings.touchInterface"), 'touchInterface', [messageTuple(['auto', say("settings.touchAuto")], {1: {key: "settings.touchAuto", params: {}}}), messageTuple(['on', say("settings.touchOn")], {1: {key: "settings.touchOn", params: {}}}), messageTuple(['off', say("settings.touchOff")], {1: {key: "settings.touchOff", params: {}}})], say("settings.touchInterfaceNote"))
        + this.select(say("settings.fingerDraw"), 'fingerDraw', [messageTuple(['auto', say("settings.fingerDrawAuto")], {1: {key: "settings.fingerDrawAuto", params: {}}}), messageTuple(['always', say("settings.fingerDrawAlways")], {1: {key: "settings.fingerDrawAlways", params: {}}}), messageTuple(['never', say("settings.fingerDrawNever")], {1: {key: "settings.fingerDrawNever", params: {}}})], say("settings.fingerDrawNote")));
      return this.group(this.t("settings.appearance"), themes + language + coverage + this.scaleControl())
        + this.group(say("settings.startup"), this.checkbox(say("settings.showHomeOnStartup"), 'showHomeOnStartup', say("settings.showHomeOnStartupNote")))
        + touch
        + this.group(this.t('timeline.title'), timeline)
        + workspace;
    }
    if (tab === "canvas") {
      const nodes = ['segment', 'origin', 'unselected', 'joined', 'static'];
      const handleSize = `<div class="styk-settings-row styk-settings-block"><span class="styk-settings-handle-head">${this.text(say("settings.handleRadius"))}<span class="styk-settings-slider"><input type="range" class="ui-slider" data-setting="handleSize" min="3" max="10" step="1" value="${value.handleSize}" aria-label="${escape(say("settings.handleRadius"))}" style="--_p:${sliderPercent(value.handleSize, 3, 10)}%" ${messageAttributes("settings.handleRadius", {}, "aria-label")}><output data-handle-value>${value.handleSize}px</output></span></span><div class="styk-settings-preview" role="img" aria-label="${escape(say("settings.handlePreview"))}" style="--size:${value.handleSize};--node-outline:${value.outlineHandles ? interfaceText("settings.message1pxSolid000") : interfaceText("settings.message0pxSolidTransparent")}" ${messageAttributes("settings.handlePreview", {}, "aria-label")}>${nodes.map(kind => `<span class="styk-settings-node-cell"><span class="styk-settings-node" style="--node-color:${PIVOT_HANDLE_COLORS[kind]}"></span><small ${messageAttributes('settings.handle.' + kind, {})}>${escape(say('settings.handle.' + kind))}</small></span>`).join('')}</div></div>`;
      return this.group(say("settings.navigation"),
          this.select(say("settings.zoomGesture"), 'canvasZoomGesture', [messageTuple(['ctrl-scroll', say("settings.zoomCtrlScroll")], {1: {key: "settings.zoomCtrlScroll", params: {}}}), messageTuple(['scroll', say("settings.zoomScroll")], {1: {key: "settings.zoomScroll", params: {}}})])
          + this.select(say("settings.smoothZoom"), 'smoothZoom', [messageTuple(['auto', say("settings.smoothZoomAuto")], {1: {key: "settings.smoothZoomAuto", params: {}}}), messageTuple(['on', say("settings.smoothZoomOn")], {1: {key: "settings.smoothZoomOn", params: {}}}), messageTuple(['off', say("settings.smoothZoomOff")], {1: {key: "settings.smoothZoomOff", params: {}}})], say("settings.smoothZoomNote"))
          + this.select(say("settings.boxSelection"), 'marqueeSelection', [messageTuple(['bounds', say("settings.boxBounds")], {1: {key: "settings.boxBounds", params: {}}}), messageTuple(['origins', say("settings.boxOrigins")], {1: {key: "settings.boxOrigins", params: {}}})]))
        + this.group(interfaceText("settings.pasting"), this.select(interfaceText("settings.pastedFigureDepth"), 'pasteDepth', [messageTuple(['same', interfaceText("settings.sameZIndexDefault")], {1: {key: "settings.sameZIndexDefault", params: {}}}), messageTuple(['front', interfaceText("settings.inFront")], {1: {key: "settings.inFront", params: {}}})], interfaceText("settings.chooseWhetherPastedFiguresKeepTheirCopiedDepth")))
        + this.group(interfaceText("settings.duplication"),
          this.select(say('settings.altDragFigureRoot'), 'altDragDuplicate', [messageTuple(['instance', interfaceText("settings.linkedInstance")], {1: {key: "settings.linkedInstance", params: {}}}), messageTuple(['unique', interfaceText("settings.independentCopy")], {1: {key: "settings.independentCopy", params: {}}})], interfaceText("settings.linkedInstancesShareFigureEditsMadeInBuild")))
        + this.group(say("settings.jointHandles"),
          this.checkbox(say("settings.showHandles"), 'showHandles')
          + this.checkbox(say("settings.showUnselected"), 'showUnselectedHandles')
          + this.checkbox(say("settings.autoSize"), 'autoSizeHandles')
          + this.checkbox(say("settings.outline"), 'outlineHandles')
          + handleSize)
        + this.group(say("settings.overlays"),
          this.checkbox(say("settings.virtualCamera"), 'showCamera')
          + this.checkbox(say("settings.motionPaths"), 'motionPaths'))
        + this.group(say("settings.builder"),
          this.checkbox(say("settings.staticHandles"), 'builderShowStaticHandles')
          + this.checkbox(say("settings.highlightSegment"), 'builderHighlightSegment')
          + this.checkbox(say("settings.construction"), 'useBuilderCanvasColor')
          + `<label class="styk-settings-row">${this.text(say("settings.constructionColorShort"))}<span class="styk-settings-color"><input type="color" data-setting="builderCanvasColor" value="${value.builderCanvasColor}" aria-label="${escape(say("settings.constructionColor"))}" ${messageAttributes("settings.constructionColor", {}, "aria-label")}></span></label>`);
    }
    if (tab === "animation") {
      const presets = [0, 2.5, 5, 10, 30, 60];
      const autosave = [messageTuple([0, say("settings.autosaveOff")], {1: {key: "settings.autosaveOff", params: {}}}), ...presets.slice(1, -1).map(seconds => messageTuple([seconds, say("settings.seconds", {count: seconds})], {1: {key: "settings.seconds", params: {count: seconds}}})), messageTuple([60, say("settings.minute")], {1: {key: "settings.minute", params: {}}}),
        ...(presets.includes(value.autosaveSeconds) ? [] : [messageTuple([value.autosaveSeconds, say("settings.seconds", {count: value.autosaveSeconds})], {1: {key: "settings.seconds", params: {count: value.autosaveSeconds}}})])];
      return this.group(say("settings.keyframes"), this.checkbox(say("settings.replaceOnDrop"), 'replaceKeyframesOnDrop', say("settings.replaceOnDropNote")))
        + this.group(say("settings.playback"),
          this.select(say("settings.playbackQuality"), 'playbackQuality', playbackQualityOptions.map(option => messageTuple([option.id, say(option.labelKey)], {1: {key: option.labelKey}})), say("settings.playbackQualityNote"))
          + this.checkbox(say("settings.loop"), 'loopPlayback')
          + this.checkbox(say("settings.fitView"), 'fitViewOnPlayback', say("settings.fitViewNote")))
        + this.group(say("settings.recovery"), this.select(say("settings.autosaveInterval"), 'autosaveSeconds', autosave, say("settings.autosaveNote")));
    }
    if (tab === "shortcuts")
      return this.hotkeySettings.html() + this.group(say("settings.gestures"), `<dl class="styk-settings-gestures">${[
        ['barrel', 'barrelResult'],
        ['eraserEnd', 'eraserEndResult'],
        ['spaceDrag', 'spaceDragResult'],
        ['ctrlSpaceDrag', 'ctrlSpaceDragResult'],
        ['shiftSpaceDrag', 'shiftSpaceDragResult'],
      ].map(([gesture, result]) => `<div class="styk-settings-row"><dt ${messageAttributes('settings.gesture.' + gesture, {})}>${escape(say('settings.gesture.' + gesture))}</dt><dd ${messageAttributes('settings.gesture.' + result, {})}>${escape(say('settings.gesture.' + result))}</dd></div>`).join("")}</dl>`, 'settings-pen-gestures');
    if (tab === 'feedback')
      return `<div class="settings-feedback-actions">${[
        ['bug', 'bug', 'draw'],
        ['idea', 'lightbulb', 'time'],
        ['other', 'message', 'select'],
      ].map(([category, symbol, tint]) => `<button type="button" class="settings-feedback-tile" data-settings-feedback="${category}" data-tint="${tint}"><span class="settings-feedback-art"><span class="settings-feedback-icon">${icon(symbol)}</span></span><span class="settings-feedback-body"><strong ${messageAttributes('settings.feedback.' + category, {})}>${escape(say('settings.feedback.' + category))}</strong><small ${messageAttributes(interfaceText("settings.settingsFeedbackNote", {category: category}), {})}>${escape(say(interfaceText("settings.settingsFeedbackNote", {category: category})))}</small><span class="settings-feedback-go">${escape(say("settings.feedback.start"))}${icon('chevronRight')}</span></span></button>`).join('')}</div>`
        + `<div class="styk-settings-card settings-feedback-private"><span class="settings-feedback-lock">${icon('lock')}</span>${this.text(say("settings.feedback.private"), say("settings.feedback.privateNote"))}<button type="button" class="ui-button" data-size="sm" data-settings-feedback="inbox" ${messageAttributes("settings.feedback.myReports", {})}>${escape(say("settings.feedback.myReports"))}</button></div>`;
    return "";
  }
  /**
   * Every setting's name and tab, for the command palette:
   * [{tab, tabLabel, setting, label}], one per data-setting (a radio group is one).
   */
  searchIndex() {
    const entries = [], seen = new Set(), template = document.createElement('template');
    const text = node => node?.textContent?.replace(/\s+/g, ' ').trim() || '';
    for (const tab of SEARCH_TABS) {
      localizedMarkup(template, this.tabHTML(tab));
      for (const field of template.content.querySelectorAll('[data-setting]')) {
        const setting = field.dataset.setting;
        if (seen.has(setting)) continue;
        seen.add(setting);
        const label = field.getAttribute('aria-label') || field.closest('[role=radiogroup]')?.getAttribute('aria-label')
          || (field.id && text(template.content.querySelector(`label[for="${field.id}"]`)))
          || text(field.closest('.styk-settings-row')?.querySelector('.styk-settings-label'));
        if (label) entries.push({tab, tabLabel: this.t('settings.' + tab), setting, label});
      }
    }
    return entries;
  }
  commit(patch) {
    if (patch.builderCanvasColor !== undefined) patch = {...patch,useBuilderCanvasColor:true};
    // Moving the slider chooses a Custom scale.
    if (patch.uiScale !== undefined && patch.uiScaleMode === undefined) patch = {...patch, uiScaleMode: 'manual'};
    if (patch.autosaveSeconds !== undefined)
      patch.autosaveSeconds = Number(patch.autosaveSeconds);
    const previous = this.value;
    const next = normalizeEditorSettings({ ...previous, ...patch });
    this.value = next;
    if (patch.uiScale !== undefined || patch.uiScaleMode !== undefined) this.appliedScale = applyUIScale(effectiveUIScale(next));
    if (patch.theme !== undefined) applyEditorTheme(next.theme);
    if (patch.locale !== undefined) this.localization.setLocale(next.locale);
    const normalizedPatch = Object.fromEntries(
      Object.keys(patch)
        .filter((key) => key in next)
        .map((key) => [key, next[key]]),
    );
    try {
      Promise.resolve(this.onChange(normalizedPatch, { ...next })).catch(
        (error) => this.showError(error),
      );
    } catch (error) {
      this.value = previous;
      if (patch.uiScale !== undefined || patch.uiScaleMode !== undefined) { this.appliedScale = applyUIScale(effectiveUIScale(previous)); this.syncScaleControl(); }
      if (patch.theme !== undefined) applyEditorTheme(previous.theme);
      if (patch.locale !== undefined) this.localization.setLocale(previous.locale);
      this.showError(error);
      return;
    }
    this.pending = { ...next };
    this.pendingRevision = (this.pendingRevision || 0) + 1;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), patch.locale !== undefined ? 0 : 200);
    if (patch.timelineMode !== undefined) this.render();
    if (patch.builderCanvasColor !== undefined) {
      const toggle = this.content.querySelector('[data-setting="useBuilderCanvasColor"]');
      if (toggle) toggle.checked = next.useBuilderCanvasColor;
    }
    if (patch.outlineHandles !== undefined)
      this.content
        .querySelector(".styk-settings-preview")
        ?.style.setProperty(
          "--node-outline",
          next.outlineHandles ? interfaceText("settings.message1pxSolid000") : interfaceText("settings.message0pxSolidTransparent"),
        );
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending) return this.chain;
    const snapshot = this.pending,
      revision = this.pendingRevision;
    this.pending = null;
    this.chain = this.chain.then(async () => {
      try {
        await this.onPersist(snapshot);
        this.error = null;
        this.content.querySelector(".styk-settings-error")?.remove();
        return true;
      } catch (error) {
        if (revision === this.pendingRevision && !this.pending)
          this.pending = snapshot;
        this.showError(error);
        return false;
      }
    });
    return this.chain;
  }
  showError(error) {
    this.error = error?.message || String(error);
    if (this.dialog.open) this.render();
  }
  async destroy() {
    await this.flush();
    this.unsubscribeLocale?.();
    this.compactLayout.removeEventListener('change', this.syncTabOrientation);
    this.dialog.remove();
  }
}
