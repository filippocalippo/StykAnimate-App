import { icon } from "./icons.mjs";
import { PIVOT_HANDLE_COLORS } from "./canvas-interactions.mjs";
import { Localization, normalizeLocale, SUPPORTED_LOCALES } from "./localization.mjs";

export const EDITOR_SETTINGS_KEY = "stykanimate.editor.settings.v1";
export const DEFAULT_EDITOR_SETTINGS = Object.freeze({
  locale: "en",
  timelineMode: "advanced",
  showHandles: true,
  showCamera: false,
  showUnselectedHandles: true,
  autoSizeHandles: true,
  outlineHandles: true,
  builderShowStaticHandles: true,
  builderHighlightSegment: false,
  builderCanvasColor: '#ffffff',
  useBuilderCanvasColor: false,
  handleSize: 5,
  onionCount: 0,
  onionAhead: true,
  onionJoined: true,
  onionOpacity: 0.14,
  onionBefore: 2,
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
  loopPlayback: true,
  autosaveSeconds: 2.5,
});
export function normalizeEditorSettings(value = {}) {
  const result = { ...DEFAULT_EDITOR_SETTINGS };
  result.locale = normalizeLocale(value?.locale);
  if (value?.timelineMode === "simple" || value?.timelineMode === "advanced")
    result.timelineMode = value.timelineMode;
  for (const key of [
    "showHandles",
    "showCamera",
    "showUnselectedHandles",
    "autoSizeHandles",
    "outlineHandles",
    "builderShowStaticHandles",
    "builderHighlightSegment",
    "useBuilderCanvasColor",
    "onionAhead",
    "onionJoined",
    "onionFade",
    "onionTint",
    "onionCamera",
    "onionShowOnTop",
    "loopPlayback",
  ])
    if (typeof value?.[key] === "boolean") result[key] = value[key];
  if (typeof value?.builderCanvasColor === 'string' && /^#[0-9a-f]{6}$/i.test(value.builderCanvasColor))
    result.builderCanvasColor = value.builderCanvasColor.toLowerCase();
  for (const [key, min, max] of [
    ["handleSize", 3, 10],
    ["onionCount", 0, 9],
    ["onionOpacity", 0, 1],
    ["onionBefore", 0, 10],
    ["onionAfter", 0, 10],
    ["onionStep", 1, 20],
    ["autosaveSeconds", 0, 300],
  ])
    if (Number.isFinite(value?.[key]))
      result[key] = Math.max(min, Math.min(max, value[key]));
  result.onionCount = Math.round(result.onionCount);
  for (const key of ['onionBefore','onionAfter','onionStep']) result[key] = Math.round(result[key]);
  for (const key of ['onionBeforeColor','onionAfterColor'])
    if (typeof value?.[key] === 'string' && /^#[0-9a-f]{6}$/i.test(value[key])) result[key] = value[key].toLowerCase();
  if (['all','selected'].includes(value?.onionScope)) result.onionScope = value.onionScope;
  if (['keyframes','frames'].includes(value?.onionMode)) result.onionMode = value.onionMode;
  return result;
}
const SHORTCUTS = [
  [
    "Tools",
    [
      ["Select", "V"],
      ["Pose", "P"],
      ["Handle edit", "Hold R / Ctrl R"],
      ["Line", "L"],
      ["Circle", "C"],
      ["Text", "T"],
      ["Pan", "H / Space drag"],
    ],
  ],
  [
    "Animation",
    [
      ["Play / pause", "Space"],
      ["New keyframe", "F6"],
      ["Previous / next frame", "← / →"],
      ["First / last frame", "Home / End"],
      ["Onion skins", "O"],
      ["Show joints", "J"],
    ],
  ],
  [
    "Editing",
    [
      ["Undo", "Ctrl Z"],
      ["Redo", "Ctrl Shift Z"],
      ["Copy / paste", "Ctrl C / Ctrl V"],
      ["Duplicate", "Ctrl D"],
      ["Select all", "Ctrl A"],
      ["Delete", "Delete"],
      ["Save", "Ctrl S"],
      ["Open", "Ctrl O"],
    ],
  ],
];
const STYLE = `
.styk-settings{width:650px;max-width:calc(100vw - 32px);height:470px;max-height:calc(100dvh - 48px);padding:0;border:1px solid #d9d9d9;border-radius:9px;background:#fff;color:#2c2c2c;box-shadow:0 15px 60px #0003;overflow:hidden;font:12px Inter,'Segoe UI',sans-serif}.styk-settings::backdrop{background:#0005}.styk-settings-head{height:53px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid #e5e5e5}.styk-settings-head h2{margin:0;font-size:14px;font-weight:600}.styk-settings-head button{height:27px;width:27px;border-radius:4px}.styk-settings-head .icon{width:16px;height:16px}.styk-settings-layout{display:flex;height:calc(100% - 53px)}.styk-settings-tabs{width:150px;flex-shrink:0;padding:12px 8px;border-right:1px solid #e5e5e5;background:#fafafa}.styk-settings-tabs button{display:flex;align-items:center;justify-content:flex-start;width:100%;height:33px;padding:0 10px;border-radius:4px;gap:9px;font-size:11px;margin-bottom:3px;color:#565656}.styk-settings-tabs button .icon{width:15px;height:15px}.styk-settings-tabs button[aria-selected=true]{background:#e5f4ff;color:#007be5;font-weight:600}.styk-settings-content{flex:1;min-width:0;overflow:auto;padding:20px}.styk-settings-content h3{margin:0 0 13px;font-size:12px;font-weight:600}.styk-settings-group+.styk-settings-group{margin-top:22px;padding-top:19px;border-top:1px solid #e5e5e5}.styk-settings-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:34px;margin:5px 0;font-size:11px}.styk-settings-row input[type=checkbox]{width:14px;height:14px;margin:0;accent-color:#0d99ff}.styk-settings-row input[type=number],.styk-settings-row select{width:84px;height:29px;padding:0 8px;border:1px solid transparent;border-radius:4px;background:#f2f2f2;font-size:11px}.styk-settings-row select{width:114px}.styk-settings-row input:focus,.styk-settings-row select:focus{outline:1px solid #0d99ff}.styk-settings-row input[type=range]{width:130px;accent-color:#0d99ff}.styk-settings-number{display:flex;align-items:center;gap:7px}.styk-settings-number small{font-size:10px;color:#858585;min-width:14px}.styk-settings-mode{display:block;position:relative;padding:14px 36px 14px 13px;border:1px solid #dedede;border-radius:6px;margin-bottom:10px;cursor:pointer}.styk-settings-mode:has(input:checked){border-color:#0d99ff;background:#f1f9ff}.styk-settings-mode input{position:absolute;right:13px;top:16px;accent-color:#0d99ff}.styk-settings-mode strong{display:block;font-size:12px;font-weight:600;margin-bottom:5px}.styk-settings-mode small{font-size:11px;color:#767676;line-height:1.5}.styk-settings-reset{height:29px;padding:0 10px;border:1px solid #dedede;border-radius:4px;font-size:11px}.styk-settings-note{font-size:10px;color:#858585;line-height:1.5;margin:12px 0 0}.styk-settings-shortcuts{display:grid;grid-template-columns:1fr auto;gap:9px 14px;font-size:11px}.styk-settings-shortcuts kbd{font:10px Inter,'Segoe UI',sans-serif;color:#767676;background:#f2f2f2;border-radius:3px;padding:2px 5px;text-align:right}.styk-settings-error{padding:8px 10px;margin-bottom:15px;border-radius:4px;background:#fff1f0;color:#b42318;font-size:11px;line-height:1.5}.styk-settings-preview{display:flex;align-items:center;gap:12px;padding:12px 0;color:#858585;font-size:10px}.styk-settings-node{display:inline-block;width:calc(var(--size)*2px);height:calc(var(--size)*2px);border-radius:50%;border:var(--node-outline,1px solid #000);background:var(--node-color)}@media(max-width:560px){.styk-settings-tabs{width:115px;padding:10px 5px}.styk-settings-tabs button{gap:6px;padding:0 6px}.styk-settings-content{padding:16px}.styk-settings-row{gap:8px}.styk-settings-row input[type=range]{width:90px}}
`;
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export class EditorSettings {
  constructor({
    value,
    getValue,
    onChange = () => {},
    onPersist,
    onResetWorkspace,
    shortcuts = SHORTCUTS,
    localization,
    onPrivacy,
  } = {}) {
    if (value === undefined) {
      try {
        value = JSON.parse(localStorage.getItem(EDITOR_SETTINGS_KEY) || "null");
      } catch {
        value = {};
      }
    }
    this.value = normalizeEditorSettings(value);
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
    this.shortcuts = shortcuts;
    this.tab = "interface";
    this.chain = Promise.resolve();
    this.pending = null;
    this.timer = null;
    this.error = null;
    this.style = document.createElement("style");
    this.style.dataset.stykSettings = "";
    this.style.textContent = STYLE;
    document.head.append(this.style);
    this.dialog = document.createElement("dialog");
    this.dialog.className = "styk-settings";
    this.dialog.setAttribute("aria-label", this.t("settings.editorLabel"));
    this.dialog.innerHTML = `<header class="styk-settings-head"><h2>${escape(this.t("settings.title"))}</h2><button type="button" aria-label="${escape(this.t("settings.close"))}">${icon("x")}</button></header><div class="styk-settings-layout"><nav class="styk-settings-tabs" role="tablist" aria-label="${escape(this.t("settings.sections"))}">${[
      ["interface", "Interface", "sliders"],
      ["canvas", "Canvas", "frame"],
      ["animation", "Animation", "play"],
      ["shortcuts", "Shortcuts", "help"],
    ]
      .map(
        ([id, name, symbol]) =>
          `<button type="button" role="tab" data-tab="${id}" aria-controls="styk-settings-content">${icon(symbol)}<span data-settings-tab-label>${escape(this.t('settings.' + id))}</span></button>`,
      )
      .join(
        "",
      )}</nav><section id="styk-settings-content" class="styk-settings-content" role="tabpanel"></section></div>`;
    document.body.append(this.dialog);
    this.content = this.dialog.querySelector(".styk-settings-content");
    if (onPrivacy) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Privacy & diagnostics'; button.dataset.settingsPrivacy = '';
      button.onclick = () => { this.close(); void this.onPrivacy(); };
      this.dialog.querySelector('.styk-settings-tabs').append(button);
    }
    this.unsubscribeLocale = this.localization.subscribe(() => this.refreshLanguage());
    this.dialog.querySelector(".styk-settings-head button").onclick = () =>
      this.close();
    this.dialog.addEventListener("close", () => void this.flush());
    this.dialog.addEventListener("keydown", (event) => {
      event.stopPropagation();
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
      if (event.target.closest("[data-settings-reset]"))
        Promise.resolve(this.onResetWorkspace?.()).catch((error) =>
          this.showError(error),
        );
    });
    this.dialog.addEventListener("change", (event) => {
      const input = event.target.closest("[data-setting]");
      if (!input) return;
      let value =
        input.type === "checkbox"
          ? input.checked
          : input.type === "number" || input.type === "range"
            ? Number(input.value)
            : input.value;
      if (input.dataset.setting === "onionOpacity") value /= 100;
      this.commit({ [input.dataset.setting]: value });
    });
    this.dialog.addEventListener("input", (event) => {
      if (event.target.dataset.setting === "handleSize") {
        const size = Number(event.target.value);
        this.content
          .querySelector(".styk-settings-preview")
          ?.style.setProperty("--size", size);
        this.content.querySelector("[data-handle-value]").textContent =
          `${size}px`;
      }
    });
  }
  t(key, params) { return this.localization.t(key, params); }
  refreshLanguage() {
    this.value.locale = this.localization.locale;
    this.dialog.lang = this.localization.locale;
    this.dialog.setAttribute('aria-label', this.t('settings.editorLabel'));
    this.dialog.querySelector('.styk-settings-head h2').textContent = this.t('settings.title');
    this.dialog.querySelector('.styk-settings-head button').setAttribute('aria-label', this.t('settings.close'));
    this.dialog.querySelector('[role=tablist]').setAttribute('aria-label', this.t('settings.sections'));
    for (const button of this.dialog.querySelectorAll('[data-tab]'))
      button.querySelector('[data-settings-tab-label]').textContent = this.t('settings.' + button.dataset.tab);
    if (!this.dialog.open) return;
    const active = document.activeElement, setting = active?.dataset.setting;
    const draft = active?.value;
    const scrollTop = this.content.scrollTop;
    this.render();
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
  setValue(value) {
    this.value = normalizeEditorSettings(value);
    const changed = this.localization.setLocale(this.value.locale);
    if (!changed && this.dialog.open) this.render();
  }
  open(tab = this.tab) {
    if (this.getValue) this.value = normalizeEditorSettings(this.getValue());
    this.localization.setLocale(this.value.locale);
    this.dialog.lang = this.localization.locale;
    this.selectTab(tab);
    if (!this.dialog.open) this.dialog.showModal();
    this.dialog.querySelector(`[data-tab="${this.tab}"]`).focus();
  }
  close() {
    this.dialog.close();
    void this.flush();
  }
  selectTab(tab) {
    this.tab = ["interface", "canvas", "animation", "shortcuts"].includes(tab)
      ? tab
      : "interface";
    for (const button of this.dialog.querySelectorAll("[role=tab]")) {
      const selected = button.dataset.tab === this.tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    this.render();
  }
  checkbox(label, key) {
    return `<label class="styk-settings-row"><span>${label}</span><input type="checkbox" data-setting="${key}" ${this.value[key] ? "checked" : ""}></label>`;
  }
  number(label, key, min, max, unit = "", value = this.value[key]) {
    return `<label class="styk-settings-row"><span>${label}</span><span class="styk-settings-number"><input type="number" data-setting="${key}" min="${min}" max="${max}" value="${value}" aria-label="${label}"><small>${unit}</small></span></label>`;
  }
  render() {
    const value = this.value;
    let html = "";
    if (this.tab === "interface")
      html = `<section class="styk-settings-group"><label class="styk-settings-row"><span>${escape(this.t('settings.language'))}</span><select data-setting="locale" aria-label="${escape(this.t('settings.language'))}">${SUPPORTED_LOCALES.map(locale => `<option value="${locale.id}" ${value.locale === locale.id ? 'selected' : ''}>${escape(locale.nativeName)}</option>`).join('')}</select></label>${value.locale !== 'en' ? `<p class="styk-settings-note" data-locale-coverage>${escape(this.t('settings.partialLanguage'))}</p>` : ''}</section><section class="styk-settings-group"><h3>${escape(this.t('timeline.title'))}</h3>${[
        ["advanced", this.t("timeline.advanced"), this.t("settings.advancedDescription")],
        ["simple", this.t("timeline.simple"), this.t("settings.simpleDescription")],
      ]
        .map(
          ([id, label, note]) =>
            `<label class="styk-settings-mode"><input type="radio" name="timeline-mode" data-setting="timelineMode" value="${id}" ${value.timelineMode === id ? "checked" : ""}><strong>${escape(label)}</strong><small>${escape(note)}</small></label>`,
        )
        .join(
          "",
        )}</section>${this.onResetWorkspace ? `<section class="styk-settings-group"><h3>${escape(this.t('settings.workspace'))}</h3><button type="button" class="styk-settings-reset" data-settings-reset>${escape(this.t('settings.resetPanels'))}</button></section>` : ""}`;
    if (this.tab === "canvas")
      html = `<section class="styk-settings-group"><h3>Joint handles</h3>${this.checkbox("Show handles", "showHandles")}${this.checkbox("Show virtual camera", "showCamera")}${this.checkbox("Show unselected figures", "showUnselectedHandles")}${this.checkbox("Size handles automatically", "autoSizeHandles")}${this.checkbox("Outline handles", "outlineHandles")}<label class="styk-settings-row"><span>Handle radius</span><span class="styk-settings-number"><input type="range" data-setting="handleSize" min="3" max="10" step="1" value="${value.handleSize}" aria-label="Handle radius"><small data-handle-value>${value.handleSize}px</small></span></label><div class="styk-settings-preview" style="--size:${value.handleSize};--node-outline:${value.outlineHandles ? "1px solid #000" : "0px solid transparent"}">${["segment", "origin", "unselected", "joined", "static"].map((kind) => `<span class="styk-settings-node" title="${kind === "segment" ? "Selected joint" : kind === "origin" ? "Figure origin" : kind === "unselected" ? "Unselected joint" : kind === "joined" ? "Joined joint" : "Static joint"}" style="--node-color:${PIVOT_HANDLE_COLORS[kind]}"></span>`).join("")}</div></section>`;
    if (this.tab === 'canvas')
      html += `<section class="styk-settings-group"><h3>Figure builder</h3>${this.checkbox('Show static handles · F10','builderShowStaticHandles')}${this.checkbox('Highlight selected segment · F12','builderHighlightSegment')}${this.checkbox('Use construction background','useBuilderCanvasColor')}<label class="styk-settings-row"><span>Construction color · F9</span><input type="color" data-setting="builderCanvasColor" value="${value.builderCanvasColor}" aria-label="Construction background color"></label><p class="styk-settings-note">Construction aids appear while building. They do not change saved scene colors or exported frames.</p></section>`;
    if (this.tab === "animation")
      html = `<section class="styk-settings-group"><h3>Playback</h3>${this.checkbox("Loop animation", "loopPlayback")}</section><section class="styk-settings-group"><h3>Recovery</h3><label class="styk-settings-row"><span>Autosave interval</span><select data-setting="autosaveSeconds" aria-label="Autosave interval">${[[0, "Off"], [2.5, "2.5 seconds"], [5, "5 seconds"], [10, "10 seconds"], [30, "30 seconds"], [60, "1 minute"], ...([0, 2.5, 5, 10, 30, 60].includes(value.autosaveSeconds) ? [] : [[value.autosaveSeconds, `${value.autosaveSeconds} seconds`]])].map(([seconds, label]) => `<option value="${seconds}" ${value.autosaveSeconds === seconds ? "selected" : ""}>${label}</option>`).join("")}</select></label></section>`;
    if (this.tab === "shortcuts")
      html = this.shortcuts
        .map(
          ([group, rows]) =>
            `<section class="styk-settings-group"><h3>${escape(group)}</h3><div class="styk-settings-shortcuts">${rows.map(([label, key]) => `<span>${escape(label)}</span><kbd>${escape(key)}</kbd>`).join("")}</div></section>`,
        )
        .join("");
    this.content.innerHTML = `${this.error ? `<div class="styk-settings-error" role="alert">${escape(this.error)}</div>` : ""}${html}`;
  }
  commit(patch) {
    if (patch.builderCanvasColor !== undefined) patch = {...patch,useBuilderCanvasColor:true};
    if (patch.autosaveSeconds !== undefined)
      patch.autosaveSeconds = Number(patch.autosaveSeconds);
    const previous = this.value;
    const next = normalizeEditorSettings({ ...previous, ...patch });
    this.value = next;
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
      if (patch.locale !== undefined) this.localization.setLocale(previous.locale);
      this.showError(error);
      return;
    }
    this.pending = { ...next };
    this.pendingRevision = (this.pendingRevision || 0) + 1;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 200);
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
          next.outlineHandles ? "1px solid #000" : "0px solid transparent",
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
    this.dialog.remove();
    this.style.remove();
  }
}
