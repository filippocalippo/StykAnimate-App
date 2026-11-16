import {tupleMessages, messageTuple, messageAttributes, localizedMarkup, localizedAttribute, appendLocalized, connectTranslations, messageHTML} from './localization-bindings.mjs';

import {t as interfaceText} from './localization.mjs';

import {icon} from './icons.mjs';
import {MOTION_PATH_SPEED_COLORS} from './motion-path.mjs';

/** Explicit display settings; values belong to editor preferences. */
export class MotionPathControls {
  constructor({button, getSettings, getEnabled, onChange, onToggle}) {
    Object.assign(this, {button, getSettings, getEnabled, onChange, onToggle});
    const trigger = this.trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'path-options-button ui-split-more';
    localizedMarkup(trigger, icon('chevron-down'));
    localizedAttribute(trigger, "title", "motionPathControls.motionPathSettings", {});
    localizedAttribute(trigger, 'aria-label', "motionPathControls.motionPathSettings", {});
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-controls', 'path-popover');
    trigger.setAttribute('aria-expanded', 'false');
    const tool = document.createElement('div');
    tool.className = 'motion-path-tool ui-split'; tool.dataset.size = 'sm';
    tool.setAttribute('role', 'group');
    localizedAttribute(tool, 'aria-label', "motionPathControls.motionPaths", {});
    button.before(tool);
    appendLocalized(tool, button, trigger);
    connectTranslations(tool);
    const panel = this.panel = document.createElement('div');
    panel.className = 'path-popover ui-popover';
    panel.id = 'path-popover';
    panel.setAttribute('popover', 'auto');
    panel.setAttribute('role', 'dialog');
    localizedAttribute(panel, 'aria-label', "motionPathControls.motionPathSettings", {});
    // The kit's popover (features/view-options.css): the title with its on/off switch (a pressed button drawn as
    // the kit's switch); what the trails follow; the frame range with its exact count; how trails look; then
    // how far a right-button arc drag reaches and how it fades.
    const choice = (key, label, options, _messages = {}) => `<div class="ui-row path-row"><span class="ui-row-label" ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params) : ''}>${label}</span><div class="ui-segmented path-choice" data-size="sm" data-fill role="group" aria-label="${label}" ${_messages.label ? messageAttributes(_messages.label.key, _messages.label.params, 'aria-label') : ''}>${options.map((_tuple) => {const [value, text, tip] = _tuple; const _messages = tupleMessages(_tuple); return `<button type="button" class="ui-segmented-item" data-choice="${key}" data-value="${value}" title="${tip}" ${_messages.text ? messageAttributes(_messages.text.key, _messages.text.params) : ''}${_messages[2] ? ' ' + messageAttributes(_messages[2].key, _messages[2].params, 'title') : ''}>${text}</button>`;}).join('')}</div></div>`;
    const toggle = (key, label, tip, extra = '', _messages = {}) => `<label class="ui-switch-row path-row" title="${tip}"><span>${label}${extra}</span><input type="checkbox" class="ui-switch" role="switch" data-path="${key}"></label>`;
    const legend = `<span class="path-speed-legend" aria-hidden="true"><span style="background:linear-gradient(90deg,${MOTION_PATH_SPEED_COLORS.join(',')})"></span>${messageHTML("motionPathControls.slowFast", {})}</span>`;
    localizedMarkup(panel, `<header class="ui-popover-head"><strong class="ui-popover-title">${icon('motion-path')}${messageHTML("motionPathControls.motionPaths", {})}</strong><button type="button" class="path-switch" data-path-toggle aria-label="Show motion paths" data-i18n-aria-label="motionPathControls.showMotionPaths"></button></header>
<div class="ui-popover-body path-body">${choice('motionPathAllTargets', interfaceText("motionPathControls.figures"), [messageTuple(['false', interfaceText("motionPathControls.selected"), interfaceText("motionPathControls.trailsForTheSelectedFigures")], {1: {key: "motionPathControls.selected", params: {}}, 2: {key: "motionPathControls.trailsForTheSelectedFigures", params: {}}}), messageTuple(['true', interfaceText("motionPathControls.all"), interfaceText("motionPathControls.trailsForEveryFigureOnTheStage")], {1: {key: "motionPathControls.all", params: {}}, 2: {key: "motionPathControls.trailsForEveryFigureOnTheStage", params: {}}})], {label: {key: "motionPathControls.figures", params: {}}})}
${choice('motionPathJoints', interfaceText("motionPathControls.joints"), [messageTuple(['selected', interfaceText("motionPathControls.selected"), interfaceText("motionPathControls.theSelectedJointOrEachFigureSOrigin")], {1: {key: "motionPathControls.selected", params: {}}, 2: {key: "motionPathControls.theSelectedJointOrEachFigureSOrigin", params: {}}}), messageTuple(['tips', interfaceText("motionPathControls.handsFeet"), interfaceText("motionPathControls.everyLimbTipHandsFeetHeadAndThe")], {1: {key: "motionPathControls.handsFeet", params: {}}, 2: {key: "motionPathControls.everyLimbTipHandsFeetHeadAndThe", params: {}}})], {label: {key: "motionPathControls.joints", params: {}}})}
<fieldset class="path-range"><legend data-i18n="motionPathControls.frameRange">Frame range</legend><div class="path-presets ui-segmented" data-size="sm" data-fill role="group" aria-label="Frame range presets" data-i18n-aria-label="motionPathControls.frameRangePresets"><button type="button" class="ui-segmented-item" data-range="12">±12</button><button type="button" class="ui-segmented-item" data-range="24">±24</button><button type="button" class="ui-segmented-item" data-range="48">±48</button><button type="button" class="ui-segmented-item" data-range="0" data-i18n="motionPathControls.full">Full</button></div>
<label class="ui-row path-row"><span class="ui-row-label" data-i18n="motionPathControls.aroundPlayhead">Around playhead</span><span class="path-number"><input type="number" data-path="motionPathRange" min="0" max="4000" step="1" aria-label="Frames either side of playhead" title="0 shows the full animation" data-i18n-aria-label="motionPathControls.framesEitherSideOfPlayhead" data-i18n-title="motionPathControls.message0ShowsTheFullAnimation"><span data-i18n="motionPathControls.frames">frames</span></span></label></fieldset>
<fieldset class="path-range path-falloff" title="Right-drag a trail point: nearby keys follow, fading out with distance; scroll to resize" data-i18n-title="motionPathControls.rightDragATrailPointNearbyKeysFollow"><legend>${messageHTML("motionPathControls.reshapeArc", {})}<span class="path-key" data-i18n="motionPathControls.rightDrag">Right-drag</span></legend><div class="ui-segmented" data-size="sm" data-fill role="group" aria-label="Falloff shape" data-i18n-aria-label="motionPathControls.falloffShape">${[messageTuple(['smooth', interfaceText("motionPathControls.smooth"), interfaceText("motionPathControls.neighboursFollowCloselyFarFramesBarelyMove")], {1: {key: "motionPathControls.smooth", params: {}}, 2: {key: "motionPathControls.neighboursFollowCloselyFarFramesBarelyMove", params: {}}}), messageTuple(['linear', interfaceText("motionPathControls.linear"), interfaceText("motionPathControls.fadesEvenlyWithDistance")], {1: {key: "motionPathControls.linear", params: {}}, 2: {key: "motionPathControls.fadesEvenlyWithDistance", params: {}}}), messageTuple(['sharp', interfaceText("motionPathControls.sharp"), interfaceText("motionPathControls.mostlyTheDraggedFrameNeighboursFollowALittle")], {1: {key: "motionPathControls.sharp", params: {}}, 2: {key: "motionPathControls.mostlyTheDraggedFrameNeighboursFollowALittle", params: {}}}), messageTuple(['flat', interfaceText("motionPathControls.flat"), interfaceText("motionPathControls.movesEverythingInReachTogether")], {1: {key: "motionPathControls.flat", params: {}}, 2: {key: "motionPathControls.movesEverythingInReachTogether", params: {}}})]
    .map((_tuple) => {const [value, text, tip] = _tuple; const _messages = tupleMessages(_tuple); return `<button type="button" class="ui-segmented-item" data-choice="motionPathFalloffShape" data-value="${value}" title="${tip}"${_messages[2] ? ' ' + messageAttributes(_messages[2].key, _messages[2].params, 'title') : ''}>${text}</button>`;}).join('')}</div>
<label class="ui-row path-row"><span class="ui-row-label" data-i18n="motionPathControls.aroundDraggedPoint">Around dragged point</span><span class="path-number"><input type="number" data-path="motionPathFalloffRadius" min="1" max="240" step="1" aria-label="Frames either side of the dragged point" data-i18n-aria-label="motionPathControls.framesEitherSideOfTheDraggedPoint"><span data-i18n="motionPathControls.frames">frames</span></span></label></fieldset>
<div class="path-display">${toggle('motionPathLabels', interfaceText("motionPathControls.frameNumbers"), interfaceText("motionPathControls.numberTheKeysTheEndsAndTheCurrent"), undefined, {label: {key: "motionPathControls.frameNumbers", params: {}}})}${toggle('motionPathDots', interfaceText("motionPathControls.inBetweenDots"), interfaceText("motionPathControls.aDotForEveryInBetweenTheirSpacing"), undefined, {label: {key: "motionPathControls.inBetweenDots", params: {}}})}${toggle('motionPathSpeed', interfaceText("motionPathControls.speedColours"), interfaceText("motionPathControls.colourTrailsBySpeedCoolWhereMotionIs"), legend, {label: {key: "motionPathControls.speedColours", params: {}}})}${toggle('motionPathRelative', interfaceText("motionPathControls.relativeToBody"), interfaceText("motionPathControls.keepATravellingFigureInPlaceSoIts"), undefined, {label: {key: "motionPathControls.relativeToBody", params: {}}})}</div></div>`);
    appendLocalized(document.body, panel);
    const open = () => { this.sync(); panel.showPopover(); this.position(); };
    trigger.addEventListener('click', event => {
      event.stopPropagation();
      if (panel.matches(':popover-open')) panel.hidePopover(); else open();
    });
    button.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); open(); panel.querySelector('button').focus(); }
    });
    panel.addEventListener('toggle', event => trigger.setAttribute('aria-expanded', String(event.newState === 'open')));
    panel.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); panel.hidePopover(); trigger.focus(); }
    });
    panel.addEventListener('click', event => {
      event.stopPropagation();
      if (event.target.closest('[data-path-toggle]')) onToggle();
      const preset = event.target.closest('[data-range]'), picked = event.target.closest('[data-choice]');
      if (preset) onChange({motionPathRange: Number(preset.dataset.range)});
      if (picked) onChange({[picked.dataset.choice]: picked.dataset.choice === 'motionPathAllTargets' ? picked.dataset.value === 'true' : picked.dataset.value});
      if (preset || picked || event.target.closest('[data-path-toggle]')) this.sync();
    });
    panel.addEventListener('change', event => {
      const input = event.target.closest('[data-path]');
      if (!input) return;
      if (input.type === 'number' && (!input.value || !input.validity.valid)) { this.sync(); return; }
      const value = input.type === 'checkbox' ? input.checked : Number(input.value);
      onChange({[input.dataset.path]: value});
      this.sync();
    });
    window.addEventListener('resize', () => { if (panel.matches(':popover-open')) this.position(); });
    this.sync();
  }
  position() {
    const r = this.trigger.getBoundingClientRect(), panel = this.panel;
    panel.style.left = `${Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, r.right - panel.offsetWidth))}px`;
    panel.style.top = `${Math.max(8, Math.min(innerHeight - panel.offsetHeight - 8, r.bottom + 8))}px`;
  }
  sync() {
    const settings = this.getSettings(), enabled = this.getEnabled();
    this.panel.querySelector('[data-path="motionPathRange"]').closest('label').hidden = settings.motionPathRange === 0;
    for (const input of this.panel.querySelectorAll('[data-path]')) {
      const value = settings[input.dataset.path];
      if (input.type === 'checkbox') input.checked = Boolean(value); else input.value = String(value);
    }
    for (const option of this.panel.querySelectorAll('[data-choice]'))
      option.setAttribute('aria-pressed', String(String(settings[option.dataset.choice]) === option.dataset.value));
    for (const preset of this.panel.querySelectorAll('[data-range]')) preset.setAttribute('aria-pressed', String(Number(preset.dataset.range) === settings.motionPathRange));
    const toggle = this.panel.querySelector('[data-path-toggle]');
    toggle.setAttribute('aria-pressed', String(enabled));
    localizedAttribute(toggle, "title", (enabled ? "motionPathControls.hideMotionPaths" : "motionPathControls.showMotionPaths"), (enabled ? {} : {}));
    this.button.setAttribute('aria-pressed', String(enabled));
    localizedAttribute(this.button, 'aria-label', "motionPathControls.motionPaths", {});
  }
}
