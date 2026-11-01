import {messageTuple, translatedElement, localizedText, localizedAttribute, localizedMarkup} from './localization-bindings.mjs';

import {messageError} from './localized-error.mjs';

import {t as interfaceText, messageText as sayTimeline} from './localization.mjs';

import {layerAppearance,thumbnailVisualChange} from './thumbnail-validity.mjs';
import {mountTimelineNavigation} from './timeline-navigation.mjs';
import {attachTimelineHotkeys} from './timeline-hotkeys.mjs';
import {pasteSheetClipboard} from './shared-clipboard.mjs';
import {sheetKeyTimes, sheetKeyAt} from './layer-sheet.mjs';
import {icon} from './icons.mjs';
import {keyEasing,EASING_MODES,DEFAULT_BEZIER} from './keyframe-easing.mjs';
import {showKeyframeEasingPopover} from './keyframe-easing-popover.mjs';
import {showTimelineMenu} from './timeline-menu.mjs';
import {AudioTimeline} from './audio-timeline.mjs';
import {createLayersPopover} from './timeline-layers-popover.mjs';
import {TimelineLayerView} from './timeline-layer-view.mjs';

import {LAYER_COLORS} from './layers.mjs';
import {bandBottom} from './shell/topbar.mjs';

/** The zoom range (the strip's slider and Ctrl+wheel), and the widest a card grows by itself from the body's height. */
const MIN_CARD = 72, MAX_CARD = 240, AUTO_MAX = 168;
/** A narrow strip (a phone) keeps at least this many cards in view as they grow with the body's height. */
const AUTO_RUN = 3.4;
/** Around a card's thumbnail (5:3, today's framing): the side gutters, then the number line, the duration bar and padding. */
const CARD_GUTTER = 12, CARD_CHROME = 58;
/** The touch interface's compact card (docs/TOUCH.md): the number sits on the thumbnail, a slim bar under it. */
const TOUCH_CARD_CHROME = 26;
/** How far a card's duration bar starts from its edge (components/filmstrip.css: the card's and the bar's insets). */
const BAR_INSET = 10;
const el = (tag, parent, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  parent?.append(node);
  return node;
};

/** Whole-scene filmstrip over the same layer poses used by the canvas. */
export class SheetFilmstrip {
  constructor(container, editor, options = {}) {
    this.editor = editor;
    this.container = container;
    Object.assign(this, options);
    this.ownsLayerView=!options.layerView;this.layerView??=new TimelineLayerView(editor);
    attachTimelineHotkeys(this);
    this.events = new AbortController();
    this.cardWidth=112;
    // Cards follow the panel height (larger thumbnails) until the user zooms.
    this.autoCardWidth=true;
    this.cards = new Map();
    this.previews = new Map();
    this.bitmapCache=new Map();this.thumbnailStats={renders:0,soft:0,hits:0,retries:0,invalidations:0};this.layerAppearance=layerAppearance(editor.report._styk?.layers);
    this.queue = [];
    this.generation = 0;
    this.times = sheetKeyTimes(editor.report);
    this.selected = new Set([this.selectedIndex]);
    this.anchor = this.selectedIndex;
    this.revealPending = true;
    this.root = el('div', container, 'sheet-filmstrip');
    this.buildFrameBar();
    // The touch interface: compact cards, and the frame bar in the timeline header's action row (as the Advanced
    // timeline's actions), so the cards take the body's whole height on a phone on its side.
    this.touchMode = Boolean(this.touch?.active);
    this.root.toggleAttribute('data-touch', this.touchMode);
    this.strip = el('div', this.root, 'sheet-filmstrip-scroll');
    this.strip.tabIndex = 0;
    this.strip.setAttribute('role', 'listbox');
    localizedAttribute(this.strip, 'aria-label', "sheetFilmstrip.animationFrames", {});
    this.strip.setAttribute('aria-multiselectable', 'true');
    this.spacer = el('div', this.strip, 'sheet-filmstrip-spacer');
    // During playback the strip stays still: no card renders and no layout reads, only this line moves (by its
    // transform) to where playback is; the cards catch up when playback stops (setPlaying).
    this.playhead = el('div', this.spacer, 'sheet-playhead sheet-filmstrip-playhead');
    this.playhead.style.visibility = 'hidden';
    this._on(this.strip, 'scroll', () => this._schedule());
    this._on(this.strip, 'wheel', event => {
      if (event.ctrlKey || event.metaKey) {event.preventDefault();this.setZoom(this.cardWidth*(event.deltaY<0?1.12:.89),event.clientX-this.strip.getBoundingClientRect().left,true);return;}
      event.preventDefault();
      this.strip.scrollLeft += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    }, {passive: false});
    this._on(this.strip, 'keydown', event => this.keydown(event));
    this._on(this.duration, 'keydown', event => event.stopPropagation());
    this._on(this.duration, 'change', () => this._run(() => this.setDuration(this.selectedFrameIndices, Number(this.duration.value))));
    this._on(editor, 'change', event => {
      const detail = event.detail ?? {};
      if (detail.kind === 'seek' && this.playing) { this._syncPlayhead(); return; }
      const appearance=detail.layers||detail.kind==='document'?layerAppearance(editor.report._styk?.layers):this.layerAppearance;
      let visual=thumbnailVisualChange(detail,this.layerAppearance,appearance);this.layerAppearance=appearance;
      if(detail.kind==='frame-draft'){const draft=editor.report._styk?.simpleFrameDraft,previous=this.draftSnapshot;this.draftSnapshot=draft;if(!(previous?.mode==='add'&&previous.baseline||draft?.mode==='add'&&draft.baseline)&&Boolean(previous?.empty)===Boolean(draft?.empty))visual=false;}
      if(visual){this.generation++;this.thumbnailStats.invalidations++;this.previews.clear();this.clearThumbnailCache();this.queue=[];this.inflight?.abort();}
      if (detail.kind === 'document' || detail.structural || detail.timing || detail.kind === 'history' && !detail.audio) {
        this.times = sheetKeyTimes(editor.report);
        this.selected = new Set([...this.selected].filter(index => index < this.times.length));
        if (!this.selected.size || detail.kind === 'document') this.selected = new Set([this.selectedIndex]);
        if (detail.kind === 'document') this.revealPending = true;
      }
      if (detail.kind === 'seek' && !this.selecting) {
        this.selected = new Set([this.selectedIndex]);
        this.anchor = this.selectedIndex;
        this.revealPending = true;
      }
      this.update();
    });
    this.observer = new ResizeObserver(() => {this.placeFrameBar();this.fitCardsToHeight();const x=this.selectedIndex*this.cardWidth,left=this.strip.scrollLeft;if(this.lastViewportWidth&&x+this.cardWidth>left&&x<left+this.lastViewportWidth)this.revealPending=true;this.lastViewportWidth=this.strip.clientWidth;this.update();});
    this.observer.observe(this.root);
    this.placeFrameBar();
    this.render();
    // Add frame, the zoom slider and Fit are the shared header's (timeline-header.mjs).
    mountTimelineNavigation(this);this.header?.setZoom(this.cardWidth);
    this.audio = new AudioTimeline(container, editor, {...options, host:this, engine:options.audioEngine, mode:'simple'});
  }
  _on(target, name, fn, options = {}) { target.addEventListener(name, fn, {signal: this.events.signal, ...options}); }
  _run(operation) {
    try { this.onSeek?.(); const wait=this.beforeCommand?.(),result=wait?wait.then(operation):operation(); this.update();
      if (result?.then) return result.catch(error => { this.onError?.(error); return false; }).finally(() => this.update());
      return result; }
    catch (error) { this.onError?.(error); this.update(); return false; }
  }
  /** A kit button in the frame bar: a glyph (icon button) or words (a ghost button); the name is `name`. */
  button(parent, name, action, {glyph, text, command} = {}) {
    const button = el('button', parent, text ? 'ui-button' : 'ui-icon-button');
    button.type = 'button';
    button.dataset.size = 'sm';
    if (text) { button.dataset.variant = 'ghost'; localizedMarkup(button, `${glyph ? icon(glyph) : ''}<span class="ui-label"></span>`); button.lastChild.textContent = text; }
    else localizedMarkup(button, icon(glyph));
    button.setAttribute('aria-label', name);
    if (command) button.dataset.hotkeyCommand = command;
    else button.dataset.tooltip = name;
    this._on(button, 'click', () => this._run(action));
    return button;
  }
  /**
   * The Simple frame bar (experience.md §5.6), in the label column's place: "Frame 6 of 8 · holds 0.25 s" and the
   * whole length in time; Inbetweens (a stepper for every selected card) and Easing (today's six modes); Copy,
   * Paste and Delete frames; Edit together (the header's toggle-range-edit, one state); and the layer Simple edits,
   * whose button opens the Layers popover.
   */
  buildFrameBar() {
    const say = (key, params) => this.say(key, params);
    const bar = this.controls = el('div', this.root, 'sheet-filmstrip-controls sheet-framebar');
    bar.setAttribute('role', 'group');
    localizedAttribute(bar, 'aria-label', "filmstrip.frameBar", {});
    this.counter = el('div', bar, 'sheet-filmstrip-counter sheet-framebar-title');
    this.counterFrame = el('strong', this.counter);
    this.counterHold = el('span', this.counter, 'sheet-framebar-meta');
    this.counterPlayback = el('span', this.counter, 'sheet-filmstrip-playback sheet-framebar-meta sheet-framebar-total');
    const grid = el('div', bar, 'sheet-framebar-grid');
    // Inbetweens: − steps every selected card down, + up; typing sets them all (Enter or leaving the field).
    const row = el('div', grid, 'ui-row sheet-framebar-row');
    translatedElement(el('span', row, 'ui-row-label', say("filmstrip.inbetweens")), "filmstrip.inbetweens", {}).setAttribute('aria-hidden', 'true');
    const stepper = el('div', row, 'ui-stepper sheet-framebar-stepper');
    stepper.setAttribute('role', 'group');
    this.fewerButton = this.button(stepper, say("filmstrip.fewer"), () => this.stepDuration(-1), {glyph: 'minus'});
    this.duration = el('input', stepper, 'ui-stepper-input');
    Object.assign(this.duration, {type: 'number', min: '0', max: '65534', step: '1'});
    localizedAttribute(this.duration, 'aria-label', "filmstrip.inbetweensName", {});
    this.moreButton = this.button(stepper, say("filmstrip.more"), () => this.stepDuration(1), {glyph: 'plus'});
    // Easing: the current easing of the selected cards (Mixed when they differ); choosing one applies it.
    const easing = el('label', grid, 'ui-field sheet-framebar-easing');
    easing.dataset.select = '';
    easing.dataset.size = 'sm';
    translatedElement(el('span', easing, 'ui-field-label', say("filmstrip.easing")), "filmstrip.easing", {});
    this.easingSelect = el('select', easing, 'ui-field-input sheet-easing-select');
    localizedAttribute(this.easingSelect, 'aria-label', "filmstrip.easingName", {});
    this.mixedOption = translatedElement(el('option', this.easingSelect, '', say("filmstrip.mixed")), "filmstrip.mixed", {});
    this.mixedOption.value = '';
    this.mixedOption.disabled = true;
    for (const mode of EASING_MODES) translatedElement(el('option', this.easingSelect), mode.labelKey).value = mode.id;
    easing.insertAdjacentHTML('beforeend', icon('chevron-down', 'ui-field-chev'));
    this._on(this.easingSelect, 'keydown', event => event.stopPropagation());
    this._on(this.easingSelect, 'change', () => {
      const mode = this.easingSelect.value;
      if (mode) this._run(() => this.applyEasing(this.selectedFrameIndices, mode === 'bezier' ? {interpolation: mode, bezier: [...DEFAULT_BEZIER]} : {interpolation: mode}));
    });
    // The frame clipboard and Delete: the words say what they do; the names say which frames.
    const actions = el('div', grid, 'sheet-filmstrip-actions sheet-framebar-actions');
    actions.setAttribute('role', 'group');
    localizedAttribute(actions, 'aria-label', "filmstrip.frameBar", {});
    this.copyButton = this.button(actions, say("filmstrip.copyName"), () => this.copySelection(), {text: say("filmstrip.copy"), textKey: "filmstrip.copy", textParams: {}, command: 'copy'});
    this.pasteButton = this.button(actions, say("filmstrip.pasteName"), () => this.pasteSelection(), {text: say("filmstrip.paste"), textKey: "filmstrip.paste", textParams: {}, command: 'paste'});
    this.deleteButton = this.button(actions, say("filmstrip.deleteName"), () => this.action('delete'), {glyph: 'trash', command: 'delete'});
    // Edit together: the header's toggle-range-edit (timeline-host.mjs writes its state through setEditTogether).
    const together = this.togetherField = el('label', grid, 'ui-field sheet-framebar-together');
    together.dataset.switchField = '';
    together.dataset.size = 'sm';
    translatedElement(el('span', together, 'ui-field-label', say("filmstrip.together")), "filmstrip.together", {});
    this.togetherSwitch = el('input', together, 'ui-switch');
    Object.assign(this.togetherSwitch, {type: 'checkbox', disabled: true});
    this.togetherSwitch.setAttribute('role', 'switch');
    this.togetherSwitch.dataset.command = 'toggle-range-edit';
    localizedAttribute(together, 'data-tooltip', "filmstrip.togetherReason", {});
    this._on(this.togetherSwitch, 'change', () => {
      this.togetherSwitch.checked = !this.togetherSwitch.checked;
      try { this.onToggleRangeEdit?.(); } catch (error) { this.onError?.(error); }
    });
    // The layer Simple edits: its dot and name; the button opens the Layers popover.
    const layer = this.layerButton = el('button', bar, 'ui-button sheet-framebar-layer');
    layer.type = 'button';
    layer.id = 'layers-button';
    layer.dataset.size = 'sm';
    layer.dataset.variant = 'ghost';
    layer.setAttribute('aria-haspopup', 'dialog');
    layer.setAttribute('aria-expanded', 'false');
    localizedAttribute(layer, 'data-tooltip', "filmstrip.layerTip", {});
    localizedMarkup(layer, `${icon('layers')}<span class="ui-label"></span><span class="ui-dot" aria-hidden="true"></span><span class="sheet-framebar-layer-name"></span>${icon('chevron-down', 'sheet-framebar-chev')}`);
    localizedText(layer.querySelector('.ui-label'), "filmstrip.layer", {});
    this.layerDot = layer.querySelector('.ui-dot');
    this.layerName = layer.querySelector('.sheet-framebar-layer-name');
    this._on(layer, 'click', () => {
      this.layersPopover ??= createLayersPopover({anchor: layer, editor: this.editor, view: this.layerView, overlays: this.overlays ?? null, t: this.localizationText ?? null,
        run: fn => this._run(fn), topInset: () => bandBottom(document) + 6});
      this.layersPopover.toggle();
    });
  }
  say(key, params) { return sayTimeline(this.localizationText ?? null, key, params); }
  /** Edit together's state from the header's (timeline-host.mjs): available while two or more cards are selected. */
  setEditTogether({ready = false, on = false} = {}) {
    if (this.togetherSwitch.disabled === ready) this.togetherSwitch.disabled = !ready;
    if (this.togetherSwitch.checked !== (ready && on)) this.togetherSwitch.checked = ready && on;
    const tip = this.say(ready ? 'filmstrip.togetherTip' : 'filmstrip.togetherReason');
    if (this.togetherField.dataset.tooltip !== tip) this.togetherField.dataset.tooltip = tip;
  }
  get ids() { return ['scene', 'camera', ...this.editor.report._styk.layers.order]; }
  get locked() { return this.ids.some(id => this.editor.getLayer(id)?.locked); }
  get selectedIndex() { return Math.max(0, this.times.findLastIndex(tick => tick <= this.editor.tick)); }
  get selectedFrameIndices() { return [...this.selected].sort((a, b) => a - b); }
  get selectedTicks() { return this.selectedFrameIndices.map(i => this.times[i]).filter(Number.isFinite); }
  get selectedTimeRange() {
    const times = this.selectedTicks, index = this.times.indexOf(times.at(-1));
    return {start: times[0] ?? this.editor.tick, end: this.times[index + 1] ?? this.editor.totalTicks};
  }
  get frameCount() { return this.times.length; }
  get stats() { return {rows: this.cards.size, cachedPreviews: this.previews.size, queuedPreviews: this.queue.length, bitmapEntries:this.bitmapCache.size, bitmapBytes:this.bitmapCache.size*320*192*4,...this.thumbnailStats}; }
  ranges(indices = this.selectedFrameIndices) {
    return indices.filter(i => Number.isInteger(i) && i >= 0 && i < this.times.length)
      .map(i => ({index: i, start: this.times[i], end: this.times[i + 1] ?? this.editor.totalTicks}));
  }
  selectFrame(index, {extend = false} = {}) {
    const wait=this.beforeCommand?.();if(wait)return wait.then(()=>this.selectFrame(index,{extend})).catch(error=>this.onError?.(error));
    index = Math.max(0, Math.min(this.times.length - 1, index));
    if (extend) this.selected = new Set(Array.from({length: Math.abs(index - this.anchor) + 1}, (_, i) => Math.min(index, this.anchor) + i));
    else { this.selected = new Set([index]); this.anchor = index; }
    this.onSeek?.();
    // Frame navigation never changes which figures are selected.
    this.editor.keepSelectionOnSeek?.();
    this.selecting = true;
    try { this.editor.seek(this.times[index]); } finally { this.selecting = false; }
    this.ensureVisible(index);
    this.onRangeChange?.(this.selectedFrameIndices);
    this.update();
  }
  ensureVisible(index) {
    if (!this.strip.clientWidth) { this.revealPending = true; return; }
    const x = index * this.cardWidth;
    if (x < this.strip.scrollLeft) this.strip.scrollLeft = x;
    else if (x + this.cardWidth > this.strip.scrollLeft + this.strip.clientWidth) this.strip.scrollLeft = x + this.cardWidth - this.strip.clientWidth;
  }
  /** Sets the inbetweens of the frames at `indices`: a number for all of them, or a function of each frame's current count. */
  setDuration(indices, inbetweens) {
    const valid = value => Number.isInteger(value) && value >= 0 && value <= 65534;
    if (typeof inbetweens !== 'function' && !valid(inbetweens)) throw messageError(new Error(''), "errors.sheetFilmstrip.inbetweensMustBe065534", {});
    const ranges = this.ranges(indices).sort((a, b) => b.start - a.start);
    const active = this.selectedIndex, offset = this.editor.tick - this.times[active];
    const result = this.editor.movieclipBatch(interfaceText("sheetFilmstrip.setFrameInbetweens"), () => {
      for (const {start, end} of ranges) {
        const count = typeof inbetweens === 'function' ? Math.max(0, Math.min(65534, inbetweens(end - start - 1))) : inbetweens;
        const delta = count + 1 - (end - start);
        if (delta > 0) this.editor.sheetInsertFrames(this.ids, end, delta);
        else if (delta < 0) this.editor.sheetRemoveFrames(this.ids, start + count + 1, end - 1);
      }
    });
    const start = this.times[active], end = this.times[active + 1] ?? this.editor.totalTicks;
    this.selecting = true;
    try { this.editor.seek(start + Math.min(offset, end - start - 1)); }
    finally { this.selecting = false; }
    this.onRangeChange?.(this.selectedFrameIndices);
    return result;
  }
  /** The frame bar's − and +: one inbetween fewer or more on every selected card, as one step to undo. */
  stepDuration(delta) {
    const indices = this.selectedFrameIndices;
    if (delta < 0 && this.ranges(indices).every(({start, end}) => end - start - 1 <= 0)) return false;
    return this.setDuration(indices, count => count + delta);
  }
  /** The longest hold on the strip, at least 8 inbetweens: the bars share this scale, the longest one full. */
  _holdScale() {
    const total = this.editor.totalTicks;
    if (this._scale?.times !== this.times || this._scale.total !== total) {
      let most = 8;
      for (let i = 0; i < this.times.length; i++) most = Math.max(most, (this.times[i + 1] ?? total) - this.times[i] - 1);
      this._scale = {times: this.times, total, most};
    }
    return this._scale.most;
  }
  /** Drags a card's bar end: whole inbetweens per step of the shared scale, one undoable change at release; Escape cancels. */
  _holdDown(event, card, index) {
    const slider = card._slider, hold = card._hold;
    if (event.button !== 0 || slider.disabled) return;
    event.preventDefault();
    const start = Number(slider.value), x = event.clientX, unit = Math.max(2, hold.clientWidth / (this._holdScale() + 1));
    let value = start, done = false;
    const events = new AbortController(), signal = events.signal;
    const finish = commit => {
      if (done) return;
      done = true; events.abort();
      card.removeAttribute('data-dragging');
      if (hold.hasPointerCapture?.(event.pointerId)) hold.releasePointerCapture(event.pointerId);
      if (commit && value !== start) this._run(() => this.setDuration([index], value));
      else { slider.value = String(start); this._showHold(card, index, start); }
    };
    hold.setPointerCapture?.(event.pointerId);
    card.setAttribute('data-dragging', '');
    hold.addEventListener('pointermove', move => {
      const next = Math.max(0, Math.min(65534, start + Math.round((move.clientX - x) / unit)));
      if (next === value) return;
      value = next;
      if (Number(slider.max) < value) slider.max = String(value);
      slider.value = String(value);
      this._showHold(card, index, value);
    }, {signal});
    hold.addEventListener('pointerup', () => finish(true), {signal});
    hold.addEventListener('pointercancel', () => finish(false), {signal});
    hold.addEventListener('lostpointercapture', () => finish(true), {signal});
    window.addEventListener('keydown', key => { if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); finish(false); } }, {signal, capture: true});
    card._events.signal.addEventListener('abort', () => finish(false), {signal});
  }
  /** A card's count in words, its bar's length and its slider's value text (live while the bar is dragged). */
  _showHold(card, index, amount) {
    const words = amount === 1 ? this.say('filmstrip.countOne') : this.say('filmstrip.count', {count: amount});
    if (card._words !== words) {
      card._words = words;
      card._count.textContent = ` · ${words}`;
      card._slider.setAttribute('aria-valuetext', words);
      card._button.dataset.tooltip = this.say('filmstrip.cardTip', {frame: index + 1, count: words});
      card._hold.dataset.tooltip = this.say('filmstrip.holdTip', {frame: index + 1, count: words});
    }
    const width = `${Math.min(100, Math.round((amount + 1) / (this._holdScale() + 1) * 1000) / 10)}%`;
    if (card._hold.style.getPropertyValue('--hold-w') !== width) card._hold.style.setProperty('--hold-w', width);
  }
  /** The frame bar: where you are and how long it holds, the selected cards' inbetweens and easing, and the layer. */
  _renderFrameBar(active, locked) {
    const say = (key, params) => this.say(key, params);
    const total = this.editor.totalTicks, fps = this.editor.report.frame_delay_ms ? 1000 / this.editor.report.frame_delay_ms : this.editor.report.fps || 24;
    const seconds = ticks => { const value = ticks / fps; return value >= 1 ? value.toFixed(1) : value.toFixed(2); };
    const hold = (this.times[active + 1] ?? total) - (this.times[active] ?? 0);
    const texts = [
      messageTuple([this.counterFrame, say("filmstrip.frameOf", {frame: active + 1, total: this.times.length})], {1: {key: "filmstrip.frameOf", params: {frame: active + 1, total: this.times.length}}}),
      messageTuple([this.counterHold, say("filmstrip.holds", {seconds: seconds(hold)})], {1: {key: "filmstrip.holds", params: {seconds: seconds(hold)}}}),
      messageTuple([this.counterPlayback, say("filmstrip.total", {seconds: seconds(total)})], {1: {key: "filmstrip.total", params: {seconds: seconds(total)}}}),
    ];
    for (const [node, text] of texts) if (node.textContent !== text) node.textContent = text;
    const totalTip = say("filmstrip.totalTip", {seconds: seconds(total), ticks: total, fps: Number(fps.toFixed(2))});
    if (this.counter.dataset.tooltip !== totalTip) this.counter.dataset.tooltip = totalTip;
    // Inbetweens: one number for every selected card, empty ("Mixed") when they differ.
    const amounts = this.ranges().map(({start, end}) => end - start - 1);
    if (document.activeElement !== this.duration) this.duration.value = amounts.every(n => n === amounts[0]) ? String(amounts[0] ?? 0) : '';
    localizedAttribute(this.duration, "placeholder", "filmstrip.mixed", {});
    this.duration.disabled = this.moreButton.disabled = this.deleteButton.disabled = this.copyButton.disabled = locked;
    this.fewerButton.disabled = locked || amounts.every(n => n <= 0);
    this.header?.setAddFrame({disabled: locked});
    this.pasteButton.disabled = locked || (!this.sharedClipboard && !this.editor._sheetClipboard);
    // Easing: today's six modes; a legacy Hold key reads as Constant.
    const easing = this.easingSettings(), same = easing.every(value => JSON.stringify(value) === JSON.stringify(easing[0]));
    const mode = same ? (easing[0]?.interpolation === 'hold' ? 'constant' : easing[0]?.interpolation ?? 'constant') : '';
    this.mixedOption.hidden = Boolean(mode);
    if (document.activeElement !== this.easingSelect && this.easingSelect.value !== mode) this.easingSelect.value = mode;
    this.easingSelect.disabled = locked;
    // The layer Simple edits.
    const layer = this.editor.getLayer(this.editor.activeLayerId);
    if (layer && this.layerName.textContent !== layer.name) this.layerName.textContent = layer.name;
    const color = LAYER_COLORS[layer?.color] ?? 'var(--sheet-layer)';
    if (this.layerDot.style.getPropertyValue('--dot') !== color) this.layerDot.style.setProperty('--dot', color);
  }
  easingSettings(indices = this.selectedFrameIndices) {
    return this.ranges(indices).flatMap(({start}) => this.ids.flatMap(id => {
      const key = sheetKeyAt(this.editor.report._styk.layerSheet.tracks[id], start).key;
      return key && !key.empty && key.value?.frameId !== null ? [keyEasing(key)] : [];
    }));
  }
  applyEasing(indices, easing) {
    const ranges = this.ranges(indices);
    return this.editor.movieclipBatch(interfaceText("sheetFilmstrip.setSceneFrameEasing"), () => {
      for (const {start, end} of ranges) {
        // A filmstrip cell can begin inside another layer's exposure. Establish
        // its boundaries before changing easing so adjacent scene frames retain theirs.
        for (const tick of [start, end]) if (tick < this.editor.totalTicks) {
          const missing = this.ids.filter(id => !this.editor.layerFrameKeys(id).some(key => key.tick === tick));
          if (missing.length) this.editor.sheetInsertKey(missing, tick);
        }
        this.editor.sheetSetEasing(this.ids, start, end - 1, easing);
      }
    });
  }
  showEasingPopover() { if (!this.locked) return showKeyframeEasingPopover.call(this); }
  render() {
    this.onionRange?.update();
    if (this.disposed) return;
    const width = `${this.times.length * this.cardWidth}px`;
    if (this.spacer.style.width !== width) this.spacer.style.width = width;
    if (!this.strip.clientWidth) return;
    // A hidden mount cannot scroll yet. Reveal once layout exists, then leave
    // deliberate scrolling alone until the playhead is explicitly moved.
    if (this.revealPending && this.strip.clientWidth) {
      this.revealPending = false;
      this.ensureVisible(this.selectedIndex);
    }
    // Audio retains this time mapping and scroll range, but needs no thumbnails.
    if (this.audio?.open) return;
    const first = Math.max(0, Math.floor(this.strip.scrollLeft / this.cardWidth) - 1);
    const last = Math.min(this.times.length, first + Math.ceil(this.strip.clientWidth / this.cardWidth) + 3);
    const active = this.selectedIndex, locked = this.locked;
    const say = (key, params) => this.say(key, params);
    this._renderFrameBar(active, locked);
    for (const [index, card] of this.cards) if (index < first || index >= last) {
      card._events.abort(); card.remove(); this.cards.delete(index); this.previews.delete(index);
    }
    this.queue = this.queue.filter(item => this.cards.get(item.index) === item.card && item.generation === this.generation);
    const edited = Boolean(this.editor.frameDraft?.dirty);
    for (let index = first; index < last; index++) {
      let card = this.cards.get(index);
      if (!card) {
        // A card: the thumbnail (the option), the number with its count in words, and one duration bar that is the
        // "Frame N inbetweens" slider (drag its end to hold the frame longer or shorter).
        card = el('div', this.spacer, 'sheet-filmstrip-card ui-frame-card');
        card._events = new AbortController();
        const listen = (target, name, fn) => this._on(target, name, fn, {signal: card._events.signal});
        card.dataset.frame = index;
        card.style.left = `${index * this.cardWidth}px`;
        const preview = el('button', card, 'sheet-preview ui-frame-thumb');
        preview.type = 'button';
        preview.tabIndex = -1;
        preview.setAttribute('role', 'option');
        localizedAttribute(preview, 'aria-label', 'filmstrip.card', {frame: index + 1});
        const canvas = el('canvas', preview);
        canvas.width = 320; canvas.height = 192;
        const number = el('span', card, 'sheet-frame-number ui-frame-num', String(index + 1));
        const count = el('span', number, 'ui-frame-count');
        // The bar's range input carries the value for the keyboard and assistive technology; a pointer drags the
        // bar's end by whole inbetweens instead (_holdDown), so a click on the bar never jumps its value.
        const hold = el('div', card, 'sheet-inbetweens ui-frame-hold');
        const slider = el('input', hold, 'ui-frame-hold-input');
        Object.assign(slider, {type: 'range', min: '0', step: '1', tabIndex: -1});
        localizedAttribute(slider, 'aria-label', 'filmstrip.holdName', {frame: index + 1});
        listen(slider, 'input', () => this._showHold(card, index, Number(slider.value)));
        listen(slider, 'change', () => this._run(() => this.setDuration([index], Number(slider.value))));
        listen(hold, 'pointerdown', event => this._holdDown(event, card, index));
        listen(preview, 'click', event => this.selectFrame(index, {extend: event.shiftKey}));
        listen(preview, 'dblclick', () => this._run(() => this.showEasingPopover()));
        listen(card, 'contextmenu', event => { event.preventDefault(); if (!this.selected.has(index)) this.selectFrame(index); this._menu(event); });
        Object.assign(card, {_button: preview, _canvas: canvas, _slider: slider, _count: count, _hold: hold, _number: number});
        this.cards.set(index, card);
      }
      const current = active === index, selected = this.selected.has(index);
      card.dataset.current = String(current);
      card.dataset.selected = String(selected);
      card._button.setAttribute('aria-selected', String(selected));
      if (current) card._button.setAttribute('aria-current', 'true'); else card._button.removeAttribute('aria-current');
      // The working copy (docs/SIMPLE-FRAME-DRAFTS.md): an edited dot on the current card's number.
      const dot = current && edited;
      if (card._number.hasAttribute('data-edited') !== dot) {
        card._number.toggleAttribute('data-edited', dot);
        if (dot) localizedAttribute(card._number, 'data-tooltip', "filmstrip.edited", {}); else delete card._number.dataset.tooltip;
      }
      const amount = (this.times[index + 1] ?? this.editor.totalTicks) - this.times[index] - 1;
      if (document.activeElement !== card._slider) {
        card._slider.max = String(Math.max(20, amount));
        card._slider.value = String(amount);
        this._showHold(card, index, amount);
      }
      card._slider.disabled = locked;
      if(this.previews.get(index)!==this.generation){
        const cached=this.bitmapCache.get(index);
        if(cached){card._canvas.getContext('2d').drawImage(cached,0,0);this.bitmapCache.delete(index);this.bitmapCache.set(index,cached);this.previews.set(index,this.generation);this.thumbnailStats.hits++;}
        else if(this.activeThumbnail!==index&&!this.queue.some(item=>item.index===index))this.queue.push({index,card,generation:this.generation});
      }
    }
    this._drain();
  }
  async _drain() {
    if (this.busy || this.paused || this.disposed || this.audio?.open || !this.strip.clientWidth) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.paused && !this.disposed && !this.audio?.open && this.strip.clientWidth) {
        const item = this.queue.shift();
        if (item.generation !== this.generation || !item.card.isConnected) continue;
        const tick = this.times[item.index], rows = this.editor.timeline, index = Math.max(0, rows.findLastIndex(row => row.start <= tick));
        this.activeThumbnail=item.index;const abort=this.inflight=new AbortController();
        const scratch=document.createElement('canvas');scratch.width=item.card._canvas.width;scratch.height=item.card._canvas.height;
        try {
          const done=await this.renderThumbnail?.(index,scratch,{tick,storedFrames:false,signal:abort.signal});
          if(done!==false&&!abort.signal.aborted&&item.generation===this.generation&&!this.disposed){
            // A thumbnail drawn from soft copies of pictures not in yet shows meanwhile, is neither cached nor counted as done, and is drawn again.
            const soft=done==='soft';
            if(!soft){this.bitmapCache.set(item.index,scratch);while(this.bitmapCache.size>32){const key=this.bitmapCache.keys().next().value,old=this.bitmapCache.get(key);this.bitmapCache.delete(key);old.width=old.height=0;}}
            if(this.cards.get(item.index)===item.card){item.card._canvas.getContext('2d').drawImage(scratch,0,0);if(!soft)this.previews.set(item.index,this.generation);}
            if(soft){this.thumbnailStats.soft++;this.retryDelay=Math.min(this.retryDelay??120,250);this._retryThumbnails();}else{this.thumbnailStats.renders++;this.retryDelay=120;}
          }else if(!this.paused&&!this.disposed){this.thumbnailStats.retries++;this._retryThumbnails();}
        }catch(error){if(error.name!=='AbortError')this.onError?.(error);this._retryThumbnails();}
        finally{this.activeThumbnail=null;if(this.inflight===abort)this.inflight=null;}
        // Worker replies yield to the browser; avoid an extra timer per frame.
      }
    } finally { this.busy = false; }
  }
  clearThumbnailCache(){for(const canvas of this.bitmapCache.values())canvas.width=canvas.height=0;this.bitmapCache.clear();}
  _retryThumbnails(){if(this.retryTimer||this.disposed)return;this.retryTimer=setTimeout(()=>{this.retryTimer=null;if(!this.paused)this.update();},this.retryDelay??120);this.retryDelay=Math.min(2000,(this.retryDelay??120)*2);}
  copySelection() { const {start, end} = this.selectedTimeRange, ids = this.ids; return this._clipboard('copy', () => this.editor.sheetCopyFrames(ids, start, end - 1)); }
  cutSelection() { return this._clipboard('copy', () => { this.editor.sheetCopyFrames(this.ids, this.selectedTimeRange.start, this.selectedTimeRange.end - 1); this.action('delete'); return this.editor._sheetClipboard; }); }
  pasteSelection(atEnd = false) { const tick = atEnd ? this.editor.totalTicks : this.times[this.selectedIndex], ids = this.ids; return this._clipboard('paste', () => pasteSheetClipboard(this.editor, ids, tick, {insert: true, wholeScene: true})); }
  _clipboard(action, operation) { return this._run(() => this.sharedClipboard ? this.sharedClipboard[action]('sheet', operation) : operation()); }
  selectAll() { this.selected = new Set(this.times.map((_, i) => i)); this.onRangeChange?.(this.selectedFrameIndices); this.update(); }
  action(command) {
    return this._run(() => {
      if (['add', 'add-frame', 'duplicate'].includes(command)) return this.onAddFrame ? this.onAddFrame() : this.editor.sheetDuplicateFrameAfter(this.ids);
      if (command === 'duplicate-after') return this.editor.sheetDuplicateFrameAfter(this.ids);
      if (command === 'copy') return this.copySelection();
      if (command === 'paste' || command === 'paste-end') return this.pasteSelection(command === 'paste-end');
      if (command === 'delete') {
        const ranges = this.ranges().sort((a, b) => b.start - a.start);
        return this.editor.movieclipBatch(interfaceText("sheetFilmstrip.removeSceneFrames"), () => {
          for (const {start, end} of ranges) this.editor.sheetRemoveFrames(this.ids, start, end - 1);
        });
      }
      if (command === 'insert') {
        const clipboard = this.editor._sheetClipboard, start = this.times[this.selectedIndex];
        try { this.editor.sheetCopyFrames(this.ids, start, start); return this.editor.sheetPasteFrames(this.ids, start, {insert: true}); }
        finally { this.editor._sheetClipboard = clipboard; }
      }
    });
  }
  extendKeyframe() {
    const ranges = this.ranges().sort((a, b) => b.start - a.start);
    return this._run(() => this.editor.movieclipBatch(interfaceText("sheetFilmstrip.extendKeyframe"), () => {
      for (const {end} of ranges) this.editor.sheetInsertFrames(this.ids, end, 1);
    }));
  }
  keydown(event) {
    if (event.target.matches('input,select,textarea')) { event.stopPropagation(); return; }
    if (this.ownsHotkeys && this.hotkeys.keydown(event, ['simple'])) event.stopPropagation();
  }
  _menu(event) {
    const locked = this.locked, canPaste = !locked && (this.sharedClipboard || this.editor._sheetClipboard);
    // Add frame's home is the header (the same place in both modes), so the card menu keeps to the selected frames.
    showTimelineMenu(this, event, [
      [!locked && {label: interfaceText("sheetFilmstrip.changeEasing"), labelKey: "sheetFilmstrip.changeEasing", symbol: 'sliders', action: () => this.showEasingPopover()}],
      [!locked && {label: interfaceText("sheetFilmstrip.copyFrames"), labelKey: "sheetFilmstrip.copyFrames", shortcut: this.shortcut('copy'), symbol: 'duplicate', action: () => this.copySelection()},
       !locked && {label: interfaceText("sheetFilmstrip.cutFrames"), labelKey: "sheetFilmstrip.cutFrames", shortcut: this.shortcut('cut'), symbol: 'cut', action: () => this.cutSelection()},
       canPaste && {label: interfaceText("sheetFilmstrip.pasteFrames"), labelKey: "sheetFilmstrip.pasteFrames", shortcut: this.shortcut('paste'), symbol: 'clipboard', action: () => this.pasteSelection()}],
      [!locked && {label: interfaceText("sheetFilmstrip.deleteFrames"), labelKey: "sheetFilmstrip.deleteFrames", shortcut: this.shortcut('delete'), symbol: 'trash', danger: true, action: () => this.action('delete')},
       locked && {label: interfaceText("sheetFilmstrip.unlockLayers"), labelKey: "sheetFilmstrip.unlockLayers", symbol: 'unlock', action: () => { for (const id of this.ids) this.editor.setLayerLocked(id, false); }}],
    ]);
  }
  setPaused(value) { this.paused = value; if (!value) this._drain(); }
  /** Renders the visible cards on the next frame, except while playing (setPlaying renders at the stop). */
  update() { if (!this.playing) this._schedule(); }
  /** The next frame's render, even while playing: a deliberate scroll or zoom shows the cards it brings in. */
  _schedule() { if (this.disposed || this.raf) return; this.raf = requestAnimationFrame(() => { this.raf = null; this.render(); }); }
  /** Playback starts or stops (timeline-host.mjs): while it plays the playhead line moves and nothing else; at the stop the
   * current card is selected and revealed, as a seek does. */
  setPlaying(playing) {
    playing = Boolean(playing);
    if (playing === Boolean(this.playing)) return;
    this.playing = playing;
    if (playing) {
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
      this._syncPlayhead();
      this.playhead.style.visibility = '';
      return;
    }
    this.playhead.style.visibility = 'hidden';
    this.selected = new Set([this.selectedIndex]);
    this.anchor = this.selectedIndex;
    this.revealPending = true;
    this.update();
  }
  /** The playhead line at the current tick: along the duration bar of the card it falls in, as far as playback is
   * through that card's hold (cached times and card width only; the bar is BAR_INSET in from each side of the card). */
  _syncPlayhead() {
    const times = this.times, tick = this.editor.tick;
    let low = 0, high = times.length - 1;
    while (low < high) { const middle = (low + high + 1) >> 1; if (times[middle] <= tick) low = middle; else high = middle - 1; }
    const start = times[low] ?? 0, end = times[low + 1] ?? this.editor.totalTicks;
    const x = low * this.cardWidth + BAR_INSET + (tick - start + 0.5) / Math.max(1, end - start) * Math.max(0, this.cardWidth - 2 * BAR_INSET);
    const transform = `translateX(${Math.round(x * 10) / 10}px)`;
    if (this.playhead.style.transform !== transform) this.playhead.style.transform = transform;
  }
  resize() { this.update(); }
  /** The header's Add frame (the sidebar's button before the header was shared). */
  addFrameFromHeader() { return this._run(() => this.action('add')); }
  /** Fit every frame: the cards shrink to show the whole animation. */
  fitAll() { this.setZoom(this.strip.clientWidth / Math.max(1, this.times.length), undefined, true); this.strip.scrollLeft = 0; }
  get zoomRange() { return {min: MIN_CARD, max: MAX_CARD}; }
  /**
   * Where the frame bar goes (docs/TOUCH.md): beside the cards with a mouse and on a tablet; on a phone on its side
   * in the timeline header's action row, so the cards take the body's height; on an upright phone under the cards,
   * where the body has room for it.
   */
  placeFrameBar(){
    const layout=this.touchMode?document.documentElement.dataset.touchLayout:null,bar=this.controls;
    if(layout==='phone-landscape'&&this.header?.setActions){if(this.header.actions!==bar)this.header.setActions(bar);return;}
    if(this.header?.actions===bar)this.header.setActions(null);
    if(layout==='phone-portrait'){if(this.strip.nextElementSibling!==bar)this.strip.after(bar);}
    else if(this.root.firstElementChild!==bar)this.root.prepend(bar);
  }
  fitCardsToHeight(){
    if(!this.autoCardWidth||!this.strip.clientHeight)return;
    // The number line, the duration bar and padding take CARD_CHROME; thumbnails are 5:3 inside CARD_GUTTER. Automatic
    // growth stops at AUTO_MAX, and at AUTO_RUN cards across a narrow strip, so a tall panel still shows a useful run of frames.
    const fit=(this.strip.clientHeight-(this.touchMode?TOUCH_CARD_CHROME:CARD_CHROME))*5/3+CARD_GUTTER;
    const width=Math.round(Math.max(MIN_CARD,Math.min(AUTO_MAX,fit,this.strip.clientWidth/AUTO_RUN||AUTO_MAX)));
    if(Math.abs(width-this.cardWidth)<2)return;
    this.setZoom(width,0);
    this.revealPending=true;
  }
  setZoom(value,anchor=this.strip.clientWidth/2,user=false){if(user)this.autoCardWidth=false;const position=(this.strip.scrollLeft+anchor)/this.cardWidth;this.cardWidth=Math.max(MIN_CARD,Math.min(MAX_CARD,Number(value)||112));this.header?.setZoom(this.cardWidth);this.root.style.setProperty('--filmstrip-card',`${this.cardWidth}px`);this.spacer.style.width=`${this.times.length*this.cardWidth}px`;for(const [index,card] of this.cards)card.style.left=`${index*this.cardWidth}px`;this.strip.scrollLeft=position*this.cardWidth-anchor;this._schedule();this.audio?.update();}
  revealPlayhead() { this.ensureVisible(this.selectedIndex); this.update(); }
  destroy() {
    if (this.header?.actions === this.controls) this.header.setActions(null);
    this.audio?.destroy();this.inflight?.abort();clearTimeout(this.retryTimer);this.clearThumbnailCache();
    if(this.ownsLayerView)this.layerView.destroy();
    this.disposed = true; this.generation++;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.events.abort(); this.menuEvents?.abort(); this.observer.disconnect();
    for (const card of this.cards.values()) card._events.abort();
    this.cards.clear(); this.previews.clear(); this.queue = [];
    this.menu?.remove(); this.easingPopover?.hidePopover(); this.layersPopover?.destroy(); this.onionRange?.destroy();this.root.remove();
  }
}
